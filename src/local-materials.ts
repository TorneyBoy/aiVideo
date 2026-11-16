import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, statfs, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LocalMaterialConfig } from './schema.ts';
import { localMaterialConfigSchema } from './schema.ts';
import { hashFile, json } from './files.ts';
import { secret } from './cloud-http.ts';

const marker = 'aivideo.private-materials.v1\n';
const media: Record<string, string> = { 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'audio/wav': '.wav', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
const objectPattern = /^[a-f0-9]{64}\.(mp4|mov|wav|mp3|m4a|png|jpg|webp)$/;
type RecordData = { version: 1; id: string; mime: string; size: number; hash: string; expiresAt: number; retainUntil: number };
const nowSeconds = () => Math.floor(Date.now() / 1000);

async function regularFile(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('素材文件类型不安全');
  return info;
}

/** Refuse to adopt an existing unrelated directory; cleanup only ever visits owned flat files. */
async function storeRoot(config: LocalMaterialConfig) {
  localMaterialConfigSchema.parse(config);
  const root = resolve(config.directory);
  if (root === dirname(root) || root === resolve('.') || root === resolve('runs') || root === resolve('runs/jobs') || root === resolve('runs/voices')) throw new Error('素材目录必须使用独立子目录');
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== root) throw new Error('素材目录不能经过符号链接');
  const tag = join(root, '.aivideo-material-store');
  try { await regularFile(tag); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const entries = await readdir(root);
    if (!entries.includes('.aivideo-material-store') && entries.length) throw new Error('素材目录已有其他文件，拒绝接管');
    try { await writeFile(tag, marker, { flag: 'wx', mode: 0o600 }); }
    catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure; }
  }
  if (await readFile(tag, 'utf8') !== marker) throw new Error('素材目录归属标记不匹配');
  for (const name of ['objects', 'records', 'locks', 'tmp']) {
    const path = join(root, name); await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('素材子目录不安全');
  }
  return root;
}

function signingKey(config: LocalMaterialConfig) {
  const value = secret(config.signingKeyEnv);
  if (Buffer.byteLength(value) < 32) throw new Error('MATERIAL_SIGNING_KEY 至少需要 32 字节');
  return value;
}
function signature(config: LocalMaterialConfig, id: string, expires: number) {
  const base = new URL(config.publicBaseUrl), prefix = base.pathname.replace(/\/$/, '');
  return createHmac('sha256', signingKey(config)).update(`v1\n${base.origin}${prefix}\n/media/${id}\n${expires}`).digest('hex');
}
function validRecord(value: unknown, id: string): RecordData {
  const item = value as RecordData;
  if (!item || item.version !== 1 || item.id !== id || !objectPattern.test(id) || media[item.mime] !== '.' + id.split('.').at(-1)
    || !Number.isSafeInteger(item.size) || item.size < 1 || !/^[a-f0-9]{64}$/.test(item.hash)
    || !Number.isSafeInteger(item.expiresAt) || !Number.isSafeInteger(item.retainUntil) || item.retainUntil < item.expiresAt) throw new Error('素材记录无效');
  return item;
}
async function record(root: string, id: string) {
  const path = join(root, 'records', id + '.json'); await regularFile(path);
  return validRecord(JSON.parse(await readFile(path, 'utf8')), id);
}

/** Locks also coordinate Hypit child processes with the HTTP server's cleanup worker. */
async function locked<T>(root: string, id: string, work: () => Promise<T>, wait = true): Promise<T | undefined> {
  const path = join(root, 'locks', id + '.lock'), owner = randomUUID(), deadline = Date.now() + 30000;
  for (;;) {
    try { await writeFile(path, owner, { flag: 'wx', mode: 0o600 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try { if (Date.now() - (await regularFile(path)).mtimeMs > 3600000) { await unlink(path); continue; } }
      catch (failure) { if ((failure as NodeJS.ErrnoException).code === 'ENOENT') continue; throw failure; }
      if (!wait) return undefined;
      if (Date.now() > deadline) throw new Error('素材正在处理，请稍后重试');
      await delay(50);
    }
  }
  try { return await work(); }
  finally { if (await readFile(path, 'utf8').catch(() => '') === owner) await unlink(path).catch(() => {}); }
}

export async function publishLocalMaterial(config: LocalMaterialConfig, source: string, mime: string, scope: string): Promise<string> {
  signingKey(config);
  const extension = media[mime]; if (!extension) throw new Error('素材格式不支持');
  const info = await regularFile(source);
  if (!info.size || info.size > 512 * 1024 * 1024) throw new Error('素材大小需要在 1 字节至 512 MB 之间');
  const hash = await hashFile(source), root = await storeRoot(config);
  const id = createHash('sha256').update(`${scope}\n${hash}\n${mime}`).digest('hex') + extension;
  const expires = nowSeconds() + config.urlTtlSeconds;
  await locked(root, 'quota', () => locked(root, id, async () => {
    const object = join(root, 'objects', id);
    let saved: RecordData | undefined;
    try { saved = await record(root, id); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    let exists = false;
    try { const value = await regularFile(object); exists = value.size === info.size && await hashFile(object) === hash; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!exists) {
      let used = 0;
      for (const name of await readdir(join(root, 'objects'))) {
        try { used += (await regularFile(join(root, 'objects', name))).size; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      const disk = await statfs(root);
      if (used + info.size > config.maxStorageBytes) throw new Error('临时素材空间已达配额，请等待到期清理或调整 MATERIAL_MAX_BYTES');
      if (disk.bavail * disk.bsize - info.size < config.minDiskFreeBytes) throw new Error('服务器剩余磁盘空间不足，已停止保存临时素材');
      const temporary = join(root, 'tmp', `${id}.${randomUUID()}.part`);
      try {
        await copyFile(source, temporary, constants.COPYFILE_EXCL);
        if (await hashFile(temporary) !== hash) throw new Error('素材在上传过程中发生变化');
        await rename(temporary, object);
      } finally { await unlink(temporary).catch(() => {}); }
    }
    await json(join(root, 'records', id + '.json'), { version: 1, id, mime, size: info.size, hash,
      expiresAt: Math.max(expires, saved?.expiresAt || 0),
      retainUntil: Math.max(nowSeconds() + config.retentionSeconds, expires + 300, saved?.retainUntil || 0) } satisfies RecordData);
  }));
  const base = new URL(config.publicBaseUrl);
  const url = new URL(`${base.pathname.replace(/\/$/, '')}/media/${id}`, base.origin);
  url.searchParams.set('expires', String(expires)); url.searchParams.set('signature', signature(config, id, expires));
  return url.href;
}

/** Only signed GET/HEAD requests can reach temporary published copies; never the original jobs or voice library. */
export async function serveLocalMaterial(config: LocalMaterialConfig, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const deny = (status: number) => { res.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' }); res.end(status === 403 ? '链接无效或已过期' : '未找到素材'); };
  if (!['GET', 'HEAD'].includes(req.method || '')) { deny(405); return; }
  const id = url.pathname.slice('/media/'.length), expiresText = url.searchParams.get('expires') || '', provided = url.searchParams.get('signature') || '';
  const expires = Number(expiresText);
  if (!objectPattern.test(id) || !/^[0-9]{1,12}$/.test(expiresText) || !/^[a-f0-9]{64}$/.test(provided)
    || url.searchParams.getAll('expires').length !== 1 || url.searchParams.getAll('signature').length !== 1
    || !Number.isSafeInteger(expires) || expires <= nowSeconds()) { deny(403); return; }
  if (!timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(signature(config, id, expires), 'hex'))) { deny(403); return; }
  const root = await storeRoot(config);
  try {
    const opened = await locked(root, id, async () => {
      const saved = await record(root, id);
      if (expires > saved.expiresAt || saved.retainUntil <= nowSeconds()) return undefined;
      const path = join(root, 'objects', id); await regularFile(path);
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const info = await file.stat();
      if (!info.isFile() || info.size !== saved.size) { await file.close(); throw new Error('素材大小不一致'); }
      return { file, saved };
    });
    if (!opened) { deny(403); return; }
    const { file, saved } = opened;
    try {
      const headers: Record<string, string | number> = { 'Content-Type': saved.mime, 'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Accept-Ranges': 'bytes' };
      if (req.method === 'HEAD') { res.writeHead(200, { ...headers, 'Content-Length': saved.size }); res.end(); return; }
      let start = 0, end = saved.size - 1, status = 200;
      if (req.headers.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (match && (match[1] || match[2])) {
          if (!match[1]) { const suffix = Number(match[2]); start = Math.max(0, saved.size - suffix); }
          else { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), end); }
        } else start = -1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || end >= saved.size) {
          res.writeHead(416, { ...headers, 'Content-Range': `bytes */${saved.size}` }); res.end(); return;
        }
        status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${saved.size}`;
      }
      res.writeHead(status, { ...headers, 'Content-Length': end - start + 1 });
      await pipeline(file.createReadStream({ start, end, autoClose: false }), res);
    } finally { await file.close(); }
  } catch (error) {
    if (res.headersSent) { res.destroy(); return; }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { deny(404); return; }
    throw error;
  }
}

export async function cleanupLocalMaterials(config: LocalMaterialConfig, now = nowSeconds()) {
  const root = await storeRoot(config), result = { removed: 0, bytes: 0, skipped: 0, temporaryRemoved: 0, orphanRemoved: 0 };
  for (const name of await readdir(join(root, 'records'))) {
    if (!name.endsWith('.json') || !objectPattern.test(name.slice(0, -5))) continue;
    const id = name.slice(0, -5);
    try {
      const done = await locked(root, id, async () => {
        const saved = await record(root, id);
        if (saved.retainUntil > now || saved.expiresAt > now) return;
        const object = join(root, 'objects', id);
        try { await regularFile(object); await unlink(object); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await unlink(join(root, 'records', id + '.json'));
        result.removed++; result.bytes += saved.size;
        return true;
      }, false);
      if (done === undefined) result.skipped++;
    } catch { result.skipped++; }
  }
  // A process can stop after copying bytes but before committing the atomic record.
  for (const id of await readdir(join(root, 'objects'))) {
    if (!objectPattern.test(id)) continue;
    try {
      await locked(root, id, async () => {
        try { await regularFile(join(root, 'records', id + '.json')); return; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        const path = join(root, 'objects', id), info = await regularFile(path);
        if (now * 1000 - info.mtimeMs <= config.retentionSeconds * 1000) return;
        await unlink(path); result.orphanRemoved++; result.bytes += info.size;
      }, false);
    } catch { result.skipped++; }
  }
  for (const name of await readdir(join(root, 'tmp'))) {
    if (!/^[a-f0-9]{64}\.[a-z0-9]+\.[a-f0-9-]{36}\.part$/.test(name)) continue;
    const path = join(root, 'tmp', name);
    try { if (now * 1000 - (await regularFile(path)).mtimeMs > 86400000) { await unlink(path); result.temporaryRemoved++; } }
    catch { result.skipped++; }
  }
  for (const name of await readdir(join(root, 'records'))) {
    const match = /^([a-f0-9]{64}\.[a-z0-9]+)\.json\.[a-f0-9-]{36}\.tmp$/.exec(name);
    if (!match || !objectPattern.test(match[1])) continue;
    try {
      await locked(root, match[1], async () => {
        const path = join(root, 'records', name);
        if (now * 1000 - (await regularFile(path)).mtimeMs > 86400000) { await unlink(path); result.temporaryRemoved++; }
      }, false);
    } catch { result.skipped++; }
  }
  return result;
}
