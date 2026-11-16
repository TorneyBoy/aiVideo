import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { runtime } from './config.ts';
import { activateSpeaker, cloneSpeaker } from './doubao.ts';
import { safeMessage } from './cloud-http.ts';
import { hashFile, json, readJson } from './files.ts';
import { extractAudio, probe } from './media.ts';
import { approveVoiceReview, readVoiceReview, VoiceConsentRequired } from './voice-consent.ts';
import { voiceAccount } from './voice-account.ts';
import { doubaoConfigSchema } from './volc-settings.ts';
import { validateSavedVoice } from './saved-voice.ts';

const uuid = z.string().uuid();
const profileSchema = z.object({
  version: z.literal(1), id: uuid, name: z.string().trim().min(1).max(60),
  created: z.string(), updated: z.string(), sampleHash: z.string(), confirmedRound: uuid.optional(),
}).strict();
const roundSchema = z.object({
  version: z.literal(1), id: uuid, profileId: uuid, created: z.string(), updated: z.string(),
  text: z.string().trim().min(4).max(300), sampleHash: z.string(), account: z.string(), config: doubaoConfigSchema,
  state: z.enum(['queued', 'testing', 'preview', 'activating', 'ready', 'failed']), operation: z.enum(['test', 'activate']),
  uploadApprovedAt: z.string(), activationApprovedAt: z.string().optional(), reviewId: uuid,
  speaker: z.string().optional(), message: z.string(), logs: z.array(z.string()).default([]),
}).strict();
export type VoiceProfile = z.infer<typeof profileSchema>;
export type VoiceRound = z.infer<typeof roundSchema>;

/** Independent from video jobs. Every audition is a temporary candidate; only the chosen one is activated. */
export class VoiceLibrary {
  root: string;
  active = new Set<string>();
  queue: Promise<void> = Promise.resolve();
  constructor(root: string) { this.root = resolve(root); }
  path(id: string, roundId?: string) { return roundId ? resolve(this.root, uuid.parse(id), 'rounds', uuid.parse(roundId)) : resolve(this.root, uuid.parse(id)); }
  async get(id: string) { return profileSchema.parse(await readJson(resolve(this.path(id), 'profile.json'))); }
  async round(id: string, roundId: string) { return roundSchema.parse(await readJson(resolve(this.path(id, roundId), 'round.json'))); }
  async save(profile: VoiceProfile) { profile.updated = new Date().toISOString(); await json(resolve(this.path(profile.id), 'profile.json'), profile); }
  async saveRound(round: VoiceRound) { round.updated = new Date().toISOString(); await json(resolve(this.path(round.profileId, round.id), 'round.json'), round); }
  busy(id: string) { return [...this.active].some(key => key.startsWith(`${id}/`)); }
  async create(id: string, name: string, input: string) {
    const info = await probe(input);
    if (!info.audio || info.duration < 3 || info.duration > 30) throw new Error('音色录音需要 3–30 秒清晰人声');
    await mkdir(this.path(id), { recursive: true });
    const sample = resolve(this.path(id), 'sample.wav');
    await extractAudio(input, sample);
    const now = new Date().toISOString();
    const profile = profileSchema.parse({ version: 1, id, name, created: now, updated: now, sampleHash: await hashFile(sample) });
    await this.save(profile); return profile;
  }
  async configuration() {
    const config = (await runtime()).voice;
    if (config?.type !== 'doubao') throw new Error('独立音色库当前需要豆包语音配置');
    // Never overwrite a configured prepaid slot while comparing temporary auditions.
    return doubaoConfigSchema.parse({ ...config, speakerId: undefined, cloneSpeakerId: undefined });
  }
  async addRound(id: string, text: string) {
    if (this.busy(id)) throw new Error('上一轮音色仍在处理，请完成后再测试');
    const roundId = randomUUID(), key = `${id}/${roundId}`; this.active.add(key);
    try {
    const profile = await this.get(id);
    if (profile.confirmedRound) throw new Error('此音色已经确定；如需更换录音，请创建新的候选音色');
    const config = await this.configuration(), directory = this.path(id, roundId);
    const source = resolve(this.path(id), 'sample.wav');
    if (await hashFile(source) !== profile.sampleHash) throw new Error('原始录音已改变，请重新建立候选音色');
    await mkdir(directory, { recursive: true }); await copyFile(source, resolve(directory, 'sample.wav'));
    const now = new Date().toISOString();
    const round = roundSchema.parse({ version: 1, id: roundId, profileId: id, text, sampleHash: profile.sampleHash,
      account: voiceAccount(config), config, created: now, updated: now, state: 'queued', operation: 'test',
      uploadApprovedAt: now, reviewId: randomUUID(), message: '等待注册试听', logs: [],
    });
    await this.saveRound(round); this.schedule(round); return round;
    } catch (error) { this.active.delete(key); throw error; }
  }
  schedule(round: VoiceRound) {
    const key = `${round.profileId}/${round.id}`;
    this.queue = this.queue.then(() => this.run(round.profileId, round.id)).catch(error => { console.error('音色处理异常', safeMessage(error instanceof Error ? error.message : error)); }).finally(() => { this.active.delete(key); });
  }
  enqueue(round: VoiceRound) {
    const key = `${round.profileId}/${round.id}`;
    if (this.busy(round.profileId)) throw new Error('此音色正在处理中');
    this.active.add(key);
    this.schedule(round);
  }
  async retry(id: string, roundId: string) {
    const profile = await this.get(id), round = await this.round(id, roundId);
    if (profile.confirmedRound || this.busy(id) || round.state === 'preview') throw new Error('此轮无需重试或仍在处理中');
    if (round.state === 'ready' && round.speaker && round.activationApprovedAt) {
      await validateSavedVoice(await this.checkedConfig(round, true), round.speaker, this.path(id, roundId));
      profile.confirmedRound = roundId; await this.save(profile); return;
    }
    round.state = 'queued'; await this.saveRound(round); this.enqueue(round);
  }
  async confirm(id: string, roundId: string, reviewId: string) {
    // Claim synchronously, before any await, to reject concurrent finalization requests.
    const key = `${id}/${roundId}`;
    if (this.busy(id)) throw new Error('此音色正在处理中，请勿重复确认');
    this.active.add(key);
    try {
      const profile = await this.get(id), round = await this.round(id, roundId);
      if (profile.confirmedRound || round.state !== 'preview' || round.reviewId !== reviewId) throw new Error('此试听不能确认或确认编号已失效');
      let tested = 0;
      for (const otherId of await readdir(resolve(this.path(id), 'rounds'))) {
        if (!uuid.safeParse(otherId).success) continue;
        const other = await this.round(id, otherId);
        if (other.state === 'preview' && await this.preview(id, otherId)) tested++;
      }
      if (tested < 2) throw new Error('请先完成至少两轮有效试听，再确认最终音色');
      if (Date.now() - Date.parse(round.created) >= 7 * 86400000) throw new Error('此试听已超过 7 天，请重新测试后确认');
      if (!await this.preview(id, roundId)) throw new Error('请先取得有效的复刻试听文件');
      round.activationApprovedAt = new Date().toISOString(); round.operation = 'activate'; round.state = 'queued';
      await this.saveRound(round);
      this.schedule(round);
    } catch (error) { this.active.delete(key); throw error; }
  }
  async checkedConfig(round: VoiceRound, forUse = false) {
    const current = await this.configuration();
    if (voiceAccount(current) !== round.account || current.resourceId !== round.config.resourceId || current.language !== round.config.language || (!forUse && current.speechRate !== round.config.speechRate)) throw new Error('语音账号或参数已经改变，请重新测试音色');
    if (await hashFile(resolve(this.path(round.profileId, round.id), 'sample.wav')) !== round.sampleHash) throw new Error('本轮录音已经改变，请重新测试音色');
    return current;
  }
  async run(id: string, roundId: string) {
    const round = await this.round(id, roundId), directory = this.path(id, roundId);
    const logs: string[] = [];
    const log = (message: string) => logs.push(safeMessage(message));
    try {
      const config = await this.checkedConfig(round);
      if (round.operation === 'test') {
        round.state = 'testing'; round.message = '正在注册本轮试听；未正式启用'; await this.saveRound(round);
        const clone = () => cloneSpeaker(config, resolve(directory, 'sample.wav'), directory, log, { id: round.id, text: round.text });
        try { round.speaker = await clone(); }
        catch (error) {
          if (!(error instanceof VoiceConsentRequired) || error.review.stage !== 'register' || !round.uploadApprovedAt) throw error;
          // This round exists only after an explicit upload-confirmed request, tied to its frozen sample/account.
          await this.checkedConfig(round); await approveVoiceReview(directory, 'register', error.review.id);
          round.speaker = await clone();
        }
        if (!await this.preview(id, roundId)) throw new Error('豆包尚未返回可播放试听；请重试查询本轮，不会调用正式合成');
        round.state = 'preview'; round.message = '试听已就绪，可继续测试其他文本或选择这一轮';
      } else {
        if (!round.activationApprovedAt || !round.speaker) throw new Error('缺少本轮正式使用确认');
        round.state = 'activating'; round.message = '正在正式启用所选音色；可能触发音色槽位费用'; await this.saveRound(round);
        const activate = () => activateSpeaker(config, round.speaker!, round.text, directory, log);
        let output: string;
        try { output = await activate(); }
        catch (error) {
          if (!(error instanceof VoiceConsentRequired) || error.review.stage !== 'activate') throw error;
          await this.checkedConfig(round); await approveVoiceReview(directory, 'activate', error.review.id); output = await activate();
        }
        await json(resolve(directory, 'confirmed.json'), { version: 1, speaker: round.speaker, account: round.account, sampleHash: round.sampleHash, activationHash: await hashFile(output), approvedAt: round.activationApprovedAt });
        round.state = 'ready'; round.message = '音色已确定，可在视频任务中选择复用';
        await this.saveRound(round);
        const profile = await this.get(id); profile.confirmedRound = round.id; await this.save(profile);
      }
    } catch (error) { round.state = 'failed'; round.message = safeMessage(error instanceof Error ? error.message : error); }
    round.logs = [...round.logs, ...logs].slice(-40); await this.saveRound(round);
  }
  async preview(id: string, roundId: string) {
    const directory = this.path(id, roundId);
    try {
      const meta = await readJson(resolve(directory, 'preview.json')) as { hash: string; sampleSignature: string };
      const registration = await readVoiceReview(directory, 'register');
      const file = resolve(directory, 'preview.wav');
      if (registration?.binding === meta.sampleSignature && await hashFile(file) === meta.hash) return file;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  async saved(id: string) {
    const profile = await this.get(id);
    if (!profile.confirmedRound) throw new Error('请先在音色库完成多轮试听并确认音色');
    const round = await this.round(id, profile.confirmedRound), config = await this.checkedConfig(round, true);
    if (round.state !== 'ready' || !round.speaker) throw new Error('所选音色尚未正式就绪');
    const directory = this.path(id, round.id); await validateSavedVoice(config, round.speaker, directory);
    return { name: profile.name, speaker: round.speaker, directory, sample: resolve(directory, 'sample.wav') };
  }
  async list() {
    await mkdir(this.root, { recursive: true });
    const items = [];
    for (const id of await readdir(this.root)) {
      if (!uuid.safeParse(id).success) continue;
      let profile: VoiceProfile;
      try { profile = await this.get(id); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      const rounds = [];
      const children = await readdir(resolve(this.path(id), 'rounds')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      for (const roundId of children) {
        if (!uuid.safeParse(roundId).success) continue;
        const round = await this.round(id, roundId), busy = this.active.has(`${id}/${roundId}`);
        const interrupted = !busy && ['queued', 'testing', 'activating'].includes(round.state);
        const expired = !['ready'].includes(round.state) && Date.now() - Date.parse(round.created) >= 7 * 86400000;
        rounds.push({ id: round.id, text: round.text, state: interrupted ? 'interrupted' : expired ? 'expired' : round.state,
          created: round.created, message: interrupted ? '服务已重启，可继续本轮' : round.message, hasPreview: !!await this.preview(id, roundId), reviewId: round.reviewId, logs: round.logs });
      }
      let selectable = false, issue: string | undefined;
      if (profile.confirmedRound) try { await this.saved(id); selectable = true; } catch (error) { issue = safeMessage(error instanceof Error ? error.message : error); }
      items.push({ id, name: profile.name, created: profile.created, confirmedRound: profile.confirmedRound, selectable, canConfirm: rounds.filter(item => item.hasPreview && ['preview', 'ready'].includes(item.state)).length >= 2, busy: this.busy(id), issue, rounds: rounds.sort((a, b) => a.created.localeCompare(b.created)) });
    }
    return items.sort((a, b) => b.created.localeCompare(a.created)).slice(0, 50);
  }
}
