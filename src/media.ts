import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { html, json } from './files.ts';
import { projectSchema, transcriptSchema } from './schema.ts';
import type { Word } from './schema.ts';
import { validateWords } from './timeline.ts';

export const binaries = { ffmpeg: process.env.FFMPEG_PATH || (ffmpegStatic as unknown as string), ffprobe: process.env.FFPROBE_PATH || ffprobeStatic.path };

export function videoOutputSize(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('视频尺寸无效');
  const scale = Math.min(1, 1920 / Math.max(width, height));
  return { width: Math.max(64, Math.floor(width * scale / 2) * 2), height: Math.max(64, Math.floor(height * scale / 2) * 2) };
}

export async function command(binary: string, args: string[], cwd?: string, timeout = 600000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((accept, reject) => {
    const child = spawn(binary, args, { cwd, windowsHide: true, shell: false });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('媒体处理超时')); }, timeout);
    child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-16000000); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) accept({ stdout, stderr });
      else reject(new Error(`媒体处理失败（${code}）：${stderr.slice(-2000)}`));
    });
  });
}

export async function ffmpeg(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  const threads = process.env.AIVIDEO_FFMPEG_THREADS?.trim();
  if (threads && !/^(?:[1-9]|1[0-6])$/.test(threads)) throw new Error('AIVIDEO_FFMPEG_THREADS 需要为 1–16');
  const bounded = threads && args.length ? ['-threads', threads, '-filter_threads', threads, '-filter_complex_threads', threads, ...args.slice(0, -1), '-threads', threads, args.at(-1)!] : args;
  return command(binaries.ffmpeg, ['-hide_banner', '-nostdin', '-y', ...bounded], cwd);
}

export async function probe(path: string) {
  const { stdout } = await command(binaries.ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path]);
  const info = JSON.parse(stdout) as { format?: { duration?: string }; streams: { codec_type: string; codec_name?: string; width?: number; height?: number; duration?: string; avg_frame_rate?: string }[] };
  const video = info.streams.find(s => s.codec_type === 'video');
  const audio = info.streams.some(s => s.codec_type === 'audio');
  const duration = Number(info.format?.duration || video?.duration || 0);
  return { duration, video, audio, streams: info.streams };
}

export function splitScenes(cuts: number[], duration: number, maxShot = 5): { start: number; end: number }[] {
  if (!Number.isFinite(duration) || duration <= 0 || maxShot <= 0) throw new Error('视频时长无效');
  const boundaries = [0];
  for (const cut of [...cuts].sort((a, b) => a - b)) {
    if (cut - boundaries.at(-1)! >= 0.4 && duration - cut >= 0.4) boundaries.push(cut);
  }
  boundaries.push(duration);
  return boundaries.slice(0, -1).flatMap((start, index) => {
    const end = boundaries[index + 1];
    const pieces = Math.ceil((end - start) / maxShot);
    return Array.from({ length: pieces }, (_, n) => ({ start: start + (end - start) * n / pieces, end: start + (end - start) * (n + 1) / pieces }));
  });
}

export async function extractAudio(source: string, output: string, start = 0, duration?: number): Promise<void> {
  await ffmpeg(['-ss', String(start), '-i', source, ...(duration ? ['-t', String(duration)] : []), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output]);
}

export async function extractVideo(source: string, output: string, start: number, duration: number): Promise<void> {
  await ffmpeg(['-ss', String(start), '-i', source, '-t', String(duration), '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', output]);
}

export async function extractCloudVideo(source: string, output: string, start: number, duration: number): Promise<void> {
  const info = await probe(source);
  const ratio = info.video?.width! / info.video?.height!;
  if (!Number.isFinite(ratio) || ratio < 0.4 || ratio > 2.5) throw new Error('火山参考视频宽高比需要在 0.4–2.5 之间');
  const width = ratio >= 1 ? Math.round(720 * ratio / 2) * 2 : 720;
  const height = ratio >= 1 ? 720 : Math.round(720 / ratio / 2) * 2;
  await ffmpeg(['-ss', String(start), '-i', source, '-t', String(duration), '-an', '-vf', `scale=${width}:${height},setsar=1,fps=24`, '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', output]);
}

export function cloudRanges(duration: number, fps: number, singleAsset = false) {
  if (!Number.isFinite(duration) || !Number.isFinite(fps) || fps < 1 || duration < 4) throw new Error('火山视频替换需要至少 4 秒的参考视频');
  const total = Math.round(duration * fps);
  if (total / fps < 4) throw new Error('火山视频替换需要至少 4 秒的参考视频');
  if (singleAsset && total / fps > 15) throw new Error('使用已授权参考视频资产时，请将本次参考视频限制在 4–15 秒；长片需分别注册分段资产');
  const count = singleAsset ? 1 : Math.ceil(total / fps / 12);
  return Array.from({ length: count }, (_, i) => ({ start: Math.round(total * i / count) / fps, end: Math.round(total * (i + 1) / count) / fps }));
}

export async function analyze(reference: string, out: string, options: { threshold?: number; maxShot?: number; words?: unknown } = {}) {
  reference = resolve(reference); out = resolve(out);
  await mkdir(out, { recursive: true });
  const info = await probe(reference);
  if (!info.video || info.duration <= 0) throw new Error('参考文件必须是具有有效时长的视频');
  if (info.duration > 180) throw new Error('首版支持最长 180 秒的参考视频，请先裁剪');
  const threshold = options.threshold ?? 0.3;
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) throw new Error('切镜阈值需要在 0 和 1 之间');
  const { stderr } = await ffmpeg(['-i', reference, '-an', '-vf', `scale=320:-2,select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-']);
  const cuts = [...stderr.matchAll(/\bpts_time:([\d.]+)/g)].map(m => Number(m[1]));
  const scenes = splitScenes(cuts, info.duration, options.maxShot ?? 5);
  const fps = 25;
  const frameCount = Math.floor(info.duration * fps);
  if (frameCount < 1) throw new Error('视频不足一帧');
  let previous = 0;
  const shots = scenes.flatMap((scene, i) => {
    const end = i === scenes.length - 1 ? frameCount : Math.min(frameCount, Math.round(scene.end * fps));
    if (end <= previous) return [];
    const shot = { id: `shot-${String(i + 1).padStart(3, '0')}`, start: previous / fps, end: end / fps, visual: { type: 'reference' as const } };
    previous = end;
    return [shot];
  });
  const words: Word[] = options.words === undefined ? [] : transcriptSchema.parse(options.words);
  validateWords(words);
  const project = projectSchema.parse({
    version: 1, name: basename(reference), reference,
    output: { ...videoOutputSize(info.video.width!, info.video.height!), fps },
    words, audio: { type: info.audio ? 'reference' : 'mute' }, shots,
  });
  await mkdir(resolve(out, 'frames'), { recursive: true });
  for (const shot of shots) {
    await ffmpeg(['-ss', String((shot.start + shot.end) / 2), '-i', reference, '-frames:v', '1', '-vf', 'scale=360:-2', '-update', '1', resolve(out, 'frames', `${shot.id}.jpg`)]);
  }
  if (info.audio) await extractAudio(reference, resolve(out, 'reference.wav'));
  await json(resolve(out, 'project.json'), project);
  await json(resolve(out, 'analysis.json'), { method: 'ffmpeg-scene-threshold', threshold, sourceDuration: info.duration, scenes: shots.length, hasAudio: info.audio, note: '切镜与定长分段，不含人物/商品识别、OCR 或语义分析' });
  await writeFile(resolve(out, 'storyboard.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>参考视频分镜</title><style>body{font:16px system-ui;background:#12171b;color:#e7eee9;padding:32px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:20px}img{width:100%;max-height:320px;object-fit:contain}figure{margin:0;background:#202a2b;padding:16px;border-radius:12px}p{color:#a6b6af}</style><h1>${html(project.name)}</h1><p>参考视频分镜 · ${shots.length} 段 · 尚未进行主体替换</p><main>${shots.map(s => `<figure><img src="frames/${s.id}.jpg" alt="${s.id}"><figcaption>${s.id} · ${s.start.toFixed(2)}–${s.end.toFixed(2)} 秒</figcaption></figure>`).join('')}</main></html>`, 'utf8');
  return project;
}
