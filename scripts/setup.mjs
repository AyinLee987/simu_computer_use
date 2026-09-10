import { randomBytes } from 'node:crypto';
import { open, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const configPath = fileURLToPath(new URL('../dockercompose.env', import.meta.url));
try {
  const template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  const file = await open(new URL('../.env', import.meta.url), 'wx', 0o600);
  try { await file.writeFile(template); }
  finally { await file.close(); }
  console.log('已创建 .env：可填写 API Key，或保持为空继续使用 Codex 登录。');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('沿用已有 .env，不覆盖你的模型配置。');
}
try {
  const file = await open(configPath, 'wx', 0o600);
  try { await file.writeFile(`DEMO_CONTROL_TOKEN=${randomBytes(32).toString('hex')}\n`); }
  finally { await file.close(); }
  console.log('已创建本机容器控制凭据。');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('沿用已有本机容器控制凭据。');
}
await mkdir(new URL('../runs/', import.meta.url), { recursive: true });
