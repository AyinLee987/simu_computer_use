import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF7sAAAAASUVORK5CYII=', 'base64');
const moduleUrl = new URL('../lib/model.mjs', import.meta.url).href;
const secret = 'test-only-not-a-real-api-key';
const observation = { width: 1000, height: 720,
  controls: [{ id: 'snapshot-1:field', role: 'text', name: '姓名', value: '旧值', enabled: true, actions: ['type'], checked: false }],
  accessibility: { status: 'ready', source: 'at-spi', message: '部分控件树', truncated: true },
  text: 'Only screenshot and public accessibility data are available.' };
const valid = { summary: '已观察到完成结果。', actions: [], done: true, success: true };

async function childResult(code, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, ...env }, cwd: tmpdir(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    const timer = setTimeout(() => child.kill(), 15000);
    child.on('error', reject);
    child.on('close', status => { clearTimeout(timer); resolve({ status, out, err }); });
  });
}

for (const apiStyle of ['responses', 'chat_completions']) {
  test(`model dispatch uses ${apiStyle} without a Codex executable and validates returned actions`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'agent-model-api-'));
    const screenshotPath = path.join(directory, 'screen.png');
    await writeFile(screenshotPath, PNG);
    let calls = 0;
    const received = [];
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      received.push({ url: req.url, key: req.headers.authorization, body });
      calls++;
      const decision = calls === 1 ? valid : { ...valid, actions: [{ type: 'shell', command: 'not allowed' }], done: false, success: false };
      const text = JSON.stringify(decision);
      const data = apiStyle === 'responses'
        ? { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] }
        : { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const env = { MODEL_PROVIDER: 'openai', OPENAI_API_KEY: secret, OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, OPENAI_MODEL: 'mock-vision-model', OPENAI_API_STYLE: apiStyle, OPENAI_RESPONSE_FORMAT: 'json_schema', CODEX_EXECUTABLE: path.join(directory, 'codex-does-not-exist') };
      const code = `import {decide,checkModelConnection} from ${JSON.stringify(moduleUrl)};
        const status=await checkModelConnection();
        const result=await decide(${JSON.stringify({ goal: '核对画面是否完成', observation, screenshotPath })});
        let rejected;
        try {await decide(${JSON.stringify({ goal: '核对画面是否完成', observation, screenshotPath })});} catch(error) {rejected=error.code;}
        process.stdout.write(JSON.stringify({status,result,rejected}));`;
      const child = await childResult(code, env);
      assert.equal(child.status, 0, child.err);
      const output = JSON.parse(child.out);
      assert.equal(output.status.ok, true);
      assert.equal(output.status.verified, false);
      assert.equal(output.status.provider, 'openai');
      assert.ok(!child.out.includes(secret));
      assert.deepEqual(output.result, valid);
      assert.equal(output.rejected, 'MODEL_FORMAT');
      assert.equal(calls, 2, 'configuration checks must not make paid/network model calls');
      for (const request of received) {
        assert.equal(request.key, `Bearer ${secret}`);
        assert.equal(request.url, `/v1/${apiStyle === 'responses' ? 'responses' : 'chat/completions'}`);
        assert.equal(request.body.model, 'mock-vision-model');
        assert.equal(request.body.tools, undefined);
        const content = apiStyle === 'responses' ? request.body.input[0].content : request.body.messages[1].content;
        const image = apiStyle === 'responses' ? content[1].image_url : content[1].image_url.url;
        assert.equal(image, `data:image/png;base64,${PNG.toString('base64')}`);
        assert.match(content[0].text, /"actions":\["type"\]/);
        assert.match(content[0].text, /"enabled":true/);
        assert.match(content[0].text, /"source":"at-spi"/);
        assert.match(content[0].text, /"truncated":true/);
        const instructions = apiStyle === 'responses' ? request.body.instructions : request.body.messages[0].content;
        assert.match(instructions, /不可信的数据/);
        assert.match(instructions, /替换该输入框的全部内容/);
        assert.match(instructions, /actions 必须只有一项/);
        assert.match(instructions, /未声明 type 但声明了 click.*click target 聚焦（独立一轮）/);
        assert.match(instructions, /重新观察并确认焦点后.*ControlOrMeta\+A 全选.*target=null 的 type/);
        assert.match(instructions, /执行器不会在语义动作失败后自动改用键盘或坐标/);
      }
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  });
}
