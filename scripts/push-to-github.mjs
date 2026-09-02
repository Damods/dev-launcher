// One-shot pusher: replay the FULL local commit chain onto GitHub via Git
// Database API. Remote main currently points at a synthetic commit chain
// (no common ancestor with local history), so the final ref update must be
// a force update. Tags for v1.9.0 / v1.11.1 keep pointing at the old
// synthetic commits — Releases are unaffected.
// Usage: GITHUB_TOKEN=ghp_xxx node scripts/push-to-github.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const REPO = 'Damods/dev-launcher';
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) { console.error('Missing GITHUB_TOKEN env var'); process.exit(1); }

const API = 'https://api.github.com';
const H = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'dev-launcher-pusher',
};

const run = (args) =>
  execFileSync('git', args, { cwd: process.cwd(), maxBuffer: 256 * 1024 * 1024 });
const out = (args) => run(args).toString();

async function api(method, path, body, upload = false) {
  const url = path.startsWith('http') ? path : API + path;
  const res = await fetch(url, {
    method,
    headers: upload
      ? { ...H, 'Content-Type': 'application/octet-stream' }
      : { ...H, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : (upload ? body : JSON.stringify(body)),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

async function main() {
  const localHead = out(['rev-parse', 'HEAD']).trim();
  const ref = await api('GET', `/repos/${REPO}/git/ref/heads/main`);
  const remoteHead = ref.object.sha;
  console.log(`Remote main HEAD: ${remoteHead}`);
  console.log(`Local  HEAD:      ${localHead}`);
  if (remoteHead === localHead) { console.log('Already in sync.'); return; }

  // Full local chain, oldest first (root commit included — parallel history).
  const commits = out(['rev-list', '--reverse', 'HEAD']).trim().split('\n').filter(Boolean);
  console.log(`Commits to replay: ${commits.length} (force update at the end)`);

  const blobCache = new Map();
  const shaMap = {}; // local commit sha -> remote commit sha
  let rootCount = 0;

  for (const sha of commits) {
    const isRoot = rootCount++ === 0 && out(['rev-list', '--max-parents=0', sha]).trim() === sha;
    const parentLocal = isRoot ? null : out(['rev-parse', `${sha}^`]).trim();
    const parentRemote = parentLocal ? (shaMap[parentLocal] ?? parentLocal) : null;
    const subject = out(['log', '-1', '--format=%s', sha]).trim();
    console.log(`- ${sha.slice(0, 7)} ${subject}`);

    const msg = out(['log', '-1', '--format=%B', sha]);
    const [an, ae, ad] = out(['log', '-1', '--format=%an%x00%ae%x00%aI', sha]).split('\x00');
    const [cn, ce, cd] = out(['log', '-1', '--format=%cn%x00%ce%x00%cI', sha]).split('\x00');

    // Root commit: full tree, no base_tree. Others: delta against parent tree.
    const diff = isRoot
      ? out(['-c', 'core.quotepath=false', 'ls-tree', '-r', sha])
      : out(['-c', 'core.quotepath=false', 'diff-tree', '-r', '--no-commit-id', '--no-renames', parentLocal, sha]);
    const entries = [];
    for (const line of diff.split('\n').filter(Boolean)) {
      let oldMode, newMode, newSha, path, status;
      if (isRoot) {
        const m = line.match(/^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/);
        if (!m) throw new Error(`Cannot parse ls-tree line: ${JSON.stringify(line)}`);
        [, newMode, , newSha, path] = m; status = 'A';
      } else {
        const m = line.match(/^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) (\w+)\t(.+)$/);
        if (!m) throw new Error(`Cannot parse diff line: ${JSON.stringify(line)}`);
        [, oldMode, newMode, , newSha, status, path] = m;
      }
      if (status === 'D') {
        // Delete entry: GitHub requires mode+type even when sha is null.
        entries.push({ path, mode: oldMode, type: 'blob', sha: null });
      } else if (status === 'A' || status === 'M' || status === 'C' || status === 'R') {
        if (!blobCache.has(newSha)) {
          const buf = run(['cat-file', 'blob', newSha]);
          const blob = await api('POST', `/repos/${REPO}/git/blobs`, {
            content: buf.toString('base64'), encoding: 'base64',
          });
          blobCache.set(newSha, blob.sha);
        }
        entries.push({ path, mode: newMode, type: 'blob', sha: blobCache.get(newSha) });
      } else if (status === 'T') {
        throw new Error(`Type-change on ${path} not supported`);
      } else {
        throw new Error(`Unhandled status ${status} on ${path}`);
      }
    }
    console.log(`  ${entries.length} path(s), ${blobCache.size} blob(s) uploaded so far`);

    const treeBody = isRoot
      ? { tree: entries }
      : { base_tree: out(['rev-parse', `${parentLocal}^{tree}`]).trim(), tree: entries };
    const tree = await api('POST', `/repos/${REPO}/git/trees`, treeBody);
    const commit = await api('POST', `/repos/${REPO}/git/commits`, {
      message: msg, tree: tree.sha, parents: parentRemote ? [parentRemote] : [],
      author: { name: an, email: ae, date: ad },
      committer: { name: cn, email: ce, date: cd },
    });
    shaMap[sha] = commit.sha;
    console.log(`  -> ${commit.sha.slice(0, 7)}${commit.sha === sha ? ' [sha preserved]' : ''}`);
  }

  // Force update: remote history is a parallel synthetic chain, not a prefix.
  await api('PATCH', `/repos/${REPO}/git/refs/heads/main`, { sha: shaMap[localHead], force: true });
  console.log(`main force-updated to ${shaMap[localHead]}`);

  // Tags: mirror every LOCAL tag whose target commit is in the pushed chain
  // (remote tags for old synthetic commits keep their existing targets).
  const existing = await api('GET', `/repos/${REPO}/git/refs/tags`);
  const existingTags = new Set(existing.map((t) => t.ref.replace('refs/tags/', '')));
  const localTags = out(['tag', '-l']).trim().split('\n').filter(Boolean);
  for (const t of localTags) {
    if (existingTags.has(t)) { console.log(`tag ${t}: exists, skip`); continue; }
    const targetLocal = out(['rev-parse', `${t}^{commit}`]).trim();
    if (!shaMap[targetLocal]) continue; // tag not pointing into this chain, skip
    await api('POST', `/repos/${REPO}/git/refs`, { ref: `refs/tags/${t}`, sha: shaMap[targetLocal] });
    console.log(`tag ${t} -> ${shaMap[targetLocal].slice(0, 7)} created`);
  }

  // Release: driven by RELEASE_TAG (default = newest local tag). Skip if exists.
  const releaseTag = process.env.RELEASE_TAG
    || out(['tag', '-l', '--sort=-v:refname']).trim().split('\n').filter(Boolean)[0];
  const releaseVer = releaseTag.replace(/^v/, '');
  const releases = await api('GET', `/repos/${REPO}/releases`);
  if (releases.some((r) => r.tag_name === releaseTag)) {
    console.log(`Release ${releaseTag} exists, skip`);
  } else {
    const rel = await api('POST', `/repos/${REPO}/releases`, {
      tag_name: releaseTag,
      name: `Dev Launcher ${releaseTag}`,
      body: releaseNotesFor(releaseVer),
      draft: false,
      prerelease: false,
    });
    console.log(`Release ${releaseTag} created (id ${rel.id}), uploading ~97MB asset...`);
    const exePath = process.env.RELEASE_ASSET || `release-${releaseVer}/Dev Launcher Setup ${releaseVer}.exe`;
    const assetName = `Dev.Launcher.Setup.${releaseVer}.exe`;
    const exe = readFileSync(exePath);
    const asset = await api(
      'POST',
      `https://uploads.github.com/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(assetName)}`,
      exe, true,
    );
    console.log(`Asset uploaded: ${asset.browser_download_url}`);
  }

  console.log('ALL DONE');
}

function releaseNotesFor(ver) {
  const notes = {
    '1.13.3': `## 修复

### 窗口与托盘（v1.13.3）
- **修复关闭窗口后无法从托盘唤醒的问题**：点击关闭按钮现在会将窗口最小化到系统托盘（首次弹出气泡提示），应用继续在后台运行，随时点击托盘图标即可恢复窗口。此前无运行项目时关窗会直接销毁窗口并尝试退出，一旦退出被拦截就会陷入"半死"状态，只能通过任务管理器结束进程。
- 真正退出请使用托盘菜单或应用内的"退出"入口。

### 安装/升级
- 根治升级安装报错 "Failed to uninstall old application files: 2"（v1.13.2）：升级时安装器会自动结束所有 Dev Launcher 进程，升级不再被文件锁卡住。

### 稳定性
- 修复托盘点击可能触发 \`Object has been destroyed\` 崩溃：窗口销毁后点击托盘图标将自动重建窗口（v1.13.1）。

完整变更见 [Commits](https://github.com/Damods/dev-launcher/commits/main)
`
  };
  return notes[ver] || `Dev Launcher ${ver}\n\n完整变更见 [Commits](https://github.com/Damods/dev-launcher/commits/main)\n`;
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
