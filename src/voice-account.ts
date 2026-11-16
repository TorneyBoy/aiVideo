import { fingerprint } from './files.ts';
import { secret } from './cloud-http.ts';
import type { DoubaoConfig } from './volc-settings.ts';

export function voiceAccount(config: DoubaoConfig) {
  return fingerprint({ url: config.url, credential: process.env[config.apiKeyEnv]?.trim() || `${secret(config.appIdEnv)}:${secret(config.accessTokenEnv)}` });
}
