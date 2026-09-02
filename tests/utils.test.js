const test = require('node:test');
const assert = require('node:assert/strict');
const { createShowWindow, extractUrls, parseArgs, shouldQuitOnWindowClose, stripAnsi } = require('../src/main/utils');

test('extractUrls removes ANSI sequences, duplicates and trailing punctuation', () => {
  const line = '\u001b[32mReady at http://localhost:3000/path?q=1\u001b[0m, http://localhost:3000/path?q=1';
  assert.deepEqual(extractUrls(line), ['http://localhost:3000/path?q=1']);
});

test('parseArgs supports quoted arguments and spaces', () => {
  assert.deepEqual(parseArgs('run dev --name "hello world" --flag'), ['run', 'dev', '--name', 'hello world', '--flag']);
});

test('stripAnsi returns readable logs', () => {
  assert.equal(stripAnsi('\u001b[31mfailed\u001b[0m'), 'failed');
});

test('shouldQuitOnWindowClose returns true when no project is running', () => {
  assert.equal(shouldQuitOnWindowClose(0), true);
});

test('shouldQuitOnWindowClose returns false while projects are running', () => {
  assert.equal(shouldQuitOnWindowClose(1), false);
  assert.equal(shouldQuitOnWindowClose(5), false);
});

test('shouldQuitOnWindowClose tolerates undefined / null / NaN inputs', () => {
  assert.equal(shouldQuitOnWindowClose(undefined), true);
  assert.equal(shouldQuitOnWindowClose(null), true);
  assert.equal(shouldQuitOnWindowClose(Number.NaN), true);
});

// --- createShowWindow 工厂守卫 ---
// 修复托盘点击触发 "Object has been destroyed" 的回归测试：
// 1. 主窗口被销毁时（app.quit 后保留托盘）必须重建，不能再去碰 destroyed 对象。
// 2. isQuitting 退出流程中直接放弃，不应反向复活窗口。
// 3. 正常态要 show / restore / focus。

test('createShowWindow recreates the window when mainWindow is destroyed (no crash)', () => {
  let mainWindow = {
    isDestroyed: () => true,
    show: () => { throw new Error('should never call show on a destroyed window'); },
    isMinimized: () => false,
    focus: () => {}
  };
  let isQuitting = false;
  let recreateCalls = 0;
  const recreateWindow = () => { recreateCalls += 1; mainWindow = { isDestroyed: () => false, show: () => {}, isMinimized: () => false, focus: () => {} }; };
  const showWindow = createShowWindow({
    getMainWindow: () => mainWindow,
    getIsQuitting: () => isQuitting,
    recreateWindow
  });
  showWindow();
  assert.equal(recreateCalls, 1, '应当触发重建而不是去碰已销毁的对象');
});

test('createShowWindow recreates the window when mainWindow is null', () => {
  let mainWindow = null;
  let isQuitting = false;
  let recreateCalls = 0;
  const recreateWindow = () => { recreateCalls += 1; };
  const showWindow = createShowWindow({
    getMainWindow: () => mainWindow,
    getIsQuitting: () => isQuitting,
    recreateWindow
  });
  showWindow();
  assert.equal(recreateCalls, 1);
});

test('createShowWindow does nothing while app is quitting', () => {
  const showCalls = [];
  const mainWindow = {
    isDestroyed: () => false,
    show: () => showCalls.push('show'),
    isMinimized: () => false,
    focus: () => showCalls.push('focus')
  };
  let recreateCalls = 0;
  const showWindow = createShowWindow({
    getMainWindow: () => mainWindow,
    getIsQuitting: () => true,
    recreateWindow: () => { recreateCalls += 1; }
  });
  showWindow();
  assert.deepEqual(showCalls, [], '退出流程中不应再操作窗口');
  assert.equal(recreateCalls, 0, '退出流程中不应重建窗口');
});

test('createShowWindow shows, restores, and focuses a healthy window', () => {
  const calls = [];
  const mainWindow = {
    isDestroyed: () => false,
    show: () => calls.push('show'),
    isMinimized: () => true,
    restore: () => calls.push('restore'),
    focus: () => calls.push('focus')
  };
  let recreateCalls = 0;
  const showWindow = createShowWindow({
    getMainWindow: () => mainWindow,
    getIsQuitting: () => false,
    recreateWindow: () => { recreateCalls += 1; }
  });
  showWindow();
  assert.deepEqual(calls, ['show', 'restore', 'focus']);
  assert.equal(recreateCalls, 0, '窗口健康时不应重建');
});

test('createShowWindow skips restore/focus when window has no isMinimized', () => {
  const calls = [];
  const mainWindow = {
    isDestroyed: () => false,
    show: () => calls.push('show'),
    focus: () => calls.push('focus')
  };
  const showWindow = createShowWindow({
    getMainWindow: () => mainWindow,
    getIsQuitting: () => false,
    recreateWindow: () => {}
  });
  showWindow();
  assert.deepEqual(calls, ['show', 'focus']);
});

test('createShowWindow rejects missing dependencies', () => {
  assert.throws(() => createShowWindow(), /createShowWindow 需要/);
  assert.throws(() => createShowWindow({ getMainWindow: () => null, getIsQuitting: () => false }), /createShowWindow 需要/);
});
