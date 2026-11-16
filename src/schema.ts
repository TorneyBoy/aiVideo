import { z } from 'zod';
import { productionSchema } from './production-config.ts';

const id = z.string().regex(/^[a-zA-Z0-9_-]+$/, 'ID 只能包含字母、数字、下划线或短横线');
const time = z.union([
  z.number().finite().nonnegative(),
  z.object({ word: id, edge: z.enum(['start', 'end']), offset: z.number().finite().default(0) }).strict(),
]);
export const wordSchema = z.object({
  id, text: z.string().min(1), start: z.number().finite().nonnegative(), end: z.number().finite().positive(),
}).strict();
export const transcriptSchema = z.array(wordSchema).min(1);
const assetSchema = z.object({ path: z.string().min(1), kind: z.enum(['image', 'video', 'audio']) }).strict();
const bindingSchema = z.object({
  node: z.string().min(1), input: z.string().min(1),
  value: z.enum(['referenceVideo', 'subjectImage', 'audio', 'prompt', 'seed', 'width', 'height', 'fps', 'frameCount']),
}).strict();
export const comfyConfigSchema = z.object({
  type: z.literal('comfyui'), url: z.url(), tokenEnv: z.string().min(1).optional(),
  workflow: z.string().min(1), bindings: z.array(bindingSchema).min(1),
  outputNode: z.string().min(1), outputField: z.enum(['gifs', 'videos']).default('gifs'),
  timeoutSeconds: z.number().int().min(1).max(86400).default(1800),
}).strict();
export const tosConfigSchema = z.object({
  bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
  region: z.string().regex(/^[a-z]+(?:-[a-z0-9]+)+$/),
  endpoint: z.string().regex(/^(?:https:\/\/)?tos-[a-z0-9-]+\.volces\.com$|^http:\/\/127\.0\.0\.1:\d+$/).optional(),
  accessKeyEnv: z.string().default('TOS_ACCESS_KEY_ID'), secretKeyEnv: z.string().default('TOS_SECRET_ACCESS_KEY'),
  sessionTokenEnv: z.string().default('TOS_SECURITY_TOKEN'),
  prefix: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_/-]*$/).default('aivideo'),
  urlTtlSeconds: z.number().int().min(3600).max(604800).default(21600),
}).strict();
export type TosConfig = z.infer<typeof tosConfigSchema>;
export const localMaterialConfigSchema = z.object({
  type: z.literal('local'), directory: z.string().min(1),
  publicBaseUrl: z.url().refine(value => {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash && /^\/(?:[A-Za-z0-9_-]+\/?)*$/.test(url.pathname)
      && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
  }, '素材地址必须为 HTTPS 地址，可带 /aiVideo 路径前缀（本机测试可使用 HTTP）'),
  signingKeyEnv: z.string().default('MATERIAL_SIGNING_KEY'),
  urlTtlSeconds: z.number().int().min(3600).max(604800).default(21600),
  retentionSeconds: z.number().int().min(3600).max(2592000).default(86400),
  cleanupIntervalSeconds: z.number().int().min(10).max(86400).default(900),
  maxStorageBytes: z.number().int().min(1024).default(2147483648),
  minDiskFreeBytes: z.number().int().nonnegative().default(2147483648),
}).strict().refine(value => value.retentionSeconds >= value.urlTtlSeconds + 300,
  '素材保留时间必须比临时链接有效期至少多 300 秒');
export type LocalMaterialConfig = z.infer<typeof localMaterialConfigSchema>;
export const materialStorageSchema = z.union([localMaterialConfigSchema, tosConfigSchema]);
export type MaterialStorageConfig = z.infer<typeof materialStorageSchema>;
export function isLocalMaterialStorage(config: MaterialStorageConfig): config is LocalMaterialConfig {
  return 'type' in config && config.type === 'local';
}
export const arkConfigSchema = z.object({
  type: z.literal('volcengine-ark'), url: z.url(), tokenEnv: z.string().default('ARK_API_KEY'),
  model: z.string().min(1), family: z.enum(['seedance-2.0', 'seedance-2.5']).default('seedance-2.0'),
  resolution: z.enum(['480p', '720p', '1080p']).default('720p'),
  timeoutSeconds: z.number().int().min(1).max(86400).default(3600),
  pollIntervalMs: z.number().int().min(10).max(30000).default(3000),
  storage: materialStorageSchema.optional(),
}).strict();
export const providerSchema = z.discriminatedUnion('type', [comfyConfigSchema, arkConfigSchema]);
export const assetUriSchema = z.string().regex(/^asset:\/\/[A-Za-z0-9_-]+$/, '请填写有效的 asset://素材ID');
export const projectSchema = z.object({
  version: z.literal(1), name: z.string().min(1), reference: z.string().min(1),
  output: z.object({
    width: z.number().int().min(64).max(4096).refine(n => n % 2 === 0, '宽度必须为偶数'),
    height: z.number().int().min(64).max(4096).refine(n => n % 2 === 0, '高度必须为偶数'),
    fps: z.number().int().min(1).max(60),
  }).strict(),
  assets: z.record(id, assetSchema).default({}),
  subjects: z.object({ presenter: id.optional(), product: id.optional() }).strict().default({}),
  providers: z.record(id, providerSchema).default({}),
  production: productionSchema.optional(),
  words: z.array(wordSchema).default([]),
  captions: z.object({ enabled: z.boolean(), wordsPerLine: z.number().int().min(1).max(30).default(8) }).strict().default({ enabled: false, wordsPerLine: 8 }),
  audio: z.discriminatedUnion('type', [
    z.object({ type: z.literal('reference') }).strict(),
    z.object({ type: z.literal('mute') }).strict(),
    z.object({ type: z.literal('asset'), asset: id, offset: z.number().nonnegative().default(0) }).strict(),
  ]).default({ type: 'reference' }),
  shots: z.array(z.object({
    id, start: time, end: time,
    visual: z.discriminatedUnion('type', [
      z.object({ type: z.literal('reference') }).strict(),
      z.object({ type: z.literal('asset'), asset: id, offset: z.number().nonnegative().default(0) }).strict(),
      z.object({ type: z.literal('generate'), provider: id, task: z.enum(['presenter', 'product']), prompt: z.string().min(1), seed: z.number().int().min(0).max(2147483647).default(1), subjectAssetUri: assetUriSchema.optional(), referenceAssetUri: assetUriSchema.optional() }).strict(),
    ]),
  }).strict()).min(1),
}).strict();

export type Project = z.infer<typeof projectSchema>;
export type Word = z.infer<typeof wordSchema>;
export type Time = z.infer<typeof time>;
export type Shot = Project['shots'][number];
export type ProviderConfig = Project['providers'][string];
export type ComfyConfig = z.infer<typeof comfyConfigSchema>;
export type ArkConfig = z.infer<typeof arkConfigSchema>;
