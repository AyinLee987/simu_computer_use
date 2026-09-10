import './lib/env.mjs';
import http from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { BrowserSession, targetFor, checkDesktop } from './lib/browser.mjs';
import { decide, checkModelConnection } from './lib/model.mjs';
import { parsePort, projectIdentity } from './lib/launcher.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = parsePort(process.env.PORT);
const ORIGIN = new URL(`http://127.0.0.1:${PORT}`).origin;
const LOCALHOST_ORIGIN = new URL(`http://localhost:${PORT}`).origin;
const ALLOWED_HOSTS = new Set([new URL(ORIGIN).host, new URL(LOCALHOST_ORIGIN).host, `127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const HEALTH = { app: 'browser-agent-demo', projectId: projectIdentity(ROOT) };
const PUBLIC = path.join(ROOT, 'public');
const RUNS = path.join(ROOT, 'runs');
const clients = new Set();
const modelStatus = { ready: false, checking: true, label: '正在检查模型连接', provider: null, selection: 'auto', authMethod: null, verified: false };
let environment = { ready: false, label: '正在检查容器桌面', desktopUrl: null };
let current = null;
let startingRun = false;
let modelCheckTask = null;

async function refreshModelConnection(refresh = false) {
  if (modelCheckTask) return modelCheckTask;
  Object.assign(modelStatus, { ready: false, checking: true, verified: false, label: '正在检测本机登录与模型来源' });
  broadcast('model', modelStatus);
  modelCheckTask = (async () => {
    try {
      const result = await checkModelConnection({ refresh });
      Object.assign(modelStatus, {
        ready: result?.ok === true,
        label: result?.message || '请检查模型配置',
        provider: result?.provider || null,
        selection: result?.selection || 'auto',
        authMethod: result?.authMethod || null,
        billingLabel: result?.billingLabel || '开始任务后会请求真实模型。',
        verified: result?.verified === true,
      });
    } catch {
      Object.assign(modelStatus, { ready: false, provider: null, authMethod: null, label: '模型未就绪，请检查 .env 配置或 Codex 登录。' });
    }
    modelStatus.checking = false;
    broadcast('model', modelStatus);
    return { ...modelStatus };
  })().finally(() => { modelCheckTask = null; });
  return modelCheckTask;
}

function publicRun(run) {
  if (!run) return null;
  const { controller, browser, directory, history, task, ...view } = run;
  return view;
}
function broadcast(type, data) {
  const chunk = `data: ${JSON.stringify({ type, data })}\n\n`;
  for (const res of clients) res.write(chunk);
}
function event(run, type, data) {
  const item = { seq: run.events.length, time: new Date().toISOString(), type, ...data };
  run.events.push(item);
  broadcast('event', { runId: run.id, event: item });
  return item;
}
function update(run, fields) { Object.assign(run, fields); broadcast('state', publicRun(run)); }

async function execute(run, target) {
  const signal = run.controller.signal;
  const browser = new BrowserSession({
    origin: ORIGIN, runDir: run.directory,
    onDownload: item => { run.downloads.push(item); event(run, 'download', item); },
    onNotice: message => event(run, 'notice', { message })
  });
  run.browser = browser;
  try {
    event(run, 'notice', { message: '正在 Docker 容器桌面中打开新的浏览器会话，noVNC 将实时显示画面。' });
    await browser.start(target, signal);
    signal.throwIfAborted();
    let seen = await browser.observe();
    update(run, { screenshotUrl: seen.screenshotUrl, controls: seen.observation.controls, targetUrl: seen.observation.url });
    event(run, 'observation', { step: 0, screenshotUrl: seen.screenshotUrl, observation: seen.observation });
    for (let step = 1; step <= run.stepLimit; step++) {
      signal.throwIfAborted();
      update(run, { step, phase: 'deciding' });
      const decision = await decide({ goal: run.goal, observation: seen.observation, history: run.history.slice(-8), screenshotPath: seen.screenshotPath, signal });
      signal.throwIfAborted();
      if (!modelStatus.verified) {
        modelStatus.verified = true;
        modelStatus.label = modelStatus.provider === 'openai' ? '模型 API 已返回有效决策' : '本机 Codex 已返回有效决策';
        broadcast('model', modelStatus);
      }
      event(run, 'decision', { step, summary: decision.summary, actions: decision.actions, done: decision.done, success: decision.success });
      const record = { step, summary: decision.summary, actions: decision.actions, results: [] };
      run.history.push(record);
      if (decision.done) {
        if (decision.actions.length) throw new Error('模型同时返回“完成”和待执行动作，请重新开始。');
        update(run, { status: decision.success ? 'completed' : 'failed', phase: 'finished', result: decision.summary });
        break;
      }
      if (!decision.actions.length) throw new Error('模型没有给出下一步动作或完成状态。');
      update(run, { phase: 'acting' });
      for (const action of decision.actions) {
        signal.throwIfAborted();
        update(run, { lastAction: action });
        try {
          const result = await browser.act(action, signal);
          record.results.push(result);
          event(run, 'action', { step, action, ok: true });
        } catch (error) {
          if (signal.aborted) throw error;
          const message = error.message.slice(0, 350);
          record.results.push({ ok: false, action, error: message });
          event(run, 'action', { step, action, ok: false, message });
          break;
        }
        seen = await browser.observe();
        update(run, { screenshotUrl: seen.screenshotUrl, controls: seen.observation.controls });
      }
      seen = await browser.observe();
      record.resultText = seen.observation.text.slice(-3000);
      update(run, { phase: 'observing', screenshotUrl: seen.screenshotUrl, controls: seen.observation.controls });
      event(run, 'observation', { step, screenshotUrl: seen.screenshotUrl, observation: seen.observation });
      if (step === run.stepLimit) update(run, { status: 'limit', phase: 'finished', result: '已到本次观察轮数上限。结果已保留，可以检查后调整目标再试。' });
    }
  } catch (error) {
    if (signal.aborted) await browser.stop();
    update(run, { status: signal.aborted ? 'stopped' : 'failed', phase: 'finished', result: signal.aborted ? '已停止，保留最后画面和操作记录。' : error.message.slice(0, 500) });
    if (!signal.aborted) event(run, 'error', { message: run.result });
  } finally {
    await browser.close();
    Object.assign(run, { endedAt: new Date().toISOString(), phase: 'finished' });
    await writeFile(path.join(run.directory, 'trace.json'), JSON.stringify(publicRun(run), null, 2));
    broadcast('state', publicRun(run));
  }
}

async function jsonBody(req) {
  let text = '';
  for await (const chunk of req) { text += chunk; if (text.length > 16000) throw new Error('请求内容太长。'); }
  try { return JSON.parse(text || '{}'); } catch { throw new Error('请求格式不正确。'); }
}
function sendJson(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}
async function file(res, filename, download = false) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon' };
  const content = await readFile(filename);
  res.writeHead(200, { 'content-type': types[path.extname(filename)] || 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(download ? { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(filename))}` } : {}) });
  res.end(content);
}

const server = http.createServer(async (req, res) => {
  try {
    if (!ALLOWED_HOSTS.has(req.headers.host)) return sendJson(res, 403, { error: '只接受本机访问。' });
    const url = new URL(req.url, ORIGIN);
    if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, HEALTH);
    if (req.method === 'GET' && url.pathname === '/api/status') return sendJson(res, 200, { model: modelStatus, environment, run: publicRun(current) });
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'snapshot', data: { model: modelStatus, environment, run: publicRun(current) } })}\n\n`);
      clients.add(res);
      const keepAlive = setInterval(() => res.write(': keepalive\n\n'), 20000);
      req.on('close', () => { clients.delete(res); clearInterval(keepAlive); });
      return;
    }
    if (req.method === 'POST') {
      const validOrigins = [ORIGIN, LOCALHOST_ORIGIN];
      if (req.headers.origin && !validOrigins.includes(req.headers.origin)) return sendJson(res, 403, { error: '请求必须来自本机控制台。' });
      if (!req.headers['content-type']?.includes('application/json')) return sendJson(res, 415, { error: '需要 JSON 请求。' });
      const body = await jsonBody(req);
      if (url.pathname === '/api/model/refresh') {
        if (startingRun || (current && !current.endedAt)) return sendJson(res, 409, { error: '任务运行中不能重新选择模型来源，请先停止任务或等待结束。' });
        return sendJson(res, 200, { model: await refreshModelConnection(true) });
      }
      if (url.pathname === '/api/stop') {
        if (current?.status === 'running') { update(current, { status: 'stopping', phase: 'stopping' }); current.controller.abort(); }
        return sendJson(res, 200, { ok: true });
      }
      if (url.pathname === '/api/run') {
        if (startingRun || (current && !current.endedAt)) return sendJson(res, 409, { error: '上一项任务正在启动或结束，请稍后重试。' });
        if (modelStatus.checking || !modelStatus.ready) return sendJson(res, 400, { error: modelStatus.label || '模型尚未就绪。请先检查本机登录或配置。' });
        if (typeof body.goal !== 'string' || body.goal.trim().length < 2 || body.goal.length > 2000) return sendJson(res, 400, { error: '请填写 2 到 2000 字的目标。' });
        const stepLimit = Number(body.stepLimit || 10);
        if (!Number.isInteger(stepLimit) || stepLimit < 1 || stepLimit > 20) return sendJson(res, 400, { error: '观察轮数范围是 1 到 20。' });
        const seed = Number.isSafeInteger(Number(body.seed)) ? Number(body.seed) : Date.now();
        const target = targetFor({ ...body, seed }, ORIGIN);
        // Reserve the provider before awaiting desktop/filesystem work, so a
        // concurrent refresh cannot change billing as a task starts.
        startingRun = true;
        try {
          environment = await checkDesktop();
          if (!environment.ready) return sendJson(res, 400, { error: environment.label });
          const id = randomUUID();
          const directory = path.join(RUNS, id);
          await mkdir(directory, { recursive: true });
          current = { id, directory, scenario: body.scenario, seed, goal: body.goal.trim(), stepLimit, step: 0, status: 'running', phase: 'opening', modelProvider: modelStatus.provider, modelAuthMethod: modelStatus.authMethod, targetUrl: target, screenshotUrl: null, controls: [], downloads: [], events: [], history: [], startedAt: new Date().toISOString(), endedAt: null, result: null, controller: new AbortController() };
          update(current, {});
          current.task = execute(current, target).catch(error => { console.error('Run cleanup failed:', error.message); });
          return sendJson(res, 202, { id });
        } finally { startingRun = false; }
      }
      return sendJson(res, 404, { error: '未找到该接口。' });
    }
    if (req.method !== 'GET') return sendJson(res, 405, { error: '不支持的请求方式。' });
    const route = decodeURIComponent(url.pathname);
    if (route.startsWith('/runs/')) {
      const match = route.match(/^\/runs\/([a-f0-9-]{36})\/(screens\/[0-9]{4}\.png|downloads\/[^/\\]+|trace\.json)$/);
      if (!match || match[2].split(/[\\/]/).some(part => part === '..')) return sendJson(res, 404, { error: '文件不存在。' });
      return await file(res, path.join(RUNS, match[1], match[2]), match[2].startsWith('downloads/') || match[2] === 'trace.json');
    }
    const filename = path.resolve(PUBLIC, `.${route === '/' ? '/index.html' : route}`);
    if (!filename.startsWith(PUBLIC + path.sep) || !(await stat(filename)).isFile()) return sendJson(res, 404, { error: '页面不存在。' });
    return await file(res, filename);
  } catch (error) { if (!res.headersSent) sendJson(res, error.code === 'ENOENT' ? 404 : 400, { error: error.code === 'ENOENT' ? '文件不存在。' : error.message }); else res.end(); }
});

server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${PORT} 已被占用。请打开 ${ORIGIN}，或使用 PORT 环境变量指定新端口。` : error.message); process.exitCode = 1; });
server.listen(PORT, '127.0.0.1', async () => {
  console.log(`Browser Agent Lab is running at ${ORIGIN}`);
  await refreshModelConnection();
  environment = await checkDesktop();
  broadcast('environment', environment);
});
const healthTimer = setInterval(async () => {
  const next = await checkDesktop();
  if (next.ready !== environment.ready || next.label !== environment.label) { environment = next; broadcast('environment', environment); }
}, 8000);
healthTimer.unref();
let closing = false;
export async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(healthTimer);
  current?.controller.abort();
  await current?.task;
  for (const res of clients) res.end();
  server.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
