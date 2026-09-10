"""Linux descriptor-based collection tests; run inside the desktop image too."""

import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'docker'))
import workspace


@unittest.skipUnless(os.name == 'posix' and hasattr(os, 'O_NOFOLLOW'), 'Linux file descriptor APIs required')
class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_nested_unicode_file_and_revision(self):
        directory = self.root / 'nested'
        directory.mkdir()
        item = directory / '中文.txt'
        item.write_text('第一版', encoding='utf-8')
        result = workspace.list_files(self.root)
        self.assertEqual(result[0]['name'], 'nested/中文.txt')
        revision = result[0]['revision']
        self.assertEqual(workspace.read_file(self.root, result[0]['name'], revision), '第一版'.encode())
        item.write_text('第二版', encoding='utf-8')
        os.utime(item, ns=(item.stat().st_atime_ns, int(revision) + 1000))
        with self.assertRaises(workspace.CollectionError) as error:
            workspace.read_file(self.root, result[0]['name'], revision)
        self.assertEqual(error.exception.status, 409)

    def test_symlinks_special_files_and_oversize_excluded(self):
        (self.root / 'real.txt').write_text('okay')
        (self.root / 'file-link').symlink_to(self.root / 'real.txt')
        (self.root / 'dir-link').symlink_to(self.root, target_is_directory=True)
        os.mkfifo(self.root / 'fifo')
        with (self.root / 'large.bin').open('wb') as file:
            file.truncate(workspace.MAX_FILE_SIZE + 1)
        self.assertEqual([item['name'] for item in workspace.list_files(self.root)], ['real.txt'])
        for name in ('file-link', 'dir-link/real.txt', 'fifo', 'large.bin'):
            with self.subTest(name=name), self.assertRaises(workspace.CollectionError):
                workspace.read_file(self.root, name)

    def test_symbolic_task_root_rejected(self):
        root = self.root / 'real'
        root.mkdir()
        (root / 'text.txt').write_text('test')
        link = self.root / 'link'
        link.symlink_to(root, target_is_directory=True)
        self.assertEqual(workspace.list_files(link), [])
        with self.assertRaises(workspace.CollectionError):
            workspace.read_file(link, 'text.txt')

    def test_file_count_bounded_and_browser_does_not_recurse(self):
        nested = self.root / 'nested'
        nested.mkdir()
        (nested / 'hidden.txt').write_text('nested')
        for index in range(workspace.MAX_FILES + 10):
            (self.root / f'{index}.txt').write_text('file')
        result = workspace.list_files(self.root, nested=False)
        self.assertEqual(len(result), workspace.MAX_FILES)
        self.assertTrue(all('/' not in item['name'] for item in result))
        with self.assertRaises(workspace.CollectionError):
            workspace.read_file(self.root, 'nested/hidden.txt', nested=False)


if __name__ == '__main__':
    unittest.main()
