type Environment = Record<string, string | undefined>;
export type SetupSection = { label: string; fields: { name: string; present: boolean }[]; notes: string[] };

/** Inspect presence only. Secrets never appear in the result, logs or browser responses. */
export function cloudConfigurationStatus(env: Environment = process.env): { sections: SetupSection[]; complete: boolean } {
  const present = (name: string) => !!env[name]?.trim();
  const fields = (...names: string[]) => names.map(name => ({ name, present: present(name) }));
  const video: SetupSection = {
    label: '火山方舟视频', fields: fields('ARK_API_KEY', 'ARK_VIDEO_MODEL'),
    notes: ['需要支持参考视频与参考图的模型；真人人像按火山肖像素材方案接入。'],
  };
  const inputProvider = env.VOICE_PROVIDER?.trim().toLowerCase() || 'volcengine';
  const selected = ['doubao', 'doobao'].includes(inputProvider) ? 'volcengine' : inputProvider;
  let voice: SetupSection;
  if (selected === 'volcengine') {
    const auth = present('VOLC_SPEECH_API_KEY')
      ? ['VOLC_SPEECH_API_KEY']
      : present('VOLC_SPEECH_APP_ID') || present('VOLC_SPEECH_ACCESS_TOKEN')
        ? ['VOLC_SPEECH_APP_ID', 'VOLC_SPEECH_ACCESS_TOKEN']
        : ['VOLC_SPEECH_API_KEY'];
    voice = {
      label: '火山豆包声音复刻', fields: fields(...auth, 'VOLC_SPEECH_RESOURCE_ID'),
      notes: ['语音凭证与方舟视频凭证分开；同一项目需开通声音复刻、音色服务和录音识别标准版。', `台词识别资源：${env.VOLC_ASR_RESOURCE_ID || 'volc.seedasr.auc'}`, '完整视频流程从独立音色库选择已确定音色；不会自动注册或启用付费槽位。'],
    };
  } else if (selected === 'aliyun') {
    voice = {
      label: '阿里云百炼声音复刻', fields: fields('DASHSCOPE_API_KEY', 'DASHSCOPE_WORKSPACE_ID', 'DASHSCOPE_REGION', 'DASHSCOPE_TTS_MODEL'),
      notes: ['音色需要与创建时的模型、账号及地域对应。', present('DASHSCOPE_VOICE_ID') ? '已填写现有音色 ID，尚未验证。' : '未填写音色 ID：首次使用需先注册复刻音色。'],
    };
  } else {
    voice = { label: '声音服务选择', fields: [{ name: 'VOICE_PROVIDER（只能填 volcengine 或 aliyun）', present: false }], notes: [] };
  }
  const storageMode = env.MATERIAL_STORAGE?.trim() || (present('TOS_BUCKET') ? 'tos' : 'local');
  const storage: SetupSection = storageMode === 'tos' ? {
    label: '本地素材私有存储', fields: fields('TOS_BUCKET', 'TOS_ACCESS_KEY_ID', 'TOS_SECRET_ACCESS_KEY'),
    notes: ['当前选择兼容的 TOS 存储；可改为 MATERIAL_STORAGE=local 使用服务器本地素材目录。', '使用私有桶与临时签名，不需要开启匿名访问。'],
  } : {
    label: '服务器本地素材存储', fields: [
      ...fields('MATERIAL_PUBLIC_BASE_URL'),
      { name: 'MATERIAL_SIGNING_KEY', present: Buffer.byteLength(env.MATERIAL_SIGNING_KEY?.trim() || '') >= 32 },
      ...(storageMode === 'local' ? [] : [{ name: 'MATERIAL_STORAGE（只能填 local 或 tos）', present: false }]),
    ],
    notes: ['不需要 TOS 凭证；正式任务通过带签名、带有效期的 HTTPS 链接读取临时素材副本。', '默认6小时链接、24小时保留，每15分钟清理过期副本；原始任务、成片和音色库不自动删除。'],
  };
  const production: SetupSection = { label: 'Hypit 三机位与逐句导演', fields: fields('ARK_IMAGE_MODEL', 'ARK_DIRECTOR_MODEL'), notes: ['图片模型需要支持多图生图；导演模型需要支持图片理解与 JSON 输出。复用 ARK_API_KEY，不需要 HypiHub。', '逐词时间来自最终实际配音的豆包识别结果，不用分句时间均分。'] };
  const sections = [video, voice, storage, production];
  return { sections, complete: sections.every(section => section.fields.every(field => field.present)) };
}

export function formatCloudStatus(status: ReturnType<typeof cloudConfigurationStatus>): string {
  return [
    '云服务配置检查（仅检查本机填写情况，不调用接口、不产生模型费用）',
    ...status.sections.flatMap(section => [
      `${section.label}：`,
      ...section.fields.map(field => `  ${field.name}：${field.present ? '已填写' : '待填写'}`),
      ...section.notes.map(note => `  ${note}`),
    ]),
    '火山接口已接入上传处理流程；此检查不代表真实调用或素材效果已验证。',
  ].join('\n');
}
