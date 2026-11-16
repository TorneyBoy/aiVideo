import { mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { generateArk } from './ark.ts';
import { cloudJson, download, safeMessage } from './cloud-http.ts';
import { cloneSpeaker, speechHeaders, synthesizeNarration, transcribe } from './doubao.ts';
import { json } from './files.ts';
import { probe } from './media.ts';
import { environmentCloudConfig } from './volc-settings.ts';
import { VoiceConsentRequired } from './voice-consent.ts';

// Public samples published in the vendor's video-editing and standard ASR docs.
const videoUrl = 'https://arkdocs.tos-cn-beijing.volces.com/videos/video-generation/r2v_edit_video1.mp4';
const imageUrl = 'https://arkdocs.tos-cn-beijing.volces.com/images/video-generation/r2v_edit_pic1.jpg';
const speechUrl = 'https://lf3-static.bytednsdoc.com/obj/eden-cn/lm_hz_ihsph/ljhwZthlaukjlkulzlp/console/bigtts/zh_female_cancan_mars_bigtts.mp3';

/** Explicit, billable integration command; never called by normal tests or cloud:check. */
export async function smokeCloud(out: string, voiceSample: string | undefined, log = console.log) {
  out = resolve(out); await mkdir(out, { recursive: true });
  const settings = environmentCloudConfig();
  const checks: { stage: string; ok: boolean; message: string; output?: string }[] = [];
  const run = async (stage: string, work: () => Promise<{ message: string; output?: string }>) => {
    try { checks.push({ stage, ok: true, ...await work() }); }
    catch (error) {
      checks.push({ stage, ok: false, message: safeMessage(error instanceof Error ? error.message : error) });
      if (error instanceof VoiceConsentRequired) log(`请先核对音色：npm run video -- voice-review --out "${resolve(out, 'voice')}" --stage ${error.review.stage}；确认后才能继续。`);
    }
    log(`${stage}：${checks.at(-1)!.ok ? '通过' : '未通过'}。${checks.at(-1)!.message}`);
    await json(resolve(out, 'report.json'), { checkedAt: new Date().toISOString(), fixtures: 'vendor-public-samples', checks });
  };
  const fixture = async (name: string, url: string) => {
    const path = resolve(out, name);
    if (!(await stat(path).catch(() => undefined))?.size) await download(url, path);
    return path;
  };
  await run('公开商品替换', async () => {
    if (!settings.video) throw new Error('请先填写 ARK_VIDEO_MODEL');
    const referenceVideo = await fixture('reference.mp4', videoUrl), subjectImage = await fixture('target.jpg', imageUrl);
    const info = await probe(referenceVideo), output = resolve(out, 'generated.mp4');
    await generateArk(settings.video, {
      referenceVideo, subjectImage, referenceUrl: videoUrl,
      prompt: '将视频中的礼盒主体替换为参考图片中的 seedance 面霜罐，保留面霜罐的外形、金色雕花盖和包装文字。保持原视频的镜头运动、暖金色灯光、展示节奏和简洁背景，制作商品宣传片。',
      seed: 42, width: 854, height: 480, fps: 30, frameCount: Math.round(info.duration * 30),
    }, output, log);
    const result = await probe(output);
    if (!result.video || result.duration < info.duration - 1 / 30) throw new Error('生成视频无效或时长不足');
    return { message: `生成 ${result.duration.toFixed(2)} 秒示例视频；商品一致性仍需观看验收`, output };
  });
  let words: Awaited<ReturnType<typeof transcribe>> | undefined, speechDuration = 0;
  await run('公开语音识别', async () => {
    if (!settings.voice) throw new Error('请设置 VOICE_PROVIDER=doubao');
    const source = await fixture('speech.mp3', speechUrl);
    speechDuration = (await probe(source)).duration;
    // The public sample requires no upload or Ark credential. Any accidental upload fails early.
    const uploader = { upload: async () => { throw new Error('公开语音测试不应触发本地上传'); } };
    words = await transcribe(settings.voice, uploader, source, speechDuration, resolve(out, 'asr'), log, { url: speechUrl, format: 'mp3' });
    return { message: `识别完成，共 ${words.length} 个带时间戳的分句`, output: resolve(out, 'asr/asr.json') };
  });
  await run('声音复刻与配音', async () => {
    if (!settings.voice) throw new Error('请设置 VOICE_PROVIDER=doubao');
    // Check actual timbre permission before requiring a sample, without registering a voice.
    await cloudJson(`${settings.voice.url.replace(/\/$/, '')}/api/v3/tts/get_voice`, {
      method: 'POST', headers: speechHeaders(settings.voice, undefined, undefined, true),
      body: JSON.stringify({ speaker_id: 'custom_speaker_id', custom_speaker_id: 'aivideo_connection_check' }),
    }, '豆包音色查询');
    if (!voiceSample && !settings.voice.speakerId) throw new Error('音色查询已通过；真实复刻请添加 --voice-sample 自己的3–30秒录音，或填写现有音色 ID');
    if (!words) throw new Error('识别未完成，无法测试原台词配音');
    const speaker = await cloneSpeaker(settings.voice, voiceSample ? resolve(voiceSample) : undefined, resolve(out, 'voice'), log);
    const output = await synthesizeNarration(settings.voice, speaker, words, speechDuration, resolve(out, 'voice'), log);
    return { message: '目标音色复刻与原台词合成完成；音色效果仍需试听', output };
  });
  // A real human test needs the user's authorized portrait assets, so never pretend this product fixture verifies it.
  log('真人替换需使用已授权的肖像素材另行验收；公开商品示例不验证人物身份或口型。');
  return checks;
}
