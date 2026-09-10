import '../lib/env.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserSession } from '../lib/browser.mjs';

// Explicit integration test of visible native applications. It never calls a
// model, runs a desktop shell command, or reads/writes a file inside the guest
// except through the native editor and the normal task-output download API.
const root = fileURLToPath(new URL('../', import.meta.url));
const base = process.env.DEMO_SMOKE_BASE_URL || 'http://127.0.0.1:4317';
const controlBase = process.env.DEMO_CONTROL_URL || 'http://127.0.0.1:8000';
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(new Error('桌面验证超过 180 秒，已停止继续操作。')), 180_000);
const initialText = '桌面智能体验证\n通过原生编辑器保存中文。\n';
const revisedText = '桌面智能体验证\n通过原生编辑器保存中文。\n第二次保存：文件版本已更新。\n';
const makeAction = overrides => ({ type: 'wait', target: null, x: null, y: null, toX: null, toY: null, text: null, key: null, deltaY: null, ...overrides });
const report = { checks: [], workspace: null, finalScreenshot: null, downloads: [] };
let browser;
let runDir;
let latest;

function passed(message) {
  report.checks.push(message);
  console.log(`✓ ${message}`);
}

async function preflight() {
  let response;
  try { response = await fetch(new URL('/api/status', base), { signal: AbortSignal.timeout(2500) }); }
  catch (error) {
    if (error.cause?.code !== 'ECONNREFUSED') throw new Error('无法确认控制台是否空闲，请先停止任务与宿主服务后重试。');
  }
  if (response) {
    assert.equal(response.status, 200, '控制台状态检查失败，未启动测试');
    const status = await response.json();
    assert.ok(!status.run || status.run.endedAt, '已有任务正在运行，请先停止；本测试不会打断它');
  }
  const healthResponse = await fetch(new URL('/health', controlBase), { signal: AbortSignal.timeout(3000) });
  assert.equal(healthResponse.status, 200, '容器健康检查失败，未启动测试');
  const health = await healthResponse.json();
  assert.equal(health.ready, true, '容器尚未就绪，未启动测试');
  assert.equal(health.capabilities?.desktopSessions, true, '容器镜像尚未提供桌面应用支持，请先重建镜像');
}

async function see() {
  latest = await browser.observe(controller.signal);
  assert.equal(latest.observation.desktop?.mode, 'desktop', '观察应标明桌面模式');
  assert.match(latest.observation.desktop.workspace, /^\/workspace\/tasks\/[A-Za-z0-9_-]+\/?$/, '只能使用本次容器任务目录');
  report.finalScreenshot = latest.screenshotPath;
  return latest.observation;
}

async function waitFor(description, predicate, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const observation = await see();
    if (await predicate(observation)) return observation;
    if (attempt + 1 < attempts) await delay(250, undefined, { signal: controller.signal });
  }
  const visible = latest?.observation.controls.map(({ role, name, value }) => `${role}: ${name} ${value}`).join('\n').slice(0, 6000);
  throw new Error(`${description}：等待超时。最近可见控件：\n${visible || '无'}`);
}

async function act(overrides) {
  return browser.act(makeAction(overrides), controller.signal);
}

async function key(value) {
  await act({ type: 'key', key: value });
}

function windowFor(observation, appId) {
  const candidates = observation.desktop.windows.filter(item => item.appId === appId);
  return candidates.find(item => item.active) || candidates[0];
}

async function focus(appId) {
  const observation = await waitFor(`发现 ${appId} 窗口`, seen => windowFor(seen, appId));
  await act({ type: 'focus_window', target: windowFor(observation, appId).id });
  return waitFor(`聚焦 ${appId} 窗口`, seen => windowFor(seen, appId)?.active);
}

async function fileList() {
  let seen = await see();
  // Thunar's icon renderer can draw filenames without exposing them to AT-SPI.
  // Its native List View exposes named table cells, so select that public view.
  if (!seen.controls.some(item => item.role === 'directory pane' && item.name === 'Details view')) {
    const menu = seen.controls.find(item => item.role === 'menu' && item.name === 'View' && item.actions.includes('click'));
    assert.ok(menu, '应能通过原生 View 菜单选择文件列表');
    await act({ type: 'click', target: menu.id });
    seen = await waitFor('原生菜单显示 List View', observation => observation.controls.some(item => item.name === 'List View' && item.actions.includes('click')));
    const list = seen.controls.find(item => item.name === 'List View' && item.actions.includes('click'));
    await act({ type: 'click', target: list.id });
  }
  return waitFor('文件管理器显示本次保存的文件', observation => windowFor(observation, 'files')?.active && observation.controls.some(item => item.name === 'demo.txt' || item.value === 'demo.txt'));
}

function editorField(observation) {
  // Mousepad's public multiline Text control, identified from its visible
  // bounds/role; no predetermined screen coordinates or private application API.
  return observation.controls
    .filter(item => /^(text|entry|paragraph)$/i.test(item.role) && item.width > 200 && item.height > 100 && item.enabled !== false)
    .sort((a, b) => Number(b.actions.includes('type')) - Number(a.actions.includes('type')) || b.width * b.height - a.width * a.height)[0];
}

async function fillEditor(text) {
  const seen = await waitFor('读取原生编辑器文本区域', observation => editorField(observation));
  const field = editorField(seen);
  if (field.actions.includes('type')) {
    await act({ type: 'type', target: field.id, text });
  } else {
    // A toolkit can expose Text without EditableText. Select the visible field
    // and explicitly use the normal clipboard typing path, with no hidden retry.
    await act({ type: 'click', x: field.x + field.width / 2, y: field.y + field.height / 2 });
    await key('ControlOrMeta+A');
    await act({ type: 'type', text });
  }
  return waitFor('原生文本区域显示中文内容', observation => editorField(observation)?.value === text.trim());
}

function saveDialog(observation) {
  return observation.controls.some(item => /^(dialog|file chooser)$/i.test(item.role) && /save|保存/i.test(item.name)) ||
    observation.controls.some(item => /^(save|_save|保存|保存\(_s\))$/i.test(item.name) && item.actions.includes('click'));
}

async function downloadedBytes(expected) {
  const file = browser.downloads.find(item => item.name === 'demo.txt');
  if (!file) return false;
  const bytes = await readFile(path.join(runDir, 'downloads', file.file));
  return bytes.equals(Buffer.from(expected, 'utf8'));
}

async function saveAs(workspace) {
  await key('ControlOrMeta+S');
  await waitFor('打开原生保存对话框', saveDialog);
  await key('ControlOrMeta+L');
  await act({ type: 'type', text: `${workspace.replace(/\/$/, '')}/demo.txt` });
  await key('Enter');
  // GTK may either accept the save directly or place the full path into its
  // location/name field. Inspect the resulting UI before choosing Save.
  let seen = await see();
  if (!await downloadedBytes(initialText) && saveDialog(seen)) {
    const save = seen.controls.filter(item => /^(save|_save|保存|保存\(_s\))$/i.test(item.name) && item.actions.includes('click'));
    assert.equal(save.length, 1, '原生保存对话框应有一个可操作的保存按钮');
    await act({ type: 'click', target: save[0].id });
  }
  seen = await waitFor('任务输出应包含完整 UTF-8 中文文件', async observation => !saveDialog(observation) && await downloadedBytes(initialText));
  assert.ok(seen.downloads.some(item => item.name === 'demo.txt'), '模型观察应包含本次文件产物');
  return seen;
}

try {
  await preflight();
  runDir = path.join(root, 'runs', `qa-desktop-${Date.now()}`);
  await mkdir(runDir, { recursive: true });
  browser = new BrowserSession({ runDir });
  console.log('验证 Linux 桌面：会重置 demo 容器应用，只操作本次任务目录，不请求模型。请勿同时启动任务。');
  await browser.start({ mode: 'desktop' }, controller.signal);
  let seen = await waitFor('桌面模式启动文件管理器', observation => windowFor(observation, 'files') && observation.accessibility.status === 'ready');
  report.workspace = seen.desktop.workspace;
  assert.deepEqual(seen.desktop.apps.map(item => item.id).sort(), ['browser', 'editor', 'files']);
  assert.equal(browser.downloads.length, 0, '新任务目录不得泄漏旧任务文件');
  passed('桌面会话、三种允许的应用、独立任务目录及文件管理器已就绪');

  const oldWindow = windowFor(seen, 'files').id;
  seen = await see();
  assert.notEqual(windowFor(seen, 'files').id, oldWindow, '窗口标识必须随观察更新');
  await assert.rejects(act({ type: 'focus_window', target: oldWindow }), error => !error.status && /过期|不存在|最新|重新观察/.test(error.message), '宿主应拒绝旧观察的窗口标识');
  seen = await see();
  const backendOldWindow = windowFor(seen, 'files').id;
  const otherReader = new BrowserSession({ runDir: path.join(runDir, 'other-reader') });
  await otherReader.observe(controller.signal);
  // The original BrowserSession still recognizes its ID, so only the backend
  // can reject this now-expired snapshot. No control credential is exported.
  await assert.rejects(act({ type: 'focus_window', target: backendOldWindow }), error => error.status === 409 && /过期|不存在|重新观察/.test(error.message), '容器应独立拒绝旧观察的窗口标识');
  passed('宿主与容器各自拒绝过期的窗口标识');

  await see();
  await act({ type: 'launch_app', target: 'editor' });
  await focus('editor');
  await fillEditor(initialText);
  await saveAs(report.workspace);
  const firstDownload = { ...browser.downloads.find(item => item.name === 'demo.txt') };
  assert.match(String(firstDownload.revision), /^\d+$/, '任务文件应有修改版本');
  passed('原生编辑器输入中文 → 原生保存对话框 → 宿主下载的 UTF-8 字节完全一致');

  await focus('editor');
  await fillEditor(revisedText);
  await key('ControlOrMeta+S');
  seen = await waitFor('覆盖保存应重新同步文件内容及版本', async () => {
    const current = browser.downloads.find(item => item.name === 'demo.txt');
    return current && current.revision !== firstDownload.revision && await downloadedBytes(revisedText);
  });
  assert.equal(browser.downloads.filter(item => item.name === 'demo.txt').length, 1, '覆盖保存应更新同名产物而非追加重复条目');
  passed('同名文件第二次保存后，下载内容与修改版本一起更新');

  await focus('files');
  await key('ControlOrMeta+L');
  await act({ type: 'type', text: report.workspace });
  await key('Enter');
  seen = await fileList();
  passed('切换到文件管理器原生列表视图，可见任务目录中的 demo.txt（已保存截图）');

  await act({ type: 'launch_app', target: 'browser' });
  seen = await focus('browser');
  await act({ type: 'close_window', target: windowFor(seen, 'browser').id });
  await waitFor('关闭允许的浏览器窗口', observation => !windowFor(observation, 'browser'));
  seen = await focus('editor');
  await act({ type: 'close_window', target: windowFor(seen, 'editor').id });
  await waitFor('关闭已保存的编辑器窗口', observation => !windowFor(observation, 'editor'));
  seen = await focus('files');
  assert.ok(await downloadedBytes(revisedText), '应用关闭后，任务产物仍应完整可下载');
  report.downloads = browser.downloads.map(({ name, size, revision, file }) => ({ name, size, revision, file }));
  passed('允许的应用启动、窗口切换和关闭均通过，已保存文件保持完整');
  report.ok = true;
  console.log(`桌面验证通过。截图、产物与验证记录保存在 ${runDir}`);
} catch (error) {
  report.ok = false;
  report.error = error.message;
  console.error(`桌面验证失败：${error.message}`);
  if (runDir) console.error(`最近截图与验证记录：${runDir}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  if (browser) report.downloads = browser.downloads.map(({ name, size, revision, file }) => ({ name, size, revision, file }));
  if (runDir) await writeFile(path.join(runDir, 'smoke-desktop.json'), JSON.stringify(report, null, 2));
  await browser?.close();
}
