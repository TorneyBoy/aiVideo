import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseEnv } from 'node:util';
import { loadLocalEnvironment } from '../src/env.ts';

loadLocalEnvironment();
const directory = resolve('runs/deployment'); await mkdir(directory, { recursive: true });
const envPath = join(directory, '.env.server');
let previous = {};
try { previous = parseEnv(await readFile(envPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const keys = ['ARK_API_KEY', 'ARK_VIDEO_MODEL', 'ARK_BASE_URL', 'ARK_VIDEO_FAMILY', 'ARK_VIDEO_RESOLUTION', 'ARK_IMAGE_MODEL', 'ARK_DIRECTOR_MODEL', 'VOICE_PROVIDER', 'VOLC_SPEECH_API_KEY', 'VOLC_SPEECH_APP_ID', 'VOLC_SPEECH_ACCESS_TOKEN', 'VOLC_SPEECH_BASE_URL', 'VOLC_SPEECH_RESOURCE_ID', 'VOLC_ASR_RESOURCE_ID', 'VOLC_SPEECH_SPEAKER_ID', 'VOLC_SPEECH_CLONE_SPEAKER_ID', 'VOLC_SPEECH_LANGUAGE', 'VOLC_SPEECH_RATE'];
const values = Object.fromEntries(keys.filter(key => process.env[key]?.trim()).map(key => [key, process.env[key]]));
Object.assign(values, {
  APP_PUBLIC_URL: 'https://huayuan.ink/aiVideo', APP_AUTH_USER: previous.APP_AUTH_USER || process.env.APP_AUTH_USER || 'aivideo',
  APP_AUTH_PASSWORD: previous.APP_AUTH_PASSWORD || randomBytes(24).toString('base64url'),
  MATERIAL_STORAGE: 'local', MATERIAL_DIRECTORY: '/app/runs/materials', MATERIAL_PUBLIC_BASE_URL: 'https://huayuan.ink/aiVideo',
  MATERIAL_SIGNING_KEY: previous.MATERIAL_SIGNING_KEY || randomBytes(32).toString('base64url'),
  MATERIAL_URL_TTL_SECONDS: '21600', MATERIAL_RETENTION_SECONDS: '86400', MATERIAL_CLEANUP_INTERVAL_SECONDS: '900',
  MATERIAL_MAX_BYTES: '2147483648', MATERIAL_MIN_FREE_BYTES: '2147483648',
});
await writeFile(envPath, Object.entries(values).map(([key, value]) => key + '=' + JSON.stringify(value)).join('\n') + '\n', { mode: 0o600 });
const archive = join(directory, 'aivideo-release.tar.gz');
await new Promise((accept, reject) => {
  const args = ['-czf', archive, '--exclude=node_modules', '--exclude=.git', '--exclude=runtime.json', '--exclude=.env', '--exclude=.env.*', '--exclude=server.json', '--exclude=runs', '--exclude=data', '--exclude=secrets',
    'package.json', 'package-lock.json', '.dockerignore', 'README.md', 'src', 'web', 'config', 'integrations', 'scripts', 'deploy', 'vendor/hypit'];
  const child = spawn('tar', args, { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
  child.once('error', reject); child.once('close', code => code === 0 ? accept() : reject(new Error('Source packaging failed')));
});
const bytes = await readFile(archive);
const manifest = { project: 'aivideo-replica', remoteRoot: '/opt/aivideo-replica', publicUrl: values.APP_PUBLIC_URL + '/', internalPort: 14173,
  sha256: createHash('sha256').update(bytes).digest('hex'), archiveBytes: bytes.length, realModelCalls: 0, realVoiceSlotOperations: 0 };
await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
