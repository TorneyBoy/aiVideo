# Hypit 原生底座

本项目从 `vendor/hypit/bin/hypit.mjs` 执行固定的 Hypit 0.3.2 源码，版本为
`6bacce093695ccc2bde5aa5d7de230e9682ffa79`。该目录是原仓库完整 checkout，未改动上游实现。
`integrations/UPSTREAM.json` 记录来源，`vendor/hypit/LICENSE` 保留原许可与版权。

## 实际执行路径

现有页面 → 参考视频分析 → 配置／已确认音色检查 → 豆包识别原词与说话人 →
豆包视频理解和逐句导演 → 原生工程检查 → 主持人角色配音与原声保留 →
Hypit Compiler / Runtime → Seedream 主全景 → 依赖主全景的另外两机位 →
三机位＋源视频＋最终音频＋逐句 Text Recipe → Seedance → Normalize →
豆包最终音频词级识别 → 原生 NarrativeAlignment / Projection →
CaptionFine / Timeline / VisualTrack / AudioTrack / Film / HTML Video → 成片。

`src/hypit.ts` 负责将页面的项目转换为原生工程。画面生成请求由 Hypit 调度，
`integrations/hypit-volcano` 使用上游公开 Provider 扩展接口连接用户的方舟账号。
媒体归一化、语义对齐、逐词高亮字幕、时间轴、画面装配和导出使用上游组件。
FFmpeg 负责参考片段、导演理解视频及配音准备。默认 `engine=hypit`、`production.enabled=true`，没有异常时自动退回旧流程的分支。
ComfyUI 老工程可显式指定 `engine=legacy`；`production.enabled=false` 仅保留基础火山兼容流程。
`demo` 仍是旧版纯本地剪辑素材演示。

人物模式让参考视频提供动作、运镜和时间，主体图提供新身份，已确认配音提供说话节奏。
商品模式复用同一原生图，只更换主体与替换指令，要求保留人物、手部与遮挡。
一张主体正面图仍然不能证明背面、侧面或被遮挡细节。Hypit 是创作执行系统，
实际生成质量还取决于模型、素材和条件；没有把本地协议检查称为真实替换质量验收。

## 与原仓库“换主持人”示例的关系

原作保留在 `vendor/hypit/examples/interview/swap-host.svml`，可直接执行只读检查：

```powershell
node vendor/hypit/bin/hypit.mjs check vendor/hypit/examples/interview/swap-host.svrun --project vendor/hypit/examples/interview --json
```

原作是三段街采访再创作：GPT Image 生成主持人／嘉宾／双人机位及图标，
Seedance Mini 接收三组机位图和两段声音生成视频，WhisperX 提供词级对齐，
最后由原生字幕、闪光、图标、音乐及 Film 合成。它不是自动逐帧抠出原主持人的模型。

完整火山改编版复用原生生成、Text Recipe、NarrativeAlignment、时间轴和合成组件，
将图片生成替换为 Seedream，将外部声学证据替换为豆包的真实词级结果，仍由上游
`narrative-speech-alignment` 与 `narrative-temporal` 完成语义映射。没有把豆包伪装成
WhisperX 模型：自有模块声明 `doubao-word-evidence` 能力，原生 `volc:Alignment`
组合投影音频、火山识别与本地语义对齐。不会向 HypiHub、GPT Image 或 WhisperX 发请求。

三个机位不是独立生成：先生成主全景，另两张图都显式引用主全景、同一主体与各自源帧。
全片共享场景、身份、服装、道具和角色定义；每句明确发言角色、机位、动作和表达。
同一说话人变成两个角色、两个说话人合并成一个角色或低置信度分配时，停止后续生成。
单张用户照片仍不提供真实背面几何；生成的三机位不能作为真实三维重建的证明。

独立音色库确认流程不变。完整视频流程拒绝未确认音色，不调用注册或激活槽位接口；
只为导演标记的目标主持人台词合成目标音色，其他角色所在时间保留原声。
背景音乐没有独立分离，目标台词窗口内会被目标配音覆盖；TTS 的语气仍会重新生成。

## 安装与无费用检查

需要 Node.js 24.4+、pnpm，以及本机 Chrome / Edge。首次安装：

```powershell
npm install
npm run hypit:setup
npm run dev
```

本机已安装源码依赖。安装锁定上游 lockfile，跳过浏览器下载与安装脚本；不下载模型权重。
现有 Edge / Chrome 自动检测，也可在 `.env` 填 `HYPIT_CHROME_PATH`。

在 `.env` 填 `ARK_IMAGE_MODEL`、`ARK_DIRECTOR_MODEL`，分别选用已开通的 Seedream
多图生图模型与支持图片／视频理解的豆包模型，复用 `ARK_API_KEY`。
中文逐词字幕使用随依赖安装的 Noto Sans SC 字体，不依赖临时联网字体。

```powershell
npm run video -- plan --project runs/project/project.json --out runs/project/output
```

此命令写入 `runs/project/output/hypit/<签名前缀>/`，保留 `Brief.md`、`Treatment.md`、
`main.svml`、`recipes.svs`、`build.svrun`、`hypit.runtime.json` 及检查结果。
`plan` 不提交模型请求，生成适配器还有单独的 `allowPaidGeneration=false` 阻挡。
只有用户启动视频生成后的 `render` 才允许提交；音色注册／正式启用仍由原独立确认流程控制。

运行配置只写环境变量名称，真实 Key 从进程环境读取。账户摘要进入工程签名，
换账号不会继续使用旧工作进程。视频任务编号保存在回执中；恢复继续跟踪原构建，
已提交请求不自动重发。提交响应丢失时保留不确定状态，要求先核对方舟控制台。
下载链接只在内存中使用，不保存签名 URL。原生构建失败时保留现场，不盲目重建收费请求。

## 尚需实际素材的部分

完整三机位工程原生规划已通过，单片段有 3 个图片请求、1 个视频请求、1 个最终音频
逐词请求。人物优先、商品随后，已在本地模拟服务中完成原生端到端导出，包括
已确认音色复用、非目标角色原声保留、三个机位展示、真实服务时间格式解析与字幕下载。
这些结果证明执行路径与协议；模拟响应不代表云端模型的真实生成质量。

完整流程默认使用服务器本地素材存储与临时签名链接，不需要 TOS；视频 `asset://` 不能
代替这些音频／视频理解输入。真人人脸仍按火山肖像素材规则接入。机位图保持模型
原始字节，不重新压缩，临时 URL 不写入回执；平台能否接受含人脸参考由实际素材
授权与模型输出信任规则决定，不把任意生成的人像自动视为已授权。
未配置可访问的素材链接或未提供自己的参考片／模特素材时，系统不能产出真实换主持人成片。服务器部署见 `deploy/README.md`。
按当前要求，迁移只进行本地检查与模拟服务联调，不重复提交前期收费质量实验，
也不注册、启用或覆盖任何真实付费音色槽位。

## 正式任务的调用范围与恢复

常规有声视频包含：原片识别 1 次、导演分析 1 次、机位图片 3 张、每片段 1 个视频任务、
每个含台词片段 1 次最终音频识别；启用声音替换时再按目标主持人句子执行已确认音色 TTS。
没有额外的模型裁判、质量重试或自动抽卡。实际费用由所选模型及平台计量决定。
导演、图片和转写缓存以输入和账号绑定；视频回执持续跟踪原任务。
同步请求响应丢失时停止，不盲目重复图片或导演调用；失败原生构建重建时复用已完成素材。

完成任务后保留 `production/director.json`、原生工程、三机位原图、`words.json`、
`subtitles.srt` 和成片。`words.json` 来自最终实际音频的词级证据，未从原分句均分；
中文显示按上游词法与语义对齐处理，声学精度以识别服务实际分词和时间精度为限。
