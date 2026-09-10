"""Controller/window contracts without Docker, a display server, or credentials."""

import importlib.util
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

DOCKER = Path(__file__).resolve().parents[1] / 'docker'
sys.path.insert(0, str(DOCKER))
import windows
import workspace

SPEC = importlib.util.spec_from_file_location('desktop_control_tests', DOCKER / 'control.py')
control = importlib.util.module_from_spec(SPEC)
with patch.object(Path, 'mkdir'):
    SPEC.loader.exec_module(control)


class WindowTests(unittest.TestCase):
    def setUp(self):
        self.listing = ('0x0400001  0 123 40 50 800 500 mousepad.Mousepad demo Draft - Mousepad\n'
                        '0x0500001  0 999 50 50 800 500 thunar.Thunar demo Foreign\n'
                        '0x0600001  0 123 50 50 800 500 xterm.XTerm demo Terminal\n')
        self.command = Mock(side_effect=lambda argv, **_: SimpleNamespace(stdout=(
            self.listing if argv[:2] == ['wmctrl', '-lpGx'] else '_NET_ACTIVE_WINDOW(WINDOW): window id # 0x400001')))
        self.identity = patch.object(windows, 'process_identity', side_effect=lambda pid: (100, '88') if pid == 123 else (999, '2'))
        self.identity.start()
        self.addCleanup(self.identity.stop)
        self.store = windows.Windows(self.command, lambda: {100})

    def test_only_registered_allowlisted_windows_and_no_native_ids_exposed(self):
        rows = self.store.observe()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['appId'], 'editor')
        self.assertTrue(rows[0]['active'])
        self.assertTrue(rows[0]['id'].startswith('win-'))
        self.assertNotIn('0x0400001', rows[0]['id'])

    def test_focus_is_fixed_argv_and_snapshot_single_use(self):
        target = self.store.observe()[0]['id']
        self.store.operate(target)
        self.command.assert_called_with(['wmctrl', '-ia', '0x400001'])
        with self.assertRaises(ValueError):
            self.store.operate(target)

    def test_close_requests_window_manager_and_never_kills(self):
        target = self.store.observe()[0]['id']
        self.store.operate(target, close=True)
        self.command.assert_called_with(['wmctrl', '-ic', '0x400001'])

    def test_unknown_id_consumes_other_ids(self):
        target = self.store.observe()[0]['id']
        with self.assertRaises(ValueError):
            self.store.operate('win-unknown')
        with self.assertRaises(ValueError):
            self.store.operate(target)

    def test_new_observation_replaces_ids(self):
        old = self.store.observe()[0]['id']
        self.assertNotEqual(old, self.store.observe()[0]['id'])
        with self.assertRaises(ValueError):
            self.store.operate(old)

    def test_title_pid_or_process_reuse_invalidates_target(self):
        for changed in (self.listing.replace('Draft', 'Changed'), self.listing.replace('123', '999'), ''):
            with self.subTest(changed=changed):
                initial = self.listing
                target = self.store.observe()[0]['id']
                self.listing = changed
                with self.assertRaises(ValueError):
                    self.store.operate(target)
                self.listing = initial
        target = self.store.observe()[0]['id']
        with patch.object(windows, 'process_identity', return_value=(100, '89')):
            with self.assertRaises(ValueError):
                self.store.operate(target)


class ControllerTests(unittest.TestCase):
    def desktop(self):
        obj = object.__new__(control.Desktop)
        obj.lock = threading.RLock()
        obj.mode, obj.active, obj.browser = 'desktop', True, None
        obj.workspace = Path('/workspace/tasks/test')
        obj.processes = []
        obj.accessibility, obj.clipboard, obj.windows = Mock(), Mock(), Mock()
        obj.windows.current.return_value = []
        return obj

    def test_input_does_not_depend_on_browser_process(self):
        obj = self.desktop()
        with patch.object(control, 'command') as command, patch.object(control.time, 'sleep'):
            obj.action({'type': 'key', 'key': 'Ctrl+S'})
        command.assert_called_once_with(['xdotool', 'key', '--clearmodifiers', 'ctrl+s'])

    def test_every_failed_action_invalidates_all_ids(self):
        obj = self.desktop()
        with self.assertRaises(control.RequestError):
            obj.action({'type': 'shell', 'text': 'anything'})
        obj.windows.invalidate.assert_called_once()
        obj.accessibility.invalidate.assert_called_once()

    def test_coordinate_double_and_right_click_and_ax_target_rejected(self):
        for kind, button in (('double_click', '1'), ('right_click', '3')):
            obj = self.desktop()
            with patch.object(control, 'command') as command, patch.object(control.time, 'sleep'):
                obj.action({'type': kind, 'x': 22, 'y': 33})
            argv = command.call_args.args[0]
            self.assertEqual(argv[:4], ['xdotool', 'mousemove', '22', '33'])
            self.assertEqual(argv[-1], button)
            if kind == 'double_click':
                self.assertIn('--repeat', argv)
            with self.assertRaises(control.RequestError):
                obj.action({'type': kind, 'target': 'ax-old'})

    def test_window_operations_reject_extra_input_or_browser_mode(self):
        obj = self.desktop()
        with self.assertRaises(control.RequestError):
            obj.action({'type': 'focus_window', 'target': 'win-abc', 'text': 'injected'})
        obj.windows.operate.assert_not_called()
        obj.mode = 'browser'
        obj.browser = Mock()
        obj.browser.poll.return_value = None
        with self.assertRaises(control.RequestError):
            obj.action({'type': 'close_window', 'target': 'win-abc'})
        obj.windows.operate.assert_not_called()

    def test_no_arbitrary_app_or_launch_argument(self):
        obj = self.desktop()
        for target in ('terminal', '/bin/sh', 'files --command anything'):
            with self.assertRaises(control.RequestError), patch.object(control.subprocess, 'Popen') as popen:
                obj.launch_app(target)
            popen.assert_not_called()

    def test_scroll_uses_active_native_window_center(self):
        obj = self.desktop()
        obj.windows.current.return_value = [{'active': True, 'bounds': [20, 30, 200, 100]}]
        with patch.object(control, 'command') as command, patch.object(control.time, 'sleep'):
            obj.action({'type': 'scroll', 'deltaY': 100})
        self.assertEqual(command.call_args.args[0][:4], ['xdotool', 'mousemove', '120', '80'])

    def test_key_aliases_include_document_and_window_shortcuts(self):
        for key, value in (('ctrl+s', 'ctrl+s'), ('controlormeta+shift+s', 'ctrl+shift+s'),
                           ('alt+f4', 'alt+F4'), ('shift+arrowleft', 'shift+Left'), ('f2', 'F2')):
            self.assertEqual(control.KEY_ALIASES[key], value)

    def test_unavailable_observation_consumes_previous_accessibility_ids(self):
        obj = self.desktop()
        obj.windows.observe.return_value = []
        obj.screenshot = Mock(return_value=b'png')
        observation = obj.observation()
        obj.accessibility.invalidate.assert_called_once()
        self.assertEqual(observation['accessibility']['status'], 'unavailable')
        self.assertEqual(observation['desktop']['workspace'], '/workspace/tasks/test' if sys.platform != 'win32' else '\\workspace\\tasks\\test')

    def test_registered_descendant_survives_leader_exit_but_reused_pid_does_not(self):
        obj = self.desktop()
        process = Mock(pid=100)
        process.poll.return_value = 0
        entry = {'process': process, 'identity': (100, 'leader'), 'appId': 'files',
                 'members': {100: (100, 'leader'), 101: (100, 'child')}}
        obj.processes = [entry]
        with patch.object(control, 'process_identity', side_effect=lambda pid: (100, 'child') if pid == 101 else None), \
                patch.object(control.os, 'scandir', side_effect=OSError):
            self.assertEqual(obj.process_groups(), {100})
        with patch.object(control, 'process_identity', return_value=(100, 'recycled')), \
                patch.object(control.os, 'scandir', side_effect=OSError):
            self.assertEqual(obj.process_groups(), set())

    def test_stop_keeps_workspace_and_kills_registered_children_after_leader_exit(self):
        obj = self.desktop()
        process = Mock(pid=100)
        process.poll.return_value = 0
        obj.processes = [{'process': process, 'identity': (100, 'leader'), 'appId': 'files',
                          'members': {101: (100, 'child')}}]
        obj.process_groups = Mock(return_value={100})
        obj.group_alive = Mock(side_effect=[True, False, False])
        with patch.object(control.os, 'killpg', create=True) as kill:
            obj.stop()
        kill.assert_called_once_with(100, control.signal.SIGTERM)
        self.assertEqual(obj.workspace, Path('/workspace/tasks/test'))
        self.assertFalse(obj.active)


class WorkspaceNameTests(unittest.TestCase):
    def test_traversal_and_host_unsafe_names_rejected(self):
        for name in ('../a', 'a/../b', '/absolute', 'a//b', 'a\\b', 'C:x', 'bad\x7f', 'bad\x00', 'a.tmp'):
            with self.subTest(name=name), self.assertRaises(workspace.CollectionError):
                workspace.parts_for(name)
        self.assertEqual(workspace.parts_for('nested/中文.txt'), ['nested', '中文.txt'])


if __name__ == '__main__':
    unittest.main()
