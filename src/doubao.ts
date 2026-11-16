import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ArkClient } from './ark.ts';
import { cloudFetch, cloudJson, download, safeMessage, secret, CloudHttpError } from './cloud-http.ts';
import { fingerprint, hashFile, json, readJson } from './files.ts';
import { extractAudio, ffmpeg, probe } from './media.ts';
import type { DoubaoConfig } from './volc-settings.ts';
import { readVoiceReview, requireVoiceConsent } from './voice-consent.ts';
import { voiceAccount as account } from './voice-account.ts';
import { validateSavedVoice } from './saved-voice.ts';

export type TimedWord = { text: string; start: number; end: number };
export type Utterance = { text: string; start: number; end: number; words?: TimedWord[]; speaker?: string };
export type WordUtterance = Utterance & { words: TimedWord[] };

export function speechHeaders(config: DoubaoConfig, resource?: string, requestId: string = randomUUID(), asr = false): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Api-Request-Id': requestId };
  if (process.env[config.apiKeyEnv]?.trim()) headers['X-Api-Key'] = secret(config.apiKeyEnv);
  else {
    headers[asr ? 'X-Api-App-Key' : 'X-Api-App-Id'] = secret(config.appIdEnv);
    headers['X-Api-Access-Key'] = secret(config.accessTokenEnv);
  }
  if (resource) headers['X-Api-Resource-Id'] = resource;
  return headers;
}

function endpoint(config: DoubaoConfig, path: string) { return `${config.url.replace(/\/$/, '')}${path}`; }
function bodyStatus(response: Response, body: any): string {
  return String(response.headers.get('X-Api-Status-Code') || body['X-Api-Status-Code'] || body.code || '');
}

export function parseUtterances(body: any, duration: number): Utterance[] {
  const list = body.result?.utterances;
  if (!Array.isArray(list)) throw new Error('豆包识别未返回分句时间戳，请确认 show_utterances 权限与服务版本');
  const result: Utterance[] = [];
  for (const item of list) {
    const text = typeof item.text === 'string' ? item.text.replace(/[\r\n\u0000-\u0008]/g, ' ').trim() : '';
    const start = Number(item.start_time) / 1000, end = Math.min(duration, Number(item.end_time) / 1000);
    if (!text) continue;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || start < (result.at(-1)?.end || 0) - 0.02) throw new Error('豆包转写分句时间戳无效或重叠');
    result.push({ text, start: Math.max(start, result.at(-1)?.end || 0), end });
  }
  if (!result.length) throw new Error('参考视频没有识别到台词，请检查原声或关闭声音替换');
  return result;
}

/** Word boundaries must come from the service. Sentence interpolation is never an alignment fallback. */
export function parseWordUtterances(body: any, duration: number): WordUtterance[] {
  if (Array.isArray(body.result?.utterances) && body.result.utterances.length === 0) return [];
  const utterances = parseUtterances(body, duration);
  const source = body.result.utterances.filter((item: any) => typeof item.text === 'string' && item.text.trim());
  let previous = 0;
  return utterances.map((utterance, index) => {
    const item = source[index];
    if (!Array.isArray(item.words) || !item.words.length) throw new Error('豆包未返回逐词时间戳，停止逐词对齐；不会用分句时间均分代替');
    const words = item.words.map((word: any) => {
      const text = typeof word.text === 'string' ? word.text.trim() : '';
      const start = Number(word.start_time) / 1000, end = Number(word.end_time) / 1000;
      if (!text || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > duration + 0.02 || start < previous - 0.002 || start < utterance.start - 0.02 || end > utterance.end + 0.02) throw new Error('豆包逐词时间戳缺失、越界或重叠');
      previous = end;
      return { text, start, end: Math.min(end, duration) };
    });
    const speaker = item.additions?.speaker_id ?? item.additions?.speaker ?? item.speaker_id;
    return { ...utterance, words, ...(speaker === undefined ? {} : { speaker: String(speaker) }) };
  });
}

export async function transcribe(config: DoubaoConfig, ark: Pick<ArkClient, 'upload'>, source: string, duration: number, out: string, log: (message: string) => void, remoteAudio?: { url: string; format: 'wav' | 'mp3' | 'mp4' }, wordTimestamps = false): Promise<Utterance[]> {
  await mkdir(out, { recursive: true });
  if (remoteAudio && !/^https:\/\//.test(remoteAudio.url)) throw new Error('公开识别音频必须使用 HTTPS 地址');
  const signature = fingerprint({ version: wordTimestamps ? 2 : 1, hash: await hashFile(source), duration, account: account(config), resource: config.asrResourceId, language: config.language, remoteAudio });
  const path = resolve(out, wordTimestamps ? 'asr-words.json' : 'asr.json');
  let receipt: { signature: string; requestId: string; taskId?: string; result?: Utterance[]; phase?: string } | undefined;
  try { const value = await readJson(path) as NonNullable<typeof receipt>; if (value.signature === signature) receipt = value; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (receipt?.phase === 'rejected') receipt = undefined;
  if (receipt?.result) { log('复用已完成的台词转写'); return receipt.result; }
  if (!receipt) {
    const url = remoteAudio?.url || await ark.upload(source);
    receipt = { signature, requestId: randomUUID() };
    // Save the client-generated ID before submitting; an interrupted request is queried first.
    await json(path, receipt);
    const headers = speechHeaders(config, config.asrResourceId, receipt.requestId, true);
    headers['X-Api-Sequence'] = '-1';
    let response: Response;
    try { response = await cloudFetch(endpoint(config, '/api/v3/auc/bigmodel/submit'), {
      method: 'POST', headers, body: JSON.stringify({ user: { uid: 'aivideo' }, audio: { url, format: remoteAudio?.format || 'wav', ...(remoteAudio ? {} : { rate: 16000, bits: 16, channel: 1 }), language: config.language === 'cn' ? 'zh-CN' : 'en-US' }, request: { model_name: 'bigmodel', show_utterances: true, enable_punc: true, enable_itn: !wordTimestamps, enable_ddc: false, ...(wordTimestamps ? { enable_speaker_info: true } : {}) } }),
    }, '豆包台词提交'); }
    catch (error) {
      if (error instanceof CloudHttpError && error.status >= 400 && error.status < 500 && error.status !== 408) { receipt.phase = 'rejected'; await json(path, receipt); }
      throw error;
    }
    const body = await response.json();
    const status = bodyStatus(response, body);
    if (status !== '20000000') {
      receipt.phase = 'rejected'; await json(path, receipt);
      throw new Error(`豆包转写未受理（${status}），请确认已开通 ${config.asrResourceId}`);
    }
    if (typeof body.task_id === 'string') receipt.taskId = body.task_id;
    await json(path, receipt);
    log('台词识别已提交，正在等待结果');
  } else log('继续查询此前的台词识别任务');
  const deadline = Date.now() + config.timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const headers = speechHeaders(config, config.asrResourceId, receipt.taskId || receipt.requestId, true);
    const response = await cloudFetch(endpoint(config, '/api/v3/auc/bigmodel/query'), { method: 'POST', headers, body: '{}' }, '豆包台词查询');
    const body = await response.json();
    const status = bodyStatus(response, body);
    if (status === '20000000') {
      receipt.result = wordTimestamps ? parseWordUtterances(body, duration) : parseUtterances(body, duration);
      await json(path, receipt);
      return receipt.result;
    }
    if (!['20000001', '20000002'].includes(status)) throw new Error(`豆包转写失败（${status}）：${safeMessage(body.message || body['X-Api-Message'])}`);
    await delay(config.pollIntervalMs);
  }
  throw new Error('台词识别等待超时，任务回执已保存，可继续查询');
}

export async function transcribeWords(config: DoubaoConfig, ark: Pick<ArkClient, 'upload'>, source: string, duration: number, out: string, log: (message: string) => void): Promise<WordUtterance[]> {
  return await transcribe(config, ark, source, duration, out, log, undefined, true) as WordUtterance[];
}

export async function cloneSpeaker(config: DoubaoConfig, sample: string | undefined, out: string, log: (message: string) => void, audition?: { id: string; text: string }): Promise<string> {
  if (!sample) {
    if (!config.speakerId) throw new Error('请上传目标声音样本，或在 .env 填写现有 VOLC_SPEECH_SPEAKER_ID');
    log('使用已配置的豆包复刻音色'); return config.speakerId;
  }
  await mkdir(out, { recursive: true });
  const info = await probe(sample);
  if (!info.audio || info.duration < 3 || info.duration > 30) throw new Error('复刻录音需要 3–30 秒清晰人声');
  const signature = fingerprint({ version: 1, sample: await hashFile(sample), account: account(config), language: config.language, slot: config.cloneSpeakerId, audition });
  await requireVoiceConsent(out, 'register', signature, { sampleName: basename(sample) });
  const path = resolve(out, `speaker-${signature}.json`);
  const customId = `aivideo_${signature.slice(0, 24)}`;
  const voiceIdentity = config.cloneSpeakerId ? { speaker_id: config.cloneSpeakerId } : { speaker_id: 'custom_speaker_id', custom_speaker_id: customId };
  const query = () => cloudJson(endpoint(config, '/api/v3/tts/get_voice'), { method: 'POST', headers: speechHeaders(config, undefined, randomUUID(), true), body: JSON.stringify(voiceIdentity) }, '豆包音色查询');
  const ready = async (result: any, speaker: string) => {
    // Preview is returned by registration/query, never synthesized through the billable TTS endpoint.
    const candidates = Array.isArray(result.speaker_status) ? result.speaker_status : [];
    const url = [5, 4, 1].map(type => candidates.find((item: any) => item.model_type === type && typeof item.demo_audio === 'string')?.demo_audio).find(Boolean);
    if (url) {
      const raw = resolve(out, 'preview-source.audio'), preview = resolve(out, 'preview.wav');
      try {
        await download(url, raw, 16 * 1024 * 1024);
        await ffmpeg(['-i', raw, '-vn', '-t', '60', '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', preview]);
        await json(resolve(out, 'preview.json'), { speaker, sampleSignature: signature, hash: await hashFile(preview) });
      } catch { log('音色已注册，试听文件暂未取得；可继续查询或到豆包控制台试听'); }
    }
    await json(path, { phase: 'ready', speaker });
    return speaker;
  };
  let receipt: { phase: string; speaker?: string } | undefined;
  try { receipt = await readJson(path) as NonNullable<typeof receipt>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (receipt?.phase === 'rejected') receipt = undefined;
  if (!receipt) {
    // Query the deterministic identity first so repeated jobs reuse a voice, without retraining.
    const prior = await query().catch(error => {
      if (error instanceof Error && /HTTP (400|404)：/.test(error.message)) return undefined;
      throw error;
    });
    if (prior && [2, 4].includes(prior.status)) {
      if (config.cloneSpeakerId) throw new Error('指定的音色槽位已训练；为避免覆盖，请用 SPEAKER_ID 复用，或改用未训练的 CLONE_SPEAKER_ID');
      const speaker = typeof prior.speaker_id === 'string' && prior.speaker_id !== 'custom_speaker_id' ? prior.speaker_id : customId;
      log('复用相同录音已注册的豆包音色'); return ready(prior, speaker);
    }
    if (prior?.status === 1) {
      receipt = { phase: 'pending' }; await json(path, receipt);
    }
  }
  if (!receipt) {
    const wav = resolve(out, `sample-${signature}.wav`);
    await extractAudio(sample, wav);
    const audio = await readFile(wav);
    if (audio.byteLength > 10 * 1024 * 1024) throw new Error('声音复刻样本超过 10 MB');
    receipt = { phase: 'submitting' };
    await json(path, receipt);
    try {
      const result = await cloudJson(endpoint(config, '/api/v3/tts/voice_clone'), { method: 'POST', headers: speechHeaders(config, undefined, randomUUID(), true), body: JSON.stringify({ ...voiceIdentity, audio: { data: audio.toString('base64'), format: 'wav' }, language: config.language === 'cn' ? 0 : 1, ...(audition ? { extra_params: { demo_text: audition.text } } : {}) }) }, '豆包音色注册');
      if (result.code && ![0, 20000000].includes(Number(result.code))) throw new Error(`豆包音色注册失败（${safeMessage(result.code)}）`);
      receipt.phase = 'pending';
      await json(path, receipt);
      if ([2, 4].includes(result.status) && Array.isArray(result.speaker_status) && result.speaker_status.some((item: any) => typeof item.demo_audio === 'string')) {
        const speaker = typeof result.speaker_id === 'string' && result.speaker_id !== 'custom_speaker_id' ? result.speaker_id : config.cloneSpeakerId || customId;
        return ready(result, speaker);
      }
    } catch (error) {
      // A deterministic custom ID can already exist from a previous job or a lost response.
      const existing = await query().catch(() => undefined);
      if (!existing || ![1, 2, 4].includes(existing.status)) {
        if (error instanceof CloudHttpError && error.status >= 400 && error.status < 500 && error.status !== 408) { receipt.phase = 'rejected'; await json(path, receipt); }
        throw error;
      }
    }
    log('目标声音已提交复刻，正在等待音色就绪');
  } else log('正在确认已注册的目标音色');
  const deadline = Date.now() + config.timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const result = await query();
    if ([2, 4].includes(result.status)) {
      const speaker = typeof result.speaker_id === 'string' && result.speaker_id !== 'custom_speaker_id' ? result.speaker_id : config.cloneSpeakerId || customId;
      return ready(result, speaker);
    }
    if (![1].includes(result.status)) throw new Error(`豆包音色尚不可用（状态 ${safeMessage(result.status)}），请检查样本及音色权限`);
    await delay(config.pollIntervalMs);
  }
  throw new Error('豆包音色复刻等待超时，继续处理可查询同一音色');
}

/** Strictly consume SSE/NDJSON; partial streams must never become a usable audio file. */
export async function decodeTts(response: Response): Promise<Buffer> {
  if (!response.body) throw new Error('豆包语音合成没有返回音频流');
  const decoder = new TextDecoder();
  let buffer = '', complete = false, bytes = 0;
  const chunks: Buffer[] = [];
  const consume = (line: string) => {
    line = line.trim();
    if (!line || line.startsWith('event:') || line.startsWith(':') || line.startsWith('id:')) return;
    if (line.startsWith('data:')) line = line.slice(5).trim();
    if (line === '[DONE]') { complete = true; return; }
    let item: any;
    try { item = JSON.parse(line); } catch { throw new Error('豆包语音流格式无效'); }
    if (![0, 20000000].includes(item.code)) throw new Error(`豆包语音合成失败（${safeMessage(item.code)}）：${safeMessage(item.message)}`);
    if (item.data) {
      if (typeof item.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.data)) throw new Error('豆包音频编码无效');
      const chunk = Buffer.from(item.data, 'base64'); bytes += chunk.length;
      if (bytes > 40 * 1024 * 1024) throw new Error('单句豆包音频超过大小限制');
      chunks.push(chunk);
    }
    if (item.code === 20000000) complete = true;
  };
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > 60 * 1024 * 1024) throw new Error('豆包语音流超过大小限制');
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, index)); buffer = buffer.slice(index + 1); }
  }
  buffer += decoder.decode(); if (buffer.trim()) consume(buffer);
  if (!complete || !bytes || bytes % 2) throw new Error('豆包音频流未完整结束，已拒绝使用不完整配音');
  return Buffer.concat(chunks);
}

async function cachedSpeech(config: DoubaoConfig, speaker: string, text: string, out: string, log: (message: string) => void): Promise<string> {
  await mkdir(out, { recursive: true });
  const signature = fingerprint({ version: 1, account: account(config), resource: config.resourceId, speaker, text, rate: config.speechRate });
  const raw = resolve(out, `${signature}.pcm`), receipt = `${raw}.json`;
  let cached = false;
  try { cached = (await readJson(receipt) as { hash: string }).hash === await hashFile(raw); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  log(cached ? '复用已合成台词' : '合成目标音色');
  if (!cached) {
    const response = await cloudFetch(endpoint(config, '/api/v3/tts/unidirectional/sse'), {
      method: 'POST', headers: speechHeaders(config, config.resourceId),
      body: JSON.stringify({ user: { uid: 'aivideo' }, req_params: { text, speaker, audio_params: { format: 'pcm', sample_rate: 24000, speech_rate: config.speechRate } } }),
    }, '豆包语音合成', 180000);
    const pcm = await decodeTts(response);
    await writeFile(`${raw}.tmp`, pcm); await rename(`${raw}.tmp`, raw);
    await json(receipt, { hash: await hashFile(raw) });
  }
  return raw;
}

/** A standalone voice is activated only after its reviewed candidate has explicit fee consent. */
export async function activateSpeaker(config: DoubaoConfig, speaker: string, text: string, out: string, log: (message: string) => void) {
  await requireVoiceConsent(out, 'activate', fingerprint({ version: 1, operation: 'library-activation', account: account(config), speaker, text, resource: config.resourceId, rate: config.speechRate }), { speaker, characters: text.length });
  const raw = await cachedSpeech(config, speaker, text, resolve(out, 'speech-cache'), log);
  const output = resolve(out, 'activation.wav');
  await ffmpeg(['-f', 's16le', '-ar', '24000', '-ac', '1', '-i', raw, '-c:a', 'pcm_s16le', output]);
  return output;
}

export async function synthesizeNarration(config: DoubaoConfig, speaker: string, utterances: Utterance[], duration: number, out: string, log: (message: string) => void, confirmedVoiceDirectory?: string, preservedSource?: string): Promise<string> {
  await mkdir(out, { recursive: true });
  if (!Number.isFinite(duration) || duration <= 0 || duration > 180) throw new Error('配音时长无效');
  if (confirmedVoiceDirectory) await validateSavedVoice(config, speaker, confirmedVoiceDirectory);
  else await requireVoiceConsent(out, 'activate', fingerprint({ version: 1, account: account(config), speaker, resource: config.resourceId, rate: config.speechRate, utterances, duration, registration: (await readVoiceReview(out, 'register'))?.binding }), { speaker, characters: utterances.reduce((n, item) => n + item.text.length, 0) });
  const timeline = Buffer.alloc(Math.round(duration * 48000) * 2);
  if (preservedSource) {
    const original = resolve(out, 'preserved-source.pcm');
    await ffmpeg(['-i', preservedSource, '-vn', '-af', `apad,atrim=duration=${duration}`, '-ac', '1', '-ar', '48000', '-f', 's16le', original]);
    (await readFile(original)).copy(timeline, 0, 0, timeline.length);
  }
  for (const [index, utterance] of utterances.entries()) {
    log(`豆包配音 ${index + 1}/${utterances.length}`);
    const raw = await cachedSpeech(config, speaker, utterance.text, confirmedVoiceDirectory ? resolve(confirmedVoiceDirectory, 'speech-cache') : out, log);
    const size = (await readFile(raw)).byteLength;
    const desired = utterance.end - utterance.start;
    const ratio = (size / 2 / 24000) / desired;
    if (ratio < 0.65 || ratio > 1.35) throw new Error(`第 ${index + 1} 句配音与原台词时长相差过大，请调整 VOLC_SPEECH_RATE 后继续处理`);
    const aligned = resolve(out, `aligned-${index}.pcm`);
    await ffmpeg(['-f', 's16le', '-ar', '24000', '-ac', '1', '-i', raw, '-af', `atempo=${ratio},apad,atrim=duration=${desired}`, '-ar', '48000', '-ac', '1', '-f', 's16le', aligned]);
    const pcm = await readFile(aligned);
    const offset = Math.round(utterance.start * 48000) * 2;
    timeline.fill(0, offset, Math.min(timeline.length, Math.round(utterance.end * 48000) * 2));
    pcm.copy(timeline, offset, 0, Math.min(pcm.length, timeline.length - offset, Math.round(utterance.end * 48000) * 2 - offset));
  }
  const pcm = resolve(out, 'timeline.pcm'), narration = resolve(out, 'narration.wav');
  await writeFile(pcm, timeline);
  await ffmpeg(['-f', 's16le', '-ar', '48000', '-ac', '1', '-i', pcm, '-c:a', 'pcm_s16le', narration]);
  return narration;
}
