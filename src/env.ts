import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

/** Load local secrets without printing values or replacing inherited environment variables. */
export function loadLocalEnvironment(path = process.env.AIVIDEO_ENV_FILE || fileURLToPath(new URL('../.env', import.meta.url))): void {
  try { loadEnvFile(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取本机 .env 配置文件，请检查格式和文件权限');
  }
}
