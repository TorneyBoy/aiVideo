import { z } from 'zod';
import { doubaoConfigSchema } from './speech-config.ts';

export const runtimeProductionSchema = z.object({
  enabled: z.boolean().default(true), imageModel: z.string().min(1).optional(), directorModel: z.string().min(1).optional(),
  imageSize: z.enum(['2K', '4K']).default('2K'), requestTimeoutSeconds: z.number().int().min(1).max(600).default(180),
}).strict();
export const directorPlanSchema = z.object({
  version: z.literal(1), mode: z.enum(['presenter', 'product']), scene: z.string().min(1).max(1500),
  subject: z.string().min(1).max(1200),
  roles: z.array(z.object({ id: z.string().regex(/^[A-Z][A-Z0-9_]{0,23}$/), description: z.string().min(1).max(600), replaceVoice: z.boolean() }).strict()).min(1).max(6),
  cameras: z.array(z.object({ id: z.enum(['camera-1', 'camera-2', 'camera-3']), frameIndex: z.number().int().nonnegative(), description: z.string().min(1).max(1000) }).strict()).length(3),
  lines: z.array(z.object({ utterance: z.number().int().nonnegative(), role: z.string(), camera: z.enum(['camera-1', 'camera-2', 'camera-3']), action: z.string().min(1).max(600), delivery: z.string().min(1).max(400), confidence: z.number().min(0).max(1) }).strict()).max(300),
}).strict();
export const productionSchema = z.object({
  version: z.literal(1), imageModel: z.string().min(1), directorModel: z.string().min(1),
  imageSize: z.enum(['2K', '4K']), requestTimeoutSeconds: z.number().int().min(1).max(600),
  speech: doubaoConfigSchema, plan: directorPlanSchema,
  frames: z.array(z.string().min(1)).min(1).max(24),
  utterances: z.array(z.object({ text: z.string().min(1), start: z.number().nonnegative(), end: z.number().positive(), words: z.array(z.object({ text: z.string().min(1), start: z.number().nonnegative(), end: z.number().positive() }).strict()).min(1), speaker: z.string().optional() }).strict()).max(300),
}).strict();
export type DirectorPlan = z.infer<typeof directorPlanSchema>;
export type Production = z.infer<typeof productionSchema>;
