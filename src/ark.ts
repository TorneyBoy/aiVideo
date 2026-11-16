import { mkdir, readFile, stat } from 'node:fs/promises';
import { extname, resolve, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { cloudJson, download, safeMessage, secret, CloudHttpError } from './cloud-http.ts';
import { fingerprint, hashFile, json, readJson } from './files.ts';
import type { ArkConfig } from './schema.ts';
import type { GenerationInputs } from './comfy.ts';
import { publishMaterial } from './material-storage.ts';

const mimeTypes: Record<string, string> = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

export class ArkClient {
  config: ArkConfig;
  cache: string;
  constructor(config: ArkConfig, cache: string) { this.config = config; this.cache = resolve(cache); }
  headers() { return { Authorization: `Bearer ${secret(this.config.tokenEnv)}` }; }
  account() { return fingerprint({ url: this.config.url, key: secret(this.config.tokenEnv) }); }
  url(route: string) { return `${this.config.url.replace(/\/$/, '')}${route}`; }

  /** Files user_data IDs are not downloadable URLs for Seedance or speech ASR. */
  async upload(path: string): Promise<string> {
    if (!this.config.storage) throw new Error('本地素材需要配置服务器临时素材链接；方舟 Files 文件 ID 不能作为视频或 ASR 的下载地址');
    if ((await stat(path)).size > 200 * 1024 * 1024) throw new Error('单段火山素材超过 200 MB');
    const mime = mimeTypes[extname(path).toLowerCase()];
    if (!mime) throw new Error('火山素材格式不支持，请先转换');
    return publishMaterial(this.config.storage, path, mime, this.account());
  }

}

export function arkBody(config: ArkConfig, inputs: GenerationInputs, urls: { video: string; image: string; audio?: string }) {
  const duration = inputs.frameCount / inputs.fps;
  if (duration < 4 || duration > 15) throw new Error('当前火山替换片段需要在 4–15 秒之间');
  const content: any[] = [
    { type: 'text', text: `请编辑 @视频1，使用 @图片1 作为目标主体。保持原视频的镜头顺序、动作与节奏。${urls.audio ? '使用 @音频1 作为台词与口型节奏参考。' : ''}\n${inputs.prompt}` },
    { type: 'video_url', video_url: { url: urls.video }, role: 'reference_video' },
    { type: 'image_url', image_url: { url: urls.image }, role: 'reference_image' },
  ];
  if (urls.audio) content.push({ type: 'audio_url', audio_url: { url: urls.audio }, role: 'reference_audio' });
  return {
    model: config.model, content, resolution: config.resolution, ratio: 'adaptive',
    // Seedance 2.5 video editing accepts only -1. 2.0 supports an integer duration.
    duration: config.family === 'seedance-2.5' ? -1 : Math.ceil(duration),
    seed: inputs.seed, generate_audio: !!urls.audio,
  };
}

export async function generateArk(config: ArkConfig, inputs: GenerationInputs, output: string, log: (message: string) => void) {
  await mkdir(dirname(output), { recursive: true });
  const client = new ArkClient(config, resolve(dirname(output), 'uploads'));
  if (inputs.referenceUrl && !/^https:\/\//.test(inputs.referenceUrl)) throw new Error('公开参考视频必须使用 HTTPS 地址');
  const signature = fingerprint({ version: 1, account: client.account(), config: { url: config.url, model: config.model, family: config.family, resolution: config.resolution },
    input: { ...inputs, referenceVideo: await hashFile(inputs.referenceVideo), subjectImage: await hashFile(inputs.subjectImage), audio: inputs.audio ? await hashFile(inputs.audio) : null } });
  const receiptPath = `${output}.ark.json`;
  let receipt: { signature: string; id?: string; phase: string; hash?: string; error?: string } | undefined;
  try { const value = await readJson(receiptPath) as NonNullable<typeof receipt>; if (value.signature === signature) receipt = value; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (receipt?.phase === 'rejected') receipt = undefined;
  if (receipt?.hash && receipt.hash === await hashFile(output).catch(() => '')) { log('复用已完成的火山生成片段'); return; }
  if (receipt && !receipt.id) throw new Error('上次视频提交未取得回执，无法确认是否受理；请先在方舟控制台核对任务，避免重复计费');
  if (receipt?.phase === 'failed') throw new Error(`此前视频任务已失败：${receipt.error || '请检查方舟控制台，调整配置后重试'}`);
  if (!receipt) {
    if ((await stat(inputs.subjectImage)).size > 20 * 1024 * 1024 && !inputs.subjectAssetUri) throw new Error('主体图片超过 20 MB，请先压缩或使用素材资产 ID');
    const urls = {
      video: inputs.referenceAssetUri || inputs.referenceUrl || await client.upload(inputs.referenceVideo),
      image: inputs.subjectAssetUri || `data:${mimeTypes[extname(inputs.subjectImage).toLowerCase()]};base64,${(await readFile(inputs.subjectImage)).toString('base64')}`,
      audio: inputs.audio ? `data:${mimeTypes[extname(inputs.audio).toLowerCase()]};base64,${(await readFile(inputs.audio)).toString('base64')}` : undefined,
    };
    const body = arkBody(config, inputs, urls);
    receipt = { signature, phase: 'submitting' };
    await json(receiptPath, receipt);
    let result: any;
    try { result = await cloudJson(client.url('/contents/generations/tasks'), { method: 'POST', headers: { ...client.headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, '方舟视频提交'); }
    catch (error) {
      if (error instanceof CloudHttpError && error.status >= 400 && error.status < 500 && error.status !== 408) {
        receipt.phase = 'rejected'; await json(receiptPath, receipt);
      }
      throw error;
    }
    if (typeof result.id !== 'string') throw new Error('方舟视频提交没有返回任务 ID，请先在控制台核对任务');
    receipt = { signature, phase: 'pending', id: result.id };
    await json(receiptPath, receipt);
    log('火山视频任务已提交，正在等待生成');
  } else log('正在继续查询已提交的火山视频任务');
  const deadline = Date.now() + config.timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const result = await cloudJson(client.url(`/contents/generations/tasks/${encodeURIComponent(receipt.id!)}`), { headers: client.headers() }, '方舟视频查询');
    if (['failed', 'expired', 'cancelled'].includes(result.status)) {
      receipt.phase = 'failed'; receipt.error = safeMessage(result.error?.message || result.status);
      await json(receiptPath, receipt);
      throw new Error(`火山视频生成失败：${receipt.error}。真人素材请确认肖像素材接入条件`);
    }
    if (result.status === 'succeeded') {
      if (typeof result.content?.video_url !== 'string') throw new Error('方舟任务成功但没有返回视频');
      await download(result.content.video_url, output);
      receipt.phase = 'complete'; receipt.hash = await hashFile(output);
      await json(receiptPath, receipt);
      return;
    }
    await delay(config.pollIntervalMs);
  }
  throw new Error('火山视频生成等待超时，任务回执已保存，继续处理可接着查询');
}
