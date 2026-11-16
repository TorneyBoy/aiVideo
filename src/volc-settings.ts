import { resolve } from 'node:path';
import { arkConfigSchema, localMaterialConfigSchema } from './schema.ts';
import { doubaoConfigSchema } from './speech-config.ts';
import type { DoubaoConfig } from './speech-config.ts';
export { doubaoConfigSchema } from './speech-config.ts';
export type { DoubaoConfig } from './speech-config.ts';

export function environmentCloudConfig() {
  const env = process.env;
  const provider = (env.VOICE_PROVIDER || 'volcengine').toLowerCase();
  const voiceSelected = ['volcengine', 'doubao', 'doobao'].includes(provider);
  const storageMode = env.MATERIAL_STORAGE?.trim() || (env.TOS_BUCKET?.trim() ? 'tos' : 'local');
  if (!['local', 'tos'].includes(storageMode)) throw new Error('MATERIAL_STORAGE 只能填写 local 或 tos');
  const localStorage = storageMode === 'local' && env.MATERIAL_PUBLIC_BASE_URL?.trim() ? localMaterialConfigSchema.parse({
    type: 'local', directory: resolve(env.MATERIAL_DIRECTORY || 'runs/materials'),
    publicBaseUrl: env.MATERIAL_PUBLIC_BASE_URL.trim(),
    urlTtlSeconds: Number(env.MATERIAL_URL_TTL_SECONDS || 21600),
    retentionSeconds: Number(env.MATERIAL_RETENTION_SECONDS || 86400),
    cleanupIntervalSeconds: Number(env.MATERIAL_CLEANUP_INTERVAL_SECONDS || 900),
    maxStorageBytes: Number(env.MATERIAL_MAX_BYTES || 2147483648),
    minDiskFreeBytes: Number(env.MATERIAL_MIN_FREE_BYTES || 2147483648),
  }) : undefined;
  const video = env.ARK_VIDEO_MODEL?.trim() ? arkConfigSchema.parse({
    type: 'volcengine-ark', url: env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3',
    model: env.ARK_VIDEO_MODEL.trim(), family: env.ARK_VIDEO_FAMILY || (env.ARK_VIDEO_MODEL.includes('2-5') ? 'seedance-2.5' : 'seedance-2.0'),
    resolution: env.ARK_VIDEO_RESOLUTION || '720p',
    storage: localStorage || (storageMode === 'tos' && env.TOS_BUCKET?.trim() ? {
      bucket: env.TOS_BUCKET.trim(), region: env.TOS_REGION || 'cn-beijing', endpoint: env.TOS_ENDPOINT?.trim() || undefined,
      prefix: env.TOS_PREFIX || 'aivideo', urlTtlSeconds: Number(env.TOS_URL_TTL_SECONDS || 21600),
    } : undefined),
  }) : undefined;
  const voice = voiceSelected ? doubaoConfigSchema.parse({
    type: 'doubao', url: env.VOLC_SPEECH_BASE_URL || 'https://openspeech.bytedance.com',
    resourceId: env.VOLC_SPEECH_RESOURCE_ID || 'seed-icl-2.0',
    asrResourceId: env.VOLC_ASR_RESOURCE_ID || 'volc.seedasr.auc',
    speakerId: env.VOLC_SPEECH_SPEAKER_ID?.trim() || undefined,
    cloneSpeakerId: env.VOLC_SPEECH_CLONE_SPEAKER_ID?.trim() || undefined,
    language: env.VOLC_SPEECH_LANGUAGE || 'cn', speechRate: Number(env.VOLC_SPEECH_RATE || 0),
  }) : undefined;
  return { video, voice };
}

export function hasSpeechCredentials(config: DoubaoConfig): boolean {
  return !!(process.env[config.apiKeyEnv]?.trim() || (process.env[config.appIdEnv]?.trim() && process.env[config.accessTokenEnv]?.trim()));
}
