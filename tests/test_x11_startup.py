"""Restart guard checks without operating the host display or processes."""

import errno
from pathlib import Path
import stat
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'docker'))
import x11_startup as startup


class ProbeTests(unittest.TestCase):
    def test_responsive_display_preserves_endpoints(self):
        with patch.object(startup.subprocess, 'run', return_value=SimpleNamespace(returncode=0)), \
                patch.object(startup, 'x_server_running') as process_probe:
            with self.assertRaises(startup.StartupError):
                startup.require_unused_display()
        process_probe.assert_not_called()

    def test_unresponsive_live_x_server_preserves_endpoints(self):
        with patch.object(startup.subprocess, 'run', return_value=SimpleNamespace(returncode=1)), \
                patch.object(startup, 'x_server_running', return_value=True), \
                patch.object(startup, 'socket_listening') as sockets:
            with self.assertRaises(startup.StartupError):
                startup.require_unused_display()
        sockets.assert_not_called()

    def test_probe_timeout_is_not_mistaken_for_unused_display(self):
        with patch.object(startup.subprocess, 'run', side_effect=subprocess.TimeoutExpired('xdotool', 2)):
            with self.assertRaises(startup.StartupError):
                startup.require_unused_display()

    def test_both_socket_names_checked_and_any_listener_prevents_cleanup(self):
        with patch.object(startup.subprocess, 'run', return_value=SimpleNamespace(returncode=1)), \
                patch.object(startup, 'x_server_running', return_value=False), \
                patch.object(startup, 'socket_listening', side_effect=[False, True]) as sockets:
            with self.assertRaises(startup.StartupError):
                startup.require_unused_display()
        self.assertEqual([call.args[0] for call in sockets.call_args_list],
                         ['/tmp/.X11-unix/X99', '\0/tmp/.X11-unix/X99'])

    def test_socket_refusal_is_stale_but_other_errors_are_uncertain(self):
        for error, expected in ((errno.ECONNREFUSED, False), (errno.ENOENT, False), (errno.EACCES, None)):
            connection = Mock()
            connection.__enter__ = Mock(return_value=connection)
            connection.__exit__ = Mock(return_value=False)
            connection.connect.side_effect = OSError(error, 'synthetic')
            with patch.object(startup.socket, 'socket', return_value=connection), \
                    patch.object(startup.socket, 'AF_UNIX', 1, create=True):
                if expected is None:
                    with self.assertRaises(startup.StartupError):
                        startup.socket_listening('/tmp/.X11-unix/X99')
                else:
                    self.assertIs(startup.socket_listening('/tmp/.X11-unix/X99'), expected)


class CleanupTests(unittest.TestCase):
    def setUp(self):
        for name in ('O_DIRECTORY', 'O_NOFOLLOW'):
            patcher = patch.object(startup.os, name, 0, create=True)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.open = patch.object(startup.os, 'open', side_effect=[10, 11]).start()
        self.close = patch.object(startup.os, 'close').start()
        self.unlink = patch.object(startup.os, 'unlink').start()
        self.check = patch.object(startup, 'require_unused_display').start()
        self.addCleanup(patch.stopall)
        self.lock = (1, 20, stat.S_IFREG | 0o600, 1000, 10, 100)
        self.socket = (1, 21, stat.S_IFSOCK | 0o700, 1000, 0, 100)

    def test_only_two_fixed_paths_removed_after_revalidation(self):
        with patch.object(startup, 'endpoint_info', side_effect=[self.lock, self.socket, self.lock, self.socket]):
            self.assertEqual(startup.cleanup_stale_display(), 2)
        self.assertEqual([(call.args, call.kwargs) for call in self.unlink.call_args_list],
                         [(('.X99-lock',), {'dir_fd': 10}), (('X99',), {'dir_fd': 11})])
        self.assertEqual(self.check.call_count, 3)

    def test_active_display_does_not_remove_anything(self):
        self.check.side_effect = startup.StartupError('active')
        with patch.object(startup, 'endpoint_info', side_effect=[self.lock, self.socket]):
            with self.assertRaises(startup.StartupError):
                startup.cleanup_stale_display()
        self.unlink.assert_not_called()

    def test_changed_endpoint_is_preserved(self):
        changed = (*self.lock[:-1], 101)
        with patch.object(startup, 'endpoint_info', side_effect=[self.lock, self.socket, changed]):
            with self.assertRaises(startup.StartupError):
                startup.cleanup_stale_display()
        self.unlink.assert_not_called()

    def test_symbolic_socket_parent_is_rejected_without_removal(self):
        self.open.side_effect = [10, OSError(errno.ELOOP, 'synthetic')]
        with patch.object(startup, 'endpoint_info', return_value=self.lock):
            with self.assertRaises(OSError):
                startup.cleanup_stale_display()
        self.unlink.assert_not_called()

    def test_symbolic_or_foreign_endpoint_rejected(self):
        for mode, uid in ((stat.S_IFLNK | 0o777, 1000), (stat.S_IFREG | 0o600, 0)):
            info = SimpleNamespace(st_mode=mode, st_uid=uid)
            with patch.object(startup.os, 'stat', return_value=info), \
                    patch.object(startup.os, 'getuid', return_value=1000, create=True):
                with self.assertRaises(startup.StartupError):
                    startup.endpoint_info(10, '.X99-lock', stat.S_IFREG)


class ProcessTests(unittest.TestCase):
    def test_reused_lock_pid_for_non_x_process_does_not_block_or_get_signalled(self):
        process = Mock(name='unrelated')
        process.name = '42'
        process.__truediv__ = Mock(return_value=SimpleNamespace(read_text=lambda: 'python3\n'))
        with patch.object(startup.Path, 'iterdir', return_value=iter([process])):
            self.assertFalse(startup.x_server_running())

    def test_live_x_server_blocks_but_zombie_does_not(self):
        for state, expected in (('S', True), ('Z', False)):
            process = Mock()
            process.name = '42'
            process.__truediv__ = Mock(side_effect=lambda name: SimpleNamespace(
                read_text=lambda: 'Xvfb\n' if name == 'comm' else f'42 (Xvfb) {state} 1 42'))
            with patch.object(startup.Path, 'iterdir', return_value=iter([process])):
                self.assertIs(startup.x_server_running(), expected)


if __name__ == '__main__':
    unittest.main()
