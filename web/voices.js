const $ = id => document.getElementById(id);
let profiles = [], selected = localStorage.getItem('aivideo-library-selection'), rendered = '', sourceId, localUrl;
let optionsVersion = '', creating = false, auditioning = false;
const stateNames = { queued: '排队中', testing: '注册试听中', preview: '可试听，尚未正式启用', activating: '正式启用中', ready: '已确定', failed: '处理失败', interrupted: '可继续本轮', expired: '试听可能已过期' };
async function api(path, options) {
  const response = await fetch(path, options), data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败'); return data;
}
function failure(error) { $('library-error').textContent = error.message; $('library-error').hidden = false; }
function route() {
  const voices = location.hash === '#voices';
  $('workspace').hidden = voices; $('voice-library-page').hidden = !voices;
  for (const link of document.querySelectorAll('.sidebar .nav')) link.classList.toggle('active', voices ? link.hash === '#voices' : link.hash === '#workspace');
}
window.addEventListener('hashchange', route); route();
function updateAuditionButton() {
  const profile = profiles.find(item => item.id === selected);
  $('audition-button').disabled = auditioning || !$('audition-consent').checked || !profile || profile.busy || !!profile.confirmedRound;
  $('audition-status').textContent = profile?.confirmedRound ? '此音色已经确定；视频任务直接选择即可，更换录音请建立新候选。' : profile?.busy ? '正在处理当前轮次，请稍候。' : '每轮都需确认上传。试听可能产生字符用量费，最终正式启用前不收槽位费。';
}
function option(value, text) { const node = document.createElement('option'); node.value = value; node.textContent = text; return node; }
function updateChoices() {
  const signature = JSON.stringify(profiles.map(item => [item.id, item.name, item.selectable, item.confirmedRound]));
  if (signature !== optionsVersion) {
    const previous = $('voice-profile').value || localStorage.getItem('aivideo-video-voice') || '';
    $('voice-profile').replaceChildren(option('', '选择已确定音色'), ...profiles.filter(item => item.selectable).map(item => option(item.id, item.name)));
    if (profiles.some(item => item.id === previous && item.selectable)) $('voice-profile').value = previous;
    $('library-profile').replaceChildren(option('', '选择候选音色'), ...profiles.map(item => option(item.id, `${item.name}${item.confirmedRound ? ' · 已确定' : ' · 待试听'}`)));
    optionsVersion = signature;
  }
  if (!profiles.some(item => item.id === selected)) selected = profiles[0]?.id;
  $('library-profile').value = selected || '';
  if (sourceId !== selected) {
    const audio = $('library-source-preview'); audio.pause(); audio.removeAttribute('src'); audio.hidden = !selected;
    if (selected) audio.src = `api/voices/${selected}/sample`; sourceId = selected;
  }
  $('voice-count').textContent = `${profiles.length} 个音色，${profiles.filter(item => item.selectable).length} 个可用于视频`;
  updateAuditionButton();
}
function paragraph(text, className) { const node = document.createElement('p'); node.textContent = text; if (className) node.className = className; return node; }
function render() {
  const profile = profiles.find(item => item.id === selected), signature = JSON.stringify(profile || null);
  if (rendered === signature) return; rendered = signature;
  const nodes = [];
  if (profile?.confirmedRound) {
    const banner = document.createElement('div'); banner.className = 'voice-usable';
    banner.append(paragraph(profile.selectable ? `“${profile.name}”已确定，后续视频直接选择，不再重新克隆。` : profile.issue || '此音色暂不可用，请检查账号配置。'));
    if (profile.selectable) {
      const link = document.createElement('a'); link.href = '#workspace'; link.textContent = '在视频任务中使用这个音色 ↗';
      link.addEventListener('click', () => { $('voice-profile').value = profile.id; localStorage.setItem('aivideo-video-voice', profile.id); $('clone-voice').checked = true; $('clone-voice').dispatchEvent(new Event('change')); });
      banner.append(link);
    }
    nodes.push(banner);
  }
  for (const [index, round] of (profile?.rounds || []).entries()) {
    const card = document.createElement('article'); card.className = 'voice-round-card';
    const title = document.createElement('h3'); title.textContent = `第 ${index + 1} 轮 · ${profile.name}`;
    card.append(title, paragraph(stateNames[round.state] || round.state, 'voice-state'), paragraph(round.text), paragraph(round.message));
    if (round.hasPreview) {
      const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'none'; audio.src = `api/voices/${profile.id}/rounds/${round.id}/preview`; audio.setAttribute('aria-label', `第 ${index + 1} 轮复刻试听`); card.append(audio);
    }
    if (['failed', 'interrupted', 'ready'].includes(round.state) && !profile.confirmedRound) {
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'secondary-button'; retry.textContent = '继续本轮（复用已有确认）'; retry.disabled = profile.busy;
      retry.addEventListener('click', async () => { retry.disabled = true; try { await api(`api/voices/${profile.id}/rounds/${round.id}/retry`, { method: 'POST' }); await refresh(); } catch (error) { failure(error); } }); card.append(retry);
    }
    if (round.state === 'preview' && round.hasPreview && !profile.confirmedRound) {
      const choose = document.createElement('button'); choose.type = 'button'; choose.className = 'secondary-button'; choose.textContent = profile.canConfirm ? '选择这一轮，核对正式使用费用' : '请先完成至少两轮有效试听'; choose.disabled = profile.busy || !profile.canConfirm;
      const box = document.createElement('div'); box.className = 'voice-confirmation'; box.hidden = true;
      box.append(paragraph(`即将正式启用“${profile.name}”的第 ${index + 1} 轮。只启用这一轮，其他轮次保留为试听记录。`), paragraph('首次正式合成可能触发整笔后付费音色槽位费，另有合成用量费；金额以豆包控制台为准。正式启用后不覆盖或重训这个音色。', 'voice-fee-note'));
      const label = document.createElement('label'); label.className = 'voice-consent-label'; const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
      const text = document.createElement('span'); text.textContent = `我已试听第 ${index + 1} 轮，同意正式启用并承担音色槽位及合成费用。`; label.append(checkbox, text);
      const confirm = document.createElement('button'); confirm.type = 'button'; confirm.textContent = '确认并正式启用'; confirm.disabled = true;
      checkbox.addEventListener('change', () => { confirm.disabled = !checkbox.checked; });
      confirm.addEventListener('click', async () => {
        if (!checkbox.checked) return; confirm.disabled = true; $('library-error').hidden = true;
        try { await api(`api/voices/${profile.id}/rounds/${round.id}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed: true, acceptFees: true, reviewId: round.reviewId }) }); await refresh(); }
        catch (error) { failure(error); confirm.disabled = !checkbox.checked; }
      });
      box.append(label, confirm); choose.addEventListener('click', () => { box.hidden = !box.hidden; }); card.append(choose, box);
    }
    nodes.push(card);
  }
  if (!(profile?.rounds.length)) nodes.push(paragraph(profile ? '录音已在本地保存。输入测试文本并确认上传，生成第一轮试听。' : '先保存一段录音，建立候选音色。', 'voice-round-empty'));
  $('voice-rounds').replaceChildren(...nodes);
}
async function refresh() {
  try { profiles = await api('api/voices'); updateChoices(); render(); }
  catch (error) { failure(error); }
}
$('library-sample').addEventListener('change', () => {
  if (localUrl) URL.revokeObjectURL(localUrl); const file = $('library-sample').files[0]; $('library-local-preview').hidden = !file;
  if (file) { localUrl = URL.createObjectURL(file); $('library-local-preview').src = localUrl; }
});
$('create-voice-form').addEventListener('submit', async event => {
  event.preventDefault(); if (creating) return; creating = true; $('library-error').hidden = true;
  const button = event.currentTarget.querySelector('button'); button.disabled = true;
  try { const profile = await api('api/voices', { method: 'POST', body: new FormData(event.currentTarget) }); selected = profile.id; localStorage.setItem('aivideo-library-selection', selected); $('audition-consent').checked = false; await refresh(); }
  catch (error) { failure(error); } finally { creating = false; button.disabled = false; }
});
$('library-profile').addEventListener('change', () => { selected = $('library-profile').value; localStorage.setItem('aivideo-library-selection', selected); $('audition-consent').checked = false; updateChoices(); render(); });
$('audition-consent').addEventListener('change', updateAuditionButton);
$('audition-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!selected || !$('audition-consent').checked || auditioning) return; auditioning = true; updateAuditionButton(); $('library-error').hidden = true;
  try { await api(`api/voices/${selected}/rounds`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: $('audition-text').value, confirmed: true }) }); $('audition-consent').checked = false; await refresh(); }
  catch (error) { failure(error); } finally { auditioning = false; updateAuditionButton(); }
});
$('voice-profile').addEventListener('change', () => localStorage.setItem('aivideo-video-voice', $('voice-profile').value));
await refresh(); setInterval(refresh, 3000);
