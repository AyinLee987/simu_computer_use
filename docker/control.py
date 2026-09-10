#!/usr/bin/env python3
"""Small authenticated desktop controller; all operating-system commands are fixed argv."""

import base64
import hmac
import json
import math
import mimetypes
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

from accessibility import AccessibilityBridge, AccessibilityError, unavailable
from clipboard import Clipboard, ClipboardError
from windows import Windows, process_identity
from workspace import CollectionError, list_files, read_file

WIDTH, HEIGHT = 1000, 720
TOKEN = os.environ.get('DEMO_CONTROL_TOKEN', '')
LABS = Path('/opt/demo/labs')
STATE = Path('/tmp/demo-desktop')
PROFILE = STATE / 'chromium-profile'
DOWNLOADS = Path('/tmp/demo-downloads')
TASKS = Path('/workspace/tasks')
APPS = [{'id': 'files', 'name': '文件管理器（Thunar）'},
        {'id': 'editor', 'name': '文本编辑器（Mousepad）'},
        {'id': 'browser', 'name': '浏览器（Chromium）'}]
SCREENSHOT = STATE / 'screenshot.png'
ENVIRONMENT = {**{key: value for key, value in os.environ.items()
                   if key.upper() not in ('DEMO_CONTROL_TOKEN', 'CODEX_API_KEY')
                   and not key.upper().startswith('OPENAI_')}, 'DISPLAY': ':99'}
KEYS = {
    'ArrowUp': 'Up', 'ArrowDown': 'Down', 'ArrowLeft': 'Left', 'ArrowRight': 'Right',
    'Enter': 'Return', 'Space': 'space', 'Tab': 'Tab', 'Escape': 'Escape',
    'Backspace': 'BackSpace', 'Delete': 'Delete', 'Home': 'Home', 'End': 'End',
    'PageUp': 'Prior', 'PageDown': 'Next', 'Shift+Tab': 'shift+Tab',
    'ControlOrMeta+A': 'ctrl+a', 'ControlOrMeta+Z': 'ctrl+z',
    'ControlOrMeta+a': 'ctrl+a', 'ControlOrMeta+z': 'ctrl+z',
    'Control+a': 'ctrl+a', 'Control+z': 'ctrl+z',
    'Control+A': 'ctrl+a', 'Control+Z': 'ctrl+z',
    'Meta+a': 'ctrl+a', 'Meta+z': 'ctrl+z',
    'Meta+A': 'ctrl+a', 'Meta+Z': 'ctrl+z',
}
KEYS.update({character: character for character in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'})
for modifier in ('ControlOrMeta', 'Control', 'Ctrl', 'Meta'):
    for letter in 'azcvxsonfl':
        KEYS[f'{modifier}+{letter}'] = f'ctrl+{letter}'
    KEYS[f'{modifier}+Shift+S'] = 'ctrl+shift+s'
KEYS.update({'Alt+Tab': 'alt+Tab', 'Alt+F4': 'alt+F4', 'F2': 'F2', 'F5': 'F5', 'F10': 'F10'})
for direction in ('Up', 'Down', 'Left', 'Right'):
    KEYS[f'Shift+Arrow{direction}'] = f'shift+{direction}'
KEY_ALIASES = {key.lower(): value for key, value in KEYS.items() if len(key) > 1}


class RequestError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def command(arguments, *, timeout=8, input_text=None, capture=False):
    return subprocess.run(
        arguments, input=input_text, text=True, env=ENVIRONMENT,
        stdin=subprocess.DEVNULL if input_text is None else None,
        stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, timeout=timeout, check=True,
    )


def coordinate(value, limit):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value < limit:
        raise RequestError('动作坐标超出桌面范围。')
    return int(value)


def valid_url(value):
    if not isinstance(value, str) or len(value) > 8192:
        raise RequestError('请提供有效的网页地址。')
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError()
        port = parsed.port
    except ValueError:
        raise RequestError('只允许普通 http 或 https 网页地址。') from None
    if parsed.hostname in ('127.0.0.1', 'localhost', '::1') and port == 8000 and not parsed.path.startswith('/labs/'):
        raise RequestError('控制服务只能通过公开的实验页访问。')
    return value


class Desktop:
    def __init__(self):
        self.lock = threading.RLock()
        self.browser = None
        self.mode = 'browser'
        self.active = False
        self.workspace = None
        self.processes = []
        self.windows = Windows(command, self.process_groups)
        self.accessibility = AccessibilityBridge()
        self.clipboard = Clipboard(ENVIRONMENT)
        STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
        DOWNLOADS.mkdir(mode=0o700, parents=True, exist_ok=True)

    def ready(self):
        try:
            result = command(['xdotool', 'getdisplaygeometry'], timeout=2, capture=True)
            return bool(TOKEN) and result.stdout.strip() == f'{WIDTH} {HEIGHT}'
        except (OSError, subprocess.SubprocessError):
            return False

    def running(self):
        return self.browser is not None and self.browser.poll() is None

    def require_browser(self):
        if not self.running():
            raise RequestError('浏览器尚未启动或已停止。', 409)

    def require_session(self):
        if self.mode == 'desktop':
            if not self.active:
                raise RequestError('桌面会话尚未启动或已停止。', 409)
        else:
            self.require_browser()

    def process_groups(self):
        groups = set()
        for entry in self.processes:
            process = entry['process']
            process.poll()  # Reap exited leaders; child windows can remain alive.
            if not self.group_alive(entry):
                continue
            group = process.pid
            groups.add(group)
            # Keep identities of observed descendants, so a leader exiting does
            # not orphan its application windows or accidentally authorize a
            # subsequently recycled process-group number.
            try:
                with os.scandir('/proc') as candidates:
                    for index, candidate in enumerate(candidates):
                        if index >= 4096:
                            break
                        if candidate.name.isdecimal():
                            pid = int(candidate.name)
                            identity = process_identity(pid)
                            if identity is not None and identity[0] == group:
                                entry['members'][pid] = identity
            except OSError:
                pass
        return groups

    @staticmethod
    def group_alive(entry):
        return any(identity[0] == entry['process'].pid and process_identity(pid) == identity
                   for pid, identity in entry['members'].items())

    def spawn(self, app_id, arguments):
        process = subprocess.Popen(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, env=ENVIRONMENT, start_new_session=True,
                                   cwd=str(self.workspace) if self.workspace else None)
        identity = process_identity(process.pid)
        if identity is None or identity[0] != process.pid:
            process.terminate()
            process.wait(timeout=3)
            raise RequestError('无法验证新应用的进程身份。', 503)
        self.processes.append({'process': process, 'identity': identity, 'appId': app_id,
                               'members': {process.pid: identity}})
        if app_id == 'browser':
            self.browser = process
        return process

    def stop(self):
        with self.lock:
            self.accessibility.close()
            self.windows.invalidate()
            self.clipboard.clear()
            self.active = False
            self.browser = None
            self.process_groups()
            entries, self.processes = self.processes, []
            for entry in entries:
                process = entry['process']
                # A recycled PID must never authorize a signal to an unrelated group.
                if not self.group_alive(entry):
                    continue
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                deadline = time.monotonic() + 3
                while self.group_alive(entry) and time.monotonic() < deadline:
                    process.poll()
                    time.sleep(0.05)
                if self.group_alive(entry):
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                process.wait(timeout=3)

    def session(self, url):
        url = valid_url(url)
        with self.lock:
            self.stop()
            self.mode, self.workspace = 'browser', None
            # These fixed paths belong only to this container session.
            for directory in (PROFILE, DOWNLOADS):
                if directory.is_symlink():
                    directory.unlink()
                elif directory.exists():
                    shutil.rmtree(directory)
                directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            default = PROFILE / 'Default'
            default.mkdir(mode=0o700)
            preferences = {
                'download': {'default_directory': str(DOWNLOADS), 'prompt_for_download': False, 'directory_upgrade': True},
                'profile': {'default_content_setting_values': {'automatic_downloads': 1}},
                'browser': {'check_default_browser': False},
                'translate': {'enabled': False},
            }
            (default / 'Preferences').write_text(json.dumps(preferences), encoding='utf-8')
            self.spawn('browser', [
                'chromium', '--no-sandbox', f'--user-data-dir={PROFILE}',
                '--window-size=1000,720', '--window-position=0,0',
                '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble',
                '--disable-background-networking', '--disable-sync',
                '--disable-features=Translate',
                '--force-renderer-accessibility',
                '--kiosk', f'--app={url}',
            ])
            deadline = time.monotonic() + 12
            while time.monotonic() < deadline:
                if not self.running():
                    raise RequestError('容器中的 Chromium 未能启动。', 503)
                try:
                    command(['xdotool', 'search', '--onlyvisible', '--class', 'chromium'], timeout=1)
                    time.sleep(0.35)
                    self.active = True
                    return
                except (OSError, subprocess.SubprocessError):
                    time.sleep(0.15)
            self.stop()
            raise RequestError('浏览器窗口启动超时，请重试。', 503)

    def desktop_session(self):
        with self.lock:
            self.stop()
            TASKS.mkdir(mode=0o700, parents=True, exist_ok=True)
            if TASKS.is_symlink() or TASKS.parent.is_symlink():
                raise RequestError('任务目录不能是符号链接。', 503)
            self.workspace = TASKS / secrets.token_hex(12)
            self.workspace.mkdir(mode=0o700)
            self.mode, self.active = 'desktop', True
            try:
                self.launch_app('files')
            except Exception:
                self.stop()
                raise

    def launch_app(self, app_id):
        self.require_session()
        if self.mode != 'desktop' or app_id not in {app['id'] for app in APPS}:
            raise RequestError('本次桌面只允许启动文件管理器、文本编辑器和浏览器。')
        # Launch is idempotent when an application window already exists.
        for row in self.windows.current():
            if row['appId'] == app_id:
                command(['wmctrl', '-ia', hex(row['xid'])])
                return
        if app_id == 'files':
            # Thunar 4.18 has no --disable-server. Refuse an existing bus owner
            # instead of adopting its windows/process group. The new process
            # must then produce a window owned by its registered group.
            owner = subprocess.run([
                'dbus-send', '--session', '--print-reply', '--dest=org.freedesktop.DBus',
                '/org/freedesktop/DBus', 'org.freedesktop.DBus.GetConnectionUnixProcessID',
                'string:org.xfce.Thunar',
            ], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, env=ENVIRONMENT, timeout=2, check=False)
            if owner.returncode == 0:
                match = re.search(r'uint32\s+(\d+)', owner.stdout)
                identity = process_identity(int(match[1])) if match else None
                if identity is None or identity[0] not in self.process_groups():
                    raise RequestError('文件管理器已有未登记的后台实例，请重启桌面会话。', 409)
                # Reopening a window in our own registered instance is safe;
                # Thunar's CLI forwards the fixed path over the same private bus.
                command(['thunar', str(self.workspace)], timeout=3)
                time.sleep(0.3)
                if not any(row['appId'] == app_id and row['identity'][0] == identity[0]
                           for row in self.windows.current()):
                    raise RequestError('文件管理器窗口尚未打开，请重新观察。', 503)
                return
            if 'NameHasNoOwner' not in owner.stderr and 'ServiceUnknown' not in owner.stderr:
                raise RequestError('无法确认文件管理器的桌面总线归属。', 503)
            arguments = ['thunar', str(self.workspace)]
        elif app_id == 'editor':
            arguments = ['mousepad', '--disable-server']
        else:
            # Unique browser profiles prevent Chrome's process singleton from
            # redirecting this launch into another session or process group.
            profile = STATE / ('desktop-browser-' + secrets.token_hex(12))
            default = profile / 'Default'
            default.mkdir(mode=0o700, parents=True)
            (default / 'Preferences').write_text(json.dumps({
                'download': {'default_directory': str(self.workspace), 'prompt_for_download': False},
                'browser': {'check_default_browser': False}, 'translate': {'enabled': False},
            }), encoding='utf-8')
            arguments = ['chromium', '--no-sandbox', f'--user-data-dir={profile}',
                         '--window-size=900,640', '--window-position=40,35', '--no-first-run',
                         '--no-default-browser-check', '--disable-session-crashed-bubble',
                         '--disable-background-networking', '--disable-sync', '--disable-features=Translate',
                         '--force-renderer-accessibility', 'http://127.0.0.1:8000/labs/paint.html']
        process = self.spawn(app_id, arguments)
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RequestError('应用未能启动，或尝试连接到未登记的已有实例。', 503)
            for row in self.windows.current():
                if row['appId'] == app_id and row['identity'][0] == process.pid:
                    command(['wmctrl', '-ia', hex(row['xid'])])
                    time.sleep(0.2)
                    return
            time.sleep(0.15)
        raise RequestError('应用窗口启动超时，请重新观察。', 503)

    def accessibility_scope(self, rows):
        groups = self.process_groups()
        active = next((row for row in rows if row['active']), None)
        return {'groups': sorted(groups), 'activeGroup': active['identity'][0] if active else None,
                'activeWindow': {'id': active['xid'], 'pid': active['pid'],
                                 'title': active['title'], 'bounds': active['bounds']} if active else None}

    def screenshot(self):
        with self.lock:
            command(['scrot', '--overwrite', str(SCREENSHOT)], timeout=5)
            return SCREENSHOT.read_bytes()

    def observation(self):
        with self.lock:
            try:
                rows = self.windows.observe()
            except (OSError, subprocess.SubprocessError):
                rows = []
                self.windows.invalidate()
            scope = self.accessibility_scope(rows)
            if scope['activeGroup']:
                accessibility = self.accessibility.observe(scope, WIDTH, HEIGHT)
            else:
                self.accessibility.invalidate()
                accessibility = unavailable('当前没有已登记的活动应用窗口，请根据截图操作。')
            screenshot = base64.b64encode(self.screenshot()).decode('ascii')
            desktop = {'mode': self.mode, 'apps': APPS if self.mode == 'desktop' else [],
                       'windows': [{key: row[key] for key in ('id', 'appId', 'title', 'active')} for row in rows],
                       'workspace': str(self.workspace) if self.workspace else None}
            return {'screenshot': screenshot, 'accessibility': accessibility, 'desktop': desktop}

    def action(self, action):
        with self.lock:
            try:
                self._action(action)
            except Exception:
                self.accessibility.invalidate()
                raise
            finally:
                self.windows.invalidate()

    def _action(self, action):
        if not isinstance(action, dict) or set(action) - {'type', 'target', 'x', 'y', 'toX', 'toY', 'text', 'key', 'deltaY'}:
            raise RequestError('动作格式不正确。')
        kind = action.get('type')
        if kind not in ('click', 'double_click', 'right_click', 'drag', 'type', 'key', 'scroll', 'wait',
                        'launch_app', 'focus_window', 'close_window'):
            raise RequestError('不支持此动作类型。')
        with self.lock:
            self.require_session()
            target = action.get('target')
            if kind in ('launch_app', 'focus_window', 'close_window'):
                self.accessibility.invalidate()
                if self.mode != 'desktop':
                    raise RequestError('应用和窗口动作需要 desktop 会话。')
                if not isinstance(target, str) or any(action.get(key) is not None for key in ('x', 'y', 'toX', 'toY', 'text', 'key', 'deltaY')):
                    raise RequestError('应用和窗口动作仅接受当前目标标识。')
                if kind == 'launch_app':
                    self.launch_app(target)
                else:
                    try:
                        self.windows.operate(target, close=kind == 'close_window')
                    except ValueError as error:
                        raise RequestError(str(error), 409) from None
                time.sleep(0.2)
                return
            if target is not None:
                if kind not in ('click', 'type') or not isinstance(target, str) or len(target) > 100 or not target.startswith('ax-'):
                    self.accessibility.invalidate()
                    raise RequestError('控件动作仅支持当前观察中的 click 或 type。')
                if any(action.get(key) is not None for key in ('x', 'y', 'toX', 'toY', 'key', 'deltaY')):
                    self.accessibility.invalidate()
                    raise RequestError('控件动作不能同时指定坐标或其他输入参数。')
                try:
                    self.accessibility.action(action, self.accessibility_scope(self.windows.current()))
                except AccessibilityError as error:
                    raise RequestError(str(error), 409) from None
                time.sleep(0.2)
                return
            # Any coordinate/key operation may change the page; IDs are single-use.
            self.accessibility.invalidate()
            if kind in ('click', 'double_click', 'right_click', 'drag'):
                x = coordinate(action.get('x'), WIDTH)
                y = coordinate(action.get('y'), HEIGHT)
                if kind in ('click', 'double_click', 'right_click'):
                    arguments = ['xdotool', 'mousemove', str(x), str(y), 'click']
                    if kind == 'double_click':
                        arguments.extend(['--repeat', '2', '--delay', '100'])
                    arguments.append('3' if kind == 'right_click' else '1')
                    command(arguments)
                else:
                    end_x = coordinate(action.get('toX'), WIDTH)
                    end_y = coordinate(action.get('toY'), HEIGHT)
                    arguments = ['xdotool', 'mousemove', str(x), str(y), 'mousedown', '1']
                    for step in range(1, 25):
                        arguments.extend(['mousemove', str(round(x + (end_x - x) * step / 24)), str(round(y + (end_y - y) * step / 24)), 'sleep', '0.012'])
                    arguments.extend(['mouseup', '1'])
                    try:
                        command(arguments)
                    finally:
                        command(['xdotool', 'mouseup', '1'], timeout=2)
            elif kind == 'type':
                text = action.get('text')
                if not isinstance(text, str) or len(text) > 2000 or '\x00' in text:
                    raise RequestError('输入内容必须在 2000 字以内。')
                if text:
                    try:
                        self.clipboard.set_text(text)
                        command(['xdotool', 'key', '--clearmodifiers', 'ctrl+v'])
                    except ClipboardError as error:
                        raise RequestError(str(error), 503) from None
            elif kind == 'key':
                key = action.get('key')
                mapped = KEYS.get(key, KEY_ALIASES.get(key.lower())) if isinstance(key, str) else None
                if mapped is None:
                    raise RequestError('该按键不在本次演示的操作范围内。')
                command(['xdotool', 'key', '--clearmodifiers', mapped])
            elif kind == 'scroll':
                delta = action.get('deltaY')
                if isinstance(delta, bool) or not isinstance(delta, (int, float)) or not math.isfinite(delta) or abs(delta) > 1500:
                    raise RequestError('单次滚动距离必须在 1500 像素以内。')
                if delta:
                    x, y = 800, 500
                    if self.mode == 'desktop':
                        active = next((row for row in self.windows.current() if row['active']), None)
                        if active is None:
                            raise RequestError('请先聚焦一个当前应用窗口。', 409)
                        left, top, width, height = active['bounds']
                        x = max(0, min(WIDTH - 1, left + width // 2))
                        y = max(0, min(HEIGHT - 1, top + height // 2))
                    command(['xdotool', 'mousemove', str(x), str(y), 'click', '--repeat', str(math.ceil(abs(delta) / 100)), '--delay', '40', '5' if delta > 0 else '4'])
            else:
                time.sleep(0.7)
            time.sleep(0.2)

    def files(self):
        with self.lock:
            return list_files(self.workspace if self.mode == 'desktop' and self.workspace else DOWNLOADS,
                              nested=self.mode == 'desktop')

    def download(self, name, revision=None):
        with self.lock:
            try:
                return read_file(self.workspace if self.mode == 'desktop' and self.workspace else DOWNLOADS,
                                 name, revision, nested=self.mode == 'desktop')
            except CollectionError as error:
                raise RequestError(str(error), error.status) from None


DESKTOP = Desktop()


class Handler(BaseHTTPRequestHandler):
    server_version = 'DesktopDemo'

    def log_message(self, *_):
        pass

    def send_data(self, data, content_type='application/json; charset=utf-8', status=200):
        if not isinstance(data, bytes):
            data = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.end_headers()
        self.wfile.write(data)

    def authenticate(self):
        supplied = self.headers.get('Authorization', '')
        if not TOKEN or not hmac.compare_digest(supplied.encode('utf-8'), f'Bearer {TOKEN}'.encode('utf-8')):
            raise RequestError('需要控制服务凭据。', 401)

    def body(self):
        if self.headers.get_content_type() != 'application/json':
            raise RequestError('请求必须使用 JSON。', 415)
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 <= length <= 32000:
                raise ValueError()
            self.connection.settimeout(10)
            data = json.loads(self.rfile.read(length) or b'{}')
            if not isinstance(data, dict):
                raise ValueError()
            return data
        except (ValueError, UnicodeDecodeError, TimeoutError):
            raise RequestError('请求内容无效或过长。') from None

    def handle_request(self, method):
        route = unquote(urlsplit(self.path).path)
        if method == 'GET' and route == '/health':
            return self.send_data({'ready': DESKTOP.ready(), 'width': WIDTH, 'height': HEIGHT,
                                   'capabilities': {'observation': True, 'accessibility': 'at-spi',
                                                    'desktopSessions': True, 'apps': [app['id'] for app in APPS]}})
        if method == 'GET' and route.startswith('/labs/'):
            relative = Path(route[len('/labs/'):])
            if relative.is_absolute() or '..' in relative.parts or '\\' in str(relative):
                raise RequestError('页面不存在。', 404)
            item = LABS / relative
            if not item.is_file() or item.is_symlink():
                raise RequestError('页面不存在。', 404)
            content_type = mimetypes.guess_type(item.name)[0] or 'application/octet-stream'
            if content_type.startswith('text/') or content_type == 'application/javascript':
                content_type += '; charset=utf-8'
            return self.send_data(item.read_bytes(), content_type)
        self.authenticate()
        if method == 'GET':
            if route == '/screenshot':
                return self.send_data(DESKTOP.screenshot(), 'image/png')
            if route == '/observation':
                return self.send_data(DESKTOP.observation())
            if route == '/downloads':
                return self.send_data({'files': DESKTOP.files()})
            if route.startswith('/downloads/'):
                revision = parse_qs(urlsplit(self.path).query).get('revision', [None])[0]
                return self.send_data(DESKTOP.download(route[len('/downloads/'):], revision), 'application/octet-stream')
        if method == 'POST':
            data = self.body()
            if route == '/session':
                if data == {'mode': 'desktop'}:
                    DESKTOP.desktop_session()
                elif set(data) == {'url'}:
                    DESKTOP.session(data['url'])
                else:
                    raise RequestError('会话请求只接受网页地址或 desktop 模式。')
            elif route == '/action':
                DESKTOP.action(data)
            elif route == '/stop':
                DESKTOP.stop()
            else:
                raise RequestError('接口不存在。', 404)
            return self.send_data({'ok': True})
        raise RequestError('接口不存在。', 404)

    def dispatch(self, method):
        try:
            self.handle_request(method)
        except RequestError as error:
            self.send_data({'error': str(error)}, status=error.status)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except (OSError, ValueError, subprocess.SubprocessError):
            self.send_data({'error': '桌面操作未完成，请重新观察或重启会话。'}, status=500)

    def do_GET(self):
        self.dispatch('GET')

    def do_POST(self):
        self.dispatch('POST')

    def do_OPTIONS(self):
        self.send_data({'error': '不允许网页跨域访问控制服务。'}, status=403)


def main():
    if not TOKEN:
        raise SystemExit('DEMO_CONTROL_TOKEN is required.')
    server = ThreadingHTTPServer(('0.0.0.0', 8000), Handler)
    server.daemon_threads = True

    def stop_signal(*_):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop_signal)
    signal.signal(signal.SIGINT, stop_signal)
    print('Desktop control service is listening on port 8000.', flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        DESKTOP.stop()
        server.server_close()


if __name__ == '__main__':
    main()
