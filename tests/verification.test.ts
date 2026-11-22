import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ProposalStore } from '../src/review/proposalStore';
import { verifySelectedHunks } from '../src/review/verification';

test('pytest sees only the selected hunks in a temporary copy and rejects a changed base', async context => {
  const fixturePython = path.resolve('.demo/flask/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const python = process.env.FORGEATHON_FLASK_PYTHON || (existsSync(fixturePython) ? fixturePython : process.platform === 'win32' ? 'python' : 'python3');
  if (spawnSync(python, ['-m', 'pytest', '--version'], { windowsHide: true }).status !== 0) {
    context.skip('Python with pytest is needed for snapshot verification');
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), 'anvil-pytest-fixture-'));
  try {
    const source = path.join(root, 'sample.py');
    const baseline = `first = 1\n${'# keep\n'.repeat(12)}last = 3\n`;
    await writeFile(source, baseline);
    await mkdir(path.join(root, 'fixtures'));
    await writeFile(path.join(root, 'fixtures', '.env'), 'FIXTURE=true\n');
    await writeFile(path.join(root, '.env'), 'UNUSED=true\n');
    await writeFile(path.join(root, 'test_sample.py'), 'from pathlib import Path\nfrom sample import first, last\n\ndef test_changes():\n    assert Path("fixtures/.env").read_text() == "FIXTURE=true\\n"\n    assert not Path(".env").exists()\n    assert (first, last) == (2, 3)\n');
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['-c', 'core.autocrlf=false', 'add', '-f', '--', 'sample.py', 'test_sample.py', 'fixtures/.env', '.env'], { cwd: root });
    const store = new ProposalStore();
    const proposal = store.stage('sample.py', baseline, baseline.replace('first = 1', 'first = 2').replace('last = 3', 'last = 4'));
    const [first, last] = proposal.files[0].hunks;
    assert.ok(first && last);
    const signal = new AbortController().signal;
    const selected = store.selected(proposal.id, [first.id]);
    assert.throws(() => store.selected(proposal.id), /Review each hunk/);
    const result = await verifySelectedHunks(root, selected, python, 'test_sample.py', signal);
    assert.equal(result.passed, true, result.output);
    const both = await verifySelectedHunks(root, store.selected(proposal.id, [first.id, last.id]), python, 'test_sample.py', signal);
    assert.equal(both.passed, false);
    assert.equal(await readFile(source, 'utf8'), baseline);
    await writeFile(source, `${baseline}# user change\n`);
    await assert.rejects(verifySelectedHunks(root, selected, python, 'test_sample.py', signal), /Source changed during review/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
