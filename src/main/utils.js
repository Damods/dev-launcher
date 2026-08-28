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

module.exports = { normalizePath, projectId, stripAnsi, extractUrls, parseArgs, quoteWindowsArg };
