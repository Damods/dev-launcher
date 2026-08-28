const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ProcessManager, findCachedMavenExecutable, isLocalRuntimeUrl, detectPortConflict } = require('../src/main/process-manager');

function waitFor(predicate, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeout) {
        clearInterval(timer);
        reject(new Error('等待进程状态超时'));
      }
    }, 30);
  });
}

test('process manager captures logs and URLs from a real process', async () => {
  const manager = new ProcessManager();
  const project = {
    id: 'process-test',
    type: 'frontend',
    path: process.cwd(),
    launch: {
      configured: true,
      command: path.basename(process.execPath),
      args: ['-e', 'console.log("Ready at http://localhost:4321"); setTimeout(() => process.exit(0), 50)'],
      workingDirectory: process.cwd(),
      env: {},
      encoding: 'utf8',
      url: ''
    }
  };
  manager.start(project);
  await waitFor(() => ['stopped', 'failed'].includes(manager.getSnapshot(project.id).state));
  const snapshot = manager.getSnapshot(project.id);
  assert.equal(snapshot.state, 'stopped');
  assert.deepEqual(snapshot.urls, ['http://localhost:4321']);
  assert.match(snapshot.logs.map((line) => line.text).join('\n'), /Ready at/);
});

test('each project has an isolated process and log stream', async () => {
  const manager = new ProcessManager();
  const makeProject = (id, marker) => ({
    id,
    type: 'frontend',
    path: process.cwd(),
    launch: {
      configured: true,
      command: path.basename(process.execPath),
      args: ['-e', `console.log("${marker}"); setTimeout(() => process.exit(0), 80)`],
      workingDirectory: process.cwd(),
      env: {},
      encoding: 'utf8',
      url: ''
    }
  });
  await manager.start(makeProject('project-a', 'ONLY_PROJECT_A'));
  await manager.start(makeProject('project-b', 'ONLY_PROJECT_B'));
  await assert.rejects(manager.start(makeProject('project-a', 'DUPLICATE')), /已经在运行/);
  // 重复启动不能覆盖正在运行实例的状态。
  assert.equal(manager.getSnapshot('project-a').state, 'running');
  await waitFor(() => ['stopped', 'failed'].includes(manager.getSnapshot('project-a').state) && ['stopped', 'failed'].includes(manager.getSnapshot('project-b').state));
  const logsA = manager.getSnapshot('project-a').logs.map((line) => line.text).join('\n');
  const logsB = manager.getSnapshot('project-b').logs.map((line) => line.text).join('\n');
  assert.match(logsA, /ONLY_PROJECT_A/);
  assert.doesNotMatch(logsA, /ONLY_PROJECT_B/);
  assert.match(logsB, /ONLY_PROJECT_B/);
  assert.doesNotMatch(logsB, /ONLY_PROJECT_A/);
});

test('cached Maven bypasses an incompatible Windows wrapper script', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-launcher-maven-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const wrapperPath = path.join(root, 'project', 'mvnw.cmd');
  const distributionUrl = 'https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.14/apache-maven-3.9.14-bin.zip';
  const hash = crypto.createHash('sha256').update(distributionUrl).digest('hex');
  const cachedMaven = path.join(root, 'm2', 'wrapper', 'dists', 'apache-maven-3.9.14', hash, 'bin', 'mvn.cmd');
  await fs.mkdir(path.dirname(wrapperPath), { recursive: true });
  await fs.mkdir(path.join(path.dirname(wrapperPath), '.mvn', 'wrapper'), { recursive: true });
  await fs.mkdir(path.dirname(cachedMaven), { recursive: true });
  await fs.writeFile(wrapperPath, '@exit /b 1');
  await fs.writeFile(path.join(path.dirname(wrapperPath), '.mvn', 'wrapper', 'maven-wrapper.properties'), `distributionUrl=${distributionUrl}\n`);
  await fs.writeFile(cachedMaven, '@exit /b 0');

  assert.equal(findCachedMavenExecutable(wrapperPath, { MAVEN_USER_HOME: path.join(root, 'm2') }), cachedMaven);
});

test('only local application URLs mark a process as ready', () => {
  assert.equal(isLocalRuntimeUrl('https://repo.maven.apache.org/maven2'), false);
  assert.equal(isLocalRuntimeUrl('http://localhost:8080'), true);
  assert.equal(isLocalRuntimeUrl('http://192.168.1.20:5173'), true);
});

test('database startup errors remain visible after the process exits', async () => {
  const manager = new ProcessManager();
  const project = {
    id: 'database-error-test',
    type: 'frontend',
    path: process.cwd(),
    launch: {
      configured: true,
      command: path.basename(process.execPath),
      args: ['-e', 'console.error("Communications link failure"); process.exit(1)'],
      workingDirectory: process.cwd(),
      env: {},
      encoding: 'utf8',
      url: ''
    }
  };
  manager.start(project);
  await waitFor(() => manager.getSnapshot(project.id).state === 'failed');
  assert.match(manager.getSnapshot(project.id).error, /数据库连接失败/);
});

test('stop waits for the child process to exit before resolving', async (t) => {
  const manager = new ProcessManager({ stopTimeout: 3000, forceKillTimeout: 1500 });
  const project = {
    id: 'stop-waits-test',
    type: 'frontend',
    path: process.cwd(),
    launch: {
      configured: true,
      command: path.basename(process.execPath),
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      workingDirectory: process.cwd(),
      env: {},
      encoding: 'utf8',
      url: ''
    }
  };
  t.after(() => manager.stop(project.id));
  manager.start(project);
  await waitFor(() => manager.getSnapshot(project.id).state === 'running');
  const stopped = await manager.stop(project.id);
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.pid, undefined);
  assert.deepEqual(manager.runningIds(), []);
});

test('restart never launches a replacement before the old process exits', async (t) => {
  const manager = new ProcessManager({ stopTimeout: 3000, forceKillTimeout: 1500 });
  const project = {
    id: 'restart-test',
    type: 'frontend',
    path: process.cwd(),
    launch: {
      configured: true,
      command: path.basename(process.execPath),
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      workingDirectory: process.cwd(),
      env: {},
      encoding: 'utf8',
      url: ''
    }
  };
  t.after(() => manager.stop(project.id));
  const first = await manager.start(project);
  const restarted = await manager.restart(project);
  assert.notEqual(restarted.pid, first.pid);
  assert.equal(restarted.state, 'running');
});

test('startMany validates every project before starting any member', async () => {
  const manager = new ProcessManager();
  const valid = {
    id: 'group-valid',
    type: 'frontend',
    path: process.cwd(),
    launch: {
      configured: true,
      command: path.basename(process.execPath),
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      workingDirectory: process.cwd(),
      env: {},
      encoding: 'utf8',
      url: ''
    }
  };
  const invalid = {
    ...valid,
    id: 'group-invalid',
    launch: { ...valid.launch, configured: false, command: '' }
  };
  await assert.rejects(manager.startMany([valid, invalid]), /启动配置不完整/);
  assert.equal(manager.getSnapshot(valid.id).state, 'idle');
  assert.deepEqual(manager.runningIds(), []);
});

test('log events carry only incremental lines instead of the full log snapshot', async () => {
  const updates = [];
  const manager = new ProcessManager({ onUpdate: (update) => updates.push(update) });
  const project = {
    id: 'incremental-log-test',
    type: 'frontend',
    path: process.cwd(),
    launch: {
      configured: true,
      command: path.basename(process.execPath),
      args: ['-e', 'console.log("INCREMENTAL_LOG");'],
      workingDirectory: process.cwd(),
      env: {},
      encoding: 'utf8',
      url: ''
    }
  };
  manager.start(project);
  await waitFor(() => updates.some((update) => update.event === 'log' && update.lines?.some((line) => line.source === 'stdout' && line.text.includes('INCREMENTAL_LOG'))));
  const update = updates.find((item) => item.event === 'log' && item.lines?.some((line) => line.source === 'stdout' && line.text.includes('INCREMENTAL_LOG')));
  assert.equal(Object.hasOwn(update.snapshot, 'logs'), false);
  assert.equal(typeof update.lines[0].time, 'string');
  assert.ok(update.lines.some((line) => line.source === 'stdout'));
});

function fakeInstance(id, encoding = 'auto') {
  return { projectId: id, state: 'running', process: null, logs: [], urls: new Set(), encoding, pendingBytes: Buffer.alloc(0), error: null };
}

test('UTF-8 characters split across chunks decode without mojibake', () => {
  const manager = new ProcessManager();
  manager.instances.set('decode-utf8', fakeInstance('decode-utf8'));
  const bytes = Buffer.from('你好世界', 'utf8');
  manager.append('decode-utf8', 'stdout', bytes.subarray(0, 5)); // 切断在“好”的多字节中间
  manager.append('decode-utf8', 'stdout', bytes.subarray(5));
  manager.flushPendingBytes('decode-utf8');
  const text = manager.getSnapshot('decode-utf8').logs.map((line) => line.text).join('');
  assert.equal(text, '你好世界');
  assert.ok(!text.includes('�'));
});

test('GBK characters split across chunks decode without mojibake', () => {
  const manager = new ProcessManager();
  manager.instances.set('decode-gbk', fakeInstance('decode-gbk', 'system'));
  manager.append('decode-gbk', 'stdout', Buffer.from([0xD6])); // “中”的 GBK 首字节
  manager.append('decode-gbk', 'stdout', Buffer.from([0xD0, 0x0A]));
  const text = manager.getSnapshot('decode-gbk').logs.map((line) => line.text).join('');
  assert.equal(text, '中');
});

test('normal startup logs are not misreported as port conflicts', () => {
  assert.equal(detectPortConflict('Tomcat started on port 8080 (http) with context path'), null);
  assert.equal(detectPortConflict('Server running at http://localhost:3000'), null);
  assert.equal(detectPortConflict('Netty started on port 9090'), null);
  assert.match(detectPortConflict('Error: listen EADDRINUSE: address already in use :::8080'), /8080/);
  assert.match(detectPortConflict('java.net.BindException: Address already in use: bind'), /端口/);
  assert.match(detectPortConflict('Port 8080 is already in use'), /8080/);
});

test('a live instance is not marked failed by a duplicate start attempt', async () => {
  const manager = new ProcessManager();
  const project = {
    id: 'duplicate-guard-test',
    type: 'frontend',
    path: process.cwd(),
    launch: {
      configured: true,
      command: path.basename(process.execPath),
      args: ['-e', 'setTimeout(() => process.exit(0), 150)'],
      workingDirectory: process.cwd(),
      env: {},
      encoding: 'utf8',
      url: ''
    }
  };
  await manager.start(project);
  await assert.rejects(manager.start(project), /已经在运行/);
  assert.equal(manager.getSnapshot(project.id).state, 'running');
  await waitFor(() => ['stopped', 'failed'].includes(manager.getSnapshot(project.id).state));
  assert.equal(manager.getSnapshot(project.id).state, 'stopped');
});

test('stop requests a graceful tree exit before forcing', async (t) => {
  const killCalls = [];
  const manager = new ProcessManager({
    stopTimeout: 3000,
    forceKillTimeout: 1500,
    gracefulTimeout: 500,
    killProcessTree: async (pid, options) => { killCalls.push({ pid, ...options }); return { ok: true }; }
  });
  const project = {
    id: 'graceful-stop-test',
    type: 'frontend',
    path: process.cwd(),
    launch: {
      configured: true,
      command: path.basename(process.execPath),
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      workingDirectory: process.cwd(),
      env: {},
      encoding: 'utf8',
      url: ''
    }
  };
  t.after(() => { try { manager.instances.get(project.id)?.process?.kill('SIGKILL'); } catch {} });
  await manager.start(project);
  await waitFor(() => manager.getSnapshot(project.id).state === 'running');
  await manager.stop(project.id);
  assert.equal(killCalls[0].force, false);
  assert.ok(killCalls.some((call) => call.force === true));
});
