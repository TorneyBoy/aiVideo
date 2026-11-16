import { access, copyFile, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { binaries, extractAudio, extractCloudVideo, ffmpeg, probe } from './media.ts';
import { fingerprint, hashFile, html, json, readJson } from './files.ts';
import { plan } from './render.ts';
import { subtitles } from './timeline.ts';
import { safeMessage } from './cloud-http.ts';
import { captionRecipe, directedPrelude, exportAlignedWords, semanticCaptions, shotDirection } from './hypit-production.ts';
import { directedLines } from './director.ts';
import { deferHypitStatus } from './hypit-observer.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const launcher = resolve(root, 'vendor/hypit/bin/hypit.mjs');
const integration = resolve(root, 'integrations/hypit-volcano');
export const hypitRevision = '6bacce093695ccc2bde5aa5d7de230e9682ffa79';

type NativeBuild = { id: string; failure?: string; attention?: { message: string }; work: { state: string; outcome?: string }; result: { state: string }; operations?: { failure?: { message: string } }[] };
type NativeReply = { build?: NativeBuild; [key: string]: unknown };
const exists = async (path: string) => access(path).then(() => true, () => false);

async function ensureProviderDependencies() {
  const scope = resolve(integration, 'node_modules/@hypit');
  await mkdir(scope, { recursive: true });
  for (const name of ['hypit', 'runtime-local', 'generation', 'narrative', 'media', 'temporal', 'narrative-temporal', 'speech-evidence', 'narrative-speech-alignment']) {
    const target = name === 'hypit' ? resolve(root, 'vendor/hypit') : resolve(root, `vendor/hypit/packages/${name}`);
    const link = resolve(scope, name);
    if (!await exists(link)) await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    else if (await realpath(link) !== await realpath(target)) throw new Error(`Hypit ${name} 依赖不是固定源码版本`);
  }
}

export async function hypitCommand(directory: string, args: string[]): Promise<NativeReply> {
  directory = resolve(directory);
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [launcher, ...args, '--project', directory, '--json'], { cwd: directory, windowsHide: true, shell: false });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Hypit 控制命令超时；已接受的原生构建会继续运行')); }, 120000);
    child.stdout.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-16000000); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      try {
        const reply = JSON.parse(stdout.replace(/^\uFEFF/, ''));
        const failure = reply.error?.message || reply.producerFailures?.map((item: any) => item.message || item.reason || JSON.stringify(item)).join('; ') || reply.preflight?.diagnostics?.map((item: any) => item.message || JSON.stringify(item)).join('; ') || reply.providers?.filter((item: any) => item.status !== 'resolved').map((item: any) => `${item.capability}: ${item.reason || item.status}`).join('; ');
        if ((code !== 0 && !(reply.format === 'hypit.cli-status@1' && reply.build)) || reply.ok === false) reject(new Error(`Hypit：${safeMessage(failure || JSON.stringify(reply).slice(0, 1000))}`));
        else accept(reply as NativeReply);
      } catch { reject(new Error(`Hypit 执行失败：${safeMessage(stderr || stdout.slice(-1000))}`)); }
    });
  });
}

async function browserPath() {
  const configured = process.env.HYPIT_CHROME_PATH?.trim();
  if (configured) { await access(configured); return resolve(configured); }
  const candidates = process.platform === 'win32' ? [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ] : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  throw new Error('Hypit 本地合成需要 Chrome 或 Edge，请配置 HYPIT_CHROME_PATH');
}

/** Author real SVML/SVRun and a BYOK Runtime Profile. Preparation never submits a model job. */
export async function prepareHypit(projectFile: string, out: string, allowPaidGeneration = false) {
  await ensureProviderDependencies();
  const prepared = await plan(projectFile);
  const { project, shots, reference, assetPaths, hashes } = prepared;
  const accounts = Object.entries(project.providers).map(([id, config]) => [id, fingerprint(process.env[config.tokenEnv || ''] || '')]);
  const speechScope = project.production ? fingerprint([project.production.speech.apiKeyEnv, project.production.speech.accessTokenEnv].map(name => process.env[name] || '')) : undefined;
  const frameHashes = project.production ? await Promise.all(project.production.frames.map(hashFile)) : undefined;
  const signature = fingerprint({ version: project.production ? 2 : 1, hypitRevision, project, hashes, accounts, speechScope, frameHashes });
  // Keep FFmpeg input paths below the Windows legacy path limit.
  const directory = resolve(out, 'hypit', signature.slice(0, 16));
  await mkdir(resolve(directory, 'inputs'), { recursive: true });
  const link = resolve(directory, 'node_modules/@aivideo/hypit-volcano');
  await mkdir(dirname(link), { recursive: true });
  if (!await exists(link)) await symlink(integration, link, process.platform === 'win32' ? 'junction' : 'dir');
  else if (await realpath(link) !== await realpath(integration)) throw new Error('Hypit Provider 路径与固定集成不一致');
  await json(resolve(directory, 'package.json'), { name: 'aivideo-native-project', private: true, type: 'module', hypit: { project: true }, dependencies: { '@aivideo/hypit-volcano': `file:${integration.replaceAll('\\', '/')}` } });
  const endpoints: Record<string, unknown> = {
    'media.local': { use: '@hypit/media-local', config: { ffmpegPath: binaries.ffmpeg, ffprobePath: binaries.ffprobe, defaultConcurrency: process.env.AIVIDEO_LOW_MEMORY === '1' ? 1 : 2 } },
    'html.local': { use: '@hypit/provider-html-local', config: { chromePath: await browserPath(), ffmpegPath: binaries.ffmpeg, ffprobePath: binaries.ffprobe, workers: 1, quality: 'standard', browserGpu: 'software', defaultConcurrency: 1,
      ...(process.env.AIVIDEO_LOW_MEMORY === '1' ? { maxWorkers: 1, browserCapacity: 1, artifactStagingConcurrency: 1, maxPendingFrameBytes: 16777216, maxDecodedSourceBytes: 50331648 } : {}) } },
  };
  const imports = ['text', 'media', 'seedance', 'media-operations', 'timeline-author', 'spatial', 'visual-track', 'audio-track', 'film', 'html-video'];
  const aliases = ['text', 'media', 'seedance', 'mediaop', 'time', 'space', 'visual', 'audio', 'film', 'html'];
  const lines = ['<?svml using="@hypit/markup@1"?>', '<svml>', ...imports.map((name, i) => `  <import as="${aliases[i]}" from="@hypit/${name}@1"/>`), '  <import as="recipes" source="./recipes.svs"/>',
    `  <time:Clock id="clock" frame-rate="${project.output.fps}"/>`,
    `  <space:Canvas id="canvas" width="${project.output.width}" height="${project.output.height}"/>`,
    '  <space:Frame id="full" within={canvas.bounds} left="0%" top="0%" right="100%" bottom="100%"/>'];
  if (project.production) {
    lines.splice(lines.findIndex(line => line.includes('<time:Clock')), 0,
    '  <import as="volc" from="@aivideo/hypit-volcano@1"/>', '  <import from="@hypit/script@1"/>',
    '  <import as="semantic" from="@hypit/narrative-temporal@1"/>', '  <import as="narrative-caption" from="@hypit/narrative-caption@1"/>',
    '  <import as="caption-fine" from="@hypit/caption-fine@1"/>', '  <import as="fonts" from="@hypit/fontsource@1"/>',
    '  <import as="director-kit" source="./director.svs"/>');
    lines.push(...await directedPrelude(directory, prepared));
  }
  const bindings: Record<string, unknown> = {};
  const providerSettings = new Map<string, { seed: number; assets: Record<string, string> }>();
  for (const [i, shot] of shots.entries()) {
    const id = `shot-${i + 1}`, duration = shot.frames / project.output.fps;
    let source = `${id}-input`;
    if (shot.visual.type === 'generate') {
      const visual = shot.visual, config = project.providers[visual.provider];
      if (config.type !== 'volcengine-ark') throw new Error('Hypit 原生流程目前接入火山模型；ComfyUI 工程可显式使用旧版兼容引擎');
      let settings = providerSettings.get(visual.provider);
      if (settings && settings.seed !== visual.seed) throw new Error('同一 Hypit 火山 Provider 的各分镜需要使用相同随机种子');
      if (!settings) { settings = { seed: visual.seed, assets: {} }; providerSettings.set(visual.provider, settings); }
      const clip = resolve(directory, `inputs/${id}-reference.mp4`);
      if (!await exists(clip)) await extractCloudVideo(reference, clip, shot.start, duration);
      if (visual.referenceAssetUri) settings.assets[await hashFile(clip)] = visual.referenceAssetUri;
      const subject = assetPaths[project.subjects[visual.task]!];
      const subjectInfo = await probe(subject);
      const extension = subjectInfo.video?.codec_name === 'png' ? 'png' : subjectInfo.video?.codec_name === 'webp' ? 'webp' : 'jpg';
      const subjectName = `inputs/${id}-subject.${extension}`;
      await copyFile(subject, resolve(directory, subjectName));
      if (visual.subjectAssetUri) settings.assets[await hashFile(subject)] = visual.subjectAssetUri;
      const nativeModel = config.family === 'seedance-2.5' ? '2.5' : /-mini-/.test(config.model) ? 'mini' : /-fast-/.test(config.model) ? 'fast' : 'standard';
      const capability = nativeModel === '2.5' ? 'seedance-2.5' : nativeModel === 'standard' ? 'seedance-2' : `seedance-2-${nativeModel}`;
      const binding = `@hypit/seedance@1#${capability}`;
      if (bindings[binding] && bindings[binding] !== `ark.${visual.provider}`) throw new Error('相同 Seedance 能力只能绑定一个火山 Provider');
      bindings[binding] = `ark.${visual.provider}`;
      lines.push(`  <media:Video id="${id}-reference" src="./inputs/${id}-reference.mp4"/>`,
        `  <media:Image id="${id}-subject" src="./${subjectName}"/>`,
        ...(project.production ? shotDirection(prepared, id, shot) : [`  <text:Value id="${id}-direction">${html(`@video1 is the source footage to edit. @image1 establishes the replacement ${visual.task === 'presenter' ? 'presenter identity' : 'product identity'}. ${visual.prompt} Preserve the source shot duration, camera cuts and action timing. ${project.audio.type !== 'mute' ? 'Use @audio1 as the exact timed speech performance; synchronize visible mouth movement where speech is visible.' : 'Create a silent visual edit.'}`)}</text:Value>`]),
        `  <seedance:ReferenceVideo id="${id}-take" model="${nativeModel}" prompt={${id}-direction} duration="${nativeModel === '2.5' ? -1 : Math.max(4, Math.ceil(duration))}" resolution="${config.resolution}" aspect-ratio="adaptive" generate-audio="${project.audio.type !== 'mute'}">`,
        // Source footage may contain people in either editing mode, including product demonstrations.
        `    <seedance:Reference video={${id}-reference} person-reference="true"/>`,
        ...(project.production ? [1, 2, 3].map(i => `    <seedance:Reference image={camera-${i}.image} person-reference="true"/>`) : [`    <seedance:Reference image={${id}-subject} person-reference="${visual.task === 'presenter'}"/>`]));
      if (project.production && visual.subjectAssetUri) lines.push(`    <seedance:Reference image={${id}-subject} person-reference="${visual.task === 'presenter'}"/>`);
      if (project.audio.type !== 'mute') {
        const audio = resolve(directory, `inputs/${id}-speech.wav`);
        if (!await exists(audio)) await extractAudio(project.audio.type === 'asset' ? assetPaths[project.audio.asset] : reference, audio, shot.start + (project.audio.type === 'asset' ? project.audio.offset : 0), duration);
        // Audio references must precede the consuming ReferenceVideo in authored source.
        const start = lines.findIndex(line => line.includes(`<seedance:ReferenceVideo id="${id}-take"`));
        lines.splice(start, 0, `  <media:Audio id="${id}-speech" src="./inputs/${id}-speech.wav"/>`);
        lines.push(`    <seedance:Reference audio={${id}-speech}/>`);
      }
      lines.push('  </seedance:ReferenceVideo>'); source = `${id}-take.video`;
      if (project.production && project.audio.type !== 'mute' && directedLines(project.production.plan, project.production.utterances, shot.start, shot.end).length) lines.push(
        `  <mediaop:Normalize id="${id}-speech-media" source={${id}-speech} video="none" audio="default" span-authority="audio" clock={clock}/>`,
        `  <volc:Alignment id="${id}-alignment" narrative={story} segment={story.segment.${id}} media={${id}-speech-media.media} domain={${id}-speech-media.domain}/>`);
    } else {
      const input = resolve(directory, `inputs/${id}.mp4`);
      if (!await exists(input)) {
        const asset = shot.visual.type === 'asset' ? project.assets[shot.visual.asset] : undefined;
        const file = shot.visual.type === 'asset' ? assetPaths[shot.visual.asset] : reference;
        const offset = shot.visual.type === 'asset' ? shot.visual.offset : shot.start;
        await ffmpeg([...(asset?.kind === 'image' ? ['-loop', '1', '-framerate', String(project.output.fps)] : ['-ss', String(offset)]), '-i', file, '-an', '-t', String(duration), '-vf', `fps=${project.output.fps},setsar=1`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input]);
      }
      lines.push(`  <media:Video id="${id}-input" src="./inputs/${id}.mp4"/>`);
    }
    lines.push(`  <mediaop:Normalize id="${id}-media" source={${source}} video="primary-moving" audio="none" span-authority="video" clock={clock}/>`);
  }
  for (const [id, settings] of providerSettings) {
    const ark = project.providers[id];
    if (ark.type !== 'volcengine-ark') throw new Error('Hypit Provider 类型不匹配');
    endpoints[`ark.${id}`] = { use: '@aivideo/hypit-volcano', config: { ark, apiKey: { store: 'env', key: ark.tokenEnv }, cacheDirectory: resolve(directory, 'provider-cache'), assetUris: settings.assets, seed: settings.seed, allowPaidGeneration,
      ...(project.production ? { production: { imageModel: project.production.imageModel, imageSize: project.production.imageSize, requestTimeoutSeconds: project.production.requestTimeoutSeconds, speech: project.production.speech } } : {}) } };
    if (project.production) {
      bindings['@aivideo/hypit-volcano@1#volcano-image-edit'] = `ark.${id}`;
      bindings['@aivideo/hypit-volcano@1#doubao-word-evidence'] = `ark.${id}`;
    }
  }
  const frameCount = shots.reduce((sum, shot) => sum + shot.frames, 0);
  lines.push(`  <time:Timeline id="program" clock={clock} end="${frameCount}f">`);
  let cursor = 0;
  for (const [i, shot] of shots.entries()) { lines.push(`    <time:Window id="shot-${i + 1}" from="${cursor}f" for="${shot.frames}f"/>`); cursor += shot.frames; }
  lines.push('  </time:Timeline>', '  <visual:Track id="picture" timeline={program.timeline}>');
  for (const [i] of shots.entries()) lines.push(`    <visual:Clip id="shot-${i + 1}" media={shot-${i + 1}-media.media} during={program.shot-${i + 1}} frame={full} z="10" fit="contain"/>`);
  lines.push('  </visual:Track>');
  if (project.audio.type !== 'mute') {
    const audio = resolve(directory, 'inputs/program.wav');
    if (!await exists(audio)) await ffmpeg(['-ss', String(project.audio.type === 'asset' ? project.audio.offset : 0), '-i', project.audio.type === 'asset' ? assetPaths[project.audio.asset] : reference, '-vn', '-af', `apad,atrim=duration=${prepared.duration}`, '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', audio]);
    lines.push('  <media:Audio id="soundtrack" src="./inputs/program.wav"/>', '  <mediaop:Normalize id="soundtrack-media" source={soundtrack} video="none" audio="default" span-authority="audio" clock={clock}/>', '  <audio:Track id="sound" timeline={program.timeline}>', '    <audio:Clip id="dialogue" source={soundtrack-media.media} during={program.window}/>', '  </audio:Track>');
  }
  const captions = project.production ? semanticCaptions(prepared) : [];
  lines.push(...captions, '  <film:Film id="main" canvas={canvas.canvas} timeline={program.timeline} appearance={recipes.film.main}>', '    <film:Track source={picture.visual}/>', ...(project.audio.type !== 'mute' ? ['    <film:Track source={sound.audio}/>'] : []), ...(captions.length ? ['    <film:Track source={captions.visual}/>'] : []), '  </film:Film>', '  <html:Video id="final" composition={main.composition} timeline={program.timeline}/>', '</svml>');
  await writeFile(resolve(directory, 'main.svml'), lines.join('\n') + '\n');
  await writeFile(resolve(directory, 'recipes.svs'), `<?svml using="@hypit/recipe@1"?>\n<sheet version="1" id="recipes">\n  film.main { background: #000000; }\n${project.production ? captionRecipe(project.output.width) : ''}</sheet>\n`);
  await writeFile(resolve(directory, 'build.svrun'), '<?svml using="@hypit/markup/run@1"?>\n<svrun version="1">\n  <author source="./main.svml"/>\n  <target output="final.video"/>\n</svrun>\n');
  await json(resolve(directory, 'hypit.runtime.json'), { format: 'hypit.runtime-local@1', dataRoot: '.hypit/runtime', credentials: { env: { use: '@hypit/credential-store-env' } }, endpoints, bindings });
  await writeFile(resolve(directory, 'Brief.md'), `# ${project.name}\n\nReplace the ${shots.some(s => s.visual.type === 'generate' && s.visual.task === 'product') ? 'featured product' : 'presenter'} using supplied source footage and subject references. Preserve source duration, camera and action timing. Use the existing confirmed voice when supplied; never register or activate a voice from this project.\n\nHypit ${hypitRevision}; aiVideo BYOK adapter.\n`);
  await writeFile(resolve(directory, 'Treatment.md'), 'Native ReferenceVideo → Normalize → Timeline / VisualTrack / AudioTrack → Film → HTML Video. Local preprocessing bounds references and prepares the confirmed narration. Existing captions are applied after native export. No model generation is performed by check or plan.\n');
  return { directory, prepared, signature };
}

export async function renderHypit(projectFile: string, out: string, log: (message: string) => void = console.log) {
  out = resolve(out);
  const { directory, prepared, signature } = await prepareHypit(projectFile, out, true);
  await json(resolve(out, 'plan.json'), { version: 1, engine: 'hypit', name: prepared.project.name, steps: prepared.steps, duration: prepared.duration });
  log('正在检查 Hypit 原生分镜工程');
  await hypitCommand(directory, ['check', 'build.svrun']);
  await hypitCommand(directory, ['plan', 'build.svrun', '--runtime', 'hypit.runtime.json']);
  const receiptFile = resolve(directory, 'build-receipt.json');
  let receipt: { signature: string; build?: string; submitting?: boolean; terminalFailure?: boolean } | undefined;
  try { receipt = await readJson(receiptFile) as typeof receipt; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (receipt?.signature !== undefined && receipt.signature !== signature) throw new Error('Hypit 工程签名已变化，请建立新任务');
  if (receipt?.terminalFailure && receipt.build) {
    await json(resolve(directory, `${receipt.build}.json`), receipt);
    log('重建失败的本地工程，火山适配器将复用原任务编号并拦截不确定提交');
  }
  let id = receipt?.terminalFailure ? undefined : receipt?.build;
  if (!id) {
    if (receipt?.submitting) throw new Error('上次 Hypit 提交状态不明，请先核对该工程的 builds 列表，避免重复扣费');
    await json(receiptFile, { signature, submitting: true });
    log('正在由 Hypit 执行人物／商品替换与合成');
    const response = await hypitCommand(directory, ['build', 'build.svrun', '--runtime', 'hypit.runtime.json']);
    id = response.build?.id;
    if (!id) throw new Error('Hypit 未返回构建编号，请核对原生工程后再继续');
    await json(receiptFile, { signature, build: id });
  } else log('继续跟踪已有 Hypit 任务，复用已提交的生成请求');
  const deadline = Date.now() + Math.max(600000, ...Object.values(prepared.project.providers).map(p => p.timeoutSeconds * 1000));
  let previous = '';
  while (true) {
    if (process.env.AIVIDEO_LOW_MEMORY === '1' && await deferHypitStatus(directory, id)) {
      if (Date.now() > deadline) throw new Error(`Hypit 构建仍在运行：${id}；已保留编号，重试将继续跟踪，不会重建`);
      const message = `Hypit 构建 ${id}：原生执行中`;
      if (message !== previous) { log(message); previous = message; }
      await new Promise(accept => setTimeout(accept, 1500));
      continue;
    }
    const { build } = await hypitCommand(directory, ['status', id, '--runtime', 'hypit.runtime.json']);
    if (!build) throw new Error(`找不到 Hypit 构建 ${id}`);
    if (['failed', 'cancelled'].includes(build.work.outcome || '') || ['failed', 'cancelled'].includes(build.result.state)) {
      await json(receiptFile, { signature, build: id, terminalFailure: true });
      await hypitCommand(directory, ['runtime', 'down', 'hypit.runtime.json']).catch(() => {});
      throw new Error(`Hypit 构建失败：${safeMessage(build.failure || build.operations?.find(op => op.failure)?.failure?.message || build.work.outcome || build.result.state)}`);
    }
    if (build.attention) throw new Error(`Hypit 需要处理：${safeMessage(build.attention.message)}。保留构建 ${id}，不会自动重新提交`);
    if (build.result.state === 'complete') break;
    const message = `Hypit 构建 ${id}：${build.work.state}`;
    if (message !== previous) { log(message); previous = message; }
    if (Date.now() > deadline) throw new Error(`Hypit 构建仍在运行：${id}；已保留编号，重试将继续跟踪，不会重建`);
    await new Promise(accept => setTimeout(accept, 1500));
  }
  const nativeOutput = resolve(directory, 'native.mp4');
  await hypitCommand(directory, ['get', id, '--output', 'final.video', '--to', nativeOutput]);
  const output = resolve(out, 'video.mp4');
  await writeFile(resolve(out, 'subtitles.srt'), subtitles(prepared.project.words, prepared.project.captions.wordsPerLine));
  if (prepared.project.captions.enabled && !prepared.project.production) await ffmpeg(['-i', nativeOutput, '-vf', "subtitles=filename=subtitles.srt:force_style='Fontsize=20,Outline=2,MarginV=24'", '-c:v', 'libx264', '-crf', '20', '-preset', 'fast', '-c:a', 'copy', '-movflags', '+faststart', 'video.mp4'], out);
  else await copyFile(nativeOutput, output);
  const info = await probe(output);
  if (!info.video || Math.abs(info.duration - prepared.duration) > 0.12 || (prepared.project.audio.type !== 'mute' && !info.audio)) throw new Error('Hypit 成片时长或声音校验失败');
  if (prepared.project.production) {
    for (const i of [1, 2, 3]) await hypitCommand(directory, ['get', id, '--output', `camera-${i}.image`, '--to', resolve(out, `camera-${i}.image`)]);
    await exportAlignedWords(directory, out, prepared);
  }
  await json(resolve(out, 'manifest.json'), { version: 1, engine: 'hypit', upstreamRevision: hypitRevision, build: id, nativeProject: directory, production: prepared.project.production ? { cameras: 3, sentenceDirection: true, wordAlignment: 'doubao-word-evidence', nativeCaptions: prepared.project.captions.enabled } : undefined, name: prepared.project.name, output: prepared.project.output, duration: info.duration, sourceHashes: prepared.hashes, audio: prepared.project.audio.type, generatedShots: prepared.shots.filter(s => s.visual.type === 'generate').length, staticImageShots: prepared.shots.filter(s => s.visual.type === 'asset' && prepared.project.assets[s.visual.asset].kind === 'image').length, sha256: await hashFile(output) });
  await hypitCommand(directory, ['runtime', 'down', 'hypit.runtime.json']).catch(() => log('成片已保存，本地 Hypit 进程稍后可手动关闭'));
  return output;
}

export async function checkHypitProject(projectFile: string, out: string) {
  const authored = await prepareHypit(projectFile, out, false);
  const check = await hypitCommand(authored.directory, ['check', 'build.svrun']);
  const report = await hypitCommand(authored.directory, ['plan', 'build.svrun', '--runtime', 'hypit.runtime.json']);
  await json(resolve(authored.directory, 'check.json'), check);
  await json(resolve(authored.directory, 'plan.json'), report);
  return { engine: 'hypit', directory: authored.directory, name: authored.prepared.project.name, duration: authored.prepared.duration, steps: authored.prepared.steps, requestCount: report.requestCount, providerRequestCount: report.providerRequestCount, ok: report.ok };
}
