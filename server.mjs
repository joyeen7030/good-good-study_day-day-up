import http from 'node:http';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(packageDir, 'dashboard');
const port = Number(process.env.TASK_COMPANION_PORT || 43129);
const dataDir = path.join(packageDir, 'data');
const dataPath = path.join(dataDir, 'state.json');
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

const dayStamp = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const nowIso = () => new Date().toISOString();
const aiKeychainService = 'com.local.task-companion.ai';
const aiProviders = {
  openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.2' },
  deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' },
  glm: { name: 'GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5' }
};
const blankState = () => ({ version: 1, activeDate: dayStamp(), projects: [], projectLogs: [], progressLogs: [], calendarEntries: [], actions: [], dailyTasks: [], history: [], focus: null, settings: { checkInInterval: 25, paused: false, companionVisible: true } });

async function readState() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    const state = { ...blankState(), ...JSON.parse(await fs.readFile(dataPath, 'utf8')) };
    if (!Array.isArray(state.projectLogs)) state.projectLogs = [];
    if (!Array.isArray(state.progressLogs)) state.progressLogs = [];
    if (!Array.isArray(state.calendarEntries)) state.calendarEntries = [];
    state.settings = { ...blankState().settings, ...(state.settings || {}) };
    return state;
  }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const state = blankState();
    await writeState(state);
    return state;
  }
}
function addCalendarEvent({ id, title, startedAt, endedAt }) {
  if (process.platform !== 'darwin') return { ok: false, error: '写入 Mac 日历仅支持 macOS。' };
  const appPath = path.join(dataDir, 'TaskCompanionCalendarWriter.app');
  const contents = path.join(appPath, 'Contents');
  const executable = path.join(contents, 'MacOS', 'TaskCompanionCalendarWriter');
  const infoPath = path.join(contents, 'Info.plist');
  const bundleIdentifier = 'com.local.task-companion.calendar-writer';
  try {
    const source = path.join(packageDir, 'calendar-helper', 'main.swift');
    const needsCompile = !fsSync.existsSync(executable) || fsSync.statSync(source).mtimeMs > fsSync.statSync(executable).mtimeMs;
    if (needsCompile) {
      fsSync.mkdirSync(path.dirname(executable), { recursive: true });
      execFileSync('/usr/bin/swiftc', ['-parse-as-library', '-framework', 'EventKit', source, '-o', executable], { timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
    }
    fsSync.mkdirSync(contents, { recursive: true });
    const needsInfo = !fsSync.existsSync(infoPath);
    if (needsInfo) {
      const info = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>TaskCompanionCalendarWriter</string><key>CFBundleIdentifier</key><string>${bundleIdentifier}</string><key>CFBundleName</key><string>Task Companion Calendar Writer</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>1.0</string><key>CFBundleVersion</key><string>1</string><key>NSCalendarsUsageDescription</key><string>在你选择将完成的陪跑计时加入日历时，Task Companion 会创建对应日历事件。</string><key>NSCalendarsWriteOnlyAccessUsageDescription</key><string>在你选择将完成的陪跑计时加入日历时，Task Companion 会创建对应日历事件。</string></dict></plist>`;
      fsSync.writeFileSync(infoPath, info, { mode: 0o644 });
    }
    if (needsInfo || needsCompile) {
      execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--identifier', bundleIdentifier, appPath], { timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
    }
    const resultPath = path.join(dataDir, `calendar-result-${crypto.randomUUID()}.json`);
    try {
      execFileSync('/usr/bin/open', ['-W', '-n', '-a', appPath, '--args', title, id, String(Date.parse(startedAt)), String(Date.parse(endedAt)), resultPath], { timeout: 300_000, stdio: ['ignore', 'pipe', 'pipe'] });
      return JSON.parse(fsSync.readFileSync(resultPath, 'utf8'));
    } finally {
      try { fsSync.unlinkSync(resultPath); } catch {}
    }
  } catch (error) {
    const detail = error.stderr?.toString().trim();
    return { ok: false, error: detail || error.message || '无法启动日历授权组件。' };
  }
}
async function writeState(state) {
  await fs.mkdir(dataDir, { recursive: true });
  const tmp = `${dataPath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, dataPath);
}
async function bodyJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 2_000_000) throw new Error('Request body is too large.');
  }
  return body ? JSON.parse(body) : {};
}
function send(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}
function projectProgress(state, projectId) {
  const linked = state.actions.filter(action => action.projectId === projectId);
  if (!linked.length) return null;
  const scores = linked.map(action => action.status === 'complete' ? 1 : action.status === 'partial' ? 0.5 : 0);
  return Math.round(scores.reduce((sum, score) => sum + score, 0) / linked.length * 100);
}
function mergeProjectLog(state, { projectId, date, title, durationSeconds, segment }) {
  if (!projectId || !date || !title || !durationSeconds || durationSeconds < 0) return null;
  let log = state.projectLogs.find(item => item.projectId === projectId && item.date === date);
  if (!log) {
    log = { id: crypto.randomUUID(), projectId, date, title: '', titles: [], titleCustom: false, durationSeconds: 0, segments: [], createdAt: nowIso() };
    state.projectLogs.push(log);
  }
  if (!Array.isArray(log.titles)) log.titles = log.title ? [log.title] : [];
  if (!Array.isArray(log.segments)) log.segments = [];
  if (!log.titles.includes(title)) log.titles.push(title);
  if (!log.titleCustom) log.title = log.titles.join('、');
  log.durationSeconds = Number(log.durationSeconds || 0) + Number(durationSeconds);
  log.segments.push({ id: crypto.randomUUID(), title, durationSeconds: Number(durationSeconds), ...segment });
  log.updatedAt = nowIso();
  return log;
}
function focusElapsedSeconds(focus, endedAt = Date.now()) {
  const end = focus.paused && focus.pausedAt ? Math.min(Date.parse(focus.pausedAt), endedAt) : endedAt;
  return Math.max(0, Math.floor((end - Date.parse(focus.startedAt)) / 1000));
}
function recordFocusTime(state, endedAt = new Date()) {
  if (!state.focus) return null;
  const task = state.dailyTasks.find(item => item.id === state.focus.taskId);
  if (!task?.projectId) return null;
  const durationSeconds = focusElapsedSeconds(state.focus, endedAt.getTime());
  if (!durationSeconds) return null;
  return mergeProjectLog(state, {
    projectId: task.projectId,
    date: dayStamp(endedAt),
    title: task.title,
    durationSeconds,
    segment: { taskId: task.id, startedAt: state.focus.startedAt, endedAt: endedAt.toISOString(), source: 'focus' }
  });
}
function runSecurity(args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/security', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(stdout.trimEnd()) : reject(new Error(stderr.trim() || 'macOS 钥匙串操作失败。')));
    child.stdin.end(input);
  });
}
async function keychainGet(account) {
  try { return await runSecurity(['find-generic-password', '-s', aiKeychainService, '-a', account, '-w']); }
  catch (error) { if (/could not be found|item not found|no such item/i.test(error.message)) return null; throw error; }
}
async function keychainSet(account, value) {
  const hex = Buffer.from(value, 'utf8').toString('hex');
  await runSecurity(['add-generic-password', '-U', '-s', aiKeychainService, '-a', account, '-X', hex]);
}
async function keychainDelete(account) {
  try { await runSecurity(['delete-generic-password', '-s', aiKeychainService, '-a', account]); }
  catch (error) { if (!/could not be found|item not found|no such item/i.test(error.message)) throw error; }
}
async function readAiPrefs() {
  const stored = await keychainGet('settings');
  try { return stored ? JSON.parse(stored) : {}; } catch { return {}; }
}
async function providerModels(provider, apiKey) {
  const spec = aiProviders[provider];
  const response = await fetch(`${spec.baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(20_000) });
  const raw = await response.text();
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'API 密钥无效或无权限。' : `服务商返回错误（${response.status}）：${raw.slice(0, 240)}`);
  let parsed; try { parsed = JSON.parse(raw); } catch { throw new Error('服务商返回的数据无法识别。'); }
  const models = (parsed.data || parsed.models || []).map(item => typeof item === 'string' ? item : item.id || item.name).filter(Boolean);
  return models.length ? models : [spec.model];
}
function safeProviderError(error) { return String(error?.message || 'AI 请求失败。').slice(0, 300); }
function parseReviewAnalysis(text) {
  const source = String(text || '').trim();
  const candidate = source.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) throw new Error('AI 没有返回可识别的复盘分析。');
  const parsed = JSON.parse(candidate);
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const analysis = { pattern: clean(parsed.pattern), evidence: clean(parsed.evidence), experiment: clean(parsed.experiment) };
  if (!analysis.pattern || !analysis.evidence || !analysis.experiment) throw new Error('AI 返回的复盘分析不完整。');
  return analysis;
}
function buildReviewContext(state, reviewedTasks, reviewedDate) {
  const targetDate = new Date(`${reviewedDate}T12:00:00`);
  const startDate = new Date(targetDate);
  startDate.setDate(startDate.getDate() - 13);
  const start = dayStamp(startDate);
  const recentHistory = state.history.filter(item => item.date >= start && item.date < reviewedDate).slice(-14).map(item => ({
    date: item.date,
    tasks: (item.tasks || []).map(task => ({ title: task.title, status: task.status, project: state.projects.find(project => project.id === task.projectId)?.title || null }))
  }));
  const recentProgress = state.progressLogs.filter(log => {
    const date = dayStamp(new Date(log.createdAt));
    return date >= start && date <= reviewedDate;
  }).slice(-80).map(log => ({ date: dayStamp(new Date(log.createdAt)), task: log.taskTitle, message: log.message }));
  const recentProjectWork = state.projectLogs.filter(log => log.date >= start && log.date <= reviewedDate).map(log => ({
    date: log.date,
    project: state.projects.find(project => project.id === log.projectId)?.title || '未知项目',
    work: log.title || (log.titles || []).join('、'),
    minutes: Math.round(Number(log.durationSeconds || 0) / 60)
  }));
  const projects = state.projects.filter(project => Number(project.estimatedProgress || 0) < 100).map(project => {
    const logs = state.projectLogs.filter(log => log.projectId === project.id).sort((a, b) => b.date.localeCompare(a.date));
    const lastLog = logs[0];
    return {
      title: project.title,
      goal: project.description || '',
      dueDate: project.dueAt || null,
      progressPercent: Number(project.estimatedProgress || 0),
      lastRecordedWorkDate: lastLog?.date || null,
      lastRecordedWork: lastLog?.title || (lastLog?.titles || []).join('、') || null
    };
  });
  return { reviewDate: reviewedDate, yesterdayTasks: reviewedTasks.map(task => ({
    title: task.title,
    status: task.status,
    estimatedMinutes: task.estimatedMinutes || null,
    project: state.projects.find(project => project.id === task.projectId)?.title || null
  })), progressNotesLast14Days: recentProgress, projectWorkLast14Days: recentProjectWork, unfinishedProjects: projects, priorReviewsLast14Days: recentHistory };
}
async function analyzeDailyReview(state, reviewedTasks, reviewedDate) {
  try {
    const prefs = await readAiPrefs();
    const provider = prefs.activeProvider;
    const spec = aiProviders[provider];
    const apiKey = spec ? await keychainGet(provider) : null;
    if (!spec || !apiKey) return { analysis: null, analysisMessage: 'AI 未配置，复盘已正常保存；配置 AI 服务后才会生成习惯分析。' };
    const model = prefs.models?.[provider] || spec.model;
    const context = buildReviewContext(state, reviewedTasks, reviewedDate);
    const system = `你是 Task Companion 的复盘分析助手。用中文简短、直接地反馈。根据用户最近14天的任务复盘、进度记录、专注投入和未完成长期项目，寻找可观察的行为模式（例如计划过量、延迟启动、遇难后停滞、反复回避某类步骤），但不能把一次未完成直接诊断成拖延或逃避，也不能把推测写成事实。先看证据，再给判断；证据不足时明确说“目前记录不足以判断稳定习惯”。关注未完成项目的停滞时长、目标/下一步是否模糊，但不要臆测原因。只给一条明天可试的小改变。不要羞辱人格、诊断心理疾病。只返回 JSON，不要 Markdown，格式为 {"pattern":"观察到的模式或证据不足","evidence":"引用具体日期、任务或进度记录","experiment":"明天可以尝试的一件小改变"}。每项不超过80个汉字。`;
    const responsesApi = provider !== 'glm';
    const messages = [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(context) }];
    const requestBody = responsesApi
      ? { model, instructions: system, input: [{ role: 'user', content: JSON.stringify(context) }], max_output_tokens: 350 }
      : { model, messages, stream: false, max_tokens: 350, temperature: 0.4 };
    const response = await fetch(`${spec.baseUrl}/${responsesApi ? 'responses' : 'chat/completions'}`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody), signal: AbortSignal.timeout(60_000) });
    const raw = await response.text(); let result; try { result = JSON.parse(raw); } catch { result = {}; }
    if (!response.ok) throw new Error(result.error?.message || `AI 服务请求失败（${response.status}）。`);
    const reply = responsesApi
      ? (result.output_text || result.output?.filter(item => item.type === 'message').flatMap(item => item.content || []).filter(item => item.type === 'output_text' || item.type === 'text').map(item => item.text).join(''))
      : result.choices?.[0]?.message?.content;
    return { analysis: parseReviewAnalysis(reply), analysisMessage: null };
  } catch (error) {
    return { analysis: null, analysisMessage: `AI 分析未生成：${safeProviderError(error)} 复盘已正常保存。` };
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return send(res, 403, { error: 'Local access only.' });
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const state = await readState();
      state.focusRecoveryRequired = Boolean(state.focus && dayStamp(new Date(state.focus.startedAt)) < dayStamp() && state.focus.recoveredThroughDate !== dayStamp());
      if (state.focusRecoveryRequired && !state.focus.paused) {
        state.focus.paused = true;
        const boundary = new Date(); boundary.setHours(0, 0, 0, 0);
        state.focus.pausedAt = boundary.toISOString();
        state.settings.paused = true;
        await writeState(state);
      }
      state.reviewRequired = state.activeDate !== dayStamp() && state.dailyTasks.length > 0 && !state.focus;
      return send(res, 200, state);
    }
    if (req.method === 'POST' && url.pathname === '/api/companion/window') {
      const input = await bodyJson(req);
      const state = await readState();
      state.settings.companionVisible = Boolean(input.visible);
      state.settings.companionWindowChangedAt = nowIso();
      await writeState(state);
      return send(res, 200, { ok: true, visible: state.settings.companionVisible });
    }
    if (req.method === 'GET' && url.pathname === '/api/export') {
      const state = await readState();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="time-companion-backup.json"' });
      return res.end(JSON.stringify(state, null, 2));
    }
    if (req.method === 'GET' && url.pathname === '/api/ai/config') {
      const prefs = await readAiPrefs(); const providers = {};
      for (const [id, spec] of Object.entries(aiProviders)) providers[id] = { name: spec.name, configured: Boolean(await keychainGet(id)), model: prefs.models?.[id] || spec.model };
      return send(res, 200, { providers, activeProvider: prefs.activeProvider || null });
    }
    if (req.method === 'POST' && url.pathname === '/api/ai/test') {
      const input = await bodyJson(req); const provider = String(input.provider || ''); const apiKey = String(input.apiKey || '').trim();
      if (!aiProviders[provider] || !apiKey || apiKey.length > 500) return send(res, 400, { error: '请选择服务商并填写有效的 API 密钥。' });
      try {
        const models = await providerModels(provider, apiKey);
        const usable = models.filter(model => !/(embedding|whisper|tts|dall-e|moderation|audio|image|realtime)/i.test(model)).slice(0, 120);
        return send(res, 200, { ok: true, models: usable.length ? usable : models.slice(0, 120), defaultModel: aiProviders[provider].model });
      } catch (error) { return send(res, 400, { error: safeProviderError(error) }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/ai/provider') {
      const input = await bodyJson(req); const provider = String(input.provider || ''); const apiKey = String(input.apiKey || '').trim(); const model = String(input.model || '');
      if (!aiProviders[provider] || !apiKey || apiKey.length > 500 || !model || model.length > 160) return send(res, 400, { error: '服务商、API 密钥和模型都需要填写。' });
      try {
        const models = await providerModels(provider, apiKey);
        if (!models.includes(model)) return send(res, 400, { error: '这个模型不在该密钥可用的模型列表中，请重新验证并选择模型。' });
        await keychainSet(provider, apiKey);
        const prefs = await readAiPrefs(); prefs.models = { ...(prefs.models || {}), [provider]: model };
        if (!prefs.activeProvider) prefs.activeProvider = provider;
        await keychainSet('settings', JSON.stringify(prefs));
        return send(res, 200, { ok: true });
      } catch (error) { return send(res, 400, { error: safeProviderError(error) }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/ai/active') {
      const input = await bodyJson(req); const provider = String(input.provider || '');
      if (!aiProviders[provider] || !await keychainGet(provider)) return send(res, 400, { error: '请先为该服务商保存并验证 API 密钥。' });
      const prefs = await readAiPrefs(); prefs.activeProvider = provider; await keychainSet('settings', JSON.stringify(prefs));
      return send(res, 200, { ok: true, activeProvider: provider });
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/ai/provider/')) {
      const provider = decodeURIComponent(url.pathname.split('/').pop());
      if (!aiProviders[provider]) return send(res, 400, { error: '未知服务商。' });
      await keychainDelete(provider); const prefs = await readAiPrefs();
      if (!prefs.activeProvider || !await keychainGet(prefs.activeProvider)) {
        prefs.activeProvider = null;
        for (const id of Object.keys(aiProviders)) if (await keychainGet(id)) { prefs.activeProvider = id; break; }
      }
      if (prefs.models) delete prefs.models[provider]; await keychainSet('settings', JSON.stringify(prefs));
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/state') {
      const state = await bodyJson(req);
      if (!Array.isArray(state.projects) || !Array.isArray(state.actions) || !Array.isArray(state.dailyTasks) || !Array.isArray(state.history)) return send(res, 400, { error: 'Invalid state document.' });
      if (!Array.isArray(state.projectLogs)) state.projectLogs = [];
      if (!Array.isArray(state.progressLogs)) state.progressLogs = [];
      await writeState(state);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/progress/log') {
      const input = await bodyJson(req);
      const state = await readState();
      const task = state.dailyTasks.find(item => item.id === input.taskId);
      const message = String(input.message || '').trim().slice(0, 500);
      if (!task) return send(res, 404, { error: 'Task not found.' });
      if (!message) return send(res, 400, { error: '请写下进展或卡点后再保存。' });
      const entry = { id: crypto.randomUUID(), taskId: task.id, taskTitle: task.title, message, createdAt: nowIso() };
      state.progressLogs.push(entry);
      if (state.focus?.taskId === task.id) {
        state.focus.acknowledgedAt = entry.createdAt;
        state.focus.nextReminderAt = new Date(Date.now() + state.focus.intervalMinutes * 60_000).toISOString();
        state.focus.remindersSent = 0;
      }
      await writeState(state);
      return send(res, 200, { ok: true, entry });
    }
    if (req.method === 'POST' && url.pathname === '/api/focus/start') {
      const input = await bodyJson(req);
      const state = await readState();
      const task = state.dailyTasks.find(item => item.id === input.taskId);
      if (!task) return send(res, 404, { error: 'Task not found.' });
      const interval = Math.max(1, Number(input.intervalMinutes || task.intervalMinutes || 25));
      task.status = 'in-progress';
      const startedAt = nowIso();
      state.focus = { taskId: task.id, startedAt, wallStartedAt: startedAt, expectedMinutes: Number(input.expectedMinutes || task.estimatedMinutes || 25), intervalMinutes: interval, nextReminderAt: new Date(Date.now() + interval * 60_000).toISOString(), remindersSent: 0, paused: false, acknowledgedAt: startedAt };
      state.settings.paused = false;
      await writeState(state);
      return send(res, 200, { ok: true, focus: state.focus });
    }
    if (req.method === 'POST' && url.pathname === '/api/focus/ack') {
      const state = await readState();
      if (!state.focus) return send(res, 409, { error: 'No active task.' });
      const input = await bodyJson(req);
      const interval = state.focus.intervalMinutes;
      state.focus.acknowledgedAt = nowIso();
      state.focus.nextReminderAt = new Date(Date.now() + interval * 60_000).toISOString();
      state.focus.remindersSent = 0;
      const task = state.dailyTasks.find(item => item.id === state.focus.taskId);
      if (task && input.status) task.status = input.status;
      if (input.message) state.focus.lastProgress = String(input.message).slice(0, 500);
      await writeState(state);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/focus/recover') {
      const input = await bodyJson(req);
      const state = await readState();
      if (!state.focus) return send(res, 409, { error: '当前没有正在进行的计时。' });
      const today = dayStamp();
      if (input.choice === 'continue') {
        state.focus.recoveredThroughDate = today;
        if (state.focus.paused && state.focus.pausedAt) {
          const pauseMs = Math.max(0, Date.now() - Date.parse(state.focus.pausedAt));
          state.focus.startedAt = new Date(Date.parse(state.focus.startedAt) + pauseMs).toISOString();
          state.focus.paused = false;
          state.focus.pausedAt = null;
        }
        state.focus.nextReminderAt = new Date(Date.now() + Math.max(1, Number(state.focus.intervalMinutes || 25)) * 60_000).toISOString();
        state.settings.paused = false;
        await writeState(state);
        state.focusRecoveryRequired = false;
        state.reviewRequired = false;
        return send(res, 200, { ok: true, state });
      }
      let endedAt;
      if (input.choice === 'last-recorded') {
        const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
        const lastProgress = [...state.progressLogs].reverse().find(entry => entry.taskId === state.focus.taskId && Date.parse(entry.createdAt) >= Date.parse(state.focus.startedAt) && Date.parse(entry.createdAt) < todayStart.getTime());
        endedAt = new Date(lastProgress?.createdAt || state.focus.startedAt);
      } else if (input.choice === 'custom') {
        endedAt = new Date(input.endedAt);
      } else return send(res, 400, { error: '请选择如何处理跨日计时。' });
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      if (!Number.isFinite(endedAt.getTime()) || endedAt >= todayStart || endedAt < new Date(state.focus.startedAt)) return send(res, 400, { error: '结束时间必须在计时开始之后、今天零点之前。' });
      const task = state.dailyTasks.find(item => item.id === state.focus.taskId);
      recordFocusTime(state, endedAt);
      if (task) task.status = 'planned';
      state.focus = null;
      state.settings.paused = false;
      await writeState(state);
      state.focusRecoveryRequired = false;
      state.reviewRequired = state.activeDate !== today && state.dailyTasks.length > 0;
      return send(res, 200, { ok: true, state });
    }
    if (req.method === 'POST' && url.pathname === '/api/focus/reminder') {
      const state = await readState();
      const focus = state.focus;
      if (!focus || focus.paused || !focus.nextReminderAt || Date.now() < Date.parse(focus.nextReminderAt)) return send(res, 200, { ok: true, reminder: null });
      const task = state.dailyTasks.find(item => item.id === focus.taskId);
      if (!task) return send(res, 200, { ok: true, reminder: null });
      focus.remindersSent = Number(focus.remindersSent || 0) + 1;
      focus.lastPromptAt = nowIso();
      focus.nextReminderAt = new Date(Date.now() + Math.max(1, Number(focus.intervalMinutes || 25)) * 60_000).toISOString();
      await writeState(state);
      return send(res, 200, { ok: true, reminder: { taskId: task.id, title: task.title, promptAt: focus.lastPromptAt } });
    }
    if (req.method === 'POST' && url.pathname === '/api/focus/pause') {
      const input = await bodyJson(req);
      const state = await readState();
      if (state.focus) {
        const wasPaused = Boolean(state.focus.paused);
        state.focus.paused = Boolean(input.paused);
        state.settings.paused = Boolean(input.paused);
        if (input.paused && !wasPaused) {
          state.focus.pausedAt = nowIso();
          state.focus.nextReminderAt = null;
        } else if (!input.paused && wasPaused) {
          const pauseMs = Date.now() - Date.parse(state.focus.pausedAt || nowIso());
          state.focus.startedAt = new Date(Date.parse(state.focus.startedAt) + pauseMs).toISOString();
          state.focus.pausedAt = null;
          state.focus.nextReminderAt = new Date(Date.now() + state.focus.intervalMinutes * 60_000).toISOString();
        }
        await writeState(state);
      }
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/focus/stop') {
      const input = await bodyJson(req);
      const state = await readState();
      let calendar = null;
      if (state.focus) {
        const endedAt = new Date();
        recordFocusTime(state);
        const task = state.dailyTasks.find(item => item.id === state.focus.taskId);
        if (task) task.status = input.complete ? 'complete' : 'planned';
        if (input.complete && input.calendarEvent === true && task) {
          const entry = { id: crypto.randomUUID(), taskId: task.id, title: task.title, startedAt: state.focus.wallStartedAt || state.focus.startedAt, endedAt: endedAt.toISOString(), status: 'pending' };
          calendar = addCalendarEvent(entry);
          entry.status = calendar.ok ? 'saved' : 'failed';
          entry.calendarTitle = calendar.calendarTitle || null;
          entry.eventIdentifier = calendar.eventIdentifier || null;
          entry.error = calendar.ok ? null : calendar.error || '日历写入失败。';
          state.calendarEntries.push(entry);
        }
        state.focus = null;
        state.settings.paused = false;
        await writeState(state);
      }
      return send(res, 200, { ok: true, calendar });
    }
    if (req.method === 'POST' && url.pathname === '/api/calendar/retry') {
      const input = await bodyJson(req);
      const state = await readState();
      const entry = state.calendarEntries.find(item => item.id === input.entryId && item.status === 'failed');
      if (!entry) return send(res, 404, { error: '找不到待重试的日历记录。' });
      const calendar = addCalendarEvent(entry);
      entry.status = calendar.ok ? 'saved' : 'failed';
      entry.calendarTitle = calendar.calendarTitle || null;
      entry.eventIdentifier = calendar.eventIdentifier || null;
      entry.error = calendar.ok ? null : calendar.error || '日历写入失败。';
      await writeState(state);
      return send(res, 200, { ok: true, calendar, state });
    }
    if (req.method === 'POST' && url.pathname === '/api/project-log/manual') {
      const input = await bodyJson(req);
      const state = await readState();
      const project = state.projects.find(item => item.id === input.projectId);
      const title = String(input.title || '').trim();
      const date = String(input.date || '');
      const minutes = Number(input.durationMinutes);
      const parts = date.split('-').map(Number);
      const parsedDate = parts.length === 3 && parts.every(Number.isFinite) ? new Date(parts[0], parts[1] - 1, parts[2]) : null;
      const validDate = Boolean(parsedDate && parsedDate.getFullYear() === parts[0] && parsedDate.getMonth() === parts[1] - 1 && parsedDate.getDate() === parts[2]);
      if (!project || !title || !validDate || !Number.isFinite(minutes) || minutes <= 0) return send(res, 400, { error: '请填写有效的项目、日期、标题和正数用时。' });
      mergeProjectLog(state, { projectId: project.id, date, title, durationSeconds: Math.round(minutes * 60), segment: { source: 'manual', createdAt: nowIso() } });
      await writeState(state);
      return send(res, 200, { ok: true, state });
    }
    if (req.method === 'POST' && url.pathname === '/api/project-log/title') {
      const input = await bodyJson(req);
      const state = await readState();
      const log = state.projectLogs.find(item => item.id === input.logId);
      const title = String(input.title || '').trim();
      if (!log || !title) return send(res, 400, { error: '记录标题不能为空。' });
      log.title = title;
      log.titleCustom = true;
      log.updatedAt = nowIso();
      await writeState(state);
      return send(res, 200, { ok: true, state });
    }
    if (req.method === 'POST' && url.pathname === '/api/review') {
      const input = await bodyJson(req);
      const state = await readState();
      const reviewedDate = state.activeDate;
      const statuses = input.statuses || {};
      const reviewedTasks = state.dailyTasks.map(task => ({ ...task, status: statuses[task.id] || 'not-started' }));
      const { analysis, analysisMessage } = await analyzeDailyReview(state, reviewedTasks, reviewedDate);
      for (const task of reviewedTasks) state.actions.push({ id: task.id, title: task.title, projectId: task.projectId || null, status: task.status, reviewedDate, reviewedAt: nowIso() });
      const counts = { complete: 0, partial: 0, 'not-started': 0 };
      reviewedTasks.forEach(task => { counts[task.status] = (counts[task.status] || 0) + 1; });
      const recap = `昨天的 ${reviewedTasks.length} 项行动已复盘：完成 ${counts.complete} 项，部分完成 ${counts.partial} 项，未开始 ${counts['not-started']} 项。每个完成的步骤都在推进长期目标。`;
      const date = dayStamp();
      state.history.push({ date: reviewedDate, tasks: reviewedTasks, recap, ...(analysis ? { analysis } : {}) });
      state.dailyTasks = [];
      state.activeDate = date;
      state.focus = null;
      state.settings.paused = false;
      for (const project of state.projects) {
        const progress = projectProgress(state, project.id);
        if (progress !== null) project.estimatedProgress = progress;
      }
      await writeState(state);
      return send(res, 200, { ok: true, recap, counts, analysis, analysisMessage, state });
    }
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      const input = await bodyJson(req); const prefs = await readAiPrefs(); const provider = prefs.activeProvider;
      const spec = aiProviders[provider]; const apiKey = spec ? await keychainGet(provider) : null;
      if (!spec || !apiKey) return send(res, 503, { error: '请先在设置里配置并启用一个 AI 服务商。' });
      const state = await readState();
      const context = {
        date: state.activeDate,
        currentTask: state.focus ? state.dailyTasks.find(task => task.id === state.focus.taskId)?.title || null : null,
        tasks: state.dailyTasks.map(task => ({ title: task.title, status: task.status, estimatedMinutes: task.estimatedMinutes, quadrant: task.quadrant, project: state.projects.find(project => project.id === task.projectId)?.title || null })),
        projects: state.projects.map(project => ({ title: project.title, dueAt: project.dueAt, progress: project.estimatedProgress })),
        recentProgress: state.progressLogs.slice(-5).map(log => ({ task: log.taskTitle, message: log.message, at: log.createdAt }))
      };
      const system = `你是 Task Companion 的严厉问责教练。说话短、硬、直接，不安慰、不哄、不说空泛鼓励。用户含糊时追问具体产出和时间；用户绕开任务、找借口或重复纠结时，点明行为与计划的落差，要求给出下一步和完成时点。可以尖锐，但只批评可观察的选择和行动，不羞辱人格、不辱骂、不使用脏话。每次只逼出一个明确行动。结合看板上下文；缺信息时只问必要问题。当前本地任务上下文：${JSON.stringify(context)}`;
      const messages = Array.isArray(input.messages) ? input.messages.filter(item => ['user', 'assistant'].includes(item.role) && typeof item.content === 'string').slice(-16) : [];
      if (!messages.length) return send(res, 400, { error: '请输入消息。' });
      const model = prefs.models?.[provider] || spec.model;
      try {
        const responsesApi = provider !== 'glm';
        const requestBody = responsesApi
          ? { model, instructions: system, input: messages, max_output_tokens: 700 }
          : { model, messages: [{ role: 'system', content: system }, ...messages], stream: false, max_tokens: 700 };
        const response = await fetch(`${spec.baseUrl}/${responsesApi ? 'responses' : 'chat/completions'}`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody), signal: AbortSignal.timeout(60_000) });
        const raw = await response.text(); let result; try { result = JSON.parse(raw); } catch { result = {}; }
        if (!response.ok) return send(res, 502, { error: result.error?.message || `AI 服务请求失败（${response.status}）。` });
        const reply = responsesApi
          ? (result.output_text || result.output?.filter(item => item.type === 'message').flatMap(item => item.content || []).filter(item => item.type === 'output_text' || item.type === 'text').map(item => item.text).join(''))
          : result.choices?.[0]?.message?.content;
        if (typeof reply !== 'string' || !reply.trim()) return send(res, 502, { error: 'AI 服务没有返回可显示的文字。' });
        return send(res, 200, { reply: reply.trim(), provider, model });
      } catch (error) { return send(res, 502, { error: safeProviderError(error) }); }
    }
    if (req.method !== 'GET' || !['/', '/index.html'].includes(url.pathname) && !url.pathname.startsWith('/assets/')) {
      if (req.method !== 'GET') return send(res, 404, { error: 'Not found.' });
      const requested = decodeURIComponent(url.pathname);
      const safeName = path.normalize(requested === '/' ? 'index.html' : requested.replace(/^\/+/, ''));
      const filePath = path.resolve(webRoot, safeName);
      if (!filePath.startsWith(`${webRoot}${path.sep}`)) return send(res, 403, { error: 'Invalid path.' });
      const data = await fs.readFile(filePath);
      res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      return res.end(data);
    }
    const filePath = path.join(webRoot, 'index.html');
    res.writeHead(200, { 'Content-Type': mimeTypes['.html'], 'Cache-Control': 'no-cache' });
    return res.end(await fs.readFile(filePath));
  } catch (error) {
    console.error(error);
    return send(res, 500, { error: error.message || 'Unexpected local server error.' });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Task Companion running at http://127.0.0.1:${port}`);
  console.log(`Private task data: ${dataPath}`);
});

setInterval(async () => {
  try {
    const state = await readState();
    const focus = state.focus;
    if (!focus || focus.paused || dayStamp(new Date(focus.startedAt)) >= dayStamp() || focus.recoveredThroughDate === dayStamp()) return;
    focus.paused = true;
    const boundary = new Date(); boundary.setHours(0, 0, 0, 0);
    focus.pausedAt = boundary.toISOString();
    state.settings.paused = true;
    await writeState(state);
  } catch (error) { console.error('Focus day-boundary check failed:', error.message); }
}, 15_000);
