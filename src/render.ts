import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { generate, loadWorkflow } from './comfy.ts';
import { fingerprint, hashFile, json, localPath, readJson } from './files.ts';
import { extractAudio, extractVideo, ffmpeg, probe } from './media.ts';
import { compileProject, subtitles } from './timeline.ts';
import { generateArk } from './ark.ts';
import { secret } from './cloud-http.ts';
import { materialStorageMissing } from './material-storage.ts';
import { extractCloudVideo } from './media.ts';
import { hasSpeechCredentials } from './volc-settings.ts';

export async function plan(projectFile: string) {
  projectFile = resolve(projectFile);
  const compiled = compileProject(await readJson(projectFile));
  const { project, shots } = compiled;
  if (project.production && project.audio.type !== 'mute' && !hasSpeechCredentials(project.production.speech)) throw new Error('完整逐词流程需要豆包录音识别凭证，请先配置语音服务');
  const reference = localPath(projectFile, project.reference);
  const source = await probe(reference);
  if (!source.video) throw new Error('参考文件没有视频流');
  if (shots.some(s => s.end > source.duration + 1 / project.output.fps && s.visual.type !== 'asset')) throw new Error('参考分镜超出原视频时长');
  if (project.audio.type === 'reference' && !source.audio) throw new Error('参考视频没有声音，请选择配音或静音');
  const hashes: Record<string, string> = { reference: await hashFile(reference) };
  const assetPaths: Record<string, string> = {};
  for (const [id, asset] of Object.entries(project.assets)) {
    assetPaths[id] = localPath(projectFile, asset.path);
    hashes[id] = await hashFile(assetPaths[id]);
    const info = await probe(assetPaths[id]);
    if (asset.kind === 'audio' ? !info.audio : !info.video) throw new Error(`素材 ${id} 的媒体类型与声明不符`);
  }
  for (const shot of shots) {
    if (shot.visual.type === 'asset' && project.assets[shot.visual.asset].kind === 'video') {
      const media = await probe(assetPaths[shot.visual.asset]);
      if (media.duration + 1 / project.output.fps < shot.visual.offset + shot.frames / project.output.fps) throw new Error(`替换素材不足以覆盖分镜 ${shot.id}`);
    }
  }
  if (project.audio.type === 'asset') {
    const audio = await probe(assetPaths[project.audio.asset]);
    if (audio.duration + 0.1 < compiled.duration + project.audio.offset) throw new Error('配音短于视频，请先完成时长对齐');
  }
  const workflows: Record<string, Awaited<ReturnType<typeof loadWorkflow>>> = {};
  for (const shot of shots) {
    if (shot.visual.type !== 'generate') continue;
    const id = shot.visual.provider;
    const config = project.providers[id];
    if (config.type === 'comfyui' && !workflows[id]) workflows[id] = await loadWorkflow(config, localPath(projectFile, config.workflow));
    else if (config.type === 'volcengine-ark') {
      secret(config.tokenEnv);
      if (project.production && project.audio.type !== 'mute' && !config.storage) throw new Error('最终配音的逐词对齐需要服务器临时素材链接，不能用视频 asset URI 代替');
      if (!shot.visual.referenceAssetUri || (project.production && project.audio.type !== 'mute')) {
        const missing = materialStorageMissing(config.storage);
        if (missing.length) throw new Error(`本地参考素材缺少配置：${missing.join('、')}`);
      }
      if (/seedance-1[-.]/i.test(config.model)) throw new Error('当前替换流程需要支持视频与主体参考的 Seedance 2.0/2.5，不能使用 1.x 图生视频模型');
    }
  }
  const steps = shots.map(s => ({ id: s.id, start: s.start, end: s.end, frames: s.frames, operation: s.visual.type, ...(s.visual.type === 'generate' ? { task: s.visual.task, provider: s.visual.provider } : {}) }));
  return { ...compiled, reference, assetPaths, hashes, workflows, steps };
}

export async function render(projectFile: string, out: string, log: (message: string) => void = console.log, engine: 'hypit' | 'legacy' = 'hypit') {
  if (engine === 'legacy') return renderLegacy(projectFile, out, log);
  const { renderHypit } = await import('./hypit.ts');
  return renderHypit(projectFile, out, log);
}

export async function renderLegacy(projectFile: string, out: string, log: (message: string) => void = console.log) {
  const prepared = await plan(projectFile);
  const { project, shots, reference, assetPaths, hashes, workflows } = prepared;
  out = resolve(out);
  await mkdir(out, { recursive: true });
  await json(resolve(out, 'plan.json'), { version: 1, name: project.name, steps: prepared.steps, duration: prepared.duration });
  const segments: string[] = [];
  const records: { id: string; cached: boolean; visual: string; hash: string }[] = [];
  for (const [index, shot] of shots.entries()) {
    const key = fingerprint({ renderer: 2, shot, output: project.output, hashes, providers: project.providers, workflows });
    const directory = resolve(out, 'cache', key);
    await mkdir(directory, { recursive: true });
    const segment = resolve(directory, 'segment.mp4');
    let cached = false;
    try {
      const record = await readJson(resolve(directory, 'done.json')) as { hash: string };
      cached = record.hash === await hashFile(segment);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    log(`分镜 ${index + 1}/${shots.length}：${cached ? '复用已完成片段' : '处理中'}`);
    if (!cached) {
      let sourcePath = reference, start = shot.start, image = false;
      if (shot.visual.type === 'asset') {
        sourcePath = assetPaths[shot.visual.asset]; start = shot.visual.offset;
        image = project.assets[shot.visual.asset].kind === 'image';
      }
      if (shot.visual.type === 'generate') {
        const config = project.providers[shot.visual.provider];
        const referenceClip = resolve(directory, 'reference.mp4');
        if (config.type === 'volcengine-ark') await extractCloudVideo(reference, referenceClip, shot.start, shot.end - shot.start);
        else await extractVideo(reference, referenceClip, shot.start, shot.end - shot.start);
        let audio: string | undefined;
        if (config.type === 'volcengine-ark' ? project.audio.type !== 'mute' : config.bindings.some(b => b.value === 'audio')) {
          audio = resolve(directory, 'speech.wav');
          const audioSource = project.audio.type === 'asset' ? assetPaths[project.audio.asset] : reference;
          const offset = project.audio.type === 'asset' ? project.audio.offset : 0;
          await extractAudio(audioSource, audio, shot.start + offset, shot.end - shot.start);
        }
        sourcePath = resolve(directory, 'generated.mp4'); start = 0;
        const inputs = {
          referenceVideo: referenceClip, subjectImage: assetPaths[project.subjects[shot.visual.task]!], audio,
          prompt: shot.visual.prompt, seed: shot.visual.seed,
          width: project.output.width, height: project.output.height, fps: project.output.fps, frameCount: shot.frames,
          subjectAssetUri: shot.visual.subjectAssetUri, referenceAssetUri: shot.visual.referenceAssetUri,
        };
        if (config.type === 'comfyui') await generate(config, workflows[shot.visual.provider], inputs, sourcePath, log);
        else await generateArk(config, inputs, sourcePath, log);
        const result = await probe(sourcePath);
        if (!result.video || result.duration + 1 / project.output.fps < shot.end - shot.start) throw new Error(`生成片段 ${shot.id} 时长不足，不能截断台词或用静帧补齐`);
      }
      const { width, height, fps } = project.output;
      const filter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},tpad=stop_mode=clone:stop_duration=0.08,trim=end_frame=${shot.frames},setpts=PTS-STARTPTS`;
      await ffmpeg([...(image ? ['-loop', '1', '-framerate', String(fps)] : ['-ss', String(start)]), '-i', sourcePath, '-an', '-vf', filter, '-frames:v', String(shot.frames), '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', segment]);
      await json(resolve(directory, 'done.json'), { hash: await hashFile(segment) });
    }
    segments.push(segment);
    records.push({ id: shot.id, cached, visual: shot.visual.type, hash: await hashFile(segment) });
  }
  // Controlled relative cache names avoid Windows drive-letter and concat quoting ambiguities.
  await writeFile(resolve(out, 'segments.txt'), segments.map(s => `file 'cache/${s.split(/[\\/]/).at(-2)}/segment.mp4'`).join('\n') + '\n');
  await writeFile(resolve(out, 'subtitles.srt'), subtitles(project.words, project.captions.wordsPerLine), 'utf8');
  const args = ['-f', 'concat', '-safe', '1', '-i', 'segments.txt'];
  if (project.audio.type !== 'mute') {
    if (project.audio.type === 'asset') args.push('-ss', String(project.audio.offset));
    args.push('-i', project.audio.type === 'asset' ? assetPaths[project.audio.asset] : reference);
    args.push('-map', '0:v:0', '-map', '1:a:0', '-af', `apad,atrim=duration=${prepared.duration}`, '-c:a', 'aac', '-b:a', '192k');
  } else args.push('-map', '0:v:0', '-an');
  if (project.captions.enabled) args.push('-vf', "subtitles=filename=subtitles.srt:force_style='Fontsize=20,Outline=2,MarginV=24'", '-c:v', 'libx264', '-crf', '20', '-preset', 'fast');
  else args.push('-c:v', 'copy');
  args.push('-t', String(prepared.duration), '-movflags', '+faststart', 'video.mp4');
  log('正在合成画面与声音');
  await ffmpeg(args, out);
  const output = resolve(out, 'video.mp4');
  const finalInfo = await probe(output);
  if (!finalInfo.video || Math.abs(finalInfo.duration - prepared.duration) > 0.12) throw new Error('成片时长校验失败');
  await json(resolve(out, 'manifest.json'), {
    version: 1, name: project.name, duration: finalInfo.duration, output: project.output,
    sourceHashes: hashes, shots: records, audio: project.audio.type, generatedShots: shots.filter(s => s.visual.type === 'generate').length,
    staticImageShots: shots.filter(s => s.visual.type === 'asset' && project.assets[s.visual.asset].kind === 'image').length,
    sha256: await hashFile(output),
  });
  return output;
}
