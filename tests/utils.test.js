const test = require('node:test');
const assert = require('node:assert/strict');
const { extractUrls, parseArgs, stripAnsi } = require('../src/main/utils');

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
