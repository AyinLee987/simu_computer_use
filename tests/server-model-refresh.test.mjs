import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

// An isolated host with fake desktop and model modules: no Docker, login,
// credentials, screenshots or model APIs are touched by this integration test.
test('model refresh cannot change a starting or running task and succeeds again when idle', { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-refresh-test-'));
  let child;
  let closed;
  try {
    await mkdir(path.join(root, 'lib'));
    await writeFile(path.join(root, 'server.mjs'), await readFile(new URL('../server.mjs', import.meta.url)));
    for (const filename of ['env.mjs', 'launcher.mjs']) await writeFile(path.join(root, 'lib', filename), await readFile(new URL(`../lib/${filename}`, import.meta.url)));
    await writeFile(path.join(root, 'lib', 'model.mjs'), `
      export async function checkModelConnection() { return {ok:true,provider:'codex',selection:'auto',authMethod:'chatgpt',verified:false,message:'mock ready',billingLabel:'mock'}; }
      export async function decide({signal}) { return new Promise((resolve,reject)=>{const stop=()=>reject(new Error('mock aborted'));if(signal.aborted)stop();else signal.addEventListener('abort',stop,{once:true});}); }
    `);
    await writeFile(path.join(root, 'lib', 'browser.mjs'), `
      import {writeFile} from 'node:fs/promises';
      import {setTimeout as delay} from 'node:timers/promises';
      let checks=0;
      export async function checkDesktop() { if(++checks===2){await writeFile(new URL('../starting-marker',import.meta.url),'starting');await delay(400);}return {ready:true,label:'mock desktop',desktopUrl:'about:blank'}; }
      export function targetFor(){return 'https://example.invalid/mock';}
      export class BrowserSession {async start(){} async observe(){return {screenshotPath:'mock.png',screenshotUrl:'/mock.png',observation:{width:1000,height:720,controls:[],text:'mock'}};} async stop(){} async close(){}}
    `);
    const portProbe = http.createServer();
    await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
    const port = portProbe.address().port;
    await new Promise(resolve => portProbe.close(resolve));
    child = spawn(process.execPath, [path.join(root, 'server.mjs')], { cwd: root, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, PORT: String(port) }, windowsHide: true, stdio: 'ignore' });
    closed = once(child, 'close');
    const origin = `http://127.0.0.1:${port}`;
    const status = async () => (await fetch(origin + '/api/status')).json();
    const post = route => fetch(origin + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'mock task', scenario: 'paint' }) });
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try { const s = await status(); if (s.model.ready && s.environment.ready) { ready = true; break; } } catch {}
      await delay(25);
    }
    assert.ok(ready, 'isolated host should start');
    const starting = post('/api/run');
    let marked = false;
    for (let i = 0; i < 40; i++) { try { await readFile(path.join(root, 'starting-marker')); marked = true; break; } catch {} await delay(10); }
    assert.ok(marked, 'task should reserve provider during desktop startup');
    assert.equal((await post('/api/model/refresh')).status, 409);
    assert.equal((await starting).status, 202);
    const active = await status();
    assert.equal(active.run.modelProvider, 'codex');
    assert.equal(active.run.modelAuthMethod, 'chatgpt');
    assert.equal((await post('/api/model/refresh')).status, 409);
    assert.equal((await post('/api/stop')).status, 200);
    let ended = false;
    for (let i = 0; i < 80; i++) { if ((await status()).run.endedAt) { ended = true; break; } await delay(25); }
    assert.ok(ended);
    const refreshed = await post('/api/model/refresh');
    assert.equal(refreshed.status, 200);
    assert.equal((await refreshed.json()).model.authMethod, 'chatgpt');
  } finally {
    if (child) { child.kill(); await closed; }
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('agent-refresh-test-'));
    await rm(root, { recursive: true, force: true });
  }
});
