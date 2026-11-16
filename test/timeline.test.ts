import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileProject, resolveTime, subtitles, validateWords } from '../src/timeline.ts';
import { splitScenes } from '../src/media.ts';

const words = [{ id: 'intro', text: '你好', start: 0, end: 1 }, { id: 'product', text: '商品', start: 1, end: 2 }];
function project() {
  return { version: 1, name: 'test', reference: 'input.mp4', output: { width: 360, height: 640, fps: 25 }, words,
    shots: [{ id: 'first', start: 0, end: { word: 'product', edge: 'start' }, visual: { type: 'reference' } },
      { id: 'last', start: { word: 'product', edge: 'start' }, end: 3, visual: { type: 'reference' } }] };
}

test('word anchors follow changed speech timing and stay on a shared frame boundary', () => {
  const original = compileProject(project());
  assert.deepEqual(original.shots.map(s => s.frames), [25, 50]);
  const input = project(); input.words = [{ ...words[0], end: 1.4 }, { ...words[1], start: 1.4, end: 2.3 }];
  const changed = compileProject(input);
  assert.deepEqual(changed.shots.map(s => s.frames), [35, 40]);
  assert.equal(changed.shots.reduce((n, s) => n + s.frames, 0), 75);
});

test('invalid words, missing anchors and overlapping timelines are rejected', () => {
  assert.throws(() => validateWords([words[0], words[0]]), /重复/);
  assert.throws(() => resolveTime({ word: 'missing', edge: 'start', offset: 0 }, words), /找不到/);
  const input = project(); input.shots[1].start = 0.8;
  assert.throws(() => compileProject(input), /空隙、重叠/);
});

test('scene splitting covers the reference once, retaining cuts and limiting duration', () => {
  const scenes = splitScenes([3, 3.02, -1, 99], 11, 4);
  assert.equal(scenes[0].start, 0);
  assert.equal(scenes.at(-1)?.end, 11);
  for (let i = 0; i < scenes.length; i++) {
    assert.ok(scenes[i].end - scenes[i].start <= 4);
    if (i) assert.equal(scenes[i].start, scenes[i - 1].end);
  }
  assert.ok(scenes.some(s => s.end === 3));
});

test('captions retain their timing and remove formatting delimiters', () => {
  assert.match(subtitles(words, 1), /00:00:01,000 --> 00:00:02,000\n商品/);
  assert.doesNotMatch(subtitles([{ ...words[0], text: '<script>' }]).split('\n')[2], /<|>/);
});

test('generation rejects missing subject images and unbound reference footage', () => {
  const input: any = project();
  input.shots[0].visual = { type: 'generate', provider: 'local', task: 'presenter', prompt: 'Replace presenter' };
  assert.throws(() => compileProject(input), /未配置生成服务/);
  input.providers = { local: { type: 'comfyui', url: 'http://localhost:8188', workflow: 'api.json', outputNode: '3', bindings: [{ node: '1', input: 'image', value: 'subjectImage' }] } };
  input.assets = { person: { kind: 'image', path: 'person.png' } }; input.subjects = { presenter: 'person' };
  assert.throws(() => compileProject(input), /referenceVideo/);
  input.providers.local.bindings.push({ node: '2', input: 'video', value: 'referenceVideo' });
  assert.throws(() => compileProject(input), /必须绑定 audio/);
});
