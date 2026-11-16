import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { fingerprint, hashFile, json, readJson } from './files.ts';
import { extractAudio, ffmpeg, probe } from './media.ts';

export const voiceConfigSchema = z.object({
  url: z.url(), tokenEnv: z.string().optional(), timeoutSeconds: z.number().int().min(1).max(3600).default(300),
}).strict();
export type VoiceConfig = z.infer<typeof voiceConfigSchema>;

export async function convertVoice(source: string, target: string, segments: { start: number; end: number }[], config: VoiceConfig, out: string, log: (message: string) => void): Promise<string> {
  await mkdir(out, { recursive: true });
  const sample = resolve(out, 'target.wav');
  const targetInfo = await probe(target);
  if (!targetInfo.audio || targetInfo.duration < 3 || targetInfo.duration > 30) throw new Error('目标音色需要 3–30 秒的有效录音，建议 10–30 秒清晰干声');
  await extractAudio(target, sample);
  const headers = new Headers();
  if (config.tokenEnv) {
    if (!process.env[config.tokenEnv]) throw new Error(`缺少语音服务环境变量 ${config.tokenEnv}`);
    headers.set('Authorization', `Bearer ${process.env[config.tokenEnv]}`);
  }
  const sourceHash = await hashFile(source), targetHash = await hashFile(sample);
  const paths: string[] = [];
  for (const [index, segment] of segments.entries()) {
    const key = fingerprint({ version: 1, sourceHash, targetHash, segment, config });
    const aligned = resolve(out, `${key}.wav`);
    let cached = false;
    try { cached = (await readJson(`${aligned}.json`) as { hash: string }).hash === await hashFile(aligned); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    log(`声音 ${index + 1}/${segments.length}：${cached ? '复用已转换音频' : '转换目标音色'}`);
    if (!cached) {
      const input = resolve(out, `${key}.source.wav`), raw = resolve(out, `${key}.raw.wav`);
      const duration = segment.end - segment.start;
      await extractAudio(source, input, segment.start, duration);
      const form = new FormData();
      form.append('source', new Blob([await readFile(input)], { type: 'audio/wav' }), 'source.wav');
      form.append('target', new Blob([await readFile(sample)], { type: 'audio/wav' }), 'target.wav');
      const response = await fetch(`${config.url.replace(/\/$/, '')}/voice-convert`, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(config.timeoutSeconds * 1000) });
      if (!response.ok) throw new Error(`声音转换失败：HTTP ${response.status}`);
      await writeFile(raw, Buffer.from(await response.arrayBuffer()));
      const info = await probe(raw);
      const ratio = info.duration / duration;
      if (!info.audio || ratio < 0.85 || ratio > 1.15) throw new Error('转换后的声音时长偏差超过 15%，请检查样本和语音模型');
      await ffmpeg(['-i', raw, '-af', `atempo=${ratio},apad,atrim=duration=${duration}`, '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', aligned]);
      await json(`${aligned}.json`, { hash: await hashFile(aligned) });
    }
    paths.push(`${key}.wav`);
  }
  await writeFile(resolve(out, 'concat.txt'), paths.map(p => `file '${p}'`).join('\n') + '\n');
  const final = resolve(out, 'narration.wav');
  await ffmpeg(['-f', 'concat', '-safe', '1', '-i', 'concat.txt', '-c:a', 'pcm_s16le', final], out);
  return final;
}
