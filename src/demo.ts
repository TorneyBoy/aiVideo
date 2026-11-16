import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { json } from './files.ts';
import { analyze, ffmpeg } from './media.ts';
import { renderLegacy as render } from './render.ts';

export async function demo(out: string, log: (message: string) => void = console.log) {
  out = resolve(out);
  await mkdir(out, { recursive: true });
  const reference = resolve(out, 'reference.mp4'), replacement = resolve(out, 'replacement.mp4');
  log('创建本地剪辑流程演示素材（不调用生成模型）');
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x1b3454:s=360x640:r=25:d=3', '-f', 'lavfi', '-i', 'color=c=0x994c32:s=360x640:r=25:d=3', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=6', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0,drawbox=x=115:y=210:w=130:h=210:color=white@0.8:t=fill[v]', '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', reference]);
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x183321:s=360x640:r=25:d=3', '-vf', 'drawbox=x=135:y=190:w=90:h=45:color=0xd3f0a5:t=fill,drawbox=x=120:y=235:w=120:h=190:color=0x78aa65:t=fill,drawbox=x=130:y=290:w=100:h=75:color=0xe3e7cb:t=fill', '-an', '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p', replacement]);
  const project = await analyze(reference, resolve(out, 'analysis'));
  project.name = '剪辑流程演示（未执行 AI 主体或声音替换）';
  project.assets.productDemo = { kind: 'video', path: replacement };
  project.shots = [
    { id: 'opening', start: 0, end: { word: 'switch', edge: 'start', offset: 0 }, visual: { type: 'reference' } },
    { id: 'product', start: { word: 'switch', edge: 'start', offset: 0 }, end: 6, visual: { type: 'asset', asset: 'productDemo', offset: 0 } },
  ];
  project.words = [
    { id: 'intro', text: '剪辑流程演示', start: 0.2, end: 2.8 },
    { id: 'switch', text: '替换为商品素材镜头', start: 3, end: 4.5 },
    { id: 'notice', text: '非 AI 主体替换结果', start: 4.6, end: 5.8 },
  ];
  project.captions = { enabled: true, wordsPerLine: 1 };
  const file = resolve(out, 'project.json');
  await json(file, project);
  return render(file, resolve(out, 'output'), log);
}
