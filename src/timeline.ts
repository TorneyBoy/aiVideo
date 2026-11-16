import { projectSchema } from './schema.ts';
import type { Project, Shot, Time, Word } from './schema.ts';

export type ResolvedShot = Omit<Shot, 'start' | 'end'> & { start: number; end: number; startFrame: number; frames: number };

export function validateWords(words: Word[]): void {
  const seen = new Set<string>();
  let previous = 0;
  for (const word of words) {
    if (seen.has(word.id)) throw new Error(`重复的词 ID：${word.id}`);
    if (word.end <= word.start || word.start < previous - 0.001) throw new Error(`词时间无效或重叠：${word.id}`);
    if (/[\r\n\u0000-\u0008]/.test(word.text)) throw new Error(`词文本包含换行或控制字符：${word.id}`);
    seen.add(word.id);
    previous = word.end;
  }
}

export function resolveTime(time: Time, words: Word[]): number {
  if (typeof time === 'number') return time;
  const word = words.find(w => w.id === time.word);
  if (!word) throw new Error(`找不到词锚点：${time.word}`);
  const result = word[time.edge] + time.offset;
  if (result < 0) throw new Error(`词锚点偏移后小于零：${time.word}`);
  return result;
}

export function compileProject(input: unknown): { project: Project; shots: ResolvedShot[]; frames: number; duration: number } {
  const project = projectSchema.parse(input);
  validateWords(project.words);
  const seen = new Set<string>();
  let nextFrame = 0;
  const shots = project.shots.map(shot => {
    if (seen.has(shot.id)) throw new Error(`重复的分镜 ID：${shot.id}`);
    seen.add(shot.id);
    const startFrame = Math.round(resolveTime(shot.start, project.words) * project.output.fps);
    const endFrame = Math.round(resolveTime(shot.end, project.words) * project.output.fps);
    if (startFrame !== nextFrame) throw new Error(`分镜 ${shot.id} 存在空隙、重叠或未从零开始`);
    if (endFrame <= startFrame) throw new Error(`分镜 ${shot.id} 必须至少包含一帧`);
    nextFrame = endFrame;
    if (shot.visual.type === 'asset') {
      const asset = project.assets[shot.visual.asset];
      if (!asset || asset.kind === 'audio') throw new Error(`分镜 ${shot.id} 需要图像或视频素材`);
    }
    if (shot.visual.type === 'generate') {
      const provider = project.providers[shot.visual.provider];
      const subject = project.subjects[shot.visual.task];
      if (!provider) throw new Error(`未配置生成服务：${shot.visual.provider}`);
      if (!subject || project.assets[subject]?.kind !== 'image') throw new Error(`请配置 ${shot.visual.task} 的主体参考图`);
      if (provider.type === 'comfyui') {
        const values = new Set(provider.bindings.map(b => b.value));
        if (!values.has('referenceVideo') || !values.has('subjectImage')) throw new Error('替换工作流必须绑定 referenceVideo 和 subjectImage');
        if (shot.visual.task === 'presenter' && project.audio.type !== 'mute' && !values.has('audio')) throw new Error('有声人物替换必须绑定 audio，以便生成与配音匹配的口型');
        if (values.has('audio') && project.audio.type === 'mute') throw new Error('口播生成工作流需要音频，当前配置为静音');
      } else {
        const duration = (endFrame - startFrame) / project.output.fps;
        if (duration < 4 || duration > 15) throw new Error('火山替换片段必须为 4–15 秒，请合并过短镜头');
      }
    }
    return { ...shot, start: startFrame / project.output.fps, end: endFrame / project.output.fps, startFrame, frames: endFrame - startFrame };
  });
  if (project.audio.type === 'asset' && project.assets[project.audio.asset]?.kind !== 'audio') throw new Error('配音必须指向 audio 类型素材');
  if (project.captions.enabled && project.words.length === 0 && !project.production) throw new Error('开启字幕前需导入带时间戳的词记录');
  if (project.words.some(word => word.end > nextFrame / project.output.fps + 1 / project.output.fps)) throw new Error('字幕超出节目时长');
  return { project, shots, frames: nextFrame, duration: nextFrame / project.output.fps };
}

function srtTime(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

export function subtitles(words: Word[], size = 8): string {
  validateWords(words);
  const groups: Word[][] = [];
  for (const word of words) {
    const group = groups.at(-1);
    if (!group || group.length >= size || word.start - group.at(-1)!.end > 0.6) groups.push([word]);
    else group.push(word);
  }
  return groups.map((group, i) => {
    const text = group.map(w => w.text.replace(/[<>]/g, '')).join(' ').replace(/([\u3400-\u9fff]) (?=[\u3400-\u9fff])/g, '$1');
    return `${i + 1}\n${srtTime(group[0].start)} --> ${srtTime(group.at(-1)!.end)}\n${text}\n`;
  }).join('\n');
}
