import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalize } from '@hypit/hypit/endpoint';
import { generationTypes, sealGeneratedImageSet } from '@hypit/generation';
import { speechEvidenceTypes, assertAlignedTranscriptEvidenceIdentity } from '@hypit/speech-evidence';
import { imageEndpoint, wordCapability } from './production-module.mjs';
import { cloudFetch, download, CloudHttpError, safeMessage } from '../../src/cloud-http.ts';
import { hashFile, json, readJson } from '../../src/files.ts';
import { probe } from '../../src/media.ts';
import { transcribeWords } from '../../src/doubao.ts';
import { publishMaterial } from '../../src/material-storage.ts';

const digest = input => createHash('sha256').update(input).digest('hex');
const mime = bytes => bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png' : bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : undefined;
export function productionCapabilities(options) {
  if (!options.production) return [];
  const config = options.production, root = resolve(options.cacheDirectory);
  const permit = () => { if (options.allowPaidGeneration !== true) throw new Error('此工程仅允许检查，禁止提交图片生成或逐词识别'); };
  const supports = () => ({ status: 'supported' });
  const image = async context => {
    permit(); await mkdir(root, { recursive: true });
    const ports = context.need.constraints.ports;
    const references = [], hashes = [];
    for (const reference of ports.images || []) {
      const bytes = await context.resources.get(reference.artifact.resource);
      if (!bytes || bytes.byteLength > 10 * 1024 * 1024 || !reference.artifact.mediaType.startsWith('image/')) throw new Error('机位参考图不存在或超过 10 MB');
      hashes.push(digest(bytes));
      references.push(`data:${reference.artifact.mediaType};base64,${Buffer.from(bytes).toString('base64')}`);
    }
    const prompt = `${ports.prompt[0]} 输出宽高比 ${ports.aspectRatio[0]}，仅一张完整机位图。`;
    const signature = digest(JSON.stringify({ version: 1, account: digest(`${options.ark.url}:${context.credentials.apiKey.secret}`), model: config.imageModel, prompt, size: ports.size[0], hashes }));
    const file = resolve(root, `im-${signature.slice(0, 20)}.image`), receiptFile = `${file}.json`;
    let saved;
    try { saved = await readJson(receiptFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (saved?.signature !== undefined && saved.signature !== signature) throw new Error('机位图片回执签名不一致');
    if (saved?.state === 'complete') {
      if (await hashFile(file) !== saved.hash) throw new Error('已生成机位图损坏；不会自动再次付费生成，请先恢复原图');
    } else {
      if (saved && saved.state !== 'rejected') throw new Error('上次机位图片提交结果不明；请核对方舟用量，未自动重复付费');
      await json(receiptFile, { signature, state: 'submitting' });
      let body;
      try {
        const response = await cloudFetch(`${options.ark.url.replace(/\/$/, '')}/images/generations`, {
          method: 'POST', headers: { Authorization: `Bearer ${context.credentials.apiKey.secret}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: config.imageModel, prompt, image: references, size: ports.size[0], response_format: 'b64_json', watermark: false }),
        }, 'Seedream 三机位素材', config.requestTimeoutSeconds * 1000);
        body = await response.json();
      } catch (error) {
        if (error instanceof CloudHttpError && [400, 401, 403, 404, 422].includes(error.status)) await json(receiptFile, { signature, state: 'rejected', message: safeMessage(error.message) });
        throw error;
      }
      if (!Array.isArray(body.data) || body.data.length !== 1 || body.data[0].error) throw new Error('Seedream 未返回唯一有效机位图；未自动再次提交');
      if (typeof body.data[0].b64_json === 'string') {
        const bytes = Buffer.from(body.data[0].b64_json, 'base64');
        if (!bytes.length || bytes.length > 30 * 1024 * 1024 || !mime(bytes)) throw new Error('Seedream 返回的图片数据无效或过大');
        await writeFile(file, bytes);
      } else if (typeof body.data[0].url === 'string') await download(body.data[0].url, file, 30 * 1024 * 1024);
      else throw new Error('Seedream 没有图片数据；提交回执已保留');
      const bytes = await readFile(file), mediaType = mime(bytes);
      if (!mediaType || !(await probe(file)).video) throw new Error('机位图片未通过媒体检查');
      saved = { signature, state: 'complete', hash: await hashFile(file), mediaType, model: config.imageModel, createdAt: new Date().toISOString() };
      await json(receiptFile, saved);
    }
    const blob = await context.resources.put(new Uint8Array(await readFile(file)), saved.mediaType);
    return { value: { kind: 'inline', value: canonicalize(sealGeneratedImageSet({ images: [blob] })) } };
  };
  const words = async context => {
    permit(); await mkdir(root, { recursive: true });
    const request = context.need.constraints;
    if (typeof request.domainId !== 'string' || !Number.isSafeInteger(request.sampleFrames) || request.sampleFrames < 1 || request.audio?.mediaType !== 'audio/wav') throw new Error('逐词对齐需要精确的原生音频域');
    const bytes = await context.resources.get(request.audio.resource);
    if (!bytes || bytes.length > 512 * 1024 * 1024) throw new Error('逐词对齐音频无效');
    const hash = digest(bytes), file = resolve(root, `sp-${hash.slice(0, 20)}.wav`);
    await writeFile(file, bytes);
    const info = await probe(file), duration = request.sampleFrames / 16000;
    if (!info.audio || Math.abs(info.duration - duration) > 1 / 16000 + 0.000001) throw new Error('对齐音频与原生采样域不一致');
    if (!options.ark.storage) throw new Error('豆包逐词识别需要配置服务器临时素材链接');
    let progress = Promise.resolve();
    const utterances = await transcribeWords(config.speech, {
      upload: path => publishMaterial(options.ark.storage, path, 'audio/wav', digest(`${options.ark.url}:${context.credentials.apiKey.secret}`)),
    }, file, duration, resolve(root, `asr-${hash.slice(0, 16)}`), message => { progress = progress.then(async () => { await context.reportProgress?.({ phase: message }); }); });
    await progress;
    if (!utterances.length) throw new Error('最终配音没有识别到台词，不能生成逐词对齐');
    const evidence = { domainId: request.domainId, sampleFrames: request.sampleFrames, passages: utterances.map(utterance => ({
      startSample: Math.round(utterance.start * 16000), endSampleExclusive: Math.min(request.sampleFrames, Math.round(utterance.end * 16000)),
      words: utterance.words.map(word => ({ text: word.text, startSample: Math.round(word.start * 16000), endSampleExclusive: Math.min(request.sampleFrames, Math.round(word.end * 16000)) })), chars: [],
    })) };
    assertAlignedTranscriptEvidenceIdentity(evidence);
    await json(resolve(root, `words-${digest(request.label).slice(0, 16)}.json`), evidence);
    return { value: { kind: 'inline', value: canonicalize(evidence) } };
  };
  return [
    { capability: imageEndpoint.capability, returns: generationTypes.imageSet, lifecycle: 'immediate', supports, handler: image },
    { capability: wordCapability, returns: speechEvidenceTypes.alignedTranscript, lifecycle: 'immediate', supports, handler: words },
  ];
}
