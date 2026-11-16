import { z } from 'zod';

export const doubaoConfigSchema = z.object({
  type: z.literal('doubao'), url: z.url().default('https://openspeech.bytedance.com'),
  apiKeyEnv: z.string().default('VOLC_SPEECH_API_KEY'),
  appIdEnv: z.string().default('VOLC_SPEECH_APP_ID'), accessTokenEnv: z.string().default('VOLC_SPEECH_ACCESS_TOKEN'),
  resourceId: z.string().default('seed-icl-2.0'), asrResourceId: z.string().default('volc.seedasr.auc'),
  speakerId: z.string().optional(), cloneSpeakerId: z.string().optional(),
  timeoutSeconds: z.number().int().min(1).max(86400).default(10800),
  pollIntervalMs: z.number().int().min(10).max(30000).default(3000),
  language: z.enum(['cn', 'en']).default('cn'), speechRate: z.number().int().min(-50).max(100).default(0),
}).strict();
export type DoubaoConfig = z.infer<typeof doubaoConfigSchema>;
