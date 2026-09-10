import { open } from 'node:fs/promises';

const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 150_000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

class DecisionApiError extends Error {
  constructor(code, message, { status, name = 'Error' } = {}) {
    super(message);
    this.name = name;
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

const failure = (code, message, options) => new DecisionApiError(code, message, options);
const aborted = () => failure('MODEL_ABORTED', '模型 API 请求已停止。', { name: 'AbortError' });
const invalidOutput = () => failure('MODEL_API_FORMAT', '模型 API 未返回有效的最终文本。');
const toolOutput = () => failure('MODEL_API_TOOL', '模型 API 返回了工具调用或不支持的输出，本次请求已停止。');
const refused = () => failure('MODEL_API_REFUSAL', '模型 API 拒绝了本次请求。');
const incomplete = () => failure('MODEL_API_INCOMPLETE', '模型 API 响应未完成，请调整设置后重试。');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function prepareConfig(config) {
  if (!isObject(config) || typeof config.apiKey !== 'string' || !config.apiKey.trim() ||
      /[\r\n]/.test(config.apiKey) || typeof config.model !== 'string' || !config.model.trim()) {
    throw failure('MODEL_API_CONFIG', '请检查 API Key 和模型名称配置。');
  }
  const apiStyle = config.apiStyle ?? 'responses';
  const responseFormat = config.responseFormat ?? 'json_schema';
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!['responses', 'chat_completions'].includes(apiStyle) ||
      !['json_schema', 'json_object'].includes(responseFormat) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw failure('MODEL_API_CONFIG', '请检查 API 协议、输出格式和超时配置。');
  }
  let base;
  try { base = new URL(config.baseUrl || 'https://api.openai.com/v1'); }
  catch { throw failure('MODEL_API_CONFIG', '请检查 API 服务地址配置。'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw failure('MODEL_API_CONFIG', '请检查 API 服务地址配置。');
  }
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/${apiStyle === 'responses' ? 'responses' : 'chat/completions'}`;
  return { apiKey: config.apiKey.trim(), model: config.model.trim(), apiStyle, responseFormat, timeoutMs, endpoint: base.href };
}

async function screenshotDataUrl(screenshotPath, signal) {
  if (typeof screenshotPath !== 'string' || !screenshotPath) {
    throw failure('MODEL_INPUT', '当前页面截图不可用。');
  }
  const handle = await open(screenshotPath, 'r');
  try {
    signal.throwIfAborted();
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_SCREENSHOT_BYTES) {
      throw failure('MODEL_INPUT', '截图必须是 20 MB 以内的 PNG 文件。');
    }
    const chunks = [];
    let size = 0;
    // The bounded stream also handles a file that grows after the size check.
    const stream = handle.createReadStream({ start: 0, end: MAX_SCREENSHOT_BYTES, autoClose: false, signal });
    try {
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > MAX_SCREENSHOT_BYTES) throw failure('MODEL_INPUT', '截图必须是 20 MB 以内的 PNG 文件。');
        chunks.push(chunk);
      }
    } finally { stream.destroy(); }
    const image = Buffer.concat(chunks, size);
    if (image.length < PNG_SIGNATURE.length || !image.subarray(0, 8).equals(PNG_SIGNATURE)) {
      throw failure('MODEL_INPUT', '截图必须是 20 MB 以内的 PNG 文件。');
    }
    return `data:image/png;base64,${image.toString('base64')}`;
  } finally { await handle.close(); }
}

function requestBody(config, instructions, prompt, image, schema) {
  const outputSchema = { ...schema };
  delete outputSchema.$schema;
  const effectiveInstructions = config.responseFormat === 'json_object'
    ? `${instructions}\n\nReturn one JSON object matching this exact schema:\n${JSON.stringify(outputSchema)}`
    : instructions;
  const format = config.responseFormat === 'json_schema'
    ? { type: 'json_schema', name: 'browser_decision', strict: true, schema: outputSchema }
    : { type: 'json_object' };
  if (config.apiStyle === 'responses') {
    return {
      model: config.model,
      instructions: effectiveInstructions,
      input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url: image, detail: 'high' }] }],
      text: { format },
      stream: false,
      store: false,
    };
  }
  return {
    model: config.model,
    messages: [
      { role: 'system', content: effectiveInstructions },
      { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: image, detail: 'high' } }] },
    ],
    response_format: config.responseFormat === 'json_schema'
      ? { type: 'json_schema', json_schema: { name: format.name, strict: true, schema: outputSchema } }
      : format,
    stream: false,
  };
}

async function responseJson(response) {
  const announcedSize = Number(response.headers.get('content-length'));
  if (announcedSize > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw failure('MODEL_API_OUTPUT_LIMIT', '模型 API 响应超过 2 MB，已停止读取。');
  }
  if (!response.body) throw invalidOutput();
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) throw failure('MODEL_API_OUTPUT_LIMIT', '模型 API 响应超过 2 MB，已停止读取。');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
  catch { throw invalidOutput(); }
}

function hasToolCalls(value) {
  return isObject(value) && (value.function_call != null ||
    (value.tool_calls != null && (!Array.isArray(value.tool_calls) || value.tool_calls.length > 0)));
}

function responsesText(data) {
  if (hasToolCalls(data)) throw toolOutput();
  if (data.refusal != null) throw refused();
  if (data.status !== 'completed' || data.incomplete_details != null) throw incomplete();
  if (!Array.isArray(data.output) || data.output.length === 0) throw invalidOutput();
  const text = [];
  for (const item of data.output) {
    if (!isObject(item)) throw invalidOutput();
    if (hasToolCalls(item)) throw toolOutput();
    if (item.type === 'reasoning') continue;
    if (item.type === 'refusal' || item.refusal != null) throw refused();
    if (item.type !== 'message') throw toolOutput();
    if (item.status != null && item.status !== 'completed') throw incomplete();
    if (item.role !== 'assistant' || !Array.isArray(item.content)) throw invalidOutput();
    for (const part of item.content) {
      if (!isObject(part)) throw invalidOutput();
      if (part.type === 'refusal' || part.refusal != null) throw refused();
      if (part.type !== 'output_text' || typeof part.text !== 'string') throw invalidOutput();
      if (item.channel == null || item.channel === 'final') text.push(part.text);
    }
  }
  return text.join('');
}

function chatText(data) {
  if (hasToolCalls(data)) throw toolOutput();
  if (!Array.isArray(data.choices) || data.choices.length === 0) throw invalidOutput();
  for (const choice of data.choices) {
    if (!isObject(choice) || !isObject(choice.message)) throw invalidOutput();
    if (hasToolCalls(choice.message) || ['tool_calls', 'function_call'].includes(choice.finish_reason)) throw toolOutput();
    if (choice.message.refusal != null || choice.finish_reason === 'content_filter') throw refused();
    if (choice.finish_reason !== 'stop') throw incomplete();
  }
  if (data.choices.length !== 1) throw invalidOutput();
  const message = data.choices[0].message;
  if (message.role !== 'assistant') throw invalidOutput();
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) throw invalidOutput();
  return message.content.map((part) => {
    if (part?.type === 'refusal' || part?.refusal != null) throw refused();
    if (part?.type !== 'text' || typeof part.text !== 'string') throw invalidOutput();
    return part.text;
  }).join('');
}

function numericUsage(usage) {
  if (!isObject(usage)) return null;
  const result = {};
  const copy = (name, value) => { if (typeof value === 'number' && Number.isFinite(value) && value >= 0) result[name] = value; };
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens', 'prompt_tokens', 'completion_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'reasoning_output_tokens']) {
    copy(key, usage[key]);
  }
  copy('cached_input_tokens', usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens);
  copy('reasoning_output_tokens', usage.output_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens);
  return result;
}

/** Sends one image-and-text request. No tools, retries, or protocol fallback. */
export async function requestDecision({ config, instructions, prompt, screenshotPath, schema, signal } = {}) {
  if (signal?.aborted) throw aborted();
  const settings = prepareConfig(config);
  if (typeof instructions !== 'string' || typeof prompt !== 'string' || !isObject(schema)) {
    throw failure('MODEL_INPUT', '模型请求缺少文字指令或输出格式。');
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort(aborted());
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const timer = setTimeout(() => controller.abort(failure('MODEL_TIMEOUT', '模型 API 请求超时，已停止本次请求。')), settings.timeoutMs);
  timer.unref();
  try {
    let image;
    try { image = await screenshotDataUrl(screenshotPath, controller.signal); }
    catch (error) {
      if (controller.signal.aborted || error instanceof DecisionApiError) throw error;
      throw failure('MODEL_INPUT', '当前页面截图不可用。');
    }
    controller.signal.throwIfAborted();
    const body = requestBody(settings, instructions, prompt, image, schema);
    const response = await fetch(settings.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${settings.apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw failure('MODEL_API_HTTP', `模型 API 请求失败（HTTP ${response.status}）。`, { status: response.status });
    }
    const data = await responseJson(response);
    controller.signal.throwIfAborted();
    if (!isObject(data)) throw invalidOutput();
    if (data.error != null) throw failure('MODEL_API_FAILED', '模型 API 返回了错误，请检查配置和可用额度。');
    const text = settings.apiStyle === 'responses' ? responsesText(data) : chatText(data);
    if (!text.trim()) throw invalidOutput();
    return { text, usage: numericUsage(data.usage) };
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof DecisionApiError) throw error;
    // Never forward provider errors, request URLs, API keys or fetch causes.
    throw failure('MODEL_API_NETWORK', '无法完成模型 API 请求，请检查配置和网络。');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
