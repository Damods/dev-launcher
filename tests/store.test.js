const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { StateStore } = require('../src/main/store');

const encryption = {
  encrypt: (value) => Buffer.from(`secure:${value}`).toString('base64'),
  decrypt: (value) => Buffer.from(value, 'base64').toString().replace(/^secure:/, '')
};

function discovered(root, command = 'mvn.cmd') {
  const launch = { command, args: ['spring-boot:run'], workingDirectory: root, env: {}, url: '', encoding: 'auto', configured: true };
  return { id: 'project-1', name: 'demo', path: root, type: 'maven', evidence: 'pom.xml', detectedAt: new Date().toISOString(), missing: false, hidden: false, userModified: false, launch, inferredLaunch: structuredClone(launch) };
}

test('manual project config survives rescanning and environment values are encrypted on disk', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-launcher-store-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state.json');
  const store = new StateStore(file, encryption);
  store.mergeScannedProjects(directory, [discovered(directory)]);
  store.updateProject('project-1', { launch: { command: 'custom.cmd', env: { TOKEN: 'secret' } } });
  store.mergeScannedProjects(directory, [discovered(directory, 'changed.cmd')]);
  assert.equal(store.getState().projects[0].launch.command, 'custom.cmd');
  const raw = await fs.readFile(file, 'utf8');
  assert.equal(raw.includes('secret'), false);
  const reloaded = new StateStore(file, encryption);
  assert.equal(reloaded.getState().projects[0].launch.env.TOKEN, 'secret');
});

test('missing projects are retained and marked instead of deleted', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-launcher-missing-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new StateStore(path.join(directory, 'state.json'), encryption);
  store.mergeScannedProjects(directory, [discovered(directory)]);
  store.mergeScannedProjects(directory, []);
  assert.equal(store.getState().projects[0].missing, true);
});

test('corrupt primary state recovers from backup and preserves the damaged file', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-launcher-recovery-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state.json');
  const store = new StateStore(file, encryption);
  store.addRoot(path.join(directory, 'code-a'));
  await fs.copyFile(file, `${file}.bak`);
  await fs.writeFile(file, '{not valid json', 'utf8');

  const recovered = new StateStore(file, encryption);
  assert.equal(recovered.getLoadStatus().status, 'recovered');
  assert.equal(recovered.getState().roots.length, 1);
  recovered.addRoot(path.join(directory, 'code-b'));

  const files = await fs.readdir(directory);
  assert.ok(files.some((name) => name.startsWith('state.json.corrupt-')));
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).roots.length, 2);
});

test('corrupt state without a backup starts safely and does not overwrite the original', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-launcher-corrupt-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state.json');
  await fs.writeFile(file, 'broken-state', 'utf8');

  const store = new StateStore(file, encryption);
  assert.equal(store.getLoadStatus().status, 'reset');
  assert.deepEqual(store.getState().projects, []);
  store.addRoot(path.join(directory, 'new-code'));

  const files = await fs.readdir(directory);
  const preserved = files.find((name) => name.startsWith('state.json.corrupt-'));
  assert.ok(preserved);
  assert.equal(await fs.readFile(path.join(directory, preserved), 'utf8'), 'broken-state');
});

test('settings updates are validated and persisted', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-launcher-settings-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state.json');
  const store = new StateStore(file, encryption);
  const settings = store.updateSettings({ maxLogLines: 5000 });
  assert.deepEqual(settings, { maxLogLines: 5000, theme: '' });
  assert.throws(() => store.updateSettings({ maxLogLines: 1234 }), /日志保留上限无效/);
  assert.throws(() => store.updateSettings({ theme: 'blue' }), /主题设置无效/);
  store.updateSettings({ theme: 'dark' });
  assert.deepEqual(new StateStore(file, encryption).getState().settings, { maxLogLines: 5000, theme: 'dark' });
});
