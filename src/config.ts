import { resolve, dirname } from 'node:path';
import { z } from 'zod';
import { readJson } from './files.ts';
import { projectSchema } from './schema.ts';
import { voiceConfigSchema } from './voice.ts';
import { doubaoConfigSchema, environmentCloudConfig } from './volc-settings.ts';
import { runtimeProductionSchema } from './production-config.ts';
import { isLocalMaterialStorage } from './schema.ts';

export const runtimeSchema = z.object({
  engine: z.enum(['hypit', 'legacy']).default('hypit'),
  production: runtimeProductionSchema.default(() => runtimeProductionSchema.parse({})),
  providers: projectSchema.shape.providers,
  routes: z.object({ presenter: z.string().optional(), product: z.string().optional() }).strict().default({}),
  voice: z.union([doubaoConfigSchema, voiceConfigSchema.transform(value => ({ ...value, type: 'cosyvoice' as const }))]).optional(),
  voiceConversion: voiceConfigSchema.optional(),
}).strict();

export async function runtime() {
  const path = resolve(process.env.AIVIDEO_CONFIG || 'config/runtime.json');
  let input: unknown;
  try { input = await readJson(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; input = {}; }
  const config = runtimeSchema.parse(input);
  // An explicitly selected profile is isolated from automatic environment routing.
  if (!process.env.AIVIDEO_CONFIG) {
    const cloud = environmentCloudConfig();
    if (!Object.keys(config.providers).length && cloud.video) {
      config.providers.volcano = cloud.video;
      config.routes = { presenter: 'volcano', product: 'volcano' };
    }
    if (!config.voice && cloud.voice) config.voice = cloud.voice;
    config.production.imageModel ||= process.env.ARK_IMAGE_MODEL?.trim() || undefined;
    config.production.directorModel ||= process.env.ARK_DIRECTOR_MODEL?.trim() || undefined;
    if (!config.voiceConversion && process.env.VOICE_CONVERSION_URL?.trim()) config.voiceConversion = voiceConfigSchema.parse({ url: process.env.VOICE_CONVERSION_URL.trim(), tokenEnv: process.env.VOICE_CONVERSION_TOKEN?.trim() ? 'VOICE_CONVERSION_TOKEN' : undefined });
  }
  for (const provider of Object.values(config.providers)) {
    if (provider.type === 'comfyui') provider.workflow = resolve(dirname(path), provider.workflow);
    if (provider.type === 'volcengine-ark' && provider.storage && isLocalMaterialStorage(provider.storage)) provider.storage.directory = resolve(dirname(path), provider.storage.directory);
  }
  return config;
}
