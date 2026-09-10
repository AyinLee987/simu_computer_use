import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCodexLogin, resolveModelSelection } from '../lib/model-selection.mjs';

// All selection inputs and login results below are synthetic. Importing the
// existing config module retains its dotenv side effect; no test uses or
// prints process.env, calls a CLI, or sends a model/network request.
const api = Object.freeze({
  OPENAI_API_KEY: 'fake-key-only-for-selection-tests',
  OPENAI_BASE_URL: 'https://private-test.invalid/v1',
  OPENAI_MODEL: 'private-test-model',
});
const loggedIn = authMethod => async () => ({ ok: true, authMethod });
const notLoggedIn = async () => ({ ok: false, reason: 'not_logged_in' });
const safeFields = ['ok', 'provider', 'verified', 'selection', 'authMethod', 'message', 'billingLabel'];

function assertSafeStatus(status, extraSecrets = []) {
  assert.deepEqual(Object.keys(status), safeFields);
  assert.equal(status.verified, false);
  assert.ok(['auto', 'codex', 'openai'].includes(status.selection));
  assert.ok(['chatgpt', 'api_key', 'unknown', null].includes(status.authMethod));
  const output = JSON.stringify(status);
  for (const secret of [...Object.values(api), ...extraSecrets]) assert.equal(output.includes(secret), false);
}

test('login classification recognizes only logged-in status sentences and drops masked key suffixes', () => {
  for (const output of ['Logged in using ChatGPT', ' Logged in using ChatGPT\r\n', '\u001b[32mLogged in using ChatGPT\u001b[0m', 'Warning: harmless notification\nLogged in using ChatGPT\n']) {
    assert.equal(classifyCodexLogin(output), 'chatgpt');
  }
  for (const output of ['Logged in using an API key - sk-test-***masked', 'Logged in using an API key', 'Logged in using API key: fake-masked-key']) {
    assert.equal(classifyCodexLogin(output), 'api_key');
  }
});

test('login classification does not infer authentication from keywords, negation or conflicting output', () => {
  for (const output of [undefined, null, {}, '', 'ChatGPT', 'API key', 'Not logged in', 'Not logged in using ChatGPT', 'Warning: Logged in using ChatGPT', 'Please log in using ChatGPT', 'Logged in using ChatGPT failed', 'Not logged in\nLogged in using ChatGPT', 'Logged in using ChatGPT\nLogged in using an API key - fake-mask']) {
    assert.equal(classifyCodexLogin(output), 'unknown');
  }
});

test('auto prioritizes a ChatGPT-authenticated Codex over an existing API configuration', async () => {
  let calls = 0;
  const result = await resolveModelSelection({ env: { ...api, MODEL_PROVIDER: 'auto', CODEX_MODEL: 'private-codex-model' }, probeCodex: async () => { calls++; return { ok: true, authMethod: 'chatgpt' }; } });
  assert.equal(calls, 1);
  assert.deepEqual(result.config, { provider: 'codex', model: 'private-codex-model' });
  assert.equal(result.status.ok, true);
  assert.equal(result.status.selection, 'auto');
  assert.equal(result.status.authMethod, 'chatgpt');
  assert.match(result.status.billingLabel, /ChatGPT.*Codex 额度/);
  assert.match(result.status.billingLabel, /不使用 \.env 中的 API Key/);
  assertSafeStatus(result.status, ['private-codex-model']);
});

test('auto uses local Codex without any API key and ignores unrelated invalid API settings', async () => {
  for (const env of [{}, { MODEL_PROVIDER: '  auto  ', OPENAI_API_KEY: 'fake key with spaces', OPENAI_BASE_URL: 'invalid endpoint', OPENAI_MODEL: 'invalid\nmodel', OPENAI_API_STYLE: 'invalid', OPENAI_RESPONSE_FORMAT: 'invalid', OPENAI_TIMEOUT_MS: '-1' }]) {
    const result = await resolveModelSelection({ env, probeCodex: loggedIn('chatgpt') });
    assert.equal(result.status.ok, true);
    assert.equal(result.config.provider, 'codex');
    assertSafeStatus(result.status);
  }
});

test('explicit API selection never probes or gets overridden by local Codex', async () => {
  const result = await resolveModelSelection({ env: { ...api, MODEL_PROVIDER: 'openai', CODEX_MODEL: 'invalid\nmodel' }, probeCodex: async () => { assert.fail('Explicit API selection must not probe Codex'); } });
  assert.equal(result.config.provider, 'openai');
  assert.equal(result.config.apiKey, api.OPENAI_API_KEY);
  assert.equal(result.status.selection, 'openai');
  assert.equal(result.status.authMethod, null);
  assertSafeStatus(result.status);
});

test('explicit Codex selection never falls back to an available API after login failure', async () => {
  const result = await resolveModelSelection({ env: { ...api, MODEL_PROVIDER: 'codex' }, probeCodex: notLoggedIn });
  assert.equal(result.config, null);
  assert.equal(result.status.ok, false);
  assert.equal(result.status.provider, 'codex');
  assert.equal(result.status.selection, 'codex');
  assert.match(result.status.message, /codex login/);
  assertSafeStatus(result.status);
});

test('CLI API-key login is selected before env API and correctly warns about API billing', async () => {
  const result = await resolveModelSelection({ env: api, probeCodex: loggedIn('api_key') });
  assert.equal(result.config.provider, 'codex');
  assert.equal(result.status.authMethod, 'api_key');
  assert.match(result.status.billingLabel, /CLI 自身的 API Key/);
  assert.match(result.status.billingLabel, /按 API 用量计费/);
  assert.match(result.status.billingLabel, /不是 ChatGPT 订阅额度/);
  assertSafeStatus(result.status);
});

test('unknown successful CLI authentication does not promise a subscription or echo an unknown method', async () => {
  for (const authMethod of ['unknown', 'private-unexpected-method', undefined]) {
    const result = await resolveModelSelection({ env: api, probeCodex: loggedIn(authMethod) });
    assert.equal(result.config.provider, 'codex');
    assert.equal(result.status.authMethod, 'unknown');
    assert.match(result.status.billingLabel, /登录方式未识别/);
    assert.doesNotMatch(result.status.billingLabel, /ChatGPT|订阅额度/);
    assertSafeStatus(result.status, ['private-unexpected-method']);
  }
});

test('auto selects a configured API only after Codex is unavailable or not confirmed logged in', async () => {
  for (const reason of ['unavailable', 'not_logged_in', 'failed']) {
    let calls = 0;
    const result = await resolveModelSelection({ env: api, probeCodex: async () => { calls++; return { ok: false, reason }; } });
    assert.equal(calls, 1);
    assert.equal(result.config.provider, 'openai');
    assert.equal(result.status.ok, true);
    assert.equal(result.status.selection, 'auto');
    assert.match(result.status.message, /未确认本机 Codex 已登录/);
    assertSafeStatus(result.status);
  }
});

test('probe exceptions and sensitive extra fields are never exposed in public selection status', async () => {
  const secret = 'fake-private-stdout-C:\\private\\auth.json-sk-test';
  const probes = [
    async () => { throw new Error(secret); },
    async () => ({ ok: false, reason: secret, stdout: secret, token: secret }),
    async () => ({ ok: true, authMethod: 'chatgpt', stdout: secret, token: secret }),
    async () => null,
  ];
  for (const probeCodex of probes) {
    const result = await resolveModelSelection({ env: api, probeCodex });
    assert.equal(result.status.ok, true);
    assertSafeStatus(result.status, [secret]);
  }
  const failed = await resolveModelSelection({ env: {}, probeCodex: probes[0] });
  assert.equal(failed.status.ok, false);
  assertSafeStatus(failed.status, [secret]);
});

test('auto without Codex login and without a key returns safe installation or login guidance', async () => {
  for (const probeCodex of [undefined, notLoggedIn, async () => ({ ok: false, reason: 'unavailable' }), async () => ({ ok: false, reason: 'failed' })]) {
    const result = await resolveModelSelection({ env: { OPENAI_API_KEY: '  ', OPENAI_BASE_URL: 'invalid-unused-url' }, probeCodex });
    assert.equal(result.config, null);
    assert.equal(result.status.ok, false);
    assert.equal(result.status.provider, 'codex');
    assert.match(result.status.message, /codex login/);
    assertSafeStatus(result.status);
  }
});

test('only provider is validated before probing, and an invalid provider never triggers a probe', async () => {
  const secret = 'private-invalid-provider';
  const result = await resolveModelSelection({ env: { ...api, MODEL_PROVIDER: secret }, probeCodex: async () => { assert.fail('Invalid provider must not probe'); } });
  assert.equal(result.config, null);
  assert.equal(result.status.ok, false);
  assert.equal(result.status.provider, null);
  assert.match(result.status.message, /MODEL_PROVIDER/);
  assertSafeStatus(result.status, [secret]);
});

test('invalid selected configurations fail safely without changing the selected provider', async () => {
  const invalidApi = await resolveModelSelection({ env: { MODEL_PROVIDER: 'openai', OPENAI_API_KEY: 'private bad key' }, probeCodex: async () => { assert.fail('Explicit API configuration failure must not probe'); } });
  assert.equal(invalidApi.config, null);
  assert.equal(invalidApi.status.provider, 'openai');
  assertSafeStatus(invalidApi.status, ['private bad key']);
  const noApiKey = await resolveModelSelection({ env: { MODEL_PROVIDER: 'openai' } });
  assert.equal(noApiKey.status.ok, false);
  const invalidCodex = await resolveModelSelection({ env: { ...api, CODEX_MODEL: 'private\ninvalid-model' }, probeCodex: loggedIn('chatgpt') });
  assert.equal(invalidCodex.config, null);
  assert.equal(invalidCodex.status.ok, false);
  assert.equal(invalidCodex.status.provider, 'codex');
  assertSafeStatus(invalidCodex.status, ['private\ninvalid-model']);
  const invalidFallback = await resolveModelSelection({ env: { ...api, OPENAI_BASE_URL: 'private-invalid-url' }, probeCodex: notLoggedIn });
  assert.equal(invalidFallback.config, null);
  assert.equal(invalidFallback.status.provider, 'openai');
  assertSafeStatus(invalidFallback.status, ['private-invalid-url']);
});

test('selection is a task-start snapshot, not a live environment or automatic runtime fallback', async () => {
  const env = { ...api };
  let calls = 0;
  const result = await resolveModelSelection({ env, probeCodex: async () => { calls++; return { ok: true, authMethod: 'chatgpt' }; } });
  env.MODEL_PROVIDER = 'openai';
  env.CODEX_MODEL = 'changed-after-selection';
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.deepEqual(result.config, { provider: 'codex', model: '' });
  assert.equal(result.status.provider, 'codex');
});
