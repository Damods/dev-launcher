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
  assert.match(installer, /CreateShortCut "\$DESKTOP\\Dev Launcher\.lnk"[^\r\n]+resources\\app\\assets\\icon\.ico/);
  assert.match(installer, /CreateShortCut "\$SMPROGRAMS\\Dev Launcher\.lnk"[^\r\n]+resources\\app\\assets\\icon\.ico/);
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

test('liquid glass material uses real backdrop blur with a software fallback', () => {
  const styles = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
  const main = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  assert.match(styles, /backdrop-filter\s*:[^;]*blur\(/);
  // 主面板模糊半径是液态玻璃的核心:必须足够大(≥40px)才能透出背景层次
  const blurLg = Number(styles.match(/--lg-blur-lg:\s*(\d+)px;/)?.[1] || 0);
  assert.ok(blurLg >= 40, `expected --lg-blur-lg >= 40px, got ${blurLg}px`);
  // 饱和度必须克制,过高的 saturate 是"AI 味"的主要来源
  const saturate = Number(styles.match(/--lg-saturate:\s*(\d+)%;/)?.[1] || 0);
  assert.ok(saturate > 0 && saturate <= 150, `expected --lg-saturate <= 150%, got ${saturate}%`);
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
