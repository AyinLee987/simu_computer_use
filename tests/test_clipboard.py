"""Pure mocks: no clipboard, desktop, Docker, model or real environment access."""

import importlib.util
from pathlib import Path
import subprocess
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

DOCKER = Path(__file__).resolve().parents[1] / 'docker'
sys.path.insert(0, str(DOCKER))
import clipboard


def fake_owner():
    owner = Mock()
    owner.stdin = Mock()
    owner.poll.return_value = None
    return owner


class ClipboardTests(unittest.TestCase):
    def setUp(self):
        self.environment = {'DISPLAY': ':99', 'LANG': 'C.UTF-8',
                            'DEMO_CONTROL_TOKEN': 'synthetic-control-secret',
                            'OPENAI_API_KEY': 'synthetic-api-secret',
                            'OpenAI_Base_Url': 'https://synthetic.invalid',
                            'CODEX_API_KEY': 'synthetic-codex-secret'}
        self.board = clipboard.Clipboard(self.environment)

    def test_unicode_stdin_fixed_argv_and_sanitized_environment(self):
        text = '无障碍填写成功 🖼️ 中文\n第二行'
        owner = fake_owner()
        stream = owner.stdin
        with patch.object(clipboard.subprocess, 'Popen', return_value=owner) as launch, \
             patch.object(clipboard.subprocess, 'run', return_value=SimpleNamespace(stdout=text)) as read:
            self.board.set_text(text)
        self.assertEqual(launch.call_args.args[0], list(clipboard.WRITE_ARGV))
        self.assertEqual(read.call_args.args[0], list(clipboard.READ_ARGV))
        self.assertNotIn(text, launch.call_args.args[0])
        stream.write.assert_called_once_with(text)
        stream.close.assert_called_once()
        self.assertIsNone(owner.stdin)
        for call in (launch.call_args, read.call_args):
            self.assertEqual(call.kwargs['env'], {'DISPLAY': ':99', 'LANG': 'C.UTF-8'})
            self.assertEqual(call.kwargs['stderr'], subprocess.DEVNULL)
            self.assertEqual(call.kwargs['encoding'], 'utf-8')
            self.assertNotIn('shell', call.kwargs)
        self.assertTrue(launch.call_args.kwargs['start_new_session'])
        self.assertEqual(launch.call_args.kwargs['stdout'], subprocess.DEVNULL)
        self.assertEqual(read.call_args.kwargs['stdin'], subprocess.DEVNULL)
        self.assertEqual(self.environment['DEMO_CONTROL_TOKEN'], 'synthetic-control-secret')
        owner.terminate.assert_not_called()  # Keep selection until paste consumers fetch it.

    def test_empty_input_is_noop_and_does_not_reuse_or_overwrite_clipboard(self):
        with patch.object(clipboard.subprocess, 'Popen') as launch, patch.object(clipboard.subprocess, 'run') as read:
            self.board.set_text('')
        launch.assert_not_called()
        read.assert_not_called()

    def test_invalid_input_does_not_launch_any_process(self):
        with patch.object(clipboard.subprocess, 'Popen') as launch:
            for text in (None, 12, 'a' * 2001, 'bad\x00text'):
                with self.assertRaises(clipboard.ClipboardError):
                    self.board.set_text(text)
        launch.assert_not_called()

    def test_replacing_input_reaps_the_previous_tracked_owner(self):
        old, new = fake_owner(), fake_owner()
        self.board.owner = old
        with patch.object(clipboard.subprocess, 'Popen', return_value=new), \
             patch.object(clipboard.subprocess, 'run', return_value=SimpleNamespace(stdout='next')):
            self.board.set_text('next')
        old.terminate.assert_called_once()
        old.wait.assert_called_once_with(timeout=0.3)
        self.assertIs(self.board.owner, new)

    def test_clear_claims_empty_selection_and_reaps_owner(self):
        owner = fake_owner()
        stream = owner.stdin
        with patch.object(clipboard.subprocess, 'Popen', return_value=owner), \
             patch.object(clipboard.subprocess, 'run', return_value=SimpleNamespace(stdout='')):
            self.board.clear()
        stream.write.assert_called_once_with('')
        owner.terminate.assert_called_once()
        self.assertIsNone(self.board.owner)

    def test_failed_clipboard_setup_closes_owner_and_redacts_error(self):
        owner = fake_owner()
        owner.poll.return_value = 1
        with patch.object(clipboard.subprocess, 'Popen', return_value=owner), \
             patch.object(clipboard.subprocess, 'run') as read:
            with self.assertRaises(clipboard.ClipboardError) as caught:
                self.board.set_text('synthetic-sensitive-content')
        self.assertNotIn('synthetic-sensitive-content', str(caught.exception))
        read.assert_not_called()
        self.assertIsNone(self.board.owner)

    def test_cleanup_kills_stuck_owner_after_bounded_wait(self):
        owner = fake_owner()
        owner.wait.side_effect = [subprocess.TimeoutExpired('xclip', 0.3), 0]
        self.board.owner = owner
        self.board.close()
        owner.terminate.assert_called_once()
        owner.kill.assert_called_once()
        self.assertIsNone(self.board.owner)


class ControllerTypingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location('control_clipboard_test', DOCKER / 'control.py')
        cls.control = importlib.util.module_from_spec(spec)
        # Import without creating container directories or reading real secrets.
        with patch.dict('os.environ', {'DISPLAY': ':99'}, clear=True), patch.object(Path, 'mkdir'):
            spec.loader.exec_module(cls.control)

    def desktop(self):
        desktop = self.control.Desktop.__new__(self.control.Desktop)
        desktop.lock = threading.RLock()
        desktop.mode = 'browser'
        desktop.active = True
        desktop.processes = []
        desktop.windows = Mock()
        desktop.windows.current.return_value = []
        desktop.require_browser = Mock()
        desktop.accessibility = Mock()
        desktop.clipboard = Mock()
        return desktop

    def test_type_sets_clipboard_then_sends_only_fixed_paste_shortcut(self):
        desktop = self.desktop()
        calls = Mock()
        calls.attach_mock(desktop.clipboard.set_text, 'set_text')
        with patch.object(self.control, 'command') as command, patch.object(self.control.time, 'sleep'):
            calls.attach_mock(command, 'command')
            desktop.action({'type': 'type', 'text': '无障碍填写成功'})
        self.assertEqual(calls.mock_calls[0].args, ('无障碍填写成功',))
        command.assert_called_once_with(['xdotool', 'key', '--clearmodifiers', 'ctrl+v'])

    def test_empty_type_never_pastes_old_clipboard(self):
        desktop = self.desktop()
        with patch.object(self.control, 'command') as command, patch.object(self.control.time, 'sleep'):
            desktop.action({'type': 'type', 'text': ''})
        desktop.clipboard.set_text.assert_not_called()
        command.assert_not_called()

    def test_clipboard_failure_never_sends_paste(self):
        desktop = self.desktop()
        desktop.clipboard.set_text.side_effect = self.control.ClipboardError('Clipboard unavailable')
        with patch.object(self.control, 'command') as command, patch.object(self.control.time, 'sleep'):
            with self.assertRaises(self.control.RequestError):
                desktop.action({'type': 'type', 'text': 'new'})
        command.assert_not_called()
        self.assertGreaterEqual(desktop.accessibility.invalidate.call_count, 1)

    def test_stop_clears_clipboard_even_without_browser(self):
        desktop = self.desktop()
        desktop.browser = None
        desktop.stop()
        desktop.clipboard.clear.assert_called_once()

    def test_target_type_stays_native_and_does_not_use_clipboard(self):
        desktop = self.desktop()
        desktop.browser = SimpleNamespace(pid=42)
        with patch.object(self.control, 'command') as command, patch.object(self.control.time, 'sleep'):
            desktop.action({'type': 'type', 'target': 'ax-native-1', 'text': 'native'})
        desktop.accessibility.action.assert_called_once()
        desktop.clipboard.set_text.assert_not_called()
        command.assert_not_called()


if __name__ == '__main__':
    unittest.main()
