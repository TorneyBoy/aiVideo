import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cloudConfigurationStatus, formatCloudStatus } from '../src/cloud-config.ts';

test('cloud inspection separates Ark credentials from speech credentials and never returns keys', () => {
  const env = { ARK_API_KEY: 'fake-video-secret', ARK_VIDEO_MODEL: 'test-model', ARK_IMAGE_MODEL: 'test-image', ARK_DIRECTOR_MODEL: 'test-director', VOLC_SPEECH_API_KEY: 'fake-speech-secret', VOLC_SPEECH_RESOURCE_ID: 'seed-icl-2.0', TOS_BUCKET: 'test-bucket', TOS_ACCESS_KEY_ID: 'fake-tos-key', TOS_SECRET_ACCESS_KEY: 'fake-tos-secret' };
  const status = cloudConfigurationStatus(env);
  assert.equal(status.complete, true);
  assert.doesNotMatch(JSON.stringify(status) + formatCloudStatus(status), /fake-video-secret|fake-speech-secret|fake-tos-key|fake-tos-secret/);
  assert.equal(cloudConfigurationStatus({ ...env, TOS_BUCKET: '' }).complete, false);
  assert.equal(cloudConfigurationStatus({ ARK_API_KEY: 'video-only' }).complete, false);
});

test('selected voice service validates its own credentials and supports old speech console pairs', () => {
  const video = { ARK_API_KEY: 'fake', ARK_VIDEO_MODEL: 'test-model', ARK_IMAGE_MODEL: 'test-image', ARK_DIRECTOR_MODEL: 'test-director', TOS_BUCKET: 'test-bucket', TOS_ACCESS_KEY_ID: 'fake-tos-key', TOS_SECRET_ACCESS_KEY: 'fake-tos-secret' };
  const old = { ...video, VOLC_SPEECH_APP_ID: 'id', VOLC_SPEECH_ACCESS_TOKEN: 'fake', VOLC_SPEECH_RESOURCE_ID: 'seed-icl-2.0' };
  assert.equal(cloudConfigurationStatus(old).complete, true);
  assert.equal(cloudConfigurationStatus({ ...old, VOLC_SPEECH_APP_ID: '' }).complete, false);
  assert.equal(cloudConfigurationStatus({ ...video, VOICE_PROVIDER: 'aliyun', DASHSCOPE_API_KEY: 'fake' }).complete, false);
  assert.equal(cloudConfigurationStatus({ ...video, VOICE_PROVIDER: 'aliyun', DASHSCOPE_API_KEY: 'fake', DASHSCOPE_WORKSPACE_ID: 'workspace', DASHSCOPE_REGION: 'cn-beijing', DASHSCOPE_TTS_MODEL: 'test-model' }).complete, true);
  assert.equal(cloudConfigurationStatus({ ...video, VOICE_PROVIDER: 'typo' }).complete, false);
});

test('dotenv loader loads a file, preserves inherited values, and tolerates absent files', async () => {
  await mkdir(resolve('runs'), { recursive: true });
  const folder = await mkdtemp(resolve('runs/env-test-'));
  const path = resolve(folder, '.env');
  await writeFile(path, 'AIVIDEO_TEST_FILE_VALUE="from local file"\nAIVIDEO_TEST_EXISTING=from-file\n');
  const script = "import { loadLocalEnvironment } from './src/env.ts'; loadLocalEnvironment(); if (process.env.AIVIDEO_TEST_FILE_VALUE !== 'from local file' || process.env.AIVIDEO_TEST_EXISTING !== 'inherited') process.exit(2);";
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: resolve('.'), env: { ...process.env, AIVIDEO_ENV_FILE: path, AIVIDEO_TEST_EXISTING: 'inherited' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const absent = spawnSync(process.execPath, ['--input-type=module', '-e', "import { loadLocalEnvironment } from './src/env.ts'; loadLocalEnvironment();"], {
    cwd: resolve('.'), env: { ...process.env, AIVIDEO_ENV_FILE: resolve(folder, 'missing') }, encoding: 'utf8',
  });
  assert.equal(absent.status, 0, absent.stderr);
});
