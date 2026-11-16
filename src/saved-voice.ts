import { resolve } from 'node:path';
import { z } from 'zod';
import { hashFile, readJson } from './files.ts';
import { voiceAccount } from './voice-account.ts';
import type { DoubaoConfig } from './volc-settings.ts';

export const savedVoiceSchema = z.object({
  version: z.literal(1), speaker: z.string().min(1), account: z.string(),
  sampleHash: z.string(), activationHash: z.string(), approvedAt: z.string(),
}).strict();

/** A selectable voice must have a complete activation result and the same credential scope. */
export async function validateSavedVoice(config: DoubaoConfig, speaker: string, directory: string) {
  const saved = savedVoiceSchema.parse(await readJson(resolve(directory, 'confirmed.json')));
  if (saved.speaker !== speaker || saved.account !== voiceAccount(config)) throw new Error('音色所属语音账号或配置已改变，请重新核对音色库');
  if (saved.sampleHash !== await hashFile(resolve(directory, 'sample.wav')) || saved.activationHash !== await hashFile(resolve(directory, 'activation.wav'))) throw new Error('已确认音色的本地文件发生变化，请重新核对音色库');
  return saved;
}
