const fs = require('node:fs/promises');
const path = require('node:path');
const { projectId, normalizePath } = require('./utils');

const SKIP_DIRECTORIES = new Set([
  '.git', '.idea', '.vscode', 'node_modules', 'target', 'build', 'dist', 'out',
  '.gradle', '.mvn-cache', 'coverage', '.next', '.nuxt', '.cache'
]);

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readText(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

function baseProject(directory, type, evidence) {
  return {
    id: projectId(directory, type),
    name: path.basename(directory),
    path: path.resolve(directory),
    type,
    evidence,
    detectedAt: new Date().toISOString(),
    missing: false,
    hidden: false,
    userModified: false
  };
}

async function detectMaven(directory, pomText) {
  const wrapper = path.join(directory, 'mvnw.cmd');
  const springBoot = /spring-boot-(?:maven-plugin|starter)/i.test(pomText);
  const project = baseProject(directory, 'maven', 'pom.xml');
  project.launch = {
    command: (await exists(wrapper)) ? wrapper : 'mvn.cmd',
    args: springBoot ? ['spring-boot:run'] : [],
    workingDirectory: directory,
    env: {},
    url: '',
    encoding: 'auto',
    configured: springBoot
  };
  project.inferredLaunch = structuredClone(project.launch);
  return project;
}

async function detectGradle(directory, gradleText, evidence) {
  const wrapper = path.join(directory, 'gradlew.bat');
  const springBoot = /org\.springframework\.boot|spring-boot/i.test(gradleText);
  const project = baseProject(directory, 'gradle', evidence);
  project.launch = {
    command: (await exists(wrapper)) ? wrapper : 'gradle.bat',
    args: springBoot ? ['bootRun'] : [],
    workingDirectory: directory,
    env: {},
    url: '',
    encoding: 'auto',
    configured: springBoot
  };
  project.inferredLaunch = structuredClone(project.launch);
  return project;
}

async function detectFrontend(directory, packageText) {
  let manifest;
  try {
    manifest = JSON.parse(packageText);
  } catch {
    return null;
  }
  const scripts = manifest.scripts || {};
  const script = ['dev', 'start', 'serve'].find((candidate) => typeof scripts[candidate] === 'string');
  if (!script && Object.keys(scripts).length === 0) return null;

  let manager = 'npm';
  if (await exists(path.join(directory, 'pnpm-lock.yaml'))) manager = 'pnpm';
  else if (await exists(path.join(directory, 'yarn.lock'))) manager = 'yarn';

  const command = `${manager}.cmd`;
  const args = script ? (manager === 'yarn' ? [script] : ['run', script]) : [];
  const project = baseProject(directory, 'frontend', 'package.json');
  project.name = manifest.name || project.name;
  project.launch = {
    command,
    args,
    workingDirectory: directory,
    env: {},
    url: '',
    encoding: 'auto',
    configured: Boolean(script)
  };
  project.inferredLaunch = structuredClone(project.launch);
  return project;
}

async function inspectDirectory(directory, filenames) {
  const found = [];
  if (filenames.has('pom.xml')) {
    found.push(await detectMaven(directory, await readText(path.join(directory, 'pom.xml'))));
  } else if (filenames.has('build.gradle') || filenames.has('build.gradle.kts')) {
    const filename = filenames.has('build.gradle.kts') ? 'build.gradle.kts' : 'build.gradle';
    found.push(await detectGradle(directory, await readText(path.join(directory, filename)), filename));
  }
  if (filenames.has('package.json')) {
    const frontend = await detectFrontend(directory, await readText(path.join(directory, 'package.json')));
    if (frontend) found.push(frontend);
  }
  return found;
}

function scanCancelledError() {
  const error = new Error('扫描已取消');
  error.code = 'SCAN_CANCELLED';
  return error;
}

// 有界并发遍历:目录 IO 并行推进,同时限制并发数避免打满文件句柄。
async function mapLimit(items, limit, iterator, signal) {
  const executing = new Set();
  for (const item of items) {
    if (signal?.aborted) throw scanCancelledError();
    const task = Promise.resolve().then(() => iterator(item));
    executing.add(task);
    task.finally(() => executing.delete(task));
    if (executing.size >= limit) await Promise.race(executing);
  }
  await Promise.all(executing);
}

async function scanRoot(rootPath, onProgress = () => {}, { signal, concurrency = 8 } = {}) {
  const root = path.resolve(rootPath);
  const projects = [];
  const visited = new Set();
  let directoriesScanned = 0;

  async function walk(directory) {
    if (signal?.aborted) throw scanCancelledError();
    let real;
    try {
      real = normalizePath(await fs.realpath(directory));
    } catch {
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);

    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    directoriesScanned += 1;
    if (directoriesScanned % 50 === 0) onProgress({ root, directoriesScanned, projectsFound: projects.length });

    const filenames = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
    projects.push(...await inspectDirectory(directory, filenames));

    const children = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !SKIP_DIRECTORIES.has(entry.name));
    await mapLimit(children, concurrency, (child) => walk(path.join(directory, child.name)), signal);
  }

  await walk(root);
  onProgress({ root, directoriesScanned, projectsFound: projects.length, complete: true });
  return { projects, directoriesScanned };
}

module.exports = { scanRoot, inspectDirectory, SKIP_DIRECTORIES };
