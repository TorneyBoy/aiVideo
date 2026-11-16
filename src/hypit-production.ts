import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { html, json } from './files.ts';
import { probe } from './media.ts';
import { directedLines, joinSpokenWords } from './director.ts';
import { subtitles } from './timeline.ts';
import type { Word } from './schema.ts';
import type { plan } from './render.ts';

type Prepared = Awaited<ReturnType<typeof plan>>;
export async function directedPrelude(directory: string, prepared: Prepared): Promise<string[]> {
  const { project, shots, assetPaths } = prepared, production = project.production!;
  if (shots.some(shot => shot.visual.type !== 'generate' || shot.visual.task !== production.plan.mode)) throw new Error('完整导演工程需要同一替换类型的生成分镜');
  const subject = assetPaths[project.subjects[production.plan.mode]!], info = await probe(subject);
  const extension = info.video?.codec_name === 'png' ? 'png' : info.video?.codec_name === 'webp' ? 'webp' : 'jpg';
  await copyFile(subject, resolve(directory, `inputs/identity.${extension}`));
  const lines = [`  <media:Image id="identity" src="./inputs/identity.${extension}"/>`];
  const roles = production.plan.roles.map(role => `${role.id}：${role.description}`).join('；');
  const target = production.plan.roles.find(role => role.replaceVoice);
  const replacement = production.plan.mode === 'presenter'
    ? `图1是唯一替换主持人的身份与外观依据；只替换源场景的 ${target!.id}（${target!.description}），保留嘉宾及所有其他人。`
    : '图1是唯一替换商品的外观依据；只替换主推商品，保持人物身份、服装、手和背景不变，包装与可见标志以图1为准，不臆造不可见背标。';
  for (const camera of [...production.plan.cameras].sort((a, b) => a.id === 'camera-3' ? -1 : b.id === 'camera-3' ? 1 : a.id.localeCompare(b.id))) {
    const context = production.frames[camera.frameIndex];
    await copyFile(context, resolve(directory, `inputs/${camera.id}-context.jpg`));
    const master = camera.id === 'camera-3';
    const prompt = `${replacement} ${master ? '图2只提供源场景、其他人物及空间关系，制作主全景。' : '图2是已确定的主全景，必须保持其中的人物、服装、物品、光线和空间关系；图3只提供当前机位构图。'} 场景：${production.plan.scene} 主体：${production.plan.subject} 角色：${roles} 当前机位：${camera.description} 同一主体在所有机位外貌与服装一致；不增加角色或道具；自然中性表情与可继续表演的姿态。只绘制镜头画面，不添加字幕、分镜边框或说明文字。`;
    lines.push(`  <media:Image id="${camera.id}-context" src="./inputs/${camera.id}-context.jpg"/>`,
      `  <text:Value id="${camera.id}-prompt">${html(prompt)}</text:Value>`,
      `  <volc:CameraImage id="${camera.id}" prompt={${camera.id}-prompt} aspect-ratio="${project.output.width}:${project.output.height}" size="${production.imageSize}">`,
      '    <volc:Reference image={identity}/>',
      ...(master ? [] : ['    <volc:Reference image={camera-3.image}/>']),
      `    <volc:Reference image={${camera.id}-context}/>`, '  </volc:CameraImage>');
  }
  lines.push('  <script id="story">');
  for (const [i, shot] of shots.entries()) {
    const fragments = directedLines(production.plan, production.utterances, shot.start, shot.end);
    lines.push(`    <shot-${i + 1}>`);
    for (const line of fragments) {
      if (/[<>|@{}\\]/.test(line.text)) throw new Error('台词包含导演模板保留字符，需要校对后继续');
      const cues: { text: string }[][] = [[]];
      for (const word of line.words) {
        const current = cues.at(-1)!;
        if (current.length && (current.length >= 6 || joinSpokenWords([...current, word]).length > 20)) cues.push([]);
        cues.at(-1)!.push(word);
      }
      lines.push(`      <${line.role}>${cues.map(cue => html(joinSpokenWords(cue))).join(' || ')}`);
    }
    lines.push(`    </shot-${i + 1}>`);
  }
  lines.push('  </script>');
  const kit = `<?svml using="@hypit/text/svs@1"?>
<sheet version="1" id="director-kit">
  text-template.director-v1 { separator: paragraph; }
  text-template.director-v1.block.base { kind: fixed; order: 10; text: "按三机位闭合集合完成源视频改编，保留源动作与时间节奏。"; }
  text-template.director-v1.block.reference { kind: fixed; order: 20; text: "机位合同：@image1 是主讲/商品机位，@image2 是反打或特写，@image3 是主全景。每句只选择一个完整机位，机位之间直接硬切；不得新增第四机位、过渡机位、任意反打或绕拍。@video1 提供动作与节奏，不提供替换主体的身份。人物、服装、商品、道具、灯光、左右关系在三机位中保持一致。"; }
  text-template.director-v1.block.identity { kind: slot; order: 30; slot: identity; optional: false; label: "主体和场景合同："; }
  text-template.director-v1.block.roles { kind: slot; order: 40; slot: roles; optional: false; label: "角色与声音："; }
  text-template.director-v1.block.audio { kind: fixed; order: 50; text: "若提供 @audio1，它是本段实际采用的最终音频，必须按其原词、停顿、语气和时间表演，不增加或重复台词；只让当前说话者动嘴，其他人物倾听。主持人持有同一麦克风，根据发言对象自然调整手腕和手臂，不能凭空出现、消失或换手。"; }
  text-template.director-v1.block.dialogue { kind: slot; order: 60; slot: dialogue; optional: false; label: "本段台词："; }
  text-template.director-v1.block.action { kind: slot; order: 70; slot: action; optional: false; label: "逐句机位、动作与表达："; }
  text-template.director-v1.block.finish { kind: fixed; order: 80; text: "稳定面部、手部、商品轮廓与标志；不添加字幕、标题、图标或画面外覆盖层；保留场景中物理文字。"; }
</sheet>
`;
  await writeFile(resolve(directory, 'director.svs'), kit);
  return lines;
}

export function shotDirection(prepared: Prepared, id: string, shot: Prepared['shots'][number]): string[] {
  const production = prepared.project.production!;
  const lines = directedLines(production.plan, production.utterances, shot.start, shot.end);
  const roles = production.plan.roles.map(role => `${role.id}：${role.description}；声音${role.replaceVoice ? '使用已选目标音色（若用户启用）' : '保留原角色'}`).join('\n');
  const action = lines.map(line => `${line.start.toFixed(3)}–${line.end.toFixed(3)} 秒，${line.role}，选择 @image${line.camera.at(-1)} 完整机位。动作：${line.action}；表达：${line.delivery}。`).join('\n') || '本段没有台词，保持源动作，不开口说话。';
  return [
    `  <text:Value id="${id}-identity">${html(`${production.plan.mode === 'presenter' ? '只改变指定主持人，其他人物不变' : '只替换指定商品，不改变任何人物身份'}。${production.plan.scene} ${production.plan.subject}`)}</text:Value>`,
    `  <text:Value id="${id}-roles">${html(roles)}</text:Value>`,
    `  <text:Value id="${id}-dialogue">${html(lines.map(line => `${line.role}: ${line.text}`).join('\n') || '无台词')}</text:Value>`,
    `  <text:Value id="${id}-action">${html(action)}</text:Value>`,
    `  <text:Render id="${id}-direction" template={director-kit.director-v1}>`,
    ...['identity', 'roles', 'dialogue', 'action'].map(name => `    <text:Set name="${name}" text={${id}-${name}}/>`),
    '  </text:Render>',
  ];
}

export function semanticCaptions(prepared: Prepared): string[] {
  const production = prepared.project.production!;
  const mappings = prepared.shots.flatMap((shot, i) => directedLines(production.plan, production.utterances, shot.start, shot.end).length ? [i + 1] : []);
  if (!mappings.length || !prepared.project.captions.enabled) return [];
  return ['  <semantic:Projection id="story-time" narrative={story} timeline={program.timeline}>',
    ...mappings.map(i => `    <semantic:Map alignment={shot-${i}-alignment.alignment} domain={shot-${i}-speech-media.domain} window={program.shot-${i}}/>`),
    '  </semantic:Projection>',
    '  <fonts:Face id="caption-font" package="@fontsource-variable/noto-sans-sc" weight="700" style="normal"/>',
    '  <caption-fine:Style id="word-style" recipe={recipes.caption.main} font={caption-font}/>',
    '  <narrative-caption:Timing id="word-timing" document={story.caption} binding={story.caption-binding} projection={story-time}/>',
    '  <caption-fine:Caption id="captions" document={story.caption} timing={word-timing} timeline={program.timeline} within={canvas.bounds}>',
    '    <caption-fine:Use style={word-style}/>', '  </caption-fine:Caption>'];
}

export function captionRecipe(width: number) {
  return `\n  caption.main { align: center; background: #00000099; fill: #FFFFFF; line-height: 1.15; padding: "6"; radius: 4; size: ${Math.max(12, Math.round(width * 0.047))}; stack-order: 70; width: 0.9; x: 0.5; y: 0.86; anchor-x: center; anchor-y: center; max-lines: 2; max-words-per-line: 12; karaoke: current; karaoke-transition: step; active-fill: #D3F0A5; active-scale: 1.05; }\n`;
}

/** Export service-reported boundaries, rather than the original source sentence times. */
export async function exportAlignedWords(directory: string, out: string, prepared: Prepared) {
  const production = prepared.project.production!;
  const words: Word[] = [];
  if (prepared.project.captions.enabled) for (const [i, shot] of prepared.shots.entries()) {
    if (!directedLines(production.plan, production.utterances, shot.start, shot.end).length) continue;
    const label = `shot-${i + 1}-alignment`, key = createHash('sha256').update(label).digest('hex').slice(0, 16);
    const evidence = JSON.parse(await readFile(resolve(directory, 'provider-cache', `words-${key}.json`), 'utf8')) as { sampleFrames: number; passages: { words: { text: string; startSample: number; endSampleExclusive: number }[] }[] };
    for (const passage of evidence.passages) for (const word of passage.words) words.push({ id: `word-${words.length + 1}`, text: word.text, start: shot.start + word.startSample / 16000, end: Math.min(shot.end, shot.start + word.endSampleExclusive / 16000) });
  }
  await json(resolve(out, 'words.json'), { version: 1, service: 'doubao', source: 'final-selected-audio', words });
  await writeFile(resolve(out, 'subtitles.srt'), subtitles(words, prepared.project.captions.wordsPerLine));
  return words;
}
