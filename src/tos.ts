import { TosClient } from '@volcengine/tos-sdk';
import { extname } from 'node:path';
import { hashFile } from './files.ts';
import { safeMessage, secret } from './cloud-http.ts';
import type { TosConfig } from './schema.ts';

/** Private objects and temporary GET links. Never changes bucket policy or ACL. */
export async function uploadPrivateMaterial(config: TosConfig, path: string, mime: string, scope: string): Promise<string> {
  const endpoint = config.endpoint || `tos-${config.region}.volces.com`;
  const loopback = endpoint.startsWith('http://127.0.0.1:');
  const client = new TosClient({
    accessKeyId: secret(config.accessKeyEnv), accessKeySecret: secret(config.secretKeyEnv),
    stsToken: process.env[config.sessionTokenEnv]?.trim() || undefined,
    region: config.region, endpoint: endpoint.replace(/^https?:\/\//, ''),
    secure: !loopback, forcePathStyle: loopback,
    connectionTimeout: 10000, requestTimeout: 180000, maxRetryCount: 0,
  });
  const key = `${config.prefix.replace(/\/+$/, '')}/${scope.slice(0, 24)}/${await hashFile(path)}${extname(path).toLowerCase()}`;
  try {
    try { await client.headObject({ bucket: config.bucket, key }); }
    catch (error) {
      const failure = error as { statusCode?: number; response?: { status?: number } };
      if ((failure.statusCode || failure.response?.status) !== 404) throw error;
      await client.putObjectFromFile({ bucket: config.bucket, key, filePath: path, contentType: mime });
    }
    // SDK signing does not inherit forcePathStyle; retain a usable loopback URL in tests.
    return client.getPreSignedUrl({ bucket: config.bucket, key: loopback ? `${config.bucket}/${key}` : key,
      isCustomDomain: loopback, method: 'GET', expires: config.urlTtlSeconds });
  } catch (error) {
    throw new Error(`TOS 素材上传失败：${safeMessage(error instanceof Error ? error.message : error)}`);
  }
}
