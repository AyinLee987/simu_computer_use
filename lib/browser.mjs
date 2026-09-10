import './env.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VIEWPORT = { width: 1000, height: 720 };
const API = process.env.DEMO_CONTROL_URL || 'http://127.0.0.1:8000';
export const DESKTOP_URL = process.env.DEMO_DESKTOP_URL || 'http://127.0.0.1:6080/vnc.html?autoconnect=true&resize=scale&view_only=true&show_dot=true';
const CONFIG_FILE = fileURLToPath(new URL('../dockercompose.env', import.meta.url));
let cachedToken;

async function controlToken() {
  if (cachedToken) return cachedToken;
  if (process.env.DEMO_CONTROL_TOKEN) return (cachedToken = process.env.DEMO_CONTROL_TOKEN);
  try { cachedToken = (await readFile(CONFIG_FILE, 'utf8')).match(/^DEMO_CONTROL_TOKEN=([a-f0-9]{64})\s*$/m)?.[1]; } catch {}
  if (!cachedToken) throw new Error('缺少容器控制凭据。请先运行 npm run setup。');
  return cachedToken;
}

export async function checkDesktop() {
  try {
    const response = await fetch(`${API}/health`, { signal: AbortSignal.timeout(3000) });
    const info = await response.json();
    return { ready: response.ok && info.ready === true, desktopUrl: DESKTOP_URL, label: info.ready ? '容器桌面已就绪' : '容器桌面正在启动' };
  } catch { return { ready: false, desktopUrl: DESKTOP_URL, label: 'Docker 桌面未就绪，请先运行 npm run desktop' }; }
}

async function request(route, { body, signal, raw = false, timeout = 20000 } = {}) {
  const token = await controlToken();
  const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
  let response;
  try {
    response = await fetch(`${API}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: combined });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new Error(error.name === 'TimeoutError' ? '容器操作超时，请检查 Docker 桌面状态。' : '无法连接容器控制服务，请确认 Docker 正在运行。');
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(response.status === 401 ? '容器凭据不一致，请重新启动 demo 容器。' : error.error || '容器未能执行该操作。');
  }
  return raw ? Buffer.from(await response.arrayBuffer()) : response.json();
}

function isLocalHost(hostname) {
  hostname = hostname.replace(/\.+$/, '');
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '[::1]' || hostname === 'host.docker.internal' || /^127\./.test(hostname) || hostname === '0.0.0.0';
}
export function targetFor({ scenario, url, seed }) {
  if (scenario === 'paint' || scenario === 'maze') return `http://127.0.0.1:8000/labs/${scenario}.html?seed=${encodeURIComponent(seed)}`;
  if (scenario !== 'custom') throw new Error('请选择画板、迷宫或自定义网页。');
  let target;
  try { target = new URL(url); } catch { throw new Error('请输入完整的网页地址。'); }
  if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password || isLocalHost(target.hostname)) throw new Error('自定义页面请使用普通外部 http/https 地址；本机实验请使用上面的画板或迷宫。');
  return target.href;
}

function coordinate(value, max, label) {
  if (!Number.isFinite(value) || value < 0 || value >= max) throw new Error(`${label} 超出当前截图范围。`);
}
export function validateAction(action) {
  if (!action || !['click', 'drag', 'type', 'key', 'scroll', 'wait'].includes(action.type)) throw new Error('模型返回了不支持的动作。');
  if (action.target != null) throw new Error('容器模式使用截图坐标，不提供网页控件编号。');
  if (action.type === 'click' || action.type === 'drag') { coordinate(action.x, VIEWPORT.width, '横坐标'); coordinate(action.y, VIEWPORT.height, '纵坐标'); }
  if (action.type === 'drag') { coordinate(action.toX, VIEWPORT.width, '终点横坐标'); coordinate(action.toY, VIEWPORT.height, '终点纵坐标'); }
  if (action.type === 'type' && (typeof action.text !== 'string' || action.text.length > 2000)) throw new Error('输入文字必须在 2000 字以内。');
  if (action.type === 'key' && (typeof action.key !== 'string' || !/^(ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Enter|Escape|Tab|Space|Backspace|Delete|Home|End|PageUp|PageDown|[a-zA-Z0-9]|(?:Control|Meta|ControlOrMeta)\+[az]|Shift\+Tab)$/i.test(action.key))) throw new Error('该按键不在 demo 的操作范围内。');
  if (action.type === 'scroll' && (!Number.isFinite(action.deltaY) || Math.abs(action.deltaY) > 1500)) throw new Error('单次滚动距离必须在 1500 像素以内。');
  return action;
}

// The adapter only receives rendered desktop screenshots and dispatches OS
// input. It has no DOM reader, application-state reader or scenario solver.
export class BrowserSession {
  constructor({ runDir, onDownload = () => {}, onNotice = () => {} }) {
    Object.assign(this, { runDir, onDownload, onNotice });
    this.downloads = [];
    this.knownDownloads = new Set();
    this.frame = 0;
    this.started = false;
  }
  async start(url, signal) {
    this.targetUrl = url;
    this.started = true;
    await request('/session', { body: { url }, signal, timeout: 45000 });
  }
  async observe() {
    await this.collectDownloads();
    const screenshot = await request('/screenshot', { raw: true });
    const filename = `${String(++this.frame).padStart(4, '0')}.png`;
    const folder = path.join(this.runDir, 'screens');
    await mkdir(folder, { recursive: true });
    const screenshotPath = path.join(folder, filename);
    await writeFile(screenshotPath, screenshot);
    const observation = { url: this.targetUrl, title: '容器桌面截图', ...VIEWPORT, text: '本次只有桌面截图。请从截图读取页面文字、工具、游戏规则和实际结果；没有 DOM 或隐藏状态信息。url 是本次启动目标，不代表当前地址栏状态。', controls: [], downloads: this.downloads.map(({ name, size }) => ({ name, size })) };
    return { observation, screenshotPath, screenshotUrl: `/runs/${path.basename(this.runDir)}/screens/${filename}` };
  }
  async collectDownloads() {
    const listing = await request('/downloads');
    for (const item of listing.files || []) {
      if (this.knownDownloads.has(item.name)) continue;
      const safeName = path.basename(item.name).replace(/[^\p{L}\p{N}_.-]/gu, '_').slice(0, 100) || 'download';
      const savedName = `${Date.now()}-${safeName}`;
      const content = await request(`/downloads/${encodeURIComponent(item.name)}`, { raw: true });
      const folder = path.join(this.runDir, 'downloads');
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, savedName), content);
      const record = { name: item.name, size: content.length, file: savedName, url: `/runs/${path.basename(this.runDir)}/downloads/${encodeURIComponent(savedName)}` };
      this.knownDownloads.add(item.name);
      this.downloads.push(record);
      this.onDownload(record);
    }
  }
  async act(rawAction, signal) {
    signal?.throwIfAborted();
    const action = validateAction(rawAction);
    await request('/action', { body: action, signal });
    signal?.throwIfAborted();
    return { ok: true, action };
  }
  async stop() { if (this.started) await request('/stop', { body: {}, timeout: 6000 }).catch(() => {}); }
  async close() { /* Keep the finished desktop visible through noVNC. The next session resets it. */ }
}
