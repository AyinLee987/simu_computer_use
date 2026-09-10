import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { resolveCodexExecutable } from '../lib/codex-executable.mjs';

// Only fixture files are inspected. Fake executables/wrappers are never run;
// env is always supplied explicitly, with no dotenv or credential imports.
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-executable-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { PATH: '', APPDATA: path.join(root, 'Roaming'), LOCALAPPDATA: path.join(root, 'Local') };
  const put = async (filename, contents = 'fake executable; never execute') => {
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, contents);
    return filename;
  };
  const exe = (folder, name = 'codex.exe') => put(path.join(folder, name));
  const wrapper = async (folder, extension = 'cmd', contents = '@echo off\nnode "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*') => {
    const command = await put(path.join(folder, `codex.${extension}`), contents);
    const entry = await put(path.join(folder, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), '// fake entry; never execute');
    return { command, entry };
  };
  const resolve = (overrides = {}) => resolveCodexExecutable({ env, platform: 'win32', nodePath: path.join(root, '中文 Node Runtime', 'node.exe'), ...overrides });
  return { root, env, put, exe, wrapper, resolve, bundle: path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin') };
}

function unavailable(error, privateValue = '') {
  assert.equal(error.code, 'MODEL_UNAVAILABLE');
  assert.equal(error.message, '未找到可直接启动的 Codex，请检查安装或 CODEX_EXECUTABLE 设置。');
  if (privateValue) assert.equal(error.message.includes(privateValue), false);
  return true;
}

test('PATH directory order wins over roaming npm and the desktop bundle', async t => {
  const f = await fixture(t);
  const first = path.join(f.root, 'first path');
  const second = path.join(f.root, 'second path');
  const expected = await f.exe(first);
  await f.exe(second);
  await f.wrapper(path.join(f.env.APPDATA, 'npm'));
  await f.exe(path.join(f.bundle, 'version-new'));
  f.env.PATH = `${first};${second}`;
  assert.deepEqual(await f.resolve(), { command: expected, prefix: [] });
});

test('native exe precedes an npm wrapper in the same PATH directory', async t => {
  const f = await fixture(t);
  const folder = path.join(f.root, 'tools');
  await f.wrapper(folder);
  const expected = await f.exe(folder);
  f.env.PATH = folder;
  assert.deepEqual(await f.resolve(), { command: expected, prefix: [] });
});

test('known PATH npm wrappers become Node plus a single JS argument with Chinese and spaces', async t => {
  const f = await fixture(t);
  const folder = path.join(f.root, '中文 用户 npm & tools');
  const { entry } = await f.wrapper(folder);
  const nodePath = path.join(f.root, '中文 Node Runtime', 'node.exe');
  f.env.PATH = `;  ;"${folder}";;`;
  assert.deepEqual(await f.resolve({ nodePath }), { command: nodePath, prefix: [entry] });
});

test('APPDATA npm is used before desktop fallback when PATH has no Codex', async t => {
  const f = await fixture(t);
  const { entry } = await f.wrapper(path.join(f.env.APPDATA, 'npm'), 'bat');
  await f.exe(path.join(f.bundle, 'version'));
  const result = await f.resolve();
  assert.deepEqual(result.prefix, [entry]);
  assert.match(result.command, /node\.exe$/);
});

test('desktop fallback supports a direct codex.exe before its version directories', async t => {
  const f = await fixture(t);
  const direct = await f.exe(f.bundle);
  const version = await f.exe(path.join(f.bundle, 'version'));
  await utimes(direct, new Date('2020-01-01'), new Date('2020-01-01'));
  await utimes(version, new Date('2030-01-01'), new Date('2030-01-01'));
  assert.deepEqual(await f.resolve(), { command: direct, prefix: [] });
});

test('version fallback chooses the newest executable file mtime, not directory name or directory mtime', async t => {
  const f = await fixture(t);
  const old = await f.exe(path.join(f.bundle, 'zzz-lexically-new'));
  const recent = await f.exe(path.join(f.bundle, 'aaa-lexically-old'));
  await utimes(old, new Date('2020-01-01'), new Date('2020-01-01'));
  await utimes(recent, new Date('2025-01-01'), new Date('2025-01-01'));
  await utimes(path.dirname(old), new Date('2030-01-01'), new Date('2030-01-01'));
  assert.deepEqual(await f.resolve(), { command: recent, prefix: [] });
});

test('desktop discovery never descends beyond one version level or inspects other app directories', async t => {
  const f = await fixture(t);
  await f.exe(path.join(f.bundle, 'version', 'deeper'));
  await f.exe(path.join(f.env.LOCALAPPDATA, 'OtherApp'));
  await mkdir(path.join(f.bundle, 'invalid-version', 'codex.exe'), { recursive: true });
  await assert.rejects(f.resolve(), error => unavailable(error, f.root));
});

test('explicit invalid path, bare command or unsupported wrapper never falls back', async t => {
  const f = await fixture(t);
  await f.exe(path.join(f.bundle, 'valid-bundle'));
  const invalidWrapper = await f.put(path.join(f.root, 'private wrapper.cmd'), '@echo private unrelated command');
  for (const requested of [path.join(f.root, 'private-missing.exe'), 'missing-private-command', invalidWrapper, 'codex']) {
    await assert.rejects(f.resolve({ env: { ...f.env, CODEX_EXECUTABLE: requested } }), error => unavailable(error, requested));
  }
});

test('explicit native paths and named PATH commands are respected exactly', async t => {
  const f = await fixture(t);
  const folder = path.join(f.root, '自定义 Codex');
  const custom = await f.exe(folder, 'my-codex.exe');
  await f.exe(path.join(f.bundle, 'bundle'));
  assert.deepEqual(await f.resolve({ env: { ...f.env, CODEX_EXECUTABLE: custom } }), { command: custom, prefix: [] });
  assert.deepEqual(await f.resolve({ env: { ...f.env, PATH: folder, CODEX_EXECUTABLE: 'my-codex' } }), { command: custom, prefix: [] });
});

test('explicit known npm wrapper is translated without cmd.exe or shell interpolation', async t => {
  const f = await fixture(t);
  const { command, entry } = await f.wrapper(path.join(f.root, '显式 wrapper & space'));
  const result = await f.resolve({ env: { ...f.env, CODEX_EXECUTABLE: command } });
  assert.deepEqual(result.prefix, [entry]);
  assert.equal(result.command.includes('cmd.exe'), false);
  assert.equal(result.prefix.length, 1);
});

test('unknown, incomplete and oversized wrappers are skipped rather than executed', async t => {
  const f = await fixture(t);
  const wrong = path.join(f.root, 'wrong-wrapper');
  const incomplete = path.join(f.root, 'incomplete-wrapper');
  const oversized = path.join(f.root, 'oversized-wrapper');
  await f.wrapper(wrong, 'cmd', '@echo off\nrem @openai/unrelated codex');
  await f.put(path.join(incomplete, 'codex.cmd'), 'node node_modules/@openai/codex/bin/codex.js');
  await f.wrapper(oversized, 'cmd', '@openai/codex/bin/codex.js\n' + 'x'.repeat(65_536));
  const expected = await f.exe(path.join(f.bundle, 'fallback'));
  f.env.PATH = [wrong, incomplete, oversized].join(';');
  assert.deepEqual(await f.resolve(), { command: expected, prefix: [] });
});

test('empty and relative PATH/app-data entries never imply a current-directory candidate', async t => {
  const f = await fixture(t);
  const env = { PATH: '; ;.;;relative-tools;', APPDATA: '.', LOCALAPPDATA: '' };
  await assert.rejects(f.resolve({ env }), error => unavailable(error));
});

test('Windows environment names are case-insensitive without consulting the real environment', async t => {
  const f = await fixture(t);
  const expected = await f.exe(path.join(f.bundle, 'installed-version'));
  assert.deepEqual(await f.resolve({ env: { Path: '', AppData: f.env.APPDATA, LocalAppData: f.env.LOCALAPPDATA } }), { command: expected, prefix: [] });
});

test('POSIX preserves command semantics and does not search Windows application folders', async () => {
  assert.deepEqual(await resolveCodexExecutable({ env: {}, platform: 'linux', nodePath: '/unused-node' }), { command: 'codex', prefix: [] });
  assert.deepEqual(await resolveCodexExecutable({ env: { CODEX_EXECUTABLE: '/explicit codex/bin/codex' }, platform: 'darwin', nodePath: '/unused-node' }), { command: '/explicit codex/bin/codex', prefix: [] });
});
