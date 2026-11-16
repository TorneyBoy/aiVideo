import { randomUUID } from 'node:crypto';
import { cloudFetch, safeMessage, secret } from './cloud-http.ts';
import { speechHeaders } from './doubao.ts';
import { environmentCloudConfig } from './volc-settings.ts';

export async function verifyCloudSetup(settings = environmentCloudConfig()) {
  const checks: { service: string; ok: boolean; message: string }[] = [];
  if (settings.video) {
    try {
      const response = await cloudFetch(`${settings.video.url.replace(/\/$/, '')}/files?limit=1`, { headers: { Authorization: `Bearer ${secret(settings.video.tokenEnv)}` } }, '方舟 Files API');
      await response.arrayBuffer();
      checks.push({ service: '火山方舟', ok: true, message: '素材文件接口可访问；视频模型权限仍需真实任务验证' });
    } catch (error) { checks.push({ service: '火山方舟', ok: false, message: safeMessage(error instanceof Error ? error.message : error) }); }
  } else checks.push({ service: '火山方舟', ok: false, message: '请填写 ARK_VIDEO_MODEL 与 ARK_API_KEY' });
  if (settings.voice) {
    try {
      const response = await cloudFetch(`${settings.voice.url.replace(/\/$/, '')}/api/v3/tts/get_voice`, {
        method: 'POST', headers: speechHeaders(settings.voice, undefined, undefined, true),
        // Query a harmless non-production identity; never create or modify a voice here.
        body: JSON.stringify({ speaker_id: 'custom_speaker_id', custom_speaker_id: 'aivideo_connection_check' }),
      }, '豆包音色查询');
      const body = await response.json();
      if (body.code && ![0, 20000000].includes(Number(body.code))) throw new Error(`豆包业务代码 ${safeMessage(body.code)}：${safeMessage(body.message)}`);
      checks.push({ service: '豆包音色管理', ok: true, message: '音色查询接口可访问；复刻和合成仍需真实任务验证' });
    } catch (error) { checks.push({ service: '豆包音色管理', ok: false, message: safeMessage(error instanceof Error ? error.message : error) }); }
    try {
      const response = await cloudFetch(`${settings.voice.url.replace(/\/$/, '')}/api/v3/auc/bigmodel/query`, {
        method: 'POST', headers: speechHeaders(settings.voice, settings.voice.asrResourceId, randomUUID(), true), body: '{}',
      }, '豆包录音识别查询');
      const body = await response.json();
      const code = String(response.headers.get('X-Api-Status-Code') || body['X-Api-Status-Code'] || body.code || '');
      if (!['20000000', '45000092'].includes(code)) throw new Error(`识别查询返回 ${safeMessage(code)}：${safeMessage(body.message)}`);
      checks.push({ service: '豆包录音识别鉴权', ok: true, message: '查询请求已通过鉴权；使用随机任务 ID，不提交识别任务' });
    } catch (error) { checks.push({ service: '豆包录音识别鉴权', ok: false, message: safeMessage(error instanceof Error ? error.message : error) }); }
  } else checks.push({ service: '豆包语音', ok: false, message: '请将 VOICE_PROVIDER 设置为 doubao' });
  return checks;
}
