import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { requestDecision } from '../lib/openai-api.mjs';

// All requests in this file use a loopback mock. Never use process.env keys or
// a real provider, and never request a model or the desktop container.
const KEY = 'test-only-api-key-not-a-real-credential';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false, properties: { summary: { type: 'string' } }, required: ['summary'] };
const apiSchema = { ...schema };
delete apiSchema.$schema;
const finalText = '{"summary":"下一步"}';
const outputMessage = (content = [{ type: 'output_text', text: finalText }]) => ({ type: 'message', role: 'assistant', status: 'completed', content });
const responsesResult = (extra = {}) => ({ status: 'completed', output: [outputMessage()], usage: { input_tokens: 5, output_tokens: 3 }, ...extra });
const chatResult = (extra = {}) => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: finalText } }], usage: { prompt_tokens: 5, completion_tokens: 3 }, ...extra });
let directory;
let screenshotPath;

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'browser-agent-api-test-'));
  screenshotPath = path.join(directory, 'screenshot.png');
  await writeFile(screenshotPath, PNG);
});

after(async () => {
  if (directory) {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('browser-agent-api-test-'));
    await rm(directory, { recursive: true, force: true });
  }
});

async function mockServer(t, handler) {
  const calls = [];
  const errors = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = { method: req.method, url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') };
      calls.push(request);
      await handler(request, res, calls.length);
    } catch (error) {
      errors.push(error);
      res.writeHead(500).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.deepEqual(errors, []);
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, calls };
}

const respond = (res, value, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
const options = (baseUrl, config = {}, extra = {}) => ({
  config: { apiKey: KEY, baseUrl, model: 'mock-vision-model', apiStyle: 'responses', responseFormat: 'json_schema', timeoutMs: 2000, ...config },
  instructions: '只返回 JSON 对象；使用当前截图决定下一步。',
  prompt: '观察当前页面。', screenshotPath, schema, ...extra,
});

function checkPrivateError(error, ...privateValues) {
  for (const value of [KEY, ...privateValues]) {
    assert.equal(String(error).includes(value), false);
    assert.equal(error.stack.includes(value), false);
  }
  assert.equal(error.cause, undefined);
  return true;
}

test('Responses sends the PNG, strict schema and auth without any tools; only final text and numeric usage return', async (t) => {
  const mock = await mockServer(t, (_req, res) => respond(res, responsesResult({
    output: [
      { type: 'reasoning', summary: [{ text: 'discarded private reasoning' }], encrypted_content: 'discarded' },
      { ...outputMessage([{ type: 'output_text', text: 'discarded commentary' }]), channel: 'commentary' },
      outputMessage(),
    ],
    usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12, prompt_tokens: '9', completion_tokens: -1, private_provider_field: 3, input_tokens_details: { cached_tokens: 6 }, output_tokens_details: { reasoning_tokens: 2 } },
  })));
  const args = options(`${mock.baseUrl}///`);
  const result = await requestDecision(args);
  assert.deepEqual(result, { text: finalText, usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12, cached_input_tokens: 6, reasoning_output_tokens: 2 } });
  assert.equal(mock.calls.length, 1);
  const request = mock.calls[0];
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/v1/responses');
  assert.equal(request.headers.authorization, `Bearer ${KEY}`);
  assert.match(request.headers['content-type'], /application\/json/);
  assert.equal(request.body.instructions, args.instructions);
  assert.equal(request.body.model, 'mock-vision-model');
  assert.deepEqual(request.body.input[0].content, [
    { type: 'input_text', text: args.prompt },
    { type: 'input_image', image_url: `data:image/png;base64,${PNG.toString('base64')}`, detail: 'high' },
  ]);
  assert.deepEqual(request.body.text.format, { type: 'json_schema', name: 'browser_decision', strict: true, schema: apiSchema });
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(request.body.store, false);
  assert.equal(request.body.stream, false);
  for (const field of ['tools', 'tool_choice', 'functions']) assert.equal(Object.hasOwn(request.body, field), false);
});

test('Chat Completions sends system/user image messages and its own strict response_format shape', async (t) => {
  const mock = await mockServer(t, (_req, res) => respond(res, chatResult({ usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 1 } } })));
  const args = options(mock.baseUrl, { apiStyle: 'chat_completions' });
  const result = await requestDecision(args);
  assert.deepEqual(result, { text: finalText, usage: { total_tokens: 13, prompt_tokens: 9, completion_tokens: 4, cached_input_tokens: 2, reasoning_output_tokens: 1 } });
  const request = mock.calls[0];
  assert.equal(request.url, '/v1/chat/completions');
  assert.equal(request.headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(request.body.messages, [
    { role: 'system', content: args.instructions },
    { role: 'user', content: [{ type: 'text', text: args.prompt }, { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}`, detail: 'high' } }] },
  ]);
  assert.deepEqual(request.body.response_format, { type: 'json_schema', json_schema: { name: 'browser_decision', strict: true, schema: apiSchema } });
  for (const field of ['tools', 'tool_choice', 'functions']) assert.equal(Object.hasOwn(request.body, field), false);
});

test('json_object is explicit in both protocols and includes the exact schema in its instructions', async (t) => {
  const mock = await mockServer(t, (req, res) => respond(res, req.url.endsWith('/responses') ? responsesResult() : chatResult()));
  for (const apiStyle of ['responses', 'chat_completions']) {
    await requestDecision(options(mock.baseUrl, { apiStyle, responseFormat: 'json_object' }));
  }
  assert.deepEqual(mock.calls[0].body.text.format, { type: 'json_object' });
  assert.deepEqual(mock.calls[1].body.response_format, { type: 'json_object' });
  assert.ok(mock.calls[0].body.instructions.endsWith(JSON.stringify(apiSchema)));
  assert.ok(mock.calls[1].body.messages[0].content.endsWith(JSON.stringify(apiSchema)));
  assert.equal(mock.calls.length, 2);
});

test('HTTP failures keep only safe fixed text and status, and never retry or switch protocols', async (t) => {
  const providerSecret = 'provider-private-body-and-url';
  const mock = await mockServer(t, (_req, res) => respond(res, { error: { message: `${providerSecret} ${KEY}` } }, 429));
  await assert.rejects(requestDecision(options(mock.baseUrl)), (error) => {
    assert.equal(error.code, 'MODEL_API_HTTP');
    assert.equal(error.status, 429);
    assert.match(error.message, /HTTP 429/);
    return checkPrivateError(error, providerSecret, mock.baseUrl);
  });
  assert.equal(mock.calls.length, 1);
});

test('redirects are rejected before an Authorization header can reach the destination', async (t) => {
  const destination = await mockServer(t, (_req, res) => respond(res, responsesResult()));
  const source = await mockServer(t, (_req, res) => res.writeHead(307, { location: `${destination.baseUrl}/collect` }).end());
  await assert.rejects(requestDecision(options(source.baseUrl)), (error) => {
    assert.equal(error.code, 'MODEL_API_NETWORK');
    return checkPrivateError(error, source.baseUrl, destination.baseUrl);
  });
  assert.equal(source.calls.length, 1);
  assert.equal(destination.calls.length, 0);
});

test('Responses rejects tool calls, refusals and every unfinished response', async (t) => {
  const cases = [
    [responsesResult({ output: [{ type: 'function_call', name: 'do_something', arguments: '{}' }, outputMessage()] }), 'MODEL_API_TOOL'],
    [responsesResult({ output: [{ type: 'web_search_call' }, outputMessage()] }), 'MODEL_API_TOOL'],
    [responsesResult({ output: [{ ...outputMessage(), tool_calls: [{ id: 'call' }] }] }), 'MODEL_API_TOOL'],
    [responsesResult({ output: [outputMessage([{ type: 'refusal', refusal: 'private refusal text' }])] }), 'MODEL_API_REFUSAL'],
    ...['incomplete', 'in_progress', 'failed', 'cancelled', 'queued'].map(status => [responsesResult({ status }), 'MODEL_API_INCOMPLETE']),
    [responsesResult({ incomplete_details: { reason: 'max_output_tokens' } }), 'MODEL_API_INCOMPLETE'],
  ];
  const mock = await mockServer(t, (_req, res, count) => respond(res, cases[count - 1][0]));
  for (const [, code] of cases) await assert.rejects(requestDecision(options(mock.baseUrl)), { code });
  assert.equal(mock.calls.length, cases.length);
});

test('Chat Completions rejects tool calls, legacy function calls, refusals and partial output', async (t) => {
  const cases = [
    [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: finalText, tool_calls: [{ id: 'call' }] } }, 'MODEL_API_TOOL'],
    [{ finish_reason: 'stop', message: { role: 'assistant', content: finalText, function_call: { name: 'call' } } }, 'MODEL_API_TOOL'],
    [{ finish_reason: 'stop', message: { role: 'assistant', content: finalText, refusal: 'private refusal' } }, 'MODEL_API_REFUSAL'],
    [{ finish_reason: 'content_filter', message: { role: 'assistant', content: finalText } }, 'MODEL_API_REFUSAL'],
    [{ finish_reason: 'length', message: { role: 'assistant', content: finalText } }, 'MODEL_API_INCOMPLETE'],
    [{ finish_reason: null, message: { role: 'assistant', content: finalText } }, 'MODEL_API_INCOMPLETE'],
  ];
  const mock = await mockServer(t, (_req, res, count) => respond(res, chatResult({ choices: [cases[count - 1][0]] })));
  for (const [, code] of cases) await assert.rejects(requestDecision(options(mock.baseUrl, { apiStyle: 'chat_completions' })), { code });
});

test('malformed JSON and provider-side errors are redacted instead of returning their bodies', async (t) => {
  const secret = 'not-for-the-user-provider-debug-text';
  const mock = await mockServer(t, (_req, res, count) => count === 1
    ? res.writeHead(200).end(`${secret} ${KEY}`)
    : respond(res, { error: { message: `${secret} ${KEY}` } }));
  for (const code of ['MODEL_API_FORMAT', 'MODEL_API_FAILED']) {
    await assert.rejects(requestDecision(options(mock.baseUrl)), (error) => {
      assert.equal(error.code, code);
      return checkPrivateError(error, secret, mock.baseUrl);
    });
  }
});

test('response size is bounded for both Content-Length and chunked bodies', async (t) => {
  const mock = await mockServer(t, (_req, res, count) => {
    if (count === 1) return res.writeHead(200, { 'content-length': 3 * 1024 * 1024 }).end('x');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"text":"');
    res.end(`${'x'.repeat(2 * 1024 * 1024)}"}`);
  });
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(requestDecision(options(mock.baseUrl)), { code: 'MODEL_API_OUTPUT_LIMIT' });
});

test('PNG type and the 20 MB screenshot limit are checked before any HTTP request', async (t) => {
  const mock = await mockServer(t, (_req, res) => respond(res, responsesResult()));
  const wrongType = path.join(directory, 'not-a-png.png');
  const oversized = path.join(directory, 'oversized.png');
  await writeFile(wrongType, 'ordinary text');
  const handle = await open(oversized, 'w');
  try { await handle.truncate(20 * 1024 * 1024 + 1); } finally { await handle.close(); }
  for (const screenshotPath of [wrongType, oversized, path.join(directory, 'missing-private-file.png')]) {
    await assert.rejects(requestDecision(options(mock.baseUrl, {}, { screenshotPath })), (error) => {
      assert.equal(error.code, 'MODEL_INPUT');
      return checkPrivateError(error, screenshotPath);
    });
  }
  assert.equal(mock.calls.length, 0);
});

test('cancellation stops a pending HTTP request and does not propagate the caller abort reason', async (t) => {
  let received;
  const started = new Promise(resolve => { received = resolve; });
  const mock = await mockServer(t, () => { received(); });
  const controller = new AbortController();
  const pending = requestDecision(options(mock.baseUrl, {}, { signal: controller.signal }));
  await started;
  controller.abort(new Error(`private abort detail ${KEY}`));
  await assert.rejects(pending, (error) => {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.code, 'MODEL_ABORTED');
    return checkPrivateError(error, 'private abort detail');
  });
  assert.equal(mock.calls.length, 1);
  await assert.rejects(requestDecision(options(mock.baseUrl, {}, { signal: controller.signal })), { name: 'AbortError', code: 'MODEL_ABORTED' });
  assert.equal(mock.calls.length, 1);
});

test('configured timeout covers a response body that starts but never completes', async (t) => {
  const mock = await mockServer(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"status":"completed","output":');
  });
  await assert.rejects(requestDecision(options(mock.baseUrl, { timeoutMs: 120 })), { code: 'MODEL_TIMEOUT' });
  assert.equal(mock.calls.length, 1);
});
