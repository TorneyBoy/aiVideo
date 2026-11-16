import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ffmpeg } from '../src/media.ts';
import { json } from '../src/files.ts';
import { render } from '../src/render.ts';
import { runtimeSchema } from '../src/config.ts';

test('Hypit is the default engine and ambiguous native submissions never submit twice', { timeout: 240000 }, async () => {
  assert.equal(runtimeSchema.parse({}).engine, 'hypit');
  await mkdir('runs', { recursive: true });
  const directory = await mkdtemp(resolve('runs/native-test-'));
  const reference = resolve(directory, 'reference.mp4'), subject = resolve(directory, 'subject.jpg');
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=25:d=4', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', reference]);
  await ffmpeg(['-i', reference, '-frames:v', '1', '-update', '1', subject]);
  let submissions = 0;
  const service = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (request.method === 'POST' && request.url === '/ark/contents/generations/tasks') {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(request.headers.authorization, 'Bearer native-contract-secret');
      assert.equal(body.model, 'lost-response');
      assert.equal(body.content.find((part: any) => part.type === 'video_url').video_url.url, 'asset://native_contract');
      assert.match(body.content.find((part: any) => part.type === 'image_url').image_url.url, /^data:image\/jpeg;base64,/);
      submissions++;
      request.socket.destroy();
      return;
    }
    response.writeHead(404); response.end();
  });
  service.listen(0, '127.0.0.1'); await once(service, 'listening');
  const port = (service.address() as { port: number }).port;
  const previous = process.env.AIVIDEO_NATIVE_TEST_KEY;
  process.env.AIVIDEO_NATIVE_TEST_KEY = 'native-contract-secret';
  const file = resolve(directory, 'project.json');
  try {
    await json(file, { version: 1, name: 'Native submit recovery contract', reference,
      output: { width: 320, height: 180, fps: 25 }, assets: { host: { path: subject, kind: 'image' } }, subjects: { presenter: 'host' },
      providers: { volcano: { type: 'volcengine-ark', url: `http://127.0.0.1:${port}/ark`, tokenEnv: 'AIVIDEO_NATIVE_TEST_KEY', model: 'lost-response', pollIntervalMs: 10, timeoutSeconds: 10 } },
      audio: { type: 'mute' }, shots: [{ id: 'host', start: 0, end: 4, visual: { type: 'generate', task: 'presenter', provider: 'volcano', prompt: 'Replace presenter with @image1 in @video1.', seed: 42, referenceAssetUri: 'asset://native_contract' } }],
    });
    const output = resolve(directory, 'output');
    await assert.rejects(render(file, output, () => {}), /中断|超时|构建失败/);
    assert.equal(submissions, 1);
    await assert.rejects(render(file, output, () => {}), /未取得任务编号|核对方舟|构建失败/);
    assert.equal(submissions, 1, 'a fresh native Build must retain the Ark ambiguous-submission guard');
  } finally {
    await new Promise<void>((accept, reject) => service.close(error => error ? reject(error) : accept()));
    if (previous === undefined) delete process.env.AIVIDEO_NATIVE_TEST_KEY; else process.env.AIVIDEO_NATIVE_TEST_KEY = previous;
  }
});
