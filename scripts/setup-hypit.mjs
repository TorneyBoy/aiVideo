import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const upstream = JSON.parse(await readFile(new URL('../integrations/UPSTREAM.json', import.meta.url), 'utf8'));
const cwd = fileURLToPath(new URL('../vendor/hypit', import.meta.url));
const env = { ...process.env, PUPPETEER_SKIP_DOWNLOAD: 'true' };
// The pinned lockfile owns all upstream versions. Skip browser downloads and install scripts.
const windows = process.platform === 'win32';
const child = spawn(windows ? 'cmd.exe' : 'pnpm', windows
  ? ['/d', '/s', '/c', 'pnpm.cmd install --frozen-lockfile --ignore-scripts']
  : ['install', '--frozen-lockfile', '--ignore-scripts'], { cwd, env, stdio: 'inherit', windowsHide: true, shell: false });
child.on('error', error => { console.error(`Hypit 安装失败：${error.message}。请先安装 pnpm。`); process.exitCode = 1; });
child.on('close', code => { process.exitCode = code || 0; if (code === 0) console.log(`Hypit ${upstream.version} 固定源码依赖已准备好；没有调用模型服务。`); });
