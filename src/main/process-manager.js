const { execFile, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { extractUrls, stripAnsi, quoteWindowsArg } = require('./utils');

const execFileAsync = promisify(execFile);
const ACTIVE_STATES = ['starting', 'running', 'ready', 'stopping', 'stop_failed'];
// 待解码字节缓冲超过该值时先解码输出,避免无换行的超长输出无限堆积。
const MAX_PENDING_BYTES = 64 * 1024;

function findCachedMavenExecutable(wrapperPath, env = process.env) {
  if (path.basename(wrapperPath).toLowerCase() !== 'mvnw.cmd') return null;

  const propertiesPath = path.join(path.dirname(wrapperPath), '.mvn', 'wrapper', 'maven-wrapper.properties');
  let properties;
  try {
    properties = fs.readFileSync(propertiesPath, 'utf8');
  } catch {
    return null;
  }

  const match = properties.match(/^\s*distributionUrl\s*=\s*(.+?)\s*$/m);
  if (!match) return null;
  const distributionUrl = match[1].replace(/\\:/g, ':').replace(/\\\\/g, '\\');
  const archiveName = distributionUrl.split(/[\\/]/).pop()?.split(/[?#]/)[0];
  if (!archiveName) return null;
  const distributionName = archiveName.replace(/\.(?:zip|tar\.gz)$/i, '').replace(/-bin$/i, '');
  const userHome = env.MAVEN_USER_HOME || (env.HOME ? path.join(env.HOME, '.m2') : null) || (env.USERPROFILE ? path.join(env.USERPROFILE, '.m2') : null);
  if (!userHome) return null;

  // Maven Wrapper 3.3.x stores the unpacked executable at this deterministic
  // location. Launching it directly avoids a known Windows PowerShell failure
  // in generated mvnw.cmd scripts while preserving the requested Maven version.
  const urlHash = crypto.createHash('sha256').update(distributionUrl).digest('hex');
  const executable = path.join(userHome, 'wrapper', 'dists', distributionName, urlHash, 'bin', 'mvn.cmd');
  return fs.existsSync(executable) ? executable : null;
}

function isLocalRuntimeUrl(value) {
  try {
    const hostname = new URL(value).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (hostname === 'localhost' || hostname === '::1' || hostname === '0.0.0.0' || hostname.endsWith('.local')) return true;
    if (/^127\./.test(hostname) || /^10\./.test(hostname) || /^192\.168\./.test(hostname)) return true;
    const private172 = hostname.match(/^172\.(\d+)\./);
    return Boolean(private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31);
  } catch {
    return false;
  }
}

// 只匹配明确的端口冲突特征,避免把 "Tomcat started on port 8080" 这类
// 正常启动日志误判为端口占用。
const PORT_CONFLICT_PATTERN = /EADDRINUSE|address already in use|BindException|port\s+\d{2,5}\s+(?:is|was)\s+already\s+in\s+use/i;

function detectPortConflict(text) {
  if (!PORT_CONFLICT_PATTERN.test(text)) return null;
  const port = text.match(/(?:port\s+|::|:)(\d{2,5})\b/i)?.[1];
  return port ? `端口 ${port} 已被占用` : '启动端口已被占用';
}

// 日志按“完整行”批量解码:多字节字符不会跨行,因此只要凑齐到换行符再解码,
// UTF-8/GBK 都不会在 chunk 边界产生乱码。剩余不足一行的字节留到下一批。
function decodeLogBytes(bytes, encoding) {
  if (encoding === 'system') return new TextDecoder('gbk').decode(bytes);
  if (encoding === 'utf8') return new TextDecoder('utf-8').decode(bytes);
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  return utf8.includes('�') ? new TextDecoder('gbk').decode(bytes) : utf8;
}

async function probeHttpReady(url, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // 任何 HTTP 响应(含 4xx/5xx)都说明端口上已有服务在监听。
    await fetch(url, { signal: controller.signal, redirect: 'manual' });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function terminateProcessTree(pid, { timeoutMs = 5000, force = true } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let killer;
    try {
      const args = force ? ['/PID', String(pid), '/T', '/F'] : ['/PID', String(pid), '/T'];
      killer = spawn('taskkill.exe', args, { windowsHide: true });
    } catch (error) {
      finish({ ok: false, error });
      return;
    }
    killer.once('exit', (code) => finish({ ok: code === 0, code }));
    killer.once('error', (error) => finish({ ok: false, error }));
    timer = setTimeout(() => {
      try { killer.kill(); } catch {}
      finish({ ok: false, timeout: true });
    }, timeoutMs);
  });
}

function waitWithTimeout(promise, timeoutMs) {
  return Promise.race([
    promise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs))
  ]);
}

class ProcessManager {
  constructor({ maxLogLines = 10000, onUpdate = () => {}, stopTimeout = 5000, forceKillTimeout = 1500, gracefulTimeout = 1500, killProcessTree = terminateProcessTree } = {}) {
    this.maxLogLines = maxLogLines;
    this.onUpdate = onUpdate;
    this.stopTimeout = stopTimeout;
    this.forceKillTimeout = forceKillTimeout;
    this.gracefulTimeout = gracefulTimeout;
    this.killProcessTree = killProcessTree;
    this.instances = new Map();
    this.resolvedExecutables = new Map();
    this.startingProjects = new Set();
  }

  getSnapshot(projectId, { includeLogs = true } = {}) {
    const instance = this.instances.get(projectId);
    if (!instance) return { projectId, state: 'idle', logs: [], urls: [] };
    const snapshot = {
      projectId,
      state: instance.state,
      pid: instance.process?.pid,
      startedAt: instance.startedAt,
      exitCode: instance.exitCode,
      error: instance.error,
      urls: [...instance.urls]
    };
    if (includeLogs) snapshot.logs = [...instance.logs];
    return snapshot;
  }

  getAllSnapshots() {
    return [...this.instances.keys()].map((id) => this.getSnapshot(id));
  }

  runningIds() {
    return [...this.instances.entries()].filter(([, value]) => ACTIVE_STATES.includes(value.state)).map(([id]) => id);
  }

  emit(projectId, event, payload = {}) {
    this.onUpdate({ projectId, event, ...payload, snapshot: this.getSnapshot(projectId, { includeLogs: event !== 'log' }) });
  }

  append(projectId, source, chunk) {
    const instance = this.instances.get(projectId);
    if (!instance) return;
    let decoded = chunk;
    if (Buffer.isBuffer(chunk)) {
      const selected = instance.encoding || 'auto';
      instance.pendingBytes = instance.pendingBytes?.length ? Buffer.concat([instance.pendingBytes, chunk]) : chunk;
      const newlineIndex = instance.pendingBytes.lastIndexOf(0x0A);
      let ready;
      if (newlineIndex >= 0) {
        ready = instance.pendingBytes.subarray(0, newlineIndex + 1);
        instance.pendingBytes = instance.pendingBytes.subarray(newlineIndex + 1);
      } else if (instance.pendingBytes.length > MAX_PENDING_BYTES) {
        ready = instance.pendingBytes;
        instance.pendingBytes = Buffer.alloc(0);
      } else {
        // 不足一行,等后续数据凑齐,避免多字节字符在 chunk 边界被切断。
        return;
      }
      decoded = decodeLogBytes(ready, selected);
    }
    this.appendDecoded(projectId, source, decoded);
  }

  appendDecoded(projectId, source, decoded) {
    const instance = this.instances.get(projectId);
    if (!instance) return;
    const clean = stripAnsi(String(decoded)).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const entries = clean.split('\n')
      .filter((line, index, all) => line || index < all.length - 1)
      .map((line) => ({ time: new Date().toISOString(), source, text: line }));
    instance.logs.push(...entries);
    if (instance.logs.length > this.maxLogLines) instance.logs.splice(0, instance.logs.length - this.maxLogLines);
    const foundUrls = extractUrls(clean);
    for (const url of foundUrls) instance.urls.add(url);
    const conflict = detectPortConflict(clean);
    if (conflict) instance.error = conflict;
    if (/(?:Communications link failure|Could not obtain connection to query metadata|Unable to create requested service \[.*JdbcEnvironment)/i.test(clean)) {
      instance.error = '数据库连接失败，请确认 MySQL 已启动且数据库地址、账号和密码正确';
    }
    // 日志里发现本地地址后,通过真实 HTTP 探测确认服务就绪,而不是看到 URL 就直接标记。
    const localUrl = foundUrls.find(isLocalRuntimeUrl);
    if (localUrl && ['starting', 'running'].includes(instance.state)) this.probeUntilReady(projectId, localUrl);
    this.emit(projectId, 'log', { source, lines: entries, urls: [...instance.urls] });
  }

  flushPendingBytes(projectId) {
    const instance = this.instances.get(projectId);
    if (!instance?.pendingBytes?.length) return;
    const pending = instance.pendingBytes;
    instance.pendingBytes = Buffer.alloc(0);
    this.appendDecoded(projectId, 'stdout', decodeLogBytes(pending, instance.encoding || 'auto'));
  }

  async probeUntilReady(projectId, url) {
    const instance = this.instances.get(projectId);
    if (!instance || instance.probing) return;
    instance.probing = true;
    try {
      // 最多探测 90 秒,覆盖 Spring Boot 这类启动较慢的服务。
      for (let attempt = 0; attempt < 90; attempt += 1) {
        if (instance.process === null || !['starting', 'running'].includes(instance.state)) return;
        if (await probeHttpReady(url)) {
          if (['starting', 'running'].includes(instance.state)) {
            instance.state = 'ready';
            this.appendDecoded(projectId, 'system', `网页已就绪：${url}`);
            this.emit(projectId, 'state');
          }
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } finally {
      instance.probing = false;
    }
  }

  async resolveExecutable(command, cwd, env = process.env) {
    if (path.isAbsolute(command)) {
      if (!fs.existsSync(command)) throw new Error(`找不到启动命令：${command}`);
      return command;
    }
    const cacheKey = `${command} ${env.PATH || env.Path || ''} ${cwd}`;
    const cached = this.resolvedExecutables.get(cacheKey);
    if (cached && fs.existsSync(cached)) return cached;
    let stdout;
    try {
      ({ stdout } = await execFileAsync('where.exe', [command], { cwd, env, windowsHide: true }));
    } catch {
      throw new Error(`未找到命令“${command}”，请检查开发环境或修改启动配置。`);
    }
    const resolved = stdout.split(/\r?\n/).map((item) => item.trim()).find(Boolean);
    if (!resolved) throw new Error(`未找到命令“${command}”，请检查开发环境或修改启动配置。`);
    if (this.resolvedExecutables.size > 200) this.resolvedExecutables.clear();
    this.resolvedExecutables.set(cacheKey, resolved);
    return resolved;
  }

  async prepareStart(project) {
    const current = this.instances.get(project.id);
    if (current && ACTIVE_STATES.includes(current.state)) {
      throw new Error('该项目已经在运行');
    }
    if (!project.launch?.configured || !project.launch.command) throw new Error('项目启动配置不完整，请先编辑启动命令。');
    if (!fs.existsSync(project.path)) throw new Error('项目路径不存在，请重新定位项目。');
    const cwd = project.launch.workingDirectory || project.path;
    if (!fs.existsSync(cwd)) throw new Error('工作目录不存在，请修改启动配置。');

    const launchEnv = { ...process.env, ...project.launch.env };
    let executable;
    let bypassedMavenWrapper = false;
    if (project.type === 'maven' || project.type === 'gradle') {
      await this.resolveExecutable('java.exe', cwd, launchEnv);
    } else if (project.type === 'frontend') {
      await this.resolveExecutable('node.exe', cwd, launchEnv);
    }
    executable = await this.resolveExecutable(project.launch.command, cwd, launchEnv);
    if (project.type === 'maven') {
      const cachedMaven = findCachedMavenExecutable(executable, launchEnv);
      if (cachedMaven) {
        executable = cachedMaven;
        bypassedMavenWrapper = true;
      }
    }
    return { projectId: project.id, cwd, launchEnv, executable, bypassedMavenWrapper, args: project.launch.args || [] };
  }

  async start(project, prepared = null) {
    // prepareStart 是异步的,先用占位标记防止并发 start 同一项目。
    if (this.startingProjects.has(project.id)) throw new Error('该项目已经在运行');
    this.startingProjects.add(project.id);
    try {
      return await this.startInternal(project, prepared);
    } finally {
      this.startingProjects.delete(project.id);
    }
  }

  async startInternal(project, prepared = null) {
    let plan;
    try {
      plan = prepared?.projectId === project.id ? prepared : await this.prepareStart(project);
    } catch (error) {
      const existing = this.instances.get(project.id);
      // 仅在没有活进程时记录启动失败;“已经在运行”之类的错误不能覆盖运行中实例的状态。
      if (existing && !ACTIVE_STATES.includes(existing.state)) {
        existing.state = 'failed';
        existing.error = error.message;
        this.append(project.id, 'system', error.message);
        this.emit(project.id, 'state');
      }
      throw error;
    }

    const instance = {
      projectId: project.id,
      state: 'starting',
      process: null,
      logs: [],
      urls: new Set(project.launch.url ? [project.launch.url] : []),
      startedAt: new Date().toISOString(),
      exitCode: null,
      error: null,
      stopping: false,
      encoding: project.launch.encoding || 'auto',
      pendingBytes: Buffer.alloc(0),
      probing: false,
      exitPromise: null,
      resolveExit: null
    };
    this.instances.set(project.id, instance);
    this.emit(project.id, 'state');

    const { args, bypassedMavenWrapper, cwd, executable, launchEnv } = plan;
    let child;
    const extension = path.extname(executable).toLowerCase();
    if (extension === '.cmd' || extension === '.bat') {
      const commandLine = [quoteWindowsArg(executable), ...args.map(quoteWindowsArg)].join(' ');
      child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', commandLine], {
        cwd,
        env: launchEnv,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } else {
      child = spawn(executable, args, {
        cwd,
        env: launchEnv,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    }
    instance.process = child;
    instance.exitPromise = new Promise((resolve) => { instance.resolveExit = resolve; });
    instance.state = 'running';
    if (bypassedMavenWrapper) this.append(project.id, 'system', '已避开不兼容的 Maven Wrapper 脚本，使用项目对应的已缓存 Maven。');
    this.append(project.id, 'system', `已启动：${project.launch.command} ${args.join(' ')}`.trim());
    this.emit(project.id, 'state');

    // 配置了固定地址时,用真实 HTTP 探测确认就绪,而不是启动即标“网页就绪”。
    if (project.launch.url && /^https?:\/\//i.test(project.launch.url)) this.probeUntilReady(project.id, project.launch.url);

    child.stdout?.on('data', (data) => this.append(project.id, 'stdout', data));
    child.stderr?.on('data', (data) => this.append(project.id, 'stderr', data));
    let finalized = false;
    const finalize = (code, error = null) => {
      if (finalized) return;
      finalized = true;
      this.flushPendingBytes(project.id);
      instance.exitCode = code;
      instance.process = null;
      instance.state = instance.stopping ? 'stopped' : (code === 0 && !error ? 'stopped' : 'failed');
      if (error) instance.error = error.message;
      if (!instance.stopping && code !== 0 && !instance.error) instance.error = `进程异常退出，代码 ${code}`;
      this.append(project.id, 'system', instance.state === 'stopped' ? '项目已停止。' : instance.error);
      this.emit(project.id, 'state');
      instance.resolveExit?.();
    };
    child.once('error', (error) => finalize(null, error));
    child.once('exit', (code) => finalize(code));
    return this.getSnapshot(project.id);
  }

  async startMany(projects) {
    const plans = await Promise.all(projects.map((project) => this.prepareStart(project)));
    const startedIds = [];
    try {
      const snapshots = [];
      for (const [index, project] of projects.entries()) {
        snapshots.push(await this.start(project, plans[index]));
        startedIds.push(project.id);
      }
      return snapshots;
    } catch (error) {
      await Promise.allSettled(startedIds.map((id) => this.stop(id)));
      throw new Error(`启动组执行失败，已回滚本次启动的项目：${error.message}`);
    }
  }

  async stop(projectId) {
    const instance = this.instances.get(projectId);
    if (!instance?.process?.pid || !ACTIVE_STATES.includes(instance.state)) return this.getSnapshot(projectId);
    instance.stopping = true;
    instance.state = 'stopping';
    instance.error = null;
    this.emit(projectId, 'state');
    const pid = instance.process.pid;
    const child = instance.process;
    const exitPromise = instance.exitPromise || Promise.resolve();

    // 先温和地请求整棵进程树退出(相当于 WM_CLOSE),给 shutdown hook 一个执行窗口;
    // 超过优雅退出窗口仍未退出,再升级为强制终止。
    await this.killProcessTree(pid, { timeoutMs: this.gracefulTimeout, force: false });
    let exited = await waitWithTimeout(exitPromise, this.gracefulTimeout);
    if (!exited && child === instance.process) {
      this.append(projectId, 'system', '项目未响应停止请求，正在强制结束进程…');
      const termination = await this.killProcessTree(pid, { timeoutMs: this.stopTimeout, force: true });
      instance.forcedTermination = termination;
      exited = await waitWithTimeout(exitPromise, this.forceKillTimeout);
    }
    if (!exited && child === instance.process) {
      try { child.kill('SIGKILL'); } catch {}
      exited = await waitWithTimeout(exitPromise, this.forceKillTimeout);
    }
    if (!exited && instance.process) {
      instance.state = 'stop_failed';
      instance.error = instance.forcedTermination?.timeout
        ? '停止项目超时，进程可能仍在运行，请重试停止。'
        : '无法确认项目已经停止，请重试停止。';
      this.emit(projectId, 'state');
    }
    return this.getSnapshot(projectId);
  }

  async restart(project) {
    const stopped = await this.stop(project.id);
    if (stopped.state === 'stop_failed' || this.instances.get(project.id)?.process) {
      throw new Error(stopped.error || '旧进程尚未停止，无法重新启动。');
    }
    return this.start(project);
  }

  async stopAll() {
    await Promise.all(this.runningIds().map((id) => this.stop(id)));
  }

  clearLogs(projectId) {
    const instance = this.instances.get(projectId);
    if (instance) instance.logs = [];
    this.emit(projectId, 'logs-cleared');
  }
}

module.exports = { ProcessManager, findCachedMavenExecutable, isLocalRuntimeUrl, detectPortConflict, decodeLogBytes };
