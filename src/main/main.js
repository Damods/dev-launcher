const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, safeStorage, shell, Tray } = require('electron');
const { StateStore } = require('./store');
const { scanRoot } = require('./scanner');
const { ProcessManager } = require('./process-manager');
const { parseArgs, shouldQuitOnWindowClose } = require('./utils');

// Liquid Glass 材质依赖 GPU 加速渲染 backdrop-filter,默认开启硬件加速。
// 若在个别机器上遇到驱动崩溃,可设置环境变量 DEV_LAUNCHER_SOFTWARE=1 回退软件渲染。
if (process.env.DEV_LAUNCHER_SOFTWARE === '1') {
  app.disableHardwareAcceleration();
}
app.setAppUserModelId('com.devlauncher.desktop');
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

let mainWindow;
let tray;
let store;
let processManager;
let isQuitting = false;
let sessionFile;
let trayNoticeShown = false;
const activeScans = new Map();

function encryptedStorage() {
  return {
    encrypt(value) {
      if (!value) return '';
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 安全存储当前不可用，无法安全保存环境变量。');
      return safeStorage.encryptString(value).toString('base64');
    },
    decrypt(value) {
      if (!value) return '';
      return safeStorage.decryptString(Buffer.from(value, 'base64'));
    }
  };
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function persistRuntimeMarker() {
  const running = processManager.getAllSnapshots().filter((item) => ['starting', 'running', 'ready', 'stopping'].includes(item.state));
  try {
    if (running.length) fs.writeFileSync(sessionFile, JSON.stringify({ recordedAt: new Date().toISOString(), running }, null, 2));
    else if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile);
  } catch {
    // The marker is best-effort and never blocks project controls.
  }
}

function createTrayIcon() {
  const trayIcon = nativeImage.createFromPath(path.join(app.getAppPath(), 'assets', 'icon-32.png'));
  if (trayIcon.isEmpty()) throw new Error('无法加载系统托盘图标');
  return trayIcon.resize({ width: 16, height: 16, quality: 'best' });
}

function showWindow() {
  if (!mainWindow) return;
  mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function updateTrayMenu() {
  if (!tray || !processManager) return;
  const count = processManager.runningIds().length;
  tray.setToolTip(count ? `Dev Launcher · ${count} 个项目运行中` : 'Dev Launcher');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Dev Launcher', click: showWindow },
    { label: `运行中的项目：${count}`, enabled: false },
    { type: 'separator' },
    { label: '全部停止', enabled: count > 0, click: async () => processManager.stopAll() },
    { label: '退出', click: requestQuit }
  ]));
}

async function requestQuit() {
  const count = processManager.runningIds().length;
  if (count) {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '退出 Dev Launcher',
      message: `仍有 ${count} 个项目正在运行。`,
      detail: '退出软件将停止这些项目及其子进程。',
      buttons: ['取消', '全部停止并退出'],
      defaultId: 0,
      cancelId: 0
    });
    if (result.response !== 1) return;
    await processManager.stopAll();
  }
  isQuitting = true;
  persistRuntimeMarker();
  app.quit();
}

function createWindow() {
  // 按上次使用的主题设置窗口底色,避免深色用户启动瞬间看到白闪。
  const theme = store.getState().settings.theme;
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    frame: false,
    thickFrame: true,
    backgroundColor: theme === 'dark' ? '#0b0e14' : '#f1f5f9',
    title: 'Dev Launcher',
    icon: path.join(app.getAppPath(), 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('maximize', () => send('window:maximized-changed', true));
  mainWindow.on('unmaximize', () => send('window:maximized-changed', false));
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    const runningCount = processManager?.runningIds().length || 0;
    if (shouldQuitOnWindowClose(runningCount)) {
      // 无运行项目，直接退出主进程——避免 NSIS 升级检测到 Dev Launcher.exe 存活而阻断升级。
      isQuitting = true;
      app.quit();
      return;
    }
    // 有运行项目：弹提示框阻止关闭，避免后台进程被强杀/升级被打断。
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Dev Launcher 正在运行项目',
      message: `仍有 ${runningCount} 个项目正在运行。`,
      detail: '请先停止所有运行中的项目，再关闭 Dev Launcher，避免子进程被遗留或升级被打断。',
      buttons: ['知道了'],
      defaultId: 0,
      cancelId: 0
    });
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
}

function projectById(projectId) {
  const project = store.getState().projects.find((item) => item.id === projectId);
  if (!project) throw new Error('项目不存在');
  return project;
}

async function scanOneRoot(root) {
  // 同一目录重复触发扫描时,中止旧任务,避免旧结果覆盖新状态。
  activeScans.get(root.id)?.abort();
  const controller = new AbortController();
  activeScans.set(root.id, controller);
  const isLatest = () => activeScans.get(root.id) === controller;
  store.updateRoot(root.id, { status: 'scanning', error: null });
  send('scan:progress', { rootId: root.id, directoriesScanned: 0, projectsFound: 0 });
  try {
    if (!fs.existsSync(root.path)) throw new Error('目录不存在');
    const result = await scanRoot(root.path, (progress) => send('scan:progress', { rootId: root.id, ...progress }), { signal: controller.signal });
    if (!isLatest()) return { rootId: root.id, status: 'cancelled' };
    store.mergeScannedProjects(root.path, result.projects);
    store.updateRoot(root.id, { status: 'ready', error: null, lastScannedAt: new Date().toISOString(), directoriesScanned: result.directoriesScanned });
    send('state:changed', store.getState());
    return { rootId: root.id, status: 'completed', projectsFound: result.projects.length, directoriesScanned: result.directoriesScanned };
  } catch (error) {
    if (error.code === 'SCAN_CANCELLED' || !isLatest()) return { rootId: root.id, status: 'cancelled' };
    store.updateRoot(root.id, { status: 'error', error: error.message, lastScannedAt: new Date().toISOString() });
    send('state:changed', store.getState());
    return { rootId: root.id, status: 'failed', error: error.message };
  } finally {
    if (isLatest()) activeScans.delete(root.id);
  }
}

async function scanAll() {
  const roots = store.getState().roots.filter((root) => root.enabled);
  const results = await Promise.all(roots.map(scanOneRoot));
  return { status: results.some((result) => result.status === 'failed') ? 'partial' : 'completed', results };
}

function registerIpc() {
  const senderWindow = (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return window === mainWindow && !window.isDestroyed() ? window : null;
  };

  ipcMain.handle('window:minimize', (event) => senderWindow(event)?.minimize());
  ipcMain.handle('window:toggle-maximize', (event) => {
    const window = senderWindow(event);
    if (!window) return false;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    return window.isMaximized();
  });
  ipcMain.handle('window:close', (event) => senderWindow(event)?.close());
  ipcMain.handle('window:get-state', (event) => {
    const window = senderWindow(event);
    return { maximized: Boolean(window?.isMaximized()) };
  });

  ipcMain.handle('state:get', () => ({ ...store.getState(), appVersion: app.getVersion(), storageStatus: store.getLoadStatus(), runtimes: processManager.getAllSnapshots() }));
  ipcMain.handle('root:add', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: '选择代码根目录' });
    if (result.canceled || !result.filePaths[0]) return { status: 'canceled' };
    const root = store.addRoot(result.filePaths[0]);
    send('state:changed', store.getState());
    return scanOneRoot(root);
  });
  ipcMain.handle('root:remove', (_, rootId) => { store.removeRoot(rootId); return store.getState(); });
  ipcMain.handle('scan:all', scanAll);

  ipcMain.handle('project:update', (_, projectId, patch) => {
    if (patch?.launch?.argsText !== undefined) {
      patch.launch.args = parseArgs(patch.launch.argsText);
      delete patch.launch.argsText;
    }
    const project = store.updateProject(projectId, patch);
    send('state:changed', store.getState());
    return project;
  });
  ipcMain.handle('project:restore', (_, projectId) => { const result = store.restoreProject(projectId); send('state:changed', store.getState()); return result; });
  ipcMain.handle('project:relocate', async (_, projectId) => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: '重新选择项目目录' });
    if (result.canceled || !result.filePaths[0]) return null;
    const project = store.relocateProject(projectId, result.filePaths[0]);
    send('state:changed', store.getState());
    return project;
  });

  ipcMain.handle('process:start', (_, projectId) => processManager.start(projectById(projectId)));
  ipcMain.handle('process:stop', (_, projectId) => processManager.stop(projectId));
  ipcMain.handle('process:restart', (_, projectId) => processManager.restart(projectById(projectId)));
  ipcMain.handle('process:stop-all', () => processManager.stopAll());
  ipcMain.handle('process:snapshot', (_, projectId) => processManager.getSnapshot(projectId));
  ipcMain.handle('process:clear-logs', (_, projectId) => processManager.clearLogs(projectId));
  ipcMain.handle('settings:update', (_, patch) => {
    const settings = store.updateSettings(patch || {});
    processManager.maxLogLines = settings.maxLogLines;
    send('state:changed', store.getState());
    return settings;
  });

  ipcMain.handle('group:save', (_, group) => { store.saveGroup(group); send('state:changed', store.getState()); return store.getState(); });
  ipcMain.handle('group:remove', (_, groupId) => { store.removeGroup(groupId); send('state:changed', store.getState()); return store.getState(); });
  ipcMain.handle('group:start', async (_, groupId) => {
    const state = store.getState();
    const group = state.groups.find((item) => item.id === groupId);
    if (!group) throw new Error('启动组不存在');
    if (!group.projectIds.length) throw new Error('启动组中还没有项目');
    const projects = group.projectIds.map((id) => projectById(id));
    return processManager.startMany(projects);
  });
  ipcMain.handle('group:stop', async (_, groupId) => {
    const group = store.getState().groups.find((item) => item.id === groupId);
    if (!group) throw new Error('启动组不存在');
    return Promise.all(group.projectIds.map((id) => processManager.stop(id)));
  });

  ipcMain.handle('shell:open-url', (_, url) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('仅允许打开 HTTP 或 HTTPS 地址');
    return shell.openExternal(url);
  });
  ipcMain.handle('shell:open-path', (_, targetPath) => shell.openPath(path.resolve(targetPath)));
  ipcMain.handle('clipboard:write', (_, text) => clipboard.writeText(String(text)));
  ipcMain.handle('app:quit', requestQuit);
}

if (hasSingleInstanceLock) app.whenReady().then(() => {
  const userData = app.getPath('userData');
  sessionFile = path.join(userData, 'runtime-session.json');
  const staleSession = fs.existsSync(sessionFile) ? fs.readFileSync(sessionFile, 'utf8') : null;
  store = new StateStore(path.join(userData, 'state.json'), encryptedStorage());
  processManager = new ProcessManager({
    maxLogLines: store.getState().settings.maxLogLines,
    onUpdate(update) {
      send('process:update', update);
      persistRuntimeMarker();
      updateTrayMenu();
    }
  });
  registerIpc();
  createWindow();
  tray = new Tray(createTrayIcon());
  tray.on('click', showWindow);
  updateTrayMenu();

  if (staleSession) {
    try { fs.unlinkSync(sessionFile); } catch {}
    mainWindow.webContents.once('did-finish-load', () => send('app:stale-session', JSON.parse(staleSession)));
  }
});

app.on('second-instance', showWindow);
app.on('activate', showWindow);
app.on('before-quit', () => { isQuitting = true; });
// 注册了 window-all-closed 监听器即会阻止默认的 quit 行为:应用关闭窗口后常驻系统托盘,
// 由托盘菜单或退出确认流程显式退出。此事件没有 event 参数,保持空函数即可。
app.on('window-all-closed', () => {});
