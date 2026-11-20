import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, glob, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { TrueForge } from '@truefoundry/trueforge-sdk';
import { ForgeClient, type ForgeEvent } from '../src/trueforge/client';
import { assembleContext } from '../src/context/assembly';

const exec = promisify(execFile);

test('local MCP endpoint stages, reviews, applies, and undoes hunks', { timeout: 420_000 }, async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'anvil-mcp-'));
  const source = path.join(root, 'sample.py');
  const otherSource = path.join(root, 'other.py');
  const longSource = path.join(root, 'long.py');
  const baseText = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  await writeFile(source, baseText);
  await writeFile(otherSource, 'other\n');
  await writeFile(longSource, Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  await writeFile(path.join(root, '.env'), 'SECRET_KEY=do-not-send\n');
  let failSaveFor: string | undefined;
  const loader = Module as typeof Module & { _load: (id: string, parent: unknown, isMain: boolean) => unknown };
  const original = loader._load;
  class MockEmitter<T> {
    event = (_listener: (value: T) => unknown) => ({ dispose() {} });
    fire(_value: T) {}
    dispose() {}
  }
  class MockPosition { constructor(readonly line: number, readonly character: number) {} }
  class MockRange { constructor(readonly start: MockPosition, readonly end: MockPosition) {} }
  class MockWorkspaceEdit {
    changes: { kind: string; file: string; text?: string }[] = [];
    replace(uri: { fsPath: string }, _range: MockRange, text: string) { this.changes.push({ kind: 'replace', file: uri.fsPath, text }); }
    insert(uri: { fsPath: string }, _position: MockPosition, text: string) { this.changes.push({ kind: 'replace', file: uri.fsPath, text }); }
    createFile(uri: { fsPath: string }) { this.changes.push({ kind: 'create', file: uri.fsPath }); }
    deleteFile(uri: { fsPath: string }) { this.changes.push({ kind: 'delete', file: uri.fsPath }); }
  }
  const fakeVscode = {
    EventEmitter: MockEmitter,
    Position: MockPosition,
    Range: MockRange,
    WorkspaceEdit: MockWorkspaceEdit,
    RelativePattern: class { constructor(readonly base: string, readonly pattern: string) {} },
    Uri: { file: (fsPath: string) => ({ fsPath }) },
    commands: { executeCommand: async () => [] },
    workspace: {
      findFiles: async ({ base, pattern }: { base: string; pattern: string }, _exclude: string, limit: number) => {
        const files = [];
        for await (const file of glob(pattern, { cwd: base, withFileTypes: true })) {
          if (file.isFile()) files.push({ fsPath: path.join(base, path.relative(base, file.parentPath), file.name) });
          if (files.length >= limit) break;
        }
        return files;
      },
      openTextDocument: async (uri: { fsPath: string }) => {
        const text = await readFile(uri.fsPath, 'utf8');
        const lines = text.replace(/\n$/, '').split('\n');
        return {
          getText: () => text,
          lineCount: lines.length,
          lineAt: (line: number) => ({ text: lines[line], range: { end: new MockPosition(line, lines[line].length) } }),
          save: async () => {
            if (uri.fsPath === failSaveFor) { failSaveFor = undefined; return false; }
            return true;
          },
        };
      },
      applyEdit: async (edit: MockWorkspaceEdit) => {
        for (const change of edit.changes) {
          if (change.kind === 'delete') await rm(change.file);
          else if (change.kind === 'create') await writeFile(change.file, '');
          else await writeFile(change.file, change.text ?? '');
        }
        return true;
      },
    },
  };
  loader._load = function (id, parent, isMain) {
    if (id === 'vscode') return fakeVscode;
    return original.call(this, id, parent, isMain);
  };
  let bridge: import('../src/mcp/editorBridge').EditorBridge | undefined;
  try {
    const { EditorBridge } = await import('../src/mcp/editorBridge');
    bridge = new EditorBridge(root);
    const actualUrl = await bridge.start(0);
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    assert.equal((await fetch(actualUrl, { headers })).status, 405);
    const call = async (id: number, method: string, params: unknown) => {
      const response = await fetch(actualUrl, {
        method: 'POST', headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
      return { response, body: await response.json() as { result: { content?: { text: string }[]; tools?: { name: string }[]; isError?: boolean } } };
    };
    const initialize = await fetch(actualUrl, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }),
    });
    assert.equal(initialize.status, 200);
    const tools = await call(2, 'tools/list', {});
    assert.equal(tools.response.status, 200);
    assert.deepEqual(tools.body.result.tools!.map(tool => tool.name).sort(), [
      'apply_reviewed_proposal', 'find_symbol', 'list_files', 'propose_edit', 'read_file', 'run_command', 'search_code',
    ]);
    const directCommand = await call(10, 'tools/call', { name: 'run_command', arguments: { command: 'echo unexpected' } });
    assert.equal(directCommand.body.result.isError, true);
    assert.match(directCommand.body.result.content![0].text, /Approve this exact command/);
    const escaped = await call(10, 'tools/call', { name: 'read_file', arguments: { path: '../outside.txt' } });
    assert.equal(escaped.body.result.isError, true, 'MCP reads must stay in the workspace');
    const secret = await call(11, 'tools/call', { name: 'read_file', arguments: { path: '.env' } });
    assert.equal(secret.body.result.isError, true, 'MCP reads must not expose local environment files');
    const bounded = await call(13, 'tools/call', { name: 'read_file', arguments: { path: 'long.py', start_line: 50, end_line: 300 } });
    assert.equal(bounded.body.result.isError, undefined);
    const range = JSON.parse(bounded.body.result.content![0].text) as { start_line: number; end_line: number; next_line: number; range_capped: boolean; lines: string[] };
    assert.deepEqual([range.start_line, range.end_line, range.next_line, range.range_capped, range.lines.length], [50, 169, 170, true, 120]);
    assert.equal(range.lines[0], '50: line 50');
    assert.equal(range.lines.at(-1), '169: line 169');
    const continued = await call(14, 'tools/call', { name: 'read_file', arguments: { path: 'long.py', start_line: range.next_line } });
    const next = JSON.parse(continued.body.result.content![0].text) as { end_line: number; next_line: number | null; lines: string[] };
    assert.deepEqual([next.end_line, next.next_line, next.lines.length], [200, null, 31]);
    const duplicateRead = await call(18, 'tools/call', { name: 'read_file', arguments: { path: 'long.py', start_line: 60, end_line: 90 } });
    const cached = JSON.parse(duplicateRead.body.result.content![0].text) as { cached_unchanged?: boolean; lines: string[]; saved_tokens_est?: number };
    assert.equal(cached.cached_unchanged, true, 'duplicate unchanged read_file must be compressed');
    assert.deepEqual(cached.lines, []);
    assert.ok((cached.saved_tokens_est ?? 0) > 0);
    const overlapFirst = await call(19, 'tools/call', { name: 'read_file', arguments: { path: 'sample.py', start_line: 1, end_line: 10 } });
    assert.equal(JSON.parse(overlapFirst.body.result.content![0].text).lines.length, 10);
    const overlapSecond = await call(20, 'tools/call', { name: 'read_file', arguments: { path: 'sample.py', start_line: 5, end_line: 15 } });
    const trimmed = JSON.parse(overlapSecond.body.result.content![0].text) as { start_line: number; end_line: number; trimmed_already_read_prefix?: string; lines: string[] };
    assert.equal(trimmed.start_line, 11);
    assert.equal(trimmed.end_line, 15);
    assert.equal(trimmed.trimmed_already_read_prefix, '5-10');
    assert.equal(trimmed.lines.length, 5);
    const badEdit = await call(21, 'tools/call', { name: 'propose_edit', arguments: { path: 'sample.py', old_text: '2: line 2\n', new_text: 'x' } });
    assert.equal(badEdit.body.result.isError, true);
    assert.match(badEdit.body.result.content![0].text, /Do NOT include line-number prefixes/);
    const badEdit2 = await call(24, 'tools/call', { name: 'propose_edit', arguments: { path: 'sample.py', old_text: 'line ', new_text: 'x' } });
    const bad2Payload = JSON.parse(badEdit2.body.result.content![0].text) as { error?: string; loop_breaker_hint?: string; loop_breaker?: boolean };
    assert.match(bad2Payload.error ?? '', /matched multiple times.*lines 1, 2, 3/);
    assert.match(bad2Payload.loop_breaker_hint ?? '', /Loop-Breaker/);
    assert.equal(bad2Payload.loop_breaker, undefined);
    const badEdit3 = await call(25, 'tools/call', { name: 'propose_edit', arguments: { path: 'sample.py', old_text: 'still missing 3', new_text: 'x' } });
    const bad3Payload = JSON.parse(badEdit3.body.result.content![0].text) as { loop_breaker?: boolean; stop_retrying?: boolean };
    assert.equal(bad3Payload.loop_breaker, true);
    assert.equal(bad3Payload.stop_retrying, true);
    const rereadAfterMiss = await call(22, 'tools/call', { name: 'read_file', arguments: { path: 'sample.py', start_line: 1, end_line: 5 } });
    const fresh = JSON.parse(rereadAfterMiss.body.result.content![0].text) as { cached_unchanged?: boolean; lines: string[] };
    assert.equal(fresh.cached_unchanged, undefined, 'failed propose_edit must invalidate read cache for anchor re-reads');
    assert.equal(fresh.lines.length, 5);
    const broad = await call(12, 'tools/call', { name: 'search_code', arguments: { query: 'line' } });
    const search = JSON.parse(broad.body.result.content![0].text) as { hits: unknown[] };
    assert.ok(search.hits.length <= 12, 'search defaults must bound tool response size');
    const duplicateSearch = await call(23, 'tools/call', { name: 'search_code', arguments: { query: 'line' } });
    const cachedSearch = JSON.parse(duplicateSearch.body.result.content![0].text) as { cached_unchanged?: boolean; hits: unknown[] };
    assert.equal(cachedSearch.cached_unchanged, true, 'identical search_code query must be deduplicated');
    assert.deepEqual(cachedSearch.hits, []);
    const partial = await call(15, 'tools/call', { name: 'propose_edit', arguments: { path: 'sample.py', old_text: 'line 2\n', new_content: '' } });
    assert.equal(partial.body.result.isError, true, 'a partial exact replacement must not fall back to new_content');
    assert.match(partial.body.result.content![0].text, /Do not pass new_content with old_text/);
    const noop = await call(16, 'tools/call', { name: 'propose_edit', arguments: { path: 'sample.py', old_text: 'line 2\n', new_text: 'line 2\n' } });
    assert.equal(noop.body.result.isError, true, 'identical old_text/new_text must fail fast');
    const nestedNew = await call(17, 'tools/call', { name: 'propose_edit', arguments: { path: 'nested/dir/new_file.py', new_content: 'x = 1\n' } });
    assert.equal(nestedNew.body.result.isError, undefined, 'staging a new file in a new nested directory should succeed');
    bridge.discardAll();
    const first = await call(3, 'tools/call', { name: 'propose_edit', arguments: { path: 'sample.py', old_text: 'line 2\n', new_text: 'new 2\n', new_content: '' } });
    assert.equal(first.body.result.isError, undefined, JSON.stringify(first.body));
    const proposalId = (JSON.parse(first.body.result.content![0].text) as { proposal_id: string }).proposal_id;
    const second = await call(4, 'tools/call', { name: 'propose_edit', arguments: { path: 'sample.py', old_text: 'line 18\n', new_text: 'new 18\n' } });
    assert.equal((JSON.parse(second.body.result.content![0].text) as { proposal_id: string }).proposal_id, proposalId);
    assert.equal(await readFile(source, 'utf8'), baseText, 'staging must not change the file');
    const proposal = bridge.getProposal(proposalId)!;
    assert.equal(proposal.files[0].hunks.length, 2);
    bridge.setSelectedHunks(proposalId, [proposal.files[0].hunks[0].id]);
    const applied = await call(5, 'tools/call', { name: 'apply_reviewed_proposal', arguments: { proposal_id: proposalId } });
    assert.equal(applied.body.result.isError, undefined);
    assert.equal(await readFile(source, 'utf8'), baseText.replace('line 2', 'new 2'));
    assert.equal(await bridge.undoLastApply(), true);
    assert.equal(await readFile(source, 'utf8'), baseText);
    const third = await call(6, 'tools/call', { name: 'propose_edit', arguments: { path: 'sample.py', old_text: 'line 2\n', new_text: 'new 2\n' } });
    const nextId = (JSON.parse(third.body.result.content![0].text) as { proposal_id: string }).proposal_id;
    await call(7, 'tools/call', { name: 'propose_edit', arguments: { path: 'other.py', old_text: 'other\n', new_text: 'changed\n' } });
    bridge.setSelectedHunks(nextId, bridge.getProposal(nextId)!.files.flatMap(file => file.hunks.map(hunk => hunk.id)));
    failSaveFor = otherSource;
    const failed = await call(8, 'tools/call', { name: 'apply_reviewed_proposal', arguments: { proposal_id: nextId } });
    assert.equal(failed.body.result.isError, true);
    assert.equal((JSON.parse(failed.body.result.content![0].text) as { applied: boolean }).applied, false);
    assert.equal(await readFile(source, 'utf8'), baseText, 'first file must roll back');
    assert.equal(await readFile(otherSource, 'utf8'), 'other\n', 'second file must roll back');
    const denied = await fetch(actualUrl, {
      method: 'POST', headers: { ...headers, origin: 'https://evil.example' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }),
    });
    assert.equal(denied.status, 403);
    const modelName = process.env.ANVIL_LIVE_MODEL;
    if (modelName) {
      bridge.discardAll();
      const flaskRoot = path.resolve('.demo/flask');
      const taskB = process.env.ANVIL_LIVE_TASK === 'B';
      const relativePath = 'src/flask/helpers.py';
      const helpers = path.join(root, relativePath);
      const originalHelpers = await readFile(path.join(flaskRoot, relativePath), 'utf8');
      const fixtureFiles = taskB ? ['src', 'tests', 'docs', 'pyproject.toml'] : ['src'];
      await Promise.all(fixtureFiles.map(file => cp(path.join(flaskRoot, file), path.join(root, file), { recursive: true })));
      const connector = `anvil-smoke-${process.pid}`;
      const baseUrl = 'http://localhost:8790';
      const api = new TrueForge({ baseUrl });
      await api.settings.mcpServers.create({ manifest: {
        name: connector, url: actualUrl, type: 'remote', description: 'Temporary editor integration test',
      } });
      try {
        const client = new ForgeClient({ baseUrl, modelName, mcpServerName: connector }, api);
        const cancelOnTimeout = () => { void client.cancel().catch(() => {}); };
        context.signal.addEventListener('abort', cancelOnTimeout, { once: true });
        let approval: Promise<void> | undefined;
        let sawStreaming = false;
        let reviewedPaths: string[] = [];
        const selection = originalHelpers.match(/^def get_debug_flag\b[^]*?(?=^\r?$)/m)?.[0];
        assert.ok(selection);
        const taskBPrompt = 'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';
        const prompt = taskB
          ? `${taskBPrompt}\n\nRepository context selected by the extension (verify against MCP tools before editing):\n${(await assembleContext(root, taskBPrompt)).text}`
          : `Inline edit request. The user selected get_debug_flag in @${relativePath}. Verify the selection against read_file at lines 28–33 and stage just this function.\n\nTreat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.\n\nSelected code:\n${selection}`;
        const onEvent = (event: ForgeEvent) => {
          if (event.type === 'delta') sawStreaming = true;
          if (event.type === 'tool') console.log(`Live tool: ${event.name}${event.isError ? ' (error)' : ''}`);
          if (event.type !== 'approval') return;
          console.log(`Live approval: ${event.name}`);
          approval = (async () => {
            if (!event.name.endsWith('apply_reviewed_proposal')) {
              await client.approve(event.toolCallId, false, 'This smoke test only reviews source proposals.');
              return;
            }
            assert.equal(await readFile(helpers, 'utf8'), originalHelpers);
            const { proposal_id } = JSON.parse(event.args ?? '{}') as { proposal_id: string };
            const proposal = bridge!.getProposal(proposal_id);
            assert.ok(proposal?.files.length);
            if (taskB && proposal.files.length < 3) {
              await client.approve(event.toolCallId, false, 'This proposal is incomplete. Keep it staged and finish the requested implementation, test, and documentation before asking for review again.');
              return;
            }
            reviewedPaths = proposal.files.map(file => file.path);
            bridge!.setSelectedHunks(proposal_id, proposal.files.flatMap(file => file.hunks.map(hunk => hunk.id)));
            await client.approve(event.toolCallId, true);
          })();
          void approval.catch(() => client.cancel());
        };
        let run = await client.start(prompt, onEvent);
        console.log(`Live session: ${run.sessionId}`);
        for (let retries = 0; ; retries++) {
          try {
            await run.done;
            break;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!/\b429\b/.test(message) || retries >= 2 || reviewedPaths.length) throw error;
            const seconds = Number(/retry in\s+(\d+(?:\.\d+)?)s/i.exec(message)?.[1] ?? 60);
            const waitMs = Math.min(90_000, Math.ceil(seconds * 1000) + 1000);
            console.log(`Provider rate limit. Resuming the same session in ${Math.ceil(waitMs / 1000)}s.`);
            await delay(waitMs, undefined, { signal: context.signal });
            run = await client.resume('Continue the original request from the prior turn. Keep existing staged proposals and finish any missing edits before asking the user for hunk review.', onEvent);
          }
        }
        context.signal.removeEventListener('abort', cancelOnTimeout);
        await approval;
        assert.ok(reviewedPaths.length, 'TrueForge must pause for hunk review');
        assert.ok(sawStreaming, 'TrueForge should stream a model response');
        const python = process.env.ANVIL_FLASK_PYTHON ?? path.join(flaskRoot, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
        const pythonOptions = { cwd: root, env: { ...process.env, PYTHONPATH: path.join(root, 'src') }, timeout: 30_000 };
        if (taskB) {
          assert.ok(new Set(reviewedPaths).size >= 3, `Expected at least three changed files, got ${reviewedPaths.join(', ')}`);
          const tests = await exec(python, ['-m', 'pytest', 'tests/test_cli.py', '-q'], pythonOptions);
          console.log(tests.stdout.trim());
          await writeFile(path.join(root, 'demo_app.py'), 'from flask import Flask\napp = Flask(__name__)\napp.config.update(SERVICE_PASSWORD="example", API_TOKEN="example", PRIVATE_KEY="example", SHOW_ME="visible")\n');
          const help = await exec(python, ['-m', 'flask', '--help'], pythonOptions);
          assert.match(help.stdout, /^\s+config\s+/m);
          const cli = await exec(python, ['-m', 'flask', '--app', 'demo_app', 'config'], pythonOptions);
          const config = JSON.parse(cli.stdout);
          for (const key of ['SECRET_KEY', 'SERVICE_PASSWORD', 'API_TOKEN', 'PRIVATE_KEY']) assert.equal(config[key], '***');
          assert.equal(config.SHOW_ME, 'visible');
        } else {
          const changed = await readFile(helpers, 'utf8');
          assert.ok(changed !== originalHelpers, 'The reviewed Flask helper must change');
          assert.match(changed, /["']off["']/);
          assert.match(changed, /["']n["']/);
          const verified = await exec(python, ['-c', 'from flask.helpers import get_debug_flag; print(get_debug_flag())'], { ...pythonOptions, env: { ...pythonOptions.env, FLASK_DEBUG: 'off' } });
          assert.equal(verified.stdout.trim(), 'False');
          assert.equal(await bridge.undoLastApply(), true);
          assert.ok(await readFile(helpers, 'utf8') === originalHelpers, 'Undo must restore the original Flask helper');
        }
        console.log(`Verified Flask Task ${taskB ? 'B' : 'A'} through TrueForge session ${run.sessionId}`);
      } finally {
        await api.settings.mcpServers.delete(connector);
      }
    }
  } finally {
    if (bridge) await bridge.stop();
    loader._load = original;
    await rm(root, { recursive: true, force: true });
  }
});
