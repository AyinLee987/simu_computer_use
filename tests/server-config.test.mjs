import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { projectIdentity } from '../lib/launcher.mjs';

test('API-only server reports configuration without credentials or a paid request; private files are not served', async () => {
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const secret = 'test-secret-must-never-be-in-public-status';
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], {
    env: { ...process.env, PORT: String(port), MODEL_PROVIDER: 'openai', OPENAI_API_KEY: secret, OPENAI_BASE_URL: 'http://127.0.0.1:9/v1', OPENAI_MODEL: 'mock-model', CODEX_EXECUTABLE: 'no-codex-required-for-api-mode' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const closed = once(child, 'close');
  const timeout = setTimeout(() => child.kill(), 10000);
  try {
    let response;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (child.exitCode !== null) break;
      try { response = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(500) }); if (response.ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(response?.status, 200, 'the API-mode server should start without Codex');
    const snapshot = await response.json();
    assert.equal(snapshot.model.provider, 'openai');
    assert.equal(snapshot.model.ready, true);
    assert.equal(snapshot.model.verified, false);
    assert.equal(snapshot.run, null);
    assert.ok(!JSON.stringify(snapshot).includes(secret));
    assert.ok(!JSON.stringify(snapshot).includes('127.0.0.1:9'));
    const healthResponse = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.deepEqual(health, { app: 'browser-agent-demo', projectId: projectIdentity(fileURLToPath(new URL('../', import.meta.url))) });
    assert.ok(!JSON.stringify(health).includes(secret));
    const refreshed = await fetch(`http://127.0.0.1:${port}/api/model/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(refreshed.status, 200);
    const refreshedBody = await refreshed.json();
    assert.equal(refreshedBody.model.provider, 'openai');
    assert.equal(refreshedBody.model.selection, 'openai');
    assert.equal(refreshedBody.model.authMethod, null);
    assert.equal(refreshedBody.model.verified, false);
    assert.ok(!JSON.stringify(refreshedBody).includes(secret));
    const forbiddenRefresh = await fetch(`http://127.0.0.1:${port}/api/model/refresh`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://untrusted.example' }, body: '{}' });
    assert.equal(forbiddenRefresh.status, 403);
    for (const route of ['/.env', '/.env.example', '/dockercompose.env', '/lib/config.mjs', '/.git/config']) {
      const denied = await fetch(`http://127.0.0.1:${port}${route}`);
      assert.equal(denied.status, 404, route);
      assert.ok(!(await denied.text()).includes(secret));
    }
    assert.ok(!output.includes(secret));
  } finally {
    child.kill();
    await closed;
    clearTimeout(timeout);
  }
});
