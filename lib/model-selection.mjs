import { stripVTControlCharacters } from 'node:util';
import { readModelConfig } from './config.mjs';

const AUTH_METHODS = new Set(['chatgpt', 'api_key', 'unknown']);
const PROBE_FAILURES = new Set(['unavailable', 'not_logged_in', 'failed']);

// Match status sentences, not mentions in warnings, help, URLs or key values.
// The API-key suffix may contain a masked key; it is never returned or stored.
export function classifyCodexLogin(output) {
  if (typeof output !== 'string') return 'unknown';
  const lines = stripVTControlCharacters(output).split(/\r?\n/).map(line => line.trim());
  if (lines.some(line => /^not logged in\b/i.test(line))) return 'unknown';
  const chatgpt = lines.some(line => /^logged in using chatgpt\.?$/i.test(line));
  const apiKey = lines.some(line => /^logged in using (?:an )?api key(?:\s*[-:]\s*.*|\.)?$/i.test(line));
  return chatgpt === apiKey ? 'unknown' : chatgpt ? 'chatgpt' : 'api_key';
}

function publicStatus({ ok, provider, selection, authMethod = null, message, billingLabel }) {
  // Keep this explicit allowlist: probe/config objects may contain credentials.
  return { ok, provider, verified: false, selection, authMethod, message, billingLabel };
}

async function inspectLogin(probeCodex) {
  if (typeof probeCodex !== 'function') return { ok: false, reason: 'unavailable' };
  try {
    const result = await probeCodex();
    if (result?.ok === true) {
      return { ok: true, authMethod: AUTH_METHODS.has(result.authMethod) ? result.authMethod : 'unknown' };
    }
    return { ok: false, reason: PROBE_FAILURES.has(result?.reason) ? result.reason : 'failed' };
  } catch {
    // Never forward exception messages or raw login-status output to the UI.
    return { ok: false, reason: 'failed' };
  }
}

function codexSelection(env, selection, login) {
  if (!login.ok) {
    const message = login.reason === 'unavailable'
      ? '未找到可用的本机 Codex CLI。请安装 Codex CLI，并运行 codex login 完成本机登录。'
      : login.reason === 'not_logged_in'
        ? '本机 Codex 尚未登录。请运行 codex login 完成本机登录后再试。'
        : '无法确认本机 Codex 登录状态。请检查 Codex CLI，并运行 codex login 后再试。';
    return { config: null, status: publicStatus({ ok: false, provider: 'codex', selection, message, billingLabel: '尚未选定可用的 Codex 登录，不会发送模型请求。' }) };
  }

  const authMethod = login.authMethod;
  const billingLabel = authMethod === 'chatgpt'
    ? '使用本机 ChatGPT 登录对应的 Codex 额度，不使用 .env 中的 API Key。'
    : authMethod === 'api_key'
      ? '使用 Codex CLI 自身的 API Key 登录，按 API 用量计费，不是 ChatGPT 订阅额度。'
      : '使用本机 Codex 登录；登录方式未识别，额度或费用以 CLI 实际认证方式为准。';
  const source = selection === 'auto' ? '已自动选择本机 Codex' : '已选择本机 Codex';
  const message = authMethod === 'chatgpt'
    ? `${source}（ChatGPT 登录），不会使用 .env 中的 API Key。`
    : authMethod === 'api_key'
      ? `${source}（CLI 自身的 API Key 登录），将按 API 用量计费。`
      : `${source}，但尚未识别其登录方式。`;
  try {
    const config = readModelConfig({ ...env, MODEL_PROVIDER: 'codex' });
    return { config, status: publicStatus({ ok: true, provider: 'codex', selection, authMethod, message, billingLabel }) };
  } catch {
    return { config: null, status: publicStatus({ ok: false, provider: 'codex', selection, authMethod, message: '本机 Codex 配置格式不正确，请检查 CODEX_MODEL。', billingLabel }) };
  }
}

function apiSelection(env, selection) {
  const billingLabel = '每轮会请求已配置的模型 API，费用由 API 服务商计收，不使用 Codex 订阅额度。';
  try {
    const config = readModelConfig({ ...env, MODEL_PROVIDER: 'openai' });
    const message = selection === 'auto'
      ? '未确认本机 Codex 已登录，已自动选择已配置的模型 API。'
      : '已选择模型 API，不会使用本机 Codex 登录。';
    return { config, status: publicStatus({ ok: true, provider: 'openai', selection, message, billingLabel }) };
  } catch {
    return { config: null, status: publicStatus({ ok: false, provider: 'openai', selection, message: '模型 API 配置不完整或格式不正确，请检查 .env 中的 API 配置。', billingLabel }) };
  }
}

// Resolve once before a task starts; the caller keeps the returned config for
// the entire task. This module performs no model requests or runtime failover.
export async function resolveModelSelection({ env = process.env, probeCodex } = {}) {
  const selected = env.MODEL_PROVIDER == null ? 'auto' : String(env.MODEL_PROVIDER).trim() || 'auto';
  if (!['auto', 'codex', 'openai'].includes(selected)) {
    return { config: null, status: publicStatus({ ok: false, provider: null, selection: 'auto', message: 'MODEL_PROVIDER 只支持 auto / codex / openai。', billingLabel: '尚未选择可用模型，不会发送模型请求。' }) };
  }
  if (selected === 'openai') return apiSelection(env, selected);

  const login = await inspectLogin(probeCodex);
  if (selected === 'codex' || login.ok) return codexSelection(env, selected, login);
  if (env.OPENAI_API_KEY != null && String(env.OPENAI_API_KEY).trim()) return apiSelection(env, selected);
  return codexSelection(env, selected, login);
}
