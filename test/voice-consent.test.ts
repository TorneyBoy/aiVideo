import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { cloneSpeaker, synthesizeNarration } from '../src/doubao.ts';
import { doubaoConfigSchema } from '../src/volc-settings.ts';
import { approveVoiceReview, readVoiceReview, VoiceConsentRequired } from '../src/voice-consent.ts';
import { ffmpeg } from '../src/media.ts';

test('voice adapters require explicit decisions and invalidate consent when sample, account or text changes', { timeout: 60000 }, async () => {
  await mkdir(resolve('runs'), { recursive: true });
  const out = await mkdtemp(resolve('runs/voice-consent-test-'));
  const sample = resolve(out, 'target.wav');
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', '4', '-c:a', 'pcm_s16le', sample]);
  let registered = false, cloneCount = 0, synthesisCount = 0, requestCount = 0;
  const pcm = Buffer.alloc(24000 * 2 * 2).toString('base64');
  const server = createServer(async (req, res) => {
    requestCount++;
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (req.url?.endsWith('/get_voice')) res.end(JSON.stringify({ status: registered ? 2 : 0 }));
    else if (req.url?.endsWith('/voice_clone')) { cloneCount++; registered = true; res.end(JSON.stringify({ status: 1 })); }
    else if (req.url?.endsWith('/unidirectional/sse')) { synthesisCount++; res.end(`data: {"code":0,"data":"${pcm}"}\n\ndata: {"code":20000000}\n\n`); }
    else { res.statusCode = 404; res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const keyName = 'AIVIDEO_TEST_CONSENT_KEY', previous = process.env[keyName]; process.env[keyName] = 'testing-consent-key-one';
  const config = doubaoConfigSchema.parse({ type: 'doubao', url: `http://127.0.0.1:${address.port}`, apiKeyEnv: keyName, pollIntervalMs: 10, timeoutSeconds: 5 });
  try {
    await assert.rejects(cloneSpeaker(config, sample, out, () => {}), VoiceConsentRequired);
    assert.equal(requestCount, 0);
    const registration = (await readVoiceReview(out, 'register'))!;
    await approveVoiceReview(out, 'register', registration.id);
    const speaker = await cloneSpeaker(config, sample, out, () => {});
    assert.equal(cloneCount, 1);
    const words = [{ text: '测试台词。', start: 0.5, end: 2.5 }];
    await assert.rejects(synthesizeNarration(config, speaker, words, 4, out, () => {}), VoiceConsentRequired);
    assert.equal(synthesisCount, 0);
    const activation = (await readVoiceReview(out, 'activate'))!;
    await approveVoiceReview(out, 'activate', activation.id);
    await synthesizeNarration(config, speaker, words, 4, out, () => {});
    assert.equal(synthesisCount, 1);
    const count = requestCount;
    await assert.rejects(synthesizeNarration(config, speaker, [{ ...words[0], text: '新的台词。' }], 4, out, () => {}), VoiceConsentRequired);
    await assert.rejects(approveVoiceReview(out, 'activate', activation.id), /失效/);
    const bytes = await readFile(sample); bytes[100] ^= 1; await writeFile(sample, bytes);
    await assert.rejects(cloneSpeaker(config, sample, out, () => {}), VoiceConsentRequired);
    const changedSample = (await readVoiceReview(out, 'register'))!;
    assert.notEqual(changedSample.id, registration.id);
    await assert.rejects(approveVoiceReview(out, 'register', registration.id), /失效/);
    process.env[keyName] = 'testing-consent-key-two';
    await assert.rejects(cloneSpeaker(config, sample, out, () => {}), VoiceConsentRequired);
    assert.notEqual((await readVoiceReview(out, 'register'))!.id, changedSample.id);
    assert.equal(requestCount, count, 'stale decisions must never reach a remote voice API');
    const automated = spawnSync(process.execPath, ['src/cli.ts', 'voice-confirm', '--out', out, '--stage', 'activate'], {
      cwd: resolve('.'), encoding: 'utf8', input: '确认付费使用\n', env: { ...process.env, AIVIDEO_ENV_FILE: resolve(out, 'absent.env') },
    });
    assert.equal(automated.status, 1); assert.match(automated.stderr, /交互终端/);
    assert.equal((await readVoiceReview(out, 'activate'))!.approvedAt, undefined, 'piped confirmation cannot authorize billing');
  } finally {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    if (previous === undefined) delete process.env[keyName]; else process.env[keyName] = previous;
  }
});
