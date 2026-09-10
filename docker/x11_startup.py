"""Remove only stale display :99 endpoints left by a stopped container.

A Docker restart retains /tmp but replaces the PID namespace. A PID written in
an old lock can therefore belong to an unrelated new process; never signal it.
"""

import errno
import os
from pathlib import Path
import socket
import stat
import subprocess

X_SERVERS = {'X', 'Xorg', 'Xvfb', 'Xwayland', 'Xvnc', 'Xephyr', 'Xnest'}


class StartupError(Exception):
    pass


def x_server_running():
    for index, process in enumerate(Path('/proc').iterdir()):
        if index >= 4096:
            raise StartupError('Too many processes to verify the virtual display safely.')
        if not process.name.isdecimal():
            continue
        try:
            name = (process / 'comm').read_text().strip()
            if name in X_SERVERS:
                state = (process / 'stat').read_text().rsplit(')', 1)[1].split()[0]
                if state != 'Z':
                    return True
        except FileNotFoundError:
            # Processes may exit between directory enumeration and inspection.
            continue
    return False


def socket_listening(address):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(0.5)
        try:
            connection.connect(address)
            return True
        except OSError as error:
            if error.errno in (errno.ENOENT, errno.ECONNREFUSED):
                return False
            raise StartupError('Cannot confirm the virtual display socket is unused.') from None


def require_unused_display():
    environment = {key: value for key, value in os.environ.items()
                   if key.upper() not in ('DEMO_CONTROL_TOKEN', 'CODEX_API_KEY')
                   and not key.upper().startswith('OPENAI_')}
    environment['DISPLAY'] = ':99'
    try:
        probe = subprocess.run(['xdotool', 'getdisplaygeometry'], env=environment,
                               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, timeout=2, check=False)
    except subprocess.TimeoutExpired:
        raise StartupError('The virtual display probe timed out; existing endpoints were preserved.') from None
    if (probe.returncode == 0 or x_server_running()
            or socket_listening('/tmp/.X11-unix/X99')
            or socket_listening('\0/tmp/.X11-unix/X99')):
        raise StartupError('An X server is already active; existing endpoints were preserved.')


def endpoint_info(descriptor, name, expected_type):
    try:
        info = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
    except FileNotFoundError:
        return None
    if stat.S_IFMT(info.st_mode) != expected_type or info.st_uid != os.getuid():
        raise StartupError('Unexpected virtual display endpoint type or owner; startup stopped.')
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_size, info.st_mtime_ns)


def cleanup_stale_display():
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    temporary = os.open('/tmp', flags)
    sockets = None
    try:
        # Directory descriptors prevent a changed/symbolic parent from redirecting
        # either unlink. Symlinks and unexpected endpoint types are rejected.
        targets = []
        lock = endpoint_info(temporary, '.X99-lock', stat.S_IFREG)
        if lock is not None:
            targets.append((temporary, '.X99-lock', stat.S_IFREG, lock))
        try:
            sockets = os.open('.X11-unix', flags, dir_fd=temporary)
        except FileNotFoundError:
            pass
        if sockets is not None:
            endpoint = endpoint_info(sockets, 'X99', stat.S_IFSOCK)
            if endpoint is not None:
                targets.append((sockets, 'X99', stat.S_IFSOCK, endpoint))
        require_unused_display()
        removed = 0
        for descriptor, name, expected_type, observed in targets:
            require_unused_display()
            current = endpoint_info(descriptor, name, expected_type)
            if current is None:
                continue
            if current != observed:
                raise StartupError('A virtual display endpoint changed; startup stopped.')
            os.unlink(name, dir_fd=descriptor)
            removed += 1
        return removed
    finally:
        if sockets is not None:
            os.close(sockets)
        os.close(temporary)


def main():
    try:
        if cleanup_stale_display():
            print('Removed stale display :99 endpoints from the previous container run.', flush=True)
    except StartupError as error:
        raise SystemExit(str(error)) from None
    except (OSError, ValueError, IndexError):
        raise SystemExit('Virtual display endpoints could not be verified; startup stopped.') from None


if __name__ == '__main__':
    main()
