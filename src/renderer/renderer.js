const api = window.devLauncher;

const runtimeState = new Map();
let state = { roots: [], projects: [], groups: [], settings: {} };
let activeView = 'projects';
let selectedProjectId = null;
let autoScroll = true;
let scanBusy = false;
let scanBusyAction = '';
let rootTreeExpanded = true;
const expandedMainFolders = new Set();
const pendingProjectActions = new Map();
const pendingGroupActions = new Map();
let stopAllBusy = false;
let projectFormDirty = false;
let groupFormDirty = false;
let activeConfirmation = null;
let appVersion = '';

/* ── 界面状态持久化(文件夹展开/目录树展开) ── */
const uiPrefsKey = 'dev-launcher-ui';
function saveUiPrefs() {
  try { localStorage.setItem(uiPrefsKey, JSON.stringify({ expandedFolders: [...expandedMainFolders], rootTree: rootTreeExpanded })); } catch {}
}

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const typeLabels = { maven: 'Maven', gradle: 'Gradle', frontend: '前端' };
const statusLabels = { idle: '未运行', starting: '启动中', running: '运行中', ready: '网页就绪', stopping: '停止中', stop_failed: '停止失败', stopped: '已停止', failed: '启动失败' };
const isActive = (status) => ['starting', 'running', 'ready', 'stopping', 'stop_failed'].includes(status);
const maxRenderedLogLines = 1000;
let pendingLogFrame = 0;
let pendingLogProjectId = null;
let pendingLogLines = [];
let programmaticLogScroll = false;
const iconAliases = {
  'arrow-autofit-down': 'arrow-down-to-line',
  'arrow-bar-to-down': 'arrow-down',
  edit: 'pencil',
  'loader-2': 'loader-circle',
  'player-play': 'play',
  'player-stop': 'square',
  refresh: 'rotate-cw',
  'stack-2': 'layers',
  'terminal-2': 'square-terminal',
  trash: 'trash-2'
};
let iconRenderScheduled = false;
function scheduleIcons() {
  if (iconRenderScheduled) return;
  iconRenderScheduled = true;
  queueMicrotask(() => {
    iconRenderScheduled = false;
    window.lucide?.createIcons({ attrs: { 'aria-hidden': 'true', 'stroke-width': 2 } });
  });
}

/* ── 日志显示偏好(时间戳/换行/级别着色),localStorage 持久化 ── */
const logPrefsKey = 'dev-launcher-log-prefs';
let logPrefs = { time: true, wrap: true, level: true };
try {
  const saved = JSON.parse(localStorage.getItem(logPrefsKey) || '{}');
  logPrefs = { ...logPrefs, ...saved };
} catch {}
function saveLogPrefs() {
  try { localStorage.setItem(logPrefsKey, JSON.stringify(logPrefs)); } catch {}
}
function logLevelClass(line) {
  if (!logPrefs.level || !['stdout', 'stderr'].includes(line.source)) return '';
  if (/(?:^|[\s\[(])(?:ERROR|FATAL|SEVERE)\b|\w*Exception\b|Caused by:/.test(line.text)) return ' level-error';
  if (/(?:^|[\s\[(])WARN(?:ING)?\b/i.test(line.text)) return ' level-warn';
  return '';
}
const icon = (name) => {
  scheduleIcons();
  return `<i data-lucide="${iconAliases[name] || name}" aria-hidden="true"></i>`;
};
const projectIcon = (type) => ({ maven: 'leaf', gradle: 'database', frontend: 'code-xml' }[type] || 'code');

function linkifyLogText(value) {
  const text = String(value ?? '');
  const pattern = /https?:\/\/[\w.-]+(?::\d+)?(?:\/[\w\-./?%&=+#:@~]*)?/gi;
  let cursor = 0;
  let html = '';
  for (const match of text.matchAll(pattern)) {
    const rawUrl = match[0];
    const url = rawUrl.replace(/[),.;'\"]+$/, '');
    const trailing = rawUrl.slice(url.length);
    html += escapeHtml(text.slice(cursor, match.index));
    html += `<button class="log-link" data-action="open-url" data-url="${escapeHtml(url)}" title="在默认浏览器中打开">${escapeHtml(url)}</button>${escapeHtml(trailing)}`;
    cursor = match.index + rawUrl.length;
  }
  return html + escapeHtml(text.slice(cursor));
}

function logLineHtml(line) {
  const time = logPrefs.time ? `<span class="log-time">${new Date(line.time).toLocaleTimeString()}</span>` : '';
  return `<span class="log-line ${escapeHtml(line.source)}${logLevelClass(line)}">${time}<span class="log-source">${line.source === 'stderr' ? 'ERROR' : line.source === 'system' ? 'SYSTEM' : 'OUTPUT'}</span>${linkifyLogText(line.text)}</span>`;
}

function logViewHtml(logs, query = '') {
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = normalizedQuery ? logs.filter((line) => line.text.toLowerCase().includes(normalizedQuery)) : logs;
  if (!filtered.length) {
    if (normalizedQuery) return `<span class="log-line log-empty">没有匹配当前搜索条件的日志。</span>`;
    return `<div class="log-empty-state">${icon('terminal-2')}<strong>还没有日志</strong><span>启动此项目后，它的实时日志会显示在这里，不会混入其他项目的输出。</span></div>`;
  }
  const visible = filtered.slice(-maxRenderedLogLines);
  const notice = filtered.length > visible.length
    ? `<span class="log-line log-notice">为保持流畅，仅显示最近 ${maxRenderedLogLines.toLocaleString()} 条匹配日志；复制操作仍包含全部日志。</span>`
    : '';
  return notice + visible.map(logLineHtml).join('');
}

function renderLogView() {
  const view = $('#logView');
  if (!view || !selectedProjectId) return;
  const query = $('#logSearch')?.value || '';
  view.classList.toggle('no-wrap', !logPrefs.wrap);
  view.classList.toggle('hide-time', !logPrefs.time);
  view.innerHTML = logViewHtml(runtime(selectedProjectId).logs || [], query);
  if (autoScroll && !query.trim()) scrollLogToBottom(view);
}

function scrollLogToBottom(view) {
  // 同步定位到底部:避免 rAF 调度与用户手动滚动产生竞态。
  // 读取 scrollHeight 会触发同步布局,日志按帧批量渲染,开销可接受。
  programmaticLogScroll = true;
  view.scrollTop = view.scrollHeight;
  programmaticLogScroll = false;
}

function updateAutoScrollControl() {
  const button = $('[data-action="toggle-scroll"]');
  if (!button) return;
  button.setAttribute('aria-pressed', String(autoScroll));
  button.innerHTML = `${icon(autoScroll ? 'arrow-autofit-down' : 'arrow-bar-to-down')}自动滚动：${autoScroll ? '开' : '关'}`;
}

function bindLogScrollBehavior() {
  const view = $('#logView');
  if (!view) return;
  view.addEventListener('scroll', () => {
    const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 24;
    if (programmaticLogScroll) {
      // 程序化滚动只屏蔽“仍停留在底部”的滚动事件;
      // 一旦用户滚离底部(含 rAF 被节流而标志未复位的情形),立即解除屏蔽并继续处理。
      if (atBottom) return;
      programmaticLogScroll = false;
    }
    if ($('#logSearch')?.value.trim()) return;
    const nextAutoScroll = atBottom;
    if (nextAutoScroll === autoScroll) return;
    autoScroll = nextAutoScroll;
    updateAutoScrollControl();
  });
}

function appendLogLines(lines) {
  const view = $('#logView');
  if (!view || !lines?.length) return;
  const query = $('#logSearch')?.value || '';
  if (query.trim()) {
    renderLogView();
    return;
  }
  view.querySelector('.log-empty')?.remove();
  view.querySelector('.log-empty-state')?.remove();
  view.insertAdjacentHTML('beforeend', lines.map(logLineHtml).join(''));
  const noticeOffset = view.firstElementChild?.classList.contains('log-notice') ? 1 : 0;
  const excess = view.childElementCount - noticeOffset - maxRenderedLogLines;
  if (excess > 0) {
    for (let index = 0; index < excess; index += 1) {
      const oldest = view.firstElementChild?.classList.contains('log-notice')
        ? view.firstElementChild.nextElementSibling
        : view.firstElementChild;
      oldest?.remove();
    }
    if (!view.querySelector('.log-notice')) {
      view.insertAdjacentHTML('afterbegin', `<span class="log-line log-notice">为保持流畅，仅显示最近 ${maxRenderedLogLines.toLocaleString()} 条日志；复制操作仍包含全部日志。</span>`);
    }
  }
  if (autoScroll) scrollLogToBottom(view);
}

function queueLogLines(projectId, lines) {
  if (!lines?.length || selectedProjectId !== projectId) return;
  if (pendingLogProjectId !== projectId) {
    pendingLogProjectId = projectId;
    pendingLogLines = [];
  }
  pendingLogLines.push(...lines);
  if (pendingLogFrame) return;
  pendingLogFrame = requestAnimationFrame(() => {
    pendingLogFrame = 0;
    const queuedProjectId = pendingLogProjectId;
    const queuedLines = pendingLogLines;
    pendingLogProjectId = null;
    pendingLogLines = [];
    if (selectedProjectId === queuedProjectId) appendLogLines(queuedLines);
  });
}

function projectUrls(project, current) {
  const urlMap = new Map();
  for (const url of [...(project.launch.url ? [project.launch.url] : []), ...(current.urls || [])]) {
    const key = String(url).replace(/\/+$/, '').toLowerCase();
    if (!urlMap.has(key)) urlMap.set(key, url);
  }
  return [...urlMap.values()];
}

function urlRowsHtml(urls) {
  return urls.map((url) => `<div class="url-row"><span title="${escapeHtml(url)}">${escapeHtml(url)}</span><button data-action="copy-url" data-url="${escapeHtml(url)}">${icon('copy')}复制</button><button data-action="open-url" data-url="${escapeHtml(url)}">${icon('external-link')}打开</button></div>`).join('');
}

function updateDetailUrls() {
  const container = $('#urlList');
  const project = state.projects.find((item) => item.id === selectedProjectId);
  if (!container || !project) return;
  const urls = projectUrls(project, runtime(project.id));
  container.classList.toggle('hidden', urls.length === 0);
  container.innerHTML = urlRowsHtml(urls);
}

function updateDetailRuntimeStatus() {
  const project = state.projects.find((item) => item.id === selectedProjectId);
  if (!project) return;
  const status = statusFor(project);
  const dot = $('.project-state-dot');
  if (dot) dot.className = `project-state-dot ${status.key}`;
  const value = $('#detailStatusValue');
  if (value) value.textContent = status.label;
}

function runtime(projectId) {
  return runtimeState.get(projectId) || { projectId, state: 'idle', logs: [], urls: [] };
}

function normalizeFolderPath(value) {
  return String(value || '').replace(/\//g, '\\').replace(/\\+$/, '');
}

// 命令位于项目目录内时只显示相对部分,避免与卡片上的路径重复造成视觉噪音。
function displayCommand(project) {
  const raw = String(project.launch?.command || '未配置');
  const args = (project.launch?.args || []).join(' ');
  const projectPath = normalizeFolderPath(project.path).toLowerCase();
  const commandPath = normalizeFolderPath(raw);
  const command = projectPath && commandPath.toLowerCase().startsWith(`${projectPath}\\`)
    ? commandPath.slice(projectPath.length + 1)
    : raw;
  return `${command} ${args}`.trim();
}

function fullCommand(project) {
  return `${project.launch?.command || '未配置'} ${(project.launch?.args || []).join(' ')}`.trim();
}

function projectFolder(project) {
  const projectPath = normalizeFolderPath(project.path);
  const separator = projectPath.lastIndexOf('\\');
  const folderPath = separator > 0 ? projectPath.slice(0, separator) : projectPath;
  const name = folderPath.split('\\').filter(Boolean).pop() || folderPath || '未分类';
  return { key: `path:${folderPath.toLowerCase()}`, name, path: folderPath };
}

function groupProjects(projects) {
  const groups = new Map();
  for (const project of projects) {
    const folder = projectFolder(project);
    if (!groups.has(folder.key)) groups.set(folder.key, { ...folder, projects: [] });
    groups.get(folder.key).projects.push(project);
  }
  return [...groups.values()].map((folder) => ({
    ...folder,
    projects: folder.projects.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  })).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

function dismissToast(toast) {
  if (!toast.isConnected || toast.classList.contains('toast-out')) return;
  toast.classList.add('toast-out');
  toast.addEventListener('animationend', () => toast.remove(), { once: true });
  // 兜底:reduced-motion 下动画时长被压缩时 animationend 仍会触发,超时双保险。
  setTimeout(() => toast.remove(), 400);
}

function notify(message, kind = '') {
  const toast = document.createElement('div');
  toast.className = `toast ${kind}`;
  toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const content = document.createElement('span');
  content.textContent = message;
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'toast-close';
  closeButton.setAttribute('aria-label', '关闭提示');
  closeButton.innerHTML = icon('x');
  closeButton.addEventListener('click', () => dismissToast(toast));
  toast.append(content, closeButton);
  $('#toastStack').append(toast);
  setTimeout(() => dismissToast(toast), kind === 'error' ? 8000 : 3600);
}

function settleConfirmation(confirmed) {
  if (!activeConfirmation) return;
  const resolve = activeConfirmation;
  activeConfirmation = null;
  $('#confirmDialog').close();
  resolve(confirmed);
}

function requestConfirmation({ title, message, confirmLabel = '确认', danger = true }) {
  if (activeConfirmation) return Promise.resolve(false);
  $('#confirmDialogTitle').textContent = title;
  $('#confirmDialogMessage').textContent = message;
  $('#confirmSubmitBtn').textContent = confirmLabel;
  $('#confirmSubmitBtn').className = `button ${danger ? 'danger-solid' : 'primary'}`;
  $('#confirmDialogIcon').classList.toggle('is-danger', danger);
  $('#confirmDialog').showModal();
  requestAnimationFrame(() => $('#confirmCancelBtn').focus());
  return new Promise((resolve) => { activeConfirmation = resolve; });
}

function isEditorDirty(dialogId) {
  return dialogId === 'projectDialog' ? projectFormDirty : dialogId === 'groupDialog' ? groupFormDirty : false;
}

function setEditorClean(dialogId) {
  if (dialogId === 'projectDialog') projectFormDirty = false;
  if (dialogId === 'groupDialog') groupFormDirty = false;
}

async function closeEditorDialog(dialogId) {
  const dialog = $(`#${dialogId}`);
  if (!dialog?.open) return;
  if (isEditorDirty(dialogId)) {
    const discard = await requestConfirmation({
      title: '放弃未保存的更改？',
      message: '关闭后，本次修改将不会保存。',
      confirmLabel: '放弃更改'
    });
    if (!discard) return;
  }
  setEditorClean(dialogId);
  dialog.close();
}

async function run(action, successMessage) {
  try {
    const result = await action();
    if (successMessage) notify(successMessage, 'success');
    return result;
  } catch (error) {
    notify(error.message || String(error), 'error');
    return null;
  }
}

function updateCounts() {
  const visibleCount = state.projects.filter((project) => !project.hidden).length;
  $('#projectCount').textContent = visibleCount;
  $('#groupCount').textContent = state.groups.length;
  $('#rootCount').textContent = state.roots.length;
  const running = state.projects.filter((project) => isActive(runtime(project.id).state));
  $('#runningCount').textContent = running.length;
  $('#stopAllBtn').disabled = running.length === 0 || stopAllBusy;
  $('#stopAllBtn').setAttribute('aria-busy', String(stopAllBusy));
  $('#stopAllBtn').innerHTML = stopAllBusy ? `${icon('loader-2')}停止中…` : `${icon('player-stop')}全部停止`;
  renderNavigationSidebar(running);
  updateScanControls();
}

function renderNavigationSidebar(runningProjects) {
  const rootTree = $('#sidebarRootTree');
  const rootTreeToggle = $('.root-tree-toggle');
  rootTree.classList.toggle('collapsed', !rootTreeExpanded);
  rootTreeToggle.classList.toggle('tree-collapsed', !rootTreeExpanded);
  rootTreeToggle.setAttribute('aria-expanded', String(rootTreeExpanded));
  rootTreeToggle.setAttribute('aria-label', rootTreeExpanded ? '收起代码目录列表' : '展开代码目录列表');
  rootTreeToggle.title = rootTreeExpanded ? '收起代码目录列表' : '展开代码目录列表';
  rootTree.innerHTML = state.roots.length ? state.roots.map((root) => {
    const normalized = normalizeFolderPath(root.path);
    const name = normalized.split('\\').filter(Boolean).pop() || normalized;
    return `<button class="sidebar-root-item" data-action="open-root-path" data-path="${escapeHtml(root.path)}" title="${escapeHtml(root.path)}">${icon('folder')}<span>${escapeHtml(name)}</span></button>`;
  }).join('') : '<small class="sidebar-tree-empty">尚未添加目录</small>';

  const runningList = $('#sidebarRunningList');
  runningList.innerHTML = runningProjects.length ? runningProjects.map((project) => `<button class="sidebar-running-item ${selectedProjectId === project.id ? 'selected' : ''}" data-action="sidebar-project" data-id="${project.id}"><i></i><span>${escapeHtml(project.name)}</span></button>`).join('') : '<small>暂无运行项目</small>';
}

function setView(view) {
  activeView = view;
  selectedProjectId = null;
  $('#detailPanel').classList.add('hidden');
  $$('.nav-item').forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  const copy = {
    projects: ['全部项目', '集中启动和管理本地开发服务'],
    groups: ['启动组', '一键运行需要共同工作的多个项目'],
    roots: ['代码目录', '管理软件自动扫描的代码位置'],
    settings: ['设置', '应用行为和本地数据说明']
  }[view];
  $('#pageTitle').textContent = copy[0];
  $('#pageSubtitle').textContent = copy[1];
  $('#toolbar').classList.toggle('hidden', view !== 'projects');
  $('#scanBtn').classList.toggle('hidden', !['projects', 'roots'].includes(view));
  $('#addRootBtn').classList.toggle('hidden', !['projects', 'roots'].includes(view));
  renderContent();
  revealContent();
}

function revealContent() {
  // 视图切换时做一次轻量淡入;高频的状态刷新(renderContent)不触发,避免闪烁。
  const content = $('#content');
  if (!content || reducedMotionMedia.matches || typeof content.animate !== 'function') return;
  content.animate(
    [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'translateY(0)' }],
    { duration: 240, easing: 'cubic-bezier(.32, .72, .24, 1)' }
  );
}

function statusFor(project) {
  if (project.missing || !project.launch?.configured) return { key: 'issue', label: project.missing ? '路径失效' : '需要配置' };
  const value = runtime(project.id).state || 'idle';
  return { key: value, label: statusLabels[value] || value };
}

function filteredProjects() {
  const query = $('#searchInput').value.trim().toLowerCase();
  const type = $('#typeFilter').value;
  const status = $('#statusFilter').value;
  return state.projects.filter((project) => {
    if (project.hidden) return false;
    if (query && !`${project.name} ${project.path}`.toLowerCase().includes(query)) return false;
    if (type !== 'all' && project.type !== type) return false;
    const current = statusFor(project).key;
    if (status === 'running' && !isActive(current)) return false;
    if (status === 'idle' && !['idle', 'stopped'].includes(current)) return false;
    if (status === 'issue' && !['issue', 'failed'].includes(current)) return false;
    return true;
  }).sort((a, b) => {
    const activityDifference = Number(isActive(runtime(b.id).state)) - Number(isActive(runtime(a.id).state));
    return activityDifference || a.name.localeCompare(b.name, 'zh-CN');
  });
}

function renderProjects() {
  const projects = filteredProjects();
  if (!state.roots.length) {
    $('#content').innerHTML = `<div class="empty-state"><div><div class="empty-icon">${icon('folder-plus')}</div><h2>添加第一个代码目录</h2><p>选择存放项目的文件夹，Dev Launcher 会自动识别 Maven、Gradle 和前端项目。</p><button class="button primary" data-action="add-root">${icon('folder-plus')}添加代码目录</button></div></div>`;
    return;
  }
  if (!projects.length) {
    const filterActive = Boolean($('#searchInput').value.trim()) || $('#typeFilter').value !== 'all' || $('#statusFilter').value !== 'all';
    $('#content').innerHTML = `<div class="empty-state"><div><div class="empty-icon">${icon('search')}</div><h2>没有找到项目</h2><p>${filterActive ? '当前搜索或筛选条件没有匹配项。' : '暂时没有可显示的项目，可以重新扫描代码目录。'}</p><button class="button ${filterActive ? 'primary' : 'secondary'}" data-action="${filterActive ? 'clear-filters' : 'scan'}">${icon(filterActive ? 'x' : 'refresh')}${filterActive ? '清除筛选' : '重新扫描'}</button></div></div>`;
    return;
  }
  const renderProjectCard = (project, folder) => {
    const current = runtime(project.id);
    const status = statusFor(project);
    const active = isActive(current.state);
    const pendingAction = pendingProjectActions.get(project.id);
    const pendingLabel = { start: '启动中…', stop: '停止中…', restart: '重启中…' }[pendingAction];
    const command = displayCommand(project);
    // 只展示相对路径;与项目名同义(如 BIYESHEJI/Backend 下的 Backend)时省略,减少视觉噪音
    const relativePath = folder && project.path.startsWith(folder.path) ? project.path.slice(folder.path.length).replace(/^[\\/]+/, '') : project.path;
    const subPath = relativePath && relativePath.toLowerCase() !== project.name.toLowerCase() ? relativePath : '';
    const primaryAction = pendingAction
      ? `<button class="action-button ${pendingAction === 'start' ? 'start' : 'stop'}" disabled aria-busy="true">${icon('loader-2')}${pendingLabel}</button>`
      : active
      ? `<button class="action-button stop" data-action="stop" data-id="${project.id}">${icon('player-stop')}停止</button><button class="action-button" aria-label="重启" title="重启" data-action="restart" data-id="${project.id}">${icon('refresh')}</button>`
      : status.key === 'issue'
        ? `<button class="action-button issue" data-action="${project.missing ? 'relocate' : 'edit'}" data-id="${project.id}">${icon(project.missing ? 'map-pin' : 'edit')}${project.missing ? '重新定位' : '完成配置'}</button>`
        : `<button class="action-button start" data-action="start" data-id="${project.id}">${icon('player-play')}启动</button>`;
    return `<article class="project-card ${selectedProjectId === project.id ? 'selected' : ''}" data-project-id="${project.id}">
      <div class="project-main" role="button" tabindex="0" aria-label="打开 ${escapeHtml(project.name)} 项目控制台" data-action="select-project" data-id="${project.id}">
        <div class="project-heading"><h3>${escapeHtml(project.name)}</h3><span class="type-badge ${project.type}">${typeLabels[project.type]}</span><span class="status-badge ${status.key}">${status.label}</span></div>
        ${subPath ? `<p class="project-path" title="${escapeHtml(project.path)}">${escapeHtml(subPath)}</p>` : ''}
        <code class="project-command" title="${escapeHtml(fullCommand(project))}">${escapeHtml(command)}</code>
      </div>
      <div class="project-actions">
        ${primaryAction}
        <button class="action-button" aria-label="编辑配置" title="编辑配置" data-action="edit" data-id="${project.id}">${icon('edit')}</button>
        <button class="action-button" aria-label="打开目录" title="打开目录" data-action="open-path" data-id="${project.id}">${icon('folder-open')}</button>
      </div>
    </article>`;
  };
  const queryActive = Boolean($('#searchInput').value.trim());
  const visibleProjects = state.projects.filter((project) => !project.hidden);
  const runningTotal = visibleProjects.filter((project) => isActive(runtime(project.id).state)).length;
  const issueTotal = visibleProjects.filter((project) => ['issue', 'failed', 'stop_failed'].includes(statusFor(project).key)).length;
  const statsHtml = `<div class="stats-strip"><div class="stat-chip"><strong>${visibleProjects.length}</strong><span>项目</span></div><div class="stat-chip running"><strong>${runningTotal}</strong><span>运行中</span></div><div class="stat-chip issue"><strong>${issueTotal}</strong><span>需处理</span></div></div>`;
  $('#content').innerHTML = `${statsHtml}<div class="folder-list">${groupProjects(projects).map((folder) => {
    const expanded = queryActive || expandedMainFolders.has(folder.key);
    const activeCount = folder.projects.filter((project) => isActive(runtime(project.id).state)).length;
    return `<section class="folder-card ${expanded ? 'expanded' : ''}">
      <button class="main-folder-toggle" aria-expanded="${expanded}" data-action="toggle-main-folder" data-folder-key="${escapeHtml(folder.key)}">
        <span class="main-folder-icon">${icon('folder')}</span><span class="main-folder-copy"><strong>${escapeHtml(folder.name)}</strong><small title="${escapeHtml(folder.path)}">${escapeHtml(folder.path)}</small></span>
        <span class="folder-summary">${folder.projects.length} 个启动项${activeCount ? ` · ${activeCount} 运行中` : ''}</span><span class="main-folder-chevron">${icon('chevron-down')}</span>
      </button>
      <div class="folder-projects">${folder.projects.map((project) => renderProjectCard(project, folder)).join('')}</div>
    </section>`;
  }).join('')}</div>`;
}

function renderGroups() {
  $('#content').innerHTML = `<div class="section-heading"><div><h2>我的启动组</h2><p>组内项目默认并行启动</p></div><button class="button primary" data-action="new-group">${icon('plus')}新建启动组</button></div>
    ${state.groups.length ? `<div class="group-grid">${state.groups.map((group) => {
      const members = group.projectIds.map((id) => state.projects.find((project) => project.id === id)).filter(Boolean);
      const activeCount = members.filter((project) => isActive(runtime(project.id).state)).length;
      const pendingAction = pendingGroupActions.get(group.id);
      const primaryAction = pendingAction
        ? `<button class="button ${pendingAction === 'start' ? 'primary' : 'ghost danger'}" disabled aria-busy="true">${icon('loader-2')}${pendingAction === 'start' ? '启动中…' : '停止中…'}</button>`
        : activeCount
          ? `<button class="button ghost danger" data-action="stop-group" data-id="${group.id}">${icon('player-stop')}停止</button>`
          : `<button class="button primary" data-action="start-group" data-id="${group.id}" ${!members.length ? 'disabled' : ''}>${icon('player-play')}启动全部</button>`;
      return `<article class="group-card"><div class="project-heading"><h3>${escapeHtml(group.name)}</h3><span class="status-badge ${activeCount ? 'running' : 'idle'}">${activeCount}/${members.length} 运行中</span></div><p>${members.length} 个项目</p>
        <div class="member-chips">${members.map((project) => `<span class="member-chip">${escapeHtml(project.name)}</span>`).join('') || '<span class="member-chip">尚未添加项目</span>'}</div>
        <div class="card-footer">${primaryAction}<button class="button secondary" data-action="edit-group" data-id="${group.id}" ${pendingAction ? 'disabled' : ''}>${icon('edit')}编辑</button><button class="button ghost danger" data-action="remove-group" data-id="${group.id}" ${pendingAction ? 'disabled' : ''}>${icon('trash')}删除</button></div></article>`;
    }).join('')}</div>` : `<div class="empty-state"><div><div class="empty-icon">${icon('stack-2')}</div><h2>还没有启动组</h2><p>把需要一起运行的前端和后端项目组合起来。</p><button class="button primary" data-action="new-group">${icon('plus')}新建启动组</button></div></div>`}`;
}

function renderRoots() {
  $('#content').innerHTML = `<div class="section-heading"><div><h2>扫描位置</h2><p>只会扫描你主动添加的目录</p></div></div>${state.roots.length ? `<div class="root-list">${state.roots.map((root) => `<article class="root-card"><div><h3 class="root-path">${escapeHtml(root.path)}</h3><p class="root-meta">${root.status === 'scanning' ? `正在扫描 · ${root.directoriesScanned || 0} 个目录` : root.lastScannedAt ? `上次扫描：${new Date(root.lastScannedAt).toLocaleString()}` : '尚未扫描'}</p>${root.error ? `<p class="root-error">${escapeHtml(root.error)}</p>` : ''}</div><button class="button ghost danger" data-action="remove-root" data-id="${root.id}">${icon('trash')}移除</button></article>`).join('')}</div>` : `<div class="empty-state"><div><div class="empty-icon">${icon('folder-code')}</div><h2>暂无代码目录</h2><p>添加代码根目录后，软件会在后台递归发现项目。</p><button class="button primary" data-action="add-root">${icon('folder-plus')}添加代码目录</button></div></div>`}`;
}

function renderSettings() {
  const hiddenProjects = state.projects.filter((project) => project.hidden);
  $('#content').innerHTML = `<div class="settings-layout">
    <div class="settings-card">
      <div class="settings-section-title"><div><h2>应用行为</h2><p>这些设置会立即保存到本机</p></div></div>
      <label class="settings-row settings-interactive"><span class="settings-copy"><strong>关闭主窗口</strong><small>关闭时缩小到系统托盘，项目继续运行</small></span><input type="checkbox" data-setting="closeToTray" ${state.settings.closeToTray ? 'checked' : ''}></label>
      <label class="settings-row settings-interactive"><span class="settings-copy"><strong>日志保留上限</strong><small>达到上限后自动移除最早的日志</small></span><select data-setting="maxLogLines">${[1000, 5000, 10000, 20000].map((value) => `<option value="${value}" ${Number(state.settings.maxLogLines) === value ? 'selected' : ''}>${value.toLocaleString()} 行 / 项目</option>`).join('')}</select></label>
      <div class="settings-row"><span class="settings-copy"><strong>项目分类</strong><small>按启动项所在的直接父文件夹分组</small></span><span>自动分组</span></div>
      <div class="settings-row"><span class="settings-copy"><strong>本地数据与环境变量</strong><small>配置仅保存在本机，环境变量使用 Windows 当前用户范围加密</small></span><span>受保护</span></div>
      <div class="settings-row"><span class="settings-copy"><strong>版本</strong><small>当前安装版本</small></span><span>Dev Launcher ${escapeHtml(appVersion)}</span></div>
      <div class="card-footer"><button class="button ghost danger" data-action="quit">停止项目并退出软件</button></div>
    </div>
    <div class="settings-card">
      <div class="settings-section-title"><div><h2>隐藏项目</h2><p>恢复后会重新出现在全部项目列表中</p></div><strong>${hiddenProjects.length}</strong></div>
      ${hiddenProjects.length ? `<div class="hidden-project-list">${hiddenProjects.map((project) => `<div class="hidden-project-row"><div><strong>${escapeHtml(project.name)}</strong><small title="${escapeHtml(project.path)}">${escapeHtml(project.path)}</small></div><button class="button secondary small" data-action="unhide-project" data-id="${project.id}">恢复显示</button></div>`).join('')}</div>` : '<p class="settings-empty">当前没有隐藏项目。</p>'}
    </div>
  </div>`;
}

function renderContent() {
  ({ projects: renderProjects, groups: renderGroups, roots: renderRoots, settings: renderSettings })[activeView]();
  updateCounts();
}

function renderDetail() {
  const panel = $('#detailPanel');
  const project = state.projects.find((item) => item.id === selectedProjectId);
  if (!project) { panel.classList.add('hidden'); return; }
  const current = runtime(project.id);
  const status = statusFor(project);
  const urls = projectUrls(project, current);
  const previousSearch = $('#logSearch');
  const logQuery = previousSearch?.value || '';
  const restoreSearchFocus = document.activeElement === previousSearch;
  const selectionStart = previousSearch?.selectionStart;
  const selectionEnd = previousSearch?.selectionEnd;
  panel.classList.remove('hidden');
  const active = isActive(current.state);
  const pendingAction = pendingProjectActions.get(project.id);
  const pendingLabel = { start: '启动中…', stop: '停止中…', restart: '重启中…' }[pendingAction];
  const hasLogs = Boolean(current.logs?.length);
  const command = displayCommand(project);
  const primaryAction = pendingAction
    ? `<button class="button primary detail-primary" disabled aria-busy="true">${icon('loader-2')}${pendingLabel}</button>`
    : active
    ? `<button class="button primary detail-primary" data-action="stop" data-id="${project.id}">${icon('player-stop')}停止</button>`
    : status.key === 'issue'
      ? `<button class="button primary detail-primary" data-action="${project.missing ? 'relocate' : 'edit'}" data-id="${project.id}">${icon(project.missing ? 'map-pin' : 'edit')}${project.missing ? '重新定位' : '完成配置'}</button>`
      : `<button class="button primary detail-primary" data-action="start" data-id="${project.id}">${icon('player-play')}启动</button>`;
  panel.innerHTML = `<div class="detail-header"><div class="detail-title-row">
      <div class="detail-title-main"><div class="detail-kicker"><span class="project-state-dot ${status.key}"></span><h2>${escapeHtml(project.name)}</h2><span class="type-badge ${project.type}">${typeLabels[project.type]}</span></div><p class="detail-path" title="${escapeHtml(project.path)}">${escapeHtml(project.path)}</p></div>
      <div class="detail-header-actions">${primaryAction}<button class="icon-button" data-action="close-detail" aria-label="关闭项目详情" title="关闭">${icon('x')}</button></div>
    </div>
    <div class="detail-meta">
      <div class="detail-meta-item">${icon('terminal-2')}<div><strong>启动命令</strong><small title="${escapeHtml(fullCommand(project))}">${escapeHtml(command)}</small></div></div>
      <div class="detail-meta-item">${icon('folder')}<div><strong>工作目录</strong><small title="${escapeHtml(project.launch?.workingDirectory || project.path)}">${escapeHtml(project.launch?.workingDirectory || project.path)}</small></div></div>
      <div class="detail-meta-item">${icon('activity')}<div><strong>运行状态</strong><small id="detailStatusValue">${status.label}</small></div></div>
    </div>
    <div class="detail-secondary-actions">${active ? `<button class="button secondary" data-action="restart" data-id="${project.id}" ${pendingAction ? 'disabled' : ''}>${icon('refresh')}重新启动</button>` : ''}<button class="button secondary" data-action="edit" data-id="${project.id}">${icon('edit')}编辑配置</button><button class="button secondary" data-action="open-path" data-id="${project.id}">${icon('folder-open')}打开目录</button>${project.missing ? `<button class="button secondary" data-action="relocate" data-id="${project.id}">${icon('map-pin')}重新定位</button>` : ''}</div></div>
    <div id="urlList" class="url-list ${urls.length ? '' : 'hidden'}">${urlRowsHtml(urls)}</div>
    <div class="log-toolbar"><label class="log-search">${icon('search')}<input id="logSearch" placeholder="搜索当前日志" value="${escapeHtml(logQuery)}" aria-label="搜索当前日志"></label><button data-action="toggle-scroll" aria-pressed="${autoScroll}" title="自动滚动新日志">${icon(autoScroll ? 'arrow-autofit-down' : 'arrow-bar-to-down')}自动滚动：${autoScroll ? '开' : '关'}</button><button data-action="toggle-log-time" aria-pressed="${logPrefs.time}" title="显示或隐藏时间戳">${icon('clock')}时间戳</button><button data-action="toggle-log-wrap" aria-pressed="${logPrefs.wrap}" title="超长日志自动换行">${icon('wrap-text')}换行</button><button data-action="toggle-log-level" aria-pressed="${logPrefs.level}" title="按日志级别着色">${icon('highlighter')}级别</button><button data-action="copy-logs" ${hasLogs ? '' : 'disabled'}>${icon('copy')}复制</button><button data-action="clear-logs" data-id="${project.id}" ${hasLogs ? '' : 'disabled'}>${icon('trash')}清空</button></div>
    <pre id="logView" class="log-view ${logPrefs.wrap ? '' : 'no-wrap'} ${logPrefs.time ? '' : 'hide-time'}">${logViewHtml(current.logs || [], logQuery)}</pre>`;
  bindLogScrollBehavior();
  if (restoreSearchFocus) {
    const nextSearch = $('#logSearch');
    nextSearch?.focus();
    if (selectionStart !== null && selectionStart !== undefined) nextSearch?.setSelectionRange(selectionStart, selectionEnd ?? selectionStart);
  }
  if (autoScroll && !logQuery.trim()) { const log = $('#logView'); if (log) scrollLogToBottom(log); }
}

async function selectProject(projectId) {
  const previousSelected = selectedProjectId;
  selectedProjectId = projectId;
  // 释放上一个选中项目的日志缓存,只保留当前项目的日志正文。
  if (previousSelected && previousSelected !== projectId) {
    const stale = runtimeState.get(previousSelected);
    if (stale?.logs?.length) runtimeState.set(previousSelected, { ...stale, logs: [] });
  }
  const snapshot = await run(() => api.getSnapshot(projectId));
  if (snapshot) runtimeState.set(projectId, snapshot);
  renderProjects();
  renderDetail();
  updateCounts();
}

async function openProjectConsole(projectId) {
  const project = state.projects.find((item) => item.id === projectId);
  if (project) expandedMainFolders.add(projectFolder(project).key);
  if (activeView !== 'projects') setView('projects');
  await selectProject(projectId);
}

async function performProjectAction(action, projectId) {
  if (pendingProjectActions.has(projectId)) return;
  pendingProjectActions.set(projectId, action);
  if (activeView === 'projects') renderProjects();
  if (selectedProjectId === projectId) renderDetail();
  try {
    if (action === 'start' || action === 'restart') await openProjectConsole(projectId);
    else {
      if (activeView === 'projects') renderProjects();
      if (selectedProjectId === projectId) renderDetail();
    }
    const operation = action === 'start'
      ? () => api.startProject(projectId)
      : action === 'stop'
        ? () => api.stopProject(projectId)
        : () => api.restartProject(projectId);
    await run(operation);
  } finally {
    pendingProjectActions.delete(projectId);
    if (activeView === 'projects') renderProjects();
    if (selectedProjectId === projectId) renderDetail();
  }
}

async function performGroupAction(action, groupId) {
  if (pendingGroupActions.has(groupId)) return;
  pendingGroupActions.set(groupId, action);
  if (activeView === 'groups') renderGroups();
  try {
    await run(action === 'start' ? () => api.startGroup(groupId) : () => api.stopGroup(groupId), action === 'start' ? '启动组已执行' : undefined);
  } finally {
    pendingGroupActions.delete(groupId);
    if (activeView === 'groups') renderGroups();
  }
}

function addEnvRow(key = '', value = '') {
  const row = document.createElement('div');
  row.className = 'env-row';
  row.innerHTML = `<input class="env-key" placeholder="变量名" value="${escapeHtml(key)}"><input class="env-value" type="password" placeholder="变量值" value="${escapeHtml(value)}"><button type="button" data-env-action="reveal" aria-label="显示或遮挡" title="显示或遮挡">${icon('eye')}</button><button type="button" data-env-action="remove" aria-label="删除变量" title="删除">${icon('trash')}</button>`;
  $('#envRows').append(row);
}

function openProjectEditor(projectId) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return;
  $('#editProjectId').value = project.id;
  $('#editName').value = project.name;
  $('#editPath').value = project.path;
  $('#editWorkingDirectory').value = project.launch.workingDirectory || project.path;
  $('#editCommand').value = project.launch.command || '';
  $('#editArgs').value = (project.launch.args || []).map((arg) => /\s/.test(arg) ? `"${arg}"` : arg).join(' ');
  $('#editUrl').value = project.launch.url || '';
  $('#editEncoding').value = project.launch.encoding || 'auto';
  $('#editVisible').checked = !project.hidden;
  $('#restoreProjectBtn').disabled = !project.userModified;
  $('#envRows').innerHTML = '';
  Object.entries(project.launch.env || {}).forEach(([key, value]) => addEnvRow(key, value));
  projectFormDirty = false;
  $('#projectDialog').showModal();
}

function openGroupEditor(groupId = '') {
  const group = state.groups.find((item) => item.id === groupId);
  $('#groupDialogTitle').textContent = group ? '编辑启动组' : '新建启动组';
  $('#editGroupId').value = group?.id || '';
  $('#editGroupName').value = group?.name || '';
  $('#groupProjectError').classList.add('hidden');
  $('#groupProjectList').innerHTML = state.projects.filter((project) => !project.hidden).map((project) => `<label class="check-item"><input type="checkbox" value="${project.id}" ${group?.projectIds.includes(project.id) ? 'checked' : ''}><span>${escapeHtml(project.name)}</span><small>${typeLabels[project.type]}</small></label>`).join('') || '<div class="check-item">请先添加并扫描代码目录</div>';
  groupFormDirty = false;
  $('#groupDialog').showModal();
}

function updateScanControls() {
  $('#addRootBtn').disabled = scanBusy;
  $('#scanBtn').disabled = scanBusy || !state.roots.length;
  $('#addRootBtn').setAttribute('aria-busy', String(scanBusy && scanBusyAction === 'add-root'));
  $('#scanBtn').setAttribute('aria-busy', String(scanBusy && scanBusyAction === 'scan'));
  $('#addRootBtn').innerHTML = scanBusy && scanBusyAction === 'add-root'
    ? `${icon('loader-2')}选择并扫描中…`
    : `${icon('folder-plus')}添加代码目录`;
  $('#scanBtn').innerHTML = scanBusy && scanBusyAction === 'scan'
    ? `${icon('loader-2')}扫描中…`
    : `${icon('refresh')}重新扫描`;
}

async function addRoot() {
  if (scanBusy) return;
  scanBusy = true;
  scanBusyAction = 'add-root';
  updateScanControls();
  try {
    const result = await run(() => api.addRoot());
    if (result?.status === 'completed') notify(`目录扫描完成，发现 ${result.projectsFound} 个项目。`, 'success');
    else if (result?.status === 'failed') notify(`目录扫描失败：${result.error}`, 'error');
  } finally {
    scanBusy = false;
    scanBusyAction = '';
    updateScanControls();
  }
}

async function scanAll() {
  if (scanBusy || !state.roots.length) return;
  scanBusy = true;
  scanBusyAction = 'scan';
  updateScanControls();
  try {
    const result = await run(() => api.scanAll());
    const failures = result?.results?.filter((item) => item.status === 'failed') || [];
    if (result?.status === 'completed') notify('所有代码目录扫描完成。', 'success');
    else if (result?.status === 'partial') notify(`${failures.length} 个目录扫描失败，请在“代码目录”中查看详情。`, 'error');
  } finally {
    scanBusy = false;
    scanBusyAction = '';
    updateScanControls();
  }
}

document.addEventListener('click', async (event) => {
  const close = event.target.closest('[data-close]');
  if (close) { await closeEditorDialog(close.dataset.close); return; }
  const envAction = event.target.closest('[data-env-action]');
  if (envAction) {
    const row = envAction.closest('.env-row');
    if (envAction.dataset.envAction === 'remove') { row.remove(); projectFormDirty = true; }
    else {
      const input = row.querySelector('.env-value');
      const reveal = input.type === 'password';
      input.type = reveal ? 'text' : 'password';
      envAction.setAttribute('aria-label', reveal ? '遮挡变量值' : '显示变量值');
      envAction.title = reveal ? '遮挡变量值' : '显示变量值';
    }
    return;
  }
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const { action, id } = target.dataset;
  if (action === 'add-root') await addRoot();
  else if (action === 'scan') await scanAll();
  else if (action === 'toggle-root-tree') { rootTreeExpanded = !rootTreeExpanded; saveUiPrefs(); updateCounts(); }
  else if (action === 'clear-filters') {
    $('#searchInput').value = '';
    $('#typeFilter').value = 'all';
    $('#statusFilter').value = 'all';
    renderProjects();
    $('#searchInput').focus();
  }
  else if (action === 'toggle-main-folder') {
    const key = target.dataset.folderKey;
    if (expandedMainFolders.has(key)) expandedMainFolders.delete(key); else expandedMainFolders.add(key);
    saveUiPrefs();
    renderProjects();
  }
  else if (action === 'select-project' || action === 'sidebar-project') await openProjectConsole(id);
  else if (action === 'start' || action === 'stop' || action === 'restart') await performProjectAction(action, id);
  else if (action === 'edit') openProjectEditor(id);
  else if (action === 'open-path') { const project = state.projects.find((item) => item.id === id); if (project) await run(() => api.openPath(project.path)); }
  else if (action === 'open-root-path') await run(() => api.openPath(target.dataset.path));
  else if (action === 'relocate') await run(() => api.relocateProject(id), '项目目录已更新');
  else if (action === 'unhide-project') await run(() => api.updateProject(id, { hidden: false }), '项目已恢复显示');
  else if (action === 'close-detail') { selectedProjectId = null; $('#detailPanel').classList.add('hidden'); renderContent(); }
  else if (action === 'open-url') await run(() => api.openUrl(target.dataset.url));
  else if (action === 'copy-url') await run(() => api.copyText(target.dataset.url), '地址已复制');
  else if (action === 'copy-logs') {
    const logs = runtime(selectedProjectId).logs.map((line) => `[${line.time}] ${line.text}`).join('\n');
    if (logs) await run(() => api.copyText(logs), '日志已复制');
  }
  else if (action === 'clear-logs') {
    const confirmed = await requestConfirmation({ title: '清空项目日志？', message: '清空后无法恢复，但不会影响正在运行的项目。', confirmLabel: '清空日志' });
    if (confirmed) await run(() => api.clearLogs(id));
  }
  else if (action === 'toggle-scroll') { autoScroll = !autoScroll; renderDetail(); }
  else if (action === 'toggle-log-time') { logPrefs.time = !logPrefs.time; saveLogPrefs(); renderDetail(); }
  else if (action === 'toggle-log-wrap') { logPrefs.wrap = !logPrefs.wrap; saveLogPrefs(); renderDetail(); }
  else if (action === 'toggle-log-level') { logPrefs.level = !logPrefs.level; saveLogPrefs(); renderDetail(); }
  else if (action === 'new-group') openGroupEditor();
  else if (action === 'edit-group') openGroupEditor(id);
  else if (action === 'start-group') await performGroupAction('start', id);
  else if (action === 'stop-group') {
    const shared = state.groups.filter((group) => group.id !== id && group.projectIds.some((projectId) => state.groups.find((g) => g.id === id)?.projectIds.includes(projectId)));
    if (shared.length) {
      const confirmed = await requestConfirmation({ title: '停止共享项目？', message: `部分项目也属于其他启动组（${shared.map((g) => g.name).join('、')}）。停止后，这些启动组也会受到影响。`, confirmLabel: '仍然停止' });
      if (!confirmed) return;
    }
    await performGroupAction('stop', id);
  }
  else if (action === 'remove-group') {
    const confirmed = await requestConfirmation({ title: '删除启动组？', message: '项目本身和启动配置都会保留。', confirmLabel: '删除启动组' });
    if (confirmed) await run(() => api.removeGroup(id));
  }
  else if (action === 'remove-root') {
    const confirmed = await requestConfirmation({ title: '移除代码目录？', message: '已发现的项目会保留；路径失效时，项目列表会显示处理提示。', confirmLabel: '移除目录' });
    if (confirmed) { const next = await run(() => api.removeRoot(id)); if (next) { state = next; renderContent(); } }
  }
  else if (action === 'quit') await api.quit();
});

document.addEventListener('keydown', (event) => {
  const projectMain = event.target.closest('.project-main[role="button"]');
  if (!projectMain || !['Enter', ' '].includes(event.key)) return;
  event.preventDefault();
  projectMain.click();
});

document.addEventListener('change', async (event) => {
  const control = event.target.closest('[data-setting]');
  if (!control) return;
  const patch = control.dataset.setting === 'closeToTray'
    ? { closeToTray: control.checked }
    : { maxLogLines: Number(control.value) };
  const settings = await run(() => api.updateSettings(patch), '设置已保存');
  if (settings) state.settings = settings;
  else renderSettings();
});

$('#mainNav').addEventListener('click', (event) => { const button = event.target.closest('[data-view]'); if (button) setView(button.dataset.view); });
$('#addRootBtn').addEventListener('click', addRoot);
$('#scanBtn').addEventListener('click', scanAll);
async function stopAllProjects() {
  const confirmed = await requestConfirmation({ title: '停止所有项目？', message: '所有正在运行的项目及其子进程都会停止。', confirmLabel: '全部停止' });
  if (!confirmed) return;
  stopAllBusy = true;
  updateCounts();
  try { await run(() => api.stopAll()); }
  finally { stopAllBusy = false; updateCounts(); }
}
$('#stopAllBtn').addEventListener('click', stopAllProjects);
['searchInput', 'typeFilter', 'statusFilter'].forEach((id) => $(`#${id}`).addEventListener('input', renderProjects));
$('#addEnvBtn').addEventListener('click', () => { addEnvRow(); projectFormDirty = true; });

$('#confirmCancelBtn').addEventListener('click', () => settleConfirmation(false));
$('#confirmSubmitBtn').addEventListener('click', () => settleConfirmation(true));
$('#confirmDialog').addEventListener('cancel', (event) => { event.preventDefault(); settleConfirmation(false); });

for (const dialogId of ['projectDialog', 'groupDialog']) {
  $(`#${dialogId}`).addEventListener('cancel', (event) => {
    event.preventDefault();
    void closeEditorDialog(dialogId);
  });
}

$('#projectForm').addEventListener('input', () => { projectFormDirty = true; });
$('#projectForm').addEventListener('change', () => { projectFormDirty = true; });
$('#groupForm').addEventListener('input', () => { groupFormDirty = true; });
$('#groupForm').addEventListener('change', () => { groupFormDirty = true; });

$('#projectForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const env = {};
  $$('#envRows .env-row').forEach((row) => { const key = row.querySelector('.env-key').value.trim(); if (key) env[key] = row.querySelector('.env-value').value; });
  const projectId = $('#editProjectId').value;
  const result = await run(() => api.updateProject(projectId, {
    name: $('#editName').value,
    hidden: !$('#editVisible').checked,
    launch: { command: $('#editCommand').value.trim(), argsText: $('#editArgs').value, workingDirectory: $('#editWorkingDirectory').value.trim(), env, url: $('#editUrl').value.trim(), encoding: $('#editEncoding').value, configured: Boolean($('#editCommand').value.trim()) }
  }), '启动配置已保存');
  if (result) { projectFormDirty = false; $('#projectDialog').close(); }
});

$('#restoreProjectBtn').addEventListener('click', async () => {
  const projectId = $('#editProjectId').value;
  const confirmed = await requestConfirmation({ title: '恢复自动配置？', message: '当前自定义的启动命令、参数、工作目录、网址和环境变量会被自动识别结果覆盖。', confirmLabel: '恢复自动配置' });
  if (!confirmed) return;
  const result = await run(() => api.restoreProject(projectId), '已恢复自动配置');
  if (result) { projectFormDirty = false; $('#projectDialog').close(); setTimeout(() => openProjectEditor(projectId), 0); }
});

$('#groupForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const selectedProjects = $$('#groupProjectList input:checked');
  if (!selectedProjects.length) {
    $('#groupProjectError').classList.remove('hidden');
    $('#groupProjectList input')?.focus();
    return;
  }
  $('#groupProjectError').classList.add('hidden');
  const result = await run(() => api.saveGroup({ id: $('#editGroupId').value || undefined, name: $('#editGroupName').value, projectIds: selectedProjects.map((input) => input.value) }), '启动组已保存');
  if (result) { groupFormDirty = false; $('#groupDialog').close(); }
});

$('#groupProjectList').addEventListener('change', () => {
  if ($('#groupProjectList input:checked')) $('#groupProjectError').classList.add('hidden');
});

document.addEventListener('input', (event) => { if (event.target.id === 'logSearch') renderLogView(); });

api.onStateChanged((nextState) => { state = nextState; renderContent(); if (selectedProjectId) renderDetail(); });
api.onScanProgress((progress) => {
  const root = state.roots.find((item) => item.id === progress.rootId);
  if (root) { root.status = progress.complete ? 'ready' : 'scanning'; root.directoriesScanned = progress.directoriesScanned; if (activeView === 'roots') renderRoots(); }
});
api.onProcessUpdate((update) => {
  const previous = runtime(update.projectId);
  // 只为当前选中的项目缓存日志正文;其余项目仅保留状态/地址等元信息,
  // 避免多项目长跑时几十万行日志常驻渲染进程内存。选中时通过 getSnapshot 拉取。
  const isSelected = update.projectId === selectedProjectId;
  if (update.event === 'log') {
    const incoming = Array.isArray(update.lines) ? update.lines : [];
    let logs = previous.logs || [];
    if (isSelected) {
      const limit = Number(state.settings.maxLogLines || 10000);
      logs = [...logs, ...incoming];
      if (logs.length > limit) logs.splice(0, logs.length - limit);
    }
    const next = {
      ...previous,
      ...update.snapshot,
      logs,
      urls: update.urls || update.snapshot?.urls || previous.urls || []
    };
    runtimeState.set(update.projectId, next);
    const stateChanged = previous.state !== next.state;
    if (stateChanged) {
      updateCounts();
      if (activeView === 'projects') renderProjects();
      else if (activeView === 'groups') renderGroups();
    }
    if (isSelected) {
      if (stateChanged) updateDetailRuntimeStatus();
      const previousUrls = previous.urls || [];
      const nextUrls = next.urls || [];
      if (previousUrls.length !== nextUrls.length || previousUrls.some((url, index) => url !== nextUrls[index])) updateDetailUrls();
      queueLogLines(update.projectId, incoming);
    }
    return;
  }
  runtimeState.set(update.projectId, { ...previous, ...update.snapshot, logs: isSelected ? (update.snapshot?.logs || []) : [] });
  updateCounts();
  if (activeView === 'projects') renderProjects();
  else if (activeView === 'groups') renderGroups();
  if (isSelected) renderDetail();
});
api.onStaleSession((session) => notify(`上次异常关闭时可能仍有 ${session.running?.length || 0} 个项目进程，请检查端口占用。`, 'error'));
api.onWindowMaximizedChanged((maximized) => document.body.classList.toggle('is-maximized', maximized));

/* ── 命令面板 (Ctrl+K) ─────────────────────── */
let paletteOpen = false;
let paletteIndex = 0;
let paletteItems = [];

function paletteCandidateItems() {
  const items = [];
  for (const project of state.projects.filter((item) => !item.hidden)) {
    const status = statusFor(project);
    const active = isActive(runtime(project.id).state);
    items.push({
      icon: projectIcon(project.type),
      title: project.name,
      subtitle: project.path,
      badge: status.label,
      keywords: `${project.name} ${project.path} ${typeLabels[project.type] || ''}`.toLowerCase(),
      action: () => openProjectConsole(project.id)
    });
    if (active) {
      items.push({ icon: 'player-stop', title: `停止 ${project.name}`, subtitle: project.path, badge: '', keywords: `停止 stop ${project.name}`.toLowerCase(), action: () => performProjectAction('stop', project.id) });
    } else if (status.key !== 'issue') {
      items.push({ icon: 'player-play', title: `启动 ${project.name}`, subtitle: project.path, badge: '', keywords: `启动 start ${project.name}`.toLowerCase(), action: () => performProjectAction('start', project.id) });
    }
  }
  items.push(
    { icon: 'refresh', title: '重新扫描所有代码目录', subtitle: '', badge: '', keywords: '重新扫描 scan rescan', action: () => scanAll() },
    { icon: 'player-stop', title: '停止所有项目', subtitle: '', badge: '', keywords: '全部停止 stop all', action: () => stopAllProjects() },
    { icon: 'folder-plus', title: '添加代码目录', subtitle: '', badge: '', keywords: '添加代码目录 add root', action: () => addRoot() },
    { icon: 'stack-2', title: '打开启动组', subtitle: '', badge: '', keywords: '启动组 groups', action: () => setView('groups') },
    { icon: 'settings', title: '打开设置', subtitle: '', badge: '', keywords: '设置 settings', action: () => setView('settings') },
    { icon: 'moon', title: '切换浅色 / 深色主题', subtitle: '', badge: '', keywords: '主题 theme 深色 浅色 dark light', action: () => toggleTheme() }
  );
  return items;
}

function renderPalette() {
  const list = $('#paletteList');
  if (!list) return;
  const query = $('#paletteInput').value.trim().toLowerCase();
  paletteItems = paletteCandidateItems().filter((item) => !query || item.keywords.includes(query));
  paletteIndex = Math.max(0, Math.min(paletteIndex, paletteItems.length - 1));
  list.innerHTML = paletteItems.length
    ? paletteItems.map((item, index) => `<button class="palette-item ${index === paletteIndex ? 'active' : ''}" data-palette-index="${index}" role="option" aria-selected="${index === paletteIndex}">${icon(item.icon)}<span class="palette-item-copy"><strong>${escapeHtml(item.title)}</strong>${item.subtitle ? `<small>${escapeHtml(item.subtitle)}</small>` : ''}</span>${item.badge ? `<span class="palette-badge">${escapeHtml(item.badge)}</span>` : '<span></span>'}</button>`).join('')
    : '<div class="palette-empty">没有匹配的命令或项目</div>';
  list.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' });
}

function openPalette() {
  if (paletteOpen) return;
  paletteOpen = true;
  paletteIndex = 0;
  $('#paletteInput').value = '';
  $('#paletteOverlay').classList.remove('hidden');
  renderPalette();
  $('#paletteInput').focus();
}

function closePalette() {
  if (!paletteOpen) return;
  paletteOpen = false;
  $('#paletteOverlay').classList.add('hidden');
}

function runPaletteItem(index) {
  const item = paletteItems[index];
  if (!item) return;
  closePalette();
  item.action();
}

$('#paletteOverlay').addEventListener('click', (event) => {
  if (event.target.id === 'paletteOverlay') { closePalette(); return; }
  const item = event.target.closest('[data-palette-index]');
  if (item) runPaletteItem(Number(item.dataset.paletteIndex));
});
$('#paletteInput').addEventListener('input', () => { paletteIndex = 0; renderPalette(); });
$('#paletteInput').addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') { event.preventDefault(); paletteIndex = Math.min(paletteIndex + 1, paletteItems.length - 1); renderPalette(); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); paletteIndex = Math.max(paletteIndex - 1, 0); renderPalette(); }
  else if (event.key === 'Enter') { event.preventDefault(); runPaletteItem(paletteIndex); }
  else if (event.key === 'Escape') { event.preventDefault(); closePalette(); }
});
document.addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && key === 'k') {
    event.preventDefault();
    if (paletteOpen) closePalette(); else openPalette();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && key === 'f' && activeView === 'projects' && !paletteOpen) {
    event.preventDefault();
    $('#searchInput').focus();
    $('#searchInput').select();
    return;
  }
  if (event.key === 'Escape' && paletteOpen) closePalette();
});

const themeStorageKey = 'dev-launcher-theme';
const themeMedia = window.matchMedia('(prefers-color-scheme: dark)');
const reducedMotionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
const themeToggle = $('#themeToggle');
const themeTransitionLayer = $('#themeTransitionLayer');
let themeAnimationInProgress = false;

function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function updateThemeToggle() {
  const targetLabel = currentTheme() === 'dark' ? '切换到浅色模式' : '切换到暗黑模式';
  themeToggle.setAttribute('aria-label', targetLabel);
  themeToggle.title = targetLabel;
}

function commitTheme(theme, persist = true) {
  document.documentElement.dataset.theme = theme;
  if (persist) localStorage.setItem(themeStorageKey, theme);
  updateThemeToggle();
  // 同步到主进程持久化,下次启动时窗口底色直接匹配,避免深色主题白闪。
  api.updateSettings({ theme }).catch(() => {});
}

async function toggleTheme() {
  if (themeAnimationInProgress) return;
  const nextTheme = currentTheme() === 'dark' ? 'light' : 'dark';
  if (reducedMotionMedia.matches) {
    commitTheme(nextTheme);
    return;
  }

  themeAnimationInProgress = true;
  themeToggle.setAttribute('aria-busy', 'true');
  themeTransitionLayer.className = `theme-transition-layer to-${nextTheme}`;
  void themeTransitionLayer.offsetWidth;
  themeTransitionLayer.classList.add('is-visible');
  await new Promise((resolve) => setTimeout(resolve, 110));
  commitTheme(nextTheme);
  themeTransitionLayer.classList.add('is-revealing');
  themeTransitionLayer.classList.remove('is-visible');
  await new Promise((resolve) => setTimeout(resolve, 190));
  themeTransitionLayer.className = 'theme-transition-layer';
  themeToggle.removeAttribute('aria-busy');
  themeAnimationInProgress = false;
}

themeToggle.addEventListener('click', toggleTheme);
themeMedia.addEventListener('change', (event) => {
  if (!localStorage.getItem(themeStorageKey)) commitTheme(event.matches ? 'dark' : 'light', false);
});
updateThemeToggle();

$$('[data-window-control]').forEach((button) => button.addEventListener('click', () => {
  const control = button.dataset.windowControl;
  if (control === 'close') api.closeWindow();
  else if (control === 'minimize') api.minimizeWindow();
  else api.toggleMaximizeWindow();
}));
$('#windowTitlebar').addEventListener('dblclick', (event) => {
  if (!event.target.closest('button')) api.toggleMaximizeWindow();
});

(async function init() {
  const initial = await run(() => api.getState());
  if (!initial) return;
  state = initial;
  appVersion = initial.appVersion || '';
  // 让主进程记录当前主题,作为下次启动时的窗口底色。
  if ((initial.settings?.theme || '') !== currentTheme()) api.updateSettings({ theme: currentTheme() }).catch(() => {});
  // 恢复上次会话的文件夹/目录树展开状态。
  try {
    const uiPrefs = JSON.parse(localStorage.getItem(uiPrefsKey) || '{}');
    if (Array.isArray(uiPrefs.expandedFolders)) uiPrefs.expandedFolders.forEach((key) => expandedMainFolders.add(key));
    if (typeof uiPrefs.rootTree === 'boolean') rootTreeExpanded = uiPrefs.rootTree;
  } catch {}
  if (initial.storageStatus?.status === 'recovered') notify('主配置文件无法读取，已自动从备份恢复。', 'error');
  else if (initial.storageStatus?.status === 'reset') notify('配置文件无法读取，已进入安全空白状态；原文件会被保留。', 'error');
  // 初始快照只保留元信息;日志正文在选中项目时按需拉取。
  (initial.runtimes || []).forEach((item) => runtimeState.set(item.projectId, { ...item, logs: [] }));
  // 文件夹默认收起,保持首页清爽;仅自动展开包含运行中项目的文件夹。
  groupProjects(initial.projects.filter((project) => !project.hidden)).forEach((folder) => {
    if (folder.projects.some((project) => isActive(runtime(project.id).state))) expandedMainFolders.add(folder.key);
  });
  const windowState = await api.getWindowState();
  document.body.classList.toggle('is-maximized', Boolean(windowState?.maximized));
  renderContent();
  $('#mainNav .nav-item.active')?.setAttribute('aria-current', 'page');
})();
