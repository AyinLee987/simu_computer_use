// Keep the model-facing and execution-facing interpretation of opaque snapshot
// targets identical. A role/name is data, never permission to invoke a control.
import { validateDesktopTarget } from './desktop.mjs';
const TARGET_ACTIONS = new Set(['click', 'type']);
const clip = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';

export function normalizeControls(controls) {
  if (!Array.isArray(controls)) return [];
  const ids = new Set();
  const duplicates = new Set();
  for (const control of controls) {
    if (typeof control?.id !== 'string') continue;
    if (ids.has(control.id)) duplicates.add(control.id);
    ids.add(control.id);
  }
  return controls.filter(control => control && typeof control.id === 'string' &&
    control.id.length > 0 && control.id.length <= 200 && !duplicates.has(control.id))
    .slice(0, 150).map(control => ({
      id: control.id,
      role: clip(control.role, 100),
      name: clip(control.name, 500),
      value: control.password === true ? '' : clip(control.value, 1000),
      enabled: control.enabled === true,
      password: control.password === true,
      actions: control.enabled === true && Array.isArray(control.actions)
        ? [...new Set(control.actions.filter(action => TARGET_ACTIONS.has(action)))] : [],
      pressed: typeof control.pressed === 'boolean' ? control.pressed : null,
      checked: control.indeterminate === true ? null : typeof control.checked === 'boolean' ? control.checked : null,
      expanded: typeof control.expanded === 'boolean' ? control.expanded : null,
      selected: typeof control.selected === 'boolean' ? control.selected : null,
      indeterminate: typeof control.indeterminate === 'boolean' ? control.indeterminate : null,
      x: Number.isFinite(control.x) ? control.x : null,
      y: Number.isFinite(control.y) ? control.y : null,
      width: Number.isFinite(control.width) ? control.width : null,
      height: Number.isFinite(control.height) ? control.height : null,
    }));
}

export function validateTargetAction(action, observation) {
  if (validateDesktopTarget(action, observation)) return;
  if (action.target == null) return;
  if (!TARGET_ACTIONS.has(action.type)) throw new Error('只有点击和填写文字可以使用控件编号。');
  const controls = Array.isArray(observation?.controls) ? observation.controls : [];
  const matches = controls.filter(control => control?.id === action.target);
  if (typeof action.target !== 'string' || !action.target || matches.length !== 1 ||
      observation?.accessibility?.status === 'unavailable') {
    throw new Error('控件编号未知或已过期，请重新观察后再操作。');
  }
  const control = matches[0];
  if (control.enabled !== true || !Array.isArray(control.actions) || !control.actions.includes(action.type)) {
    throw new Error('当前控件未提供该操作能力，请重新观察或使用截图坐标。');
  }
  const unrelated = ['x', 'y', 'toX', 'toY', 'key', 'deltaY', ...(action.type === 'click' ? ['text'] : [])];
  if (unrelated.some(field => action[field] !== null)) {
    throw new Error('控件操作不能同时携带坐标、按键或其他无关字段。');
  }
}
