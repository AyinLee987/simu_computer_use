#!/usr/bin/env python3
"""Small authenticated desktop controller; all operating-system commands are fixed argv."""

import hmac
import json
import math
import mimetypes
import os
from pathlib import Path
import shutil
import signal
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

WIDTH, HEIGHT = 1000, 720
TOKEN = os.environ.get('DEMO_CONTROL_TOKEN', '')
LABS = Path('/opt/demo/labs')
STATE = Path('/tmp/demo-desktop')
PROFILE = STATE / 'chromium-profile'
DOWNLOADS = Path('/tmp/demo-downloads')
SCREENSHOT = STATE / 'screenshot.png'
ENVIRONMENT = {**{key: value for key, value in os.environ.items() if key != 'DEMO_CONTROL_TOKEN'}, 'DISPLAY': ':99'}
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

    def stop(self):
        with self.lock:
            browser, self.browser = self.browser, None
            if browser is None:
                return
            try:
                os.killpg(browser.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                browser.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(browser.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                browser.wait(timeout=3)

    def session(self, url):
        url = valid_url(url)
        with self.lock:
            self.stop()
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
            }
            (default / 'Preferences').write_text(json.dumps(preferences), encoding='utf-8')
            self.browser = subprocess.Popen([
                'chromium', '--no-sandbox', f'--user-data-dir={PROFILE}',
                '--window-size=1000,720', '--window-position=0,0',
                '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble',
                '--disable-background-networking', '--disable-sync',
                '--kiosk', f'--app={url}',
            ], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                env=ENVIRONMENT, start_new_session=True)
            deadline = time.monotonic() + 12
            while time.monotonic() < deadline:
                if not self.running():
                    raise RequestError('容器中的 Chromium 未能启动。', 503)
                try:
                    command(['xdotool', 'search', '--onlyvisible', '--class', 'chromium'], timeout=1)
                    time.sleep(0.35)
                    return
                except (OSError, subprocess.SubprocessError):
                    time.sleep(0.15)
            self.stop()
            raise RequestError('浏览器窗口启动超时，请重试。', 503)

    def screenshot(self):
        with self.lock:
            command(['scrot', '--overwrite', str(SCREENSHOT)], timeout=5)
            return SCREENSHOT.read_bytes()

    def action(self, action):
        if not isinstance(action, dict) or set(action) - {'type', 'target', 'x', 'y', 'toX', 'toY', 'text', 'key', 'deltaY'}:
            raise RequestError('动作格式不正确。')
        kind = action.get('type')
        if kind not in ('click', 'drag', 'type', 'key', 'scroll', 'wait') or action.get('target') is not None:
            raise RequestError('仅支持使用桌面坐标的基础动作。')
        with self.lock:
            self.require_browser()
            if kind in ('click', 'drag'):
                x = coordinate(action.get('x'), WIDTH)
                y = coordinate(action.get('y'), HEIGHT)
                if kind == 'click':
                    command(['xdotool', 'mousemove', str(x), str(y), 'click', '1'])
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
                command(['xdotool', 'type', '--clearmodifiers', '--delay', '1', '--file', '-'], input_text=text, timeout=12)
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
                    command(['xdotool', 'mousemove', '800', '500', 'click', '--repeat', str(math.ceil(abs(delta) / 100)), '--delay', '40', '5' if delta > 0 else '4'])
            else:
                time.sleep(0.7)
            time.sleep(0.2)

    def files(self):
        with self.lock:
            return [{'name': item.name, 'size': item.stat().st_size} for item in sorted(DOWNLOADS.iterdir())
                    if item.is_file() and not item.is_symlink() and not item.name.endswith(('.crdownload', '.tmp', '.download'))]

    def download(self, name):
        if not name or name in ('.', '..') or '/' in name or '\\' in name or '\x00' in name:
            raise RequestError('文件不存在。', 404)
        with self.lock:
            item = DOWNLOADS / name
            if item.is_symlink() or not item.is_file() or name.endswith(('.crdownload', '.tmp', '.download')):
                raise RequestError('文件不存在。', 404)
            return item.read_bytes()


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
            return self.send_data({'ready': DESKTOP.ready(), 'width': WIDTH, 'height': HEIGHT})
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
            if route == '/downloads':
                return self.send_data({'files': DESKTOP.files()})
            if route.startswith('/downloads/'):
                return self.send_data(DESKTOP.download(route[len('/downloads/'):]), 'application/octet-stream')
        if method == 'POST':
            data = self.body()
            if route == '/session':
                if set(data) != {'url'}:
                    raise RequestError('会话请求仅接受网页地址。')
                DESKTOP.session(data['url'])
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
