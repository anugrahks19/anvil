import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assembleContext, extractReferencedFiles } from '../src/context/assembly';

test('context assembly selects explicit symbols and relevant unmentioned files within a budget', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'anvil-context-'));
  try {
    await mkdir(path.join(root, 'src', 'flask'), { recursive: true });
    await mkdir(path.join(root, 'tests'), { recursive: true });
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await writeFile(path.join(root, 'src', 'flask', 'cli.py'),
      'def config_command():\n    """Print application config as JSON."""\n    pass\n');
    await writeFile(path.join(root, 'tests', 'test_cli.py'),
      'def test_config_command():\n    assert "SECRET_KEY"\n');
    await writeFile(path.join(root, 'docs', 'cli.rst'),
      'Built-in CLI commands include the config command.\n');
    await writeFile(path.join(root, 'unrelated.txt'), 'Some unrelated prose.\n');

    const result = await assembleContext(root,
      'Add a built-in CLI config command, test it, and document it. Check @symbol(config_command) and @file(src/flask/cli.py).',
      { budgetTokens: 1500 });
    assert.ok(result.selections.some(s => s.path === 'src/flask/cli.py' && s.reason.includes('explicit')));
    assert.ok(result.selections.some(s => s.path === 'tests/test_cli.py'));
    assert.ok(result.selections.some(s => s.path === 'docs/cli.rst'));
    assert.ok(result.text.includes('Reason:'));
    assert.equal(result.budgetTokens, 1500);
    assert.ok(result.usedTokens <= 1500 + 50);
    assert.ok(result.text.length <= 1500 * 4 + 200);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('active editor selection is included without exposing a file outside the workspace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'anvil-context-'));
  try {
    await writeFile(path.join(root, 'helpers.py'), 'def get_debug_flag():\n    return True\n');
    const result = await assembleContext(root, 'Treat off as false', {
      activeFile: path.join(root, 'helpers.py'),
      selection: 'def get_debug_flag():\n    return True',
      budgetTokens: 1200,
    });
    assert.equal(result.selections[0].path, 'helpers.py');
    assert.ok(result.text.includes('Selected code in editor:'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a bare @path is a file mention and does not turn its first segment into a symbol', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'anvil-context-'));
  try {
    await mkdir(path.join(root, 'src', 'flask'), { recursive: true });
    await writeFile(path.join(root, 'src', 'flask', 'helpers.py'), 'def get_debug_flag():\n    return True\n');
    const result = await assembleContext(root, 'Edit @src/flask/helpers.py to handle off.');
    assert.ok(result.selections.some(item => item.path === 'src/flask/helpers.py' && item.reason.includes('explicit @file')));
    assert.ok(result.selections.every(item => !item.reason.includes('explicit @symbol src')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const pinnedFlask = path.resolve('.demo/flask');
test('extracts 1-hop Python and TypeScript import neighbors and explains why they were selected', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'anvil-deps-'));
  try {
    await mkdir(path.join(root, 'src', 'pkg'), { recursive: true });
    await writeFile(path.join(root, 'src', 'pkg', 'entry.py'),
      'from .helper import format_output\nfrom pkg.schema import ConfigSchema\ndef run_entry():\n    return format_output()\n');
    await writeFile(path.join(root, 'src', 'pkg', 'helper.py'),
      'def format_output():\n    return "ok"\n');
    await writeFile(path.join(root, 'src', 'pkg', 'schema.py'),
      'class ConfigSchema:\n    pass\n');
    await writeFile(path.join(root, 'src', 'web.ts'),
      "import { render } from './ui/view';\nexport const start = () => render();\n");
    await mkdir(path.join(root, 'src', 'ui'), { recursive: true });
    await writeFile(path.join(root, 'src', 'ui', 'view.ts'), 'export function render() { return "hi"; }\n');

    const pyRefs = extractReferencedFiles(
      'src/pkg/entry.py',
      'from .helper import format_output\nfrom pkg.schema import ConfigSchema\n',
      new Set(['src/pkg/entry.py', 'src/pkg/helper.py', 'src/pkg/schema.py']),
    );
    assert.deepEqual(pyRefs.sort(), ['src/pkg/helper.py', 'src/pkg/schema.py']);

    const tsRefs = extractReferencedFiles(
      'src/web.ts',
      "import { render } from './ui/view';\n",
      new Set(['src/web.ts', 'src/ui/view.ts']),
    );
    assert.deepEqual(tsRefs, ['src/ui/view.ts']);

    const context = await assembleContext(root, 'Update @file(src/pkg/entry.py) behavior');
    assert.ok(context.selections.some(item => item.path === 'src/pkg/helper.py' && item.reason.includes('imported by src/pkg/entry.py')));
    assert.ok(context.selections.some(item => item.path === 'src/pkg/schema.py' && item.reason.includes('imported by src/pkg/entry.py')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('pinned Flask Task B context visibly selects CLI implementation, test, and docs',
  { skip: !existsSync(path.join(pinnedFlask, 'src/flask/cli.py')) }, async () => {
    const prompt = 'Add a new built-in CLI command flask config that prints the loaded application configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as ***. It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';
    const context = await assembleContext(pinnedFlask, prompt);
    const selected = new Set(context.selections.map(item => item.path));
    assert.ok(selected.has('src/flask/cli.py'));
    assert.ok(selected.has('tests/test_cli.py'));
    assert.ok(selected.has('docs/cli.rst'));
    assert.ok(selected.has('src/flask/config.py'));
    assert.ok(context.selections.some(item => item.reason.includes('imported by ')));
    assert.ok(context.selections.every(item => item.tokens <= 750));
  });

test('ranks @symbol definition files above changelogs and generalizes to unseen multi-file Flask tasks',
  { skip: !existsSync(path.join(pinnedFlask, 'src/flask/helpers.py')) }, async () => {
    const sym = await assembleContext(pinnedFlask, 'Inspect @symbol(send_from_directory) and check path traversal safety.');
    assert.equal(sym.selections[0]?.path, 'src/flask/helpers.py');
    assert.match(sym.selections[0]?.reason ?? '', /defines @symbol send_from_directory/);

    const views = await assembleContext(
      pinnedFlask,
      'Add HEAD fallback handling to MethodView dispatch_request, cover it with tests, and update views documentation.',
    );
    const viewPaths = new Set(views.selections.map(item => item.path));
    assert.ok(viewPaths.has('src/flask/views.py'));
    assert.ok(viewPaths.has('tests/test_views.py'));
    assert.ok(viewPaths.has('docs/views.rst'));

    const ctx = await assembleContext(
      pinnedFlask,
      'Investigate how request_ctx and app_ctx push and pop work and add a test.',
    );
    const ctxPaths = new Set(ctx.selections.map(item => item.path));
    assert.ok(ctxPaths.has('src/flask/ctx.py'));
    assert.ok(ctxPaths.has('tests/test_appctx.py'));
  });
