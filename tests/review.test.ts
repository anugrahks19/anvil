import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeProposalFile, checkBufferSyntax, classifyFileIntent } from '../src/review/analysis';
import { ProposalStore } from '../src/review/proposalStore';

test('requires explicit hunk selection and keeps rejected hunks unchanged', () => {
  const store = new ProposalStore();
  const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const after = before.replace('line 2', 'new 2').replace('line 18', 'new 18');
  const proposal = store.stage('file.py', before, after);
  assert.equal(proposal.files[0].hunks.length, 2);
  assert.throws(() => store.selected(proposal.id), /Review each hunk/);
  store.select(proposal.id, [proposal.files[0].hunks[0].id]);
  assert.equal(store.selected(proposal.id)[0].resultText, before.replace('line 2', 'new 2'));
});

test('aggregates staged edits in multiple files under one proposal', () => {
  const store = new ProposalStore();
  const first = store.stage('one.py', 'a\n', 'A\n');
  const second = store.stage('two.py', 'b\n', 'B\n');
  assert.equal(first.id, second.id);
  assert.deepEqual(second.files.map(file => file.path), ['one.py', 'two.py']);
  store.select(second.id, second.files.flatMap(file => file.hunks.map(hunk => hunk.id)));
  assert.deepEqual(store.selected(second.id).map(file => file.resultText), ['A\n', 'B\n']);
});

test('preserves newlines for created files and CRLF files', () => {
  const store = new ProposalStore();
  const created = store.stage('new.py', '', 'print("hi")\n');
  store.select(created.id, [created.files[0].hunks[0].id]);
  assert.equal(store.selected(created.id)[0].resultText, 'print("hi")\n');
  store.clear();
  const windows = store.stage('old.py', 'a\r\nb\r\n', 'a\r\nB\r\n');
  store.select(windows.id, [windows.files[0].hunks[0].id]);
  assert.equal(store.selected(windows.id)[0].resultText, 'a\r\nB\r\n');
});

test('cannot select an unknown hunk or apply stale proposal after clearing', () => {
  const store = new ProposalStore();
  const proposal = store.stage('file.py', 'a\n', 'b\n');
  assert.throws(() => store.select(proposal.id, ['fake']), /Unknown hunk/);
  store.clear();
  assert.throws(() => store.select(proposal.id, []), /no longer exists/);
});

test('computes blast radius, intent categories, and touched symbols across production, test, and docs files', () => {
  assert.equal(classifyFileIntent('src/flask/cli.py'), 'production');
  assert.equal(classifyFileIntent('tests/test_cli.py'), 'test');
  assert.equal(classifyFileIntent('docs/cli.rst'), 'docs');
  assert.equal(classifyFileIntent('pyproject.toml'), 'config');

  const store = new ProposalStore();
  const basePy = 'def get_debug_flag():\n    val = "0"\n    return val not in {"0", "false"}\n';
  const nextPy = 'def get_debug_flag():\n    val = "0"\n    return val not in {"0", "false", "off", "n"}\n';
  store.stage('src/flask/helpers.py', basePy, nextPy);
  store.stage('tests/test_cli.py', 'def test_help():\n    assert True\n', 'def test_help():\n    assert True\n\ndef test_config():\n    assert True\n');
  const proposal = store.stage('docs/cli.rst', 'CLI\n===\n\nOld text.\n', 'CLI\n===\n\nOld text.\n\nConfig\n------\nAdded docs.\n');

  const prod = analyzeProposalFile(proposal.files[0]);
  assert.equal(prod.category, 'production');
  assert.deepEqual([prod.addedLines, prod.removedLines], [1, 1]);
  assert.ok(prod.touchedSymbols.includes('get_debug_flag'));

  const testFile = analyzeProposalFile(proposal.files[1]);
  assert.equal(testFile.category, 'test');
  assert.ok(testFile.touchedSymbols.includes('test_config'));

  const docs = analyzeProposalFile(proposal.files[2]);
  assert.equal(docs.category, 'docs');
  assert.ok(docs.addedLines >= 3);
});

test('runs zero-disk-write pre-apply syntax diagnostics on Python and JSON buffers', async () => {
  const validJson = await checkBufferSyntax('config/sample.json', '{"ok": true}');
  assert.equal(validJson?.status, 'clean');
  assert.equal(validJson?.newErrorCount, 0);

  const badJson = await checkBufferSyntax('config/sample.json', '{"ok": }');
  assert.equal(badJson?.status, 'errors');
  assert.equal(badJson?.newErrorCount, 1);

  const validPy = await checkBufferSyntax('src/app.py', 'def ok():\n    return 1\n');
  if (validPy) {
    assert.equal(validPy.status, 'clean');
    const badPy = await checkBufferSyntax('src/app.py', 'def broken(:\n    return 1\n');
    assert.equal(badPy?.status, 'errors');
    assert.equal(badPy?.issues[0]?.line, 1);
    assert.equal(badPy?.issues[0]?.source, 'python-ast');
  }
});
