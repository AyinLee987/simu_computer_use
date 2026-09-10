"""No GUI, Docker, D-Bus, model or credentials required: python -m unittest discover -s tests -p test_accessibility.py."""

import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

MODULE_PATH = Path(__file__).resolve().parents[1] / 'docker' / 'accessibility.py'
SPEC = importlib.util.spec_from_file_location('accessibility', MODULE_PATH)
accessibility = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = accessibility
SPEC.loader.exec_module(accessibility)

STATE = SimpleNamespace(**{name: name for name in accessibility.SEMANTIC_STATES})


class Node:
    def __init__(self, name='', role='push button', *, pid=42, children=None,
                 states=None, text='', password=False, actions=('click',), editable=False,
                 bounds=(10, 10, 100, 30)):
        self.name, self.role, self.pid = name, role, pid
        self.children = children or []
        self.states = set(states if states is not None else ('VISIBLE', 'SHOWING', 'ENABLED', 'SENSITIVE'))
        self.text, self.password, self.actions, self.editable = text, password, actions, editable
        if editable:
            self.states.add('EDITABLE')
        self.bounds = bounds
        self.parent = object()
        self.invocations, self.replacements, self.text_reads = [], [], 0
        self.success = True

    def clear_cache(self):
        pass

    def get_state_set(self):
        return SimpleNamespace(contains=lambda state: state in self.states)

    def get_process_id(self):
        return self.pid

    def get_interfaces(self):
        return ['Component', 'Text'] + (['Action'] if self.actions else []) + (['EditableText'] if self.editable else [])

    def get_component_iface(self):
        return SimpleNamespace(get_extents=lambda _: SimpleNamespace(**dict(zip(('x', 'y', 'width', 'height'), self.bounds))))

    def get_role_name(self):
        return 'password text' if self.password else self.role

    def get_role(self):
        return 'PASSWORD_TEXT' if self.password else self.role

    def get_name(self):
        return self.name

    def get_parent(self):
        return self.parent

    def get_text_iface(self):
        self.text_reads += 1
        if self.password:
            raise AssertionError('Password text must never be requested')
        return SimpleNamespace(get_character_count=lambda: len(self.text), get_text=lambda start, end: self.text[start:end])

    def get_action_iface(self):
        def invoke(index):
            self.invocations.append(index)
            return self.success
        return SimpleNamespace(get_n_actions=lambda: len(self.actions), get_action_name=lambda index: self.actions[index], do_action=invoke)

    def get_editable_text_iface(self):
        def replace(value):
            self.replacements.append(value)
            self.text = value
            return self.success
        return SimpleNamespace(set_text_contents=replace)

    def get_child_count(self):
        return len(self.children)

    def get_child_at_index(self, index):
        return self.children[index]


def store_for(*nodes, applications=None, clock=None):
    app = Node(role='application', actions=(), states=(), children=list(nodes))
    desktop = Node(children=applications if applications is not None else [app])
    api = SimpleNamespace(StateType=STATE, Role=SimpleNamespace(PASSWORD_TEXT='PASSWORD_TEXT'),
                          CoordType=SimpleNamespace(SCREEN=0), get_desktop=lambda _: desktop)
    kwargs = {'clock': clock} if clock else {}
    return accessibility.SnapshotStore(api, lambda pid, browser_pid: pid == browser_pid == 42, **kwargs)


class AccessibilityTests(unittest.TestCase):
    def observe(self, store):
        return store.observe(42, 1000, 720)

    def test_click_is_semantic_and_snapshot_is_single_use(self):
        button = Node('Save')
        store = store_for(button)
        snapshot = self.observe(store)
        self.assertEqual(snapshot['status'], 'ready')
        target = snapshot['controls'][0]['id']
        store.act({'type': 'click', 'target': target}, 42)
        self.assertEqual(button.invocations, [0])
        with self.assertRaises(accessibility.AccessibilityError):
            store.act({'type': 'click', 'target': target}, 42)

    def test_unknown_id_rejects_and_consumes_snapshot(self):
        button = Node('Save')
        store = store_for(button)
        target = self.observe(store)['controls'][0]['id']
        with self.assertRaises(accessibility.AccessibilityError):
            store.act({'type': 'click', 'target': 'ax-unknown'}, 42)
        with self.assertRaises(accessibility.AccessibilityError):
            store.act({'type': 'click', 'target': target}, 42)
        self.assertEqual(button.invocations, [])

    def test_new_observation_invalidates_old_ids(self):
        store = store_for(Node('Save'))
        first = self.observe(store)['controls'][0]['id']
        second = self.observe(store)['controls'][0]['id']
        self.assertNotEqual(first, second)
        with self.assertRaises(accessibility.AccessibilityError):
            store.act({'type': 'click', 'target': first}, 42)

    def test_changed_properties_disappeared_or_foreign_process_rejected(self):
        changes = [lambda n: setattr(n, 'name', 'Delete'),
                   lambda n: setattr(n, 'bounds', (12, 10, 100, 30)),
                   lambda n: n.states.discard('ENABLED'),
                   lambda n: n.states.add('DEFUNCT'),
                   lambda n: setattr(n, 'parent', None),
                   lambda n: setattr(n, 'pid', 999),
                   lambda n: setattr(n, 'text', 'changed')]
        for change in changes:
            with self.subTest(change=change):
                button = Node('Save')
                store = store_for(button)
                target = self.observe(store)['controls'][0]['id']
                change(button)
                with self.assertRaises(accessibility.AccessibilityError):
                    store.act({'type': 'click', 'target': target}, 42)
                self.assertEqual(button.invocations, [])

    def test_disabled_nodes_have_no_actions(self):
        button = Node('Save', states=('VISIBLE', 'SHOWING'), editable=True)
        store = store_for(button)
        control = self.observe(store)['controls'][0]
        self.assertFalse(control['enabled'])
        self.assertEqual(control['actions'], [])
        with self.assertRaises(accessibility.AccessibilityError):
            store.act({'type': 'click', 'target': control['id']}, 42)

    def test_semantic_state_changes_invalidate_old_targets(self):
        for state in ('COLLAPSED', 'EXPANDED', 'EXPANDABLE', 'SELECTED', 'INDETERMINATE',
                      'READ_ONLY', 'CHECKED', 'PRESSED', 'BUSY', 'FOCUSED'):
            with self.subTest(state=state):
                node = Node('Widget')
                store = store_for(node)
                target = self.observe(store)['controls'][0]['id']
                node.states.add(state)
                with self.assertRaises(accessibility.AccessibilityError):
                    store.act({'type': 'click', 'target': target}, 42)
                self.assertEqual(node.invocations, [])

    def test_expansion_and_selection_are_explicit_when_supported(self):
        node = Node('Section')
        node.states.update(('EXPANDABLE', 'COLLAPSED', 'SELECTABLE'))
        store = store_for(node)
        control = self.observe(store)['controls'][0]
        self.assertIs(control['expanded'], False)
        self.assertIs(control['selected'], False)
        node.states.discard('COLLAPSED')
        node.states.update(('EXPANDED', 'SELECTED'))
        control = self.observe(store)['controls'][0]
        self.assertIs(control['expanded'], True)
        self.assertIs(control['selected'], True)

    def test_mixed_checkbox_does_not_report_unchecked(self):
        checkbox = Node('All items', role='check box')
        checkbox.states.add('INDETERMINATE')
        store = store_for(checkbox)
        control = self.observe(store)['controls'][0]
        self.assertIs(control['indeterminate'], True)
        self.assertIsNone(control['checked'])
        checkbox.states.discard('INDETERMINATE')
        checkbox.states.add('CHECKED')
        control = self.observe(store)['controls'][0]
        self.assertIs(control['indeterminate'], False)
        self.assertIs(control['checked'], True)

    def test_read_only_text_does_not_offer_type(self):
        field = Node('Title', editable=True, actions=())
        field.states.add('READ_ONLY')
        store = store_for(field)
        control = self.observe(store)['controls'][0]
        self.assertEqual(control['actions'], [])
        with self.assertRaises(accessibility.AccessibilityError):
            store.act({'type': 'type', 'target': control['id'], 'text': 'new'}, 42)

    def test_password_values_and_descendants_are_not_read_or_returned(self):
        password = Node('Account password', text='secret-test-only', password=True,
                        children=[Node('secret-child-test-only')], editable=True, actions=())
        store = store_for(password)
        snapshot = self.observe(store)
        self.assertEqual(password.text_reads, 0)
        self.assertEqual(snapshot['controls'][0]['value'], '')
        self.assertTrue(snapshot['controls'][0]['password'])
        self.assertNotIn('secret-test-only', json.dumps(snapshot))
        self.assertNotIn('secret-child-test-only', json.dumps(snapshot))

    def test_only_visible_in_bounds_current_application_nodes(self):
        nodes = [Node('Visible'), Node('Hidden', states=('ENABLED',)),
                 Node('Outside', bounds=(1000, 0, 100, 20)),
                 Node('Negative', bounds=(-100, 10, 20, 20)),
                 Node('Zero', bounds=(0, 0, 0, 20)),
                 Node('Clipped', bounds=(-10, -5, 30, 20)), Node('Foreign', pid=99)]
        snapshot = self.observe(store_for(*nodes))
        controls = {item['name']: item for item in snapshot['controls']}
        self.assertEqual(set(controls), {'Visible', 'Clipped'})
        self.assertEqual([controls['Clipped'][key] for key in ('x', 'y', 'width', 'height')], [0, 0, 20, 15])
        other = Node('Other app', pid=99, children=[Node('Not ours')])
        self.assertEqual(self.observe(store_for(applications=[other]))['status'], 'unavailable')

    def test_semantic_type_replaces_entire_value(self):
        field = Node('Title', editable=True, text='old', actions=())
        store = store_for(field)
        control = self.observe(store)['controls'][0]
        self.assertEqual(control['actions'], ['type'])
        store.act({'type': 'type', 'target': control['id'], 'text': 'new'}, 42)
        self.assertEqual(field.replacements, ['new'])
        self.assertEqual(field.invocations, [])

    def test_type_rejects_missing_unsupported_or_invalid_text(self):
        for value in (None, 12, 'x' * 2001, 'bad\x00text'):
            field = Node('Title', editable=True, actions=())
            store = store_for(field)
            target = self.observe(store)['controls'][0]['id']
            with self.assertRaises(accessibility.AccessibilityError):
                store.act({'type': 'type', 'target': target, 'text': value}, 42)
            self.assertEqual(field.replacements, [])
        field = Node('Title', editable=False, actions=())
        store = store_for(field)
        target = self.observe(store)['controls'][0]['id']
        with self.assertRaises(accessibility.AccessibilityError):
            store.act({'type': 'type', 'target': target, 'text': 'new'}, 42)

    def test_unknown_native_action_not_exposed_as_click(self):
        control = self.observe(store_for(Node('Widget', actions=('show context menu',))))['controls'][0]
        self.assertEqual(control['actions'], [])

    def test_check_and_uncheck_are_semantic_primary_actions(self):
        for native_action in ('check', 'uncheck'):
            with self.subTest(native_action=native_action):
                checkbox = Node('Reminder', role='check box', actions=(native_action, 'showContextMenu'))
                store = store_for(checkbox)
                control = self.observe(store)['controls'][0]
                self.assertEqual(control['actions'], ['click'])
                store.act({'type': 'click', 'target': control['id']}, 42)
                self.assertEqual(checkbox.invocations, [0])

    def test_failed_action_does_not_retry_and_consumes_snapshot(self):
        button = Node('Save')
        button.success = False
        store = store_for(button)
        target = self.observe(store)['controls'][0]['id']
        with self.assertRaises(accessibility.AccessibilityError):
            store.act({'type': 'click', 'target': target}, 42)
        self.assertEqual(button.invocations, [0])
        self.assertEqual(store.targets, {})

    def test_limits_are_explicit_and_strings_bounded(self):
        nodes = [Node('a' * 500, text='b' * 1000) for _ in range(200)]
        result = self.observe(store_for(*nodes))
        self.assertEqual(len(result['controls']), 150)
        self.assertTrue(result['truncated'])
        self.assertLessEqual(len(result['text']), accessibility.MAX_TEXT)
        self.assertEqual(len(result['controls'][0]['name']), 240)
        self.assertEqual(len(result['controls'][0]['value']), 512)

    def test_parent_text_does_not_duplicate_or_reveal_child_input_values(self):
        password = Node('Password', text='secret-test-only', password=True)
        parent = Node('Form', text='secret-test-only', children=[password], actions=())
        result = self.observe(store_for(parent))
        self.assertNotIn('secret-test-only', json.dumps(result))
        self.assertEqual(parent.text_reads, 0)

    def test_browser_session_change_invalidates_previous_targets(self):
        store = store_for(Node('Save'))
        target = self.observe(store)['controls'][0]['id']
        with self.assertRaises(accessibility.AccessibilityError):
            store.act({'type': 'click', 'target': target}, 43)
        self.assertEqual(store.targets, {})

    def test_empty_failed_or_no_browser_observations_are_unavailable(self):
        store = store_for()
        for result in (self.observe(store), store.observe(None, 1000, 720)):
            self.assertEqual(result['status'], 'unavailable')
            self.assertEqual(result['controls'], [])
        store.api.get_desktop = Mock(side_effect=RuntimeError('bus failed'))
        self.assertEqual(self.observe(store)['status'], 'unavailable')

    def test_timed_out_worker_is_closed_and_observation_degrades_explicitly(self):
        bridge = accessibility.AccessibilityBridge(timeout=0.001)
        bridge.process = Mock()
        bridge.process.is_alive.return_value = True
        bridge.connection = Mock()
        bridge.connection.poll.return_value = False
        result = bridge.observe(42, 1000, 720)
        self.assertEqual(result['status'], 'unavailable')
        self.assertIsNone(bridge.process)
        self.assertIsNone(bridge.connection)

    def test_timed_out_action_is_not_retried(self):
        bridge = accessibility.AccessibilityBridge(timeout=0.001)
        process = bridge.process = Mock()
        process.is_alive.return_value = True
        connection = bridge.connection = Mock()
        connection.poll.return_value = False
        with self.assertRaises(accessibility.AccessibilityError):
            bridge.action({'type': 'click', 'target': 'ax-test'}, 42)
        self.assertEqual(connection.send.call_count, 1)

    def test_registered_desktop_scope_reads_only_foreground_application(self):
        ours = Node('Editor text', pid=42, editable=True, actions=())
        other = Node('Background file', pid=55)
        store = store_for(applications=[
            Node(role='application', pid=42, states=(), actions=(), children=[ours]),
            Node(role='application', pid=55, states=(), actions=(), children=[other]),
        ])
        store.owns_process = lambda pid, scope: pid == scope['activeGroup'] and pid in scope['groups']
        scope = {'groups': [42, 55], 'activeGroup': 42,
                 'activeWindow': {'id': 123, 'pid': 42, 'title': 'Draft', 'bounds': [10, 10, 100, 30]}}
        snapshot = store.observe(scope, 1000, 720)
        self.assertEqual([item['name'] for item in snapshot['controls']], ['Editor text'])
        target = snapshot['controls'][0]['id']
        changed = {**scope, 'activeWindow': {**scope['activeWindow'], 'id': 456}}
        with self.assertRaises(accessibility.AccessibilityError):
            store.act({'type': 'type', 'target': target, 'text': 'new'}, changed)
        self.assertEqual(ours.replacements, [])

    def test_background_windows_in_same_application_are_not_traversed(self):
        visible = Node('Current', role='frame', children=[Node('Current button')])
        background = Node('Other', role='frame', children=[Node('Background button')])
        store = store_for(visible, background)
        store.owns_process = lambda pid, scope: pid == scope['activeGroup']
        scope = {'groups': [42], 'activeGroup': 42,
                 'activeWindow': {'id': 123, 'pid': 42, 'title': 'Current', 'bounds': [10, 10, 100, 30]}}
        snapshot = store.observe(scope, 1000, 720)
        self.assertIn('Current button', [item['name'] for item in snapshot['controls']])
        self.assertNotIn('Background button', [item['name'] for item in snapshot['controls']])


if __name__ == '__main__':
    unittest.main()
