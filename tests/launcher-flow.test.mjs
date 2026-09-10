import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { projectIdentity } from '../lib/launcher.mjs';

// Real child processes exercise only reuse/refusal/help paths. All files are
// isolated fixtures; the user's .env, Docker, npm, browser and model are unused.
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FAKE_KEY = 'sk-test-launcher-flow-fixture-only-not-a-real-key';
const HOSTILE_TEXT = 'UNTRUSTED_RESPONSE_MUST_NEVER_APPEAR_IN_LAUNCHER_OUTPUT';
const TEST_OPTIONS = { timeout: 15_000 };

function childEnvironment() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(PATH|PORT|NODE_OPTIONS|NODE_PATH|OPENAI_.*|CODEX_.*|DEMO_CONTROL_TOKEN|npm_.*)$/i.test(name)) delete env[name];
  }
  env.PATH = '';
  return env;
}

async function fingerprint(root, current = root) {
  const files = [];
  const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    assert.equal(entry.isSymbolicLink(), false, 'Fixture must not contain symbolic links');
    if (entry.isDirectory()) files.push({ directory: relative }, ...await fingerprint(root, absolute));
    else files.push({ file: relative, sha256: createHash('sha256').update(await readFile(absolute)).digest('hex') });
  }
  return files;
}

async function createFixture(t, port) {
  const tempBase = await realpath(tmpdir());
  const temporary = await mkdtemp(path.join(tempBase, 'browser-agent-launcher-flow-'));
  const allocated = await realpath(temporary);
  const root = path.join(allocated, '中文 demo & fixture');
  t.after(async () => {
    // Resolve and validate the exact allocated temporary directory immediately
    // before recursive removal. Never delete the workspace or a broad temp root.
    assert.equal((await lstat(temporary)).isSymbolicLink(), false);
    const target = await realpath(temporary);
    const relative = path.relative(tempBase, target);
    assert.equal(target, allocated);
    assert.ok(relative && !path.isAbsolute(relative) && !relative.startsWith('..'));
    assert.equal(path.dirname(relative), '.');
    assert.ok(path.basename(target).startsWith('browser-agent-launcher-flow-'));
    await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await mkdir(path.join(root, 'lib'));
  await copyFile(path.join(ROOT, 'scripts', 'start.mjs'), path.join(root, 'scripts', 'start.mjs'));
  await copyFile(path.join(ROOT, 'lib', 'launcher.mjs'), path.join(root, 'lib', 'launcher.mjs'));
  const envText = port === undefined ? undefined : `PORT=${port}\nOPENAI_API_KEY=${FAKE_KEY}\n`;
  if (envText !== undefined) await writeFile(path.join(root, '.env'), envText);
  return { root, envText, original: await fingerprint(root) };
}

async function assertUnchanged(fixture) {
  assert.deepEqual(await fingerprint(fixture.root), fixture.original, 'Launcher must not create or modify fixture files');
  const names = await readdir(fixture.root);
  for (const unexpected of ['dockercompose.env', 'runs', 'node_modules', 'package-lock.json']) {
    assert.equal(names.includes(unexpected), false, `${unexpected} must not be created on an early-return path`);
  }
  if (fixture.envText !== undefined) assert.equal(await readFile(path.join(fixture.root, '.env'), 'utf8'), fixture.envText);
  else assert.equal(names.includes('.env'), false, '--help must not create .env');
}

async function launch(fixture, args = ['--no-open']) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(fixture.root, 'scripts', 'start.mjs'), ...args], {
      cwd: fixture.root, shell: false, windowsHide: true, env: childEnvironment(), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 8_000);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) { reject(new Error('Isolated launcher child exceeded the 8-second deadline')); return; }
      resolve({ code, signal, stdout, stderr, output: stdout + stderr });
    });
  });
}

async function listen(t, server) {
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return server.address().port;
}

async function httpService(t, response) {
  const requests = [];
  const server = http.createServer((request, result) => {
    requests.push({ method: request.method, url: request.url, headers: request.headers });
    const reply = response();
    result.writeHead(reply.status || 200, { 'content-type': reply.contentType || 'application/json' });
    result.end(reply.body);
  });
  return { server, requests, port: await listen(t, server) };
}

function assertHealthOnly(service) {
  assert.ok(service.server.listening, 'An existing service must remain running');
  assert.equal(service.requests.length, 1, 'The launcher must only make its single early health probe');
  const request = service.requests[0];
  assert.equal(request.method, 'GET');
  assert.equal(request.url, '/api/health');
  for (const header of ['authorization', 'proxy-authorization', 'cookie', 'x-api-key']) {
    assert.equal(Object.hasOwn(request.headers, header), false, `Health probe must not send ${header}`);
  }
  assert.equal(JSON.stringify(request).includes(FAKE_KEY), false);
}

function assertNoLeak(result) {
  assert.equal(result.output.includes(FAKE_KEY), false, 'The fixture key must never appear in child output');
  assert.equal(result.output.includes(HOSTILE_TEXT), false, 'Untrusted HTTP response contents must not be printed');
}

test('launcher reuses the same project before dependencies/setup/Docker in a path containing spaces, Chinese and &', TEST_OPTIONS, async t => {
  let fixture;
  const service = await httpService(t, () => ({ body: JSON.stringify({ app: 'browser-agent-demo', projectId: projectIdentity(fixture.root) }) }));
  fixture = await createFixture(t, service.port);
  assert.match(fixture.root, /中文 demo & fixture/);
  const result = await launch(fixture);
  assert.equal(result.code, 0, result.output);
  assert.equal(result.signal, null);
  assert.match(result.stdout, /控制台已运行，直接复用/);
  assertHealthOnly(service);
  assertNoLeak(result);
  await assertUnchanged(fixture);
});

for (const scenario of [
  { name: 'a different project identity', reply: () => ({ body: JSON.stringify({ app: 'browser-agent-demo', projectId: 'different-project', message: HOSTILE_TEXT, key: FAKE_KEY }) }) },
  { name: 'hostile HTML masquerading as a health response', reply: () => ({ contentType: 'text/html', body: `<html><script>${HOSTILE_TEXT}</script><p>${FAKE_KEY}</p></html>` }) },
  { name: 'an HTTP 404 from an unrelated service', reply: () => ({ status: 404, body: JSON.stringify({ error: HOSTILE_TEXT, key: FAKE_KEY }) }) },
]) {
  test(`launcher refuses ${scenario.name} without writes or response/key disclosure`, TEST_OPTIONS, async t => {
    const service = await httpService(t, scenario.reply);
    const fixture = await createFixture(t, service.port);
    const result = await launch(fixture);
    assert.equal(result.code, 1, result.output);
    assert.match(result.stderr, /端口已被其他项目、旧版控制台或未知服务占用/);
    assertHealthOnly(service);
    assertNoLeak(result);
    await assertUnchanged(fixture);
  });
}

test('launcher refuses an occupied plain TCP port after its bounded HTTP probe without stopping the owner', TEST_OPTIONS, async t => {
  let connections = 0;
  const chunks = [];
  const server = net.createServer(socket => {
    connections++;
    socket.on('data', chunk => chunks.push(chunk.toString()));
    // Keep the foreign TCP service open but never send an HTTP response.
  });
  const port = await listen(t, server);
  const fixture = await createFixture(t, port);
  const result = await launch(fixture);
  assert.equal(result.code, 1, result.output);
  assert.match(result.stderr, /端口已被其他项目、旧版控制台或未知服务占用/);
  assert.ok(server.listening, 'The plain TCP owner must still be listening');
  assert.equal(connections, 1);
  assert.match(chunks.join(''), /^GET \/api\/health HTTP\/1\.1\r\n/);
  assert.equal(chunks.join('').includes(FAKE_KEY), false);
  assertNoLeak(result);
  await assertUnchanged(fixture);
});

test('launcher --help exits successfully without .env, dependencies, Docker or browser access', TEST_OPTIONS, async t => {
  const fixture = await createFixture(t);
  const result = await launch(fixture, ['--help']);
  assert.equal(result.code, 0, result.output);
  assert.match(result.stdout, /npm run launch/);
  assert.match(result.stdout, /--no-open/);
  assert.equal(result.stderr, '');
  assertNoLeak(result);
  await assertUnchanged(fixture);
});
