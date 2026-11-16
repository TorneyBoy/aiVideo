import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile, utimes } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { localMaterialConfigSchema, arkConfigSchema } from '../src/schema.ts';
import { cleanupLocalMaterials, publishLocalMaterial, serveLocalMaterial } from '../src/local-materials.ts';
import { createApp } from '../src/server.ts';
import { cloudConfigurationStatus } from '../src/cloud-config.ts';
import { json } from '../src/files.ts';

async function fixture() {
  await mkdir('runs', { recursive: true });
  const root = await mkdtemp(resolve('runs/local-material-test-'));
  const source = join(root, 'source.wav'), bytes = Buffer.from('RIFF-test-local-private-audio-bytes');
  await writeFile(source, bytes);
  process.env.LOCAL_MATERIAL_TEST_KEY = 'local-material-test-secret-32-bytes-minimum';
  const config = localMaterialConfigSchema.parse({ type: 'local', directory: join(root, 'materials'), publicBaseUrl: 'http://127.0.0.1:1', signingKeyEnv: 'LOCAL_MATERIAL_TEST_KEY', minDiskFreeBytes: 0 });
  return { root, source, bytes, config };
}

test('signed local material URLs preserve bytes, support HEAD/ranges, and reject tampering, expiry and key rotation', async () => {
  const { source, bytes, config } = await fixture();
  const server = createServer((req, res) => { void serveLocalMaterial(config, req, res, new URL(req.url!, config.publicBaseUrl)).catch(() => { res.writeHead(500); res.end(); }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  config.publicBaseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const url = await publishLocalMaterial(config, source, 'audio/wav', 'account-a');
    assert.deepEqual(Buffer.from(await (await fetch(url)).arrayBuffer()), bytes);
    const head = await fetch(url, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(bytes.length)); assert.equal((await head.arrayBuffer()).byteLength, 0);
    const range = await fetch(url, { headers: { Range: 'bytes=2-7' } }); assert.equal(range.status, 206); assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(2, 8));
    const suffix = await fetch(url, { headers: { Range: 'bytes=-4' } }); assert.equal(suffix.status, 206); assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), bytes.subarray(-4));
    assert.equal((await fetch(url, { headers: { Range: 'bytes=99999-' } })).status, 416);
    assert.equal((await fetch(url, { headers: { Range: 'bytes=-0' } })).status, 416);
    assert.equal((await fetch(url, { method: 'POST' })).status, 405);
    const tampered = new URL(url); tampered.searchParams.set('expires', String(Number(tampered.searchParams.get('expires')) + 500));
    assert.equal((await fetch(tampered)).status, 403);
    const expired = new URL(url), expires = Math.floor(Date.now() / 1000) - 1;
    expired.searchParams.set('expires', String(expires));
    expired.searchParams.set('signature', createHmac('sha256', process.env.LOCAL_MATERIAL_TEST_KEY!).update(`v1\n${new URL(config.publicBaseUrl).origin}\n${expired.pathname}\n${expires}`).digest('hex'));
    assert.equal((await fetch(expired)).status, 403);
    assert.equal((await fetch(url + '&expires=1')).status, 403);
    process.env.LOCAL_MATERIAL_TEST_KEY = 'rotated-material-test-secret-32-bytes-minimum';
    assert.equal((await fetch(url)).status, 403);
  } finally { await new Promise<void>(accept => server.close(() => accept())); }
});

test('cleanup removes only expired published copies; live renewed links, originals and independent voices survive', async () => {
  const { root, source, bytes, config } = await fixture();
  const voice = join(root, 'voices', 'confirmed.wav'); await mkdir(join(root, 'voices')); await writeFile(voice, bytes);
  const urls = await Promise.all(Array.from({ length: 4 }, () => publishLocalMaterial(config, source, 'audio/wav', 'account-a')));
  assert.equal(new Set(urls.map(url => new URL(url).pathname)).size, 1); assert.equal((await readdir(join(config.directory, 'objects'))).length, 1);
  assert.equal((await cleanupLocalMaterials(config)).removed, 0);
  const before = Math.floor(Date.now() / 1000), candidateExpiry = before + config.retentionSeconds + 10;
  config.retentionSeconds *= 2;
  await publishLocalMaterial(config, source, 'audio/wav', 'account-a');
  assert.equal((await cleanupLocalMaterials(config, candidateExpiry)).removed, 0, 'a renewed record is checked again under the cross-process lock');
  const cleared = await cleanupLocalMaterials(config, before + config.retentionSeconds + 100);
  assert.equal(cleared.removed, 1); assert.equal(cleared.bytes, bytes.length);
  assert.deepEqual(await readFile(source), bytes); assert.deepEqual(await readFile(voice), bytes);
  assert.equal((await readdir(join(config.directory, 'objects'))).length, 0);
  const orphan = join(config.directory, 'objects', 'a'.repeat(64) + '.wav'); await writeFile(orphan, bytes);
  await utimes(orphan, new Date(0), new Date(0));
  assert.equal((await cleanupLocalMaterials(config)).orphanRemoved, 1);
  const unrelated = join(root, 'existing-project'); await mkdir(unrelated); await writeFile(join(unrelated, 'keep.txt'), 'keep');
  await assert.rejects(cleanupLocalMaterials({ ...config, directory: unrelated }), /拒绝接管/);
  assert.equal(await readFile(join(unrelated, 'keep.txt'), 'utf8'), 'keep');
});

test('published storage enforces quota, isolates accounts and never stores signing credentials', async () => {
  const { source, config } = await fixture();
  const large = Buffer.alloc(700, 1); await writeFile(source, large); config.maxStorageBytes = 1024;
  const first = await publishLocalMaterial(config, source, 'audio/wav', 'account-a');
  assert.equal(new URL(await publishLocalMaterial(config, source, 'audio/wav', 'account-a')).pathname, new URL(first).pathname);
  await assert.rejects(publishLocalMaterial(config, source, 'audio/wav', 'account-b'), /配额/);
  for (const name of await readdir(join(config.directory, 'records'))) assert.doesNotMatch(await readFile(join(config.directory, 'records', name), 'utf8'), /local-material-test-secret|signature|account-a/);
  assert.throws(() => localMaterialConfigSchema.parse({ ...config, publicBaseUrl: 'http://example.com' }));
  assert.throws(() => localMaterialConfigSchema.parse({ ...config, retentionSeconds: config.urlTtlSeconds }));
  const status = cloudConfigurationStatus({ MATERIAL_STORAGE: 'local', MATERIAL_PUBLIC_BASE_URL: 'https://video.example.com', MATERIAL_SIGNING_KEY: process.env.LOCAL_MATERIAL_TEST_KEY });
  const storage = status.sections.find(section => section.label === '服务器本地素材存储')!;
  assert.ok(storage.fields.every(field => field.present)); assert.doesNotMatch(JSON.stringify(status), /TOS_ACCESS_KEY_ID|local-material-test-secret/);
});

test('workbench authentication remains required while valid signed model downloads need no login', async () => {
  const { root, source, bytes, config } = await fixture();
  const keys = ['AIVIDEO_CONFIG', 'APP_AUTH_USER', 'APP_AUTH_PASSWORD', 'APP_PUBLIC_URL', 'MATERIAL_PUBLIC_BASE_URL'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.AIVIDEO_CONFIG = join(root, 'runtime.json'); process.env.APP_AUTH_USER = 'test-user'; process.env.APP_AUTH_PASSWORD = 'test-private-workbench-password'; process.env.APP_PUBLIC_URL = 'https://video.example.com/aiVideo'; delete process.env.MATERIAL_PUBLIC_BASE_URL;
  const ark = arkConfigSchema.parse({ type: 'volcengine-ark', url: 'https://example.com', model: 'no-submission', storage: config });
  const profile = { providers: { volcano: ark } }; await json(process.env.AIVIDEO_CONFIG, profile);
  const { server } = createApp(join(root, 'jobs')); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/aiVideo`;
  try {
    config.publicBaseUrl = base; ark.storage = config; await json(process.env.AIVIDEO_CONFIG!, profile);
    assert.equal((await fetch(base + '/api/status')).status, 401);
    const headers = { Authorization: 'Basic ' + Buffer.from('test-user:test-private-workbench-password').toString('base64') };
    assert.equal((await fetch(base + '/api/status', { headers })).status, 200);
    const html = await (await fetch(base + '/', { headers })).text(); assert.match(html, /src="\.\/app.js"/);
    assert.equal((await fetch(base + '/app.js', { headers })).status, 200);
    assert.equal((await fetch(new URL('/api/status', base), { headers })).status, 404, 'root URLs do not escape the configured prefix');
    assert.equal((await fetch(base + '/api/status', { headers: { ...headers, Origin: 'https://attacker.example' } })).status, 403);
    const url = await publishLocalMaterial(config, source, 'audio/wav', 'test-account');
    const response = await fetch(url); assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.equal((await fetch(base + '/media/not-a-file')).status, 403);
    assert.equal((await fetch(base + '/.env', { headers })).status, 404);
  } finally {
    await new Promise<void>(accept => server.close(() => accept()));
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
});
