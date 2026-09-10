import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Frontend-only integration: serve the real public files on a private random
// port. All status, event and desktop-image responses are synthetic. Never load
// .env, connect to Docker/model services, or submit a real task.
const root = fileURLToPath(new URL('../', import.meta.url));
const runDir = path.join(root, 'runs', `qa-desktop-ui-${Date.now()}`);
const defaultGoal = '打开文本编辑器，输入「你好，Linux 桌面！这是一次跨应用操作测试。」，保存为本次工作目录中的「桌面测试.txt」，最后切回文件管理器确认文件存在。';
const untrustedTitle = '<img src=x onerror="globalThis.__desktopUiInjected=1">';
const workspace = '/workspace/tasks/qa-desktop-ui-0123456789abcdef';
const results = { ok: false, checks: [], screenshots: [], layouts: [] };
const clients = new Set();
const requests = [];
let origin;
let snapshot;
let image;
let browser;

const fixtureHtml = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#dbe4e9}svg{width:100%;height:100%;display:block;font-family:"Segoe UI","Microsoft YaHei",sans-serif}</style><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 720"><rect width="1000" height="720" fill="#dbe4e9"/><rect width="1000" height="48" fill="#253d4c"/><text x="24" y="30" font-size="18" fill="white">Synthetic Linux desktop · UI test fixture</text><rect x="100" y="105" width="800" height="500" rx="8" fill="white" stroke="#9eafb9"/><path d="M100 155H900" stroke="#d6e0e6"/><text x="124" y="138" font-size="22" fill="#203443">文本编辑器 — 桌面测试.txt</text><text x="140" y="250" font-size="32" font-weight="600" fill="#203443">你好，Linux 桌面！</text><text x="140" y="325" font-size="23" fill="#203443">这是前端验证使用的合成画面。</text><text x="140" y="365" font-size="23" fill="#203443">没有连接 Docker，也没有调用模型。</text><rect x="140" y="425" width="720" height="75" rx="6" fill="#f4f8fa" stroke="#d6e3e9"/><text x="160" y="470" font-size="22" fill="#203443">桌面测试.txt · 已保存到本次工作目录</text><text x="24" y="684" font-size="18" fill="#4a626f">Fixture only · 1000 × 720</text></svg>`;

function state(run = null) {
  return {
    model: { ready: true, checking: false, label: 'UI 测试模型（合成状态）', provider: 'codex', verified: false, selection: 'codex', authMethod: 'chatgpt', billingLabel: '前端验证使用合成状态，不会请求模型。' },
    environment: { ready: true, desktopSessions: true, label: 'UI 测试桌面（合成画面）', desktopUrl: `${origin}/fixture/desktop?view_only=true` },
    run,
  };
}

function desktopRun() {
  const desktop = {
    mode: 'desktop', workspace,
    apps: [{ id: 'files', name: '文件管理器' }, { id: 'editor', name: '文本编辑器' }, { id: 'browser', name: '浏览器' }],
    windows: [{ id: 'win-qa-files', appId: 'files', title: 'qa-desktop-ui — 文件管理器', active: false }, { id: 'win-qa-editor', appId: 'editor', title: untrustedTitle, active: true }],
  };
  const accessibility = { status: 'ready', source: 'at-spi', message: '合成的可见控件，用于验证前端呈现。', truncated: false };
  const controls = [{ id: 'ax-qa-editor', role: 'text', name: '编辑内容', value: '你好，Linux 桌面！', actions: ['type'], x: 100, y: 100, width: 600, height: 300, enabled: true }];
  const observation = { title: '桌面观察（合成）', width: 1000, height: 720, desktop, accessibility, controls, downloads: [], text: '前端合成观察' };
  const time = '2026-09-10T03:00:00.000Z';
  const action = (type, target) => ({ type, target, x: null, y: null, toX: null, toY: null, text: null, key: null, deltaY: null });
  return {
    id: 'qa-desktop-ui', scenario: 'desktop', goal: defaultGoal, targetUrl: null, startedAt: time, endedAt: null,
    status: 'running', phase: 'observing', step: 4, stepLimit: 16, desktop, accessibility, controls,
    screenshotUrl: '/fixture/screenshot.png?current=1', lastAction: action('focus_window', 'win-qa-editor'), downloads: [],
    events: [
      { seq: 1, type: 'observation', step: 1, time, screenshotUrl: '/fixture/screenshot.png?history=1', observation },
      { seq: 2, type: 'action', step: 1, time, ok: true, action: action('launch_app', 'editor') },
      { seq: 3, type: 'action', step: 2, time, ok: true, action: action('focus_window', 'win-qa-editor') },
      { seq: 4, type: 'action', step: 3, time, ok: true, action: action('close_window', 'win-qa-browser') },
    ],
  };
}

function publish(run, environment = {}) {
  snapshot = state(run);
  Object.assign(snapshot.environment, environment);
  for (const client of clients) client.write(`data: ${JSON.stringify({ type: 'snapshot', data: snapshot })}\n\n`);
}

function passed(message) {
  results.checks.push(message);
  console.log(`✓ ${message}`);
}

const staticFiles = new Map(await Promise.all([
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
  ['/style.css', 'style.css', 'text/css; charset=utf-8'],
].map(async ([url, file, type]) => [url, { body: await readFile(path.join(root, 'public', file)), type }])));

const server = createServer((request, response) => {
  const url = new URL(request.url, origin || 'http://127.0.0.1');
  requests.push({ method: request.method, path: url.pathname });
  response.setHeader('cache-control', 'no-store');
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end('Fixture is read-only'); return; }
  if (url.pathname === '/api/events') {
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
    clients.add(response);
    response.write(`data: ${JSON.stringify({ type: 'snapshot', data: snapshot })}\n\n`);
    request.on('close', () => clients.delete(response));
    return;
  }
  if (url.pathname === '/api/status') {
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(snapshot)); return;
  }
  if (url.pathname === '/fixture/desktop') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(fixtureHtml); return;
  }
  if (url.pathname === '/fixture/screenshot.png' && image) {
    response.writeHead(200, { 'content-type': 'image/png' }); response.end(image); return;
  }
  const file = staticFiles.get(url.pathname);
  if (file) { response.writeHead(200, { 'content-type': file.type }); response.end(file.body); return; }
  if (url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
  response.writeHead(404); response.end('Unknown fixture path');
});

async function screenshot(page, name) {
  const file = path.join(runDir, name);
  await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
  results.screenshots.push(file);
}

async function layout(page, width, phase) {
  const info = await page.evaluate(() => ({
    viewportWidth: innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    panels: [...document.querySelectorAll('.workspace > .panel')].map(element => {
      const { x, right, width, height } = element.getBoundingClientRect();
      return { x, right, width, height };
    }),
  }));
  results.layouts.push({ width, phase, ...info });
  assert.ok(info.documentWidth <= width + 2, `${width}px ${phase} 页面横向溢出：${info.documentWidth}px`);
  for (const panel of info.panels) assert.ok(panel.x >= -2 && panel.right <= width + 2 && panel.width > 150, `${width}px ${phase} 面板超出可视宽度`);
}

async function checkViewport(width, height) {
  publish(null);
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const blocked = [];
  const errors = [];
  const failedRequests = [];
  await context.route('**/*', async route => {
    const request = route.request();
    if (!['GET', 'HEAD'].includes(request.method()) || new URL(request.url()).origin !== origin) {
      blocked.push(`${request.method()} ${request.url()}`);
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', entry => { if (entry.type() === 'error') errors.push(entry.text()); });
  page.on('requestfailed', request => failedRequests.push(`${request.method()} ${request.url()}`));
  try {
    const response = await page.goto(origin, { waitUntil: 'domcontentloaded' });
    assert.equal(response.status(), 200);
    await page.locator('#environment-status.ready').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('#start').disabled);
    assert.equal(await page.locator('input[name=scenario]:checked').inputValue(), 'desktop');
    assert.equal(await page.locator('#goal').inputValue(), defaultGoal);
    assert.equal(await page.locator('#rounds').inputValue(), '16');
    assert.equal(await page.locator('#desktop-hint').isVisible(), true);
    assert.equal(await page.locator('#custom-url-field').isVisible(), false);
    assert.equal(await page.locator('#variation').isVisible(), false);
    assert.equal(await page.locator('#view-desktop').getAttribute('aria-selected'), 'true');
    assert.equal(new URL(await page.locator('#preview').getAttribute('src')).searchParams.get('view_only'), 'true');
    await layout(page, width, 'default');
    await screenshot(page, `${width}-default.png`);
    passed(`${width}px 默认桌面场景、中文目标、16 轮与只读视图正确`);

    for (const scenario of ['paint', 'maze', 'custom', 'desktop']) {
      await page.locator(`label.scenario-choice:has(input[value="${scenario}"])`).click();
      assert.equal(await page.locator('input[name=scenario]:checked').inputValue(), scenario);
      assert.equal(await page.locator('#variation').isVisible(), ['paint', 'maze'].includes(scenario));
      assert.equal(await page.locator('#custom-url-field').isVisible(), scenario === 'custom');
      assert.equal(await page.locator('#desktop-hint').isVisible(), scenario === 'desktop');
      assert.equal(await page.locator('#rounds').inputValue(), scenario === 'desktop' ? '16' : '10');
      assert.ok((await page.locator('#goal').inputValue()).length > 5);
    }
    passed(`${width}px 桌面、画板、迷宫、自定义网页的输入区显隐与轮数切换正确`);

    publish(null, { desktopSessions: false });
    await page.locator('#desktop-upgrade').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#start').isDisabled(), true, '旧镜像应禁用桌面任务启动');
    await layout(page, width, 'upgrade');
    await screenshot(page, `${width}-upgrade.png`);
    await page.locator('label.scenario-choice:has(input[value="paint"])').click();
    assert.equal(await page.locator('#desktop-upgrade').isVisible(), false);
    assert.equal(await page.locator('#start').isDisabled(), false, '旧镜像应仍可启动画板任务');
    publish(null);
    await page.locator('label.scenario-choice:has(input[value="desktop"])').click();
    await page.waitForFunction(() => !document.querySelector('#start').disabled);
    assert.equal(await page.locator('#desktop-upgrade').isVisible(), false);
    passed(`${width}px 旧镜像提示升级并禁止桌面任务，画板模式仍可用`);

    publish(desktopRun());
    await page.locator('#desktop-panel').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelectorAll('#desktop-windows li').length === 2);
    assert.equal(await page.locator('#window-count').textContent(), '2 个窗口');
    assert.equal(await page.locator('#workspace-path').textContent(), workspace);
    assert.match(await page.locator('#desktop-apps').textContent(), /文件管理器.*文本编辑器.*浏览器/);
    assert.equal(await page.locator('#desktop-windows li.active').count(), 1);
    assert.equal(await page.locator('#desktop-windows li.active').textContent(), `当前 · 文本编辑器 — ${untrustedTitle}`);
    assert.equal(await page.locator('#desktop-windows img').count(), 0);
    assert.equal(await page.evaluate(() => globalThis.__desktopUiInjected), undefined);
    assert.equal(await page.locator('#start').isVisible(), false);
    assert.equal(await page.locator('#stop').isVisible(), true);
    assert.equal(await page.locator('#refresh-model').isDisabled(), true);
    const inputs = page.locator('.setup input,.setup textarea,.setup select,#shuffle');
    for (let index = 0; index < await inputs.count(); index++) assert.equal(await inputs.nth(index).isDisabled(), true, '任务执行时必须禁用设置输入');
    const actions = await page.locator('#events .event-card.action p').allTextContents();
    assert.equal(actions.length, 3);
    assert.match(actions[0], /启动应用 文本编辑器/);
    assert.match(actions[1], /切换到窗口 win-qa-editor/);
    assert.match(actions[2], /请求关闭窗口 win-qa-browser/);
    assert.ok(actions.every(text => !/\(0,\s*0\)/.test(text)), '按编号执行的桌面动作不得显示坐标 (0, 0)');
    await layout(page, width, 'running');
    await screenshot(page, `${width}-running.png`);
    passed(`${width}px 应用、窗口、工作目录与当前窗口正确呈现；HTML 标题作为文本；忙碌状态锁定设置`);

    const detail = page.locator('#events .event-card.observation details');
    await detail.locator('summary').click();
    const observed = JSON.parse(await detail.locator('pre').textContent());
    assert.deepEqual(observed.desktop, desktopRun().desktop);
    await page.locator('#events .event-card.observation .observation-link').click();
    assert.equal(await page.locator('#view-label').textContent(), '历史观察截图');
    assert.equal(await page.locator('#view-screenshot').getAttribute('aria-selected'), 'true');
    await page.waitForFunction(() => { const img = document.querySelector('#live-screen'); return img.complete && img.naturalWidth === 1000; });
    assert.equal(await page.locator('#live-screen').getAttribute('src'), '/fixture/screenshot.png?history=1');
    assert.equal(await page.locator('#cursor-marker').isVisible(), false);
    await layout(page, width, 'history');
    await screenshot(page, `${width}-history.png`);
    await page.locator('#back-live').click();
    assert.equal(await page.locator('#live-screen').getAttribute('src'), '/fixture/screenshot.png?current=1');
    assert.equal(await page.locator('#cursor-marker').isVisible(), false, '窗口编号动作不应出现坐标光标');
    passed(`${width}px 启动/切换/关闭动作标签、历史桌面观察、截图切换与无坐标光标均正确`);

    const finished = { ...desktopRun(), status: 'completed', endedAt: '2026-09-10T03:01:00.000Z', result: '前端合成任务已结束。' };
    publish(finished);
    await page.locator('#result').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('#goal').disabled);
    assert.equal(await page.locator('#start').isVisible(), true);
    assert.equal(await page.locator('#stop').isVisible(), false);
    assert.deepEqual(blocked, [], '页面尝试请求测试服务之外的地址或发送写入请求');
    assert.deepEqual(errors, [], '页面出现 JavaScript 或控制台错误');
    assert.deepEqual(failedRequests, [], '前端资源请求失败');
    passed(`${width}px 页面无横向溢出、错误或外部请求；完成后恢复输入`);
  } catch (error) {
    await screenshot(page, `${width}-failure.png`).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
}

try {
  await mkdir(runDir, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  snapshot = state();
  browser = await chromium.launch({ channel: process.env.DEMO_SMOKE_BROWSER_CHANNEL || 'msedge', headless: true });
  const imagePage = await browser.newPage({ viewport: { width: 1000, height: 720 }, deviceScaleFactor: 1 });
  await imagePage.goto(`${origin}/fixture/desktop`, { waitUntil: 'load' });
  image = await imagePage.screenshot({ animations: 'disabled' });
  await imagePage.close();
  console.log('前端桌面验证：真实前端文件 + 合成服务状态；不连接 Docker、不启动任务、不请求模型。');
  await checkViewport(1440, 1080);
  await checkViewport(390, 844);
  assert.ok(requests.every(request => ['GET', 'HEAD'].includes(request.method)));
  results.ok = true;
  console.log(`前端验证通过。截图与报告：${runDir}`);
} catch (error) {
  results.error = error.message;
  console.error(`前端验证失败：${error.message}`);
  console.error(`截图与报告：${runDir}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  for (const client of clients) client.end();
  await new Promise(resolve => server.close(resolve));
  server.closeAllConnections();
  await writeFile(path.join(runDir, 'smoke-desktop-ui.json'), JSON.stringify({ ...results, requests }, null, 2));
}
