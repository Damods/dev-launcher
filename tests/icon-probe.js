// 图标探测脚本：对指定 Electron 可执行文件（打包产物或源码）评估图标渲染状态
// 用法：DEV_LAUNCHER_EXECUTABLE="...exe" node tests/icon-probe.js
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function waitForPage(port, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let lastPages = [];
  while (Date.now() < deadline) {
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json());
      lastPages = pages;
      const page = pages.find((item) => item.type === 'page' && item.title === 'Dev Launcher');
      if (page) return page;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('窗口未启动: ' + JSON.stringify(lastPages.map(({ type, title }) => ({ type, title }))));
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
    const timeout = setTimeout(() => { socket.close(); reject(new Error('连接超时')); }, 10000);
    socket.onerror = () => { clearTimeout(timeout); reject(new Error('连接失败')); };
    socket.onopen = () => {
      clearTimeout(timeout);
      resolve({
        send(method, params = {}) {
          const id = ++sequence;
          socket.send(JSON.stringify({ id, method, params }));
          return new Promise((res, rej) => {
            const t = setTimeout(() => { pending.delete(id); rej(new Error(`命令 ${id} 超时`)); }, 15000);
            pending.set(id, { resolve: res, reject: rej, timeout: t });
          });
        },
        evaluate(expression) {
          const id = ++sequence;
          socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
          return new Promise((res, rej) => {
            const t = setTimeout(() => { pending.delete(id); rej(new Error(`命令 ${id} 超时`)); }, 15000);
            pending.set(id, { resolve: res, reject: rej, timeout: t });
          });
        },
        close: () => socket.close()
      });
    };
  });
}

async function main() {
  const electronPath = process.env.DEV_LAUNCHER_EXECUTABLE;
  if (!electronPath) { console.error('需要 DEV_LAUNCHER_EXECUTABLE 指向待测 exe'); process.exit(2); }
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-launcher-probe-'));
  const port = 19224;
  const child = spawn(electronPath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userData}`,
    '--no-sandbox', '--disable-gpu-sandbox', '--in-process-gpu', '--use-angle=swiftshader'
  ], { cwd: path.dirname(electronPath), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let client;
  try {
    const page = await waitForPage(port, 45000);
    client = await connect(page.webSocketDebuggerUrl);
    await client.evaluate(`new Promise((resolve) => { const deadline = Date.now() + 10000; const check = () => { if (document.querySelectorAll('.sidebar-root-item').length >= 4 || Date.now() >= deadline) resolve(true); else setTimeout(check, 50); }; check(); })`);
    await client.evaluate(`new Promise((resolve) => setTimeout(resolve, 500))`);
    const report = await client.evaluate(`(() => {
      const lucideTags = document.querySelectorAll('[data-lucide]');
      const lucideSvgs = document.querySelectorAll('svg.lucide');
      const imgs = [...document.querySelectorAll('img')].map((img) => ({
        src: img.getAttribute('src'), complete: img.complete, naturalWidth: img.naturalWidth
      }));
      const badImgs = imgs.filter((i) => !i.complete || i.naturalWidth === 0);
      return {
        lucideTags: lucideTags.length,
        lucideSvgs: lucideSvgs.length,
        lucideOk: lucideTags.length > 0 && lucideSvgs.length >= lucideTags.length,
        imgs,
        badImgs
      };
    })()`);
    console.log(JSON.stringify(report.result.value, null, 2));
  } finally {
    try { await client?.evaluate('window.devLauncher.quit()'); } catch {}
    client?.close();
    if (child.exitCode === null) child.kill();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
