import '../lib/env.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserSession } from '../lib/browser.mjs';

// Explicit integration test: resets the demo browser and operates only local
// fixture pages. Never requests a model, exports secrets or reads page source.
const root = fileURLToPath(new URL('../', import.meta.url));
const base = process.env.DEMO_SMOKE_BASE_URL || 'http://127.0.0.1:4317';
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 90_000);
let browser;
const makeAction = overrides => ({ type: 'wait', target: null, x: null, y: null, toX: null, toY: null, text: null, key: null, deltaY: null, ...overrides });
function find(observation, name, kind) {
  const matches = observation.controls.filter(item => item.name === name && (!kind || item.actions.includes(kind)));
  assert.equal(matches.length, 1, `应有一个可操作的「${name}」控件，实际 ${matches.length} 个`);
  return matches[0];
}
async function see() {
  let result;
  for (let attempt = 0; attempt < 5; attempt++) {
    result = await browser.observe(controller.signal);
    if (result.observation.accessibility.status === 'ready' && result.observation.controls.length) return result.observation;
    await delay(250, undefined, { signal: controller.signal });
  }
  assert.fail(`未能读取 AT-SPI 控件：${result?.observation.accessibility.message}`);
}
async function activate(observation, name) {
  await browser.act(makeAction({ type: 'click', target: find(observation, name, 'click').id }), controller.signal);
  return see();
}
async function checkIdle() {
  let response;
  try { response = await fetch(new URL('/api/status', base), { signal: AbortSignal.timeout(2000) }); }
  catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return;
    throw new Error('无法确认控制台是否空闲，请先停止任务与宿主服务后重试。');
  }
  assert.equal(response.status, 200, '控制台状态检查失败，未启动测试');
  const status = await response.json();
  assert.ok(!status.run || status.run.endedAt, '已有任务正在运行，请先停止；本测试不会打断它');
}
try {
  await checkIdle();
  const runDir = path.join(root, 'runs', `qa-accessibility-${Date.now()}`);
  await mkdir(runDir, { recursive: true });
  browser = new BrowserSession({ runDir });
  console.log('验证 AT-SPI：会重置本地 demo 浏览器，不请求模型。请勿同时启动任务。');
  await browser.start('http://127.0.0.1:8000/labs/accessibility-check.html', controller.signal);
  let seen = await see();
  assert.ok(!JSON.stringify(seen).includes('demo-password-never-export'), '密码值不得进入观察');
  assert.ok(!JSON.stringify(seen.controls).includes('隐藏按钮不得导出'), '隐藏按钮不得进入控件列表');
  const disabled = seen.controls.find(item => item.name === '禁用按钮');
  assert.ok(!disabled || !disabled.actions.length, '禁用控件不得声明动作能力');
  const oldTarget = find(seen, '保存名称', 'click').id;
  seen = await see();
  await assert.rejects(browser.act(makeAction({ type: 'click', target: oldTarget }), controller.signal));
  seen = await see();
  const backendOldTarget = find(seen, '保存名称', 'click').id;
  const otherReader = new BrowserSession({ runDir: path.join(runDir, 'other-reader') });
  await otherReader.observe(controller.signal);
  // This BrowserSession still knows the old ID; the container must reject it.
  await assert.rejects(browser.act(makeAction({ type: 'click', target: backendOldTarget }), controller.signal), /过期|不存在/);
  seen = await see();
  const field = seen.controls.find(item => item.name === '作品名称' && item.role === 'entry');
  assert.ok(field, '应能读取普通输入框');
  if (field.actions.includes('type')) {
    await browser.act(makeAction({ type: 'type', target: field.id, text: '无障碍填写成功' }), controller.signal);
    console.log('  输入路径：应用提供 EditableText，直接设置文本。');
  } else {
    // Chromium may expose editable Text without the EditableText interface.
    // Choose explicit keyboard steps; never silently retry a semantic failure.
    await browser.act(makeAction({ type: 'click', target: field.id }), controller.signal);
    await see();
    await browser.act(makeAction({ type: 'key', key: 'ControlOrMeta+A' }), controller.signal);
    await browser.act(makeAction({ type: 'type', text: '无障碍填写成功' }), controller.signal);
    console.log('  输入路径：控件聚焦后显式键盘替换，不伪称 EditableText 调用。');
  }
  seen = await see();
  assert.equal(seen.controls.find(item => item.name === '作品名称' && item.role === 'entry')?.value, '无障碍填写成功');
  seen = await activate(seen, '保存名称');
  assert.match(seen.text, /已保存：无障碍填写成功/);
  seen = await activate(seen, '开启提醒');
  assert.equal(find(seen, '开启提醒', 'click').checked, true);
  console.log('✓ 真实可见控件、控件定位填写/语义点击/勾选、密码与隐藏控件过滤、旧编号拒绝');

  await browser.start('http://127.0.0.1:8000/labs/paint.html?seed=1', controller.signal);
  seen = await see();
  seen = await activate(seen, '红色');
  assert.equal(find(seen, '红色', 'click').pressed, true);
  seen = await activate(seen, '矩形');
  const canvas = seen.controls.find(item => item.name?.startsWith('绘画画布'));
  assert.ok(canvas && canvas.width > 200 && canvas.height > 100, '应能定位可见画布范围');
  await browser.act(makeAction({ type: 'drag', x: canvas.x + canvas.width * 0.3, y: canvas.y + canvas.height * 0.3, toX: canvas.x + canvas.width * 0.7, toY: canvas.y + canvas.height * 0.7 }), controller.signal);
  seen = await see();
  assert.match(seen.text, /已画形状：1/);
  const exportButton = seen.controls.find(item => item.name?.includes('导出 PNG') && item.actions.includes('click'));
  assert.ok(exportButton, '应有导出按钮');
  await browser.act(makeAction({ type: 'click', target: exportButton.id }), controller.signal);
  for (let attempt = 0; attempt < 5 && !browser.downloads.length; attempt++) {
    await see();
    await delay(200, undefined, { signal: controller.signal });
  }
  assert.equal(browser.downloads.length, 1);
  const png = await readFile(path.join(runDir, 'downloads', browser.downloads[0].file));
  assert.equal(png.toString('hex', 0, 8), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 700);
  assert.equal(png.readUInt32BE(20), 440);
  console.log('✓ 同一执行器：语义选择工具/颜色 → 坐标拖拽 → 语义导出 PNG（700 × 440）');
  console.log(`验证通过。截图与下载保存在 ${runDir}`);
} catch (error) {
  console.error(`无障碍验证失败：${error.message}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await browser?.close();
}
