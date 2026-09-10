// A desktop observation is a capability snapshot, not a source of commands.
const APP_IDS = new Set(['files', 'editor', 'browser']);
const WINDOW_ID = /^win-[A-Za-z0-9_-]{1,160}(?![\s\S])/;
const clip = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
export const ACTION_KEYS = ['type', 'target', 'x', 'y', 'toX', 'toY', 'text', 'key', 'deltaY'];
export const ACTION_TYPES = new Set(['click', 'double_click', 'right_click', 'drag', 'type', 'key', 'scroll', 'wait', 'launch_app', 'focus_window', 'close_window']);
const DESKTOP_ACTIONS = new Set(['launch_app', 'focus_window', 'close_window']);
const KEYS = /^(ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Enter|Escape|Tab|Space|Backspace|Delete|Home|End|PageUp|PageDown|[a-z0-9]|(?:Control|Ctrl|Meta|ControlOrMeta)\+[azcvxsonfl]|(?:Control|Ctrl|Meta|ControlOrMeta)\+Shift\+S|Alt\+(?:Tab|F4)|F2|F5|F10|Shift\+(?:Tab|ArrowUp|ArrowDown|ArrowLeft|ArrowRight))(?![\s\S])/i;

function uniqueEntries(value, valid, limit) {
  if (!Array.isArray(value)) return [];
  // Overlarge capability lists are discarded rather than trusting a prefix
  // whose duplicate IDs could appear later in an unbounded input.
  if (value.length > 1000) return [];
  const counts = new Map();
  for (const item of value) if (typeof item?.id === 'string') counts.set(item.id, (counts.get(item.id) || 0) + 1);
  return value.filter(item => valid(item) && counts.get(item.id) === 1).slice(0, limit);
}

export function normalizeDesktop(value) {
  const mode = value?.mode === 'desktop' ? 'desktop' : 'browser';
  if (mode !== 'desktop') return { mode, apps: [], windows: [], workspace: null };
  const apps = uniqueEntries(value.apps, app => app && APP_IDS.has(app.id), 3)
    .map(app => ({ id: app.id, name: clip(app.name, 100) }));
  const available = new Set(apps.map(app => app.id));
  const windows = uniqueEntries(value.windows, window => window && typeof window.id === 'string' &&
    WINDOW_ID.test(window.id) && available.has(window.appId), 32)
    .map(window => ({ id: window.id, appId: window.appId, title: clip(window.title, 500), active: window.active === true }));
  const workspace = typeof value.workspace === 'string' && /^\/workspace\/tasks\/[A-Za-z0-9_-]{1,128}(?![\s\S])/.test(value.workspace)
    ? value.workspace : null;
  return { mode, apps, windows, workspace };
}

export function validateDesktopTarget(action, observation) {
  if (!DESKTOP_ACTIONS.has(action.type)) return false;
  const desktop = normalizeDesktop(observation?.desktop);
  const capabilities = action.type === 'launch_app' ? desktop.apps : desktop.windows;
  if (desktop.mode !== 'desktop' || typeof action.target !== 'string' ||
      !capabilities.some(item => item.id === action.target)) {
    throw new Error('应用或窗口编号未知或已过期，请重新观察后再操作。');
  }
  return true;
}

export function validateActionFields(action, width, height) {
  if (!action || typeof action !== 'object' || Array.isArray(action) ||
      Object.keys(action).length !== ACTION_KEYS.length || !ACTION_KEYS.every(key => Object.hasOwn(action, key)) ||
      !ACTION_TYPES.has(action.type)) throw new Error('模型返回了不支持的动作或动作字段。');
  if (action.target !== null && (typeof action.target !== 'string' || !action.target || action.target.length > 200)) {
    throw new Error('动作编号格式无效。');
  }
  const related = new Set(['type']);
  const coordinate = (name, max) => {
    related.add(name);
    if (!Number.isFinite(action[name]) || action[name] < 0 || action[name] >= max) throw new Error('坐标超出当前截图范围。');
  };
  if (DESKTOP_ACTIONS.has(action.type)) related.add('target');
  else if (action.type === 'click' && action.target !== null) related.add('target');
  else if (['click', 'double_click', 'right_click', 'drag'].includes(action.type)) {
    coordinate('x', width); coordinate('y', height);
    if (action.type === 'drag') { coordinate('toX', width); coordinate('toY', height); }
  } else if (action.type === 'type') {
    related.add('text'); related.add('target');
    if (typeof action.text !== 'string' || action.text.length > 2000) throw new Error('输入文字必须在 2000 字以内。');
  } else if (action.type === 'key') {
    related.add('key');
    if (typeof action.key !== 'string' || !KEYS.test(action.key)) throw new Error('该按键不在 demo 的操作范围内。');
  } else if (action.type === 'scroll') {
    related.add('deltaY');
    if (!Number.isFinite(action.deltaY) || Math.abs(action.deltaY) > 1500) throw new Error('单次滚动距离必须在 1500 像素以内。');
  }
  if (ACTION_KEYS.some(field => !related.has(field) && action[field] !== null)) {
    throw new Error('动作不能同时携带无关字段。');
  }
}

export const MAX_OUTPUT_FILES = 100;
export const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

export function safeOutputName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 300 &&
    !/[\\:\u0000-\u001f\u007f]/.test(name) &&
    name.split('/').every(segment => segment && segment !== '.' && segment !== '..');
}

export function normalizeOutputs(files, { strict = false } = {}) {
  const invalid = () => { if (strict) throw new Error('容器输出文件列表无效或超过限制。'); return []; };
  if (!Array.isArray(files) || files.length > MAX_OUTPUT_FILES) return invalid();
  const names = new Set();
  const output = [];
  for (const item of files) {
    if (!safeOutputName(item?.name) || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > MAX_OUTPUT_BYTES ||
        (item.revision !== undefined && (typeof item.revision !== 'string' || !/^\d{1,30}(?![\s\S])/.test(item.revision))) ||
        names.has(item.name)) {
      if (strict) return invalid();
      continue;
    }
    names.add(item.name);
    output.push({ name: item.name, size: item.size, ...(item.revision === undefined ? {} : { revision: item.revision }) });
  }
  return output;
}
