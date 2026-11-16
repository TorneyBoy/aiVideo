# aiVideo · 视频复刻工作台

上传参考视频、自己的模特照片或商品图，选择独立音色库中已确认的音色，按原视频的分镜与节奏生成新的视频。当前默认使用固定版本的 **Hypit 原生源码作为编译、调度与合成底座**，保留现有页面、豆包音色库与火山接口。

默认流程现已接入完整的 **三机位素材准备、逐句导演、最终配音逐词对齐**，统一调用火山服务：豆包理解参考视频和角色，Seedream 生成共享机位，Seedance 生成片段，豆包识别最终配音，Hypit 原生合成逐词高亮字幕。先接通主持人，再复用到商品场景。独立音色库保留多轮试听与费用确认，视频只选择已确认音色，按角色替换主持人台词并保留其他角色原声。人物和商品端到端联调使用本地模拟服务，不代表真实模型画质已验收。

## 启动

首次从 GitHub 获取代码时，需要同时获取固定版本的 Hypit 子模块：

```powershell
git clone --recurse-submodules https://github.com/TorneyBoy/aiVideo.git
cd aiVideo
```

如果已用普通方式克隆，请先运行 `git submodule update --init --recursive`。Hypit 保持固定提交，不自动切到最新版。第三方来源和许可见 [第三方说明](THIRD_PARTY_NOTICES.md)。

需要 Node.js 24.4 或更新版本、pnpm 及 Chrome / Edge。FFmpeg 与 ffprobe 随依赖安装。Hypit 使用本机浏览器完成原生画面合成，不下载额外浏览器或模型权重。

```powershell
npm install
npm run hypit:setup
npm run dev
```

打开 [视频复刻工作台](http://127.0.0.1:4173)。开发模式默认只监听本机；阿里云服务器部署见 [隔离部署说明](deploy/README.md)，公开工作台有独立登录保护。

1. 选择人物替换或商品替换。
2. 上传参考视频及主体照片。
3. 先到侧栏“我的音色”保存录音，换用不同文本做多轮试听；只对选中的一轮确认费用并正式启用。每轮试听是独立的临时候选，试听文本可能产生合成用量费，未选中候选不会自动转正。
4. 返回视频复刻，直接选择已确定音色与声音处理方式。豆包配音会重新生成语气；VC 需要配置独立服务并验收。视频任务不再重复克隆，相同音色与台词的已完成配音可跨任务复用。关闭声音替换则保留原声。未确认音色不能用于视频任务。
5. 尚未配置模型时，任务停在“等待服务配置”，保留上传素材与分镜；配置后点“继续处理”。

当前火山声音路径为 ASR + 克隆音色 TTS：保留原台词，不自动改写文案，按识别分句恢复原始停顿。建议先用 4–15 秒、单人清晰干声的素材验收。Seedance 对真人人脸参考素材有限制，需要按官方肖像素材方案接入；页面支持填写已注册主体与参考视频的 `asset://` URI，不能把普通文件上传当作肖像授权。

## 现有能力与边界

| 环节 | 当前实现 |
| --- | --- |
| 上传与任务 | 视频、主体图、目标声音上传，素材预览、任务记录、重试、成片下载 |
| 视频分析 | 媒体信息、切镜、中帧、16 kHz 音频和分镜浏览页；火山生成阶段重组为 4–15 秒片段 |
| 时间轴 | 页面 JSON 转换为 Hypit SVML/SVRun；原生 Compiler、Normalize、Timeline、VisualTrack、AudioTrack、Film、HTML Video |
| 画面生成 | 豆包视频理解与逐句导演；Seedream 主全景 → 另外两个机位；三机位与原视频、最终音频共同约束 Seedance；原生任务与回执复用 |
| 声音替换 | 豆包录音识别标准版、音色注册与查询、SSE 语音合成、分句时间对齐；保留可选本地 CosyVoice |
| 独立音色库 | 不依赖视频或 TOS 建立候选、多轮文本试听、对比与显式付费确认、确定后直接选择、已确定音色不覆盖或重训 |
| 合成 | 镜头规范化、视频拼接、独立音轨、可选烧录字幕、成片时长和哈希校验 |
| 复用 | 内容哈希、镜头与配音缓存、相同样本的音色复用、私有素材去重及链接刷新、损坏成片重新下载、远程任务继续查询 |
| 连接检查 | 不显示密钥的本地填写检查，以及不提交生成任务的只读接口连接检查 |

当前不包含分割掩码、OCR、文案重写、背景人声分离或自动质量打分。模型接收参考视频、三机位与最终配音，人物口型、商品遮挡及 Logo 等细节仍需人工检查。完整流程字幕使用最终实际音频的逐词识别证据；基础兼容模式仍使用分句边界。原视频里已烧录的字幕需要额外移除。

## 调研与接入

- [Hypit 源码分析、开源方案比较与项目架构](docs/architecture.md)
- [Hypit 原生底座、换主持人示例的改编与安装](docs/hypit-native.md)
- [模型配置、云 API 接入要求与 CosyVoice 服务](docs/models.md)
- [运行配置起点](config/runtime.example.json)

配置由服务端从 `config/runtime.json` 读取，也可用 `AIVIDEO_CONFIG` 指定文件。密钥通过环境变量引用，不放入前端或项目 JSON。实际生成会将素材发送到配置的服务。

火山凭证填写在项目根目录 `.env`，格式参考 [.env.example](.env.example)。新增 `ARK_IMAGE_MODEL`（支持多图生图的 Seedream）和 `ARK_DIRECTOR_MODEL`（支持图片／视频理解的豆包）；两者复用 `ARK_API_KEY`，由用户填写已开通的模型 ID。启动命令自动读取 `.env`，已有系统环境变量优先；修改后需重启。系统默认将人物、商品和声音路由到火山，`VOICE_PROVIDER=doubao` 也兼容 `volcengine`、`doobao`。具体见 [云服务凭证配置](docs/models.md)。

完整上传流程默认使用服务器本地磁盘及临时签名 HTTPS 链接，无需开通 TOS。通过 `MATERIAL_PUBLIC_BASE_URL` 和 `MATERIAL_SIGNING_KEY` 配置发布地址与服务端密钥；支持 `https://huayuan.ink/aiVideo` 路径前缀，默认链接6小时有效、临时副本24小时后清理，原始任务、成片及音色库保留。可显式选择 `MATERIAL_STORAGE=tos` 兼容旧桶。方舟 Files 的文件 ID 不能当作 Seedance 和 ASR 下载地址。`cloud:smoke` 是旧的收费协议诊断命令，不能代表完整三机位流程已运行；部署检查不自动执行它或音色槽位操作。

`npm run config:check` 只检查填写情况；`npm run cloud:check` 查询 Files、音色及随机 ASR 任务，不提交生成任务。`npm run cloud:smoke` 会真实调用视频生成与录音识别，按服务计费；音色注册和正式合成分别暂停等待人工确认，命令行需在交互终端确认。通过只读检查不表示所有生成权限已开通。

2026-11-15 实测：公开语音识别与分句时间戳已通过；当前配置的视频模型返回未开通，音色管理返回 `volc.megatts.timbre` 权限不足，尚未产出真实替换成片。详见 [联调结果与下一步](docs/live-validation.md)。

## 不依赖模型的演示

```powershell
npm run demo
```

输出 `runs/demo/output/video.mp4`，演示参考视频分析、词锚点、替换整个素材镜头、中文字幕及音画合成。**这是合成素材的剪辑演示，不是 AI 人物／商品替换或声音克隆样片。**

```powershell
npm run video -- analyze --reference "D:\素材\参考.mp4" --out runs/project
npm run video -- plan --project runs/project/project.json
npm run video -- render --project runs/project/project.json --out runs/project/output
npm run video -- doctor
npm run check
npm test
```

`analyze --words words.json` 可导入 `[{"id":"w1","text":"你好","start":0,"end":0.6}]` 形式的词记录。分镜 `start`、`end` 可以使用秒，也可以使用 `{"word":"w1","edge":"end","offset":0}`。CLI 分析默认不生成字幕；豆包自动流程会生成基于 ASR 分句边界的字幕。

任务和上传素材位于 `runs/jobs/<任务编号>/`；运行数据与本地配置已忽略。Hypit 已接受的生成与合成由原生 Worker 执行；页面服务重启后点继续处理，使用保存的构建编号继续跟踪。声音准备阶段仍由页面服务管理；TTS 流中断时未完成的句子可能需要重新合成。视频提交响应丢失且没有任务 ID 时，不自动重提，需先在方舟控制台核对。签名下载地址与密钥不写入任务日志或回执。

## 验证

`npm test` 包含真实 FFmpeg 编码、音视频时长、HTTP 上传、媒体 Range、缓存修复、ComfyUI 协议，以及模拟火山服务的两类完整任务、独立音色库多轮测试与最终确认、跨视频复用、台词转写、SSE 合成、视频回执恢复及密钥／签名地址不落盘检查。音色测试验证未确认不注册／不合成、重试不代替确认、并发重复确认只受理一次、草稿不能用于视频、切换账号不能自动复用已付费音色。测试不调用真实收费模型，不代表生成质量已验收。

## 依赖与来源

Hypit 运行源码固定为 `6bacce093695ccc2bde5aa5d7de230e9682ffa79`，版本 0.3.2，完整保存在 `vendor/hypit`，来源为 [原仓库](https://github.com/hypit-ai/hypit)。原生编译器、执行器及媒体合成是实际运行依赖；自有火山适配位于 `integrations/hypit-volcano`。保留上游名称、版权与 [许可证](https://github.com/hypit-ai/hypit/blob/6bacce093695ccc2bde5aa5d7de230e9682ffa79/LICENSE)；该许可带附加条件。

媒体二进制由 [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) 和 [ffprobe-static](https://github.com/joshwnj/ffprobe-static) 提供；重新分发二进制时需保留各自许可并检查所选 FFmpeg 构建的许可。模型代码、权重和调用服务分别适用各自条款。
