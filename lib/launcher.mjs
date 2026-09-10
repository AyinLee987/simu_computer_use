import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function safeChildEnvironment(source = process.env) {
  const env = { ...source };
  for (const name of Object.keys(env)) {
    if (/^(OPENAI_|CODEX_API_KEY$|DEMO_CONTROL_TOKEN$)/i.test(name)) delete env[name];
  }
  return env;
}

export function assertLocalDockerEndpoint(endpoint) {
  // Be conservative: this app talks to ports on the host, not a remote Docker
  // machine. Named pipes must name the local machine, not a network share.
  if (/^unix:\/\/\//.test(endpoint) || /^npipe:\/\/\/\/\.\/pipe\//i.test(endpoint)) return;
  try {
    const url = new URL(endpoint);
    if (url.protocol === 'tcp:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password && !url.search && !url.hash) return;
  } catch { /* Only known local transports are allowed. */ }
  throw new Error('当前 Docker 连接不是可确认的本机引擎。本 demo 不支持远程 Docker；请切换到本机 context，并检查 DOCKER_HOST / DOCKER_CONTEXT 后重试。');
}

export function assertNodeVersion(version) {
  const match = /^v?(\d+)\.\d+\.\d+(?:[-+].*)?$/.exec(String(version));
  if (!match || Number(match[1]) < 22) throw new Error('需要 Node.js 22 或更新版本（包含 npm），请更新后重试。');
  return Number(match[1]);
}

export function parsePort(value) {
  if (value === undefined || value === '') return 4317;
  if (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error('PORT 必须是 1 到 65535 之间的整数。请检查 .env 或终端环境变量。');
  }
  return Number(value);
}

export function projectIdentity(root) {
  const resolved = path.resolve(root);
  return createHash('sha256').update(process.platform === 'win32' ? resolved.toLowerCase() : resolved).digest('hex');
}

export function classifyConsole(payload, expectedId) {
  if (!payload || Array.isArray(payload) || payload.app !== 'browser-agent-demo' || typeof payload.projectId !== 'string' || !payload.projectId) return 'unknown';
  return payload.projectId === expectedId ? 'same' : 'other';
}

// Identity is for accidental port collisions, not authentication. No secrets
// are sent, redirects are not followed, and response size/time are bounded.
export function probeConsole(origin, expectedId) {
  const url = new URL('/api/health', origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) {
    throw new Error('启动检查只允许本机回环地址。');
  }
  return new Promise(resolve => {
    let answered = false;
    let connected = false;
    let timer;
    const finish = kind => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      resolve({ kind });
    };
    const request = http.get(url, { agent: false }, response => {
      connected = true;
      if (response.statusCode !== 200) { finish('unknown'); response.destroy(); return; }
      let size = 0;
      const chunks = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 4096) { finish('unknown'); response.destroy(); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try { finish(classifyConsole(JSON.parse(Buffer.concat(chunks).toString('utf8')), expectedId)); }
        catch { finish('unknown'); }
      });
      response.on('error', () => finish('unknown'));
    });
    request.on('socket', socket => socket.once('connect', () => { connected = true; }));
    request.on('error', () => finish(connected ? 'unknown' : 'unreachable'));
    timer = setTimeout(() => { finish(connected ? 'unknown' : 'unreachable'); request.destroy(); }, 1500);
  });
}

export function desktopStatus(output) {
  const text = output.trim();
  if (!text) return { ready: false, failed: false };
  let rows;
  try { const parsed = JSON.parse(text); rows = Array.isArray(parsed) ? parsed : [parsed]; }
  catch { rows = text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
  const desktops = rows.filter(row => row?.Service === 'desktop');
  return {
    ready: desktops.length > 0 && desktops.every(row => row.State === 'running' && row.Health === 'healthy'),
    failed: desktops.some(row => ['exited', 'dead', 'removing'].includes(row.State) || row.Health === 'unhealthy'),
  };
}

async function listenLocal(port) {
  const server = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    const onError = error => reject(error);
    server.once('error', onError);
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
  return server;
}

export async function assertPortAvailable(port) {
  let server;
  try { server = await listenLocal(port); }
  catch { throw new Error(`端口 ${port} 已被占用或不可用。请先停止原服务，或修改 .env 中的 PORT。不会自动关闭其他程序。`); }
  await new Promise(resolve => server.close(resolve));
}

// The OS releases this loopback mutex on process exit; no stale lock files.
export async function acquireStartupLock(root, port) {
  const digest = createHash('sha256').update(`${projectIdentity(root)}:${port}`).digest();
  let lockPort = 20000 + digest.readUInt32BE(0) % 30000;
  if (lockPort === port) lockPort = lockPort === 49999 ? 20000 : lockPort + 1;
  let server;
  try { server = await listenLocal(lockPort); }
  catch (error) {
    if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error;
    return { acquired: false, lockPort, release: async () => {} };
  }
  let releasing;
  return {
    acquired: true, lockPort,
    release: () => releasing ??= new Promise(resolve => server.close(resolve)),
  };
}
