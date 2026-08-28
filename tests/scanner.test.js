const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { scanRoot } = require('../src/main/scanner');

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-launcher-scan-'));
  const maven = path.join(root, '服务端');
  const frontend = path.join(root, 'web app');
  const gradle = path.join(root, 'worker');
  await fs.mkdir(maven, { recursive: true });
  await fs.mkdir(frontend, { recursive: true });
  await fs.mkdir(gradle, { recursive: true });
  await fs.writeFile(path.join(maven, 'pom.xml'), '<plugin>spring-boot-maven-plugin</plugin>');
  await fs.writeFile(path.join(maven, 'mvnw.cmd'), '@echo off');
  await fs.writeFile(path.join(frontend, 'package.json'), JSON.stringify({ name: 'my-web', scripts: { dev: 'vite' } }));
  await fs.writeFile(path.join(frontend, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
  await fs.writeFile(path.join(gradle, 'build.gradle.kts'), 'plugins { id("org.springframework.boot") }');
  await fs.mkdir(path.join(root, 'node_modules', 'ignored'), { recursive: true });
  await fs.writeFile(path.join(root, 'node_modules', 'ignored', 'package.json'), JSON.stringify({ scripts: { start: 'bad' } }));
  return root;
}

test('scanRoot detects Java and frontend projects and skips dependencies', async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await scanRoot(root);
  assert.equal(result.projects.length, 3);
  const maven = result.projects.find((project) => project.type === 'maven');
  const frontend = result.projects.find((project) => project.type === 'frontend');
  const gradle = result.projects.find((project) => project.type === 'gradle');
  assert.equal(path.basename(maven.launch.command), 'mvnw.cmd');
  assert.deepEqual(maven.launch.args, ['spring-boot:run']);
  assert.equal(frontend.name, 'my-web');
  assert.equal(frontend.launch.command, 'pnpm.cmd');
  assert.deepEqual(frontend.launch.args, ['run', 'dev']);
  assert.deepEqual(gradle.launch.args, ['bootRun']);
});

test('frontend with scripts but no preferred start script requires configuration', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-launcher-config-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node test.js' } }));
  const result = await scanRoot(root);
  assert.equal(result.projects[0].launch.configured, false);
});
