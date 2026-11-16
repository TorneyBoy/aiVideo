# 2026-11-15 火山真实联调记录

此记录使用本机 `.env` 调用真实服务，不记录密钥。常规 `npm test` 使用模拟 API，与这里的真实结果分开统计。

以下表格保留此前真实云端检查结果。本次三机位、逐句导演和逐词流程接入只做本地模拟联调，没有再次提交收费视频、图片或音色操作。新流程待填写 `ARK_IMAGE_MODEL`、`ARK_DIRECTOR_MODEL` 及本地素材 TOS 配置后，再使用用户正式素材运行；不得把本地模拟成片当成真实效果样片。

| 环节 | 真实结果 | 后续要求 |
| --- | --- | --- |
| 方舟 Key / Files 查询 | HTTP 200 | 不代表视频模型已开通 |
| 本地 Files 上传 | 成功且 active，但无下载 URL | 已改为 TOS 私有上传；用户尚未提供 TOS，当前用公开素材验证 |
| 公开商品替换 | HTTP 404：`doubao-seedance-2-0-260128` 尚未开通 | 开通该模型或填写当前项目可调用的模型／接入点 ID |
| 豆包标准版 ASR | 已成功提交、查询并取得文本和分句时间戳 | 6.312 秒官方公开语音，识别区间 0.48–5.88 秒 |
| 豆包音色查询 | HTTP 403：缺少 `volc.megatts.timbre` 资源权限 | 当前语音 Key 所属项目需要音色服务和声音复刻权限 |
| 声音复刻 / 克隆 TTS | 未完成真实验证 | 先解决音色权限，再使用自己的目标录音或已注册音色 |
| 真人替换与口型 | 未完成真实验证 | 需要可用视频模型及用户已授权的肖像素材 |
| 用户完整上传成片 | 尚未产出 | 需要 TOS、本账号模型权限、目标素材和录音验收 |

ASR 官方样例识别文本为：“刚刚还在想你怎么还不来找我聊天，你就来了，真是心有灵犀啊。”

## 已修正的问题

- `.env` 中重复拼接的模型 ID 已修正为单个 `doubao-seedance-2-0-260128`，保留凭证。
- 不再把 Files `user_data` 文件 ID 当作可下载的素材链接。TOS 适配使用私有对象、内容哈希去重和临时签名；配置不足时先提示，避免进入收费生成阶段才发现素材不可访问。TOS 协议已用本地模拟服务验证，尚未使用真实桶验收。
- 图片和短配音直接使用 Seedance 支持的 Base64；视频及标准 ASR 的本地音频需要签名 URL 或受支持的素材资产。
- 新增 `npm run cloud:smoke`，公开素材不依赖 TOS，分项记录结果；已受理任务继续查询，已完成识别复用结果。

## 再次联调

1. 在当前视频 Key 所属项目开通目标模型，或更新 `.env` 的 `ARK_VIDEO_MODEL`；`ep-...` 需同时指定实际的 `ARK_VIDEO_FAMILY`。
2. 检查当前语音 Key 所属项目的“音色服务”和“声音复刻 2.0”；只在其他项目开通不会让这个 Key 自动取得权限。
3. 运行 `npm run cloud:check`，再运行 `npm run cloud:smoke`。后者会调用真实计费接口。
4. 需要声音实测时运行 `npm run cloud:smoke -- --voice-sample "D:\素材\我的录音.wav"`，录音为自己的 3–30 秒清晰干声。新后付费音色首次合成可能收槽位费。

动态报告保存在 `runs/live-check/official-fixture/report.json`。真人参考素材接入和商品细节需用实际视频验收，公开商品例子不验证人物身份或口型。

依据：[视频模型调用教程](https://docs.volcengine.com/docs/ark/video-generation-tutorial?lang=zh)、[豆包控制台与项目说明](https://docs.volcengine.com/docs/doubao-voice/console-guidance?lang=zh)、[音色注册](https://docs.volcengine.com/docs/doubao-voice/tone-training-http?lang=en)、[标准版 ASR](https://docs.volcengine.com/docs/doubao-voice/task-submission-http-1?lang=en)、[TOS 官方 SDK](https://github.com/volcengine/ve-tos-js-sdk)。
