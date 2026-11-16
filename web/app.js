const $ = id => document.getElementById(id);
const stateNames = { queued: '排队中', analyzing: '分析中', needs_setup: '等待服务配置', transcribing: '台词识别中', cloning: '音色复刻中', awaiting_voice_upload: '等待确认上传音色', awaiting_voice_activation: '等待确认正式使用', voice: '配音合成中', generating: '画面生成中', complete: '已完成', failed: '处理失败', interrupted: '可继续处理' };
let selectedJob = localStorage.getItem('aivideo-job'), shownResult, previewUrl;
let currentReview, confirmingVoice = false;
const fileUrls = new Map();

function clearSelection() {
  selectedJob = null; localStorage.removeItem('aivideo-job'); currentReview = undefined;
  $('voice-confirmation').hidden = true; $('voice-confirm-checkbox').checked = false;
  $('confirmation-audio').pause();
}

function previewFile(name) {
  clearSelection();
  const file = $(name).files[0];
  if (fileUrls.has(name)) URL.revokeObjectURL(fileUrls.get(name));
  if (!file) return;
  const url = URL.createObjectURL(file); fileUrls.set(name, url);
  $(`${name}-name`).textContent = file.name;
  if (name === 'reference') {
    selectedJob = null; localStorage.removeItem('aivideo-job'); shownResult = null;
    $('video-preview').src = url; $('video-preview').hidden = false; $('empty-preview').hidden = true;
    $('preview-badge').textContent = '参考视频'; $('download-button').hidden = true; $('retry-button').hidden = true;
    $('job-message').textContent = '素材已选择，准备提交';
  }
  if (name === 'subject') { $('subject-preview').src = url; $('subject-preview').hidden = false; }
  if (name === 'voice') { $('voice-preview').src = url; $('voice-preview').hidden = false; }
}

for (const name of ['reference', 'subject']) {
  $(name).addEventListener('change', () => previewFile(name));
  const drop = document.querySelector(`[data-drop="${name}"]`);
  drop.addEventListener('dragover', event => { event.preventDefault(); drop.classList.add('dragging'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
  drop.addEventListener('drop', event => {
    event.preventDefault(); drop.classList.remove('dragging');
    if (event.dataTransfer.files.length) { const transfer = new DataTransfer(); transfer.items.add(event.dataTransfer.files[0]); $(name).files = transfer.files; previewFile(name); }
  });
}
document.querySelectorAll('input[name="mode"]').forEach(input => input.addEventListener('change', () => {
  clearSelection();
  const person = input.value === 'presenter';
  $('subject-label').textContent = person ? '你的模特照片' : '你的商品图片';
  if (!$('subject').files[0]) $('subject-name').textContent = person ? '上传清晰的模特正面照' : '上传完整、清晰的商品图片';
}));
$('clone-voice').addEventListener('change', () => {
  clearSelection();
  $('voice-section').hidden = !$('clone-voice').checked;
  $('voice-profile').required = $('clone-voice').checked;
  $('voice-profile').disabled = !$('clone-voice').checked;
  $('voice-mode').required = $('clone-voice').checked;
  $('voice-mode').disabled = !$('clone-voice').checked;
  soundHint();
});
function soundHint() {
  $('voice-hint').textContent = !$('clone-voice').checked ? '将保留参考视频原声。' : $('voice-mode').value === 'conversion'
    ? 'VC 直接转换原音频，以音色库保存的录音作为参考，不使用豆包闭源音色模型。语气、音高与音色相似度仍需实测；请优先使用清晰干声。'
    : $('voice-mode').value === 'synthesis' ? '自动识别原台词，用已确定音色重新配音，不重复克隆。语气会重新生成，原背景音乐未单独保留；正常合成用量仍计费。'
    : '请选择声音处理方式。豆包配音会重新生成语气；VC 尽量保留原表达，但需要另行部署服务并验收效果。';
}
$('voice-mode').addEventListener('change', soundHint);
soundHint();

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}

$('create-form').addEventListener('submit', async event => {
  event.preventDefault(); $('form-error').hidden = true; $('submit-button').disabled = true;
  $('submit-button').textContent = '正在上传素材…';
  try {
    const data = new FormData(event.currentTarget);
    data.set('cloneVoice', String($('clone-voice').checked));
    if (!$('clone-voice').checked) { data.delete('voiceProfileId'); data.delete('voiceMode'); }
    const job = await api('api/jobs', { method: 'POST', body: data });
    selectedJob = job.id; shownResult = null; localStorage.setItem('aivideo-job', job.id);
    showJob(job); await refresh();
  } catch (error) { $('form-error').textContent = error.message; $('form-error').hidden = false; }
  finally { $('submit-button').disabled = false; $('submit-button').textContent = '开始复刻 ↗'; }
});

function showJob(job) {
  if (job.id !== selectedJob) return;
  $('job-message').textContent = job.message;
  $('preview-badge').textContent = stateNames[job.state];
  $('job-details').hidden = !job.logs.length;
  $('job-logs').textContent = job.logs.join('\n');
  $('retry-button').hidden = !['needs_setup', 'failed', 'interrupted'].includes(job.state);
  $('download-button').hidden = job.state !== 'complete';
  const gallery = $('camera-gallery');
  gallery.hidden = !job.directedProduction || job.state !== 'complete';
  if (!gallery.hidden && gallery.dataset.job !== job.id) {
    gallery.querySelectorAll('img').forEach((image, i) => { image.src = `api/jobs/${job.id}/camera/${i + 1}`; });
    $('word-subtitles').href = `api/jobs/${job.id}/subtitles`;
    gallery.dataset.job = job.id;
  }
  showVoiceReview(job);
  const order = ['analyzing', 'voice', 'generating', 'complete'];
  const current = job.state === 'needs_setup' ? 1 : ['transcribing', 'cloning', 'awaiting_voice_upload', 'awaiting_voice_activation'].includes(job.state) ? 1 : order.indexOf(job.state);
  for (const item of document.querySelectorAll('[data-step]')) {
    const index = order.indexOf(item.dataset.step);
    item.classList.toggle('current', index === current && job.state !== 'complete' && job.state !== 'needs_setup');
    item.classList.toggle('done', job.state === 'complete' || (current >= 0 && index < current));
  }
  if (job.state === 'complete') {
    $('download-button').href = `api/jobs/${job.id}/result?download=1`;
    if (shownResult !== job.id) { $('video-preview').src = `api/jobs/${job.id}/result`; shownResult = job.id; }
  } else if (previewUrl !== job.id) { $('video-preview').src = `api/jobs/${job.id}/reference`; previewUrl = job.id; shownResult = null; }
  $('video-preview').hidden = false; $('empty-preview').hidden = true;
}

function showVoiceReview(job) {
  const review = job.voiceReview;
  $('voice-confirmation').hidden = !review;
  if (!review) { currentReview = undefined; return; }
  const registration = review.stage === 'register';
  if (currentReview?.id !== review.id || currentReview?.job !== job.id) {
    $('voice-confirm-checkbox').checked = false;
    const audio = $('confirmation-audio');
    audio.pause(); audio.removeAttribute('src');
    const available = registration ? review.hasSample : review.hasPreview;
    audio.hidden = !available;
    if (available) audio.src = `api/jobs/${job.id}/${registration ? 'voice-sample' : 'voice-preview'}`;
  }
  currentReview = { ...review, job: job.id };
  $('voice-confirm-title').textContent = registration ? '确认上传目标录音' : '试听后，确认正式使用';
  $('voice-confirm-description').textContent = registration
    ? '这里播放的是你上传的原始录音。确认后才会上传至豆包并注册试听音色，暂不调用正式配音。'
    : review.hasPreview ? '这里播放的是豆包返回的复刻试听。确认后将用这个音色合成原视频台词。' : '暂未取得豆包试听文件。可先到豆包控制台试听，再确认使用；这里不会用正式合成接口生成试听。';
  $('voice-confirm-label').textContent = registration ? '我同意将这段录音上传至豆包，注册试听音色。' : '我已核对音色，同意正式使用，并接受首次合成可能产生的音色槽位费及合成用量费。';
  $('voice-confirm-button').textContent = registration ? '确认上传，生成试听' : '确认正式使用并继续';
  $('voice-confirm-button').disabled = !$('voice-confirm-checkbox').checked || confirmingVoice;
}

$('voice-confirm-checkbox').addEventListener('change', () => {
  $('voice-confirm-button').disabled = !$('voice-confirm-checkbox').checked || confirmingVoice;
});
$('voice-confirm-button').addEventListener('click', async () => {
  if (!currentReview || !$('voice-confirm-checkbox').checked || confirmingVoice) return;
  const review = { ...currentReview }; confirmingVoice = true; $('voice-confirm-button').disabled = true;
  try {
    await api(`api/jobs/${review.job}/voice-confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage: review.stage, reviewId: review.id, confirmed: true }) });
    await refresh();
  } catch (error) { $('job-message').textContent = error.message; }
  finally { confirmingVoice = false; $('voice-confirm-button').disabled = !$('voice-confirm-checkbox').checked; }
});

$('retry-button').addEventListener('click', async () => {
  if (!selectedJob) return;
  $('retry-button').disabled = true;
  try { await api(`api/jobs/${selectedJob}/retry`, { method: 'POST' }); await refresh(); }
  catch (error) { $('job-message').textContent = error.message; }
  finally { $('retry-button').disabled = false; }
});

async function refresh() {
  try {
    const jobs = await api('api/jobs');
    $('job-count').textContent = `${jobs.length} 个任务`;
    if (jobs.length) {
      $('history-list').replaceChildren(...jobs.map(job => {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'job-row';
        const icon = document.createElement('span'); icon.className = 'job-type'; icon.textContent = job.mode === 'presenter' ? '◉' : '◇';
        const info = document.createElement('span'); info.className = 'job-info'; info.textContent = `${job.mode === 'presenter' ? '人物' : '商品'}替换${job.hasVoice ? ` · ${job.voiceName || '声音替换'}` : ''}`;
        const date = document.createElement('small'); date.textContent = new Date(job.created).toLocaleString('zh-CN'); info.append(date);
        const status = document.createElement('span'); status.className = 'job-state'; status.textContent = stateNames[job.state];
        button.append(icon, info, status);
        button.addEventListener('click', async () => { selectedJob = job.id; localStorage.setItem('aivideo-job', job.id); await refresh(); $('preview-title').scrollIntoView({ block: 'nearest' }); });
        return button;
      }));
    }
    const job = jobs.find(job => job.id === selectedJob);
    if (job) showJob(['awaiting_voice_upload', 'awaiting_voice_activation'].includes(job.state) ? await api(`api/jobs/${job.id}`) : job);
    else if (selectedJob) { selectedJob = null; localStorage.removeItem('aivideo-job'); }
  } catch (error) { $('system-status').textContent = '无法连接本地服务，请检查服务是否运行'; }
}
try {
  const status = await api('api/status');
  $('conversion-option').disabled = !status.voiceConversion;
  if (status.voiceConversion) $('conversion-option').textContent = '音色转换 VC：尽量保留原表达，效果仍需验收';
  $('system-status').textContent = status.directedProduction && !status.productionConfigured ? '三机位流程 · 图片与导演服务待配置' : status.presenter && status.product && status.voice ? '替换服务已配置 · 尚未验证模型' : '可分析视频 · 替换服务待配置';
} catch (error) { $('system-status').textContent = '服务配置需要检查'; }
await refresh();
setInterval(refresh, 3000);
await import('./voices.js');
