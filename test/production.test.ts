import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { binaries, ffmpeg, extractAudio, probe } from '../src/media.ts';
import { json, readJson } from '../src/files.ts';
import { parseWordUtterances } from '../src/doubao.ts';
import { validateDirectorPlan } from '../src/director.ts';
import { createApp } from '../src/server.ts';
import { arkConfigSchema } from '../src/schema.ts';
import { doubaoConfigSchema } from '../src/volc-settings.ts';
import { localMaterialConfigSchema } from '../src/schema.ts';
import type { LocalMaterialConfig } from '../src/schema.ts';
import { serveLocalMaterial } from '../src/local-materials.ts';

const utterances = [
  { text: 'Hello world', start_time: 200, end_time: 1800, additions: { speaker: '0' }, words: [{ text: 'Hello', start_time: 200, end_time: 800 }, { text: 'world', start_time: 800, end_time: 1800 }] },
  { text: 'Good day', start_time: 2100, end_time: 3700, additions: { speaker: '1' }, words: [{ text: 'Good', start_time: 2100, end_time: 2800 }, { text: 'day', start_time: 2800, end_time: 3700 }] },
];
const words = parseWordUtterances({ result: { utterances } }, 4);
const director = (mode = 'presenter') => ({ version: 1, mode, scene: 'Same studio with HOST on the left and GUEST on the right.', subject: 'Identity/product from the uploaded subject.', roles: [{ id: 'HOST', description: 'Primary presenter on the left.', replaceVoice: true }, { id: 'GUEST', description: 'Guest on the right, unchanged.', replaceVoice: false }], cameras: [1, 2, 3].map(i => ({ id: `camera-${i}`, frameIndex: 0, description: ['Host medium view', 'Guest reverse view', 'Shared wide view'][i - 1] })), lines: [{ utterance: 0, role: 'HOST', camera: 'camera-1', action: 'Natural hand gesture.', delivery: 'Conversational.', confidence: 1 }, { utterance: 1, role: 'GUEST', camera: 'camera-2', action: 'Natural nod.', delivery: 'Calm answer.', confidence: 1 }] });

test('word alignment refuses sentence-only and out-of-range evidence; director cannot omit or change speakers', () => {
  assert.deepEqual(words[0].words.map(word => word.start), [0.2, 0.8]);
  assert.throws(() => parseWordUtterances({ result: { utterances: [{ text: 'Hello', start_time: 0, end_time: 1000 }] } }, 4), /逐词/);
  assert.throws(() => parseWordUtterances({ result: { utterances: [{ ...utterances[0], words: [{ text: 'Hello', start_time: 0, end_time: 9000 }] }] } }, 4), /时间戳/);
  assert.throws(() => validateDirectorPlan({ ...director(), lines: [] }, 'presenter', words, 1), /逐句/);
  const conflicting = director();
  assert.throws(() => validateDirectorPlan(conflicting, 'presenter', [{ ...words[0], speaker: '0' }, { ...words[1], speaker: '0' }], 1), /说话人/);
});

test('native presenter then product production: master-dependent cameras, sentence direction, final-audio word alignment and saved voice', { timeout: 600000 }, async () => {
  await mkdir('runs', { recursive: true }); const root = await mkdtemp(resolve('runs/production-test-'));
  const reference = resolve(root, 'reference.mp4'), subject = resolve(root, 'subject.jpg'), generatedCamera = resolve(root, 'camera.png'), sample = resolve(root, 'sample.wav');
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=128x224:r=10:d=4', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', reference]);
  await ffmpeg(['-i', reference, '-frames:v', '1', '-update', '1', subject]);
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=green:s=128x224', '-frames:v', '1', '-update', '1', generatedCamera]);
  await extractAudio(reference, sample);
  const video = await readFile(reference), image = await readFile(subject), cameraBytes = await readFile(generatedCamera), sampleBytes = await readFile(sample);
  const pcm = Buffer.alloc(Math.round(24000 * 1.6) * 2);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 24000) * 4000), i * 2);
  let base = '', images = 0, videos = 0, asr = 0, directors = 0, slotWrites = 0, materialReads = 0;
  let localStore: LocalMaterialConfig;
  const speakers = new Set<string>(), objects = new Set<string>(), spoken: string[] = [], serviceErrors: unknown[] = [];
  const asrRequests = new Map<string, number>();
  const model = createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url!, base || 'http://127.0.0.1');
      if (requestUrl.pathname.startsWith('/media/')) { materialReads++; await serveLocalMaterial(localStore, req, res, requestUrl); return; }
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks), path = new URL(req.url!, base || 'http://127.0.0.1').pathname;
      const body = String(req.headers['content-type']).startsWith('application/json') && raw.length ? JSON.parse(raw.toString()) : {};
      const send = (value: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (req.method === 'PUT' || req.method === 'HEAD') { res.setHeader('x-tos-request-id', 'contract'); res.setHeader('ETag', '"contract"'); if (req.method === 'HEAD' && !objects.has(path)) { res.writeHead(404); res.end(); } else { objects.add(path); send({}); } }
      else if (path === '/ark/chat/completions') {
        const input = JSON.parse(body.messages[1].content[0].text); assert.equal(input.utterances.length, 2); directors++;
        assert.ok(body.messages[1].content.some((item: any) => item.type === 'video_url' && item.video_url.fps === 1));
        assert.equal((await fetch(body.messages[1].content.find((item: any) => item.type === 'video_url').video_url.url)).status, 200);
        send({ choices: [{ message: { content: JSON.stringify(director(input.mode)) } }] });
      } else if (path === '/ark/images/generations') {
        assert.equal(body.model, 'contract-image'); assert.equal(body.size, '2K');
        if (images % 3 === 0) assert.equal(body.image.length, 2);
        else { assert.equal(body.image.length, 3); assert.equal(body.image[1], `data:image/png;base64,${cameraBytes.toString('base64')}`); }
        images++; send({ data: [{ b64_json: cameraBytes.toString('base64') }] });
      } else if (path === '/ark/contents/generations/tasks') {
        assert.equal(body.content.filter((item: any) => item.role === 'reference_image').length, 3);
        for (const item of body.content.filter((item: any) => item.type === 'video_url' || item.type === 'image_url')) assert.equal((await fetch(item[`${item.type}`].url)).status, 200);
        assert.match(body.content[0].text, /HOST/); assert.match(body.content[0].text, /GUEST/); assert.match(body.content[0].text, /@图片3/);
        videos++; send({ id: `video-${videos}` });
      } else if (path.startsWith('/ark/contents/generations/tasks/')) send({ status: 'succeeded', content: { video_url: `${base}/result?token=DO_NOT_PERSIST` } });
      else if (path === '/result') { res.setHeader('Content-Type', 'video/mp4'); res.end(video); }
      else if (path === '/preview') { res.setHeader('Content-Type', 'audio/wav'); res.end(sampleBytes); }
      else if (path.endsWith('/auc/bigmodel/submit')) {
        assert.equal(req.headers['x-api-key'], 'production-speech-secret'); assert.equal(body.request.enable_itn, false); assert.equal(body.request.show_utterances, true); asr++;
        const audio = await fetch(body.audio.url); assert.equal(audio.status, 200); assert.equal(Buffer.from(await audio.arrayBuffer()).subarray(0, 4).toString(), 'RIFF');
        asrRequests.set(String(req.headers['x-api-request-id']), asr);
        res.setHeader('X-Api-Status-Code', '20000000'); send({});
      } else if (path.endsWith('/auc/bigmodel/query')) {
        const finalAudio = asrRequests.get(String(req.headers['x-api-request-id']))! % 2 === 0;
        const measured = finalAudio ? [{ ...utterances[0], words: [{ text: 'Hello', start_time: 300, end_time: 900 }, { text: 'world', start_time: 900, end_time: 1700 }] }, utterances[1]] : utterances;
        res.setHeader('X-Api-Status-Code', '20000000'); send({ result: { utterances: measured } });
      }
      else if (path.endsWith('/tts/get_voice')) send({ status: speakers.has(body.custom_speaker_id) ? 2 : 0, speaker_id: body.custom_speaker_id, speaker_status: [{ model_type: 5, demo_audio: `${base}/preview?token=DO_NOT_PERSIST` }] });
      else if (path.endsWith('/tts/voice_clone')) { slotWrites++; speakers.add(body.custom_speaker_id); send({ status: 2, speaker_id: body.custom_speaker_id, speaker_status: [{ model_type: 5, demo_audio: `${base}/preview?token=DO_NOT_PERSIST` }] }); }
      else if (path.endsWith('/tts/unidirectional/sse')) { spoken.push(body.req_params.text); res.setHeader('Content-Type', 'text/event-stream'); res.end(`data: ${JSON.stringify({ code: 0, data: pcm.toString('base64') })}\n\ndata: {"code":20000000}\n\n`); }
      else send({ error: 'Unknown contract endpoint' }, 404);
    } catch (error) { serviceErrors.push(error); res.writeHead(500); res.end('contract assertion failed'); }
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening'); base = `http://127.0.0.1:${(model.address() as { port: number }).port}`;
  const keys = ['AIVIDEO_CONFIG', 'PRODUCTION_ARK_KEY', 'PRODUCTION_SPEECH_KEY', 'PRODUCTION_TOS_KEY', 'PRODUCTION_TOS_SECRET', 'PRODUCTION_MATERIAL_KEY'] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.AIVIDEO_CONFIG = resolve(root, 'runtime.json'); process.env.PRODUCTION_ARK_KEY = 'production-ark-secret'; process.env.PRODUCTION_SPEECH_KEY = 'production-speech-secret'; process.env.PRODUCTION_TOS_KEY = 'production-tos-key'; process.env.PRODUCTION_TOS_SECRET = 'production-tos-secret';
  process.env.PRODUCTION_MATERIAL_KEY = 'production-material-signing-secret-32-bytes';
  localStore = localMaterialConfigSchema.parse({ type: 'local', directory: resolve(root, 'materials'), publicBaseUrl: base, signingKeyEnv: 'PRODUCTION_MATERIAL_KEY', minDiskFreeBytes: 0 });
  const ark = arkConfigSchema.parse({ type: 'volcengine-ark', url: `${base}/ark`, model: 'contract-video', tokenEnv: 'PRODUCTION_ARK_KEY', pollIntervalMs: 10, timeoutSeconds: 120, storage: localStore });
  const speech = doubaoConfigSchema.parse({ type: 'doubao', url: `${base}/speech`, apiKeyEnv: 'PRODUCTION_SPEECH_KEY', pollIntervalMs: 10, timeoutSeconds: 30 });
  await json(process.env.AIVIDEO_CONFIG, { production: { imageModel: 'contract-image', directorModel: 'contract-director' }, providers: { volcano: ark }, routes: { presenter: 'volcano', product: 'volcano' }, voice: speech });
  const { server, store } = createApp(resolve(root, 'jobs')); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    // A ready voice is produced through the same explicitly confirmed, isolated mock-library workflow.
    const profile = await store.voices.create(randomUUID(), 'Contract voice', sample);
    const draft = new FormData(); draft.append('mode', 'presenter'); draft.append('cloneVoice', 'true'); draft.append('voiceProfileId', profile.id); draft.append('reference', new Blob([video]), 'source.mp4'); draft.append('subject', new Blob([image]), 'subject.jpg');
    const draftResponse = await fetch(`${url}/api/jobs`, { method: 'POST', body: draft }); const draftJob = await draftResponse.json() as { id: string }; await store.queue;
    assert.equal((await store.get(draftJob.id)).state, 'failed'); assert.equal(asr + images + directors + slotWrites, 0, 'an unconfirmed voice stops before paid production');
    const first = await store.voices.addRound(profile.id, '第一轮独立试听。'); await store.voices.queue;
    const second = await store.voices.addRound(profile.id, '第二轮检查数字。'); await store.voices.queue;
    assert.equal((await store.voices.round(profile.id, first.id)).state, 'preview');
    await store.voices.confirm(profile.id, second.id, second.reviewId); await store.voices.queue;
    assert.ok(await store.voices.saved(profile.id)); const slotsBefore = slotWrites, speechBefore = spoken.length;
    for (const mode of ['presenter', 'product']) {
      const form = new FormData(); form.append('mode', mode); form.append('reference', new Blob([video]), 'source.mp4'); form.append('subject', new Blob([image]), 'subject.jpg');
      if (mode === 'presenter') { form.append('cloneVoice', 'true'); form.append('voiceProfileId', profile.id); form.append('voiceMode', 'synthesis'); }
      const response = await fetch(`${url}/api/jobs`, { method: 'POST', body: form }); assert.equal(response.status, 202);
      const { id } = await response.json() as { id: string }; await store.queue;
      const job = await store.get(id); assert.equal(job.state, 'complete', job.message);
      const out = resolve(store.path(id), 'output'), manifest = await readJson(resolve(out, 'manifest.json')) as any;
      assert.deepEqual(manifest.production, { cameras: 3, sentenceDirection: true, wordAlignment: 'doubao-word-evidence', nativeCaptions: true });
      const final = await probe(resolve(out, 'video.mp4')); assert.ok(final.audio && final.video); assert.ok(Math.abs(final.duration - 4) < 0.1);
      const frame = spawnSync(binaries.ffmpeg, ['-v', 'error', '-ss', '1.2', '-i', resolve(out, 'video.mp4'), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
      assert.equal(frame.status, 0); let highlighted = 0;
      for (let offset = 0; offset < frame.stdout.length; offset += 3) { const r = frame.stdout[offset], g = frame.stdout[offset + 1], b = frame.stdout[offset + 2]; if (r > 100 && g > r + 8 && r > b + 10) highlighted++; }
      assert.ok(highlighted > 5, 'the final blue-background video must visibly highlight the current word');
      const alignment = await readJson(resolve(out, 'words.json')) as any; assert.equal(alignment.words.length, 4); assert.equal(alignment.words[1].start, 0.9, 'export uses final audio evidence rather than source word times');
      if (mode === 'presenter') {
        const original = await readFile(resolve(store.path(id), 'voice/preserved-source.pcm')), mixed = await readFile(resolve(store.path(id), 'voice/timeline.pcm'));
        assert.deepEqual(mixed.subarray(2200 * 48 * 2, 3600 * 48 * 2), original.subarray(2200 * 48 * 2, 3600 * 48 * 2), 'non-target guest waveform is retained');
      }
      for (const camera of [1, 2, 3]) assert.equal((await fetch(`${url}/api/jobs/${id}/camera/${camera}`)).headers.get('content-type'), 'image/png');
      assert.equal((await fetch(`${url}/api/jobs/${id}/subtitles`)).status, 200);
    }
    assert.equal(images, 6); assert.equal(videos, 2); assert.equal(directors, 2); assert.equal(asr, 4);
    assert.ok(materialReads >= 14, 'director, final ASR and native video provider must fetch real signed local copies');
    assert.equal(objects.size, 0, 'the complete workflow never uses the TOS mock');
    assert.equal(slotWrites, slotsBefore, 'video production never writes another voice slot');
    assert.deepEqual(spoken.slice(speechBefore), ['Hello world'], 'only the HOST uses target TTS; GUEST remains original');
    assert.deepEqual(serviceErrors, []);
    const inspect = async (directory: string) => { for (const item of await readdir(directory, { withFileTypes: true })) { if (item.isSymbolicLink() || item.name === 'node_modules') continue; const path = resolve(directory, item.name); if (item.isDirectory()) await inspect(path); else if (item.name.endsWith('.json')) assert.doesNotMatch(await readFile(path, 'utf8'), /production-ark-secret|production-speech-secret|production-tos-secret|X-Tos-Signature=|DO_NOT_PERSIST/); } };
    await inspect(root);
    assert.doesNotMatch(await readFile(resolve(root, 'runtime.json'), 'utf8'), /production-material-signing-secret/);
  } finally {
    await new Promise<void>(accept => server.close(() => accept())); await new Promise<void>(accept => model.close(() => accept()));
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
});
