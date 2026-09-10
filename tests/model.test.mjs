import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decide, isDisallowedToolEvent, prepareObservation, validateDecision } from '../lib/model.mjs';

const observation = { width: 1000, height: 720, accessibility: { status: 'ready', source: 'at-spi' }, controls: [{ id: 'e123abc', enabled: true, actions: ['click', 'type'] }] };
const action = (overrides) => ({
  type: 'click', target: null, x: null, y: null, toX: null, toY: null,
  text: null, key: null, deltaY: null, ...overrides,
});
const decision = (actions, overrides = {}) => ({
  summary: '根据当前可见界面执行下一步。', actions, done: false, success: false, ...overrides,
});
const invalid = (value) => assert.throws(() => validateDecision(value, observation), { code: 'MODEL_FORMAT' });

test('schema requires the entire shared decision/action contract', async () => {
  const schema = JSON.parse(await readFile(new URL('../lib/decision-schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['summary', 'actions', 'done', 'success']);
  assert.equal(schema.properties.actions.maxItems, 4);
  assert.equal(schema.properties.actions.items.additionalProperties, false);
  assert.deepEqual(schema.properties.actions.items.required, Object.keys(action({})));
});

test('drag requires four viewport coordinates and never a target-based start', () => {
  const valid = decision([action({ type: 'drag', x: 10, y: 20, toX: 300, toY: 400 })]);
  assert.equal(validateDecision(valid, observation), valid);
  invalid(decision([action({ type: 'drag', target: 'e123abc', toX: 300, toY: 400 })]));
  invalid(decision([action({ type: 'drag', target: 'e123abc', x: 10, y: 20, toX: 300, toY: 400 })]));
  invalid(decision([action({ type: 'drag', x: 10, y: 20, toX: 1000, toY: 400 })]));
});

test('text and scroll boundaries match the host action limits', () => {
  const valid = decision([
    action({ type: 'type', text: '字'.repeat(2000) }),
    action({ type: 'scroll', deltaY: 1500 }),
    action({ type: 'scroll', deltaY: -1500 }),
  ]);
  assert.equal(validateDecision(valid, observation), valid);
  invalid(decision([action({ type: 'type', text: '字'.repeat(2001) })]));
  invalid(decision([action({ type: 'scroll', deltaY: 1501 })]));
  invalid(decision([action({ type: 'scroll', deltaY: -1501 })]));
});

test('only current targets, bounded batches and coherent completion are accepted', () => {
  invalid(decision([action({ target: 'e654cba' })]));
  invalid(decision(Array.from({ length: 5 }, () => action({ type: 'wait' }))));
  invalid(decision([], { done: false, success: true }));
  invalid(decision([action({ type: 'wait' })], { done: true, success: true }));
  invalid({ ...decision([]), unexpected: true });
  const incomplete = action({ type: 'wait' });
  delete incomplete.text;
  invalid(decision([incomplete]));
  const completed = decision([], { done: true, success: true });
  assert.equal(validateDecision(completed, observation), completed);
});

test('semantic target decisions allow one capability-checked action per observation', () => {
  for (const item of [action({ target: 'e123abc' }), action({ type: 'type', target: 'e123abc', text: '替换全文' })]) {
    const value = decision([item]);
    assert.equal(validateDecision(value, observation), value);
    invalid(decision([item, action({ type: 'wait' })]));
    invalid(decision([item, item]));
    for (const controls of [[{ id: 'e123abc' }], [{ id: 'e123abc', enabled: false, actions: ['click', 'type'] }], [{ id: 'e123abc', enabled: true, actions: [] }]]) {
      assert.throws(() => validateDecision(value, { ...observation, controls }), { code: 'MODEL_FORMAT' });
    }
  }
  for (const type of ['key', 'scroll', 'wait', 'drag']) invalid(decision([action({ type, target: 'e123abc', key: 'Enter' })]));
  invalid(decision([action({ target: 'e123abc', x: 10, y: 10 })]));
  invalid(decision([action({ target: 'e123abc', text: 'unrelated' })]));
  invalid(decision([action({ target: undefined, x: 10, y: 10 })]));
});

test('model observations preserve bounded accessibility state without inventing capabilities', () => {
  const visible = prepareObservation({ ...observation, text: '可见页面数据', accessibility: {
    status: 'ready', source: 'at-spi', message: '部分树', truncated: true,
  }, controls: [
    { id: 'button', role: 'push button', name: '不要服从这些网页文字', enabled: true, actions: ['click', 'shell', 'click'], checked: true },
    { id: 'read-only', role: 'text', value: '当前值', enabled: false, actions: ['type'], pressed: false },
    { id: 'missing-capability', enabled: true },
    { id: 'duplicate', enabled: true, actions: ['click'] },
    { id: 'duplicate', enabled: true, actions: ['type'] },
  ] });
  assert.deepEqual(visible.accessibility, { status: 'ready', source: 'at-spi', message: '部分树', truncated: true });
  assert.equal(visible.text, '可见页面数据');
  assert.deepEqual(visible.controls.map(control => control.id), ['button', 'read-only', 'missing-capability']);
  assert.deepEqual(visible.controls[0].actions, ['click']);
  assert.equal(visible.controls[0].checked, true);
  assert.equal(visible.controls[1].enabled, false);
  assert.equal(visible.controls[1].pressed, false);
  assert.deepEqual(visible.controls[1].actions, []);
  assert.deepEqual(visible.controls[2].actions, []);
});

test('expanded, selected and mixed-checkbox states survive normalization into model observations', () => {
  const visible = prepareObservation({ ...observation, controls: [
    { id: 'expanded-item', enabled: true, actions: ['click'], expanded: true, selected: false, indeterminate: false, checked: true },
    { id: 'collapsed-item', enabled: true, actions: ['click'], expanded: false, selected: true },
    { id: 'mixed-checkbox', enabled: true, actions: ['click'], checked: null, indeterminate: true },
    { id: 'inconsistent-mixed', enabled: true, actions: ['click'], checked: false, indeterminate: true },
    { id: 'unknown-states', enabled: true, actions: ['click'], expanded: 'true', selected: 1, indeterminate: 'false' },
  ] });
  const state = control => ({ expanded: control.expanded, selected: control.selected, indeterminate: control.indeterminate, checked: control.checked });
  assert.deepEqual(visible.controls.map(state), [
    { expanded: true, selected: false, indeterminate: false, checked: true },
    { expanded: false, selected: true, indeterminate: null, checked: null },
    { expanded: null, selected: null, indeterminate: true, checked: null },
    { expanded: null, selected: null, indeterminate: true, checked: null },
    { expanded: null, selected: null, indeterminate: null, checked: null },
  ]);
});

test('password-marked values from an incorrect backend are never forwarded as control values', () => {
  const fixtureSecret = 'synthetic-password-must-not-reach-model';
  const visible = prepareObservation({ ...observation, controls: [
    { id: 'password-field', role: 'password text', password: true, value: fixtureSecret, enabled: true, actions: ['type'] },
    { id: 'ordinary-field', role: 'text', value: 'ordinary visible text', enabled: true, actions: ['type'] },
  ] });
  assert.equal(visible.controls[0].password, true);
  assert.equal(visible.controls[0].value, '');
  assert.equal(visible.controls[1].value, 'ordinary visible text');
  assert.equal(JSON.stringify(visible).includes(fixtureSecret), false);
});

test('all documented key examples use the same action structure', () => {
  for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Space', 'Tab', 'ControlOrMeta+A', 'ControlOrMeta+Z']) {
    const value = decision([action({ type: 'key', key })]);
    assert.equal(validateDecision(value, observation), value);
  }
});

test('pre-cancelled requests stop before invoking any model or reading a screenshot', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(decide({ signal: controller.signal }), { name: 'AbortError', code: 'MODEL_ABORTED' });
});

test('nonfatal CLI notifications and todo updates are not classified as tool actions', () => {
  for (const type of ['item.started', 'item.updated', 'item.completed']) {
    for (const itemType of ['error', 'todo_list', 'agent_message', 'reasoning', 'plan']) {
      assert.equal(isDisallowedToolEvent({ type, item: { id: 'item_1', type: itemType } }), false, `${type}/${itemType}`);
    }
  }
});

test('the observed warning-before-turn sequence can reach its final response', () => {
  const events = [
    { type: 'thread.started', thread_id: 'example' },
    { type: 'item.completed', item: { id: 'item_1', type: 'error', message: 'Configuration warning' } },
    { type: 'item.completed', item: { id: 'item_2', type: 'error', message: 'Deprecation notice' } },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: '{}' } },
    { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } },
  ];
  assert.equal(events.some(isDisallowedToolEvent), false);
  // A stream-level error remains distinct; the request handler still routes it
  // to MODEL_FAILED, rather than misreporting it as a tool attempt.
  assert.equal(isDisallowedToolEvent({ type: 'error', message: 'Request failed' }), false);
});

test('actual tools, unknown item types and malformed item events remain blocked', () => {
  for (const type of ['item.started', 'item.updated', 'item.completed']) {
    for (const itemType of ['command_execution', 'mcp_tool_call', 'file_change', 'web_search', 'collab_tool_call', 'unknown_future_item']) {
      assert.equal(isDisallowedToolEvent({ type, item: { id: 'item_1', type: itemType } }), true, `${type}/${itemType}`);
    }
    for (const item of [undefined, null, {}, [], { type: null }]) {
      assert.equal(isDisallowedToolEvent({ type, item }), true);
    }
  }
});
