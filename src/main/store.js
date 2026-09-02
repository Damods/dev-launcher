const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_STATE = {
  version: 1,
  roots: [],
  projects: [],
  groups: [],
  settings: { maxLogLines: 10000, theme: '' }
};

function validateState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('配置文件内容不是有效对象');
  for (const key of ['roots', 'projects', 'groups']) {
    if (raw[key] !== undefined && !Array.isArray(raw[key])) throw new Error(`配置字段 ${key} 格式无效`);
  }
  if (raw.settings !== undefined && (!raw.settings || typeof raw.settings !== 'object' || Array.isArray(raw.settings))) {
    throw new Error('配置字段 settings 格式无效');
  }
  if (raw.version !== undefined && !Number.isInteger(raw.version)) throw new Error('配置版本格式无效');
  return raw;
}

class StateStore {
  constructor(filePath, encryption) {
    this.filePath = filePath;
    this.encryption = encryption;
    this.state = structuredClone(DEFAULT_STATE);
    this.backupPath = `${filePath}.bak`;
    this.primaryCorrupt = false;
    this.loadStatus = { status: 'new', message: '' };
    this.load();
  }

  readState(filePath) {
    const raw = validateState(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    const next = { ...structuredClone(DEFAULT_STATE), ...raw };
    next.settings = { ...structuredClone(DEFAULT_STATE.settings), ...(raw.settings || {}) };
    next.projects = (raw.projects || []).map((project) => ({
      ...project,
      launch: { ...project.launch, env: this.decryptEnv(project.launch?.env || {}) }
    }));
    return next;
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      this.loadStatus = { status: 'new', message: '' };
      return;
    }
    try {
      this.state = this.readState(this.filePath);
      this.loadStatus = { status: 'ok', message: '' };
    } catch (primaryError) {
      this.primaryCorrupt = true;
      try {
        this.state = this.readState(this.backupPath);
        this.loadStatus = { status: 'recovered', message: `主配置无法读取，已从备份恢复：${primaryError.message}` };
      } catch {
        this.state = structuredClone(DEFAULT_STATE);
        this.loadStatus = { status: 'reset', message: `配置无法读取，已使用安全的空白状态；原文件会在下次保存时保留：${primaryError.message}` };
      }
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const serializable = structuredClone(this.state);
    serializable.projects = serializable.projects.map((project) => ({
      ...project,
      launch: { ...project.launch, env: this.encryptEnv(project.launch?.env || {}) }
    }));
    const temporary = `${this.filePath}.tmp`;
    if (this.primaryCorrupt && fs.existsSync(this.filePath)) {
      const preserved = `${this.filePath}.corrupt-${Date.now()}`;
      fs.renameSync(this.filePath, preserved);
      this.loadStatus = { ...this.loadStatus, preservedPath: preserved };
    } else if (fs.existsSync(this.filePath)) {
      fs.copyFileSync(this.filePath, this.backupPath);
    }
    fs.writeFileSync(temporary, JSON.stringify(serializable, null, 2), 'utf8');
    fs.renameSync(temporary, this.filePath);
    this.primaryCorrupt = false;
  }

  encryptEnv(env) {
    const result = {};
    for (const [key, value] of Object.entries(env)) {
      result[key] = { encrypted: this.encryption.encrypt(String(value)) };
    }
    return result;
  }

  decryptEnv(env) {
    const result = {};
    for (const [key, entry] of Object.entries(env)) {
      if (entry && typeof entry === 'object' && entry.encrypted) {
        try { result[key] = this.encryption.decrypt(entry.encrypted); } catch { result[key] = ''; }
      } else if (typeof entry === 'string') {
        result[key] = entry;
      }
    }
    return result;
  }

  getState() {
    return structuredClone(this.state);
  }

  getLoadStatus() {
    return structuredClone(this.loadStatus);
  }

  updateSettings(patch) {
    if (patch.theme !== undefined) {
      if (!['light', 'dark', ''].includes(patch.theme)) throw new Error('主题设置无效');
      this.state.settings.theme = patch.theme;
    }
    if (patch.maxLogLines !== undefined) {
      const maxLogLines = Number(patch.maxLogLines);
      if (![1000, 5000, 10000, 20000].includes(maxLogLines)) throw new Error('日志保留上限无效');
      this.state.settings.maxLogLines = maxLogLines;
    }
    this.save();
    return structuredClone(this.state.settings);
  }

  addRoot(rootPath) {
    const normalized = path.resolve(rootPath);
    const existing = this.state.roots.find((root) => root.path.toLowerCase() === normalized.toLowerCase());
    if (existing) return existing;
    const root = { id: crypto.randomUUID(), path: normalized, enabled: true, status: 'idle', lastScannedAt: null };
    this.state.roots.push(root);
    this.save();
    return root;
  }

  removeRoot(rootId) {
    this.state.roots = this.state.roots.filter((root) => root.id !== rootId);
    this.save();
  }

  updateRoot(rootId, patch) {
    const root = this.state.roots.find((item) => item.id === rootId);
    if (root) Object.assign(root, patch);
    this.save();
  }

  mergeScannedProjects(rootPath, scannedProjects) {
    const resolvedRoot = path.resolve(rootPath);
    const scannedIds = new Set(scannedProjects.map((project) => project.id));
    for (const existing of this.state.projects) {
      const relative = path.relative(resolvedRoot, existing.path);
      const belongsToRoot = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
      if (belongsToRoot && !scannedIds.has(existing.id)) existing.missing = true;
    }
    for (const discovered of scannedProjects) {
      const existing = this.state.projects.find((project) => project.id === discovered.id);
      if (!existing) {
        this.state.projects.push(discovered);
      } else {
        existing.path = discovered.path;
        existing.evidence = discovered.evidence;
        existing.detectedAt = discovered.detectedAt;
        existing.missing = false;
        existing.inferredLaunch = discovered.inferredLaunch;
        if (!existing.userModified) {
          existing.name = discovered.name;
          existing.launch = discovered.launch;
          existing.type = discovered.type;
        }
      }
    }
    this.save();
  }

  updateProject(projectId, patch) {
    const project = this.state.projects.find((item) => item.id === projectId);
    if (!project) throw new Error('项目不存在');
    if (patch.name !== undefined) project.name = String(patch.name).trim() || project.name;
    if (patch.hidden !== undefined) project.hidden = Boolean(patch.hidden);
    if (patch.launch) {
      project.launch = {
        ...project.launch,
        ...patch.launch,
        args: Array.isArray(patch.launch.args) ? patch.launch.args.map(String) : project.launch.args,
        env: patch.launch.env && typeof patch.launch.env === 'object' ? patch.launch.env : project.launch.env
      };
      project.userModified = true;
    }
    this.save();
    return structuredClone(project);
  }

  restoreProject(projectId) {
    const project = this.state.projects.find((item) => item.id === projectId);
    if (!project) throw new Error('项目不存在');
    project.launch = structuredClone(project.inferredLaunch);
    project.userModified = false;
    this.save();
    return structuredClone(project);
  }

  relocateProject(projectId, newPath) {
    const project = this.state.projects.find((item) => item.id === projectId);
    if (!project) throw new Error('项目不存在');
    const previousPath = project.path;
    project.path = path.resolve(newPath);
    project.missing = false;
    if (!project.userModified || project.launch.workingDirectory.toLowerCase() === previousPath.toLowerCase()) {
      project.launch.workingDirectory = project.path;
    }
    project.userModified = true;
    this.save();
    return structuredClone(project);
  }

  saveGroup(group) {
    const memberIds = [...new Set((group.projectIds || []).filter((id) => this.state.projects.some((p) => p.id === id)))];
    if (group.id) {
      const existing = this.state.groups.find((item) => item.id === group.id);
      if (!existing) throw new Error('启动组不存在');
      existing.name = String(group.name).trim() || existing.name;
      existing.projectIds = memberIds;
    } else {
      this.state.groups.push({ id: crypto.randomUUID(), name: String(group.name).trim() || '新启动组', projectIds: memberIds });
    }
    this.save();
  }

  removeGroup(groupId) {
    this.state.groups = this.state.groups.filter((group) => group.id !== groupId);
    this.save();
  }
}

module.exports = { StateStore, DEFAULT_STATE };
