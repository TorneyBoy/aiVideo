import { createWriteStream } from 'node:fs';
import { rename } from 'node:fs/promises';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export function secret(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`请在 .env 中填写 ${name}`);
  return value;
}

export function safeMessage(input: unknown): string {
  let message = String(input || '服务返回错误');
  for (const [name, value] of Object.entries(process.env)) {
    if (/KEY|TOKEN|SECRET/i.test(name) && value && value.length >= 6) message = message.split(value).join('[已隐藏]');
  }
  return message.replace(/https?:\/\/[^\s"<>]+/g, '[素材地址]').replace(/data:[^\s"]+/g, '[素材数据]').slice(0, 300);
}

export class CloudHttpError extends Error {
  status: number;
  constructor(service: string, status: number, message: unknown) {
    super(`${service} HTTP ${status}：${safeMessage(message)}`); this.status = status;
  }
}

export async function cloudFetch(url: string, init: RequestInit, service: string, timeoutMs = 60000): Promise<Response> {
  try {
    const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as any;
      throw new CloudHttpError(service, response.status, body.error?.message || body.message || response.statusText);
    }
    return response;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(service)) throw error;
    throw new Error(`${service} 请求中断或超时；如已提交远程任务，继续处理时将先查询回执`);
  }
}

export async function cloudJson(url: string, init: RequestInit, service: string): Promise<any> {
  const response = await cloudFetch(url, init, service);
  try { return await response.json(); }
  catch { throw new Error(`${service} 返回了无法解析的结果`); }
}

export async function download(url: string, output: string, maxBytes = 512 * 1024 * 1024): Promise<void> {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('模型返回了无效的下载地址');
  let response: Response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(300000) }); }
  catch { throw new Error('成片下载中断，继续处理可重新获取下载地址'); }
  if (!response.ok || !response.body) throw new Error(`成片下载失败：HTTP ${response.status}`);
  let size = 0;
  const limit = new Transform({ transform(chunk, _encoding, callback) {
    size += chunk.length;
    callback(size > maxBytes ? new Error('模型输出超过下载大小限制') : null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body as any), limit, createWriteStream(`${output}.tmp`));
  await rename(`${output}.tmp`, output);
}
