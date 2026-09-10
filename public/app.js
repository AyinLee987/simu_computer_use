const $ = selector => document.querySelector(selector);
const defaults = { paint: '使用矩形工具，在画布中央画一个红色实心矩形，然后导出 PNG。', maze: '阅读页面上的迷宫规则，控制角色拿到钥匙，再走到出口完成通关。', custom: '阅读这个网页，完成：' };
const names = { paint: '几何画板', maze: '钥匙迷宫', custom: '其他网页' };
const statusNames = { running: '执行中', stopping: '正在停止', completed: '模型确认完成', failed: '未完成', stopped: '已停止', limit: '到达轮数上限' };
const phaseNames = { opening: '正在容器中打开网页', deciding: '模型正在读取截图并选择动作', acting: '正在执行模型选择的动作', observing: '正在获取新的 PNG 截图', stopping: '正在停止模型和浏览器操作' };
const defaultDesktopUrl = 'http://127.0.0.1:6080/vnc.html?autoconnect=true&resize=scale&view_only=true';
let scenario = 'paint', seed = 10, run = null, connected = false, historical = false, submitting = false;
let model = { ready: false, checking: true, label: '正在检查模型来源', provider: null, billingLabel: '', verified: false };
let environment = { ready: false, label: '正在检查 Docker 桌面…', desktopUrl: defaultDesktopUrl };
let renderedEvents = 0, currentRunId = null, newestScreen = '', selectedScreen = '', viewMode = 'desktop', desktopSource = '';
let healthRequest = null;
const eventsElement = $('#events');

function isBusy() { return Boolean(run && !run.endedAt); }
function updateConnection() {
  $('#connection').classList.toggle('ready', Boolean(model.ready && environment.ready && connected && (model.provider !== 'openai' || model.verified)));
  $('#connection').title = model.provider === 'openai' ? 'API 模型来源；是否通过真实请求验证请查看任务设置中的说明。' : model.provider === 'codex' ? '使用本机 Codex CLI 的登录状态。' : '模型来源由服务端配置决定。';
  if (!connected) $('#connection-label').textContent = '正在连接本地服务';
  else if (!environment.ready) $('#connection-label').textContent = 'Docker 桌面尚未就绪';
  else $('#connection-label').textContent = model.label || (model.ready ? '模型已就绪' : '模型尚未就绪');
}
function controls() {
  const busy = isBusy();
  $('#start').hidden = busy;
  $('#stop').hidden = !busy;
  $('#start').disabled = !model.ready || !environment.ready || !connected || submitting;
  $('#stop').disabled = run?.status === 'stopping';
  for (const el of document.querySelectorAll('.setup input,.setup textarea,.setup select,#shuffle')) el.disabled = busy || submitting;
  $('#phase').hidden = !busy && !submitting;
  $('#phase-label').textContent = submitting && !busy ? '正在启动容器浏览器任务' : phaseNames[run?.phase] || '正在结束本次任务';
}
function setModel(next) {
  if (!next) return;
  model = next;
  $('#billing-note').textContent = model.billingLabel || '每轮会请求真实模型，计费方式以当前模型来源为准。';
  const verification = $('#model-verification');
  verification.hidden = model.provider !== 'openai';
  verification.textContent = model.verified ? 'API 已完成真实请求验证；模型任务仍可能因页面或输出变化而失败。' : model.ready ? 'API 配置校验通过，尚未进行真实付费请求；开始任务后才会调用接口。' : 'API 尚未就绪，请检查本机 .env 配置。';
  updateConnection();
  controls();
}
function desktopUrl() { return environment.desktopUrl || defaultDesktopUrl; }
function setEnvironment(next) {
  if (!next) return;
  environment = { ...environment, ...next };
  $('#environment-label').textContent = environment.label || (environment.ready ? 'Docker 容器已就绪' : 'Docker 尚未就绪，请启动容器后重试。');
  $('#environment-status').classList.toggle('ready', Boolean(environment.ready));
  $('#environment-status').classList.toggle('unavailable', !environment.ready);
  $('#open-target').href = desktopUrl();
  $('#open-target').hidden = !environment.ready;
  if (environment.ready && desktopSource !== desktopUrl()) {
    desktopSource = desktopUrl();
    $('#preview').src = desktopSource;
  }
  updateConnection();
  updateView();
  controls();
}
function placeholder(title, description, waiting = false) {
  const element = $('#loading');
  element.replaceChildren();
  if (waiting) { const spinner = document.createElement('span'); spinner.className = 'spinner'; element.append(spinner); }
  const strong = document.createElement('strong'); strong.textContent = title;
  const p = document.createElement('p'); p.textContent = description;
  element.append(strong, p);
  element.hidden = false;
}
function updateView() {
  const desktop = viewMode === 'desktop';
  $('#view-desktop').setAttribute('aria-selected', String(desktop));
  $('#view-screenshot').setAttribute('aria-selected', String(!desktop));
  $('#view-desktop').tabIndex = desktop ? 0 : -1;
  $('#view-screenshot').tabIndex = desktop ? -1 : 0;
  $('#view-desktop').classList.toggle('selected', desktop);
  $('#view-screenshot').classList.toggle('selected', !desktop);
  $('#iframe-holder').hidden = !desktop || !environment.ready;
  $('#live-screen').hidden = desktop || !selectedScreen;
  $('#loading').hidden = true;
  $('#cursor-marker').hidden = true;
  $('#back-live').hidden = desktop || !historical || !newestScreen;
  $('#view-dimension').textContent = desktop ? 'noVNC · 实时' : 'PNG · 1000 × 720';
  if (desktop) {
    $('#view-label').textContent = '容器实时桌面';
    if (!environment.ready) placeholder('Docker 桌面尚未就绪', environment.label || '请先启动 Docker 容器。环境就绪后会自动连接桌面。');
    $('#viewer-caption').textContent = !environment.ready ? '等待 Docker 环境就绪；此处尚无实时桌面。' : run && !run.endedAt ? `${phaseNames[run.phase] || '正在处理'} · 桌面持续实时显示。` : run?.endedAt ? '任务已结束；容器桌面仍实时显示，截图与记录已保留。' : `容器实时桌面 · 下次任务：${names[scenario]}${scenario !== 'custom' ? '，布局 ' + seed : ''}。`;
  } else {
    $('#view-label').textContent = historical ? '历史观察截图' : '模型看到的最新截图';
    if (selectedScreen) {
      if ($('#live-screen').getAttribute('src') !== selectedScreen) $('#live-screen').src = selectedScreen;
      $('#viewer-caption').textContent = historical ? '这是所选轮次的静态 PNG，和实时桌面独立。' : run?.endedAt ? '运行结束时模型看到的最后一张 PNG，记录已保留。' : '模型实际接收的 PNG 截图，仅在新一轮观察后更新。';
    } else {
      placeholder('尚无模型观察截图', isBusy() || submitting ? '第一轮截图生成后会显示在这里；容器桌面可随时查看。' : '开始执行后，可以查看模型每轮实际收到的 PNG。', isBusy() || submitting);
      $('#viewer-caption').textContent = '截图随模型观察更新，不是实时视频。';
    }
    if (!historical && selectedScreen && run?.lastAction && run.status === 'running') {
      const action = run.lastAction;
      const x = action.type === 'drag' ? action.toX : action.x;
      const y = action.type === 'drag' ? action.toY : action.y;
      const marker = $('#cursor-marker'); marker.hidden = x == null || y == null;
      if (!marker.hidden) { marker.style.left = `${x / 10}%`; marker.style.top = `${y / 7.2}%`; }
    }
  }
  $('#address').textContent = run?.targetUrl || (environment.ready ? '容器桌面 / 等待开始任务' : '容器桌面 / 等待环境就绪');
}
function setView(mode) {
  viewMode = mode;
  historical = false;
  selectedScreen = newestScreen;
  updateView();
}
$('#view-desktop').addEventListener('click', () => setView('desktop'));
$('#view-screenshot').addEventListener('click', () => setView('screenshot'));
document.querySelector('.view-switch').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const mode = event.key === 'Home' ? 'desktop' : event.key === 'End' ? 'screenshot' : viewMode === 'desktop' ? 'screenshot' : 'desktop';
  setView(mode); $(`#view-${mode}`).focus();
});
function setupPreview() {
  $('#custom-url-field').hidden = scenario !== 'custom';
  $('#variation').hidden = scenario === 'custom';
  document.querySelectorAll('.scenario-choice').forEach(label => label.classList.toggle('selected', label.querySelector('input').value === scenario));
  $('#seed-label').textContent = `下次运行使用布局 ${seed}`;
  updateView();
}
document.querySelectorAll('input[name=scenario]').forEach(input => input.addEventListener('change', () => { scenario = input.value; $('#goal').value = defaults[scenario]; setupPreview(); }));
$('#shuffle').addEventListener('click', () => { seed = 1 + Math.floor(Math.random() * 99999); setupPreview(); });

function showScreen(url, historic = false) {
  if (!url) return;
  viewMode = 'screenshot';
  historical = historic;
  selectedScreen = url;
  updateView();
}
$('#back-live').addEventListener('click', () => showScreen(newestScreen));
function actionText(action) {
  if (!action) return '浏览器操作';
  const where = `(${Math.round(action.x || 0)}, ${Math.round(action.y || 0)})`;
  return ({ click: `点击 ${where}`, drag: `拖拽 (${action.x}, ${action.y}) → (${action.toX}, ${action.toY})`, type: `输入「${action.text}」`, key: `按键 ${action.key}`, scroll: `滚动 ${action.deltaY} 像素`, wait: '等待页面响应' })[action.type] || action.type;
}
function renderEvent(event) {
  const card = document.createElement('article');
  card.className = `event-card ${event.type}`;
  const time = new Date(event.time).toLocaleTimeString('zh-CN', { hour12: false });
  const labels = { observation: '截图观察', decision: '模型决策', action: '执行结果', download: '文件', notice: '记录', error: '未完成' };
  card.innerHTML = `<div class="event-top"><span class="event-badge">${labels[event.type] || '记录'}</span>${event.step !== undefined ? `<span>第 ${event.step} 轮</span>` : ''}<time>${time}</time></div>`;
  if (event.type === 'observation') {
    const button = document.createElement('button'); button.className = 'observation-link';
    button.textContent = 'PNG 截图 · 查看模型当时看到的画面 ↗';
    button.disabled = !event.screenshotUrl;
    button.addEventListener('click', () => showScreen(event.screenshotUrl, true)); card.append(button);
    const details = document.createElement('details');
    details.innerHTML = '<summary>本轮截图与执行反馈信息</summary>';
    const pre = document.createElement('pre');
    const observation = { ...(event.observation || {}) };
    delete observation.controls;
    pre.textContent = JSON.stringify({ ...observation, screenshotUrl: event.screenshotUrl }, null, 2);
    details.append(pre); card.append(details);
  } else {
    const p = document.createElement('p');
    p.textContent = event.type === 'decision' ? event.summary : event.type === 'action' ? `${event.ok ? '✓' : '×'} ${actionText(event.action)}${event.message ? ` · ${event.message}` : ''}` : event.type === 'download' ? `已保存 ${event.name}` : event.message;
    card.append(p);
    if (event.type === 'decision' && event.actions?.length) {
      const details = document.createElement('details'); details.innerHTML = `<summary>${event.actions.length} 个动作 · 查看 JSON</summary>`;
      const pre = document.createElement('pre'); pre.textContent = JSON.stringify(event.actions, null, 2); details.append(pre); card.append(details);
    }
  }
  eventsElement.append(card);
}
function renderRun(next) {
  if (!next) { run = null; updateView(); controls(); return; }
  const atBottom = eventsElement.scrollTop + eventsElement.clientHeight >= eventsElement.scrollHeight - 70;
  if (next.id !== currentRunId) {
    currentRunId = next.id; renderedEvents = 0; eventsElement.replaceChildren(); historical = false;
    newestScreen = ''; selectedScreen = ''; $('#live-screen').removeAttribute('src');
    $('#form-error').hidden = true; $('#result').hidden = true;
  }
  run = next;
  const events = run.events || [], downloads = run.downloads || [];
  while (renderedEvents < events.length) renderEvent(events[renderedEvents++]);
  if (atBottom) eventsElement.scrollTop = eventsElement.scrollHeight;
  if (run.screenshotUrl) { newestScreen = run.screenshotUrl; if (!historical) selectedScreen = newestScreen; }
  $('#run-status').textContent = statusNames[run.status] || '等待开始';
  $('#run-step').textContent = `${run.step} / ${run.stepLimit}`;
  $('#run-actions').textContent = events.filter(e => e.type === 'action' && e.ok).length;
  $('#run-downloads').textContent = downloads.length;
  $('#tiny-status').classList.toggle('active', run.status === 'running');
  if (run.result) {
    $('#result').hidden = false;
    $('#result').classList.toggle('failed', run.status !== 'completed');
    $('#result-title').textContent = run.status === 'completed' ? '模型根据最后的截图确认完成' : statusNames[run.status];
    $('#result-text').textContent = run.result;
  } else if (downloads.length) {
    $('#result').hidden = false;
    $('#result').classList.remove('failed');
    $('#result-title').textContent = '已保存下载文件';
    $('#result-text').textContent = '任务仍在执行时，也可以查看已经产出的文件。';
  }
  $('#downloads').replaceChildren();
  for (const d of downloads) { const a = document.createElement('a'); a.href = d.url; a.textContent = `↓ ${d.name}`; a.download = d.name; $('#downloads').append(a); }
  $('#download-trace').hidden = !run.endedAt;
  $('#download-trace').href = `/runs/${run.id}/trace.json`;
  updateView();
  controls();
}

async function post(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '请求失败。'); return result;
}
function showError(message) { $('#form-error').textContent = message; $('#form-error').hidden = false; }
async function refreshStatus() {
  if (healthRequest) return healthRequest;
  healthRequest = (async () => {
    const response = await fetch('/api/status', { cache: 'no-store' });
    if (!response.ok) throw new Error('本地服务暂时无法检查 Docker 状态。');
    const snapshot = await response.json();
    setModel(snapshot.model);
    setEnvironment(snapshot.environment);
    if ('run' in snapshot) renderRun(snapshot.run);
  })();
  try { await healthRequest; } finally { healthRequest = null; }
}
$('#start').addEventListener('click', async () => {
  if (submitting || isBusy()) return;
  $('#form-error').hidden = true;
  submitting = true; controls(); updateView();
  try {
    if (!environment.ready) throw new Error('Docker 桌面尚未就绪，请等待环境连接后开始。');
    if (scenario === 'custom' && !$('#target-url').value.trim()) throw new Error('请填写要操作的网址。');
    const result = await post('/api/run', { scenario, goal: $('#goal').value, url: $('#target-url').value.trim(), seed, stepLimit: Number($('#rounds').value) });
    if (result.run) renderRun(result.run);
    else await refreshStatus();
  } catch (error) { showError(error.message); }
  finally { submitting = false; controls(); updateView(); }
});
$('#stop').addEventListener('click', async () => { $('#stop').disabled = true; try { await post('/api/stop', {}); } catch (error) { showError(error.message); controls(); } });
const stream = new EventSource('/api/events');
stream.onopen = () => { connected = true; $('#connection').classList.remove('offline'); updateConnection(); controls(); };
stream.onerror = () => { connected = false; $('#connection').classList.add('offline'); $('#connection-label').textContent = '与本地服务断开，正在重连'; controls(); };
stream.onmessage = ({ data }) => {
  let message;
  try { message = JSON.parse(data); } catch { return; }
  if (message.type === 'snapshot') { setModel(message.data.model); setEnvironment(message.data.environment); renderRun(message.data.run); }
  if (message.type === 'model') setModel(message.data);
  if (message.type === 'environment') setEnvironment(message.data);
  if (message.type === 'state') renderRun(message.data);
  if (message.type === 'event' && run?.id === message.data.runId && !(run.events || []).some(e => e.seq === message.data.event.seq)) { (run.events ||= []).push(message.data.event); renderRun(run); }
};
setupPreview();
refreshStatus().catch(error => setEnvironment({ ready: false, label: error.message }));
setInterval(() => {
  if (!environment.ready) refreshStatus().catch(error => setEnvironment({ ready: false, label: error.message }));
}, 5000);
