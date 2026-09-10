import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readModelConfig, publicModelInfo, codexEnvironment } from '../lib/config.mjs';

const api = { MODEL_PROVIDER: 'openai', OPENAI_API_KEY: 'test-placeholder-not-a-real-key' };
test('config-only fallback parses key presence; runtime login priority is resolved separately', () => {
  assert.equal(readModelConfig({}).provider, 'codex');
  assert.equal(readModelConfig({ OPENAI_API_KEY: ' ' }).provider, 'codex');
  assert.equal(readModelConfig({ OPENAI_API_KEY: api.OPENAI_API_KEY }).provider, 'openai');
  assert.deepEqual(readModelConfig({ ...api, MODEL_PROVIDER: 'codex', CODEX_MODEL: 'example-model' }), { provider: 'codex', model: 'example-model' });
  assert.throws(() => readModelConfig({ MODEL_PROVIDER: 'other' }), { code: 'MODEL_CONFIG' });
  assert.throws(() => readModelConfig({ MODEL_PROVIDER: 'openai' }), { code: 'MODEL_CONFIG' });
});

test('API defaults and configured protocol/model are preserved', () => {
  const defaults = readModelConfig(api);
  assert.equal(defaults.baseUrl, 'https://api.openai.com/v1');
  assert.equal(defaults.model, 'gpt-4.1');
  assert.equal(defaults.apiStyle, 'responses');
  assert.equal(defaults.responseFormat, 'json_schema');
  assert.equal(defaults.timeoutMs, 150000);
  const custom = readModelConfig({ ...api, OPENAI_BASE_URL: 'https://example.com/proxy/v1/', OPENAI_MODEL: 'vision-model', OPENAI_API_STYLE: 'chat_completions', OPENAI_RESPONSE_FORMAT: 'json_object', OPENAI_TIMEOUT_MS: '2000' });
  assert.equal(custom.baseUrl, 'https://example.com/proxy/v1');
  assert.equal(custom.model, 'vision-model');
  assert.equal(custom.apiStyle, 'chat_completions');
  assert.equal(custom.responseFormat, 'json_object');
  assert.equal(custom.timeoutMs, 2000);
});

test('API root URLs reject credentials, cleartext remote URLs and ambiguous endpoint paths', () => {
  for (const url of ['bad-url', 'file:///tmp/key', 'http://example.com/v1', 'https://user:pass@example.com/v1', 'https://example.com/v1?key=secret', 'https://example.com/v1#fragment', 'https://example.com/v1/responses', 'https://example.com/v1/chat/completions/']) {
    assert.throws(() => readModelConfig({ ...api, OPENAI_BASE_URL: url }), { code: 'MODEL_CONFIG' });
  }
  for (const url of ['http://127.0.0.1:1234/v1', 'http://localhost:1234/v1', 'http://[::1]:1234/v1']) {
    assert.equal(readModelConfig({ ...api, OPENAI_BASE_URL: url }).baseUrl, url);
  }
});

test('configuration errors are bounded and never echo supplied values', () => {
  for (const [name, val] of [['OPENAI_API_KEY', 'private secret'], ['OPENAI_API_KEY', 'secret\nheader'], ['OPENAI_TIMEOUT_MS', 'NaN'], ['OPENAI_TIMEOUT_MS', '999'], ['OPENAI_TIMEOUT_MS', '300001'], ['OPENAI_API_STYLE', 'secret-style'], ['OPENAI_RESPONSE_FORMAT', 'secret-format'], ['OPENAI_MODEL', 'secret\nmodel']]) {
    assert.throws(() => readModelConfig({ ...api, [name]: val }), error => error.code === 'MODEL_CONFIG' && !error.message.includes(val));
  }
});

test('public model status does not contain key, endpoint or arbitrary model names', () => {
  const config = readModelConfig({ ...api, OPENAI_BASE_URL: 'https://private.example/v1', OPENAI_MODEL: 'private-model' });
  const json = JSON.stringify(publicModelInfo(config));
  for (const value of [config.apiKey, config.baseUrl, config.model]) assert.ok(!json.includes(value));
  assert.deepEqual(Object.keys(publicModelInfo(config)), ['provider', 'billingLabel']);
});

test('Codex subprocess does not inherit API-mode key or endpoint overrides', () => {
  const env = { ...api, OPENAI_BASE_URL: 'https://private.example/v1', OPENAI_MODEL: 'private-model', CODEX_API_KEY: 'test-cli-api-override', DEMO_CONTROL_TOKEN: 'test-desktop-token', PATH: 'preserved-path', CODEX_HOME: 'preserved-home' };
  const result = codexEnvironment(env);
  assert.equal(result.OPENAI_API_KEY, undefined);
  assert.equal(result.OPENAI_BASE_URL, undefined);
  assert.equal(result.OPENAI_MODEL, undefined);
  assert.equal(result.CODEX_API_KEY, undefined);
  assert.equal(result.DEMO_CONTROL_TOKEN, undefined);
  assert.equal(result.PATH, env.PATH);
  assert.equal(result.CODEX_HOME, env.CODEX_HOME);
  assert.equal(env.OPENAI_API_KEY, api.OPENAI_API_KEY);
});

test('dotenv resolves from its project and preserves shell environment precedence', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-env-test-'));
  try {
    await mkdir(path.join(root, 'lib'));
    await writeFile(path.join(root, 'lib', 'env.mjs'), await readFile(new URL('../lib/env.mjs', import.meta.url)));
    await writeFile(path.join(root, '.env'), 'DEMO_TEST_PRECEDENCE=from-file\nDEMO_TEST_ONLY_FILE="from file"\n');
    const code = `import ${JSON.stringify(pathToFileURL(path.join(root, 'lib', 'env.mjs')).href)}; process.stdout.write(JSON.stringify([process.env.DEMO_TEST_PRECEDENCE,process.env.DEMO_TEST_ONLY_FILE]));`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: tmpdir(), env: { ...process.env, DEMO_TEST_PRECEDENCE: 'from-shell' }, encoding: 'utf8', windowsHide: true });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), ['from-shell', 'from file']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('setup generates private local configuration once and never overwrites it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-setup-test-'));
  try {
    await mkdir(path.join(root, 'scripts'));
    const script = path.join(root, 'scripts', 'setup.mjs');
    await writeFile(script, await readFile(new URL('../scripts/setup.mjs', import.meta.url)));
    await writeFile(path.join(root, '.env.example'), 'MODEL_PROVIDER=auto\nOPENAI_API_KEY=\n');
    const run = () => spawnSync(process.execPath, [script], { cwd: tmpdir(), encoding: 'utf8', windowsHide: true });
    assert.equal(run().status, 0);
    const token = await readFile(path.join(root, 'dockercompose.env'), 'utf8');
    assert.match(token, /^DEMO_CONTROL_TOKEN=[a-f0-9]{64}\n$/);
    await writeFile(path.join(root, '.env'), 'MODEL_PROVIDER=codex\n# preserve me\n');
    assert.equal(run().status, 0);
    assert.equal(await readFile(path.join(root, '.env'), 'utf8'), 'MODEL_PROVIDER=codex\n# preserve me\n');
    assert.equal(await readFile(path.join(root, 'dockercompose.env'), 'utf8'), token);
  } finally { await rm(root, { recursive: true, force: true }); }
});
