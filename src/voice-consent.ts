import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import { json, readJson } from './files.ts';

export const voiceStageSchema = z.enum(['register', 'activate']);
export type VoiceStage = z.infer<typeof voiceStageSchema>;
const reviewSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), stage: voiceStageSchema,
  binding: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.string(), approvedAt: z.string().optional(),
  details: z.object({ sampleName: z.string().optional(), speaker: z.string().optional(), characters: z.number().int().nonnegative().optional() }).strict().optional(),
}).strict();
export type VoiceReview = z.infer<typeof reviewSchema>;

export class VoiceConsentRequired extends Error {
  review: VoiceReview;
  constructor(review: VoiceReview) {
    super(review.stage === 'register' ? '等待你确认上传目标录音并注册试听音色' : '等待你试听并确认正式使用音色；首次合成可能触发后付费音色槽位费用');
    this.review = review;
  }
}

export async function readVoiceReview(out: string, stage: VoiceStage): Promise<VoiceReview | undefined> {
  try { return reviewSchema.parse(await readJson(resolve(out, `consent-${voiceStageSchema.parse(stage)}.json`))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

/** Bind each decision to the exact credential scope, sample/voice and operation. */
export async function requireVoiceConsent(out: string, stage: VoiceStage, binding: string, details?: VoiceReview['details']): Promise<void> {
  let review = await readVoiceReview(out, stage);
  if (review?.binding === binding && review.approvedAt) return;
  if (!review || review.binding !== binding) {
    review = { version: 1, id: randomUUID(), stage, binding, createdAt: new Date().toISOString(), details };
    await json(resolve(out, `consent-${stage}.json`), review);
  }
  throw new VoiceConsentRequired(review);
}

/** Called only by an explicit review action, never by retry or a generation adapter. */
export async function approveVoiceReview(out: string, stage: VoiceStage, id: string): Promise<void> {
  const review = await readVoiceReview(out, stage);
  if (!review || review.id !== id || review.approvedAt) throw new Error('确认已失效或已提交，请刷新后核对当前音色');
  await json(resolve(out, `consent-${stage}.json`), { ...review, approvedAt: new Date().toISOString() });
}
