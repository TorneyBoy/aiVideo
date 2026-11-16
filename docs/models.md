# 火山引擎与豆包接入说明

人物和商品画面统一使用火山方舟 Seedance；声音统一使用豆包录音识别、声音复刻 V3 与语音合成 V3。项目也保留可选的 ComfyUI 和本地 CosyVoice 适配，但默认云流程不需要它们。

默认由 Hypit 原生 Compiler、Runtime 和合成组件执行画面流程，火山以自有 Provider 接入。现有 `.env` 凭证继续生效，不需要 HypiHub Key。安装及原作示例差异见 [Hypit 原生底座](hypit-native.md)。

## 1. 填写 .env

在项目根目录 `C:\documents\development\aiVideo\.env` 填写凭证。启动时自动读取，系统环境变量优先，修改后需重启。凭证不会放进前端、项目 JSON、日志或任务回执。

```dotenv
ARK_API_KEY=你的方舟API_Key
ARK_VIDEO_MODEL=实际已开通的Seedance模型ID或推理接入点ID
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
ARK_VIDEO_FAMILY=
ARK_VIDEO_RESOLUTION=720p

# 填写当前账号已开通的模型 ID，两项复用 ARK_API_KEY。
ARK_IMAGE_MODEL=支持多图生图的Seedream模型ID
ARK_DIRECTOR_MODEL=支持图片和视频理解的豆包模型ID

VOICE_PROVIDER=doubao
VOLC_SPEECH_API_KEY=豆包语音控制台的API_Key
VOLC_SPEECH_RESOURCE_ID=seed-icl-2.0
VOLC_ASR_RESOURCE_ID=volc.seedasr.auc
VOLC_SPEECH_LANGUAGE=cn
VOLC_SPEECH_RATE=0
VOLC_SPEECH_SPEAKER_ID=
VOLC_SPEECH_CLONE_SPEAKER_ID=
```

完整流程默认启用三机位导演。图片接口使用 `/images/generations`，提供原主体、源场景帧及已生成的主全景；导演接口使用 `/chat/completions`，输入源视频、帧和带时间的台词并要求结构化角色／机位计划。模型 ID 示例为 `doubao-seedream-5-0-pro-260628`、`doubao-seed-2-1-pro-260915`，应以当前账号实际开通的 ID 为准，不自动切换模型或以失败调用试探权限。官方接口：[图片生成](https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh)、[视频理解](https://docs.volcengine.com/docs/ark/video-understanding?lang=zh)。

逐词流程使用豆包录音识别标准版 `show_utterances=true` 返回的 `utterances[].words[]`，识别最终实际使用的配音。缺失词级时间时停止，不用分句时间均分，也不调用 WhisperX 或外部非火山推理服务。原台词用于导演与配音，最终音频词级结果用于 Hypit 语义投影、逐词高亮及 SRT 下载。

视频与语音 Key 分别获取；不能把方舟 Key 或通用云账号 AK/SK 当作豆包语音 Key。`VOICE_PROVIDER` 也接受 `volcengine`、`doobao`，均路由到豆包。

`ARK_VIDEO_FAMILY` 留空时，根据明确的模型名识别 2.5，其余默认 2.0。若填写的是 `ep-...` 接入点，必须按其实际模型设置 `seedance-2.0` 或 `seedance-2.5`。2.5 视频编辑请求使用 `duration=-1`；2.0 使用具体整数秒。不能用 1.x 图生视频模型完成参考视频编辑。

旧版语音控制台可改用下面一组凭证，和新版 API Key 二选一：

```dotenv
VOLC_SPEECH_APP_ID=语音应用APP_ID
VOLC_SPEECH_ACCESS_TOKEN=语音应用Access_Token
```

没有自定义 `config/runtime.json` 时，系统从 `.env` 自动建立视频、声音路由。若指定 `AIVIDEO_CONFIG`，则严格使用该 Profile，不再自动合并云路由。旧 Profile 如果仍指向本地 CosyVoice，需要移除该声音配置或改为 `type: doubao`。

## 2. 开通模型与素材存储

- 火山方舟：当前 API Key 所属项目可调用的 Seedance 2.0/2.5；Files 接口可访问不代表视频模型已开通。
- 豆包语音：同一项目中的声音复刻 2.0、音色服务（`volc.megatts.timbre`）、在线语音合成 V3。
- 豆包录音识别标准版：默认资源 `volc.seedasr.auc`，用于原视频台词与分句时间戳。

项目使用标准版 ASR，不依赖已限制新用户开通的极速版。ASR 可能排队较久，等待超时后可以继续查询同一任务。声音复刻和 ASR 的权限要分别开通，即使共用一个语音 API Key。

本地视频和识别音频默认由服务器磁盘提供临时签名 GET 链接，无需开通 TOS。服务器部署和完整配置见 [隔离部署说明](../deploy/README.md)。

```dotenv
MATERIAL_STORAGE=local
MATERIAL_DIRECTORY=runs/materials
MATERIAL_PUBLIC_BASE_URL=https://huayuan.ink/aiVideo
MATERIAL_SIGNING_KEY=自行生成至少32字节的随机密钥
MATERIAL_URL_TTL_SECONDS=21600
MATERIAL_RETENTION_SECONDS=86400
MATERIAL_CLEANUP_INTERVAL_SECONDS=900
MATERIAL_MAX_BYTES=2147483648
MATERIAL_MIN_FREE_BYTES=2147483648
APP_PUBLIC_URL=https://huayuan.ink/aiVideo
APP_AUTH_USER=aivideo
APP_AUTH_PASSWORD=至少16位的独立工作台密码
```

正式服务器填写自己的公网 HTTPS 地址；不能将本机电脑保存的文件指向服务器域名，文件必须由该地址对应的 aiVideo 实例保存并提供。临时副本与任务／音色库分开，清理仅删除已过期的临时副本。页面、接口、播放和下载使用同一路径前缀。

下方 TOS 是可选的旧版兼容方案，仅在 `MATERIAL_STORAGE=tos` 时使用。公开示例验证也不需要 TOS。

```dotenv
TOS_BUCKET=你的私有桶名
TOS_REGION=cn-beijing
# 留空按地域推导；不需要 https:// 或桶名前缀
TOS_ENDPOINT=
TOS_ACCESS_KEY_ID=仅限该桶和下方前缀的访问凭证
TOS_SECRET_ACCESS_KEY=对应密钥
TOS_SECURITY_TOKEN=
TOS_PREFIX=aivideo
TOS_URL_TTL_SECONDS=21600
```

开通和填写步骤：

1. 使用主账号登录[对象存储控制台](https://console.volcengine.com/tos)，首次进入时按提示勾选服务条款并开通 TOS。流程参考[官方控制台快速入门](https://docs.volcengine.com/docs/torch-object-storage/getting-started-with-tos-using-the-console?lang=zh)。
2. 在“桶列表”中选择“创建桶”。设置一个全局唯一的桶名，地域选“华北2（北京）”，存储类型选“标准存储”，权限选“私有”；其余按需设置。把实际桶名填到 `.env` 的 `TOS_BUCKET`。如果选择其他地域，必须同时修改 `TOS_REGION`。
3. 在“访问控制（IAM）→ 用户管理”创建专用用户，例如 `aivideo-tos`，勾选“编程访问”。保存该用户的 Access Key ID 和 Secret Access Key，分别填入 `.env` 的 `TOS_ACCESS_KEY_ID` 和 `TOS_SECRET_ACCESS_KEY`。这是一对 IAM 密钥，与方舟、豆包语音 API Key 分开。
4. 在“访问控制（IAM）→ 权限策略”新建自定义策略，切换到 JSON 编辑器，复制 [`config/tos-policy.example.json`](../config/tos-policy.example.json)。将 `YOUR_BUCKET_NAME` 替换为实际桶名，保留 `aivideo/*`。提交后将策略授权给上一步创建的用户，保证授权范围包含此桶所属的项目。策略仅允许该目录下的读取和上传，不需要授予整个账号的 TOSFullAccess。资源与动作语法参考[官方 IAM 策略示例](https://docs.volcengine.com/docs/torch-object-storage/iam-policy-examples?lang=zh)。
5. `TOS_ENDPOINT` 可留空，程序会根据地域选择公网域名；北京为 `tos-cn-beijing.volces.com`。如果手填，只填域名，不填 `https://`、桶名、文件路径、内网域名或 S3 域名。地域对应关系参考[官方地域与访问域名](https://docs.volcengine.com/docs/torch-object-storage/regions-and-endpoints?lang=en)。长期 IAM 密钥下 `TOS_SECURITY_TOKEN` 保持空白；`TOS_PREFIX=aivideo`、`TOS_URL_TTL_SECONDS=21600` 可以保持默认。
6. 保存 `.env` 后重启工作台。可运行 `npm run config:check` 检查字段是否已填写；此命令只检查本机，不验证真实桶权限、不上传素材、不调用收费模型。无需手动上传文件或预先创建 `aivideo` 文件夹，正式任务会自动上传。

凭证需要该桶前缀下的 GetObject／PutObject 权限，HeadObject 用于检查是否已上传，对象元数据读取包含在 GetObject 权限中。程序不创建桶、不改公开策略或 ACL；上传和读取由后端完成，当前流程无需设置浏览器跨域（CORS）。签名链接默认有效 6 小时，私有桶无需开放匿名访问。临时凭证还需填写 `TOS_SECURITY_TOKEN`，实际有效期受临时凭证到期时间限制。对象会留在桶中，链接过期不会删除文件，可按业务需要对 `aivideo/` 设置生命周期清理。

TOS 的存储容量、请求次数和公网流出流量会按实际使用计费，详见[官方计费概述](https://docs.volcengine.com/docs/torch-object-storage/Billingoverview-2?lang=zh)。这些费用与模型生成费用、音色槽位费用分开。

本次实测方舟 Files 的 `purpose=user_data` 上传成功且状态为 active，但不返回下载 URL，因此已移除将 Files 文件 ID 当素材下载地址的路径。Files 的输入文件 ID 用于其支持的理解接口，不能假定可直接用于视频生成或 ASR。

## 3. 独立音色库

侧栏“我的音色”独立于视频任务和 TOS。先命名并保存 3–30 秒清晰录音到本地，再输入 4–300 字的试听文本，明确确认上传并生成本轮试听。每轮创建独立的临时候选 ID，至少完成两轮有效试听并人工比较后，才可确认最终候选；其他候选保留试听记录。录音需调整时可另建候选，已正式启用的音色不覆盖或重训。

试听通过注册接口的 `extra_params.demo_text` 生成，试听字符可能产生用量费，不能将“不收槽位费”理解为“全部测试免费”。注册后下载官方返回的试听文件，不额外调用正式 TTS 冒充试听。用户听过并勾选费用确认后，点击所选轮次的“确认并正式启用”，才调用一次正式合成，可能触发后付费音色槽位费。只有最终成功启用并保存的音色出现在视频选择列表。

音色保存在 `runs/voices/<音色ID>/`，各轮录音、测试文本、试听、回执和确认单独保留。后续视频只需选择已确定音色；不会再次注册，也不会再要求逐视频确认同一个槽位。正常配音字符仍会计费，完成的相同台词可跨视频复用缓存。切换语音凭证／账号时会停止自动复用，要求核对，不自动新建付费音色。

旧 CLI／历史任务仍兼容 `VOLC_SPEECH_SPEAKER_ID`、未训练的预付费 `VOLC_SPEECH_CLONE_SPEAKER_ID` 及原来的逐任务两阶段确认。新的音色库始终使用独立的自定义后付费候选，不会覆盖环境变量中配置的预付费槽位。

按豆包当前计费说明，注册试听不会立即收取后付费音色槽位费，首次正式语音合成才触发槽位收费，此外有合成用量费用；金额以当前控制台为准。未正式调用的试听音色可能在 7 天后删除。开通后付费、保存本地音色 ID、普通开始／重试均不代替用户确认。确认记录绑定当前录音、账号、音色与合成内容；变化后重新确认。连接检查不会注册或合成音色。

## 4. 上传与自动处理

1. 上传参考视频和目标模特／商品图，选择替换类型。
2. 从独立音色库选择已确定音色并选择声音处理方式；关闭声音替换则保留原声。
3. 系统分析视频，保留原始分镜；生成阶段重新分为 4–15 秒片段。
4. 有声音替换时，抽取 16 kHz WAV，经 TOS 私有上传取得临时签名 URL，再提交豆包 ASR。
5. 豆包配音模式使用已确定音色，把分句文本合成 24 kHz PCM，经有限变速恢复原始句子时间窗与停顿；不重复克隆。
6. 将参考视频签名链接、主体参考图或资产、配音提交给 Seedance 进行编辑；图片和短配音支持 Base64，人物任务还提供台词参考以辅助口型。
7. 下载生成视频，规范化帧率与尺寸，烧录分句字幕，使用明确选择的音轨合成。

程序保留 ASR 分句边界，不生成虚构的逐词 TTS 时间戳。配音时长相对原句偏差超过 35% 时，任务停止并提示调整 `VOLC_SPEECH_RATE`，避免大幅拉伸或截断台词。真实口型仍需检查。

豆包配音是 ASR + TTS，语气会重新生成。若选择 VC，则跳过 ASR 和 TTS，用原视频音频与音色库保留的原始录音调用独立 `/voice-convert` 服务。VC 不使用豆包闭源音色模型，声音相似度、情绪和音高保留效果需分别验收。本机尚未部署真实 VC 模型，配置 `VOICE_CONVERSION_URL` 后界面才允许选择；可参考现有 `workers/voice_server.py` 协议。VC 本身不要求豆包槽位，当前复用已确定音色库的原始录音只是素材入口，不应为尚未验证的 VC 效果提前购买音色。

```dotenv
VOICE_CONVERSION_URL=http://127.0.0.1:8088
VOICE_CONVERSION_TOKEN=
```

示例地址需要替换为实际部署的服务。当前两种路径均未实现背景人声／音乐分离；建议用清晰干声验收，不能承诺背景音乐原样保留。

## 5. 真人肖像与模型限制

官方当前对含真人人脸的参考图片／视频有接入限制，需要按其肖像素材方案接入。普通 TOS 上传只提供临时可访问的文件地址，不代表素材通过肖像审核或取得特殊权限。

页面的“肖像素材设置”可以填写已注册的主体和参考视频 `asset://` URI，程序将其原样传给模型。素材应对应本次上传文件。参考视频资产当前用于一次 4–15 秒任务；长视频需要分别注册分段资产。原视频或商品镜头中含真人面孔也应核对平台要求。

生成参考视频会转为 H.264、24 fps 并规范化尺寸；宽高比需在 0.4–2.5 之间。所有云片段限制为 4–15 秒。2.5 编辑模型的输出可能略短于参考；如时长不足，程序报错，不用静帧补齐口播。商品包装、Logo、手部遮挡、跨片段身份与嘴型均需要人工验收。

当前不包含背景音乐分离、语义镜头分类、自动掩码、文案重写或旧字幕消除。全部片段会交给选定替换类型处理，建议先以单人或单商品短片试用。

## 6. 检查连接

```powershell
npm run config:check
npm run cloud:check
# 以下会调用计费接口；没有 TOS 也可用官方公开示例验证
npm run cloud:smoke
# 使用自己的目标录音验证复刻及配音（新后付费音色首次合成可能收槽位费）
npm run cloud:smoke -- --voice-sample "D:\素材\我的录音.wav"
npm run dev
```

- `config:check`：仅检查是否填写，不联网，不显示密钥。
- `cloud:check`：只读查询 Files、一个不存在的测试音色及随机 ASR 任务 ID，不注册音色、不合成、不提交视频。通过也不等于每个模型权限都可用。
- `cloud:smoke`：使用官方公开商品视频、面霜罐图片和官方 ASR 示例音频，分别验证商品替换与分句识别。默认报告在 `runs/live-check/official-fixture/report.json`。提供自己的录音或现有音色时，音色阶段暂停等待确认；保留回执与产物。重跑不会代替确认；一个环节失败仍检查其余环节。该商品示例不验证真人身份、口型或用户素材效果。
- `dev`：打开 http://127.0.0.1:4173 后上传真实素材。

命令行先用 `npm run video -- voice-review --out runs/live-check/official-fixture/voice --stage register` 核对，再在自己的交互终端运行同参数的 `voice-confirm` 并输入“确认上传”。重跑原来的 `cloud:smoke` 后会在正式合成前暂停；先听本地 `preview.wav`（如已取得），再使用 `--stage activate` 核对并输入“确认付费使用”。管道、自动参数和环境变量不能代替人工确认。

若语音返回 `401 / Invalid X-Api-Key`，优先检查是否使用了豆包语音控制台的 Key，及系统环境变量是否覆盖 `.env`。不要将密钥粘贴进聊天、URL 或素材上传表单。

若返回 `403 / [resource_id=volc.megatts.timbre] requested resource not granted`，当前 Key 尚未获得音色管理权限；检查该 Key 所属项目的音色服务、声音复刻服务和授权范围。仅在另一个项目开通或仅开通 TTS 资源不代表音色查询可用。若视频返回 `has not activated the model`，需开通对应模型或将 `ARK_VIDEO_MODEL` 改为当前项目已开通的 2.0/2.5 模型／接入点。

## 7. 失败与恢复

任务保存在 `runs/jobs/<id>`，服务重启后点击继续处理。视频、ASR 与音色注册保存远程身份；相同样本的音色名固定。已明确拒绝的请求可以在修正配置后继续提交；已经受理的视频会优先查询，不重新生成。文件过期可重新上传，成片损坏可用原任务重新下载。

`awaiting_voice_upload` 和 `awaiting_voice_activation` 是持久的等待状态，不会因重启、重试或轮询自动批准；网页确认请求必须携带当前阶段及确认编号。试听音频可保存在本地，这不是云端音色模型导出。豆包路径仍为 ASR + TTS；只换音色、保持原语调的 VC 需要另行验收。

如果视频提交响应丢失、没有拿到任务 ID，系统不会盲目重复提交。先在方舟控制台核实是否存在任务，再恢复对应回执或明确开始新任务。语音流没有等价的异步回执；中断句子可能需要重新合成。已明确失败的视频任务不会循环重提，需先检查原因、调整输入或配置。

签名 URL 只在内存中使用，回执保存任务 ID、音色 ID 和内容哈希。日志会遮盖已知密钥与 URL。常规测试使用本地模拟服务，不提交真实收费生成任务；公开示例命令是单独显式调用的联调工具。

## 官方接口与实现

| 环节 | 官方文档 | 实现 |
| --- | --- | --- |
| 视频任务 | [创建视频任务](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh) | `src/ark.ts` |
| 本地素材 | [火山 TOS 官方 SDK](https://github.com/volcengine/ve-tos-js-sdk) | `src/tos.ts`、`ArkClient.upload` |
| 台词识别 | [标准版任务提交](https://docs.volcengine.com/docs/doubao-voice/task-submission-http-1?lang=en) | `src/doubao.ts` |
| 音色注册 | [声音复刻 V3](https://docs.volcengine.com/docs/doubao-voice/sound-replica-api-v3?lang=zh) | `cloneSpeaker` |
| 语音合成 | [单向 SSE 合成](https://docs.volcengine.com/docs/doubao-voice/http-chunked-sse-unidirectional-streaming-v3?lang=zh) | `synthesizeNarration` |

可选本地 CosyVoice 包装服务仍位于 `workers/voice_server.py`，只适用于单独部署开源推理环境后的本地 VC 流程，与豆包 ASR + TTS 是不同协议。
