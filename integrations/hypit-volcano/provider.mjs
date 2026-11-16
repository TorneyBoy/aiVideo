// aiVideo's original BYOK Provider. Hypit itself remains the pinned upstream implementation.
import { canonicalize, defineEndpoint, wakeAfter } from '@hypit/hypit/endpoint';
import { generationTypes, sealGeneratedVideoSet } from '@hypit/generation';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { arkConfigSchema } from '../../src/schema.ts';
import { CloudHttpError, cloudJson, download, safeMessage } from '../../src/cloud-http.ts';
import { publishMaterial } from '../../src/material-storage.ts';
import { probe } from '../../src/media.ts';
import { json, readJson } from '../../src/files.ts';
import { productionCapabilities } from './production-provider.mjs';

export function nativeSeedanceModel(ark) {
  return ark.family === 'seedance-2.5' ? 'seedance-2.5' : /-mini-/.test(ark.model) ? 'seedance-2-mini' : /-fast-/.test(ark.model) ? 'seedance-2-fast' : 'seedance-2';
}
const digest = value => createHash('sha256').update(value).digest('hex');
const extensions = { 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'audio/wav': '.wav', 'audio/mpeg': '.mp3', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

export function createVolcanoProvider(options) {
  const ark = arkConfigSchema.parse(options.ark), nativeModel = nativeSeedanceModel(ark);
  const capability = { module: { name: '@hypit/seedance', version: '1' }, name: nativeModel };
  const base = ark.url.replace(/\/$/, ''), root = resolve(options.cacheDirectory);
  function supports(need) {
    const ports = need.constraints?.ports || {};
    if (ports.webSearch?.[0] === true) return { status: 'unsupported', reason: 'This Ark editing adapter does not implement web search' };
    if (ports.firstFrame?.length || ports.lastFrame?.length) return { status: 'unsupported', reason: 'This adapter currently implements ReferenceVideo, not first/last-frame generation' };
    if (ports.resolution?.[0] === '4k') return { status: 'unsupported', reason: 'This adapter currently supports 480p, 720p and 1080p' };
    return { status: 'supported' };
  }
  function headers(context) {
    const key = context.credentials.apiKey?.secret;
    if (!key) throw new Error('Ark API key is unavailable');
    return { Authorization: `Bearer ${key}` };
  }
  const api = (context, route, init = {}) => cloudJson(`${base}${route}`, { ...init, headers: { ...headers(context), ...init.headers } }, 'Hypit 火山接口');
  const endpoint = {
    async start(context) {
      const accepted = supports(context.need); if (accepted.status !== 'supported') throw new Error(accepted.reason);
      if (options.allowPaidGeneration !== true) throw new Error('此 Hypit Profile 仅用于检查，尚未允许提交收费视频生成');
      await mkdir(root, { recursive: true });
      const ports = context.need.constraints.ports;
      const prompt = String(ports.prompt?.[0] || '').replace(/@image(\d+)\b/g, '@图片$1').replace(/@video(\d+)\b/g, '@视频$1').replace(/@audio(\d+)\b/g, '@音频$1');
      const content = [{ type: 'text', text: prompt }];
      const identities = [];
      let minSeconds = Number(ports.duration?.[0]) > 0 ? Number(ports.duration[0]) : 0;
      for (const [port, kind] of [['referenceVideo', 'video'], ['referenceImage', 'image'], ['referenceAudio', 'audio']]) {
        for (const reference of ports[port] || []) {
          const artifact = reference.artifact;
          if (kind !== 'audio' && typeof reference.fields?.personReference !== 'boolean') throw new Error('视觉参考必须明确声明 person-reference');
          const bytes = await context.resources.get(artifact.resource);
          if (!bytes) throw new Error('Hypit reference bytes are unavailable');
          if (bytes.byteLength > (kind === 'image' ? 20 : 200) * 1024 * 1024) throw new Error('参考素材超过当前火山适配大小限制');
          const hash = digest(bytes), extension = extensions[artifact.mediaType];
          identities.push({ port, hash, personReference: reference.fields?.personReference, asset: options.assetUris?.[hash] });
          if (!extension) throw new Error(`Unsupported Ark reference media type: ${artifact.mediaType}`);
          const file = resolve(root, `${hash.slice(0, 32)}${extension}`); await writeFile(file, bytes);
          let url = options.assetUris?.[hash];
          if (url && !/^asset:\/\/[A-Za-z0-9_-]+$/.test(url)) throw new Error('Invalid registered portrait asset URI');
          if (kind === 'video') {
            const info = await probe(file);
            if (!info.video || info.duration < 4 || info.duration > 15.1) throw new Error('参考视频必须为 4–15 秒');
            minSeconds = info.duration;
            if (!url) {
              if (!ark.storage) throw new Error('本地参考视频需要服务器临时素材链接或已注册的 asset:// URI');
              url = await publishMaterial(ark.storage, file, artifact.mediaType, digest(`${base}:${context.credentials.apiKey.secret}`));
            }
          } else if (!url && options.production && ark.storage && kind === 'image') {
            // Preserve exact Seedream output bytes; do not re-encode model originals or persist signed URLs.
            url = await publishMaterial(ark.storage, file, artifact.mediaType, digest(`${base}:${context.credentials.apiKey.secret}`));
          } else if (!url) url = `data:${artifact.mediaType};base64,${Buffer.from(bytes).toString('base64')}`;
          content.push({ type: `${kind}_url`, [`${kind}_url`]: { url }, role: `reference_${kind}` });
        }
      }
      if (!content.some(item => item.type === 'image_url' || item.type === 'video_url')) throw new Error('编辑需要主体图或视频参考');
      const body = { model: ark.model, content, resolution: ports.resolution[0], ratio: ports.aspectRatio[0], duration: ports.duration[0], generate_audio: ports.generateAudio[0], seed: options.seed ?? 42 };
      const signature = digest(JSON.stringify({ account: digest(`${base}:${context.credentials.apiKey.secret}`), model: ark.model, identities, prompt, resolution: body.resolution, ratio: body.ratio, duration: body.duration, audio: body.generate_audio, seed: body.seed }));
      const receiptFile = resolve(root, `task-${signature.slice(0, 32)}.json`);
      let saved;
      try { saved = await readJson(receiptFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (saved?.signature && saved.signature !== signature) throw new Error('Ark receipt signature mismatch');
      if (saved?.id) return { ...wakeAfter({ id: saved.id, minSeconds }, ark.pollIntervalMs), receipt: { id: saved.id, service: 'volcengine-ark' } };
      if (saved && saved.state !== 'rejected') throw new Error('上次火山提交未取得任务编号；请核对方舟控制台，避免重复扣费');
      // Mark before POST: a dropped response or worker restart must not submit the same paid request twice.
      await json(receiptFile, { signature, state: 'submitting', submittedAt: new Date().toISOString() });
      await context.reportProgress?.({ phase: 'Submitting video through the native Hypit Provider' });
      let result;
      try { result = await api(context, '/contents/generations/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
      catch (error) {
        if (error instanceof CloudHttpError && [400, 401, 403, 404, 422].includes(error.status)) await json(receiptFile, { signature, state: 'rejected', status: error.status, message: safeMessage(error.message) });
        throw error;
      }
      if (typeof result.id !== 'string') throw new Error('Ark accepted no task identity; verify the console before submitting again');
      await json(receiptFile, { signature, state: 'accepted', id: result.id });
      const handle = { id: result.id, minSeconds }, receipt = { id: result.id, service: 'volcengine-ark' };
      await context.checkpoint?.({ handle, receipt });
      return { ...wakeAfter(handle, ark.pollIntervalMs), receipt };
    },
    async poll(context) {
      const result = await api(context, `/contents/generations/tasks/${encodeURIComponent(context.handle.id)}`);
      if (['failed', 'expired', 'cancelled'].includes(result.status)) return { status: 'failed', receipt: { id: context.handle.id }, failure: { code: String(result.error?.code || result.status), message: safeMessage(result.error?.message || result.status) } };
      if (result.status === 'succeeded') return { status: 'ready', handle: context.handle };
      return wakeAfter(context.handle, ark.pollIntervalMs, Date.now(), { phase: String(result.status) });
    },
    async collect(context) {
      // Query again so the signed URL never enters durable Hypit handles or receipts.
      const result = await api(context, `/contents/generations/tasks/${encodeURIComponent(context.handle.id)}`);
      if (result.status !== 'succeeded' || typeof result.content?.video_url !== 'string') throw new Error('Ark task has no completed video output');
      const output = resolve(root, `result-${digest(context.handle.id)}.mp4`); await download(result.content.video_url, output);
      const info = await probe(output);
      if (!info.video || info.duration + 0.08 < context.handle.minSeconds) throw new Error('生成视频时长不足，不用静帧补齐');
      const blob = await context.resources.put(new Uint8Array(await readFile(output)), 'video/mp4');
      return { status: 'completed', result: { value: { kind: 'inline', value: canonicalize(sealGeneratedVideoSet({ videos: [blob] })) } } };
    },
  };
  return defineEndpoint({
    instance: options.instance, pool: options.pool, credentials: { apiKey: options.apiKey },
    credentialInputs: { apiKey: { label: 'Volcengine Ark API key' } },
    defaultConcurrency: 1, actionLimits: { submit: { concurrency: 1 }, poll: { concurrency: 2 }, collect: { concurrency: 1 } },
    capabilities: [{ capability, returns: generationTypes.videoSet, lifecycle: 'asynchronous', supports, endpoint }, ...productionCapabilities(options)],
  });
}
