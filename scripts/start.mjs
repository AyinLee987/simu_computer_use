import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import * as util from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { assertNodeVersion, parsePort, projectIdentity, probeConsole, desktopStatus, assertPortAvailable, acquireStartupLock, safeChildEnvironment, assertLocalDockerEndpoint } from '../lib/launcher.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(new URL('../package.json', import.meta.url));
const controller = new AbortController();
const interrupted = () => controller.abort();

// Do not load .env into dependency/Docker subprocesses. The server loads it
// later, and only the PORT field is needed by the launcher.
async function consolePort() {
  let config = {};
  try { config = util.parseEnv(await readFile(path.join(ROOT, '.env'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取项目 .env，请检查文件格式和权限。'); }
  return parsePort(process.env.PORT ?? config.PORT);
}

async function terminateChild(child, tree) {
  if (!child.pid) return;
  await new Promise(resolve => {
    const done = () => { clearTimeout(timer); child.removeListener('close', done); child.stdout?.destroy(); child.unref(); resolve(); };
    const timer = setTimeout(done, 3000);
    child.once('close', done);
    if (child.exitCode !== null || child.signalCode !== null) { done(); return; }
    if (process.platform === 'win32' && tree) {
      // Only this launcher's live child tree, never a port owner or all Node
      // processes. Docker Desktop startup opts out so its engine is retained.
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore', env: safeChildEnvironment() });
      killer.once('error', () => child.kill());
      killer.once('exit', code => { if (code !== 0) child.kill(); });
      killer.unref();
    } else {
      try { if (tree) process.kill(-child.pid, 'SIGKILL'); else child.kill(); }
      catch { child.kill(); }
    }
  });
}

function run(command, args, { stream = false, timeout = 30000, tree = true } = {}) {
  controller.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let stdout = '';
    let finished = false;
    const child = spawn(command, args, {
      cwd: ROOT, shell: false, windowsHide: true, env: safeChildEnvironment(),
      detached: process.platform !== 'win32' && tree,
      stdio: ['ignore', stream ? 'inherit' : 'pipe', stream ? 'inherit' : 'ignore'],
    });
    const cleanup = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); };
    const cancel = async message => {
      if (finished) return;
      finished = true;
      cleanup();
      await terminateChild(child, tree);
      reject(new Error(message));
    };
    const abort = () => { void cancel('已取消启动。'); };
    const timer = setTimeout(() => { void cancel('此启动步骤超时。请检查网络或 Docker 状态后重试。'); }, timeout);
    controller.signal.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-65536); });
    child.once('error', error => { if (finished) return; finished = true; cleanup(); reject(error); });
    child.once('close', code => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve({ code, stdout: stdout.trim() });
    });
  });
}

async function dependencies() {
  const lock = JSON.parse(await readFile(path.join(ROOT, 'package-lock.json'), 'utf8'));
  let installed = false;
  try {
    require('playwright');
    installed = true;
    for (const name of ['playwright', 'playwright-core']) {
      const actual = JSON.parse(await readFile(require.resolve(`${name}/package.json`), 'utf8'));
      installed &&= actual.version === lock.packages[`node_modules/${name}`].version;
    }
  } catch { installed = false; /* A partial install is not ready. */ }
  if (installed) { console.log('依赖已就绪。'); return; }
  console.log('安装项目锁定版本的依赖（首次运行需要联网）…');
  let command = 'npm';
  let args = ['ci'];
  if (process.platform === 'win32') {
    // npm.cmd cannot safely be spawned without a shell. Invoke its JS entry
    // with Node and separate arguments, including when the path has spaces.
    const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')];
    for (const dir of (process.env.PATH || '').split(path.delimiter)) candidates.push(path.join(dir, 'node_modules/npm/bin/npm-cli.js'));
    let npmCli;
    for (const candidate of candidates) {
      if (!candidate || !/npm-cli\.js$/i.test(candidate)) continue;
      try { await access(candidate); npmCli = candidate; break; } catch { /* Try the next installed npm location. */ }
    }
    if (!npmCli) throw new Error('找不到 npm。请安装包含 npm 的 Node.js 22 或更新版本。');
    command = process.execPath;
    args = [npmCli, 'ci'];
  }
  if ((await run(command, args, { stream: true, timeout: 600000 })).code !== 0) throw new Error('依赖安装失败，请检查网络和 npm 安装。');
}

async function dockerReady() {
  let version;
  try { version = await run('docker', ['--version'], { timeout: 10000 }); }
  catch { throw new Error('找不到可用的 Docker。请安装 Docker Desktop，然后重新打开启动脚本。'); }
  if (version.code !== 0) throw new Error('Docker 命令不可用，请检查 Docker Desktop 安装。');
  if (process.env.DOCKER_HOST) assertLocalDockerEndpoint(process.env.DOCKER_HOST);
  const context = await run('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { timeout: 10000 });
  if (context.code !== 0) throw new Error('无法读取当前 Docker context，请确认本机 Docker 配置。');
  assertLocalDockerEndpoint(context.stdout);
  if ((await run('docker', ['compose', 'version'], { timeout: 15000 })).code !== 0) throw new Error('缺少 Docker Compose v2 或更新版本，请更新 Docker Desktop。');
  let info = await run('docker', ['info', '--format', '{{.OSType}}'], { timeout: 15000 });
  if (info.code !== 0) {
    console.log('Docker 引擎未运行，正在尝试启动 Docker Desktop…');
    try {
      if ((await run('docker', ['desktop', 'start'], { timeout: 60000, tree: false })).code !== 0) console.log('请手动打开 Docker Desktop；脚本会继续等待引擎。');
    }
    catch (error) { controller.signal.throwIfAborted(); console.log('请手动打开 Docker Desktop；脚本会继续等待引擎。'); }
    const deadline = Date.now() + 120000;
    while (info.code !== 0 && Date.now() < deadline) {
      console.log('等待 Docker 引擎就绪…');
      await delay(3000, undefined, { signal: controller.signal });
      info = await run('docker', ['info', '--format', '{{.OSType}}'], { timeout: 15000 });
    }
    if (info.code !== 0) throw new Error('等待 Docker 引擎超时。请手动打开 Docker Desktop，确认引擎运行后重试。');
  }
  if (info.stdout !== 'linux') throw new Error('此桌面镜像需要 Linux 容器。请在 Docker Desktop 中切换到 Linux containers 后重试。');
  console.log('构建并启动 Docker 桌面（首次下载镜像可能需要几分钟）…');
  if ((await run('docker', ['compose', 'up', '-d', '--build'], { stream: true, timeout: 900000 })).code !== 0) {
    throw new Error('容器启动失败。请检查上方构建结果、网络以及 6080 / 8000 端口是否被占用。');
  }
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const result = await run('docker', ['compose', 'ps', '--all', '--format', 'json'], { timeout: 15000 });
    if (result.code !== 0) throw new Error('无法读取容器状态，请检查 Docker Desktop。');
    let status;
    try { status = desktopStatus(result.stdout); }
    catch { throw new Error('无法解析 Compose 状态，请更新 Docker Compose。'); }
    if (status.ready) { console.log('容器桌面已通过健康检查。'); return; }
    if (status.failed) throw new Error('桌面容器已退出或健康检查失败。请运行 docker compose logs --tail=80 desktop 查看原因。');
    console.log('等待容器桌面健康检查…');
    await delay(3000, undefined, { signal: controller.signal });
  }
  throw new Error('等待容器桌面超时。请运行 docker compose ps 和 docker compose logs --tail=80 desktop 检查状态。');
}

async function openBrowser(origin) {
  if (process.argv.includes('--no-open')) return;
  const [command, args] = process.platform === 'win32'
    ? ['rundll32.exe', ['url.dll,FileProtocolHandler', origin]]
    : process.platform === 'darwin' ? ['open', [origin]] : ['xdg-open', [origin]];
  try {
    // A failed browser opener must not shut down an otherwise ready server.
    const child = spawn(command, args, { shell: false, windowsHide: true, detached: true, stdio: 'ignore', env: safeChildEnvironment() });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } catch { console.log(`无法自动打开浏览器，请手动访问 ${origin}`); }
}

async function reuseOrCheck(origin, projectId) {
  const status = await probeConsole(origin, projectId);
  if (status.kind === 'same') {
    console.log(`控制台已运行，直接复用：${origin}`);
    console.log('不会重建桌面或中断任务；如修改了 .env，请先停止旧控制台再启动。');
    await openBrowser(origin);
    return true;
  }
  if (status.kind !== 'unreachable') throw new Error(`端口已被其他项目、旧版控制台或未知服务占用：${origin}。请先手动停止原服务，或修改 .env 中的 PORT；不会自动关闭它。`);
  await assertPortAvailable(Number(new URL(origin).port || 80));
  return false;
}

async function main() {
  assertNodeVersion(process.versions.node);
  if (process.argv.includes('--help')) {
    console.log('用法：npm run launch [-- --no-open]\n或：node scripts/start.mjs [--no-open]\n检查依赖、准备配置、启动 Docker 桌面并打开控制台。--no-open 禁止自动打开浏览器。\n保持启动终端运行；Ctrl+C 停止控制台，不关闭桌面容器。');
    return;
  }
  if (process.argv.slice(2).some(arg => arg !== '--no-open')) throw new Error('不支持的启动参数。请使用 --help 查看用法。');
  process.chdir(ROOT);
  const port = await consolePort();
  const origin = new URL(`http://127.0.0.1:${port}`).origin;
  const projectId = projectIdentity(ROOT);
  if (await reuseOrCheck(origin, projectId)) return;
  const lock = await acquireStartupLock(ROOT, port);
  if (!lock.acquired) {
    if ((await probeConsole(origin, projectId)).kind === 'same') { await reuseOrCheck(origin, projectId); return; }
    throw new Error(`另一个启动过程可能正在准备此项目，或本机启动锁端口 ${lock.lockPort} 被占用。请稍后重试；不会停止任何现有进程。`);
  }
  process.on('SIGINT', interrupted);
  process.on('SIGTERM', interrupted);
  try {
    if (await reuseOrCheck(origin, projectId)) return;
    await dependencies();
    if ((await run(process.execPath, [path.join(ROOT, 'scripts/setup.mjs')], { stream: true })).code !== 0) throw new Error('准备本机配置失败，请检查文件权限。');
    await dockerReady();
    controller.signal.throwIfAborted();
    // Re-check after the potentially long build; never replace a new occupant.
    if (await reuseOrCheck(origin, projectId)) return;
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
    // Keep the chosen port stable if .env is edited during a long build.
    process.env.PORT = String(port);
    // Keep the console in this process so Ctrl+C uses the server's graceful
    // task cancellation, rather than forcibly killing a detached Node child.
    const { shutdown } = await import('../server.mjs');
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if ((await probeConsole(origin, projectId)).kind === 'same') {
        console.log(`启动完成：${origin}\n保持此终端运行；Ctrl+C 停止控制台。容器可用 npm run desktop:stop 单独停止。`);
        await lock.release();
        await openBrowser(origin);
        return;
      }
      if (process.exitCode) break;
      await delay(250);
    }
    await shutdown();
    throw new Error('控制台未能就绪，请检查上方信息。桌面容器保留，不会自动删除。');
  } finally {
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
    await lock.release();
  }
}

main().catch(error => {
  console.error(`\n启动未完成：${controller.signal.aborted ? '已取消启动。' : error.message}`);
  console.error('没有自动关闭其他服务，也没有删除配置或运行记录。');
  process.exitCode = 1;
});
