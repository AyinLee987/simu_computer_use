import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// A read-only integration check. This script never starts a task, requests a
// model decision, changes the container session or sends desktop input.
const BASE = process.env.DEMO_SMOKE_BASE_URL || 'http://127.0.0.1:4317';
const CONTROL = process.env.DEMO_CONTROL_URL || 'http://127.0.0.1:8000';
const NOVNC = process.env.DEMO_DESKTOP_URL || 'http://127.0.0.1:6080/vnc.html?autoconnect=true&resize=scale&view_only=true';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCREENSHOT = path.join(ROOT, 'runs', 'qa-dashboard.png');
const TIMEOUT = 30_000;
let snapshot;

function report(label) { console.log(`✓ ${label}`); }
function message(error) { return error instanceof Error ? error.message : String(error); }
async function get(url) {
  try { return await fetch(url, { method: 'GET', signal: AbortSignal.timeout(8_000) }); }
  catch (error) { throw new Error(`无法读取 ${url}：${message(error)}。请确认 demo 服务和 Docker 容器已启动。`); }
}

async function checkHttp() {
  const checks = [
    ['控制台 /api/status 返回模型与环境状态', async () => {
      const response = await get(new URL('/api/status', BASE));
      assert.equal(response.status, 200, '控制台状态接口应返回 200');
      snapshot = await response.json();
      assert.equal(typeof snapshot.model?.ready, 'boolean', '缺少 model.ready');
      assert.equal(typeof snapshot.model?.label, 'string', '缺少 model.label');
      assert.equal(typeof snapshot.environment?.ready, 'boolean', '缺少 environment.ready');
      assert.equal(typeof snapshot.environment?.label, 'string', '缺少 environment.label');
      assert.equal(typeof snapshot.environment?.desktopUrl, 'string', '缺少 environment.desktopUrl');
      assert.equal(snapshot.environment.ready, true, 'Docker 桌面尚未就绪；请先运行 npm run desktop');
    }],
    ['容器 /health 返回已就绪', async () => {
      const response = await get(new URL('/health', CONTROL));
      assert.equal(response.status, 200, '容器健康接口应返回 200');
      const health = await response.json();
      assert.equal(health.ready, true, '容器中的桌面尚未就绪');
    }],
    ['不带凭据读取容器截图被拒绝（401）', async () => {
      const response = await get(new URL('/screenshot', CONTROL));
      assert.equal(response.status, 401, '未授权的 /screenshot 请求必须返回 401');
      await response.arrayBuffer();
    }],
    ['noVNC 页面可读取（200）', async () => {
      const response = await get(NOVNC);
      assert.equal(response.status, 200, 'noVNC 页面应返回 200');
      assert.match(await response.text(), /noVNC/i, '响应内容不是预期的 noVNC 页面');
    }],
  ];
  const results = await Promise.allSettled(checks.map(([, run]) => run()));
  let failed = false;
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') report(checks[i][0]);
    else { failed = true; console.error(`× ${checks[i][0]}：${message(results[i].reason)}`); }
  }
  if (failed) throw new Error('HTTP 健康检查未通过，尚未进行浏览器检查。');
  console.log(`  模型来源配置状态：${snapshot.model.ready ? '已就绪' : '尚未就绪'}；此检查不调用模型。`);
}

async function checkDashboard() {
  let browser;
  let page;
  let failure;
  const pageErrors = [];
  const blockedRequests = [];
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, deviceScaleFactor: 1 });
    // Do not permit an accidental task/session/action POST during this check.
    await context.route('**/*', async route => {
      const request = route.request();
      if (!['GET', 'HEAD'].includes(request.method())) {
        blockedRequests.push(`${request.method()} ${request.url()}`);
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
    page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);
    page.on('pageerror', error => pageErrors.push(message(error)));
    const response = await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    assert.equal(response?.status(), 200, '控制台首页应返回 200');
    await page.getByRole('heading', { name: '给它一个目标，看它如何操作。', exact: true }).waitFor({ state: 'visible' });
    await page.locator('#environment-status.ready').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#view-desktop').getAttribute('aria-selected'), 'true', '默认应显示容器实时桌面');
    await page.locator('#iframe-holder').waitFor({ state: 'visible' });
    await page.locator('#loading').waitFor({ state: 'hidden' });
    const desktopSource = await page.locator('#preview').getAttribute('src');
    const desktopUrl = new URL(desktopSource, BASE);
    assert.equal(desktopUrl.searchParams.get('view_only'), 'true', 'noVNC 必须使用只读视图');
    assert.equal(desktopUrl.origin, new URL(snapshot.environment.desktopUrl).origin, 'iframe 应连接状态接口提供的桌面地址');
    report('控制台可见，默认显示只读容器桌面，没有加载遮罩');

    const frame = page.frameLocator('#preview');
    await frame.locator('html.noVNC_connected').waitFor({ state: 'attached', timeout: TIMEOUT });
    const canvas = frame.locator('canvas').first();
    await canvas.waitFor({ state: 'visible', timeout: TIMEOUT });
    const canvasSize = await canvas.evaluate(element => ({ width: element.width, height: element.height }));
    assert.ok(canvasSize.width > 0 && canvasSize.height > 0, 'noVNC 画布必须包含有效尺寸');
    report(`noVNC 已连接，实时画布可见（${canvasSize.width} × ${canvasSize.height}）`);

    const layout = await page.evaluate(() => {
      const box = element => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom }; };
      return {
        viewportWidth: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        panels: [...document.querySelectorAll('.workspace > .panel')].map(box),
        viewport: box(document.querySelector('#viewport')),
        iframe: box(document.querySelector('#preview')),
      };
    });
    assert.ok(layout.documentWidth <= layout.viewportWidth + 2, '控制台出现整页横向溢出');
    assert.equal(layout.panels.length, 3, '应显示任务设置、浏览器视图和记录三个面板');
    for (const panel of layout.panels) {
      assert.ok(panel.width > 150 && panel.height > 150, '控制台存在不可见或过小的主面板');
      assert.ok(panel.x >= -2 && panel.right <= layout.viewportWidth + 2, '主面板越过浏览器可视宽度');
    }
    assert.ok(layout.iframe.width > 250 && layout.iframe.height > 180, '容器桌面的可视区域过小');
    assert.ok(Math.abs(layout.iframe.width - layout.viewport.width) <= 2, 'noVNC iframe 宽度未适配视图');
    assert.ok(Math.abs(layout.iframe.height - layout.viewport.height) <= 2, 'noVNC iframe 高度未适配视图');
    report('1440 × 1080 控制台没有横向溢出，noVNC 填满容器视图');

    assert.deepEqual(pageErrors, [], '控制台或 noVNC 出现未处理的页面错误');
    assert.deepEqual(blockedRequests, [], '页面尝试了非只读 HTTP 请求，检查已将其拦截');
    report('控制台和 noVNC 没有 pageerror，也没有发出任务或桌面操作请求');
  } catch (error) { failure = error; }
  finally {
    if (page && !page.isClosed() && page.url() !== 'about:blank') {
      try {
        await mkdir(path.dirname(SCREENSHOT), { recursive: true });
        await page.screenshot({ path: SCREENSHOT, fullPage: true, timeout: 15_000 });
        report(`控制台截图已保存：${SCREENSHOT}`);
      } catch (error) { failure ||= new Error(`无法保存控制台截图：${message(error)}`); }
    }
    if (browser) await browser.close();
  }
  if (failure) throw failure;
}

try {
  console.log('只读集成检查：不会调用模型、开始任务或操作容器桌面。');
  await checkHttp();
  await checkDashboard();
  console.log('检查通过。范围为服务健康、截图鉴权、noVNC 连接和控制台布局；不代表 AI 任务端到端验证。');
} catch (error) {
  console.error(`检查失败：${message(error)}`);
  process.exitCode = 1;
}
