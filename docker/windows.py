"""Only observed windows from registered application process groups are targetable."""

import os
from pathlib import Path
import re
import secrets

MAX_WINDOWS = 40
CLASSES = {'thunar': 'files', 'mousepad': 'editor', 'chromium': 'browser', 'chromium-browser': 'browser'}


def process_identity(pid):
    try:
        # Linux stat field 22 is starttime; comm may contain spaces or parentheses.
        fields = Path(f'/proc/{int(pid)}/stat').read_text().rsplit(')', 1)[1].split()
        return (int(fields[2]), fields[19])  # process group and start time
    except (OSError, ValueError, IndexError, TypeError):
        return None


class Windows:
    def __init__(self, command, groups):
        self.command, self.groups = command, groups
        self.targets = {}

    def invalidate(self):
        self.targets = {}

    def current(self):
        groups = self.groups()
        if not groups:
            return []
        listing = self.command(['wmctrl', '-lpGx'], timeout=2, capture=True).stdout
        active_output = self.command(['xprop', '-root', '_NET_ACTIVE_WINDOW'], timeout=2, capture=True).stdout
        match = re.search(r'0x[0-9a-fA-F]+', active_output)
        active = int(match[0], 16) if match else None
        rows = []
        for line in listing.splitlines()[:200]:
            parts = line.split(None, 9)
            if len(parts) < 9 or not re.fullmatch(r'0x[0-9a-fA-F]+', parts[0]):
                continue
            try:
                xid, pid = int(parts[0], 16), int(parts[2])
                rect = [int(value) for value in parts[3:7]]
                identity = process_identity(pid)
                if identity is None or identity[0] not in groups:
                    continue
                app_id = next((CLASSES[value] for value in parts[7].lower().split('.') if value in CLASSES), None)
                if app_id is None:
                    continue
                title = (parts[9] if len(parts) > 9 else '').replace('\x00', '')[:240]
                rows.append({'xid': xid, 'pid': pid, 'identity': identity, 'appId': app_id,
                             'title': title, 'active': xid == active, 'bounds': rect,
                             'windowClass': parts[7]})
                if len(rows) >= MAX_WINDOWS:
                    break
            except (ValueError, TypeError):
                continue
        return rows

    def observe(self):
        self.invalidate()
        snapshot = secrets.token_hex(12)
        rows = self.current()
        for index, row in enumerate(rows):
            row['id'] = f'win-{snapshot}-{index + 1}'
            self.targets[row['id']] = row
        return rows

    def consume(self, target):
        targets, self.targets = self.targets, {}
        previous = targets.get(target) if isinstance(target, str) else None
        if previous is None:
            raise ValueError('窗口标识已过期或不存在，请重新观察。')
        for current in self.current():
            if all(current[key] == previous[key] for key in ('xid', 'pid', 'identity', 'appId', 'title', 'windowClass')):
                # Re-read PID identity immediately before sending the WM request.
                if process_identity(current['pid']) == current['identity']:
                    return current
        raise ValueError('窗口已关闭或发生变化，请重新观察。')

    def operate(self, target, *, close=False):
        row = self.consume(target)
        # wmctrl -c requests _NET_CLOSE_WINDOW; it does not kill the process.
        self.command(['wmctrl', '-ic' if close else '-ia', hex(row['xid'])])
        return row
