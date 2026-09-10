import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

// Resolve relative to the project, not the shell's working directory. Node keeps
// existing process environment values ahead of entries in this optional file.
try { loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); }
catch (error) {
  if (error.code !== 'ENOENT') throw new Error('无法读取项目 .env，请检查文件权限与格式。');
}
