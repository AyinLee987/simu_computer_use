"""Bounded AT-SPI snapshots and semantic actions, isolated from the HTTP process.

No desktop/session bus is exposed to the host. Only registered application
process groups and the current foreground window contribute actionable objects.
"""

from collections import deque
import hashlib
import json
import multiprocessing
import os
import secrets
import threading
import time

MAX_CONTROLS = 150
MAX_NODES = 2000
MAX_TEXT = 12000
MAX_VALUE = 512
CLICK_ACTIONS = {'click', 'press', 'activate', 'jump', 'toggle', 'open', 'check', 'uncheck'}
# Include semantic states even when a given toolkit does not expose them as a
# model-visible control property. Missing enum members on older AT-SPI releases
# are treated as unsupported, never guessed.
SEMANTIC_STATES = (
    'ENABLED', 'SENSITIVE', 'VISIBLE', 'SHOWING', 'DEFUNCT', 'EDITABLE', 'READ_ONLY',
    'CHECKABLE', 'CHECKED', 'PRESSED', 'INDETERMINATE', 'EXPANDABLE', 'EXPANDED',
    'COLLAPSED', 'SELECTABLE', 'SELECTED', 'MULTISELECTABLE', 'BUSY', 'MODAL',
    'REQUIRED', 'INVALID_ENTRY', 'HAS_POPUP', 'FOCUSABLE', 'FOCUSED',
)


class AccessibilityError(Exception):
    pass


def unavailable(message='无障碍接口暂不可用，请根据截图操作。'):
    return {'status': 'unavailable', 'source': 'at-spi', 'message': message,
            'truncated': False, 'text': '', 'controls': []}


def clean_text(value, limit):
    return str(value or '').replace('\x00', '').strip()[:limit]


class SnapshotStore:
    """GI-independent state machine; tests use small fake accessible objects."""

    def __init__(self, api, owns_process, clock=time.monotonic):
        self.api = api
        self.owns_process = owns_process
        self.clock = clock
        self.targets = {}
        self.browser_pid = None

    def invalidate(self):
        self.targets = {}

    def state(self, states, name):
        member = getattr(self.api.StateType, name, None)
        return member is not None and states.contains(member)

    def active_window(self, node):
        """Reject background application windows before walking their descendants."""
        scope = self.browser_pid
        if not isinstance(scope, dict):
            return True
        window = scope.get('activeWindow')
        if not window:
            return False
        try:
            role = clean_text(node.get_role_name(), 80).lower()
            if role not in ('frame', 'window', 'dialog', 'alert'):
                return True
            clear = getattr(node, 'clear_cache_single', None) or node.clear_cache
            clear()
            states = node.get_state_set()
            # Native GTK frame/dialog ACTIVE is stronger than title matching and
            # handles several windows with identical document titles.
            if self.state(states, 'ACTIVE'):
                return True
            rect = node.get_component_iface().get_extents(self.api.CoordType.SCREEN)
            expected = window.get('bounds', [])
            if len(expected) != 4:
                return False
            # Chromium may omit ACTIVE on its exported frame; client bounds and
            # window title must both match the current WM-selected window.
            actual = (int(rect.x), int(rect.y), int(rect.width), int(rect.height))
            if any(abs(first - second) > 4 for first, second in zip(actual, expected)):
                return False
            title, name = str(window.get('title', '')), clean_text(node.get_name(), 240)
            return bool(name) and (name == title or title == name + ' - Chromium')
        except Exception:
            return False

    def describe(self, node, width, height):
        # Avoid making decisions using libatspi's cached state after the page changes.
        clear = getattr(node, 'clear_cache_single', None) or node.clear_cache
        clear()
        states = node.get_state_set()
        if self.state(states, 'DEFUNCT') or not all(self.state(states, name) for name in ('VISIBLE', 'SHOWING')):
            return None
        pid = node.get_process_id()
        if not self.owns_process(pid, self.browser_pid):
            return None
        interfaces = set(node.get_interfaces())
        if 'Component' not in interfaces:
            return None
        rect = node.get_component_iface().get_extents(self.api.CoordType.SCREEN)
        x, y, w, h = int(rect.x), int(rect.y), int(rect.width), int(rect.height)
        if w <= 0 or h <= 0 or x >= width or y >= height or x + w <= 0 or y + h <= 0:
            return None
        role_raw = node.get_role_name() or ''
        name_raw = node.get_name() or ''
        role = clean_text(role_raw, 80)
        password = node.get_role() == self.api.Role.PASSWORD_TEXT or 'password' in role.lower()
        value_raw, text_length = '', 0
        # Never ask password objects for Text or Value, including during revalidation.
        if not password and 'Text' in interfaces and ('EditableText' in interfaces or node.get_child_count() == 0):
            text_iface = node.get_text_iface()
            text_length = text_iface.get_character_count()
            value_raw = text_iface.get_text(0, min(text_length, 4096)) or ''
        elif not password and 'Value' in interfaces:
            value_raw = str(node.get_value_iface().get_current_value())
        enabled = all(self.state(states, name) for name in ('ENABLED', 'SENSITIVE'))
        semantic_states = {name: self.state(states, name) for name in SEMANTIC_STATES}
        native_actions = []
        click_index = None
        if 'Action' in interfaces:
            action = node.get_action_iface()
            for index in range(min(action.get_n_actions(), 20)):
                action_name = (action.get_action_name(index) or '').lower()
                native_actions.append(action_name)
                if click_index is None and action_name in CLICK_ACTIONS:
                    click_index = index
        actions = []
        if enabled and click_index is not None:
            actions.append('click')
        if enabled and 'EditableText' in interfaces and self.state(states, 'EDITABLE') and not self.state(states, 'READ_ONLY') and text_length <= 4096:
            actions.append('type')
        clipped_x, clipped_y = max(x, 0), max(y, 0)
        control = {
            'role': role, 'name': clean_text(name_raw, 240),
            'value': '' if password else clean_text(value_raw, MAX_VALUE),
            'x': clipped_x, 'y': clipped_y,
            'width': min(x + w, width) - clipped_x,
            'height': min(y + h, height) - clipped_y,
            'actions': actions, 'enabled': enabled,
        }
        if password:
            control['password'] = True
        if role.lower() in ('check box', 'radio button', 'toggle button', 'check menu item', 'radio menu item'):
            control['indeterminate'] = self.state(states, 'INDETERMINATE')
            control['checked'] = None if control['indeterminate'] else self.state(states, 'CHECKED')
        elif self.state(states, 'INDETERMINATE'):
            control['indeterminate'] = True
        if role.lower() in ('toggle button', 'push button'):
            control['pressed'] = self.state(states, 'PRESSED')
        if any(self.state(states, name) for name in ('EXPANDABLE', 'EXPANDED', 'COLLAPSED')):
            control['expanded'] = self.state(states, 'EXPANDED')
        if self.state(states, 'SELECTABLE') or self.state(states, 'SELECTED'):
            control['selected'] = self.state(states, 'SELECTED')
        # Hash full bounded properties, not only the model-visible truncated labels.
        fingerprint = hashlib.sha256(json.dumps({
            'control': control, 'pid': pid, 'role': role_raw, 'name': name_raw,
            'value': value_raw, 'text_length': text_length, 'bounds': [x, y, w, h],
            'semantic_states': semantic_states,
            'interfaces': sorted(interfaces), 'native_actions': native_actions,
        }, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()
        return control, fingerprint, click_index

    def observe(self, browser_pid, width, height):
        self.invalidate()
        self.browser_pid = browser_pid
        if not browser_pid:
            return unavailable('当前应用尚未启动，暂时没有可读取的控件。')
        deadline = self.clock() + 2.5
        try:
            desktop = self.api.get_desktop(0)
            desktop.clear_cache()
            applications = []
            for index in range(min(desktop.get_child_count(), 100)):
                if self.clock() >= deadline:
                    return unavailable('发现本次应用的无障碍树超时，请重新观察。')
                app = desktop.get_child_at_index(index)
                if app is not None and self.owns_process(app.get_process_id(), browser_pid):
                    applications.append(app)
            if not applications:
                return unavailable('尚未发现当前应用的无障碍树，请稍后重新观察或使用截图。')
            queue = deque((app, 0) for app in applications)
            controls, texts, text_size = [], [], 0
            visited, truncated, failures = 0, False, 0
            snapshot_id = secrets.token_hex(12)
            while queue:
                if visited >= MAX_NODES or len(controls) >= MAX_CONTROLS or self.clock() >= deadline:
                    truncated = True
                    break
                node, depth = queue.popleft()
                visited += 1
                try:
                    if depth <= 1 and not self.active_window(node):
                        continue
                    details = self.describe(node, width, height)
                    password = node.get_role() == self.api.Role.PASSWORD_TEXT
                    if details is not None:
                        control, fingerprint, click_index = details
                        password = control.get('password', False)
                        # Named non-interactive text is useful context; generic empty
                        # layout containers only consume the bounded tree budget.
                        if control['name'] or control['value'] or control['actions'] or password:
                            control['id'] = f'ax-{snapshot_id}-{len(controls) + 1}'
                            controls.append(control)
                            self.targets[control['id']] = (node, fingerprint, click_index, width, height)
                            line = f"{control['role']}: {control['name']} {control['value']}".strip()
                            if text_size < MAX_TEXT:
                                part = line[:MAX_TEXT - text_size]
                                texts.append(part)
                                text_size += len(part) + 1
                                if part != line:
                                    truncated = True
                            else:
                                truncated = True
                    # Do not inspect descendants that might mirror a password value.
                    if not password and depth < 40:
                        count = node.get_child_count()
                        if count > MAX_NODES:
                            truncated = True
                        for index in range(min(count, MAX_NODES)):
                            if len(queue) + visited >= MAX_NODES or self.clock() >= deadline:
                                truncated = True
                                break
                            child = node.get_child_at_index(index)
                            if child is not None:
                                queue.append((child, depth + 1))
                    elif depth >= 40:
                        truncated = True
                except Exception:
                    failures += 1
            if not controls:
                self.invalidate()
                return unavailable('无障碍树尚无可用的可见控件，请根据截图操作。')
            return {'status': 'ready', 'source': 'at-spi',
                    'message': '仅显示本次会话当前应用窗口的可见控件；画布内部仍需截图。' + (' 部分节点读取失败。' if failures else ''),
                    'truncated': truncated or failures > 0,
                    'text': '\n'.join(texts)[:MAX_TEXT], 'controls': controls}
        except Exception:
            self.invalidate()
            return unavailable()

    def act(self, action, browser_pid):
        # Every attempt consumes the snapshot, including failures and invalid IDs.
        targets, self.targets = self.targets, {}
        target = action.get('target')
        entry = targets.get(target) if isinstance(target, str) else None
        if entry is None or browser_pid != self.browser_pid:
            raise AccessibilityError('控件标识已过期或不存在，请重新观察。')
        node, fingerprint, click_index, width, height = entry
        try:
            if node.get_parent() is None:
                raise AccessibilityError('控件已消失，请重新观察。')
            details = self.describe(node, width, height)
            if details is None or details[1] != fingerprint:
                raise AccessibilityError('控件状态或属性已变化，请重新观察。')
            control = details[0]
            kind = action.get('type')
            if kind not in control['actions']:
                raise AccessibilityError('该控件没有提供所请求的无障碍动作。')
            if kind == 'click':
                success = node.get_action_iface().do_action(click_index)
            elif kind == 'type':
                value = action.get('text')
                if not isinstance(value, str) or len(value) > 2000 or '\x00' in value:
                    raise AccessibilityError('输入内容必须在 2000 字以内。')
                success = node.get_editable_text_iface().set_text_contents(value)
            else:
                raise AccessibilityError('无障碍动作仅支持 click 和 type。')
            if not success:
                raise AccessibilityError('应用未确认无障碍动作成功，请重新观察；不会自动改用坐标点击。')
        except AccessibilityError:
            raise
        except Exception:
            raise AccessibilityError('控件已不可访问，请重新观察；不会自动改用坐标操作。') from None


def owns_browser_process(pid, browser_pid):
    try:
        if isinstance(browser_pid, dict):
            groups = browser_pid.get('groups', [])
            active = browser_pid.get('activeGroup')
            return bool(pid and active and active in groups) and os.getpgid(pid) == active
        return bool(pid and browser_pid) and os.getpgid(pid) == browser_pid
    except (OSError, TypeError):
        return False


def worker_main(connection):
    # The worker only needs desktop bus credentials, never the HTTP control token.
    for key in list(os.environ):
        if key.upper() in ('DEMO_CONTROL_TOKEN', 'CODEX_API_KEY') or key.upper().startswith('OPENAI_'):
            os.environ.pop(key, None)
    store = None
    try:
        import gi
        gi.require_version('Atspi', '2.0')
        from gi.repository import Atspi
        Atspi.init()
        Atspi.set_timeout(250, 500)
        store = SnapshotStore(Atspi, owns_browser_process)
    except Exception:
        pass
    try:
        while True:
            request = connection.recv()
            operation = request.get('operation')
            if store is None:
                response = unavailable('容器中的 AT-SPI 依赖或桌面总线不可用，请检查镜像版本。') if operation == 'observe' else {'error': '无障碍接口不可用，请重新观察。'}
            elif operation == 'observe':
                response = store.observe(request.get('browser_pid'), request['width'], request['height'])
            elif operation == 'action':
                try:
                    store.act(request['action'], request.get('browser_pid'))
                    response = {'ok': True}
                except AccessibilityError as error:
                    response = {'error': str(error)}
            else:
                store.invalidate()
                response = {'ok': True}
            connection.send(response)
    except (EOFError, BrokenPipeError, OSError):
        pass
    finally:
        connection.close()


class AccessibilityBridge:
    """A wedged or crashed D-Bus client must not wedge screenshot/control HTTP."""

    def __init__(self, timeout=4):
        self.timeout = timeout
        self.process = None
        self.connection = None
        self.lock = threading.RLock()

    def close(self):
        with self.lock:
            if self.connection is not None:
                self.connection.close()
                self.connection = None
            if self.process is not None:
                if self.process.is_alive():
                    self.process.terminate()
                    self.process.join(timeout=0.2)
                    if self.process.is_alive():
                        self.process.kill()
                self.process.join(timeout=0.2)
                self.process = None

    def request(self, payload):
        with self.lock:
            try:
                if self.process is None or not self.process.is_alive():
                    self.close()
                    context = multiprocessing.get_context('spawn')
                    self.connection, child = context.Pipe()
                    self.process = context.Process(target=worker_main, args=(child,), daemon=True)
                    self.process.start()
                    child.close()
                self.connection.send(payload)
                if not self.connection.poll(self.timeout):
                    raise TimeoutError()
                return self.connection.recv()
            except (OSError, EOFError, TimeoutError, ValueError):
                self.close()
                if payload['operation'] == 'observe':
                    return unavailable('无障碍读取超时或服务重启，请根据截图操作；下次观察会重试。')
                raise AccessibilityError('无障碍动作结果未确认，请重新观察；不会自动重试动作。') from None

    def observe(self, browser_pid, width, height):
        return self.request({'operation': 'observe', 'browser_pid': browser_pid, 'width': width, 'height': height})

    def action(self, action, browser_pid):
        response = self.request({'operation': 'action', 'action': action, 'browser_pid': browser_pid})
        if not isinstance(response, dict) or response.get('ok') is not True:
            message = response.get('error') if isinstance(response, dict) else None
            raise AccessibilityError(message or '无障碍动作结果未确认，请重新观察。')

    def invalidate(self):
        if self.process is not None:
            try:
                self.request({'operation': 'invalidate'})
            except AccessibilityError:
                pass
