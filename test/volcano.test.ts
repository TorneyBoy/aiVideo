import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { demo } from '../src/demo.ts';
import { ArkClient, arkBody, generateArk } from '../src/ark.ts';
import { decodeTts, parseUtterances, speechHeaders, transcribe } from '../src/doubao.ts';
import { arkConfigSchema } from '../src/schema.ts';
import { doubaoConfigSchema, environmentCloudConfig } from '../src/volc-settings.ts';
import { cloudRanges, probe, videoOutputSize } from '../src/media.ts';
import { createApp } from '../src/server.ts';
import { json, readJson } from '../src/files.ts';
import { safeMessage } from '../src/cloud-http.ts';
import { verifyCloudSetup } from '../src/cloud-check.ts';
import { JobStore } from '../src/jobs.ts';

async function listen(server: Server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done())); }

test('cloud ranges cover all frames and honor platform clip limits', () => {
  for (const duration of [4, 6, 12.04, 15, 16, 179.96, 180]) {
    const ranges = cloudRanges(duration, 25);
    assert.equal(ranges[0].start, 0); assert.equal(ranges.at(-1)!.end, duration);
    for (const [i, range] of ranges.entries()) {
      assert.ok(range.end - range.start >= 4 && range.end - range.start <= 15);
      if (i) assert.equal(ranges[i - 1].end, range.start);
    }
  }
  assert.throws(() => cloudRanges(3.99, 25), /至少 4 秒/);
  assert.throws(() => cloudRanges(16, 25, true), /4–15 秒/);
});

test('4K portrait and landscape reference videos retain orientation during output sizing', () => {
  assert.deepEqual(videoOutputSize(2160, 3840), { width: 1080, height: 1920 });
  assert.deepEqual(videoOutputSize(3840, 2160), { width: 1920, height: 1080 });
  assert.deepEqual(videoOutputSize(360, 640), { width: 360, height: 640 });
});

test('Seedance editing sends supported references and family-specific durations', () => {
  const config = arkConfigSchema.parse({ type: 'volcengine-ark', url: 'https://example.test/api/v3', model: 'model' });
  const inputs = { referenceVideo: 'video.mp4', subjectImage: 'person.jpg', audio: 'audio.wav', prompt: 'Replace the person', seed: 42, width: 360, height: 640, fps: 25, frameCount: 150 };
  const body = arkBody(config, inputs, { video: 'asset://video', image: 'asset://person', audio: 'https://example.test/audio.wav' });
  assert.equal(body.duration, 6);
  assert.deepEqual(body.content.slice(1).map(item => item.role), ['reference_video', 'reference_image', 'reference_audio']);
  assert.equal(arkBody({ ...config, family: 'seedance-2.5' }, inputs, { video: 'video', image: 'image' }).duration, -1);
});

test('TTS decoder refuses partial, malformed and service-error audio', async () => {
  const audio = Buffer.alloc(48, 1).toString('base64');
  const success = await decodeTts(new Response(`data: {"code":0,"data":"${audio}"}\n\ndata: {"code":20000000}\n\n`));
  assert.equal(success.length, 48);
  await assert.rejects(decodeTts(new Response(`data: {"code":0,"data":"${audio}"}\n\n`)), /未完整结束/);
  await assert.rejects(decodeTts(new Response('data: {"code":45000001,"message":"invalid speaker"}\n\n')), /合成失败/);
  await assert.rejects(decodeTts(new Response('data: not-json\n\n')), /格式无效/);
});

test('ASR timestamps are interpreted as milliseconds and invalid segments are rejected', () => {
  assert.deepEqual(parseUtterances({ result: { utterances: [{ text: '你好', start_time: 200, end_time: 2500 }] } }, 6), [{ text: '你好', start: 0.2, end: 2.5 }]);
  assert.throws(() => parseUtterances({ result: { text: 'missing timing' } }, 6), /时间戳/);
  assert.throws(() => parseUtterances({ result: { utterances: [{ text: 'bad', start_time: 2000, end_time: 1000 }] } }, 6), /无效/);
});

test('local materials require private storage; Files IDs cannot silently count as download URLs', async () => {
  const config = arkConfigSchema.parse({ type: 'volcengine-ark', url: 'https://example.test/api/v3', model: 'model' });
  const client = new ArkClient(config, 'runs/no-upload');
  await assert.rejects(client.upload('unused.mp4'), /Files 文件 ID 不能/);
});

// Five native browser renders and the independent voice branches run on the same local CPU.
test('HTTP video flows, independent multi-round voice library, confirmed reuse and receipts prevent duplicate cloud operations', { timeout: 900000 }, async () => {
  await mkdir(resolve('runs'), { recursive: true });
  const root = await mkdtemp(resolve('runs/volcano-test-'));
  const sourceOutput = await demo(resolve(root, 'demo'), () => {});
  const video = await readFile(sourceOutput);
  const image = await readFile(resolve(root, 'demo/analysis/frames/shot-001.jpg'));
  const sample = await readFile(resolve(root, 'demo/analysis/reference.wav'));
  const pcm = Buffer.alloc(24000 * 2 * 2.6);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 24000) * 5000), i * 2);
  let uploadCount = 0, videoCount = 0, asrCount = 0, cloneCount = 0, synthesisCount = 0;
  const tasks = new Map<string, { model: string; polls: number }>();
  const voices = new Set<string>(), objects = new Set<string>();
  const auditionTexts: string[] = [];
  let mockUrl = '';
  const mock = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks), path = (req.url || '').split('?')[0];
      const send = (value: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
      const body = raw.length && String(req.headers['content-type']).startsWith('application/json') ? JSON.parse(raw.toString()) : {};
      if (path.startsWith('/ark/')) assert.equal(req.headers.authorization, 'Bearer testing-ark-credential');
      if (path.startsWith('/test-materials/')) {
        if (req.method !== 'GET') assert.match(req.headers.authorization || '', /TOS4-HMAC-SHA256/);
        if (req.method === 'HEAD') { res.statusCode = objects.has(path) ? 200 : 404; res.end(); }
        else if (req.method === 'PUT') { assert.ok(raw.length); objects.add(path); uploadCount++; res.setHeader('etag', 'test-object'); send({}); }
        else { res.setHeader('Content-Type', 'audio/wav'); res.end(sample); }
      } else if (path === '/ark/files' && req.method === 'GET') send({ data: [] });
      else if (path === '/ark/files' && req.method === 'POST') send({ error: 'Files must never be used as an input download link' }, 500);
      else if (path === '/ark/contents/generations/tasks') {
        assert.equal(body.duration, 6); assert.ok(body.content.some((item: any) => item.role === 'reference_video'));
        const audio = body.content.find((item: any) => item.role === 'reference_audio');
        if (audio) assert.match(audio.audio_url.url, /^data:audio\/wav;base64,/);
        videoCount++; const id = `video-${videoCount}`; tasks.set(id, { model: body.model, polls: 0 });
        if (body.model === 'lost-response') { req.socket.destroy(); return; }
        send({ id });
      } else if (path.startsWith('/ark/contents/generations/tasks/')) {
        const id = path.split('/').at(-1)!, task = tasks.get(id)!; task.polls++;
        if (task.model === 'failed-model') send({ id, status: 'failed', error: { message: 'invalid reference' } });
        else send(task.polls === 1 ? { id, status: 'running' } : { id, status: 'succeeded', content: { video_url: `${mockUrl}/media/result?signature=DO_NOT_PERSIST_THIS_URL` } });
      } else if (path === '/media/result') { res.setHeader('Content-Type', 'video/mp4'); res.end(video); }
      else if (path === '/media/input') { res.setHeader('Content-Type', 'audio/wav'); res.end(sample); }
      else if (path === '/media/preview') { res.setHeader('Content-Type', 'audio/wav'); res.end(sample); }
      else if (path === '/vc/voice-convert') { assert.match(raw.toString('latin1'), /name="source"/); assert.match(raw.toString('latin1'), /name="target"/); res.setHeader('Content-Type', 'audio/wav'); res.end(sample); }
      else if (path.startsWith('/speech/')) {
        assert.equal(req.headers['x-api-key'], 'testing-speech-credential');
        if (path.endsWith('/auc/bigmodel/submit')) {
          assert.equal(req.headers['x-api-resource-id'], 'volc.seedasr.auc');
          assert.equal(body.request.show_utterances, true); assert.ok(body.audio.url.includes('/aivideo/')); assert.ok(body.audio.url.includes('X-Tos-Signature='));
          asrCount++; send({ task_id: `asr-${asrCount}`, 'X-Api-Status-Code': '20000000' });
        } else if (path.endsWith('/auc/bigmodel/query')) {
          res.setHeader('X-Api-Status-Code', '20000000');
          send({ result: { utterances: [{ text: '这是第一句演示台词。', start_time: 200, end_time: 2800 }, { text: '这是第二句演示台词。', start_time: 3200, end_time: 5800 }] } });
        } else if (path.endsWith('/tts/voice_clone')) {
          assert.equal(body.speaker_id, 'custom_speaker_id'); assert.equal(body.audio.format, 'wav');
          if (body.extra_params?.demo_text) auditionTexts.push(body.extra_params.demo_text);
          if (voices.has(body.custom_speaker_id)) send({ message: 'already exists' }, 409);
          else {
            voices.add(body.custom_speaker_id); cloneCount++;
            send(body.extra_params?.demo_text ? { status: 2, speaker_id: body.custom_speaker_id, speaker_status: [{ model_type: 5, demo_audio: `${mockUrl}/media/preview?signature=DO_NOT_PERSIST_THIS_URL` }] } : { status: 1 });
          }
        } else if (path.endsWith('/tts/get_voice')) {
          send({ status: voices.has(body.custom_speaker_id) ? 2 : 0, speaker_id: body.custom_speaker_id, speaker_status: [{ model_type: 4, demo_audio: `${mockUrl}/media/preview?signature=DO_NOT_PERSIST_THIS_URL` }] });
        } else if (path.endsWith('/tts/unidirectional/sse')) {
          assert.equal(req.headers['x-api-resource-id'], 'seed-icl-2.0'); assert.equal(body.req_params.audio_params.sample_rate, 24000);
          assert.ok(voices.has(body.req_params.speaker)); synthesisCount++;
          res.setHeader('Content-Type', 'text/event-stream');
          const stream = `event: audio\ndata: ${JSON.stringify({ code: 0, data: pcm.toString('base64') })}\n\ndata: {"code":20000000}\n\n`;
          res.write(stream.slice(0, 137)); res.end(stream.slice(137));
        } else send({ error: 'unknown speech endpoint' }, 404);
      } else send({ error: 'unknown route' }, 404);
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ message: String(error) })); }
  });
  mockUrl = await listen(mock);
  const ark = arkConfigSchema.parse({ type: 'volcengine-ark', url: `${mockUrl}/ark`, tokenEnv: 'AIVIDEO_TEST_ARK_KEY', model: 'test-model', pollIntervalMs: 10, timeoutSeconds: 10,
    storage: { bucket: 'test-materials', region: 'cn-beijing', endpoint: mockUrl, accessKeyEnv: 'AIVIDEO_TEST_TOS_KEY', secretKeyEnv: 'AIVIDEO_TEST_TOS_SECRET', sessionTokenEnv: 'AIVIDEO_TEST_TOS_SESSION' },
  });
  const speech = doubaoConfigSchema.parse({ type: 'doubao', url: `${mockUrl}/speech`, apiKeyEnv: 'AIVIDEO_TEST_SPEECH_KEY', pollIntervalMs: 10, timeoutSeconds: 10 });
  const configFile = resolve(root, 'runtime.json');
  await json(configFile, { production: { enabled: false }, providers: { volcano: ark }, routes: { presenter: 'volcano', product: 'volcano' }, voice: speech, voiceConversion: { url: `${mockUrl}/vc` } });
  const names = ['AIVIDEO_CONFIG', 'AIVIDEO_TEST_ARK_KEY', 'AIVIDEO_TEST_SPEECH_KEY', 'AIVIDEO_TEST_TOS_KEY', 'AIVIDEO_TEST_TOS_SECRET'] as const;
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.AIVIDEO_CONFIG = configFile; process.env.AIVIDEO_TEST_ARK_KEY = 'testing-ark-credential'; process.env.AIVIDEO_TEST_SPEECH_KEY = 'testing-speech-credential';
  process.env.AIVIDEO_TEST_TOS_KEY = 'testing-tos-credential'; process.env.AIVIDEO_TEST_TOS_SECRET = 'testing-tos-secret';
  const { server, store } = createApp(resolve(root, 'jobs'));
  const url = await listen(server);
  try {
    const connection = await verifyCloudSetup({ video: ark, voice: speech });
    assert.ok(connection.every(item => item.ok));
    assert.equal(videoCount + asrCount + cloneCount + synthesisCount, 0);
    const uploader = new ArkClient(ark, resolve(root, 'material-check'));
    const samplePath = resolve(root, 'demo/analysis/reference.wav');
    const first = await uploader.upload(samplePath), uploaded = uploadCount;
    const second = await uploader.upload(samplePath);
    assert.equal(uploadCount, uploaded, 'existing private objects are reused');
    assert.equal(new URL(first).searchParams.get('X-Tos-Expires'), '21600');
    assert.equal(new URL(second).searchParams.has('X-Tos-Signature'), true);
    assert.equal((await fetch(first)).status, 200, 'temporary material URL is usable');
    objects.clear();
    await uploader.upload(samplePath);
    assert.equal(uploadCount, uploaded + 1, 'deleted private objects can be uploaded again');
    for (const mode of ['product', 'presenter']) {
      const form = new FormData(); form.append('mode', mode); form.append('cloneVoice', 'true');
      if (mode === 'product') form.append('confirmed', 'true'); // A generic create/retry action must never authorize a slot.
      form.append('reference', new Blob([video]), 'reference.mp4'); form.append('subject', new Blob([image]), 'subject.jpg'); form.append('voice', new Blob([sample]), 'target.wav');
      if (mode === 'presenter') { form.append('subjectAssetUri', 'asset://authorized-person'); form.append('referenceAssetUri', 'asset://authorized-reference'); }
      const response = await fetch(`${url}/api/jobs`, { method: 'POST', body: form }); assert.equal(response.status, 202);
      const accepted = await response.json() as { id: string }; await store.queue;
      let waiting = await store.get(accepted.id);
      assert.equal(waiting.state, 'awaiting_voice_upload');
      const callsBeforeConfirm = cloneCount + synthesisCount;
      const uploadReview = (await (await fetch(`${url}/api/jobs/${accepted.id}`)).json() as any).voiceReview;
      const confirm = (stage: string, reviewId: string, confirmed: boolean = true, origin?: string) => fetch(`${url}/api/jobs/${accepted.id}/voice-confirm`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify({ stage, reviewId, confirmed }),
      });
      assert.equal((await confirm('register', uploadReview.id, false)).status, 400);
      assert.equal((await confirm('register', '00000000-0000-4000-8000-000000000000')).status, 400);
      assert.equal((await confirm('activate', uploadReview.id)).status, 400);
      assert.equal((await confirm('register', uploadReview.id, true, 'https://untrusted.test')).status, 403);
      await fetch(`${url}/api/jobs/${accepted.id}/retry`, { method: 'POST' }); await store.queue;
      assert.equal((await store.get(accepted.id)).state, 'awaiting_voice_upload');
      assert.equal(cloneCount + synthesisCount, callsBeforeConfirm);
      const simultaneous = await Promise.all([confirm('register', uploadReview.id), confirm('register', uploadReview.id)]);
      assert.deepEqual(simultaneous.map(item => item.status).sort(), [202, 400]);
      await store.queue;
      waiting = await store.get(accepted.id); assert.equal(waiting.state, 'awaiting_voice_activation');
      assert.equal(synthesisCount, mode === 'product' ? 0 : 2);
      const activationReview = (await (await fetch(`${url}/api/jobs/${accepted.id}`)).json() as any).voiceReview;
      assert.equal(activationReview.hasPreview, true);
      const preview = await fetch(`${url}/api/jobs/${accepted.id}/voice-preview`, { headers: { Range: 'bytes=0-43' } });
      assert.equal(preview.status, 206); assert.equal((await preview.arrayBuffer()).byteLength, 44);
      assert.equal((await new JobStore(store.root).get(accepted.id)).state, 'awaiting_voice_activation', 'restart preserves the waiting stage');
      await fetch(`${url}/api/jobs/${accepted.id}/retry`, { method: 'POST' }); await store.queue;
      assert.equal((await store.get(accepted.id)).state, 'awaiting_voice_activation');
      assert.equal(synthesisCount, mode === 'product' ? 0 : 2);
      assert.equal((await confirm('activate', activationReview.id)).status, 202);
      await store.queue;
      const job = await store.get(accepted.id); assert.equal(job.state, 'complete', job.message);
      const result = await fetch(`${url}/api/jobs/${job.id}/result`); assert.equal(result.status, 200); await result.arrayBuffer();
      const directory = store.path(job.id);
      const info = await probe(resolve(directory, 'output/video.mp4')); assert.ok(info.video && info.audio); assert.ok(Math.abs(info.duration - 6) < 0.1);
      const manifest = await readJson(resolve(directory, 'output/manifest.json')) as any;
      assert.equal(manifest.engine, 'hypit'); assert.match(manifest.build, /^bld_/);
      assert.equal(manifest.upstreamRevision, '6bacce093695ccc2bde5aa5d7de230e9682ffa79');
      assert.equal(manifest.generatedShots, 1); assert.equal(manifest.audio, 'asset');
      assert.ok(job.logs.some(log => log.includes('识别'))); assert.ok(job.logs.some(log => log.includes('豆包配音')));
    }
    assert.equal(videoCount, 2); assert.equal(asrCount, 2); assert.equal(cloneCount, 1); assert.equal(voices.size, 1); assert.equal(synthesisCount, 4); assert.ok(uploadCount >= 2);
    // Standalone voice library: no video dependency, several temporary auditions, explicit finalization once.
    const createVoice = new FormData(); createVoice.append('name', '品牌口播'); createVoice.append('sample', new Blob([sample]), 'target.wav');
    const voiceResponse = await fetch(`${url}/api/voices`, { method: 'POST', body: createVoice }); assert.equal(voiceResponse.status, 201);
    const profile = await voiceResponse.json() as { id: string };
    const jsonPost = (path: string, body: unknown) => fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const library = async () => (await (await fetch(`${url}/api/voices`)).json() as any[]).find(item => item.id === profile.id);
    const selectedForm = (mode: string) => {
      const form = new FormData(); form.append('mode', mode); form.append('cloneVoice', 'true'); form.append('voiceProfileId', profile.id);
      form.append('voiceMode', 'synthesis'); form.append('subjectAssetUri', ''); form.append('referenceAssetUri', '');
      form.append('reference', new Blob([video]), 'reference.mp4'); form.append('subject', new Blob([image]), 'subject.jpg'); return form;
    };
    const callsBeforeLibrary = { clone: cloneCount, tts: synthesisCount, asr: asrCount, video: videoCount };
    assert.equal((await library()).selectable, false);
    const unconfirmedJob = await fetch(`${url}/api/jobs`, { method: 'POST', body: selectedForm('presenter') });
    const unconfirmedId = (await unconfirmedJob.json() as { id: string }).id; await store.queue;
    assert.equal((await store.get(unconfirmedId)).state, 'failed');
    assert.deepEqual({ clone: cloneCount, tts: synthesisCount, asr: asrCount, video: videoCount }, callsBeforeLibrary);
    assert.equal((await jsonPost(`/api/voices/${profile.id}/rounds`, { text: '这是第一轮试听文本。', confirmed: false })).status, 400);
    const attempts = await Promise.all([
      jsonPost(`/api/voices/${profile.id}/rounds`, { text: '这是第一轮试听文本。', confirmed: true }),
      jsonPost(`/api/voices/${profile.id}/rounds`, { text: '并发提交不应重复注册。', confirmed: true }),
    ]);
    assert.deepEqual(attempts.map(result => result.status).sort(), [202, 400]); await store.voices.queue;
    const firstRound = (await library()).rounds[0]; assert.equal(firstRound.state, 'preview');
    assert.equal(firstRound.hasPreview, true); assert.equal(synthesisCount, callsBeforeLibrary.tts);
    assert.equal((await library()).canConfirm, false);
    assert.equal((await jsonPost(`/api/voices/${profile.id}/rounds/${firstRound.id}/confirm`, { confirmed: true, acceptFees: true, reviewId: firstRound.reviewId })).status, 400, 'finalization requires several successful auditions');
    const secondResponse = await jsonPost(`/api/voices/${profile.id}/rounds`, { text: '价格九十九元，请检查数字读音。', confirmed: true }); assert.equal(secondResponse.status, 202); await store.voices.queue;
    const tested = await library(); assert.equal(tested.rounds.length, 2); assert.equal(cloneCount, callsBeforeLibrary.clone + 2);
    assert.deepEqual(auditionTexts, ['这是第一轮试听文本。', '价格九十九元，请检查数字读音。']);
    const secondRound = tested.rounds[1]; assert.equal(tested.selectable, false); assert.equal(synthesisCount, callsBeforeLibrary.tts);
    assert.equal((await jsonPost(`/api/voices/${profile.id}/rounds/${secondRound.id}/confirm`, { confirmed: true, acceptFees: false, reviewId: secondRound.reviewId })).status, 400);
    assert.equal((await jsonPost(`/api/voices/${profile.id}/rounds/${secondRound.id}/confirm`, { confirmed: true, acceptFees: true, reviewId: firstRound.reviewId })).status, 400);
    const confirmations = await Promise.all([1, 2].map(() => jsonPost(`/api/voices/${profile.id}/rounds/${secondRound.id}/confirm`, { confirmed: true, acceptFees: true, reviewId: secondRound.reviewId })));
    assert.deepEqual(confirmations.map(result => result.status).sort(), [202, 400]); await store.voices.queue;
    const finalized = await library(); assert.equal(finalized.selectable, true); assert.equal(finalized.confirmedRound, secondRound.id);
    assert.equal(synthesisCount, callsBeforeLibrary.tts + 1);
    assert.equal((await jsonPost(`/api/voices/${profile.id}/rounds`, { text: '不能覆盖已确定音色。', confirmed: true })).status, 400);
    for (const mode of ['presenter', 'product']) {
      const uploaded = await fetch(`${url}/api/jobs`, { method: 'POST', body: selectedForm(mode) }); assert.equal(uploaded.status, 202);
      const selectedJob = await uploaded.json() as { id: string }; await store.queue;
      const result = await store.get(selectedJob.id); assert.equal(result.state, 'complete', result.message); assert.equal(result.voiceName, '品牌口播');
      assert.equal(cloneCount, callsBeforeLibrary.clone + 2, 'video reuse must never clone again');
      assert.equal(synthesisCount, callsBeforeLibrary.tts + 3, 'the second video reuses cached speech from the confirmed voice');
    }
    process.env.AIVIDEO_TEST_SPEECH_KEY = 'testing-different-account';
    assert.equal((await library()).selectable, false, 'another credential scope cannot reuse a paid voice automatically');
    assert.equal(cloneCount, callsBeforeLibrary.clone + 2);
    process.env.AIVIDEO_TEST_SPEECH_KEY = 'testing-speech-credential';
    assert.equal((await library()).selectable, true);
    const beforeConversion = { asr: asrCount, tts: synthesisCount, clone: cloneCount };
    const conversionForm = selectedForm('presenter'); conversionForm.set('voiceMode', 'conversion');
    const conversionResponse = await fetch(`${url}/api/jobs`, { method: 'POST', body: conversionForm }); assert.equal(conversionResponse.status, 202);
    const conversionId = (await conversionResponse.json() as { id: string }).id; await store.queue;
    const converted = await store.get(conversionId); assert.equal(converted.state, 'complete', converted.message);
    assert.deepEqual({ asr: asrCount, tts: synthesisCount, clone: cloneCount }, beforeConversion, 'VC uses the source audio and saved original sample without ASR/TTS/slot calls');
    const inputs = { referenceVideo: resolve(root, 'demo/reference.mp4'), subjectImage: resolve(root, 'demo/analysis/frames/shot-001.jpg'), prompt: 'Replace product', seed: 42, width: 360, height: 640, fps: 25, frameCount: 150 };
    const resume = resolve(root, 'resume/generated.mp4');
    await generateArk(ark, inputs, resume, () => {}); const count = videoCount;
    await writeFile(resume, 'damaged'); await generateArk(ark, inputs, resume, () => {}); assert.equal(videoCount, count);
    assert.ok((await probe(resume)).video);
    const ambiguous = resolve(root, 'ambiguous/generated.mp4');
    await assert.rejects(generateArk({ ...ark, model: 'lost-response' }, inputs, ambiguous, () => {}), /中断|超时/);
    const afterLost = videoCount;
    await assert.rejects(generateArk({ ...ark, model: 'lost-response' }, inputs, ambiguous, () => {}), /未取得回执/);
    assert.equal(videoCount, afterLost);
    const failedOutput = resolve(root, 'failed/generated.mp4');
    await assert.rejects(generateArk({ ...ark, model: 'failed-model' }, inputs, failedOutput, () => {}), /生成失败/);
    const afterFailed = videoCount;
    await assert.rejects(generateArk({ ...ark, model: 'failed-model' }, inputs, failedOutput, () => {}), /此前视频任务已失败/);
    assert.equal(videoCount, afterFailed);
    const { storage: unusedStorage, ...withoutStorage } = ark;
    await json(configFile, { production: { enabled: false }, providers: { volcano: withoutStorage }, routes: { presenter: 'volcano', product: 'volcano' }, voice: speech });
    const callsBeforeMissingStorage = videoCount + asrCount + cloneCount + synthesisCount;
    const unconfigured = new FormData(); unconfigured.append('mode', 'product'); unconfigured.append('cloneVoice', 'true');
    unconfigured.append('reference', new Blob([video]), 'reference.mp4'); unconfigured.append('subject', new Blob([image]), 'subject.jpg'); unconfigured.append('voice', new Blob([sample]), 'target.wav');
    const queued = await fetch(`${url}/api/jobs`, { method: 'POST', body: unconfigured });
    assert.equal(queued.status, 202);
    const waiting = await queued.json() as { id: string }; await store.queue;
    const waitingJob = await store.get(waiting.id);
    assert.equal(waitingJob.state, 'needs_setup'); assert.match(waitingJob.message, /MATERIAL_PUBLIC_BASE_URL/);
    assert.equal(videoCount + asrCount + cloneCount + synthesisCount, callsBeforeMissingStorage, 'missing storage stops before billable work');
    assert.doesNotMatch(safeMessage('testing-ark-credential testing-speech-credential https://private.test/?token=hidden'), /testing-ark|testing-speech|private.test/);
    const inspect = async (directory: string) => {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        const path = resolve(directory, item.name);
        if (item.isDirectory()) await inspect(path);
        else if (item.name.endsWith('.json')) assert.doesNotMatch(await readFile(path, 'utf8'), /testing-ark-credential|testing-speech-credential|testing-tos-credential|testing-tos-secret|X-Tos-Signature=|DO_NOT_PERSIST_THIS_URL/);
      }
    };
    await inspect(root);
  } finally {
    await close(server); await close(mock);
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
  }
});
