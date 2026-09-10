import test from 'node:test';
import assert from 'node:assert/strict';
import { targetFor, validateAction, VIEWPORT } from '../lib/browser.mjs';

// These tests exercise an initial-URL guard. They do not claim that the
// browser is a network sandbox, resolve DNS, or inspect subsequent navigation.
// Importing and calling these pure helpers sends no model/container requests.
const action = (fields = {}) => ({
  type: 'wait', target: null, x: null, y: null, toX: null, toY: null,
  text: null, key: null, deltaY: null, ...fields,
});
const custom = (url) => targetFor({ scenario: 'custom', url });

test('ordinary custom HTTP(S) URLs preserve paths, queries and fragments', () => {
  for (const url of ['https://example.com/', 'http://example.com:8080/editor?mode=free#canvas', 'https://example.com/a%20b?next=%2Fworkspace']) {
    assert.equal(custom(url), new URL(url).href);
  }
});

test('custom URL validation rejects malformed input, unsafe protocols and URL credentials', () => {
  for (const url of ['', 'not a URL', '/relative', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hello', 'ftp://example.com/file', 'https://user@example.com/', 'https://user:password@example.com/', 'https://:password@example.com/']) {
    assert.throws(() => custom(url), undefined, `Expected initial URL rejection: ${url}`);
  }
  assert.throws(() => targetFor({ scenario: 'unknown', url: 'https://example.com/' }));
});

test('the initial URL guard rejects explicit loopback hosts and known local aliases', () => {
  for (const url of [
    'http://localhost:8000/', 'http://LOCALHOST:8000/', 'http://app.localhost/',
    'http://localhost.:8000/', 'http://app.localhost.:8000/',
    'http://127.0.0.1:8000/', 'http://127.0.0.2/', 'http://127.1/',
    'http://2130706433/', 'http://0x7f000001/', 'http://[::1]:8000/',
    'http://0.0.0.0/', 'http://host.docker.internal:8000/',
  ]) {
    assert.throws(() => custom(url), undefined, `Expected explicit local host rejection: ${url}`);
  }
});

test('the initial URL guard does not require network access or promise DNS/navigation isolation', () => {
  const unresolved = 'https://not-resolved-during-validation.invalid/path?next=http%3A%2F%2Flocalhost%3A8000%2F';
  assert.equal(custom(unresolved), unresolved);
});

test('paint and maze target the container labs and encode the entire seed value', () => {
  const seed = '中文 /&?=7#';
  for (const scenario of ['paint', 'maze']) {
    assert.equal(targetFor({ scenario, seed }), `http://127.0.0.1:8000/labs/${scenario}.html?seed=${encodeURIComponent(seed)}`);
  }
  assert.equal(targetFor({ scenario: 'paint', seed: 0 }), 'http://127.0.0.1:8000/labs/paint.html?seed=0');
});

test('only supported action types and screenshot coordinates are accepted', () => {
  for (const value of [null, undefined, {}, action({ type: 'evaluate' }), action({ type: 'navigate' }), action({ type: 'launch' })]) {
    assert.throws(() => validateAction(value));
  }
  for (const target of ['e123abc', '']) assert.throws(() => validateAction(action({ target })));
  assert.equal(VIEWPORT.width, 1000);
  assert.equal(VIEWPORT.height, 720);
  for (const [x, y] of [[0, 0], [999, 719], [999.5, 719.5]]) {
    const value = action({ type: 'click', x, y });
    assert.equal(validateAction(value), value);
  }
  for (const [x, y] of [[-1, 0], [0, -1], [1000, 0], [0, 720], [NaN, 0], [0, Infinity], [null, 0], ['0', 0], [true, 0]]) {
    assert.throws(() => validateAction(action({ type: 'click', x, y })), undefined, `Unexpected coordinate acceptance: ${x}, ${y}`);
  }
});

test('drag requires both starting and ending desktop coordinates', () => {
  const value = action({ type: 'drag', x: 0, y: 0, toX: 999, toY: 719 });
  assert.equal(validateAction(value), value);
  for (const field of ['x', 'y', 'toX', 'toY']) {
    assert.throws(() => validateAction({ ...value, [field]: null }));
    assert.throws(() => validateAction({ ...value, [field]: -1 }));
  }
  assert.throws(() => validateAction({ ...value, toX: 1000 }));
  assert.throws(() => validateAction({ ...value, toY: 720 }));
  assert.throws(() => validateAction({ ...value, target: 'e123abc' }));
});

test('typing accepts at most 2000 characters and scrolling stays within ±1500 pixels', () => {
  for (const text of ['', 'hello 中文', '字'.repeat(2000)]) {
    const value = action({ type: 'type', text });
    assert.equal(validateAction(value), value);
  }
  for (const text of [null, 123, '字'.repeat(2001)]) assert.throws(() => validateAction(action({ type: 'type', text })));
  for (const deltaY of [-1500, 0, 1500]) {
    const value = action({ type: 'scroll', deltaY });
    assert.equal(validateAction(value), value);
  }
  for (const deltaY of [-1501, 1501, NaN, Infinity, null, '100']) assert.throws(() => validateAction(action({ type: 'scroll', deltaY })));
});

test('documented navigation, typing and undo keys are supported without arbitrary shortcuts', () => {
  for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Space', 'Tab', 'Escape', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'a', 'Z', '7', 'ControlOrMeta+A', 'ControlOrMeta+a', 'ControlOrMeta+Z', 'ControlOrMeta+z', 'Control+A', 'Control+z', 'Meta+A', 'Meta+z', 'Shift+Tab']) {
    const value = action({ type: 'key', key });
    assert.equal(validateAction(value), value);
  }
  for (const key of [null, '', 123, 'F12', 'Alt+F2', 'Control+Shift+I', 'Enter; echo test']) {
    assert.throws(() => validateAction(action({ type: 'key', key })), undefined, `Unexpected key acceptance: ${key}`);
  }
  const wait = action({ type: 'wait' });
  assert.equal(validateAction(wait), wait);
});

test('semantic actions require a current enabled control with the exact capability', () => {
  const observation = { accessibility: { status: 'ready' }, controls: [
    { id: 'snapshot-1:button', enabled: true, actions: ['click'] },
    { id: 'snapshot-1:field', enabled: true, actions: ['type'] },
    { id: 'snapshot-1:disabled', enabled: false, actions: ['click'] },
    { id: 'snapshot-1:unknown', enabled: true },
  ] };
  for (const value of [action({ type: 'click', target: 'snapshot-1:button' }), action({ type: 'type', target: 'snapshot-1:field', text: '替换全文' })]) {
    assert.equal(validateAction(value, observation), value);
    assert.throws(() => validateAction(value));
    assert.throws(() => validateAction(value, { ...observation, accessibility: { status: 'unavailable' } }));
  }
  for (const value of [
    action({ type: 'click', target: 'snapshot-0:button' }),
    action({ type: 'click', target: 'snapshot-1:field' }),
    action({ type: 'type', target: 'snapshot-1:button', text: 'unsupported' }),
    action({ type: 'click', target: 'snapshot-1:disabled' }),
    action({ type: 'click', target: 'snapshot-1:unknown' }),
    action({ type: 'key', target: 'snapshot-1:button', key: 'Enter' }),
    action({ type: 'click', target: 'snapshot-1:button', x: 10, y: 20 }),
    action({ type: 'click', target: 'snapshot-1:button', text: 'unrelated' }),
  ]) assert.throws(() => validateAction(value, observation));
});
