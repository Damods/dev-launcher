const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const assets = path.resolve(__dirname, '..', 'assets');

test('app icon PNG has a valid PNG signature', () => {
  const png = fs.readFileSync(path.join(assets, 'icon.png'));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});

test('Windows ICO contains every required taskbar and tray size', () => {
  const ico = fs.readFileSync(path.join(assets, 'icon.ico'));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  const count = ico.readUInt16LE(4);
  const sizes = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16;
    sizes.push(ico[offset] || 256);
  }
  assert.deepEqual(sizes.sort((a, b) => a - b), [16, 24, 32, 48, 64, 128, 256]);
});

test('in-app brand and Windows shortcuts both use the custom icon', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  const installer = fs.readFileSync(path.resolve(__dirname, '..', 'build', 'installer.nsh'), 'utf8');
  assert.match(html, /class="brand-mark" src="\.\.\/\.\.\/assets\/icon\.png"/);
  assert.match(installer, /CreateShortCut "\$DESKTOP\\Dev Launcher\.lnk"[^\r\n]+resources\\app\.asar\.unpacked\\assets\\icon\.ico/);
  assert.match(installer, /CreateShortCut "\$SMPROGRAMS\\Dev Launcher\.lnk"[^\r\n]+resources\\app\.asar\.unpacked\\assets\\icon\.ico/);
});

test('compact sidebar exposes directory tree and project folders', () => {
  const renderer = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');
  assert.match(renderer, /function groupProjects\(projects\)/);
  assert.match(renderer, /function renderNavigationSidebar\(runningProjects\)/);
  assert.match(renderer, /class="sidebar-root-item"/);
  assert.match(renderer, /class="sidebar-running-item/);
  assert.match(renderer, /data-action="toggle-main-folder"/);
  assert.match(renderer, /class="folder-projects"/);
});

test('outer app surface fills the window without a frame', () => {
  const styles = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
  const appWindow = styles.match(/\.app-window\s*\{([\s\S]*?)\}/)?.[1] || '';
  assert.match(appWindow, /border:\s*0;/);
  assert.match(appWindow, /border-radius:\s*0;/);
  assert.match(appWindow, /box-shadow:\s*none;/);
});

test('dark minimal UI: flat surfaces, modal-only blur, aligned window base colors', () => {
  const styles = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
  const main = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  // 液态玻璃令牌必须全部移除
  assert.doesNotMatch(styles, /--lg-[\w-]+\s*:/);
  assert.doesNotMatch(styles, /glass-breathe/);
  // backdrop-filter 仅允许保留在模态框及其遮罩上
  const blurLines = styles.split('\n').filter((line) => /backdrop-filter\s*:[^;]*blur\(/.test(line));
  assert.ok(blurLines.length > 0, 'modal blur should be kept');
  for (const line of blurLines) {
    assert.match(line, /\.modal|\.palette-overlay|prefers-reduced-transparency/, `unexpected blur outside modal: ${line.trim()}`);
  }
  // 深色基底与天空蓝强调色
  assert.match(styles, /--page:\s*#0b0e14;/);
  assert.match(styles, /--surface:\s*#0f172a;/);
  assert.match(styles, /#38bdf8/);
  // 主进程窗口底色必须与 CSS 基底对齐,防止启动闪旧色
  assert.match(main, /backgroundColor: theme === 'dark' \? '#0b0e14' : '#f1f5f9'/);
  assert.doesNotMatch(styles, /content-visibility:\s*auto;/);
  assert.match(main, /DEV_LAUNCHER_SOFTWARE/);
});

test('live logs are frame-batched and capped to a lightweight DOM', () => {
  const renderer = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');
  assert.match(renderer, /const maxRenderedLogLines = 1000;/);
  assert.match(renderer, /function queueLogLines\(projectId, lines\)/);
  assert.match(renderer, /pendingLogFrame = requestAnimationFrame/);
  assert.doesNotMatch(renderer, /logs:\s*\[\.\.\.\(previous\.logs/);
});

test('desktop app prevents multiple instances from racing on the same state file', () => {
  const main = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  assert.match(main, /app\.requestSingleInstanceLock\(\)/);
  assert.match(main, /app\.on\('second-instance', showWindow\)/);
});
