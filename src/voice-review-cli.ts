import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { approveVoiceReview, readVoiceReview } from './voice-consent.ts';
import type { VoiceStage } from './voice-consent.ts';

export async function reviewVoiceCli(out: string, stage: VoiceStage, confirm: boolean) {
  const review = await readVoiceReview(resolve(out), stage);
  if (!review) throw new Error('没有这个阶段的待确认音色，请先运行原来的联调命令');
  console.log(stage === 'register' ? '将上传目标录音至豆包并注册试听音色。' : '将正式合成台词，新后付费音色首次合成可能触发槽位费，另有合成用量费。');
  console.log(`确认编号：${review.id}`);
  if (review.details?.sampleName) console.log(`目标录音：${review.details.sampleName}`);
  if (review.details?.speaker) console.log(`音色 ID：${review.details.speaker}`);
  if (review.details?.characters !== undefined) console.log(`本次台词：${review.details.characters} 字符`);
  if (stage === 'activate') console.log(`试听文件（如已取得）：${resolve(out, 'preview.wav')}；金额以豆包控制台为准。`);
  if (review.approvedAt) { console.log('该版本已经确认；输入、账号或音色变化时仍会要求重新确认。'); return; }
  if (!confirm) { console.log('尚未确认。请核对后在交互终端使用 voice-confirm；此命令不提交模型请求。'); return; }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('音色确认需要你在交互终端输入确认文字，不能用管道或自动化参数代替；也可以在工作台页面确认');
  const phrase = stage === 'register' ? '确认上传' : '确认付费使用';
  const input = createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try { answer = await input.question(`核对以上内容后，输入“${phrase}”继续，其余输入取消：`); }
  finally { input.close(); }
  if (answer.trim() !== phrase) { console.log('未确认，音色操作保持暂停。'); return; }
  await approveVoiceReview(resolve(out), stage, review.id);
  console.log('已记录本次确认。重跑原来的 cloud:smoke 命令继续处理；正式使用仍需单独确认。');
}
