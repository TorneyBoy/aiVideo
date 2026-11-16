import { mkdir, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { runtime } from './config.ts';
import { hashFile, json, readJson } from './files.ts';
import { analyze, probe, cloudRanges, ffmpeg } from './media.ts';
import { plan, render } from './render.ts';
import { checkHypitProject } from './hypit.ts';
import { convertVoice } from './voice.ts';
import { assetUriSchema } from './schema.ts';
import { hasSpeechCredentials } from './volc-settings.ts';
import { ArkClient } from './ark.ts';
import { transcribe, transcribeWords, cloneSpeaker, synthesizeNarration } from './doubao.ts';
import type { WordUtterance } from './doubao.ts';
import { directProduction } from './director.ts';
import { safeMessage } from './cloud-http.ts';
import { approveVoiceReview, readVoiceReview, VoiceConsentRequired } from './voice-consent.ts';
import type { VoiceStage } from './voice-consent.ts';
import { VoiceLibrary } from './voice-library.ts';
import { materialStorageMissing } from './material-storage.ts';
import { assertJobMemoryBudget } from './resource-budget.ts';

export const jobSchema = z.object({
  id: z.string().uuid(), created: z.string(), updated: z.string(),
  mode: z.enum(['presenter', 'product']), reference: z.string(), subject: z.string(), voice: z.string().optional(),
  cloneVoice: z.boolean().optional(), subjectAssetUri: assetUriSchema.optional(), referenceAssetUri: assetUriSchema.optional(),
  voiceProfileId: z.string().uuid().optional(), voiceName: z.string().optional(),
  voiceMode: z.enum(['synthesis', 'conversion']).optional(),
  directedProduction: z.boolean().optional(),
  state: z.enum(['queued', 'analyzing', 'needs_setup', 'transcribing', 'cloning', 'awaiting_voice_upload', 'awaiting_voice_activation', 'voice', 'generating', 'complete', 'failed', 'interrupted']),
  message: z.string(), logs: z.array(z.string()).default([]),
});
export type Job = z.infer<typeof jobSchema>;

export class JobStore {
  root: string;
  active = new Set<string>();
  confirming = new Set<string>();
  voices: VoiceLibrary;
  queue: Promise<void> = Promise.resolve();
  constructor(root: string) { this.root = resolve(root); this.voices = new VoiceLibrary(resolve(dirname(this.root), 'voices')); }
  path(id: string) {
    if (!z.string().uuid().safeParse(id).success) throw new Error('任务编号无效');
    return resolve(this.root, id);
  }
  async save(job: Job) { job.updated = new Date().toISOString(); await json(resolve(this.path(job.id), 'job.json'), job); }
  async get(id: string): Promise<Job> { return jobSchema.parse(await readJson(resolve(this.path(id), 'job.json'))); }
  async preview(id: string): Promise<string | undefined> {
    const out = resolve(this.path(id), 'voice');
    try {
      const meta = await readJson(resolve(out, 'preview.json')) as { hash: string; sampleSignature: string };
      const registration = await readVoiceReview(out, 'register');
      const path = resolve(out, 'preview.wav');
      if (registration?.binding === meta.sampleSignature && meta.hash === await hashFile(path)) return path;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  async review(job: Job) {
    const stage = job.state === 'awaiting_voice_upload' ? 'register' : job.state === 'awaiting_voice_activation' ? 'activate' : undefined;
    if (!stage) return undefined;
    const review = await readVoiceReview(resolve(this.path(job.id), 'voice'), stage);
    if (!review || review.approvedAt) return undefined;
    return { id: review.id, stage, hasPreview: stage === 'activate' && !!await this.preview(job.id), hasSample: !!job.voice, details: review.details };
  }
  async confirmVoice(id: string, stage: VoiceStage, reviewId: string) {
    if (this.active.has(id) || this.confirming.has(id)) throw new Error('任务正在处理，请勿重复确认');
    this.confirming.add(id);
    try {
      const job = await this.get(id);
      const expected = stage === 'register' ? 'awaiting_voice_upload' : 'awaiting_voice_activation';
      if (job.state !== expected) throw new Error('当前任务不在此确认阶段，请刷新后重试');
      await approveVoiceReview(resolve(this.path(id), 'voice'), stage, reviewId);
      await this.enqueue(id);
    } finally { this.confirming.delete(id); }
  }
  async list() {
    await mkdir(this.root, { recursive: true });
    const jobs: Job[] = [];
    for (const directory of await readdir(this.root)) {
      if (!z.string().uuid().safeParse(directory).success) continue;
      const job = await this.get(directory);
      if (!this.active.has(job.id) && ['queued', 'analyzing', 'transcribing', 'cloning', 'voice', 'generating'].includes(job.state)) {
        job.state = 'interrupted'; job.message = '服务已重启，可继续处理并复用已有结果';
      }
      jobs.push(job);
    }
    return jobs.sort((a, b) => b.created.localeCompare(a.created)).slice(0, 30);
  }
  async enqueue(id: string) {
    if (this.active.has(id)) throw new Error('任务正在处理中');
    const job = await this.get(id);
    if (job.state === 'complete') throw new Error('任务已经完成');
    this.active.add(id);
    job.state = 'queued'; job.message = '正在排队';
    await this.save(job);
    this.queue = this.queue.then(() => this.run(id)).catch(error => { console.error('任务队列错误', error instanceof Error ? error.message : '未知错误'); }).finally(() => { this.active.delete(id); });
  }
  async run(id: string) {
    const job = await this.get(id), directory = this.path(id);
    const update = async (state: Job['state'], message: string) => {
      job.state = state; job.message = message;
      job.logs = [...job.logs.slice(-79), message];
      await this.save(job);
    };
    let logQueue = Promise.resolve();
    const log = (message: string) => { logQueue = logQueue.then(() => update(job.state, message)); };
    try {
      await assertJobMemoryBudget();
      await update('analyzing', '正在分析参考视频和切分镜头');
      const subject = await probe(job.subject);
      if (!subject.video) throw new Error('主体素材不是有效图像');
      const project = await analyze(job.reference, resolve(directory, 'analysis'));
      const config = await runtime();
      const providerId = config.routes[job.mode];
      const provider = providerId ? config.providers[providerId] : undefined;
      const withVoice = job.cloneVoice ?? !!(job.voice || job.voiceProfileId);
      const conversion = withVoice && job.voiceMode === 'conversion';
      const directed = config.engine === 'hypit' && config.production.enabled;
      job.directedProduction = directed;
      const missing: string[] = [];
      if (!provider) missing.push('ARK_VIDEO_MODEL 或人物/商品生成服务');
      if (directed) {
        if (!config.production.imageModel) missing.push('ARK_IMAGE_MODEL（三机位 Seedream 图片模型）');
        if (!config.production.directorModel) missing.push('ARK_DIRECTOR_MODEL（支持图片理解的豆包导演模型）');
        if (provider?.type !== 'volcengine-ark') missing.push('完整导演流程需要火山方舟视频服务');
        if (project.audio.type !== 'mute' && (config.voice?.type !== 'doubao' || !hasSpeechCredentials(config.voice))) missing.push('豆包录音识别凭证（逐句导演与逐词对齐）');
        if (conversion) missing.push('完整火山流程请使用豆包配音；独立 VC 仅保留在基础兼容流程');
      }
      if (provider?.type === 'volcengine-ark' && !process.env[provider.tokenEnv]?.trim()) missing.push(provider.tokenEnv);
      if (provider?.type === 'volcengine-ark' && (!job.referenceAssetUri || (withVoice && !conversion && config.voice?.type === 'doubao') || directed)) {
        missing.push(...materialStorageMissing(provider.storage));
      }
      if (withVoice && !conversion && !config.voice) missing.push('声音克隆服务');
      if (withVoice && !conversion && config.voice?.type === 'doubao' && !hasSpeechCredentials(config.voice)) missing.push('VOLC_SPEECH_API_KEY 或旧版语音凭证');
      if (conversion && !config.voiceConversion) missing.push('VOICE_CONVERSION_URL（独立 VC 服务尚未配置）');
      if (conversion && config.voiceConversion?.tokenEnv && !process.env[config.voiceConversion.tokenEnv]?.trim()) missing.push(config.voiceConversion.tokenEnv);
      if (missing.length) { await update('needs_setup', `分镜已完成，等待配置：${missing.join('、')}`); return; }
      if (withVoice && project.audio.type === 'mute') throw new Error('参考视频没有声音，无法提取原台词');
      if (withVoice && job.voice) {
        const sample = await probe(job.voice);
        if (!sample.audio || sample.duration < 3 || sample.duration > 30) throw new Error('目标声音样本需要 3–30 秒的有效录音');
      }
      const selectedVoice = withVoice && job.voiceProfileId ? await this.voices.saved(job.voiceProfileId) : undefined;
      if (directed && withVoice && !selectedVoice) throw new Error('完整导演流程需要选择独立音色库中已试听确认的音色；视频任务不会新建或启用槽位');
      if (selectedVoice) job.voiceName = selectedVoice.name;
      if (withVoice && !job.voice && !selectedVoice && config.voice?.type === 'doubao' && !config.voice.speakerId) throw new Error('请在独立音色库中试听、确认并选择音色');
      project.assets.subject = { path: job.subject, kind: 'image' };
      project.subjects[job.mode] = 'subject';
      project.providers = config.providers;
      const instruction = job.mode === 'presenter'
        ? 'Replace the visible presenter with the person in the subject reference image. Preserve the reference camera, scene, gestures and timing. Match the supplied audio and lip motion. Maintain the new identity across every frame.'
        : 'Replace the featured product with the exact product in the subject reference image. Preserve camera motion, background, hands and occlusions. Keep the product shape, packaging, colors and logo consistent across frames. Do not change people.';
      if (provider!.type === 'volcengine-ark') {
        const duration = project.shots.at(-1)!.end as number;
        project.shots = cloudRanges(duration, project.output.fps, !!job.referenceAssetUri).map((range, i) => ({
          id: `cloud-${i + 1}`, ...range,
          visual: { type: 'generate', task: job.mode, provider: providerId!, prompt: instruction, seed: 42, subjectAssetUri: job.subjectAssetUri, referenceAssetUri: job.referenceAssetUri },
        }));
      } else for (const shot of project.shots) shot.visual = { type: 'generate', task: job.mode, provider: providerId!, prompt: instruction, seed: 42 };
      const projectFile = resolve(directory, 'project.json');
      // Validate every workflow and asset before invoking the voice or video services.
      await json(projectFile, project);
      await plan(projectFile);
      let originalWords: WordUtterance[] = [];
      if (directed) {
        if (provider!.type !== 'volcengine-ark' || config.voice?.type !== 'doubao') throw new Error('三机位导演流程需要火山视频与豆包语音配置');
        const productionOut = resolve(directory, 'production');
        if (project.audio.type !== 'mute') {
          await update('transcribing', '正在由豆包识别原台词、说话人与逐词时间');
          originalWords = await transcribeWords(config.voice, new ArkClient(provider!, resolve(productionOut, 'uploads')), resolve(directory, 'analysis/reference.wav'), project.shots.at(-1)!.end as number, resolve(productionOut, 'source-asr'), log);
        }
        const available = (await readdir(resolve(directory, 'analysis/frames'))).filter(name => /\.jpg$/i.test(name)).sort();
        const frameNames = available.length <= 24 ? available : Array.from({ length: 24 }, (_, i) => available[Math.round(i * (available.length - 1) / 23)]);
        const frames = frameNames.map(name => resolve(directory, 'analysis/frames', name));
        const directorVideo = resolve(productionOut, 'reference.mp4');
        await mkdir(productionOut, { recursive: true });
        await ffmpeg(['-i', job.reference, '-an', '-vf', "scale=w='min(640,iw)':h=-2,setsar=1", '-c:v', 'libx264', '-preset', 'fast', '-crf', '24', '-pix_fmt', 'yuv420p', directorVideo]);
        await update('analyzing', '正在准备共享三机位与逐句角色、动作、表达计划');
        const director = await directProduction({ ark: provider!, model: config.production.directorModel!, mode: job.mode, subject: job.subject, frames, utterances: originalWords, referenceVideo: directorVideo, duration: project.shots.at(-1)!.end as number, out: productionOut, timeoutSeconds: config.production.requestTimeoutSeconds, log });
        project.production = { version: 1, imageModel: config.production.imageModel!, directorModel: config.production.directorModel!, imageSize: config.production.imageSize, requestTimeoutSeconds: config.production.requestTimeoutSeconds, speech: config.voice, plan: director, frames, utterances: originalWords };
        project.words = originalWords.flatMap(utterance => utterance.words).map((word, i) => ({ id: `source-word-${i + 1}`, ...word }));
        project.captions = { enabled: originalWords.length > 0, wordsPerLine: 12 };
        await json(projectFile, project);
      }
      if (config.engine === 'hypit') {
        await update('analyzing', '正在检查 Hypit 分镜与火山服务连接配置');
        await checkHypitProject(projectFile, resolve(directory, 'output'));
      }
      if (withVoice) {
        const voiceOut = resolve(directory, 'voice');
        let audio: string;
        if (directed) {
          if (!project.production || !selectedVoice || config.voice?.type !== 'doubao') throw new Error('导演配音需要已确认的豆包音色');
          const targetRoles = new Set(project.production.plan.roles.filter(role => role.replaceVoice).map(role => role.id));
          const selected = project.production.plan.lines.filter(line => targetRoles.has(line.role)).map(line => originalWords[line.utterance]);
          if (!selected.length) throw new Error('导演计划没有可替换声音的主持人台词，已停止配音');
          await update('voice', `使用已确定音色“${selectedVoice.name}”替换主持人台词，保留其他角色原声`);
          audio = await synthesizeNarration(config.voice, selectedVoice.speaker, selected.sort((a, b) => a.start - b.start), project.shots.at(-1)!.end as number, voiceOut, log, selectedVoice.directory, selected.length < originalWords.length ? job.reference : undefined);
        } else if (conversion) {
          if (!selectedVoice || !config.voiceConversion) throw new Error('音色转换需要选择已确定音色并配置 VC 服务');
          await update('voice', `正在将原音频转换为“${selectedVoice.name}”的音色，尽量保留原表达`);
          audio = await convertVoice(job.reference, selectedVoice.sample, project.shots.map(s => ({ start: s.start as number, end: s.end as number })), config.voiceConversion, voiceOut, log);
        } else if (config.voice!.type === 'doubao') {
          if (provider!.type !== 'volcengine-ark') throw new Error('豆包自动台词流程需要配置方舟素材上传服务');
          const duration = project.shots.at(-1)!.end as number;
          await update('transcribing', '正在识别原视频台词');
          const ark = new ArkClient(provider!, resolve(voiceOut, 'uploads'));
          const utterances = await transcribe(config.voice!, ark, resolve(directory, 'analysis/reference.wav'), duration, voiceOut, log);
          await logQueue;
          await update('cloning', selectedVoice ? `使用已确定音色：${selectedVoice.name}` : '正在准备豆包目标音色');
          const speaker = selectedVoice?.speaker || await cloneSpeaker(config.voice!, job.voice, voiceOut, log);
          await logQueue;
          await update('voice', '正在用豆包目标音色合成台词并对齐时间');
          audio = await synthesizeNarration(config.voice!, speaker, utterances, duration, voiceOut, log, selectedVoice?.directory);
          project.words = utterances.map((item, i) => ({ id: `sentence-${i + 1}`, ...item }));
          // These are sentence boundaries, not fabricated word-level TTS timestamps.
          project.captions = { enabled: true, wordsPerLine: 1 };
          for (const shot of project.shots) {
            if (shot.visual.type === 'generate' && job.mode === 'presenter') {
              const text = utterances.filter(u => u.end > (shot.start as number) && u.start < (shot.end as number)).map(u => u.text).join('');
              shot.visual.prompt += ` 台词只采用参考音频中的内容，当前片段台词参考：${text}`;
            }
          }
        } else {
          if (!job.voice) throw new Error('本地声音转换需要上传目标录音');
          await update('voice', '正在将参考台词转换为目标音色');
          audio = await convertVoice(job.reference, job.voice, project.shots.map(s => ({ start: s.start as number, end: s.end as number })), config.voice!, voiceOut, log);
        }
        await logQueue;
        project.assets.narration = { path: audio, kind: 'audio' };
        project.audio = { type: 'asset', asset: 'narration', offset: 0 };
        await json(projectFile, project);
      }
      await update('generating', '正在生成替换画面');
      await render(projectFile, resolve(directory, 'output'), log, config.engine);
      await logQueue;
      await update('complete', '视频已完成，可以预览和下载');
    } catch (error) {
      await logQueue.catch(() => {});
      if (error instanceof VoiceConsentRequired) {
        await update(error.review.stage === 'register' ? 'awaiting_voice_upload' : 'awaiting_voice_activation', error.message);
        return;
      }
      await update('failed', safeMessage(error instanceof Error ? error.message : '处理失败'));
    }
  }
}
