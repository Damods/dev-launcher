const crypto = require('node:crypto');
const path = require('node:path');

const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const URL_PATTERN = /https?:\/\/[\w.-]+(?::\d+)?(?:\/[\w\-./?%&=+#:@~]*)?/gi;

function normalizePath(value) {
  return path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
}

function projectId(projectPath, type) {
  return crypto.createHash('sha256').update(`${normalizePath(projectPath)}|${type}`).digest('hex').slice(0, 16);
}

function stripAnsi(value) {
  return String(value ?? '').replace(ANSI_PATTERN, '');
}

function extractUrls(value) {
  const matches = stripAnsi(value).match(URL_PATTERN) || [];
  return [...new Set(matches.map((url) => url.replace(/[),.;'\"]+$/, '')))];
}

function parseArgs(value) {
  if (Array.isArray(value)) return value.map(String);
  const input = String(value ?? '').trim();
  if (!input) return [];
  const args = [];
  let token = '';
  let quote = null;
  let escaped = false;
  for (const char of input) {
    if (escaped) {
      token += char;
      escaped = false;
    } else if (char === '\\' && quote === '"') {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else token += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (token) {
        args.push(token);
        token = '';
      }
    } else {
      token += char;
    }
  }
  if (token) args.push(token);
  return args;
}

function quoteWindowsArg(value) {
  const text = String(value);
  if (!/[\s"&|<>^]/.test(text)) return text;
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

// 关闭主窗口时是否直接退出主进程。
// 返回 true = 主进程可退出（无运行项目，避免 NSIS 升级检测到存活进程被阻断）；
// 返回 false = 应阻止关闭，让用户先停止运行中的项目。
// 兼容 undefined / null / NaN：当作 0 处理（保守地允许退出，避免升级卡住）。
function shouldQuitOnWindowClose(runningProjectCount) {
  if (typeof runningProjectCount !== 'number' || Number.isNaN(runningProjectCount)) return true;
  return runningProjectCount <= 0;
}

module.exports = { normalizePath, projectId, stripAnsi, extractUrls, parseArgs, quoteWindowsArg, shouldQuitOnWindowClose };
