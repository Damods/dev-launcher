const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function waitForPage(port, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let lastPages = [];
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
      lastPages = pages;
      const page = pages.find((item) => item.type === 'page' && item.title === 'Dev Launcher');
      if (page) return page;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const observed = lastPages.map(({ type, title, url }) => ({ type, title, url }));
  throw new Error(`Dev Launcher 窗口未能在 ${Math.round(timeout / 1000)} 秒内启动\nObserved targets: ${JSON.stringify(observed)}${lastError ? `\nLast fetch error: ${lastError}` : ''}`);
}

function connect(url) {
  const socket = new WebSocket(url);
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject, timeout } = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(timeout);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  };
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error('连接 Electron 调试页面超时'));
    }, 10000);
    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('无法连接 Electron 调试端口'));
    };
    socket.onclose = () => {
      clearTimeout(timeout);
      const error = new Error('Electron 调试页面连接已关闭');
      for (const request of pending.values()) {
        clearTimeout(request.timeout);
        request.reject(error);
      }
      pending.clear();
      reject(new Error('Electron 调试页面在连接前关闭'));
    };
    socket.onopen = () => {
      clearTimeout(timeout);
      resolve({
        send(method, params = {}) {
          const id = ++sequence;
          socket.send(JSON.stringify({ id, method, params }));
          return new Promise((resolveResult, rejectResult) => {
            const requestTimeout = setTimeout(() => {
              pending.delete(id);
              rejectResult(new Error(`Electron 调试命令 ${id} 超时`));
            }, 15000);
            pending.set(id, { resolve: resolveResult, reject: rejectResult, timeout: requestTimeout });
          });
        },
        evaluate(expression) {
          const id = ++sequence;
          socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
          return new Promise((resolveResult, rejectResult) => {
            const requestTimeout = setTimeout(() => {
              pending.delete(id);
              rejectResult(new Error(`Electron 调试命令 ${id} 超时`));
            }, 15000);
            pending.set(id, { resolve: resolveResult, reject: rejectResult, timeout: requestTimeout });
          });
        },
        close: () => socket.close()
      });
    };
  });
}

async function captureScreenshot(client, file) {
  if (!file) return;
  await client.evaluate(`new Promise((resolve) => setTimeout(resolve, 230))`);
  const capture = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.from(capture.data, 'base64'));
}

async function main() {
  const electronPath = process.env.DEV_LAUNCHER_EXECUTABLE || require('electron');
  const appPath = path.resolve(__dirname, '..');
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-launcher-electron-'));
  const workspace = path.join(userData, 'workspace');
  const biyeshejiPath = path.join(workspace, 'BIYESHEJI');
  const warehousePath = path.join(workspace, 'Damods的仓库');
  const backendPath = path.join(biyeshejiPath, 'Backend');
  const frontendPath = path.join(biyeshejiPath, 'frontend');
  const portalPath = path.join(warehousePath, '深度学习课程');
  await fs.mkdir(backendPath, { recursive: true });
  await fs.mkdir(frontendPath, { recursive: true });
  await fs.mkdir(portalPath, { recursive: true });
  const smokeLaunch = {
    configured: true,
    command: path.basename(process.execPath),
    args: ['-e', 'console.log("SMOKE_PROJECT_LOG http://localhost:5173/"); setTimeout(() => process.exit(0), 120)'],
    workingDirectory: appPath,
    env: {},
    encoding: 'utf8',
    url: ''
  };
  const brokenLaunch = { ...smokeLaunch, configured: false, command: '' };
  await fs.writeFile(path.join(userData, 'state.json'), JSON.stringify({
    version: 1,
    roots: [
      { id: 'smoke-root-c', path: 'C:\\Projects', enabled: true, status: 'ready', lastScannedAt: null },
      { id: 'smoke-root-d', path: 'D:\\Workspace', enabled: true, status: 'ready', lastScannedAt: null },
      { id: 'smoke-root-e', path: 'E:\\Code', enabled: true, status: 'ready', lastScannedAt: null },
      { id: 'smoke-root-f', path: 'F:\\Dev', enabled: true, status: 'ready', lastScannedAt: null }
    ],
    projects: [
      { id: 'smoke-api', name: 'Backend', path: backendPath, type: 'maven', evidence: 'pom.xml', missing: false, hidden: false, userModified: true, launch: smokeLaunch, inferredLaunch: smokeLaunch },
      { id: 'smoke-project', name: 'frontend', path: frontendPath, type: 'frontend', evidence: 'package.json', missing: false, hidden: false, userModified: true, launch: smokeLaunch, inferredLaunch: smokeLaunch },
      { id: 'smoke-portal', name: 'deep-learning-learning-portal', path: portalPath, type: 'frontend', evidence: 'package.json', missing: false, hidden: false, userModified: true, launch: smokeLaunch, inferredLaunch: smokeLaunch },
      { id: 'smoke-broken', name: 'broken-hidden-project', path: portalPath, type: 'frontend', evidence: 'package.json', missing: false, hidden: true, userModified: true, launch: brokenLaunch, inferredLaunch: brokenLaunch }
    ],
    groups: [],
    settings: { maxLogLines: 10000 }
  }, null, 2));
  const port = 19223;
  const chromiumTestArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userData}`,
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--in-process-gpu',
    '--use-angle=swiftshader'
  ];
  const launchArgs = process.env.DEV_LAUNCHER_EXECUTABLE
    ? chromiumTestArgs
    : [...chromiumTestArgs, appPath];
  const child = spawn(electronPath, launchArgs, {
    cwd: appPath,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  console.log(`Electron smoke: launched PID ${child.pid || 'unknown'} on debug port ${port}.`);
  const diagnostics = [];
  child.stdout.on('data', (chunk) => diagnostics.push(chunk.toString()));
  child.stderr.on('data', (chunk) => diagnostics.push(chunk.toString()));
  child.on('exit', (code, signal) => diagnostics.push(`\nElectron exited: code=${code}, signal=${signal}\n`));
  let client;
  try {
    let page;
    try {
      page = await waitForPage(port, process.env.DEV_LAUNCHER_EXECUTABLE ? 60000 : 30000);
    } catch (error) {
      throw new Error(`${error.message}${diagnostics.length ? `\nElectron 诊断：\n${diagnostics.join('').slice(-4000)}` : ''}`);
    }
    console.log(`Electron smoke: renderer target ready (${page.title}).`);
    client = await connect(page.webSocketDebuggerUrl);
    await client.evaluate(`new Promise((resolve) => { const deadline = Date.now() + 10000; const check = () => { if (document.querySelectorAll('.sidebar-root-item').length >= 4 || Date.now() >= deadline) resolve(true); else setTimeout(check, 50); }; check(); })`);
    const initial = await client.evaluate(`({ title: document.querySelector('#pageTitle').textContent, titlebar: Boolean(document.querySelector('#windowTitlebar')), windowControls: document.querySelectorAll('[data-window-control]').length, windowsControlLayout: Boolean(document.querySelector('.titlebar-actions > .window-controls')), themeToggle: Boolean(document.querySelector('#themeToggle')), navItems: document.querySelectorAll('.nav-item').length, sidebarRoots: document.querySelectorAll('.sidebar-root-item').length, rootTreeVisible: !document.querySelector('#sidebarRootTree').classList.contains('collapsed'), runningCount: document.querySelector('#runningCount').textContent, mainFolders: document.querySelectorAll('.folder-card').length, mainExpanded: document.querySelector('.folder-card')?.classList.contains('expanded'), brandLoaded: document.querySelector('.brand-mark')?.complete && document.querySelector('.brand-mark')?.naturalWidth > 0 })`);
    assert.deepEqual(initial.result.value, { title: '全部项目', titlebar: true, windowControls: 3, windowsControlLayout: true, themeToggle: true, navItems: 4, sidebarRoots: 4, rootTreeVisible: true, runningCount: '0', mainFolders: 2, mainExpanded: false, brandLoaded: true });

    if (process.env.DEV_LAUNCHER_SCREENSHOT) {
      await client.evaluate(`document.documentElement.dataset.theme = 'light'; runtimeState.set('smoke-api', { projectId: 'smoke-api', state: 'running', logs: [], urls: [] }); runtimeState.set('smoke-project', { projectId: 'smoke-project', state: 'running', logs: [], urls: [] }); updateCounts()`);
      await client.evaluate(`new Promise((resolve) => setTimeout(resolve, 230))`);
      const bounds = await client.evaluate(`(() => { const rect = document.querySelector('.navigation-sidebar').getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 }; })()`);
      const capture = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false, clip: bounds.result.value });
      await fs.mkdir(path.dirname(process.env.DEV_LAUNCHER_SCREENSHOT), { recursive: true });
      await fs.writeFile(process.env.DEV_LAUNCHER_SCREENSHOT, Buffer.from(capture.data, 'base64'));
      await client.evaluate(`runtimeState.clear(); updateCounts()`);
    }
    if (process.env.DEV_LAUNCHER_FULL_SCREENSHOT) {
      await client.evaluate(`document.documentElement.dataset.theme = 'light'`);
      await client.evaluate(`new Promise((resolve) => setTimeout(resolve, 230))`);
      const lightSurface = await client.evaluate(`({ theme: document.documentElement.dataset.theme, projectBackground: getComputedStyle(document.querySelector('.project-card')).backgroundColor })`);
      assert.deepEqual(lightSurface.result.value, { theme: 'light', projectBackground: 'rgba(0, 0, 0, 0)' });
      const bounds = await client.evaluate(`(() => { const rect = document.documentElement.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 }; })()`);
      const capture = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false, clip: bounds.result.value });
      await fs.mkdir(path.dirname(process.env.DEV_LAUNCHER_FULL_SCREENSHOT), { recursive: true });
      await fs.writeFile(process.env.DEV_LAUNCHER_FULL_SCREENSHOT, Buffer.from(capture.data, 'base64'));
    }

    const themeSwitch = await client.evaluate(`(async () => { const button = document.querySelector('#themeToggle'); const layer = document.querySelector('#themeTransitionLayer'); const before = document.documentElement.dataset.theme; const startedAt = performance.now(); button.click(); while (document.documentElement.dataset.theme === before && performance.now() - startedAt < 1000) await new Promise((resolve) => setTimeout(resolve, 10)); const switchMs = performance.now() - startedAt; const after = document.documentElement.dataset.theme; const stored = localStorage.getItem('dev-launcher-theme'); const label = button.getAttribute('aria-label'); await new Promise((resolve) => setTimeout(resolve, 300)); button.click(); await new Promise((resolve) => setTimeout(resolve, 400)); return { before, after, restored: document.documentElement.dataset.theme, stored, label, switchMs, layerClean: layer.className === 'theme-transition-layer', buttonIdle: !button.hasAttribute('aria-busy') }; })()`);
    assert.notEqual(themeSwitch.result.value.after, themeSwitch.result.value.before);
    assert.equal(themeSwitch.result.value.restored, themeSwitch.result.value.before);
    assert.equal(themeSwitch.result.value.stored, themeSwitch.result.value.after);
    assert.match(themeSwitch.result.value.label, themeSwitch.result.value.after === 'dark' ? /浅色/ : /暗黑/);
    assert.ok(themeSwitch.result.value.switchMs < 450, `theme switch took ${themeSwitch.result.value.switchMs}ms`);
    assert.equal(themeSwitch.result.value.layerClean, true);
    assert.equal(themeSwitch.result.value.buttonIdle, true);
    if (process.env.DEV_LAUNCHER_DARK_SCREENSHOT) {
      await client.evaluate(`commitTheme('dark', false); document.documentElement.dataset.theme`);
      await client.evaluate(`new Promise((resolve) => setTimeout(resolve, 230))`);
      const darkSurface = await client.evaluate(`({ theme: document.documentElement.dataset.theme, projectBackground: getComputedStyle(document.querySelector('.project-card')).backgroundColor })`);
      assert.deepEqual(darkSurface.result.value, { theme: 'dark', projectBackground: 'rgba(0, 0, 0, 0)' });
      const capture = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
      await fs.mkdir(path.dirname(process.env.DEV_LAUNCHER_DARK_SCREENSHOT), { recursive: true });
      await fs.writeFile(process.env.DEV_LAUNCHER_DARK_SCREENSHOT, Buffer.from(capture.data, 'base64'));
      await client.evaluate(`commitTheme('light', false); document.documentElement.dataset.theme`);
    }

    const navigationToggled = await client.evaluate(`document.querySelector('.root-tree-toggle').click(); const rootsCollapsed = document.querySelector('#sidebarRootTree').classList.contains('collapsed'); const viewBeforeNavigation = document.querySelector('#pageTitle').textContent; document.querySelector('.root-nav-item').click(); const viewAfterNavigation = document.querySelector('#pageTitle').textContent; const stillCollapsed = document.querySelector('#sidebarRootTree').classList.contains('collapsed'); document.querySelector('.root-tree-toggle').click(); document.querySelector('[data-view="projects"]').click(); document.querySelector('.main-folder-toggle').click(); const mainCollapsed = document.querySelector('.folder-card').classList.contains('expanded'); document.querySelector('.main-folder-toggle').click(); ({ collapsed: { roots: rootsCollapsed, main: mainCollapsed }, viewBeforeNavigation, viewAfterNavigation, stillCollapsed, rootsVisible: !document.querySelector('#sidebarRootTree').classList.contains('collapsed'), mainExpanded: document.querySelector('.folder-card').classList.contains('expanded'), rootItems: document.querySelectorAll('.sidebar-root-item').length, cards: document.querySelectorAll('.folder-card.expanded .project-card').length })`);
    assert.deepEqual(navigationToggled.result.value, { collapsed: { roots: true, main: true }, viewBeforeNavigation: '全部项目', viewAfterNavigation: '代码目录', stillCollapsed: true, rootsVisible: true, mainExpanded: false, rootItems: 4, cards: 0 });

    const windowControls = await client.evaluate(`(async () => { const before = await window.devLauncher.getWindowState(); await window.devLauncher.toggleMaximizeWindow(); await new Promise((resolve) => setTimeout(resolve, 250)); const maximized = await window.devLauncher.getWindowState(); await window.devLauncher.toggleMaximizeWindow(); await new Promise((resolve) => setTimeout(resolve, 250)); const restored = await window.devLauncher.getWindowState(); return { before: before.maximized, maximized: maximized.maximized, restored: restored.maximized }; })()`);
    assert.deepEqual(windowControls.result.value, { before: false, maximized: true, restored: false });

    const settings = await client.evaluate(`document.querySelector('[data-view="settings"]').click(); ({ title: document.querySelector('#pageTitle').textContent, maxLogLines: document.querySelector('[data-setting="maxLogLines"]').value, hiddenProjects: document.querySelectorAll('.hidden-project-row').length })`);
    assert.deepEqual(settings.result.value, { title: '设置', maxLogLines: '10000', hiddenProjects: 1 });
    if (process.env.DEV_LAUNCHER_SETTINGS_SCREENSHOT) {
      await client.evaluate(`new Promise((resolve) => setTimeout(resolve, 230))`);
      const capture = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
      await fs.mkdir(path.dirname(process.env.DEV_LAUNCHER_SETTINGS_SCREENSHOT), { recursive: true });
      await fs.writeFile(process.env.DEV_LAUNCHER_SETTINGS_SCREENSHOT, Buffer.from(capture.data, 'base64'));
    }
    if (process.env.DEV_LAUNCHER_DARK_SETTINGS_SCREENSHOT) {
      await client.evaluate(`commitTheme('dark', false)`);
      await captureScreenshot(client, process.env.DEV_LAUNCHER_DARK_SETTINGS_SCREENSHOT);
      await client.evaluate(`commitTheme('light', false)`);
    }

    const groupDialog = await client.evaluate(`document.querySelector('[data-view="groups"]').click(); document.querySelector('[data-action="new-group"]').click(); ({ title: document.querySelector('#pageTitle').textContent, open: document.querySelector('#groupDialog').open, focused: document.activeElement.id })`);
    assert.deepEqual(groupDialog.result.value, { title: '启动组', open: true, focused: 'editGroupName' });
    const emptyGroupValidation = await client.evaluate(`(() => { document.querySelector('#editGroupName').value = '空启动组'; document.querySelector('#groupForm').requestSubmit(); return { open: document.querySelector('#groupDialog').open, errorVisible: !document.querySelector('#groupProjectError').classList.contains('hidden'), focusedProject: document.activeElement.closest('#groupProjectList') !== null }; })()`);
    assert.deepEqual(emptyGroupValidation.result.value, { open: true, errorVisible: true, focusedProject: true });
    if (process.env.DEV_LAUNCHER_DIALOG_SCREENSHOT) {
      await client.evaluate(`new Promise((resolve) => setTimeout(resolve, 230))`);
      const capture = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
      await fs.mkdir(path.dirname(process.env.DEV_LAUNCHER_DIALOG_SCREENSHOT), { recursive: true });
      await fs.writeFile(process.env.DEV_LAUNCHER_DIALOG_SCREENSHOT, Buffer.from(capture.data, 'base64'));
    }
    if (process.env.DEV_LAUNCHER_DARK_DIALOG_SCREENSHOT) {
      await client.evaluate(`commitTheme('dark', false)`);
      await captureScreenshot(client, process.env.DEV_LAUNCHER_DARK_DIALOG_SCREENSHOT);
      await client.evaluate(`commitTheme('light', false)`);
    }
    const groupPreflight = await client.evaluate(`(async () => { const next = await window.devLauncher.saveGroup({ name: '预检失败组', projectIds: ['smoke-project', 'smoke-broken'] }); const group = next.groups.find((item) => item.name === '预检失败组'); let error = ''; try { await window.devLauncher.startGroup(group.id); } catch (caught) { error = caught.message; } const validProject = await window.devLauncher.getSnapshot('smoke-project'); await window.devLauncher.removeGroup(group.id); return { error, validState: validProject.state }; })()`);
    assert.match(groupPreflight.result.value.error, /启动配置不完整/);
    assert.equal(groupPreflight.result.value.validState, 'idle');
    const consoleOpened = await client.evaluate(`document.querySelector('#groupDialog').close(); document.querySelector('[data-view="projects"]').click(); document.querySelector('[data-action="select-project"][data-id="smoke-project"]').click(); new Promise((resolve) => setTimeout(() => resolve({ detail: document.querySelector('.detail-title-row h2')?.textContent, projectViewActive: document.querySelector('[data-view="projects"]').classList.contains('active') }), 150))`);
    assert.deepEqual(consoleOpened.result.value, { detail: 'frontend', projectViewActive: true });
    const emptyLogActions = await client.evaluate(`({ copyDisabled: document.querySelector('[data-action="copy-logs"]').disabled, clearDisabled: document.querySelector('[data-action="clear-logs"]').disabled, autoScrollPressed: document.querySelector('[data-action="toggle-scroll"]').getAttribute('aria-pressed'), autoScrollLabel: document.querySelector('[data-action="toggle-scroll"]').textContent.trim() })`);
    assert.deepEqual(emptyLogActions.result.value, { copyDisabled: true, clearDisabled: true, autoScrollPressed: 'true', autoScrollLabel: '自动滚动：开' });
    await captureScreenshot(client, process.env.DEV_LAUNCHER_DETAIL_SCREENSHOT);
    const projectDialog = await client.evaluate(`document.querySelector('[data-action="edit"][data-id="smoke-project"]').click(); ({ open: document.querySelector('#projectDialog').open, name: document.querySelector('#editName').value, focused: document.activeElement.id })`);
    assert.deepEqual(projectDialog.result.value, { open: true, name: 'frontend', focused: 'editName' });
    await captureScreenshot(client, process.env.DEV_LAUNCHER_PROJECT_DIALOG_SCREENSHOT);
    const unsavedConfirmation = await client.evaluate(`(async () => { const input = document.querySelector('#editName'); input.value = 'frontend changed'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-close="projectDialog"]').click(); await new Promise((resolve) => setTimeout(resolve, 20)); return { projectOpen: document.querySelector('#projectDialog').open, confirmOpen: document.querySelector('#confirmDialog').open, title: document.querySelector('#confirmDialogTitle').textContent, focused: document.activeElement.id }; })()`);
    assert.deepEqual(unsavedConfirmation.result.value, { projectOpen: true, confirmOpen: true, title: '放弃未保存的更改？', focused: 'confirmCancelBtn' });
    if (process.env.DEV_LAUNCHER_CONFIRM_SCREENSHOT) await captureScreenshot(client, process.env.DEV_LAUNCHER_CONFIRM_SCREENSHOT);
    if (process.env.DEV_LAUNCHER_DARK_CONFIRM_SCREENSHOT) {
      await client.evaluate(`commitTheme('dark', false)`);
      await captureScreenshot(client, process.env.DEV_LAUNCHER_DARK_CONFIRM_SCREENSHOT);
      await client.evaluate(`commitTheme('light', false)`);
    }
    const confirmationEscape = await client.evaluate(`(async () => { document.querySelector('#confirmDialog').dispatchEvent(new Event('cancel', { cancelable: true })); await new Promise((resolve) => setTimeout(resolve, 20)); const afterCancel = { projectOpen: document.querySelector('#projectDialog').open, confirmOpen: document.querySelector('#confirmDialog').open }; document.querySelector('[data-close="projectDialog"]').click(); await new Promise((resolve) => setTimeout(resolve, 20)); document.querySelector('#confirmSubmitBtn').click(); await new Promise((resolve) => setTimeout(resolve, 20)); return { ...afterCancel, discarded: !document.querySelector('#projectDialog').open && !document.querySelector('#confirmDialog').open }; })()`);
    assert.deepEqual(confirmationEscape.result.value, { projectOpen: true, confirmOpen: false, discarded: true });
    const scanLock = await client.evaluate(`(() => { scanBusy = true; scanBusyAction = 'scan'; updateScanControls(); const locked = { addDisabled: document.querySelector('#addRootBtn').disabled, scanDisabled: document.querySelector('#scanBtn').disabled, scanBusy: document.querySelector('#scanBtn').getAttribute('aria-busy'), label: document.querySelector('#scanBtn').textContent.trim() }; scanBusy = false; scanBusyAction = ''; updateScanControls(); return locked; })()`);
    assert.deepEqual(scanLock.result.value, { addDisabled: true, scanDisabled: true, scanBusy: 'true', label: '扫描中…' });
    const projectLog = await client.evaluate(`(() => { const button = document.querySelector('.detail-primary[data-action="start"][data-id="smoke-project"]'); button.click(); const pendingButton = document.querySelector('.detail-primary'); const immediate = { disabled: pendingButton.disabled, busy: pendingButton.getAttribute('aria-busy'), label: pendingButton.textContent.trim() }; return new Promise((resolve) => setTimeout(() => resolve({ immediate, text: document.querySelector('#logView')?.textContent || '', link: document.querySelector('#logView .log-link')?.dataset.url, action: document.querySelector('#logView .log-link')?.dataset.action }), 800)); })()`);
    assert.deepEqual(projectLog.result.value.immediate, { disabled: true, busy: 'true', label: '启动中…' });
    assert.match(projectLog.result.value.text, /SMOKE_PROJECT_LOG/);
    assert.deepEqual({ link: projectLog.result.value.link, action: projectLog.result.value.action }, { link: 'http://localhost:5173/', action: 'open-url' });
    const manualLogScroll = await client.evaluate(`(async () => { const current = runtimeState.get('smoke-project'); current.logs.push(...Array.from({ length: 220 }, (_, index) => ({ time: new Date().toISOString(), source: 'stdout', text: 'filler-' + index }))); renderDetail(); await new Promise((resolve) => { const deadline = Date.now() + 5000; const check = () => { const view = document.querySelector('#logView'); if (!view || !programmaticLogScroll || Date.now() > deadline) resolve(); else setTimeout(check, 10); }; check(); }); const view = document.querySelector('#logView'); view.scrollTop = 0; view.dispatchEvent(new Event('scroll')); const paused = { pressed: document.querySelector('[data-action="toggle-scroll"]').getAttribute('aria-pressed'), label: document.querySelector('[data-action="toggle-scroll"]').textContent.trim() }; view.scrollTop = view.scrollHeight; view.dispatchEvent(new Event('scroll')); return { paused, resumed: document.querySelector('[data-action="toggle-scroll"]').getAttribute('aria-pressed'), copyDisabled: document.querySelector('[data-action="copy-logs"]').disabled, clearDisabled: document.querySelector('[data-action="clear-logs"]').disabled }; })()`);
    assert.deepEqual(manualLogScroll.result.value, { paused: { pressed: 'false', label: '自动滚动：关' }, resumed: 'true', copyDisabled: false, clearDisabled: false });
    const logSearch = await client.evaluate(`(() => { const input = document.querySelector('#logSearch'); input.focus(); input.value = 'SMOKE'; input.dispatchEvent(new Event('input', { bubbles: true })); return { active: document.activeElement === input, value: input.value, matched: document.querySelector('#logView').textContent.includes('SMOKE_PROJECT_LOG') }; })()`);
    assert.deepEqual(logSearch.result.value, { active: true, value: 'SMOKE', matched: true });
    if (process.env.DEV_LAUNCHER_COMPACT_SCREENSHOT || process.env.DEV_LAUNCHER_COMPACT_DARK_SCREENSHOT) {
      await client.evaluate(`window.resizeTo(1040, 680); document.querySelector('[data-action="close-detail"]')?.click(); document.querySelector('[data-view="projects"]').click(); new Promise((resolve) => setTimeout(resolve, 400))`);
      await client.evaluate(`commitTheme('light', false)`);
      await captureScreenshot(client, process.env.DEV_LAUNCHER_COMPACT_SCREENSHOT);
      await client.evaluate(`commitTheme('dark', false)`);
      await captureScreenshot(client, process.env.DEV_LAUNCHER_COMPACT_DARK_SCREENSHOT);
    }
    // Regression guard (v1.13.3): closing the window must HIDE it to the tray while the
    // app keeps running (never destroy + isQuitting=true). Waking via the shared
    // showWindow entry point (second-instance here, tray click uses the same path)
    // must restore visibility — otherwise the window is "half dead".
    const closeToTray = await client.evaluate(`(async () => { window.devLauncher.closeWindow(); await new Promise((resolve) => setTimeout(resolve, 250)); return document.visibilityState; })()`);
    assert.equal(closeToTray.result.value, 'hidden', `关窗后应隐藏到托盘，实际 ${closeToTray.result.value}`);
    const wakeSecond = spawn(electronPath, [appPath, `--user-data-dir=${userData}`, '--no-sandbox', '--disable-gpu-sandbox', '--in-process-gpu', '--use-angle=swiftshader'], { cwd: appPath, windowsHide: true, stdio: 'ignore' });
    try {
      const wakeToVisible = await client.evaluate(`(async () => { const deadline = Date.now() + 10000; while (document.visibilityState !== 'visible' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100)); return document.visibilityState; })()`);
      assert.equal(wakeToVisible.result.value, 'visible', `唤醒入口应恢复窗口，实际 ${wakeToVisible.result.value}`);
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (wakeSecond.exitCode === null) wakeSecond.kill();
    }
    console.log('Electron smoke test passed: custom titlebar, grouping preflight, dialogs, incremental live logs and stable log search.');
  } finally {
    try { await client?.evaluate('window.devLauncher.quit()'); } catch {}
    client?.close();
    if (child.exitCode === null) {
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 3000))
      ]);
    }
    if (child.exitCode === null) child.kill();
    if (child.exitCode === null) {
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 2000))
      ]);
    }
    await fs.rm(userData, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
