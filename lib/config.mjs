import './env.mjs';

function invalid(message) {
  const error = new Error(message);
  error.code = 'MODEL_CONFIG';
  throw error;
}
function value(env, name, fallback = '') {
  const result = env[name];
  return result == null || String(result).trim() === '' ? fallback : String(result).trim();
}
function choice(env, name, choices, fallback) {
  const result = value(env, name, fallback);
  if (!choices.includes(result)) invalid(`${name} 只支持 ${choices.join(' / ')}。`);
  return result;
}
function modelName(name, field) {
  if (name.length > 200 || /[\x00-\x1f\x7f]/.test(name)) invalid(`${field} 格式不正确。`);
  return name;
}

// Parse provider settings. The legacy auto branch is only a config fallback;
// runtime login-aware choice belongs to resolveModelSelection in model-selection.
export function readModelConfig(env = process.env) {
  const selected = choice(env, 'MODEL_PROVIDER', ['auto', 'codex', 'openai'], 'auto');
  const apiKey = value(env, 'OPENAI_API_KEY');
  const provider = selected === 'auto' ? (apiKey ? 'openai' : 'codex') : selected;
  if (provider === 'codex') return { provider, model: modelName(value(env, 'CODEX_MODEL'), 'CODEX_MODEL') };
  if (!apiKey) invalid('请在 .env 中填写 OPENAI_API_KEY，或将 MODEL_PROVIDER 改为 codex。');
  if (apiKey.length > 8192 || /[\x00-\x20\x7f]/.test(apiKey)) invalid('OPENAI_API_KEY 格式不正确，请勿填写账号密码。');
  let endpoint;
  try { endpoint = new URL(value(env, 'OPENAI_BASE_URL', 'https://api.openai.com/v1')); }
  catch { invalid('OPENAI_BASE_URL 必须是完整的 API 根地址。'); }
  const hostname = endpoint.hostname.toLowerCase().replace(/\.+$/, '');
  const loopback = hostname === 'localhost' || hostname === '[::1]' || /^127\./.test(hostname);
  if ((endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    invalid('OPENAI_BASE_URL 需要 HTTPS（本机回环地址可用 HTTP），且不能包含账号、查询参数或片段。');
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '');
  if (/\/(responses|chat\/completions)$/.test(endpoint.pathname)) invalid('OPENAI_BASE_URL 请填 API 根地址，不要附加 /responses 或 /chat/completions。');
  const timeoutMs = Number(value(env, 'OPENAI_TIMEOUT_MS', '150000'));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) invalid('OPENAI_TIMEOUT_MS 必须是 1000 到 300000 之间的整数。');
  return {
    provider, apiKey, baseUrl: endpoint.href.replace(/\/$/, ''),
    model: modelName(value(env, 'OPENAI_MODEL', 'gpt-4.1'), 'OPENAI_MODEL'),
    apiStyle: choice(env, 'OPENAI_API_STYLE', ['responses', 'chat_completions'], 'responses'),
    responseFormat: choice(env, 'OPENAI_RESPONSE_FORMAT', ['json_schema', 'json_object'], 'json_schema'),
    timeoutMs,
  };
}

// These strings are the only config-derived values intended for the web UI.
// No API key, endpoint, model input or account details are returned here.
export function publicModelInfo(config) {
  const api = config.provider === 'openai';
  return {
    provider: config.provider,
    billingLabel: api ? '每轮会请求配置的模型 API，费用由 API 服务商计收，不使用 Codex 订阅额度。' : '每轮会请求真实模型，使用本机 Codex 登录对应的额度或计费方式。',
  };
}

export function codexEnvironment(env = process.env) {
  const result = { ...env };
  // Explicit Codex mode reuses the CLI's own login/configuration. API-mode
  // credentials and endpoint overrides must not leak into a CLI subprocess.
  for (const name of Object.keys(result)) {
    if (/^(OPENAI_|CODEX_API_KEY$|DEMO_CONTROL_TOKEN$)/i.test(name)) delete result[name];
  }
  return result;
}
