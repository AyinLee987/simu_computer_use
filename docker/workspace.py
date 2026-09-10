"""Bounded output collection; the container user remains the GUI security boundary."""

from contextlib import contextmanager
import os
from pathlib import PurePosixPath
import stat

MAX_FILES = 100
MAX_FILE_SIZE = 20 * 1024 * 1024
MAX_ENTRIES = 2000
MAX_DEPTH = 8


class CollectionError(Exception):
    def __init__(self, message, status=404):
        super().__init__(message)
        self.status = status


def parts_for(name):
    if (not isinstance(name, str) or not name or len(name) > 300 or '\\' in name or ':' in name
            or any(ord(char) < 32 or ord(char) == 127 for char in name)):
        raise CollectionError('文件不存在。')
    parts = name.split('/')
    if len(parts) > MAX_DEPTH or any(part in ('', '.', '..') for part in parts):
        raise CollectionError('文件不存在。')
    if name.endswith(('.crdownload', '.tmp', '.download')):
        raise CollectionError('文件尚未准备好。')
    return parts


@contextmanager
def directory_fd(root):
    # Open every component without following symlinks, including the task root.
    root = PurePosixPath(root)
    if not root.is_absolute():
        raise CollectionError('任务目录无效。')
    descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in root.parts[1:]:
            if part in ('.', '..'):
                raise CollectionError('任务目录无效。')
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        yield descriptor
    finally:
        os.close(descriptor)


def regular(info):
    return stat.S_ISREG(info.st_mode) and info.st_size <= MAX_FILE_SIZE


def list_files(root, *, nested=True):
    output, scanned = [], 0

    def visit(descriptor, prefix='', depth=1):
        nonlocal scanned
        # Do not materialize an unbounded directory listing merely to sort it.
        with os.scandir(descriptor) as entries:
            for item in entries:
                scanned += 1
                if scanned > MAX_ENTRIES or len(output) >= MAX_FILES:
                    return
                name = prefix + item.name
                try:
                    parts_for(name)
                    info = item.stat(follow_symlinks=False)
                    if regular(info):
                        output.append({'name': name, 'size': info.st_size, 'revision': str(info.st_mtime_ns)})
                    elif nested and depth < MAX_DEPTH and stat.S_ISDIR(info.st_mode):
                        child = os.open(item.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
                        try:
                            visit(child, name + '/', depth + 1)
                        finally:
                            os.close(child)
                except (OSError, CollectionError):
                    continue

    try:
        with directory_fd(str(root)) as descriptor:
            visit(descriptor)
    except OSError:
        return []
    return sorted(output, key=lambda item: item['name'])


def read_file(root, name, revision=None, *, nested=True):
    parts = parts_for(name)
    if not nested and len(parts) != 1:
        raise CollectionError('文件不存在。')
    if revision is not None and (not isinstance(revision, str) or not revision.isdecimal() or len(revision) > 30):
        raise CollectionError('文件版本无效。', 400)
    opened = []
    try:
        with directory_fd(str(root)) as parent:
            for part in parts[:-1]:
                parent = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                opened.append(parent)
            descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            opened.append(descriptor)
            before = os.fstat(descriptor)
            if not regular(before):
                raise CollectionError('文件不存在或超过 20 MiB。')
            if revision is not None and revision != str(before.st_mtime_ns):
                raise CollectionError('文件已更新，请重新收集。', 409)
            chunks, length = [], 0
            while True:
                chunk = os.read(descriptor, min(1024 * 1024, MAX_FILE_SIZE + 1 - length))
                if not chunk:
                    break
                chunks.append(chunk)
                length += len(chunk)
                if length > MAX_FILE_SIZE:
                    raise CollectionError('文件超过 20 MiB。')
            after = os.fstat(descriptor)
            if ((before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                    != (after.st_size, after.st_mtime_ns, after.st_ctime_ns) or length != after.st_size):
                raise CollectionError('文件正在更新，请重新收集。', 409)
            return b''.join(chunks)
    except OSError:
        raise CollectionError('文件不存在。') from None
    finally:
        for descriptor in reversed(opened):
            os.close(descriptor)
