import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, extname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { fingerprint, hashFile, json, readJson } from './files.ts';
import type { ComfyConfig } from './schema.ts';

const graphSchema = z.record(z.string(), z.object({ class_type: z.string().min(1), inputs: z.record(z.string(), z.unknown()) }).passthrough());
export type ComfyGraph = z.infer<typeof graphSchema>;
export type GenerationInputs = { referenceVideo: string; subjectImage: string; audio?: string; prompt: string; seed: number; width: number; height: number; fps: number; frameCount: number; subjectAssetUri?: string; referenceAssetUri?: string; referenceUrl?: string };

export async function loadWorkflow(config: ComfyConfig, path: string): Promise<ComfyGraph> {
  const graph = graphSchema.parse(await readJson(path));
  if (!graph[config.outputNode]) throw new Error('ComfyUI 工作流不存在指定的输出节点');
  const used = new Set<string>();
  for (const binding of config.bindings) {
    const key = `${binding.node}.${binding.input}`;
    if (!graph[binding.node] || !(binding.input in graph[binding.node].inputs)) throw new Error(`ComfyUI 绑定不存在：${key}`);
    if (used.has(key)) throw new Error(`ComfyUI 重复绑定：${key}`);
    used.add(key);
  }
  if (config.tokenEnv && !process.env[config.tokenEnv]) throw new Error(`缺少环境变量 ${config.tokenEnv}`);
  return graph;
}

export function bindWorkflow(graph: ComfyGraph, config: ComfyConfig, values: Record<string, unknown>): ComfyGraph {
  const bound = structuredClone(graph);
  for (const binding of config.bindings) {
    if (values[binding.value] === undefined) throw new Error(`缺少生成输入：${binding.value}`);
    bound[binding.node].inputs[binding.input] = values[binding.value];
  }
  return bound;
}

async function request(config: ComfyConfig, route: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (config.tokenEnv) headers.set('Authorization', `Bearer ${process.env[config.tokenEnv]}`);
  const response = await fetch(`${config.url.replace(/\/$/, '')}${route}`, { ...init, headers, signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`生成服务请求失败：HTTP ${response.status}`);
  return response;
}

async function upload(config: ComfyConfig, path: string): Promise<string> {
  if ((await stat(path)).size > 128 * 1024 * 1024) throw new Error('单段生成输入超过 128 MB');
  const name = `${(await hashFile(path)).slice(0, 24)}${extname(path)}`;
  const form = new FormData();
  form.append('image', new Blob([await readFile(path)]), name);
  form.append('type', 'input');
  form.append('overwrite', 'false');
  const data = await (await request(config, '/upload/image', { method: 'POST', body: form })).json() as { name?: string; subfolder?: string };
  if (!data.name) throw new Error('生成服务未返回上传文件名');
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

export async function generate(config: ComfyConfig, graph: ComfyGraph, inputs: GenerationInputs, output: string, log: (message: string) => void): Promise<void> {
  await mkdir(dirname(output), { recursive: true });
  const receiptPath = `${output}.receipt.json`;
  const used = new Set(config.bindings.map(b => b.value));
  const inputHashes: Record<string, string> = {};
  for (const name of ['referenceVideo', 'subjectImage', 'audio'] as const) {
    if (used.has(name) && inputs[name]) inputHashes[name] = await hashFile(inputs[name]!);
  }
  const signature = fingerprint({ config, graph, inputs: { ...inputs, referenceVideo: undefined, subjectImage: undefined, audio: undefined }, inputHashes });
  let promptId: string | undefined;
  try {
    const receipt = await readJson(receiptPath) as { signature: string; promptId: string; outputHash?: string; failed?: boolean };
    if (receipt.signature === signature) {
      if (receipt.failed) throw new Error('这个生成任务已失败；请调整配置或 seed 后重试');
      promptId = receipt.promptId;
      if (receipt.outputHash && receipt.outputHash === await hashFile(output).catch(() => '')) { log('复用已完成的生成片段'); return; }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!promptId) {
    const values: Record<string, unknown> = { ...inputs };
    for (const name of ['referenceVideo', 'subjectImage', 'audio'] as const) {
      if (used.has(name)) {
        if (!inputs[name]) throw new Error(`生成流程需要 ${name}`);
        values[name] = await upload(config, inputs[name]!);
      }
    }
    const prompt = bindWorkflow(graph, config, values);
    const result = await (await request(config, '/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }) })).json() as { prompt_id?: string; node_errors?: Record<string, unknown> };
    if (!result.prompt_id || Object.keys(result.node_errors || {}).length) throw new Error('生成服务拒绝工作流，请检查节点、模型和绑定');
    promptId = result.prompt_id;
    await json(receiptPath, { signature, promptId });
    log('生成任务已提交，正在等待画面');
  } else log('继续等待此前提交的生成任务');
  const deadline = Date.now() + config.timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const history = await (await request(config, `/history/${encodeURIComponent(promptId)}`)).json() as Record<string, { status?: { status_str?: string; completed?: boolean }; outputs?: Record<string, Record<string, unknown>> }>;
    const item = history[promptId];
    if (item?.status?.status_str === 'error') {
      await json(receiptPath, { signature, promptId, failed: true });
      throw new Error('生成模型执行失败，请查看 ComfyUI 日志');
    }
    if (item?.status?.completed) {
      const files = item.outputs?.[config.outputNode]?.[config.outputField] as { filename: string; subfolder?: string; type?: string }[] | undefined;
      const file = files?.find(f => /\.(mp4|webm|mov|mkv)$/i.test(f.filename));
      if (!file) throw new Error('生成任务没有输出视频，不能用静态图替代成片');
      const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || '', type: file.type || 'output' });
      const response = await request(config, `/view?${query}`);
      const temporary = `${output}.tmp`;
      await writeFile(temporary, Buffer.from(await response.arrayBuffer()));
      const { rename } = await import('node:fs/promises');
      await rename(temporary, output);
      await json(receiptPath, { signature, promptId, outputHash: await hashFile(output) });
      return;
    }
    await delay(1500);
  }
  throw new Error(`生成等待超时，任务回执已保存；重新执行会继续查询任务 ${promptId}`);
}
