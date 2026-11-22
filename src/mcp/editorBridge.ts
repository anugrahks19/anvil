import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { realpath, stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as vscode from 'vscode';
import { z } from 'zod';
import { hashText, type Proposal, ProposalStore } from '../review/proposalStore';

const execFileAsync = promisify(execFile);
const SEARCH_EXCLUDE = '**/{.git,node_modules,dist,.venv,venv,__pycache__,build}/**';

export interface EditorBridgeOptions {
  maxFileBytes?: number;
}

interface AppliedFile {
  path: string;
  before: string;
  after: string;
  created: boolean;
}

export interface CompressionEvent {
  tool: string;
  savedTokens: number;
  detail: string;
}

export interface LoopEvent {
  tool: string;
  target: string;
  count: number;
  tripped: boolean;
}

interface ReadCacheEntry {
  hash: string;
  ranges: Array<[number, number]>;
}

export class EditorBridge implements vscode.Disposable {
  private readonly store = new ProposalStore();
  private readonly emitter = new vscode.EventEmitter<Proposal>();
  private readonly appliedEmitter = new vscode.EventEmitter<{ proposalId: string; files: string[] }>();
  private readonly applyFailedEmitter = new vscode.EventEmitter<{ proposalId: string; message: string }>();
  private readonly compressedEmitter = new vscode.EventEmitter<CompressionEvent>();
  private readonly loopEmitter = new vscode.EventEmitter<LoopEvent>();
  private readonly readCache = new Map<string, ReadCacheEntry>();
  private readonly searchCache = new Set<string>();
  private readonly errorStreaks = new Map<string, number>();
  private readonly maxFileBytes: number;
  private httpServer: Server | undefined;
  private lastApplied: AppliedFile[] | undefined;
  private applying = false;
  private approvedCommand?: string;
  private commandAbort?: AbortController;

  readonly onProposal = this.emitter.event;
  readonly onApplied = this.appliedEmitter.event;
  readonly onApplyFailed = this.applyFailedEmitter.event;
  readonly onCompressed = this.compressedEmitter.event;
  readonly onLoop = this.loopEmitter.event;

  constructor(private readonly workspaceRoot: string, options: EditorBridgeOptions = {}) {
    this.maxFileBytes = options.maxFileBytes ?? 1_000_000;
  }

  async start(port: number): Promise<string> {
    if (this.httpServer) throw new Error('Editor MCP bridge is already running');
    let listeningPort = port;
    this.httpServer = createServer(async (request, response) => {
      const host = request.headers.host;
      const origin = request.headers.origin;
      if (host !== `127.0.0.1:${listeningPort}` && host !== `localhost:${listeningPort}`) {
        response.writeHead(403).end('Invalid Host');
        return;
      }
      if (origin && origin !== `http://127.0.0.1:${listeningPort}` && origin !== `http://localhost:${listeningPort}`) {
        response.writeHead(403).end('Invalid Origin');
        return;
      }
      if (request.url !== '/mcp') {
        response.writeHead(404).end('Not Found');
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(405, { Allow: 'POST' }).end();
        return;
      }
      try {
        const server = this.makeMcpServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        await server.connect(transport);
        response.once('finish', () => { void server.close(); });
        await transport.handleRequest(request, response);
      } catch (error) {
        if (!response.headersSent) response.writeHead(500).end(String(error));
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        this.httpServer!.once('error', reject);
        this.httpServer!.listen(port, '127.0.0.1', resolve);
      });
    } catch (error) {
      this.httpServer = undefined;
      throw error;
    }
    listeningPort = (this.httpServer.address() as AddressInfo).port;
    return `http://127.0.0.1:${listeningPort}/mcp`;
  }

  async stop(): Promise<void> {
    const server = this.httpServer;
    this.httpServer = undefined;
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }

  get canUndo(): boolean {
    return Boolean(this.lastApplied?.length);
  }

  getProposal(id: string): Proposal | undefined {
    return this.store.get(id);
  }

  setSelectedHunks(id: string, ids: string[]): void {
    this.store.select(id, ids);
  }

  previewSelectedHunks(id: string, ids: string[]) {
    return this.store.selected(id, ids);
  }

  discardAll(): void {
    this.approvedCommand = undefined;
    this.commandAbort?.abort();
    if (this.applying) throw new Error('Wait for the approved edit to finish before discarding');
    this.store.clear();
    this.readCache.clear();
    this.searchCache.clear();
    this.errorStreaks.clear();
  }

  approveCommand(command: string): void {
    this.approvedCommand = command;
  }

  revokeCommand(): void {
    this.approvedCommand = undefined;
  }

  async undoLastApply(): Promise<boolean> {
    const applied = this.lastApplied;
    if (!applied?.length || this.applying) return false;
    this.applying = true;
    try {
      const edit = new vscode.WorkspaceEdit();
      for (const file of applied) {
        const uri = await this.safeUri(file.path, file.created);
        const document = await vscode.workspace.openTextDocument(uri);
        if (hashText(document.getText()) !== hashText(file.after)) {
          throw new Error(`Cannot undo because ${file.path} changed after the agent applied it`);
        }
        if (file.created) edit.deleteFile(uri);
        else edit.replace(uri, fullRange(document), file.before);
      }
      const ok = await vscode.workspace.applyEdit(edit);
      if (ok) {
        for (const file of applied) {
          if (!file.created) await (await vscode.workspace.openTextDocument(await this.safeUri(file.path))).save();
        }
        this.lastApplied = undefined;
        this.readCache.clear();
        this.searchCache.clear();
        this.errorStreaks.clear();
      }
      return ok;
    } finally {
      this.applying = false;
    }
  }

  dispose(): void {
    void this.stop();
    this.emitter.dispose();
    this.appliedEmitter.dispose();
    this.applyFailedEmitter.dispose();
    this.compressedEmitter.dispose();
    this.loopEmitter.dispose();
  }

  private makeMcpServer(): McpServer {
    const server = new McpServer({ name: 'anvil-editor', version: '0.1.0' });
    const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
    const handled = async (toolName: string, target: string, fn: () => Promise<unknown>) => {
      const key = `${toolName}::${target}`;
      try {
        const value = await fn();
        this.errorStreaks.delete(key);
        return result(value);
      } catch (error) {
        const count = (this.errorStreaks.get(key) ?? 0) + 1;
        this.errorStreaks.set(key, count);
        const payload: Record<string, unknown> = { error: String(error) };
        if (count === 2) {
          payload.loop_breaker_hint = `Loop-Breaker: ${toolName} failed twice on ${target}. Re-read the exact lines or change arguments before retrying.`;
          this.loopEmitter.fire({ tool: toolName, target, count, tripped: false });
        } else if (count >= 3) {
          payload.loop_breaker = true;
          payload.stop_retrying = true;
          payload.loop_breaker_hint = `Loop-Breaker tripped: ${toolName} failed ${count} consecutive times on ${target}. Stop repeating this call; inspect with another tool or report the blocker.`;
          this.loopEmitter.fire({ tool: toolName, target, count, tripped: true });
        }
        return { ...result(payload), isError: true };
      }
    };

    server.registerTool('list_files', {
      description: 'List relative source paths in the current VS Code workspace. Use this to discover files before reading.',
      inputSchema: { glob: z.string().default('**/*'), limit: z.number().int().min(1).max(200).default(100) },
    }, ({ glob, limit }) => handled('list_files', glob, async () => {
      const files = await vscode.workspace.findFiles(new vscode.RelativePattern(this.workspaceRoot, glob), SEARCH_EXCLUDE, limit);
      return { files: files.map(file => this.relativePath(file)).filter(isAllowedRelative) };
    }));

    server.registerTool('search_code', {
      description: 'Search workspace text for a literal query. Returns up to three short matches per file across multiple files.',
      inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(30).default(12) },
    }, ({ query, limit }) => handled('search_code', query, () => this.searchCode(query, limit)));

    server.registerTool('find_symbol', {
      description: 'Find a code symbol by name, using editor language providers and text search fallback.',
      inputSchema: { name: z.string().min(1) },
    }, ({ name }) => handled('find_symbol', name, () => this.findSymbol(name)));

    server.registerTool('read_file', {
      description: 'Read a bounded range of a workspace file. Line numbers are one-based; oversized ranges return at most 120 lines and a next_line for continuation.',
      inputSchema: {
        path: z.string().min(1),
        start_line: z.number().int().min(1).default(1),
        end_line: z.number().int().min(1).optional(),
      },
    }, ({ path: filePath, start_line, end_line }) => handled('read_file', filePath, async () => {
      const requestedEnd = end_line ?? start_line + 79;
      if (requestedEnd < start_line) throw new Error('end_line must be at or after start_line');
      const uri = await this.safeUri(filePath);
      const document = await vscode.workspace.openTextDocument(uri);
      const fullText = document.getText();
      if (Buffer.byteLength(fullText) > this.maxFileBytes) throw new Error('File exceeds read limit');
      const actualEnd = Math.min(document.lineCount, requestedEnd, start_line + 119);
      const contentHash = hashText(fullText);
      const cached = this.readCache.get(filePath);
      if (cached && cached.hash === contentHash) {
        const covering = cached.ranges.find(([s, e]) => s <= start_line && e >= actualEnd);
        if (covering) {
          const skippedLines = Array.from({ length: Math.max(0, actualEnd - start_line + 1) },
            (_, i) => document.lineAt(start_line - 1 + i).text).join('\n');
          const savedTokens = Math.max(1, Math.ceil(skippedLines.length / 4));
          this.compressedEmitter.fire({
            tool: 'read_file',
            savedTokens,
            detail: `${filePath}:${start_line}-${actualEnd}`,
          });
          return {
            path: filePath,
            cached_unchanged: true,
            content_hash: contentHash.slice(0, 8),
            already_covered: `${covering[0]}-${covering[1]}`,
            saved_tokens_est: savedTokens,
            lines: [],
            message: `Lines ${start_line}-${actualEnd} of ${filePath} were already read in this run and are unchanged on disk.`,
          };
        }
      }
      let effectiveStart = start_line;
      let trimmedPrefix: string | undefined;
      if (cached && cached.hash === contentHash) {
        const prefixCover = cached.ranges.find(([s, e]) => s <= start_line && e >= start_line && e < actualEnd);
        if (prefixCover) {
          effectiveStart = prefixCover[1] + 1;
          const skipped = Array.from({ length: Math.max(0, effectiveStart - start_line) },
            (_, i) => document.lineAt(start_line - 1 + i).text).join('\n');
          const savedTokens = Math.max(1, Math.ceil(skipped.length / 4));
          trimmedPrefix = `${start_line}-${prefixCover[1]}`;
          this.compressedEmitter.fire({
            tool: 'read_file',
            savedTokens,
            detail: `${filePath}:${trimmedPrefix} prefix`,
          });
        }
      }
      const entry: ReadCacheEntry = cached && cached.hash === contentHash
        ? cached
        : { hash: contentHash, ranges: [] };
      entry.ranges = mergeRanges([...entry.ranges, [effectiveStart, actualEnd]]);
      this.readCache.set(filePath, entry);
      return {
        path: filePath,
        total_lines: document.lineCount,
        start_line: effectiveStart,
        end_line: actualEnd,
        next_line: actualEnd < document.lineCount ? actualEnd + 1 : null,
        range_capped: requestedEnd > start_line + 119,
        ...(trimmedPrefix ? { trimmed_already_read_prefix: trimmedPrefix } : {}),
        lines: Array.from({ length: Math.max(0, actualEnd - effectiveStart + 1) },
          (_, i) => `${effectiveStart + i}: ${document.lineAt(effectiveStart - 1 + i).text}`),
      };
    }));

    server.registerTool('propose_edit', {
      description: 'Stage an edit for human hunk review. For existing files, ALWAYS pass path, old_text, and new_text (omit new_content). Use new_content ONLY to create a brand-new file. Exact old_text must occur once.',
      inputSchema: {
        path: z.string().min(1),
        old_text: z.string().max(12_000).optional(),
        new_text: z.string().max(16_000).optional(),
        new_content: z.string().optional(),
      },
    }, ({ path: filePath, old_text, new_text, new_content }) => handled('propose_edit', filePath, async () => {
      const uri = await this.safeUri(filePath, true);
      const current = this.store.current()?.files.find(file => file.path === filePath);
      let baseText: string;
      if (current) baseText = current.baseText;
      else {
        try {
          await stat(uri.fsPath);
          baseText = (await vscode.workspace.openTextDocument(uri)).getText();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          baseText = '';
        }
      }
      const stagedText = current?.proposedText ?? baseText;
      const newline = stagedText.includes('\r\n') ? '\r\n' : '\n';
      const normalizeNewlines = (value: string) => value.replace(/\r?\n/g, newline);
      let proposedText: string;
      if (old_text !== undefined && new_text === undefined && new_content !== undefined) {
        throw new Error('Do not pass new_content with old_text; pass old_text and new_text to edit an existing file');
      }
      if ((old_text === undefined) !== (new_text === undefined) || old_text === '') {
        throw new Error('Supply both nonempty old_text and new_text for an exact replacement');
      }
      if (old_text !== undefined && new_text !== undefined) {
        const oldText = normalizeNewlines(old_text);
        const first = stagedText.indexOf(oldText);
        if (first < 0) {
          this.readCache.delete(filePath);
          const hasLinePrefixes = /^\s*\d+:\s/m.test(old_text);
          const hint = hasLinePrefixes
            ? ' Do NOT include line-number prefixes like "30: " from read_file.'
            : ' Match exact indentation and surrounding lines from read_file.';
          throw new Error(`old_text matched 0 times in ${filePath}.${hint} Re-read the target range and try again.`);
        }
        if (stagedText.indexOf(oldText, first + oldText.length) >= 0) {
          this.readCache.delete(filePath);
          const lines: number[] = [];
          let pos = first;
          while (pos >= 0 && lines.length < 5) {
            lines.push(stagedText.slice(0, pos).split(newline).length);
            pos = stagedText.indexOf(oldText, pos + oldText.length);
          }
          throw new Error(`old_text matched multiple times in ${filePath} (lines ${lines.join(', ')}); include 2-3 surrounding lines so it matches uniquely.`);
        }
        proposedText = stagedText.slice(0, first) + normalizeNewlines(new_text) + stagedText.slice(first + oldText.length);
      } else if (new_content !== undefined) {
        if (stagedText) throw new Error('Existing file: omit new_content and pass small exact old_text and new_text strings');
        proposedText = new_content;
      } else {
        throw new Error('Supply old_text and new_text, or new_content for a new file');
      }
      if (proposedText === stagedText) throw new Error('No changes in proposed edit; new_text matches existing text');
      if (Buffer.byteLength(proposedText) > this.maxFileBytes) throw new Error('Proposed file exceeds size limit');
      const proposal = this.store.stage(filePath, baseText, proposedText);
      this.emitter.fire(proposal);
      return { proposal_id: proposal.id, changed_files: proposal.files.map(file => file.path), hunk_count: proposal.files.reduce((n, file) => n + file.hunks.length, 0), next_step: 'Call apply_reviewed_proposal when all edits are staged; the user will review each hunk before approval.' };
    }));

    server.registerTool('apply_reviewed_proposal', {
      description: 'Apply only hunks explicitly selected in the VS Code review UI. This tool must require TrueForge human approval.',
      inputSchema: { proposal_id: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: true },
    }, async ({ proposal_id }) => {
      try { return result(await this.applyReviewedProposal(proposal_id)); }
      catch (error) {
        const message = String(error);
        this.applyFailedEmitter.fire({ proposalId: proposal_id, message });
        return { ...result({ applied: false, proposal_id, message }), isError: true };
      }
    });

    server.registerTool('run_command', {
      description: 'Run a terminal command in the workspace after TrueForge human approval. Use for tests and verification.',
      inputSchema: { command: z.string().min(1).max(500) },
      annotations: { readOnlyHint: false, destructiveHint: true },
    }, ({ command }) => handled('run_command', command, async () => {
      if (this.approvedCommand !== command || this.commandAbort) throw new Error('Approve this exact command in VS Code before running it');
      this.approvedCommand = undefined;
      const abort = new AbortController();
      this.commandAbort = abort;
      const executable = process.platform === 'win32' ? 'powershell.exe' : 'sh';
      const args = process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command];
      try {
        const { stdout, stderr } = await execFileAsync(executable, args, {
          cwd: this.workspaceRoot,
          timeout: 120_000,
          maxBuffer: 256_000,
          windowsHide: true,
          signal: abort.signal,
        });
        return { exit_code: 0, stdout: stdout.slice(-20_000), stderr: stderr.slice(-20_000) };
      } catch (error) {
        const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
        return { exit_code: typeof failure.code === 'number' ? failure.code : 1, stdout: (failure.stdout ?? '').slice(-20_000), stderr: (failure.stderr ?? failure.message).slice(-20_000) };
      } finally {
        this.commandAbort = undefined;
      }
    }));

    return server;
  }

  private async applyReviewedProposal(id: string): Promise<unknown> {
    if (this.applying) throw new Error('An edit is already being applied');
    const selected = this.store.selected(id);
    const selectedHunkCount = this.store.selectedCount(id);
    this.applying = true;
    const applied: AppliedFile[] = [];
    let editAttempted = false;
    try {
      const edit = new vscode.WorkspaceEdit();
      for (const file of selected) {
        const uri = await this.safeUri(file.path, true);
        let document: vscode.TextDocument | undefined;
        try { document = await vscode.workspace.openTextDocument(uri); }
        catch { /* New workspace file. */ }
        const liveText = document?.getText() ?? '';
        if (hashText(liveText) !== file.baseHash) throw new Error(`Source changed during review: ${file.path}`);
        if (document) edit.replace(uri, fullRange(document), file.resultText);
        else { edit.createFile(uri, { overwrite: false }); edit.insert(uri, new vscode.Position(0, 0), file.resultText); }
        applied.push({ path: file.path, before: liveText, after: file.resultText, created: !document });
      }
      if (applied.length) {
        editAttempted = true;
        if (!(await vscode.workspace.applyEdit(edit))) throw new Error('VS Code could not apply the reviewed edit');
      }
      for (const file of applied) {
        const document = await vscode.workspace.openTextDocument(await this.safeUri(file.path));
        if (!(await document.save())) throw new Error(`Could not save ${file.path}`);
      }
      this.lastApplied = applied.length ? applied : undefined;
      this.store.clear();
      this.readCache.clear();
      this.searchCache.clear();
      this.errorStreaks.clear();
      this.appliedEmitter.fire({ proposalId: id, files: applied.map(file => file.path) });
      return { applied: true, proposal_id: id, applied_files: applied.map(file => file.path), applied_hunks: selectedHunkCount, undo_available: applied.length > 0 };
    } catch (error) {
      if (editAttempted) {
        try { await this.rollback(applied); }
        catch (rollbackError) {
          this.lastApplied = applied;
          throw new Error(`${String(error)}; rollback also failed: ${String(rollbackError)}. Use Undo Last Agent Apply after resolving the file conflict.`);
        }
      }
      throw error;
    } finally {
      this.applying = false;
    }
  }

  private async rollback(applied: AppliedFile[]): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    const changed: AppliedFile[] = [];
    for (const file of applied) {
      const uri = await this.safeUri(file.path, file.created);
      let document: vscode.TextDocument | undefined;
      try { document = await vscode.workspace.openTextDocument(uri); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (!document) {
        if (!file.created) throw new Error(`Missing original file: ${file.path}`);
        continue;
      }
      const live = document.getText();
      if (live === file.before) continue;
      if (live !== file.after) throw new Error(`File changed during rollback: ${file.path}`);
      if (file.created) edit.deleteFile(uri);
      else edit.replace(uri, fullRange(document), file.before);
      changed.push(file);
    }
    if (changed.length && !(await vscode.workspace.applyEdit(edit))) throw new Error('VS Code rejected rollback');
    for (const file of changed) {
      if (file.created) continue;
      const document = await vscode.workspace.openTextDocument(await this.safeUri(file.path));
      if (!(await document.save())) throw new Error(`Could not save rollback for ${file.path}`);
    }
  }

  private async searchCode(query: string, limit: number): Promise<unknown> {
    const cacheKey = `${query.toLocaleLowerCase()}::${limit}`;
    if (this.searchCache.has(cacheKey)) {
      this.compressedEmitter.fire({ tool: 'search_code', savedTokens: 80, detail: `"${query}"` });
      return {
        query,
        cached_unchanged: true,
        hits: [],
        message: `Query "${query}" was already searched in this run with no disk changes since. Reuse prior hits or try a narrower query.`,
      };
    }
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(this.workspaceRoot, '**/*'), SEARCH_EXCLUDE, 1000);
    const hits: { path: string; line: number; excerpt: string }[] = [];
    const needle = query.toLocaleLowerCase();
    for (const uri of files) {
      if (hits.length >= limit) break;
      try {
        if (!isAllowedRelative(this.relativePath(uri))) continue;
        if ((await stat(uri.fsPath)).size > this.maxFileBytes) continue;
        const document = await vscode.workspace.openTextDocument(uri);
        let fileHits = 0;
        for (let i = 0; i < document.lineCount && hits.length < limit; i++) {
          const line = document.lineAt(i).text;
          if (line.toLocaleLowerCase().includes(needle)) {
            hits.push({ path: this.relativePath(uri), line: i + 1, excerpt: line.trim().slice(0, 180) });
            if (++fileHits >= 3) break;
          }
        }
      } catch { /* Ignore binary or unreadable files in search. */ }
    }
    this.searchCache.add(cacheKey);
    return { query, hits, truncated: hits.length >= limit };
  }

  private async findSymbol(name: string): Promise<unknown> {
    const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', name) ?? [];
    const matches = symbols.filter(symbol => {
      const relative = this.relativePath(symbol.location.uri);
      return isAllowedRelative(relative) && symbol.name.toLocaleLowerCase().includes(name.toLocaleLowerCase());
    }).slice(0, 12);
    if (matches.length) {
      return { symbols: matches.map(symbol => ({ path: this.relativePath(symbol.location.uri), name: symbol.name, line: symbol.location.range.start.line + 1 })) };
    }
    return this.searchCode(name, 12);
  }

  private relativePath(uri: vscode.Uri): string {
    return path.relative(this.workspaceRoot, uri.fsPath).replace(/\\/g, '/');
  }

  private async safeUri(relative: string, allowNew = false): Promise<vscode.Uri> {
    if (path.isAbsolute(relative) || relative.includes('\0')) throw new Error('Path must be relative to the workspace');
    if (!isAllowedRelative(relative)) throw new Error('Protected or outside-workspace path');
    const root = await realpath(this.workspaceRoot);
    const target = path.resolve(root, relative);
    const relation = path.relative(root, target);
    if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) throw new Error('Path is outside the workspace');
    try {
      const resolved = await realpath(target);
      const actualRelation = path.relative(root, resolved);
      if (!actualRelation || actualRelation.startsWith('..') || path.isAbsolute(actualRelation)) throw new Error('Symlink points outside the workspace');
    } catch (error) {
      if (!allowNew || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      let probe = path.dirname(target);
      while (true) {
        try {
          const parent = await realpath(probe);
          const parentRelation = path.relative(root, parent);
          if (parentRelation.startsWith('..') || path.isAbsolute(parentRelation)) throw new Error('Parent is outside the workspace');
          break;
        } catch (parentError) {
          if ((parentError as NodeJS.ErrnoException).code !== 'ENOENT' || probe === root || probe === path.dirname(probe)) {
            throw parentError;
          }
          probe = path.dirname(probe);
        }
      }
    }
    return vscode.Uri.file(target);
  }
}

function isAllowedRelative(relative: string): boolean {
  if (!relative || path.isAbsolute(relative)) return false;
  const parts = relative.replace(/\\/g, '/').split('/').map(part => part.toLowerCase());
  if (parts.includes('..')) return false;
  if (parts.some(part => ['.git', '.venv', 'venv', 'node_modules', '__pycache__'].includes(part))) return false;
  const basename = parts.at(-1)!;
  if (basename === '.npmrc' || basename === '.pypirc' || basename === '.netrc') return false;
  if (basename === '.env' || (basename.startsWith('.env.') && !['.env.example', '.env.sample'].includes(basename))) return false;
  return true;
}

function fullRange(document: vscode.TextDocument): vscode.Range {
  return new vscode.Range(new vscode.Position(0, 0), document.lineAt(document.lineCount - 1).range.end);
}

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  if (ranges.length <= 1) return ranges;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const [start, end] = sorted[i];
    if (start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}
