import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { demo } from '../src/demo.ts';
import { createApp } from '../src/server.ts';
import { renderLegacy as render } from '../src/render.ts';
import { probe } from '../src/media.ts';
import { readJson } from '../src/files.ts';
import { generate } from '../src/comfy.ts';
import type { ProviderConfig } from '../src/schema.ts';
import { convertVoice } from '../src/voice.ts';
import { extractAudio } from '../src/media.ts';

async function listen(server: Server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept())); }

test('real media render, cache recovery, uploads, and ComfyUI receipt reuse', { timeout: 90000 }, async () => {
  await mkdir(resolve('runs'), { recursive: true });
  const root = await mkdtemp(resolve("runs/test folder's-"));
  const output = await demo(resolve(root, 'demo'), () => {});
  const info = await probe(output);
  assert.ok(info.video && info.audio); assert.equal(info.video.width, 360); assert.equal(info.video.height, 640);
  assert.ok(Math.abs(info.duration - 6) < 0.1);
  const projectFile = resolve(root, 'demo/project.json'), outputFolder = resolve(root, 'demo/output');
  await render(projectFile, outputFolder, () => {});
  let manifest = await readJson(resolve(outputFolder, 'manifest.json')) as any;
  assert.ok(manifest.shots.every((s: any) => s.cached));
  const cache = (await import('node:fs/promises')).readdir;
  const folders = await cache(resolve(outputFolder, 'cache'));
  await writeFile(resolve(outputFolder, 'cache', folders[0], 'segment.mp4'), 'corrupt');
  await render(projectFile, outputFolder, () => {});
  manifest = await readJson(resolve(outputFolder, 'manifest.json')) as any;
  assert.equal(manifest.shots.filter((s: any) => !s.cached).length, 1);

  const { server, store } = createApp(resolve(root, 'jobs'));
  const previousConfig = process.env.AIVIDEO_CONFIG;
  process.env.AIVIDEO_CONFIG = resolve(root, 'empty-runtime.json');
  await writeFile(process.env.AIVIDEO_CONFIG, '{}');
  const url = await listen(server);
  try {
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await fetch(`${url}/api/jobs`, { headers: { Origin: 'https://unrelated.test' } })).status, 403);
    const form = new FormData(); form.append('mode', 'product');
    form.append('reference', new Blob([await readFile(resolve(root, 'demo/reference.mp4'))]), 'reference.mp4');
    form.append('subject', new Blob([await readFile(resolve(root, 'demo/analysis/frames/shot-001.jpg'))]), 'product.jpg');
    const response = await fetch(`${url}/api/jobs`, { method: 'POST', body: form });
    assert.equal(response.status, 202);
    const job = await response.json() as { id: string };
    await store.queue;
    const state = await (await fetch(`${url}/api/jobs/${job.id}`)).json() as any;
    assert.equal(state.state, 'needs_setup');
    assert.equal('reference' in state, false);
    assert.equal((await fetch(`${url}/api/jobs/${job.id}/result`)).status, 409);
    const range = await fetch(`${url}/api/jobs/${job.id}/reference`, { headers: { Range: 'bytes=0-99' } });
    assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 100);
    const invalid = await fetch(`${url}/api/jobs/${job.id}/reference`, { headers: { Range: 'bytes=999999999999-' } });
    assert.equal(invalid.status, 416);
    const retry = await fetch(`${url}/api/jobs/${job.id}/retry`, { method: 'POST' });
    assert.equal(retry.status, 202); await store.queue;
  } finally {
    await close(server);
    if (previousConfig === undefined) delete process.env.AIVIDEO_CONFIG;
    else process.env.AIVIDEO_CONFIG = previousConfig;
  }

  let submissions = 0, uploads = 0;
  const mock = createServer(async (req, res) => {
    for await (const chunk of req) { /* consume multipart/JSON input */ }
    const send = (value: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.url === '/upload/image') { uploads++; send({ name: 'uploaded.mp4', subfolder: '' }); }
    else if (req.url === '/prompt') { submissions++; send({ prompt_id: 'persisted-job' }); }
    else if (req.url === '/history/persisted-job') send({ 'persisted-job': { status: { completed: true }, outputs: { '3': { gifs: [{ filename: 'generated.mp4' }] } } } });
    else if (req.url?.startsWith('/view?')) { res.setHeader('Content-Type', 'video/mp4'); res.end(await readFile(output)); }
    else { res.statusCode = 404; res.end(); }
  });
  const mockUrl = await listen(mock);
  try {
    const config: ProviderConfig = { type: 'comfyui', url: mockUrl, workflow: 'unused.json', outputNode: '3', outputField: 'gifs', timeoutSeconds: 5, bindings: [
      { node: '1', input: 'video', value: 'referenceVideo' }, { node: '2', input: 'image', value: 'subjectImage' },
    ] };
    const graph = { '1': { class_type: 'LoadVideo', inputs: { video: '' } }, '2': { class_type: 'LoadImage', inputs: { image: '' } }, '3': { class_type: 'SaveVideo', inputs: {} } };
    const inputs = { referenceVideo: output, subjectImage: resolve(root, 'demo/analysis/frames/shot-001.jpg'), prompt: 'replace', seed: 1, width: 360, height: 640, fps: 25, frameCount: 150 };
    const generated = resolve(root, 'generated.mp4');
    await generate(config, graph, inputs, generated, () => {});
    await generate(config, graph, inputs, generated, () => {});
    assert.equal(submissions, 1); assert.equal(uploads, 2);
    // A missing local result should be downloaded again using the original prompt receipt.
    await writeFile(generated, 'corrupt');
    await generate(config, graph, inputs, generated, () => {});
    assert.equal(submissions, 1);
    assert.ok((await probe(generated)).video);
  } finally { await close(mock); }

  const voiceChunk = resolve(root, 'voice-chunk.wav');
  await extractAudio(resolve(root, 'demo/reference.mp4'), voiceChunk, 0, 3);
  let voiceCalls = 0;
  const voiceMock = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    assert.match(Buffer.concat(chunks).toString('latin1'), /name="source"/);
    assert.match(Buffer.concat(chunks).toString('latin1'), /name="target"/);
    voiceCalls++;
    res.setHeader('Content-Type', 'audio/wav'); res.end(await readFile(voiceChunk));
  });
  const voiceUrl = await listen(voiceMock);
  try {
    const reference = resolve(root, 'demo/reference.mp4');
    const segments = [{ start: 0, end: 3 }, { start: 3, end: 6 }];
    const voiceOptions = { url: voiceUrl, timeoutSeconds: 5 };
    const voiceOut = resolve(root, 'voice');
    const result = await convertVoice(reference, voiceChunk, segments, voiceOptions, voiceOut, () => {});
    assert.ok(Math.abs((await probe(result)).duration - 6) < 0.03);
    await convertVoice(reference, voiceChunk, segments, voiceOptions, voiceOut, () => {});
    assert.equal(voiceCalls, 2);
  } finally { await close(voiceMock); }
});
