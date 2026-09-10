import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// All executable, home, screenshot and configuration paths belong to a temporary
// fixture. Copying the production modules also isolates their .env lookup: these
// tests never import the real project's env module or contact any model service.
const LIB_DIRECTORY = fileURLToPath(new URL('../lib/', import.meta.url));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const VALID = { summary: '已观察到完成结果。', actions: [], done: true, success: true };
const FAKE_SECRETS = {
  OPENAI_API_KEY: 'test-only-openai-key',
  CODEX_API_KEY: 'test-only-codex-key',
  DEMO_CONTROL_TOKEN: 'test-only-desktop-token',
};

const FAKE_CLI = `const fs = require('node:fs');
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.FAKE_CODEX_STATE, 'utf8'));
const login = args.includes('login') && args.includes('status');
const stage = login ? 'login' : args.includes('exec') ? 'exec' : 'unknown';
const privateNames = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'DEMO_CONTROL_TOKEN'];
fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({
  stage,
  ignoredUserConfig: args.includes('--ignore-user-config'),
  inheritedSecrets: Object.fromEntries(privateNames.map(name => [name, Object.hasOwn(process.env, name)])),
  codexHome: process.env.CODEX_HOME,
}) + '\\n');
if (login) {
  if (!state.login) { process.stderr.write('Not logged in\\n'); process.exitCode = 1; }
  else process.stderr.write(state.login === 'api_key' ? 'Logged in using an API key\\n' : 'Logged in using ChatGPT\\n');
} else if (stage === 'exec') {
  process.stdin.resume();
  process.stdin.on('end', () => {
    if (state.failExec) { process.stderr.write('Fixture request failed\\n'); process.exitCode = 1; return; }
    process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(${JSON.stringify(VALID)}) } }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');
  });
} else { process.stderr.write('Unexpected fixture command\\n'); process.exitCode = 2; }
`;

function isolatedEnvironment(fixture, overrides = {}) {
  const environment = {};
  // Do not inherit real model settings, credentials, proxy configuration, NODE_OPTIONS
  // or a real CODEX_HOME. Only basic OS process-launch variables are copied.
  for (const name of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'Path', 'TEMP', 'TMP', 'TMPDIR']) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return {
    ...environment,
    HOME: fixture.home,
    USERPROFILE: fixture.home,
    APPDATA: fixture.home,
    LOCALAPPDATA: fixture.home,
    CODEX_HOME: fixture.home,
    CODEX_EXECUTABLE: fixture.executable,
    CODEX_MODEL: '',
    MODEL_PROVIDER: 'auto',
    ...FAKE_SECRETS,
    OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
    OPENAI_MODEL: 'fixture-vision-model',
    OPENAI_API_STYLE: 'responses',
    OPENAI_RESPONSE_FORMAT: 'json_schema',
    OPENAI_TIMEOUT_MS: '1000',
    FAKE_CODEX_STATE: fixture.statePath,
    FAKE_CODEX_LOG: fixture.logPath,
    ...overrides,
  };
}

async function fixtureFor(t, state = { login: 'chatgpt', failExec: false }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-model-codex-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('agent-model-codex-'));
    await rm(directory, { recursive: true, force: true });
  });
  const home = path.join(directory, 'empty-codex-home');
  const statePath = path.join(directory, 'fake-state.json');
  const logPath = path.join(directory, 'fake-calls.jsonl');
  const screenshotPath = path.join(directory, 'screen.png');
  await mkdir(home);
  await cp(LIB_DIRECTORY, path.join(directory, 'lib'), { recursive: true });
  await writeFile(statePath, JSON.stringify(state));
  await writeFile(logPath, '');
  await writeFile(screenshotPath, PNG);
  let executable;
  if (process.platform === 'win32') {
    executable = path.join(directory, 'codex.cmd');
    const entry = path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    await mkdir(path.dirname(entry), { recursive: true });
    // The production resolver recognizes this npm-style marker, then runs the
    // known JavaScript entry directly with Node; no batch shell is executed.
    await writeFile(executable, '@rem node_modules/@openai/codex/bin/codex.js fixture\r\n');
    await writeFile(entry, FAKE_CLI);
  } else {
    executable = path.join(directory, 'codex');
    await writeFile(executable, '#!/usr/bin/env node\n' + FAKE_CLI, { mode: 0o700 });
  }
  return {
    directory, home, statePath, logPath, screenshotPath, executable,
    modelUrl: pathToFileURL(path.join(directory, 'lib', 'model.mjs')).href,
  };
}

async function exercise(fixture, scenario, overrides) {
  const request = {
    goal: '核对当前截图是否完成',
    observation: { width: 1000, height: 720, controls: [], text: 'Only the fixture screenshot is available.' },
    screenshotPath: fixture.screenshotPath,
  };
  const code = `import { writeFile } from 'node:fs/promises';
    let fetchCalls = 0;
    globalThis.fetch = async () => { fetchCalls++; throw new Error('Fixture forbids network requests'); };
    const { checkModelConnection, decide } = await import(${JSON.stringify(fixture.modelUrl)});
    const request = ${JSON.stringify(request)};
    const setState = state => writeFile(${JSON.stringify(fixture.statePath)}, JSON.stringify(state));
    const results = await (async () => { ${scenario} })();
    process.stdout.write(JSON.stringify({ ...results, fetchCalls }));`;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: isolatedEnvironment(fixture, overrides), cwd: fixture.directory,
      shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Isolated model fixture timed out')); }, 15_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
  assert.equal(result.status, 0, result.stderr);
  for (const secret of Object.values(FAKE_SECRETS)) assert.equal(result.stdout.includes(secret), false);
  const output = JSON.parse(result.stdout);
  assert.equal(output.fetchCalls, 0, 'Codex selection and execution must not fall back to an API request');
  const calls = (await readFile(fixture.logPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { output, calls };
}

test('auto prefers a ChatGPT CLI login over an API key and caches selection across decisions', async (t) => {
  const fixture = await fixtureFor(t);
  const { output, calls } = await exercise(fixture, `
    const status = await checkModelConnection();
    const first = await decide(request);
    const second = await decide(request);
    const cachedStatus = await checkModelConnection();
    return { status, first, second, cachedStatus };`);
  assert.equal(output.status.ok, true);
  assert.equal(output.status.provider, 'codex');
  assert.equal(output.status.authMethod, 'chatgpt');
  assert.equal(output.cachedStatus.provider, 'codex');
  assert.deepEqual(output.first, VALID);
  assert.deepEqual(output.second, VALID);
  assert.deepEqual(calls.map(call => call.stage), ['login', 'exec', 'exec']);
  assert.equal(calls[0].ignoredUserConfig, false, 'login status does not accept the exec-only flag');
});

test('a selected CLI execution failure never retries through the configured API key', async (t) => {
  const fixture = await fixtureFor(t);
  const { output, calls } = await exercise(fixture, `
    const status = await checkModelConnection();
    await setState({ login: 'chatgpt', failExec: true });
    const errors = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await decide(request); } catch (error) { errors.push(error.code); }
    }
    return { status, errors, cachedStatus: await checkModelConnection() };`);
  assert.equal(output.status.provider, 'codex');
  assert.deepEqual(output.errors, ['MODEL_FAILED', 'MODEL_FAILED']);
  assert.equal(output.cachedStatus.provider, 'codex');
  assert.deepEqual(calls.map(call => call.stage), ['login', 'exec', 'exec']);
});

test('explicit refresh can detect a new login without generating a model request', async (t) => {
  const fixture = await fixtureFor(t, { login: null, failExec: false });
  const { output, calls } = await exercise(fixture, `
    const before = await checkModelConnection();
    await setState({ login: 'chatgpt', failExec: false });
    const cached = await checkModelConnection();
    const after = await checkModelConnection({ refresh: true });
    return { before, cached, after };`, { OPENAI_API_KEY: '', CODEX_API_KEY: '' });
  assert.equal(output.before.ok, false);
  assert.equal(output.cached.ok, false);
  assert.equal(output.after.ok, true);
  assert.equal(output.after.provider, 'codex');
  assert.equal(output.after.authMethod, 'chatgpt');
  assert.deepEqual(calls.map(call => call.stage), ['login', 'login']);
});

test('both login probes and decisions strip API and desktop secrets but preserve the isolated CODEX_HOME', async (t) => {
  const fixture = await fixtureFor(t);
  const { output, calls } = await exercise(fixture, `
    const status = await checkModelConnection();
    const result = await decide(request);
    return { status, result };`);
  assert.equal(output.status.provider, 'codex');
  assert.deepEqual(output.result, VALID);
  assert.deepEqual(calls.map(call => call.stage), ['login', 'exec']);
  for (const call of calls) {
    assert.equal(call.codexHome, fixture.home);
    assert.deepEqual(call.inheritedSecrets, {
      OPENAI_API_KEY: false, OPENAI_BASE_URL: false, CODEX_API_KEY: false, DEMO_CONTROL_TOKEN: false,
    });
  }
});
