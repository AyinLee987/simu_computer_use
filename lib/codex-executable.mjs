import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const UNAVAILABLE_MESSAGE = '未找到可直接启动的 Codex，请检查安装或 CODEX_EXECUTABLE 设置。';

function unavailable() {
  const error = new Error(UNAVAILABLE_MESSAGE);
  error.code = 'MODEL_UNAVAILABLE';
  return error;
}

function envValue(env, name, platform) {
  if (env[name] !== undefined) return env[name];
  if (platform !== 'win32') return undefined;
  const key = Object.keys(env).find(key => key.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function unquote(value) {
  const text = value.trim();
  return text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;
}

function absoluteFolder(value) {
  if (typeof value !== 'string') return null;
  const folder = unquote(value);
  // In particular, an empty PATH component must never become the project cwd.
  return folder && path.isAbsolute(folder) ? folder : null;
}

async function fileInfo(filename) {
  try {
    const info = await stat(filename);
    return info.isFile() ? info : null;
  } catch { return null; }
}

async function npmEntry(wrapper) {
  const entry = path.join(path.dirname(wrapper), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (!(await fileInfo(entry))) return null;
  let file;
  try {
    file = await open(wrapper, 'r');
    if (!(await file.stat()).isFile()) return null;
    const buffer = Buffer.alloc(65_537);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 65_536) return null;
    const source = buffer.subarray(0, bytesRead).toString('utf8').replaceAll('\\', '/');
    return /@openai\/codex(?:\/|["'\s]|$)/i.test(source) ? entry : null;
  } catch { return null; }
  finally { await file?.close().catch(() => {}); }
}

async function candidateCommand(candidate, nodePath) {
  if (!(await fileInfo(candidate))) return null;
  if (/\.exe$/i.test(candidate)) return { command: candidate, prefix: [] };
  if (!/\.(cmd|bat)$/i.test(candidate)) return null;
  const entry = await npmEntry(candidate);
  return entry ? { command: nodePath, prefix: [entry] } : null;
}

async function inFolders(folders, requested, nodePath) {
  const suffixes = path.extname(requested) ? [''] : ['.exe', '.cmd', '.bat'];
  for (const folder of folders) {
    for (const suffix of suffixes) {
      const result = await candidateCommand(path.resolve(folder, `${requested}${suffix}`), nodePath);
      if (result) return result;
    }
  }
  return null;
}

async function desktopBundle(localAppData) {
  if (!localAppData) return null;
  const bin = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  const direct = path.join(bin, 'codex.exe');
  if (await fileInfo(direct)) return { command: direct, prefix: [] };
  let children;
  try { children = await readdir(bin, { withFileTypes: true }); }
  catch { return null; }
  const candidates = [];
  // Inspect only codex.exe in immediate version directories, never recurse into
  // user data, authentication files or other application directories.
  for (const child of children) {
    if (!child.isDirectory()) continue;
    const command = path.join(bin, child.name, 'codex.exe');
    const info = await fileInfo(command);
    if (info) candidates.push({ command, modified: info.mtimeMs });
  }
  candidates.sort((a, b) => b.modified - a.modified || a.command.localeCompare(b.command));
  return candidates.length ? { command: candidates[0].command, prefix: [] } : null;
}

export async function resolveCodexExecutable({ env = process.env, platform = process.platform, nodePath = process.execPath } = {}) {
  try {
    const setting = envValue(env, 'CODEX_EXECUTABLE', platform);
    if (setting != null && typeof setting !== 'string') throw unavailable();
    const requested = typeof setting === 'string' ? unquote(setting) : '';
    if (/[\x00-\x1f\x7f]/.test(requested)) throw unavailable();
    if (platform !== 'win32') return { command: requested || 'codex', prefix: [] };

    const rawPath = envValue(env, 'PATH', platform);
    const folders = typeof rawPath === 'string' ? rawPath.split(';').map(absoluteFolder).filter(Boolean) : [];
    if (requested) {
      const hasDirectory = requested.includes('/') || requested.includes('\\');
      const result = hasDirectory
        ? await inFolders([path.dirname(path.resolve(requested))], path.basename(requested), nodePath)
        : await inFolders(folders, requested, nodePath);
      if (!result) throw unavailable();
      return result;
    }

    const onPath = await inFolders(folders, 'codex', nodePath);
    if (onPath) return onPath;
    const roaming = absoluteFolder(envValue(env, 'APPDATA', platform));
    if (roaming) {
      const npm = await inFolders([path.join(roaming, 'npm')], 'codex', nodePath);
      if (npm) return npm;
    }
    const bundled = await desktopBundle(absoluteFolder(envValue(env, 'LOCALAPPDATA', platform)));
    if (bundled) return bundled;
    throw unavailable();
  } catch {
    // Never surface filesystem paths, environment contents or raw errors.
    throw unavailable();
  }
}
