import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const ACTION = { type: 'type', target: 'snapshot-1:input', x: null, y: null, toX: null, toY: null, text: '新的完整值', key: null, deltaY: null };
const TREE = {
  status: 'ready', source: 'at-spi', message: '控件已就绪', truncated: false, text: '表单标签',
  controls: [{ id: 'snapshot-1:input', role: 'text', name: '姓名', value: '旧值', x: 10, y: 20, width: 200, height: 30, enabled: true, actions: ['type'] }],
};

async function exercise(t, handler, scenario) {
  // Import a copied adapter so its optional .env lookup can never read the real
  // project's credentials. No model module, CLI or Docker process is involved.
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-browser-fixture-'));
  const lib = path.join(directory, 'lib');
  await mkdir(lib);
  for (const file of ['browser.mjs', 'env.mjs', 'accessibility.mjs', 'desktop.mjs']) {
    await cp(fileURLToPath(new URL(`../lib/${file}`, import.meta.url)), path.join(lib, file));
  }
  const requests = [];
  const respond = (res, status, value) => {
    res.writeHead(status, { 'content-type': Buffer.isBuffer(value) ? 'image/png' : 'application/json' });
    res.end(Buffer.isBuffer(value) ? value : JSON.stringify(value));
  };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    requests.push({ url: req.url, method: req.method, body, token: req.headers.authorization });
    if (req.url === '/health') return handler(req, res, { body, respond });
    if (req.headers.authorization !== 'Bearer fixture-only-control-token') return respond(res, 401, { error: 'unauthorized' });
    if (req.url === '/session' && !handler.handlesSession) return respond(res, 200, { ok: true });
    if (req.url === '/downloads' && !handler.handlesDownloads) return respond(res, 200, { files: [] });
    handler(req, res, { body, respond });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('agent-browser-fixture-'));
    await rm(directory, { recursive: true, force: true });
  });
  const environment = {};
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'Path', 'TEMP', 'TMP', 'TMPDIR']) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  const script = `import assert from 'node:assert/strict';
    import { readFile, readdir } from 'node:fs/promises';
    import { BrowserSession, checkDesktop } from ${JSON.stringify(pathToFileURL(path.join(lib, 'browser.mjs')).href)};
    const notices = [];
    const downloads = [];
    const session = new BrowserSession({ runDir: ${JSON.stringify(path.join(directory, 'run'))}, onNotice: value => notices.push(value), onDownload: value => downloads.push(value) });
    const action = ${JSON.stringify(ACTION)};
    const png = Buffer.from(${JSON.stringify(PNG.toString('base64'))}, 'base64');
    ${scenario}
    process.stdout.write('fixture passed');`;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...environment, DEMO_CONTROL_URL: `http://127.0.0.1:${server.address().port}`, DEMO_CONTROL_TOKEN: 'fixture-only-control-token' },
      cwd: directory, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Browser fixture timed out')); }, 10_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'fixture passed');
  return requests;
}

test('combined observation saves its PNG, exposes semantic controls and sends typed targets', async t => {
  const requests = await exercise(t, (req, res, { respond }) => {
    if (req.url === '/observation') return respond(res, 200, { screenshot: PNG.toString('base64'), accessibility: TREE });
    respond(res, req.url === '/action' ? 200 : 404, { ok: true });
  }, `
    await session.start('https://example.invalid/');
    const seen = await session.observe();
    assert.equal(seen.observation.accessibility.status, 'ready');
    assert.equal(seen.observation.controls[0].name, '姓名');
    assert.deepEqual(seen.observation.controls[0].actions, ['type']);
    assert.equal(seen.observation.controls[0].enabled, true);
    assert.match(seen.observation.text, /表单标签/);
    assert.deepEqual(await readFile(seen.screenshotPath), png);
    assert.equal(notices.length, 0);
    await session.act(action);
    await assert.rejects(session.act(action), /过期/);
    assert.equal(session.latestObservation, null);
  `);
  assert.deepEqual(requests.map(request => request.url), ['/session', '/downloads', '/observation', '/action']);
  assert.deepEqual(requests.at(-1).body, ACTION);
});

test('older 404 observation endpoints fall back to screenshot with an explicit rebuild notice', async t => {
  const requests = await exercise(t, (req, res, { respond }) => {
    if (req.url === '/screenshot') return respond(res, 200, PNG);
    respond(res, 404, { error: 'missing endpoint' });
  }, `
    const seen = await session.observe();
    assert.equal(seen.observation.accessibility.status, 'unavailable');
    assert.deepEqual(seen.observation.controls, []);
    assert.deepEqual(await readFile(seen.screenshotPath), png);
    assert.match(notices[0], /npm run desktop/);
    await assert.rejects(session.act(action), /过期/);
    await session.observe();
    assert.equal(notices.length, 1, 'do not repeat the same fallback notice each round');
  `);
  assert.equal(requests.filter(request => request.url === '/screenshot').length, 2);
  assert.equal(requests.filter(request => request.url === '/action').length, 0);
});

for (const status of [401, 403, 500]) {
  test(`observation HTTP ${status} remains a visible error and never silently falls back`, async t => {
    const requests = await exercise(t, (_req, res, { respond }) => respond(res, status, { error: 'fixture failure' }), `
      await assert.rejects(session.observe(), error => error.status === ${status});
      assert.equal(session.latestObservation, null);
      assert.equal(notices.length, 0);
    `);
    assert.deepEqual(requests.map(request => request.url), ['/downloads', '/observation']);
  });
}

test('unavailable accessibility still permits coordinate actions but exposes no stale targets', async t => {
  const requests = await exercise(t, (req, res, { respond }) => {
    if (req.url === '/observation') return respond(res, 200, { screenshot: PNG.toString('base64'), accessibility: { ...TREE, status: 'unavailable', message: '应用未暴露控件' } });
    respond(res, 200, { ok: true });
  }, `
    const seen = await session.observe();
    assert.equal(seen.observation.accessibility.status, 'unavailable');
    assert.deepEqual(seen.observation.controls, []);
    assert.equal(notices[0], '应用未暴露控件');
    await assert.rejects(session.act(action), /过期/);
    await session.act({ ...action, type: 'click', target: null, text: null, x: 100, y: 200 });
  `);
  assert.equal(requests.filter(request => request.url === '/action').length, 1);
});

test('failed actions invalidate target snapshots instead of retrying an uncertain operation', async t => {
  const requests = await exercise(t, (req, res, { respond }) => {
    if (req.url === '/observation') return respond(res, 200, { screenshot: PNG.toString('base64'), accessibility: TREE });
    respond(res, 409, { error: '控件已失效，请重新观察' });
  }, `
    await session.observe();
    await assert.rejects(session.act(action), /失效/);
    await assert.rejects(session.act(action), /过期/);
  `);
  assert.equal(requests.filter(request => request.url === '/action').length, 1);
});

test('a new observation replaces all IDs from the previous snapshot', async t => {
  let frame = 0;
  const requests = await exercise(t, (req, res, { respond }) => {
    if (req.url === '/observation') {
      frame++;
      return respond(res, 200, { screenshot: PNG.toString('base64'), accessibility: {
        ...TREE, controls: [{ ...TREE.controls[0], id: `snapshot-${frame}:input` }],
      } });
    }
    respond(res, 200, { ok: true });
  }, `
    await session.observe();
    const second = await session.observe();
    assert.equal(second.observation.controls[0].id, 'snapshot-2:input');
    await assert.rejects(session.act(action), /过期/);
    await session.act({ ...action, target: 'snapshot-2:input' });
  `);
  assert.equal(requests.filter(request => request.url === '/action').length, 1);
  assert.equal(requests.at(-1).body.target, 'snapshot-2:input');
});

test('malformed observation images fail instead of accepting controls or silently falling back', async t => {
  const requests = await exercise(t, (_req, res, { respond }) => {
    respond(res, 200, { screenshot: 'bm90IGEgcG5n', accessibility: TREE });
  }, `
    await assert.rejects(session.observe(), /PNG/);
    assert.equal(session.latestObservation, null);
    assert.equal(notices.length, 0);
  `);
  assert.equal(requests.some(request => request.url === '/screenshot'), false);
});

test('pre-cancelled operations send no container request', async t => {
  const requests = await exercise(t, () => {}, `
    const controller = new AbortController();
    controller.abort(new Error('already cancelled'));
    await assert.rejects(session.observe(controller.signal), /already cancelled/);
    await assert.rejects(session.act(action, controller.signal), /already cancelled/);
  `);
  assert.deepEqual(requests, []);
});

test('cancelled observations never fall back or leave reusable targets', async t => {
  const requests = await exercise(t, () => { /* Hold the observation until the client cancels. */ }, `
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('fixture cancelled')), 150);
    await assert.rejects(session.observe(controller.signal), /fixture cancelled/);
    clearTimeout(timer);
    assert.equal(session.latestObservation, null);
    await assert.rejects(session.act(action), /过期/);
  `);
  assert.equal(requests.some(request => request.url === '/screenshot' || request.url === '/action'), false);
});

test('desktop sessions send an explicit mode and invalidate app/window snapshots after actions', async t => {
  let frame = 0;
  const requests = await exercise(t, (req, res, { respond }) => {
    if (req.url === '/observation') return respond(res, 200, { screenshot: PNG.toString('base64'), accessibility: TREE, desktop: {
      mode: 'desktop', apps: [{ id: 'editor', name: '文本编辑器' }],
      windows: [{ id: `win-frame${++frame}-0`, appId: 'editor', title: '测试文件', active: true }], workspace: '/workspace/tasks/fixture-task',
    } });
    respond(res, 200, { ok: true });
  }, `
    await session.start({ mode: 'desktop' });
    const first = await session.observe();
    assert.equal(first.observation.url, null);
    assert.equal(first.observation.desktop.mode, 'desktop');
    assert.equal(first.observation.desktop.workspace, '/workspace/tasks/fixture-task');
    const launch = { ...action, type: 'launch_app', target: 'editor', text: null };
    await session.act(launch);
    await assert.rejects(session.act(launch), /过期/);
    await session.observe();
    await assert.rejects(session.act({ ...launch, type: 'focus_window', target: 'win-frame1-0' }), /过期/);
    await session.act({ ...launch, type: 'focus_window', target: 'win-frame2-0' });
  `);
  assert.deepEqual(requests[0].body, { mode: 'desktop' });
  assert.equal(requests.filter(request => request.url === '/action').length, 2);
});

test('desktop mode fails clearly against older images without switching into browser mode', async t => {
  const handler = (req, res, { respond }) => respond(res, 400, { error: 'A URL is required' });
  handler.handlesSession = true;
  const requests = await exercise(t, handler, `
    await assert.rejects(session.start({ mode: 'desktop' }), /npm run desktop/);
    await assert.rejects(session.start({ mode: 'desktop', command: 'sh' }), /启动参数/);
  `);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body, { mode: 'desktop' });
});

test('same-size saved-file revisions replace one bounded host snapshot and record', async t => {
  let listing = 0;
  const handler = (req, res, { respond }) => {
    if (req.url === '/downloads') return respond(res, 200, { files: [{ name: 'notes/任务.txt', size: 3, revision: ++listing < 3 ? '111' : '222' }] });
    if (req.url.startsWith('/downloads/')) return respond(res, 200, Buffer.from(req.url.endsWith('revision=111') ? 'old' : 'new'));
    if (req.url === '/observation') return respond(res, 200, { screenshot: PNG.toString('base64'), accessibility: TREE });
    respond(res, 404, {});
  };
  handler.handlesDownloads = true;
  const requests = await exercise(t, handler, `
    const first = await session.observe();
    const original = session.downloads[0];
    assert.equal(first.observation.downloads[0].revision, '111');
    await session.observe();
    const third = await session.observe();
    assert.equal(session.downloads.length, 1);
    assert.equal(downloads.length, 2);
    assert.equal(session.downloads[0].file, original.file);
    assert.equal(session.downloads[0].url, original.url);
    assert.equal(third.observation.downloads[0].revision, '222');
    assert.deepEqual(await readdir(session.runDir + '/downloads'), [original.file]);
    assert.equal(await readFile(session.runDir + '/downloads/' + original.file, 'utf8'), 'new');
  `);
  assert.equal(requests.filter(request => request.url.startsWith('/downloads/')).length, 2);
  assert.equal(requests.some(request => request.url === '/downloads/notes%2F%E4%BB%BB%E5%8A%A1.txt?revision=222'), true);
});

test('files replaced during a save are retried on the next observation', async t => {
  let reads = 0;
  const handler = (req, res, { respond }) => {
    if (req.url === '/downloads') return respond(res, 200, { files: [{ name: 'result.txt', size: 3, revision: '333' }] });
    if (req.url.startsWith('/downloads/')) return ++reads === 1 ? respond(res, 409, { error: 'File changed' }) : respond(res, 200, Buffer.from('new'));
    respond(res, 200, { screenshot: PNG.toString('base64'), accessibility: TREE });
  };
  handler.handlesDownloads = true;
  await exercise(t, handler, `
    await session.observe();
    assert.equal(session.downloads.length, 0);
    await session.observe();
    assert.equal(session.downloads.length, 1);
    assert.equal(downloads.length, 1);
    assert.equal(session.downloads[0].revision, '333');
  `);
});

test('malformed output names fail before fetching any file', async t => {
  const handler = (req, res, { respond }) => respond(res, 200, { files: [{ name: '../outside.txt', size: 1, revision: '1' }] });
  handler.handlesDownloads = true;
  const requests = await exercise(t, handler, `
    await assert.rejects(session.observe(), /列表无效/);
    assert.equal(session.downloads.length, 0);
  `);
  assert.deepEqual(requests.map(request => request.url), ['/downloads']);
});

test('oversized file responses are bounded even if the listing claimed a small file', async t => {
  const handler = (req, res, { respond }) => {
    if (req.url === '/downloads') return respond(res, 200, { files: [{ name: 'result.txt', size: 1, revision: '1' }] });
    res.writeHead(200, { 'content-length': 21 * 1024 * 1024 });
    res.write('x');
  };
  handler.handlesDownloads = true;
  await exercise(t, handler, `
    await assert.rejects(session.observe(), /超过允许大小/);
    assert.equal(session.downloads.length, 0);
    assert.equal(session.knownDownloads.size, 0);
  `);
});

test('desktop health exposes only the backend advertised desktop capability', async t => {
  let reads = 0;
  await exercise(t, (_req, res, { respond }) => respond(res, 200, ++reads === 1
    ? { ready: true, capabilities: { desktopSessions: true } }
    : { ready: true }), `
    const modern = await checkDesktop();
    assert.equal(modern.ready, true);
    assert.equal(modern.desktopSessions, true);
    const legacy = await checkDesktop();
    assert.equal(legacy.ready, true);
    assert.equal(legacy.desktopSessions, false);
  `);
});
