import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertNodeVersion, parsePort, projectIdentity, classifyConsole,
  desktopStatus, acquireStartupLock, probeConsole, safeChildEnvironment,
} from '../lib/launcher.mjs';

// This suite uses pure helpers and loopback-only HTTP/TCP sockets. It never
// reads .env, starts a child process, or contacts Docker, a browser or a model.
const uniqueRoot = () => path.join(tmpdir(), `browser-agent-launcher-test-${randomUUID()}`);
const identityPayload = (projectId) => ({ app: 'browser-agent-demo', projectId });

test('child environments remove model and control credentials case-insensitively without mutating the source', () => {
  const source = Object.freeze({
    OPENAI_API_KEY: 'fake-api-key-for-test',
    openai_base_url: 'https://fake-provider.invalid/v1',
    OpEnAi_MoDeL: 'fake-model',
    CODEX_API_KEY: 'fake-codex-key-for-test',
    codex_api_key: 'fake-lowercase-codex-key',
    DEMO_CONTROL_TOKEN: 'fake-control-token-for-test',
    demo_control_token: 'fake-lowercase-control-token',
    PATH: 'fake-executable-path',
    SystemRoot: 'fake-system-root',
    PORT: '4317',
  });
  const cleaned = safeChildEnvironment(source);
  assert.deepEqual(cleaned, { PATH: 'fake-executable-path', SystemRoot: 'fake-system-root', PORT: '4317' });
  assert.notEqual(cleaned, source);
  assert.equal(source.OPENAI_API_KEY, 'fake-api-key-for-test');
  assert.equal(source.DEMO_CONTROL_TOKEN, 'fake-control-token-for-test');
  assert.deepEqual(safeChildEnvironment({}), {});
});

async function localServer(t, handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    handler(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, requests };
}

test('Node 22 and newer are supported and older or malformed versions fail', () => {
  for (const [version, major] of [['22.0.0', 22], ['22.12.0', 22], ['24.19.0', 24], ['v24.19.0', 24]]) {
    assert.equal(assertNodeVersion(version), major);
  }
  for (const version of ['21.9.0', '20.20.0', 'v18.0.0', '', 'not-node', '22oops', '-22.0.0']) {
    assert.throws(() => assertNodeVersion(version), undefined, `Unexpected version acceptance: ${version}`);
  }
});

test('port parsing defaults to 4317 and accepts only an integer port in range', () => {
  assert.equal(parsePort(), 4317);
  for (const [input, expected] of [['1', 1], ['4317', 4317], ['65535', 65535]]) {
    assert.equal(parsePort(input), expected);
  }
  for (const input of ['0', '65536', '-1', '4317.5', '4e3', '4_317', '4317/api', 'NaN', 'Infinity', 'true']) {
    assert.throws(() => parsePort(input), undefined, `Unexpected port acceptance: ${input}`);
  }
});

test('project identity is stable, differs across roots and does not expose the path', () => {
  const root = uniqueRoot();
  const id = projectIdentity(root);
  assert.equal(typeof id, 'string');
  assert.ok(id.length > 0);
  assert.equal(projectIdentity(root), id);
  assert.notEqual(projectIdentity(`${root}-another-project`), id);
  assert.equal(id.includes(root), false);
  assert.equal(id.includes(path.basename(root)), false);
  assert.equal(/[\\/]/.test(id), false);
});

test('only an exact application and project identity is classified as the same console', () => {
  const expected = projectIdentity(uniqueRoot());
  assert.equal(classifyConsole(identityPayload(expected), expected), 'same');
  assert.equal(classifyConsole(identityPayload('another-project'), expected), 'other');
  for (const payload of [null, undefined, '', [], {}, { app: 'browser-agent-demo' }, { projectId: expected }]) {
    assert.equal(classifyConsole(payload, expected), 'unknown');
  }
  for (const payload of [{ app: 'unrelated-service', projectId: expected }, { app: 'browser-agent-demo', projectId: 123 }]) {
    assert.notEqual(classifyConsole(payload, expected), 'same');
  }
});

test('Compose array output reports desktop health without using unrelated services', () => {
  const output = JSON.stringify([
    { Service: 'database', State: 'exited', Health: 'unhealthy' },
    { Service: 'desktop', State: 'running', Health: 'healthy' },
  ]);
  assert.deepEqual(desktopStatus(output), { ready: true, failed: false });
  assert.deepEqual(desktopStatus(JSON.stringify([{ Service: 'unrelated', State: 'running', Health: 'healthy' }])), { ready: false, failed: false });
  assert.deepEqual(desktopStatus('[]'), { ready: false, failed: false });
  assert.deepEqual(desktopStatus(''), { ready: false, failed: false });
});

test('Compose JSONL output recognizes starting, unhealthy and exited desktop states', () => {
  const line = (entry) => `${JSON.stringify(entry)}\n`;
  const unrelated = line({ Service: 'another-service', State: 'running', Health: 'healthy' });
  for (const desktop of [
    { Service: 'desktop', State: 'running', Health: 'starting' },
    { Service: 'desktop', State: 'created', Health: '' },
  ]) {
    assert.deepEqual(desktopStatus(unrelated + line(desktop)), { ready: false, failed: false });
  }
  for (const desktop of [
    { Service: 'desktop', State: 'exited', Health: '' },
    { Service: 'desktop', State: 'running', Health: 'unhealthy' },
  ]) {
    assert.deepEqual(desktopStatus(unrelated + line(desktop)), { ready: false, failed: true });
  }
  assert.deepEqual(desktopStatus(unrelated + line({ Service: 'desktop', State: 'running', Health: 'healthy' })), { ready: true, failed: false });
});

test('a second launcher cannot take the same TCP startup lock, and release permits a new owner', async (t) => {
  const root = uniqueRoot();
  const first = await acquireStartupLock(root, 4317);
  t.after(() => first.release());
  assert.equal(first.acquired, true);
  assert.equal(typeof first.release, 'function');

  const second = await acquireStartupLock(root, 4317);
  t.after(() => second.release());
  assert.equal(second.acquired, false);
  await second.release();

  const stillBlocked = await acquireStartupLock(root, 4317);
  t.after(() => stillBlocked.release());
  assert.equal(stillBlocked.acquired, false, 'A failed contender must not release the active owner');

  await first.release();
  const next = await acquireStartupLock(root, 4317);
  t.after(() => next.release());
  assert.equal(next.acquired, true);
});

test('console probe uses the public health endpoint with no credential headers', async (t) => {
  const expected = projectIdentity(uniqueRoot());
  const server = await localServer(t, (_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(identityPayload(expected))));
  const result = await probeConsole(server.origin, expected);
  assert.equal(result.kind, 'same');
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].method, 'GET');
  assert.equal(server.requests[0].url, '/api/health');
  for (const header of ['authorization', 'proxy-authorization', 'cookie', 'x-api-key']) {
    assert.equal(Object.hasOwn(server.requests[0].headers, header), false);
  }
});

test('a different project is not reused and hostile HTTP contents cannot impersonate this project', async (t) => {
  const expected = projectIdentity(uniqueRoot());
  const cases = [
    { status: 200, body: JSON.stringify(identityPayload('another-project')), expectedKind: 'other' },
    { status: 200, body: '<html><script>window.app="browser-agent-demo"</script></html>' },
    { status: 200, body: JSON.stringify({ app: 'foreign-app', projectId: expected }) },
    { status: 200, body: JSON.stringify([identityPayload(expected)]) },
    { status: 200, body: '{malformed JSON' },
    { status: 503, body: JSON.stringify(identityPayload(expected)) },
  ];
  let index = 0;
  const server = await localServer(t, (_req, res) => {
    const item = cases[index++];
    res.writeHead(item.status, { 'content-type': 'application/json' }).end(item.body);
  });
  for (const item of cases) {
    const result = await probeConsole(server.origin, expected);
    if (item.expectedKind) assert.equal(result.kind, item.expectedKind);
    else assert.notEqual(result.kind, 'same');
  }
});

test('a closed loopback port is reported as unreachable without starting another process', async () => {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  await new Promise(resolve => server.close(resolve));
  const result = await probeConsole(origin, projectIdentity(uniqueRoot()));
  assert.equal(result.kind, 'unreachable');
});
