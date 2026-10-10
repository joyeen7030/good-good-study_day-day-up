const API = '';
let state;
let toastTimer;
let timerInterval;
let aiConfig = null;
let chatMessages = [];
let promptedReminderAt = '';
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const QUADS = { q1: '重要 · 紧急', q2: '重要 · 不紧急', q3: '不重要 · 紧急', q4: '不重要 · 不紧急' };
const uid = () => crypto.randomUUID();
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const localDateKey = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const localInput = date => { const d = new Date(date); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
async function save() { await api('/api/state', { method: 'POST', body: JSON.stringify(state) }); render(); }
function toast(message) { const node = $('#toast'); node.textContent = message; node.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove('show'), 2900); }
function openModal({ title, subtitle = '', body, confirm = '保存', onConfirm, cancel = '取消', wide = false }) {
  const root = $('#modalRoot');
  root.innerHTML = `<div class="modal-backdrop"><section class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true"><header class="modal-header"><div><div class="eyebrow">事项设置</div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(subtitle)}</p></div><button class="modal-close" aria-label="关闭">×</button></header><div class="modal-body">${body}</div><footer class="modal-footer"><button class="button-secondary modal-cancel">${escapeHtml(cancel)}</button><button class="button-primary modal-confirm">${escapeHtml(confirm)}</button></footer></section></div>`;
  const close = () => { root.innerHTML = ''; delete root.dataset.open; };
  $('.modal-close', root).onclick = close;
  $('.modal-cancel', root).onclick = close;
  $('.modal-backdrop', root).addEventListener('click', event => { if (event.target.classList.contains('modal-backdrop')) close(); });
  $('.modal-confirm', root).onclick = async () => { try { await onConfirm(close); } catch (error) { toast(error.message); } };
  root.dataset.open = 'true';
}
function parseNaturalTask(text) {
  let due = null;
  const now = new Date();
  const setEnd = days => { const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 18, 0, 0); return d; };
  if (/今天|今晚/.test(text)) due = setEnd(0);
  else if (/明天/.test(text)) due = setEnd(1);
  else if (/后天/.test(text)) due = setEnd(2);
  else {
    const week = text.match(/周([一二三四五六日天])(?:之前|前|截止)?/);
    if (week) {
      const map = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };
      let days = (map[week[1]] - now.getDay() + 7) % 7;
      if (days === 0) days = 7;
      due = setEnd(days);
    }
  }
  const duration = text.match(/(\d+(?:\.\d+)?)\s*(分钟|分|小时|个小时|h|hr)/i);
  let minutes = null;
  if (duration) minutes = /小时|个小时|h|hr/i.test(duration[2]) ? Number(duration[1]) * 60 : Number(duration[1]);
  return { dueAt: due?.toISOString() || null, estimatedMinutes: minutes ? Math.round(minutes) : null };
}
function detectTaskType(text) {
  if (/刷题|做题|解题|算法题|练习题|题目/.test(text)) return '刷题';
  if (/论文|报告|写作|文章|文稿|文案/.test(text)) return '写作';
  if (/复习|阅读|学习|背诵|课程|看书/.test(text)) return '学习';
  if (/报销|预约|邮件|缴费|提交|整理材料/.test(text)) return '行政事务';
  if (/设计|绘制|剪辑|创作|制作/.test(text)) return '创作';
  return '';
}
function taskWizard(text = '', existing = null, onSaved = null) {
  const extracted = parseNaturalTask(text);
  const detectedType = existing?.taskType || detectTaskType(text);
  const suggestedDue = existing?.dueAt || extracted.dueAt;
  const suggestedUrgent = suggestedDue && (Date.parse(suggestedDue) - Date.now()) < 48 * 60 * 60_000;
  const suggestedQuadrant = existing?.quadrant || (suggestedUrgent ? 'q1' : 'q2');
  const initialTitle = existing?.title || text;
  const projectOptions = state.projects.map(project => `<option value="${escapeHtml(project.id)}" ${existing?.projectId === project.id ? 'selected' : ''}>${escapeHtml(project.title)}</option>`).join('');
  const body = `<div class="modal-field"><label>任务</label><input id="taskTitle" value="${escapeHtml(initialTitle)}" placeholder="用一句话描述要完成的事"></div>
    <div class="field-grid"><div class="modal-field"><label>截止时间</label><input id="taskDue" type="datetime-local" value="${suggestedDue ? localInput(suggestedDue) : ''}"></div><div class="modal-field"><label>预计用时（分钟）</label><input id="taskEstimate" type="number" min="1" value="${existing?.estimatedMinutes ?? extracted.estimatedMinutes ?? ''}" placeholder="例如 45"></div></div>
    <div class="modal-field"><label>AI 优先级建议 · 请确认</label><div class="quadrant-choice">${Object.entries(QUADS).map(([key, label]) => `<button type="button" data-quadrant="${key}" class="${suggestedQuadrant === key ? 'selected' : ''}">${label}</button>`).join('')}</div><div class="suggestion-note">${suggestedUrgent ? '因截止时间较近，建议列为紧急；请确认是否重要。' : '未识别到近期截止时间，暂建议重要但不紧急；请按影响和后果确认。'}</div></div>
    <div class="field-grid"><div class="modal-field"><label>任务类型 · 请确认</label><select id="taskType"><option value="" ${!detectedType ? 'selected' : ''}>待确认</option>${['刷题','写作','学习','行政事务','创作','其他'].map(item => `<option ${detectedType === item ? 'selected' : ''}>${item}</option>`).join('')}</select></div><div class="modal-field"><label>关联长期项目</label><select id="taskProject"><option value="">不关联</option>${projectOptions}</select></div></div>
    <div class="field-grid"><div class="modal-field"><label>检查提醒间隔（分钟）</label><input id="taskInterval" type="number" min="1" value="${existing?.intervalMinutes || 25}"></div><div class="modal-field"><label>阶段目标（每行一项）</label><textarea id="taskMilestones" rows="2" placeholder="先写出问题条件\n完成第一版草稿">${escapeHtml((existing?.milestones || []).join('\n'))}</textarea></div></div>`;
  openModal({ title: existing ? '调整任务计划' : '确认任务计划', subtitle: '信息不完整的字段请补充；保存后任务才会进入你的计划。', body, confirm: existing ? '保存修改' : '确认加入', onConfirm: async close => {
    const title = $('#taskTitle')?.value.trim();
    if (!title) throw new Error('先写下任务内容。');
    const selected = $('.quadrant-choice button.selected');
    if (!selected) throw new Error('请确认一个优先级象限。');
    const dueValue = $('#taskDue').value;
    const task = { ...(existing || {}), id: existing?.id || uid(), title, dueAt: dueValue ? new Date(dueValue).toISOString() : null, estimatedMinutes: Number($('#taskEstimate').value) || null, quadrant: selected.dataset.quadrant, taskType: $('#taskType').value || null, projectId: $('#taskProject').value || null, intervalMinutes: Math.max(1, Number($('#taskInterval').value) || 25), milestones: $('#taskMilestones').value.split('\n').map(item => item.trim()).filter(Boolean), status: existing?.status || 'planned', createdAt: existing?.createdAt || new Date().toISOString(), source: existing?.source || 'manual' };
    if (existing) state.dailyTasks = state.dailyTasks.map(item => item.id === existing.id ? task : item); else state.dailyTasks.push(task);
    await save(); close(); toast(existing ? '任务已更新' : '已加入今日计划'); onSaved?.(task);
  }});
  $$('.quadrant-choice button').forEach(button => button.onclick = () => { $$('.quadrant-choice button').forEach(item => item.classList.remove('selected')); button.classList.add('selected'); });
}
function projectWizard(existing = null) {
  openModal({ title: existing ? '编辑长期项目' : '创建长期项目', subtitle: '项目会持续保留；每天的行动按日复盘。', body: `<div class="modal-field"><label>项目名称</label><input id="projectTitle" value="${escapeHtml(existing?.title || '')}" placeholder="例如：毕业论文"></div><div class="modal-field"><label>目标描述</label><textarea id="projectDescription" placeholder="你希望最终完成什么？">${escapeHtml(existing?.description || '')}</textarea></div><div class="field-grid"><div class="modal-field"><label>目标截止时间</label><input id="projectDue" type="date" value="${escapeHtml(existing?.dueAt || '')}"></div><div class="modal-field"><label>当前进度估计 (%)</label><input id="projectProgress" type="number" min="0" max="100" value="${existing?.estimatedProgress ?? 0}"></div></div>`, confirm: existing ? '保存修改' : '创建项目', onConfirm: async close => {
    const title = $('#projectTitle').value.trim(); if (!title) throw new Error('请填写项目名称。');
    const project = { ...(existing || {}), id: existing?.id || uid(), title, description: $('#projectDescription').value.trim(), dueAt: $('#projectDue').value || null, estimatedProgress: Math.min(100, Math.max(0, Number($('#projectProgress').value) || 0)), createdAt: existing?.createdAt || new Date().toISOString() };
    if (existing) state.projects = state.projects.map(item => item.id === existing.id ? project : item); else state.projects.push(project);
    await save(); close(); toast(existing ? '项目已更新' : '长期项目已创建'); if (existing) renderProjectDetail();
  }});
}
function importWizard(source) {
  const label = source === 'brief' ? '每日简报' : '日历内容';
  openModal({ title: `粘贴${label}`, subtitle: '每行一项。导入后逐项确认任务详情和优先级。', body: `<div class="modal-field"><label>内容</label><textarea id="importText" placeholder="粘贴${label}文字；标题、截止时间和预计用时可写在同一行。"></textarea></div><div class="source-preview" id="sourcePreview"></div>`, confirm: '解析并确认任务', onConfirm: async close => {
    const lines = $('#importText').value.split('\n').map(line => line.replace(/^\s*[-*•\d.)、]+\s*/, '').trim()).filter(Boolean);
    if (!lines.length) throw new Error('粘贴至少一条任务或事件。');
    close();
    let index = 0;
    const addNext = () => { if (index >= lines.length) { toast(`已整理 ${lines.length} 项`); render(); return; } const line = lines[index++]; taskWizard(line, null, addNext); };
    addNext();
  }, wide: true });
}
function reviewWizard() {
  const tasks = [...state.dailyTasks];
  if (!tasks.length) return;
  const body = `<p class="review-intro" style="font-size:10px;color:#858f87;margin:0 0 7px;line-height:1.6">先快速确认昨天的行动进度，再归档并开始新一天。未选择的项目会按“没开始”处理。</p>${tasks.map(task => `<div class="review-row" data-review-task="${escapeHtml(task.id)}"><strong>${escapeHtml(task.title)}</strong><div class="review-options">${[['complete','完成'],['partial','部分完成'],['not-started','没开始']].map(([key,label]) => `<button type="button" data-status="${key}" class="${task.status === key ? 'selected' : ''}">${label}</button>`).join('')}</div></div>`).join('')}`;
  openModal({ title: '昨天的任务进度', subtitle: `${state.activeDate} · 简短复盘`, body, confirm: '生成回顾并归档', cancel: '稍后再说', wide: true, onConfirm: async close => {
    const statuses = {};
    $$('.review-row').forEach(row => { statuses[row.dataset.reviewTask] = row.querySelector('.selected')?.dataset.status || 'not-started'; });
    const button = $('.modal-confirm'); button.disabled = true; button.textContent = '正在生成复盘…';
    let result;
    try { result = await api('/api/review', { method: 'POST', body: JSON.stringify({ statuses }) }); }
    catch (error) { button.disabled = false; button.textContent = '生成回顾并归档'; throw error; }
    state = result.state; close(); render();
    if (result.analysis) {
      openModal({ title: '复盘完成', subtitle: 'AI 习惯观察 · 简短结论已保存在复盘记录', body: `<section class="review-insight review-result"><p><b>模式</b>${escapeHtml(result.analysis.pattern)}</p><p><b>依据</b>${escapeHtml(result.analysis.evidence)}</p><p><b>明天试试</b>${escapeHtml(result.analysis.experiment)}</p><button type="button" class="text-button" id="reviewResultArchive">查看复盘记录 →</button></section>`, confirm: '回到今日', cancel: '关闭', onConfirm: close => close() });
      $('#reviewResultArchive').onclick = () => { close(); goView('archive'); };
    } else toast(result.analysisMessage || result.recap);
  }});
  $$('.review-options button').forEach(button => button.onclick = () => { const parent = button.closest('.review-options'); parent.querySelectorAll('button').forEach(item => item.classList.remove('selected')); button.classList.add('selected'); });
}
function kickoffWizard(task) {
  openModal({ title: '开始陪跑', subtitle: '先对齐这段专注时间的边界。提醒间隔沿用任务设置。', body: `<div class="suggestion-note">任务类型：${escapeHtml(task.taskType || '待确认')} · 阶段目标：${escapeHtml(task.milestones?.length ? task.milestones.join('、') : '未设置')}</div><div class="field-grid"><div class="modal-field"><label>本次预计专注（分钟）</label><input id="focusEstimate" type="number" min="1" value="${task.estimatedMinutes || 25}"></div><div class="modal-field"><label>提醒间隔（分钟）</label><input id="focusInterval" type="number" min="1" value="${task.intervalMinutes || 25}"></div></div><div class="modal-field"><label>现在的第一步</label><input id="firstStep" placeholder="例如：打开题目，先写已知条件"></div>`, confirm: '开始计时', onConfirm: async close => {
    const expectedMinutes = Number($('#focusEstimate').value) || 25; const intervalMinutes = Number($('#focusInterval').value) || 25;
    task.estimatedMinutes = expectedMinutes; task.intervalMinutes = intervalMinutes;
    const firstStep = $('#firstStep').value.trim(); if (firstStep) task.milestones = [firstStep, ...(task.milestones || [])];
    await save(); await api('/api/focus/start', { method: 'POST', body: JSON.stringify({ taskId: task.id, expectedMinutes, intervalMinutes }) }); state = await api('/api/state'); close(); render(); toast('计时开始。先完成第一步。');
  }});
}
function focusRecoveryWizard() {
  if (!state?.focusRecoveryRequired || !state.focus) return;
  const task = state.dailyTasks.find(item => item.id === state.focus.taskId);
  if (!task) return;
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const lastProgress = [...(state.progressLogs || [])].reverse().find(entry => entry.taskId === task.id && Date.parse(entry.createdAt) >= Date.parse(state.focus.startedAt) && Date.parse(entry.createdAt) < todayStart.getTime());
  const lastRecordedAt = new Date(lastProgress?.createdAt || state.focus.startedAt);
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayValue = `${localDateKey(yesterday)}T23:59`;
  openModal({ title: '计时跨过了午夜', subtitle: `${task.title} · 开始于 ${new Date(state.focus.startedAt).toLocaleString('zh-CN')}`, confirm: '确认处理', cancel: '稍后处理', body: `<p class="recovery-intro">你昨天没有结束陪跑。计时已暂停结算，系统不会默认你一直做到今天。选一个符合实际的处理方式：</p><div class="recovery-options"><label><input type="radio" name="focusRecovery" value="last-recorded" checked><span><strong>结束在昨天最后一次有记录的时间</strong><small>${lastRecordedAt.toLocaleString('zh-CN')}</small></span></label><label><input type="radio" name="focusRecovery" value="custom"><span><strong>手动指定昨天的结束时间</strong><input id="recoveryEndedAt" type="datetime-local" value="${yesterdayValue}" max="${yesterdayValue}"></span></label><label><input type="radio" name="focusRecovery" value="continue"><span><strong>确认我今天也确实在做，继续计时</strong><small>计时会继续；下次跨日时仍会再次确认。</small></span></label></div>`, onConfirm: async close => {
    const choice = $('input[name="focusRecovery"]:checked')?.value;
    let endedAt;
    if (choice === 'custom') {
      const value = $('#recoveryEndedAt').value;
      if (!value) throw new Error('请选择昨天的结束时间。');
      endedAt = new Date(value).toISOString();
    }
    const result = await api('/api/focus/recover', { method: 'POST', body: JSON.stringify({ choice, endedAt }) });
    state = result.state; promptedReminderAt = ''; close(); render();
    if (state.reviewRequired) reviewWizard();
    else toast(choice === 'continue' ? '计时继续。到点会在 Mac 桌面提醒你汇报。' : '已按你选的时间结算昨天的计时。');
  }});
}
function progressWizard(taskId, reminder = false) {
  const task = state.dailyTasks.find(item => item.id === taskId);
  if (!task) return;
  openModal({ title: reminder ? '该记录一下进度了' : '记录进度', subtitle: task.title, confirm: '保存记录', body: `<div class="modal-field"><label for="progressNote">这段时间做了什么，或卡在哪里？</label><textarea id="progressNote" rows="4" maxlength="500" placeholder="写下已经完成的部分、遇到的卡点或接下来的第一步"></textarea></div>`, onConfirm: async close => {
    const message = $('#progressNote').value.trim();
    if (!message) throw new Error('请先写下进展或卡点。');
    await api('/api/progress/log', { method: 'POST', body: JSON.stringify({ taskId, message }) });
    state = await api('/api/state'); promptedReminderAt = '';
    close(); render(); toast('进度已保存到工作台');
  }});
}
async function pauseFocus(paused) { await api('/api/focus/pause', { method: 'POST', body: JSON.stringify({ paused }) }); state = await api('/api/state'); render(); toast(paused ? '已暂停提醒' : '已继续计时'); }
async function stopFocus(complete) { const result = await api('/api/focus/stop', { method: 'POST', body: JSON.stringify({ complete }) }); state = await api('/api/state'); render(); if (state.reviewRequired) { reviewWizard(); return; } if (!complete) toast('已结束当前陪跑'); else if (result.calendar?.ok) toast(`已完成，并已记入${result.calendar.calendarTitle || '默认日历'}`); else if (result.calendar) toast(`任务已完成，但日历记录失败：${result.calendar.error || '请检查日历权限'}`); else toast('任务已完成'); }
function formatDue(value) { if (!value) return '未设截止时间'; const date = new Date(value); return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`; }
function statusLabel(status) { return ({ planned: '待开始', 'in-progress': '进行中', complete: '已完成', partial: '部分完成', 'not-started': '未开始' })[status] || '待开始'; }
function formatDuration(seconds = 0) { const minutes = Math.floor(Number(seconds) / 60); const hours = Math.floor(minutes / 60); const rest = minutes % 60; return hours ? `${hours} 小时${rest ? ` ${rest} 分钟` : ''}` : `${rest} 分钟`; }
function projectCountdown(dueAt) {
  if (!dueAt) return { label: '未设置截止日期', overdue: false };
  const [year, month, day] = dueAt.slice(0, 10).split('-').map(Number);
  const today = new Date();
  const delta = Math.round((Date.UTC(year, month - 1, day) - Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
  return delta === 0 ? { label: '今天截止', overdue: false, today: true } : delta > 0 ? { label: `倒数 ${delta} 天`, overdue: false } : { label: `已逾期 ${Math.abs(delta)} 天`, overdue: true };
}
function openProject(projectId) { state.selectedProjectId = projectId; renderProjectDetail(); goView('project-detail'); }
function renderProjectDetail() {
  const project = state.projects.find(item => item.id === state.selectedProjectId); const root = $('#projectDetail');
  if (!project || !root) return;
  const logs = state.projectLogs.filter(item => item.projectId === project.id).sort((a, b) => b.date.localeCompare(a.date));
  const total = logs.reduce((sum, item) => sum + Number(item.durationSeconds || 0), 0); const countdown = projectCountdown(project.dueAt);
  root.innerHTML = `<div class="project-detail-head"><div><div class="eyebrow">长期项目</div><h1>${escapeHtml(project.title)}</h1><p>${escapeHtml(project.description || '为这个项目补充一句目标描述。')}</p></div><button class="button-secondary" id="editProjectButton">编辑项目</button></div>
    <div class="project-detail-stats"><div class="project-countdown ${countdown.overdue ? 'overdue' : ''} ${countdown.today ? 'due-today' : ''}"><span>截止日期</span><strong>${escapeHtml(countdown.label)}</strong>${project.dueAt ? `<small>${escapeHtml(project.dueAt)}</small>` : ''}</div><div class="project-total-time"><span>累计投入</span><strong>${escapeHtml(formatDuration(total))}</strong><small>${logs.length} 个记录日 · 进度估计 ${project.estimatedProgress ?? 0}%</small></div></div>
    <div class="section-heading project-log-heading"><div><div class="eyebrow">项目记录</div><h2>每日投入</h2></div><button class="button-primary" id="addProjectLog">＋ 补记投入</button></div>
    ${logs.length ? `<div class="project-log-list">${logs.map(log => `<article class="project-log-row"><time>${escapeHtml(log.date.slice(5).replace('-', '月') + '日')}</time><strong>${escapeHtml(log.title || (log.titles || []).join('、'))}</strong><span>${escapeHtml(formatDuration(log.durationSeconds))}</span><button class="text-button" data-edit-log="${escapeHtml(log.id)}">改标题</button></article>`).join('')}</div>` : '<div class="empty-state slim"><h3>还没有投入记录</h3><p>结束关联这个项目的陪跑计时后会自动记录，也可以手动补记。</p></div>'}`;
  $('#editProjectButton').onclick = () => projectWizard(project);
  $('#addProjectLog').onclick = () => projectLogWizard(project);
  $$('[data-edit-log]').forEach(button => button.onclick = () => { const log = state.projectLogs.find(item => item.id === button.dataset.editLog); if (!log) return; openModal({ title: '修改记录标题', subtitle: `${log.date} · ${formatDuration(log.durationSeconds)}`, body: `<div class="modal-field"><label>记录标题</label><input id="projectLogTitle" value="${escapeHtml(log.title)}"></div>`, onConfirm: async close => { const result = await api('/api/project-log/title', { method: 'POST', body: JSON.stringify({ logId: log.id, title: $('#projectLogTitle').value.trim() }) }); state = result.state; close(); renderProjectDetail(); toast('记录标题已更新'); } }); });
}
function projectLogWizard(project) {
  const today = localDateKey(); const taskTitles = [...new Set(state.dailyTasks.filter(task => task.projectId === project.id).map(task => task.title))];
  openModal({ title: '补记项目投入', subtitle: '同一项目、同一天的投入会自动合并。', body: `<div class="field-grid"><div class="modal-field"><label>日期</label><input id="logDate" type="date" value="${today}" max="${today}"></div><div class="modal-field"><label>用时（分钟）</label><input id="logMinutes" type="number" min="0.1" step="0.1" placeholder="例如 45"></div></div><div class="modal-field"><label>记录标题</label><input id="logTitle" value="${escapeHtml(taskTitles.join('、'))}" placeholder="例如：修改论文第二章"></div>`, confirm: '保存投入', onConfirm: async close => { const result = await api('/api/project-log/manual', { method: 'POST', body: JSON.stringify({ projectId: project.id, date: $('#logDate').value, title: $('#logTitle').value.trim(), durationMinutes: Number($('#logMinutes').value) }) }); state = result.state; close(); renderProjectDetail(); render(); toast('投入记录已合并保存'); } });
}
async function refreshAiConfig() {
  try { aiConfig = await api('/api/ai/config'); }
  catch { aiConfig = { providers: {}, activeProvider: null }; }
  const active = aiConfig.activeProvider ? aiConfig.providers?.[aiConfig.activeProvider] : null;
  const badge = $('.provider-badge'); if (badge) badge.textContent = active ? active.name : 'AI 待配置';
  const input = $('#chatInput'); const send = $('#sendChat');
  if (input && send) { input.disabled = !active; send.disabled = !active; input.placeholder = active ? '说说你现在卡在哪里…' : '先在右上角设置里配置 AI 服务'; }
}
async function openAiSettings() {
  aiConfig = await api('/api/ai/config');
  const cards = Object.entries(aiConfig.providers).map(([id, item]) => `<article class="ai-provider-row"><div><strong>${escapeHtml(item.name)}</strong><small>${item.configured ? `已配置 · ${escapeHtml(item.model)}` : '尚未配置'}</small></div><div class="ai-provider-actions">${item.configured ? `<button class="button-secondary" data-ai-active="${id}">${aiConfig.activeProvider === id ? '正在使用' : '切换使用'}</button>` : ''}<button class="button-secondary" data-ai-configure="${id}">${item.configured ? '替换密钥' : '配置'}</button>${item.configured ? `<button class="text-button ai-delete" data-ai-delete="${id}">删除</button>` : ''}</div></article>`).join('');
  openModal({ title: 'AI 服务配置', subtitle: '密钥保存在当前 Mac 用户的钥匙串中，不会写入任务文件。', body: `<div class="ai-provider-list">${cards}</div><p class="ai-privacy-note">陪跑聊天会发送当前任务摘要和对话内容；生成复盘分析时，会发送近 14 天的进度记录、复盘状态和未完成长期项目给所选服务商。复盘只保存三条简短结论，不保存详细分析。不同 Mac 用户各自使用自己的钥匙串配置。</p>`, confirm: '完成', onConfirm: close => close() });
  $$('[data-ai-configure]').forEach(button => button.onclick = () => configureAiProvider(button.dataset.aiConfigure));
  $$('[data-ai-active]').forEach(button => button.onclick = async () => { try { await api('/api/ai/active', { method: 'POST', body: JSON.stringify({ provider: button.dataset.aiActive }) }); await refreshAiConfig(); openAiSettings(); } catch (error) { toast(error.message); } });
  $$('[data-ai-delete]').forEach(button => button.onclick = async () => { if (!confirm(`删除 ${aiConfig.providers[button.dataset.aiDelete].name} 的密钥？`)) return; try { await api(`/api/ai/provider/${button.dataset.aiDelete}`, { method: 'DELETE' }); await refreshAiConfig(); openAiSettings(); toast('密钥已从当前用户钥匙串删除'); } catch (error) { toast(error.message); } });
}
function configureAiProvider(provider) {
  const existing = aiConfig.providers[provider]; let verifiedModels = []; let verifiedKey = '';
  openModal({ title: `${existing.configured ? '替换' : '配置'} ${existing.name} 密钥`, subtitle: '粘贴 API 密钥后先验证，再保存到当前 Mac 用户的钥匙串。', body: `<div class="modal-field"><label>API 密钥</label><input id="aiApiKey" type="password" autocomplete="new-password" placeholder="${existing.configured ? '输入新密钥以替换现有密钥' : '粘贴 API 密钥'}"></div><div class="ai-test-row"><button type="button" class="button-secondary" id="aiTestKey">验证密钥并读取模型</button><span id="aiTestStatus">验证通过后才能保存。</span></div><div class="modal-field"><label>使用模型</label><select id="aiModel" disabled><option value="">先验证 API 密钥</option></select></div>`, confirm: '保存密钥', onConfirm: async close => {
    const key = $('#aiApiKey').value.trim(); const model = $('#aiModel').value;
    if (!verifiedModels.length || !key || key !== verifiedKey || !model) throw new Error('请先验证当前密钥并选择模型。');
    await api('/api/ai/provider', { method: 'POST', body: JSON.stringify({ provider, apiKey: key, model }) });
    close(); await refreshAiConfig(); toast(`${existing.name} 已保存，可在设置中切换使用。`); openAiSettings();
  }});
  $('.modal-confirm').disabled = true;
  $('#aiApiKey').addEventListener('input', () => { verifiedKey = ''; verifiedModels = []; $('#aiModel').innerHTML = '<option value="">密钥已更改，请重新验证</option>'; $('#aiModel').disabled = true; $('#aiTestStatus').textContent = '密钥已更改，请重新验证。'; $('#aiTestStatus').classList.remove('success'); $('.modal-confirm').disabled = true; });
  $('#aiTestKey').onclick = async () => {
    const key = $('#aiApiKey').value.trim(); if (!key) return toast('先粘贴 API 密钥。');
    const status = $('#aiTestStatus'); const button = $('#aiTestKey'); button.disabled = true; status.textContent = '正在连接服务商…'; $('.modal-confirm').disabled = true;
    try {
      const result = await api('/api/ai/test', { method: 'POST', body: JSON.stringify({ provider, apiKey: key }) });
      verifiedModels = result.models; verifiedKey = key; const select = $('#aiModel'); select.innerHTML = verifiedModels.map(model => `<option value="${escapeHtml(model)}" ${model === result.defaultModel || model === existing.model ? 'selected' : ''}>${escapeHtml(model)}</option>`).join(''); select.disabled = false;
      status.textContent = `验证成功，读取到 ${verifiedModels.length} 个模型。`; status.classList.add('success'); $('.modal-confirm').disabled = false;
    } catch (error) { verifiedModels = []; status.textContent = error.message; status.classList.remove('success'); }
    finally { button.disabled = false; }
  };
}
function appendChatMessage(role, content) {
  const transcript = $('#chatTranscript'); const item = document.createElement('div'); item.className = `chat-message ${role}`;
  item.innerHTML = `<span class="message-mark">${role === 'assistant' ? '✳' : '你'}</span><div class="message-content"><p></p></div><time>刚刚</time>`;
  item.querySelector('p').textContent = content; transcript.append(item); transcript.scrollTop = transcript.scrollHeight;
}
async function sendChatMessage() {
  const input = $('#chatInput'); const text = input.value.trim(); if (!text || !aiConfig?.activeProvider) return;
  input.value = ''; chatMessages.push({ role: 'user', content: text }); appendChatMessage('user', text); $('#sendChat').disabled = true;
  try { const result = await api('/api/chat', { method: 'POST', body: JSON.stringify({ messages: chatMessages }) }); chatMessages.push({ role: 'assistant', content: result.reply }); appendChatMessage('assistant', result.reply); }
  catch (error) { appendChatMessage('assistant', `这次没连上：${error.message}`); chatMessages.pop(); }
  finally { $('#sendChat').disabled = false; input.focus(); }
}
function sortedTasks(tasks) { const ranks = { q1: 0, q2: 1, q3: 2, q4: 3 }; return [...tasks].sort((a,b) => Number(a.status === 'complete') - Number(b.status === 'complete') || (ranks[a.quadrant] ?? 4) - (ranks[b.quadrant] ?? 4) || (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity) || Number(b.important) - Number(a.important) || (a.estimatedMinutes || Infinity) - (b.estimatedMinutes || Infinity)); }
function makeTaskCard(task) {
  const done = task.status === 'complete';
  return `<article class="task-card ${done ? 'completed' : ''}" data-task-card="${escapeHtml(task.id)}"><button class="task-check" data-complete="${escapeHtml(task.id)}" title="标记完成">✓</button><div><div class="task-title">${escapeHtml(task.title)}</div><div class="task-meta"><span class="priority-tag ${task.quadrant}">${escapeHtml(QUADS[task.quadrant] || '待确认优先级')}</span><span>◷ ${escapeHtml(formatDue(task.dueAt))}</span>${task.estimatedMinutes ? `<span>◴ ${task.estimatedMinutes} 分钟</span>` : '<span>◴ 未估时</span>'}${task.taskType ? `<span>· ${escapeHtml(task.taskType)}</span>` : ''}${task.projectId ? `<span>⌘ ${escapeHtml(state.projects.find(project => project.id === task.projectId)?.title || '项目')}</span>` : ''}</div></div><div class="task-actions">${!done ? `<button class="start-task" data-start="${escapeHtml(task.id)}">${state.focus?.taskId === task.id ? '专注中' : '开始陪跑'}</button>` : `<span class="priority-tag">完成</span>`}<button data-progress-task="${escapeHtml(task.id)}">记进度</button><button data-edit="${escapeHtml(task.id)}">调整</button></div></article>`;
}
function renderFocus() {
  const banner = $('#focusBanner');
  if (!state.focus) { banner.classList.add('hidden'); return; }
  const task = state.dailyTasks.find(item => item.id === state.focus.taskId);
  if (!task) { banner.classList.add('hidden'); return; }
  banner.classList.remove('hidden');
  const elapsed = Math.max(0, (state.focus.paused && state.focus.pausedAt ? Date.parse(state.focus.pausedAt) : Date.now()) - Date.parse(state.focus.startedAt));
  const remaining = Math.max(0, state.focus.expectedMinutes * 60_000 - elapsed);
  const time = `${String(Math.floor(remaining / 60_000)).padStart(2,'0')}:${String(Math.floor(remaining / 1000) % 60).padStart(2,'0')}`;
  banner.innerHTML = `<div class="focus-ring">${state.focus.paused ? '已暂停' : '专注中'}</div><div class="focus-copy"><b>${escapeHtml(task.title)}</b><p>${state.focus.paused ? '计时已暂停，准备好后可以继续。' : `约 ${Math.ceil(Math.max(0, Date.parse(state.focus.nextReminderAt || new Date().toISOString()) - Date.now()) / 60_000)} 分钟后提醒 · ${state.focus.remindersSent}/3 次未回应`}</p></div><div class="focus-timer" aria-label="剩余时间">${time}</div><div class="focus-controls"><button data-ack="${task.id}">汇报进度</button><button data-pause="${!state.focus.paused}">${state.focus.paused ? '继续计时' : '暂停'}</button><button data-focus-stop="true">结束陪跑</button><button class="focus-done" data-focus-done="true">完成</button></div>`;
  bindFocusActions();
}
function bindFocusActions() {
  $$('[data-pause]').forEach(button => button.onclick = () => runAction(button, () => pauseFocus(button.dataset.pause === 'true')));
  $$('[data-ack]').forEach(button => button.onclick = () => progressWizard(button.dataset.ack));
  $$('[data-focus-done]').forEach(button => button.onclick = () => runAction(button, () => stopFocus(true)));
  $$('[data-focus-stop]').forEach(button => button.onclick = () => runAction(button, () => stopFocus(false)));
}
function render() {
  if (!state) return;
  if (!Array.isArray(state.projectLogs)) state.projectLogs = [];
  const today = new Date(); $('#todayDate').textContent = today.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  $('#todayCount').textContent = state.dailyTasks.length; $('#projectCount').textContent = state.projects.length;
  const companionVisible = state.settings?.companionVisible !== false;
  $('#companionToggleLabel').textContent = companionVisible ? '关闭悬浮窗' : '打开悬浮窗';
  $('#companionToggle').setAttribute('aria-label', companionVisible ? '关闭悬浮窗' : '打开悬浮窗');
  $('#companionToggle').setAttribute('aria-pressed', String(companionVisible));
  $('#doneCount').textContent = state.dailyTasks.filter(task => task.status === 'complete').length; $('#remainingCount').textContent = state.dailyTasks.filter(task => task.status !== 'complete').length;
  if (!Array.isArray(state.progressLogs)) state.progressLogs = [];
  const tasks = sortedTasks(state.dailyTasks); $('#todayTasks').innerHTML = tasks.map(makeTaskCard).join(''); $('#emptyState').classList.toggle('hidden', tasks.length > 0);
  for (const [quadrant, suffix] of [['q1','q1'],['q2','q2'],['q3','q3'],['q4','q4']]) {
    const matches = sortedTasks(state.dailyTasks.filter(task => task.quadrant === quadrant)); $(`#count-${suffix}`).textContent = matches.length;
    $(`#quad-${suffix}`).innerHTML = matches.length ? matches.map(task => `<div class="quad-task"><i class="quad-dot"></i><div><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(formatDue(task.dueAt))} · ${escapeHtml(statusLabel(task.status))}</small></div></div>`).join('') : '<div class="quad-empty">还没有排入此象限的任务</div>';
  }
  $('#projectsList').innerHTML = state.projects.map(project => { const actions = state.actions.filter(action => action.projectId === project.id); const progress = project.estimatedProgress ?? 0; const logSeconds = state.projectLogs.filter(log => log.projectId === project.id).reduce((sum, log) => sum + Number(log.durationSeconds || 0), 0); const countdown = projectCountdown(project.dueAt); return `<article class="project-card"><div class="project-top"><span class="project-icon">⌘</span><button class="task-menu" data-delete-project="${project.id}">···</button></div><h3>${escapeHtml(project.title)}</h3><p>${escapeHtml(project.description || '为这个项目补充一句目标描述。')}</p><div class="project-summary"><span class="project-countdown-mini ${countdown.overdue ? 'overdue' : ''}">${escapeHtml(countdown.label)}</span><span>累计 ${escapeHtml(formatDuration(logSeconds))}</span></div><div class="project-progress"><div class="progress-line"><span style="width:${progress}%"></span></div><div class="progress-meta"><span>行动估算 ${actions.length} 项</span><span>${progress}%</span></div><input type="range" min="0" max="100" value="${progress}" aria-label="校正项目进度" data-progress="${project.id}"></div><button class="text-button project-open" data-open-project="${project.id}">查看项目详情 →</button></article>`; }).join(''); $('#projectsEmpty').classList.toggle('hidden', state.projects.length > 0);
  $('#historyList').innerHTML = [...state.history].reverse().map(item => { const count = { complete: 0, partial: 0, 'not-started': 0 }; item.tasks.forEach(task => { count[task.status] = (count[task.status] || 0) + 1; }); const analysis = item.analysis; return `<article class="history-card"><header><span>${escapeHtml(item.date)}</span><span>${item.tasks.length} 项</span></header><p>${escapeHtml(item.recap)}</p><div class="history-counts"><span>完成 ${count.complete}</span><span>部分完成 ${count.partial}</span><span>没开始 ${count['not-started']}</span></div>${analysis ? `<section class="review-insight"><strong>AI 习惯观察</strong><p><b>模式</b>${escapeHtml(analysis.pattern)}</p><p><b>依据</b>${escapeHtml(analysis.evidence)}</p><p><b>明天试试</b>${escapeHtml(analysis.experiment)}</p></section>` : `<button type="button" class="text-button review-retry" data-review-analyze="${escapeHtml(item.date)}">重新生成 AI 分析 →</button>`}</article>`; }).join(''); $('#historyEmpty').classList.toggle('hidden', state.history.length > 0);
  renderFocus(); renderProgressLog(); renderCalendarFailures(); bindActions();
}
function renderProgressLog() {
  const root = $('#progressLog');
  const entries = [...state.progressLogs].slice(-4).reverse();
  root.classList.toggle('hidden', entries.length === 0);
  if (!entries.length) { root.innerHTML = ''; return; }
  const collapsed = localStorage.getItem('task-companion-progress-collapsed') === 'true';
  root.classList.toggle('is-collapsed', collapsed);
  root.innerHTML = `<button type="button" class="progress-log-heading" aria-expanded="${!collapsed}" aria-controls="progressLogContent"><span>最近进度</span><span class="progress-log-chevron" aria-hidden="true">${collapsed ? '＋' : '−'}</span></button><div class="progress-log-content" id="progressLogContent">${entries.map(entry => `<article class="progress-log-entry"><time>${escapeHtml(new Date(entry.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</time><strong>${escapeHtml(entry.taskTitle)}</strong><p>${escapeHtml(entry.message)}</p></article>`).join('')}</div>`;
  $('.progress-log-heading', root).onclick = () => {
    const nextCollapsed = !root.classList.contains('is-collapsed');
    root.classList.toggle('is-collapsed', nextCollapsed);
    $('.progress-log-heading', root).setAttribute('aria-expanded', String(!nextCollapsed));
    $('.progress-log-chevron', root).textContent = nextCollapsed ? '＋' : '−';
    localStorage.setItem('task-companion-progress-collapsed', String(nextCollapsed));
  };
}
function renderCalendarFailures() {
  const root = $('#calendarFailures'); if (!root) return;
  const failed = [...(state.calendarEntries || [])].filter(entry => entry.status === 'failed').reverse();
  root.classList.toggle('hidden', failed.length === 0);
  root.innerHTML = failed.map(entry => `<article class="calendar-failure"><div><strong>未能写入日历：${escapeHtml(entry.title)}</strong><p>${escapeHtml(entry.error || '日历访问权限不足。')}</p></div><button type="button" class="button-secondary" data-calendar-retry="${escapeHtml(entry.id)}">重试授权并写入</button></article>`).join('');
  $$('[data-calendar-retry]', root).forEach(button => button.onclick = async () => {
    button.disabled = true; button.textContent = '正在请求…';
    try {
      const result = await api('/api/calendar/retry', { method: 'POST', body: JSON.stringify({ entryId: button.dataset.calendarRetry }) });
      state = result.state; render(); toast(result.calendar.ok ? '日历事件已补写' : result.calendar.error || '仍未获得日历权限');
    } catch (error) { button.disabled = false; button.textContent = '重试授权并写入'; toast(error.message); }
  });
}
function promptDueProgress() {
  const focus = state?.focus;
  if (!focus || focus.paused) return;
  const deliveredPrompt = focus.lastPromptAt && Date.parse(focus.lastPromptAt) > Date.parse(focus.acknowledgedAt || focus.startedAt) ? focus.lastPromptAt : '';
  const promptAt = deliveredPrompt;
  if (!promptAt || promptedReminderAt === promptAt || $('#modalRoot').dataset.open === 'true') return;
  const task = state.dailyTasks.find(item => item.id === focus.taskId);
  if (!task) return;
  promptedReminderAt = promptAt;
  progressWizard(task.id, true);
}
function bindActions() {
  $$('[data-start]').forEach(button => button.onclick = () => { if (state.focus) { toast('先暂停或结束当前陪跑。'); return; } const task = state.dailyTasks.find(item => item.id === button.dataset.start); if (task) kickoffWizard(task); });
  $$('[data-edit]').forEach(button => button.onclick = () => { const task = state.dailyTasks.find(item => item.id === button.dataset.edit); if (task) taskWizard('', task); });
  $$('[data-progress-task]').forEach(button => button.onclick = () => progressWizard(button.dataset.progressTask));
  $$('[data-complete]').forEach(button => button.onclick = async () => { const task = state.dailyTasks.find(item => item.id === button.dataset.complete); if (task) { task.status = 'complete'; if (state.focus?.taskId === task.id) await stopFocus(true); else { await save(); toast('任务已完成'); } } });
  $$('[data-progress]').forEach(input => input.onchange = async () => { const project = state.projects.find(item => item.id === input.dataset.progress); if (project) { project.estimatedProgress = Number(input.value); await save(); toast('项目进度已校正'); } });
  $$('[data-delete-project]').forEach(button => button.onclick = async () => { if (!confirm('删除这个项目？已归档行动会保留，但不会再关联项目。')) return; state.projects = state.projects.filter(project => project.id !== button.dataset.deleteProject); state.dailyTasks.forEach(task => { if (task.projectId === button.dataset.deleteProject) task.projectId = null; }); await save(); toast('项目已删除'); });
  $$('[data-open-project]').forEach(button => button.onclick = () => openProject(button.dataset.openProject));
  $$('[data-review-analyze]').forEach(button => button.onclick = async () => {
    button.disabled = true; button.textContent = '正在生成…';
    try { const result = await api('/api/review/analyze', { method: 'POST', body: JSON.stringify({ date: button.dataset.reviewAnalyze }) }); state = result.state; render(); toast('复盘分析已生成'); }
    catch (error) { button.disabled = false; button.textContent = '重新生成 AI 分析 →'; toast(error.message); }
  });
}
async function runAction(button, action) {
  if (button.disabled) return;
  button.disabled = true;
  try { await action(); } catch (error) { toast(error.message || '操作失败，请重试'); }
  finally { button.disabled = false; }
}
function goView(view) { $$('.view').forEach(item => item.classList.remove('active')); $(`#view-${view}`)?.classList.add('active'); $$('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === (view === 'project-detail' ? 'projects' : view))); $('#crumbLabel').textContent = ({ today: '今日计划', quadrants: '四象限看板', projects: '长期项目', 'project-detail': '项目详情', archive: '复盘记录' })[view] || '今日计划'; }
async function init() {
  try { state = await api('/api/state'); }
  catch (error) { document.body.innerHTML = `<main style="max-width:620px;margin:12vh auto;font:14px sans-serif;color:#26342c;padding:24px"><h1>Task Companion 服务未启动</h1><p>在终端进入 Skill 包目录并运行 <code>node server.mjs</code>，再刷新此页面。</p><p style="color:#778279">${escapeHtml(error.message)}</p></main>`; return; }
  if (state.activeDate !== localDateKey() && !state.dailyTasks.length) { state.activeDate = localDateKey(); await save(); }
  render();
  if (state.focusRecoveryRequired) focusRecoveryWizard();
  else if (state.reviewRequired) reviewWizard();
  setInterval(() => { if (state?.focus) { renderFocus(); promptDueProgress(); } }, 1000);
  setInterval(async () => {
    if (!state) return;
    try {
      const fresh = await api('/api/state');
      if (fresh.focus?.nextReminderAt !== state.focus?.nextReminderAt) promptedReminderAt = '';
      state = fresh; render(); promptDueProgress();
    } catch {}
  }, 15000);
  $$('.nav-item').forEach(button => button.onclick = () => goView(button.dataset.view));
  $$('[data-view]').filter(button => !button.classList.contains('nav-item')).forEach(button => button.onclick = () => goView(button.dataset.view));
  $('#addTaskButton').onclick = () => { const text = $('#quickInput').value.trim(); if (!text) return toast('先写下一件事。'); taskWizard(text, null, () => { $('#quickInput').value = ''; }); };
  $('#quickInput').addEventListener('keydown', event => { if (event.key === 'Enter') $('#addTaskButton').click(); }); $('#emptyAdd').onclick = () => $('#quickInput').focus(); $('#quadrantAdd').onclick = () => $('#quickInput').focus();
  $$('[data-open-import]').forEach(button => button.onclick = () => importWizard(button.dataset.openImport));
  $('#newProjectButton').onclick = $('#projectAdd').onclick = $('#projectEmptyAdd').onclick = () => projectWizard();
  $('#projectBack').onclick = () => goView('projects');
  $('#collapseChat').onclick = () => $('#companionPanel').classList.toggle('collapsed');
  $('#settingsButton').onclick = () => openAiSettings().catch(error => toast(error.message));
  $('#companionToggle').onclick = async () => {
    const visible = state.settings?.companionVisible === false;
    try {
      await api('/api/companion/window', { method: 'POST', body: JSON.stringify({ visible }) });
      state.settings.companionVisible = visible; render(); toast(visible ? '悬浮窗已打开' : '悬浮窗已关闭');
    } catch (error) { toast(error.message); }
  };
  $('#sendChat').onclick = sendChatMessage;
  $('#chatInput').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendChatMessage(); } });
  refreshAiConfig();
}
init();
