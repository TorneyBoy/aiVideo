import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { runtime } from './config.ts';
import { demo } from './demo.ts';
import { readJson } from './files.ts';
import { analyze, binaries, command } from './media.ts';
import { plan, render } from './render.ts';
import { checkHypitProject } from './hypit.ts';
import { startServer } from './server.ts';
import { loadLocalEnvironment } from './env.ts';
import { cloudConfigurationStatus, formatCloudStatus } from './cloud-config.ts';
import { verifyCloudSetup } from './cloud-check.ts';
import { smokeCloud } from './cloud-smoke.ts';
import { reviewVoiceCli } from './voice-review-cli.ts';
import { voiceStageSchema } from './voice-consent.ts';
import { isLocalMaterialStorage } from './schema.ts';
import { cleanupLocalMaterials } from './local-materials.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { reference: { type: 'string' }, out: { type: 'string' }, project: { type: 'string' }, words: { type: 'string' }, port: { type: 'string' }, host: { type: 'string' }, 'voice-sample': { type: 'string' }, stage: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
});
const help = `aiVideo 视频复刻工作台

  npm run dev                        启动上传页面：http://127.0.0.1:4173
  npm run video -- doctor             检查媒体工具和模型配置
  npm run config:check                检查火山凭证是否填写（不发送请求）
  npm run materials:cleanup           清理已到期的临时素材副本（不删除任务和音色库）
  npm run cloud:check                 只读连接检查（不提交视频、注册音色或合成）
  npm run cloud:smoke                 公开商品与语音样例实测（调用计费接口）
  npm run video -- voice-review --out runs/live-check/official-fixture/voice --stage register
  npm run video -- voice-confirm --out runs/live-check/official-fixture/voice --stage register
                                     核对／人工确认音色；正式使用阶段为 activate
  npm run demo                       生成本地剪辑演示（不调用模型）
  npm run video -- analyze --reference input.mp4 --out runs/project
  npm run video -- plan --project runs/project/project.json
  npm run video -- render --project runs/project/project.json --out runs/project/output

可选：analyze --words words.json 导入 [{id,text,start,end}] 词时间戳。
模型服务配置见 config/runtime.example.json 与 docs/models.md。
`;
function required(name: 'reference' | 'project') {
  if (!values[name]) throw new Error(`缺少 --${name}`);
  return resolve(values[name]);
}
try {
  loadLocalEnvironment();
  if (values.help) console.log(help);
  else switch (positionals[0]) {
    case 'serve': {
      const port = Number(values.port || 4173);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口需要在 1024–65535 之间');
      if (values.host && !['127.0.0.1', '0.0.0.0'].includes(values.host)) throw new Error('监听地址只支持 127.0.0.1 或容器内的 0.0.0.0');
      startServer(port, values.host); break;
    }
    case 'doctor': {
      const results = await Promise.allSettled(Object.entries(binaries).map(async ([name, path]) => {
        const info = await command(path, ['-version']);
        return `${name}：${info.stdout.split('\n')[0]}`;
      }));
      for (const result of results) console.log(result.status === 'fulfilled' ? result.value : `工具检查失败：${result.reason}`);
      const config = await runtime();
      console.log(`人物替换：${config.routes.presenter ? '已配置（尚未验证推理）' : '待配置'}`);
      console.log(`商品替换：${config.routes.product ? '已配置（尚未验证推理）' : '待配置'}`);
      console.log(`声音服务：${config.voice ? config.voice.type === 'doubao' ? '豆包（含台词识别、复刻与合成）' : '本地 CosyVoice' : '待配置'}`);
      if (results.some(r => r.status === 'rejected')) process.exitCode = 1;
      break;
    }
    case 'config-check': {
      const status = cloudConfigurationStatus();
      console.log(formatCloudStatus(status));
      if (!status.complete) process.exitCode = 1;
      break;
    }
    case 'materials-cleanup': {
      const config = await runtime();
      const stores = Object.values(config.providers).flatMap(provider => provider.type === 'volcengine-ark' && provider.storage && isLocalMaterialStorage(provider.storage) ? [provider.storage] : []);
      const unique = [...new Map(stores.map(storage => [storage.directory, storage])).values()];
      if (!unique.length) throw new Error('请先配置服务器本地素材存储');
      for (const storage of unique) console.log(JSON.stringify(await cleanupLocalMaterials(storage)));
      break;
    }
    case 'cloud-check': {
      console.log('检查火山连接，只查询文件、音色及随机识别任务，不提交生成任务。');
      const checks = await verifyCloudSetup();
      for (const check of checks) console.log(`${check.service}：${check.ok ? '通过' : '需要处理'}。${check.message}`);
      if (checks.some(check => !check.ok)) process.exitCode = 1;
      break;
    }
    case 'cloud-smoke': {
      console.log('使用官方公开素材验证实际接口；会提交视频与语音识别任务，按服务计费。音色注册与正式合成分别等待人工确认。');
      const checks = await smokeCloud(values.out || 'runs/live-check/official-fixture', values['voice-sample']);
      if (checks.some(check => !check.ok)) process.exitCode = 1;
      break;
    }
    case 'voice-review':
    case 'voice-confirm': {
      await reviewVoiceCli(values.out || 'runs/live-check/official-fixture/voice', voiceStageSchema.parse(values.stage), positionals[0] === 'voice-confirm');
      break;
    }
    case 'analyze': {
      const out = resolve(values.out || 'runs/project');
      const project = await analyze(required('reference'), out, { words: values.words ? await readJson(resolve(values.words)) : undefined });
      console.log(`已提取 ${project.shots.length} 个分镜：${out}`); break;
    }
    case 'plan': {
      if ((await runtime()).engine === 'hypit') {
        console.log(JSON.stringify(await checkHypitProject(required('project'), resolve(values.out || 'runs/plan')), null, 2)); break;
      }
      const prepared = await plan(required('project'));
      console.log(JSON.stringify({ name: prepared.project.name, duration: prepared.duration, steps: prepared.steps }, null, 2)); break;
    }
    case 'render': console.log(await render(required('project'), resolve(values.out || 'runs/output'), console.log, (await runtime()).engine)); break;
    case 'demo': console.log(await demo(resolve(values.out || 'runs/demo'))); break;
    default: console.log(help);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
