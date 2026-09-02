const test = require('node:test');
const assert = require('node:assert/strict');
const { extractUrls, parseArgs, shouldQuitOnWindowClose, stripAnsi } = require('../src/main/utils');

test('extractUrls removes ANSI sequences, duplicates and trailing punctuation', () => {
  const line = '\u001b[32mReady at http://localhost:3000/path?q=1\u001b[0m, http://localhost:3000/path?q=1';
  assert.deepEqual(extractUrls(line), ['http://localhost:3000/path?q=1']);
});

test('parseArgs supports quoted arguments and spaces', () => {
  assert.deepEqual(parseArgs('run dev --name "hello world" --flag'), ['run', 'dev', '--name', 'hello world', '--flag']);
});

test('stripAnsi returns readable logs', () => {
  assert.equal(stripAnsi('\u001b[31mfailed\u001b[0m'), 'failed');
});

test('shouldQuitOnWindowClose returns true when no project is running', () => {
  assert.equal(shouldQuitOnWindowClose(0), true);
});

test('shouldQuitOnWindowClose returns false while projects are running', () => {
  assert.equal(shouldQuitOnWindowClose(1), false);
  assert.equal(shouldQuitOnWindowClose(5), false);
});

test('shouldQuitOnWindowClose tolerates undefined / null / NaN inputs', () => {
  assert.equal(shouldQuitOnWindowClose(undefined), true);
  assert.equal(shouldQuitOnWindowClose(null), true);
  assert.equal(shouldQuitOnWindowClose(Number.NaN), true);
});
