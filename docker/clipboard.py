"""Private X11 clipboard owner for reliable Unicode paste inside the container.

Text travels only over stdin. There is no HTTP clipboard-read API, and the fixed
internal read is used only to confirm our own clipboard content is ready.
"""

import subprocess
import time

WRITE_ARGV = ('xclip', '-selection', 'clipboard', '-in', '-quiet')
READ_ARGV = ('xclip', '-selection', 'clipboard', '-out', '-target', 'UTF8_STRING')


class ClipboardError(Exception):
    pass


class Clipboard:
    def __init__(self, environment):
        self.environment = {
            key: value for key, value in environment.items()
            if key.upper() not in ('DEMO_CONTROL_TOKEN', 'CODEX_API_KEY') and not key.upper().startswith('OPENAI_')
        }
        self.owner = None

    def close(self):
        owner, self.owner = self.owner, None
        if owner is None:
            return
        if owner.poll() is None:
            owner.terminate()
            try:
                owner.wait(timeout=0.3)
            except subprocess.TimeoutExpired:
                owner.kill()
                owner.wait(timeout=0.3)
        else:
            owner.wait(timeout=0.3)

    def _replace(self, text):
        self.close()
        try:
            # -quiet keeps xclip in the foreground so the controller owns exactly
            # one tracked process; default xclip daemonization is not used.
            self.owner = subprocess.Popen(
                list(WRITE_ARGV), stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, text=True, encoding='utf-8',
                env=self.environment, start_new_session=True,
            )
            self.owner.stdin.write(text)
            self.owner.stdin.close()
            self.owner.stdin = None
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                if self.owner.poll() is not None:
                    raise ClipboardError('容器剪贴板未能启动，输入未发送。')
                try:
                    observed = subprocess.run(
                        list(READ_ARGV), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                        stderr=subprocess.DEVNULL, text=True, encoding='utf-8',
                        env=self.environment, timeout=0.3, check=True,
                    )
                    if observed.stdout == text:
                        return
                except subprocess.SubprocessError:
                    pass
                time.sleep(0.02)
            raise ClipboardError('容器剪贴板准备超时，输入未发送。')
        except (OSError, UnicodeError, subprocess.SubprocessError, ClipboardError):
            self.close()
            # Never include clipboard content, command stderr or request text.
            raise ClipboardError('容器剪贴板未准备好，输入未发送；请重新观察后重试。') from None

    def set_text(self, text):
        if not isinstance(text, str) or len(text) > 2000 or '\x00' in text:
            raise ClipboardError('输入内容必须在 2000 字以内。')
        if text:
            self._replace(text)

    def clear(self):
        try:
            # Acquire an empty selection, including when the page last owned the
            # clipboard. Releasing our owner then leaves no retained selection.
            self._replace('')
        except ClipboardError:
            pass
        finally:
            self.close()
