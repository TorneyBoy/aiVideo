import { isLocalMaterialStorage } from './schema.ts';
import type { MaterialStorageConfig } from './schema.ts';
import { publishLocalMaterial } from './local-materials.ts';

/** The model APIs receive the same temporary URL regardless of where bytes are stored. */
export async function publishMaterial(config: MaterialStorageConfig, path: string, mime: string, scope: string): Promise<string> {
  if (isLocalMaterialStorage(config)) return publishLocalMaterial(config, path, mime, scope);
  const { uploadPrivateMaterial } = await import('./tos.ts');
  return uploadPrivateMaterial(config, path, mime, scope);
}

export function materialStorageMissing(config?: MaterialStorageConfig): string[] {
  if (!config) return ['服务器素材存储（MATERIAL_PUBLIC_BASE_URL）'];
  if (isLocalMaterialStorage(config)) return Buffer.byteLength(process.env[config.signingKeyEnv]?.trim() || '') >= 32 ? [] : [`${config.signingKeyEnv}（至少32字节）`];
  return [config.accessKeyEnv, config.secretKeyEnv].filter(name => !process.env[name]?.trim());
}
