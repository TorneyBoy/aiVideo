import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import Busboy from 'busboy';
import { runtime } from './config.ts';
import { JobStore } from './jobs.ts';
import type { Job } from './jobs.ts';
import { assetUriSchema } from './schema.ts';
import { hasSpeechCredentials } from './volc-settings.ts';
import { z } from 'zod';
import { voiceStageSchema } from './voice-consent.ts';
import { serverAccess } from './server-access.ts';
import { isLocalMaterialStorage } from './schema.ts';
import { cleanupLocalMaterials, serveLocalMaterial } from './local-materials.ts';
import { safeMessage } from './cloud-http.ts';

const publicRoot = new URL('../web/', import.meta.url);
const extensions: Record<string, string[]> = { reference: ['.mp4', '.mov', '.webm', '.mkv'], subject: ['.jpg', '.jpeg', '.png', '.webp'], voice: ['.wav', '.mp3', '.m4a', '.ogg', '.flac'] };
const contentTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac' };

async function confirmationBody(req: IncomingMessage) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('确认请求需要 JSON');
  let body = '';
  for await (const chunk of req) { body += chunk.toString(); if (Buffer.byteLength(body) > 4096) throw new Error('确认内容过长'); }
  return z.object({ stage: voiceStageSchema, reviewId: z.string().uuid(), confirmed: z.literal(true) }).strict().parse(JSON.parse(body));
}

async function jsonBody(req: IncomingMessage) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('请求需要 JSON');
  let body = ''; for await (const chunk of req) { body += chunk.toString(); if (Buffer.byteLength(body) > 8192) throw new Error('请求内容过长'); }
  return JSON.parse(body);
}

async function receiveVoiceSample(req: IncomingMessage, directory: string) {
  await mkdir(directory, { recursive: true });
  let sample: string | undefined, name = '';
  await new Promise<void>((accept, reject) => {
    const parser = Busboy({ headers: req.headers, limits: { files: 1, fields: 1, parts: 3, fileSize: 10 * 1024 * 1024, fieldSize: 240 } });
    let failure: Error | undefined; const writes: Promise<void>[] = [];
    parser.on('file', (field, stream, info) => {
      const extension = extname(info.filename).toLowerCase();
      if (field !== 'sample' || !extensions.voice.includes(extension) || sample) { failure = new Error('请上传支持的音频录音'); stream.resume(); return; }
      sample = resolve(directory, `sample${extension}`);
      stream.on('limit', () => { failure = new Error('音色录音不能超过 10 MB'); });
      writes.push(pipeline(stream, createWriteStream(sample)).catch(error => { failure = error; }));
    });
    parser.on('field', (field, value) => { if (field !== 'name') failure = new Error('音色字段不支持'); else name = value; });
    for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit'] as const) parser.on(event, () => { failure = new Error('音色上传内容过多'); });
    parser.on('error', reject); req.on('aborted', () => { parser.destroy(); reject(new Error('上传中断')); });
    parser.on('close', () => { void Promise.all(writes).then(() => failure ? reject(failure) : accept()); }); req.pipe(parser);
  });
  if (!sample) throw new Error('请上传目标音色录音');
  return { sample, name: z.string().trim().min(1).max(60).parse(name) };
}

async function receive(req: IncomingMessage, directory: string) {
  await mkdir(directory, { recursive: true });
  const files: Record<string, string> = {}, fields: Record<string, string> = {};
  await new Promise<void>((accept, reject) => {
    const parser = Busboy({ headers: req.headers, limits: { files: 3, fields: 6, fileSize: 500 * 1024 * 1024, fieldSize: 1000, parts: 10 } });
    const writes: Promise<void>[] = [];
    let failure: Error | undefined;
    parser.on('file', (name, stream, info) => {
      const extension = extname(info.filename).toLowerCase();
      if (!extensions[name]?.includes(extension) || files[name]) { failure = new Error('文件类型或上传字段不支持'); stream.resume(); return; }
      const path = resolve(directory, `${name}${extension}`);
      files[name] = path;
      stream.on('limit', () => { failure = new Error('文件超过 500 MB 上传限制'); });
      const writing = pipeline(stream, createWriteStream(path)).catch(error => { failure = error; });
      writes.push(writing);
    });
    parser.on('field', (name, value) => { fields[name] = value; });
    for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit'] as const) parser.on(event, () => { failure = new Error('上传内容过多'); });
    parser.on('error', reject);
    req.on('aborted', () => { parser.destroy(); reject(new Error('上传已中断')); });
    parser.on('close', () => { void Promise.all(writes).then(() => failure ? reject(failure) : accept()); });
    req.pipe(parser);
  });
  if (!files.reference || !files.subject) throw new Error('请上传参考视频和主体图像');
  if (!['presenter', 'product'].includes(fields.mode)) throw new Error('请选择人物或商品替换');
  const asset = (value?: string) => value?.trim() ? assetUriSchema.parse(value.trim().startsWith('asset://') ? value.trim() : `asset://${value.trim()}`) : undefined;
  const voiceProfileId = fields.voiceProfileId?.trim() ? z.string().uuid().parse(fields.voiceProfileId.trim()) : undefined;
  const voiceMode = fields.voiceMode?.trim() ? z.enum(['synthesis', 'conversion']).parse(fields.voiceMode.trim()) : undefined;
  if (voiceProfileId && files.voice) throw new Error('请直接选择已确定音色，视频任务不重复上传目标录音');
  return { files, mode: fields.mode as Job['mode'], cloneVoice: fields.cloneVoice === undefined ? !!(files.voice || voiceProfileId) : fields.cloneVoice === 'true', subjectAssetUri: asset(fields.subjectAssetUri), referenceAssetUri: asset(fields.referenceAssetUri), voiceProfileId, voiceMode };
}

async function sendFile(req: IncomingMessage, res: ServerResponse, path: string, type?: string) {
  const info = await stat(path);
  res.setHeader('Content-Type', type || contentTypes[extname(path)] || 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes');
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    const start = Number(match?.[1]), end = match?.[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
    if (!match || !Number.isSafeInteger(start) || start > end || start < 0) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); res.end(); return; }
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Content-Length': end - start + 1 });
    await pipeline(createReadStream(path, { start, end }), res);
  } else {
    res.setHeader('Content-Length', info.size);
    await pipeline(createReadStream(path), res);
  }
}

function publicJob(job: Job) {
  return { id: job.id, mode: job.mode, created: job.created, updated: job.updated, state: job.state, message: job.message, logs: job.logs, directedProduction: job.directedProduction, hasVoice: job.cloneVoice ?? !!(job.voice || job.voiceProfileId), voiceProfileId: job.voiceProfileId, voiceName: job.voiceName };
}

export function createApp(root = 'runs/jobs') {
  const store = new JobStore(root);
  const access = serverAccess();
  const basePath = process.env.APP_PUBLIC_URL?.trim() ? new URL(process.env.APP_PUBLIC_URL.trim()).pathname.replace(/\/$/, '') : '';
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob:; media-src 'self' blob:; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'");
    const reply = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (basePath && url.pathname === basePath) { res.writeHead(308, { Location: basePath + '/' }); res.end(); return; }
      if (basePath) {
        if (!url.pathname.startsWith(basePath + '/')) { reply(404, { error: '未找到内容' }); return; }
        url.pathname = url.pathname.slice(basePath.length);
      }
      const material = url.pathname.startsWith('/media/');
      if (!access.allow(req, res, material)) return;
      if (material) {
        const config = await runtime();
        const storage = [...new Map(Object.values(config.providers).flatMap(provider => provider.type === 'volcengine-ark' && provider.storage && isLocalMaterialStorage(provider.storage) ? [[`${provider.storage.directory}|${provider.storage.publicBaseUrl}`, provider.storage] as const] : [])).values()];
        if (storage.length !== 1) { reply(404, { error: '素材服务未配置' }); return; }
        await serveLocalMaterial(storage[0], req, res, url); return;
      }
      if (req.method === 'GET' && ['/', '/app.js', '/voices.js', '/style.css'].includes(url.pathname)) {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        res.setHeader('Content-Type', contentTypes[extname(name)]);
        res.end(await readFile(new URL(name, publicRoot))); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        const config = await runtime();
        const ready = (route?: string) => !!route && !!config.providers[route] && (config.providers[route].type !== 'volcengine-ark' || !!process.env[config.providers[route].tokenEnv]?.trim());
        reply(200, {
          engine: config.engine,
          directedProduction: config.engine === 'hypit' && config.production.enabled,
          productionConfigured: !config.production.enabled || !!(config.production.imageModel && config.production.directorModel),
          storage: Object.values(config.providers).some(provider => provider.type === 'volcengine-ark' && provider.storage && isLocalMaterialStorage(provider.storage)) ? 'local' : null,
          presenter: ready(config.routes.presenter), product: ready(config.routes.product),
          voice: !!config.voice && (config.voice.type !== 'doubao' || hasSpeechCredentials(config.voice)),
          voiceProvider: config.voice?.type || null, existingVoice: config.voice?.type === 'doubao' && !!config.voice.speakerId,
          voiceConversion: !!config.voiceConversion && !config.production.enabled,
        }); return;
      }
      if (url.pathname === '/api/voices') {
        if (req.method === 'GET') { reply(200, await store.voices.list()); return; }
        if (req.method === 'POST') {
          const id = randomUUID(); const input = await receiveVoiceSample(req, resolve(store.voices.path(id), 'input'));
          const voice = await store.voices.create(id, input.name, input.sample);
          reply(201, { id: voice.id, name: voice.name }); return;
        }
      }
      const voiceRoute = /^\/api\/voices\/([0-9a-f-]{36})\/(sample|rounds)(?:\/([0-9a-f-]{36})\/(preview|confirm|retry))?$/.exec(url.pathname);
      if (voiceRoute) {
        const [, id, part, roundId, action] = voiceRoute; await store.voices.get(id);
        if (req.method === 'GET' && part === 'sample' && !roundId) { await sendFile(req, res, resolve(store.voices.path(id), 'sample.wav')); return; }
        if (req.method === 'POST' && part === 'rounds' && !roundId) {
          const body = z.object({ text: z.string().trim().min(4).max(300), confirmed: z.literal(true) }).strict().parse(await jsonBody(req));
          const round = await store.voices.addRound(id, body.text); reply(202, { id: round.id, state: round.state }); return;
        }
        if (roundId && part === 'rounds') {
          if (req.method === 'GET' && action === 'preview') {
            const preview = await store.voices.preview(id, roundId);
            if (!preview) { reply(404, { error: '本轮试听尚未就绪' }); return; }
            await sendFile(req, res, preview); return;
          }
          if (req.method === 'POST' && action === 'confirm') {
            const body = z.object({ reviewId: z.string().uuid(), confirmed: z.literal(true), acceptFees: z.literal(true) }).strict().parse(await jsonBody(req));
            await store.voices.confirm(id, roundId, body.reviewId); reply(202, { ok: true }); return;
          }
          if (req.method === 'POST' && action === 'retry') { await store.voices.retry(id, roundId); reply(202, { ok: true }); return; }
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/jobs') { reply(200, (await store.list()).map(publicJob)); return; }
      if (req.method === 'POST' && url.pathname === '/api/jobs') {
        const id = randomUUID(), directory = store.path(id);
        const { files, mode, cloneVoice, subjectAssetUri, referenceAssetUri, voiceProfileId, voiceMode } = await receive(req, resolve(directory, 'input'));
        const now = new Date().toISOString();
        const job: Job = { id, created: now, updated: now, mode, reference: files.reference, subject: files.subject, voice: files.voice, cloneVoice, subjectAssetUri, referenceAssetUri, voiceProfileId, voiceMode, state: 'queued', message: '等待分析', logs: [] };
        await store.save(job); await store.enqueue(id);
        reply(202, publicJob(job)); return;
      }
      const camera = /^\/api\/jobs\/([0-9a-f-]{36})\/camera\/([123])$/.exec(url.pathname);
      if (req.method === 'GET' && camera) {
        const job = await store.get(camera[1]);
        if (job.state !== 'complete' || !job.directedProduction) { reply(409, { error: '三机位素材尚未完成' }); return; }
        const file = resolve(store.path(job.id), `output/camera-${camera[2]}.image`);
        const bytes = await readFile(file);
        const type = bytes[0] === 0x89 ? 'image/png' : bytes[0] === 0xff ? 'image/jpeg' : undefined;
        if (!type) throw new Error('机位素材格式无效');
        await sendFile(req, res, file, type); return;
      }
      const match = /^\/api\/jobs\/([0-9a-f-]{36})(?:\/(retry|result|reference|subject|voice-confirm|voice-preview|voice-sample|subtitles|words))?$/.exec(url.pathname);
      if (match) {
        const job = await store.get(match[1]);
        if (req.method === 'GET' && !match[2]) { reply(200, { ...publicJob(job), voiceReview: await store.review(job) }); return; }
        if (req.method === 'POST' && match[2] === 'retry') { await store.enqueue(job.id); reply(202, { ok: true }); return; }
        if (req.method === 'POST' && match[2] === 'voice-confirm') {
          const body = await confirmationBody(req);
          await store.confirmVoice(job.id, body.stage, body.reviewId);
          reply(202, { ok: true }); return;
        }
        if (req.method === 'GET' && ['voice-preview', 'voice-sample'].includes(match[2])) {
          const path = match[2] === 'voice-preview' ? await store.preview(job.id) : job.voice;
          if (!path) { reply(404, { error: '试听音频暂不可用' }); return; }
          await sendFile(req, res, path); return;
        }
        if (req.method === 'GET' && ['words', 'subtitles'].includes(match[2])) {
          if (job.state !== 'complete' || !job.directedProduction) { reply(409, { error: '逐词对齐尚未完成' }); return; }
          const name = match[2] === 'words' ? 'words.json' : 'subtitles.srt';
          res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
          await sendFile(req, res, resolve(store.path(job.id), 'output', name), name.endsWith('.json') ? 'application/json' : 'text/plain; charset=utf-8'); return;
        }
        if (req.method === 'GET' && ['result', 'reference', 'subject'].includes(match[2])) {
          const path = match[2] === 'result' ? resolve(store.path(job.id), 'output/video.mp4') : match[2] === 'reference' ? job.reference : job.subject;
          if (match[2] === 'result' && job.state !== 'complete') { reply(409, { error: '视频尚未完成' }); return; }
          if (match[2] === 'result' && url.searchParams.has('download')) res.setHeader('Content-Disposition', 'attachment; filename="aivideo.mp4"');
          await sendFile(req, res, path); return;
        }
      }
      reply(404, { error: '未找到内容' });
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      reply(missing ? 404 : 400, { error: missing ? '未找到内容' : error instanceof Error ? error.message : '请求失败' });
    }
  });
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;
  let cleaning = false, closed = false;
  server.once('listening', () => {
    void (async () => {
      const config = await runtime();
      const stores = Object.values(config.providers).flatMap(provider => provider.type === 'volcengine-ark' && provider.storage && isLocalMaterialStorage(provider.storage) ? [provider.storage] : []);
      const unique = [...new Map(stores.map(storage => [storage.directory, storage])).values()];
      if (!unique.length || closed) return;
      const clean = async () => {
        if (cleaning || closed) return;
        cleaning = true;
        try { for (const storage of unique) await cleanupLocalMaterials(storage); }
        catch (error) { console.error(`临时素材清理失败：${safeMessage(error)}`); }
        finally { cleaning = false; }
      };
      await clean();
      if (!closed) { cleanupTimer = setInterval(() => { void clean(); }, Math.min(...unique.map(storage => storage.cleanupIntervalSeconds)) * 1000); cleanupTimer.unref(); }
    })().catch(error => console.error(`素材清理未启动：${safeMessage(error)}`));
  });
  server.once('close', () => { closed = true; if (cleanupTimer) clearInterval(cleanupTimer); });
  server.requestTimeout = 15 * 60 * 1000;
  return { server, store };
}

export function startServer(port = 4173, host = '127.0.0.1') {
  const { server } = createApp();
  server.listen(port, host, () => console.log(`aiVideo 已启动：${process.env.APP_PUBLIC_URL || `http://127.0.0.1:${port}`}`));
  return server;
}
