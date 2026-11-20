import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Hunk, ProposalFile } from './proposalStore';

export type FileIntent = 'production' | 'test' | 'docs' | 'config';

export interface DiagnosticIssue {
  line?: number;
  message: string;
  source: 'vscode' | 'python-ast' | 'json';
}

export interface FileDiagnostics {
  status: 'checking' | 'clean' | 'errors' | 'unchecked';
  newErrorCount: number;
  issues: DiagnosticIssue[];
}

export interface HunkAnalysis {
  id: string;
  addedLines: number;
  removedLines: number;
  symbol?: string;
}

export interface FileBlastRadius {
  category: FileIntent;
  isNewFile: boolean;
  addedLines: number;
  removedLines: number;
  touchedSymbols: string[];
  hunks: Map<string, HunkAnalysis>;
}

export function classifyFileIntent(filePath: string): FileIntent {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  const base = path.posix.basename(normalized);
  if (
    normalized.startsWith('tests/') ||
    normalized.startsWith('test/') ||
    normalized.includes('/tests/') ||
    normalized.includes('/__tests__/') ||
    /^test_/.test(base) ||
    /(?:\.|_)(?:test|spec)\.[^.]+$/.test(base)
  ) {
    return 'test';
  }
  if (
    normalized.startsWith('docs/') ||
    normalized.startsWith('doc/') ||
    /\.(?:md|rst|txt|adoc)$/.test(base)
  ) {
    return 'docs';
  }
  if (
    /\.(?:json|ya?ml|toml|ini|cfg|lock)$/.test(base) ||
    base === 'makefile' ||
    base === 'dockerfile' ||
    base.startsWith('.env.')
  ) {
    return 'config';
  }
  return 'production';
}

export function analyzeProposalFile(file: ProposalFile): FileBlastRadius {
  const category = classifyFileIntent(file.path);
  const ext = path.posix.extname(file.path).toLowerCase();
  const baseLines = file.baseText.split(/\r?\n/);
  const proposedLines = file.proposedText.split(/\r?\n/);
  const hunks = new Map<string, HunkAnalysis>();
  const touched = new Set<string>();
  let totalAdded = 0;
  let totalRemoved = 0;

  for (const hunk of file.hunks) {
    let added = 0;
    let removed = 0;
    for (const line of hunk.diffLines) {
      if (line.startsWith('+') && !line.startsWith('+++')) added++;
      else if (line.startsWith('-') && !line.startsWith('---')) removed++;
    }
    totalAdded += added;
    totalRemoved += removed;

    const symbolsInHunk = findHunkSymbols(hunk, baseLines, proposedLines, ext);
    for (const sym of symbolsInHunk) touched.add(sym);
    hunks.set(hunk.id, {
      id: hunk.id,
      addedLines: added,
      removedLines: removed,
      symbol: symbolsInHunk[0],
    });
  }

  return {
    category,
    isNewFile: file.baseText.length === 0,
    addedLines: totalAdded,
    removedLines: totalRemoved,
    touchedSymbols: [...touched].slice(0, 6),
    hunks,
  };
}

function findHunkSymbols(hunk: Hunk, baseLines: string[], proposedLines: string[], ext: string): string[] {
  const found: string[] = [];
  const push = (name?: string) => {
    if (name && !found.includes(name)) found.push(name);
  };

  for (const line of hunk.diffLines) {
    if (!line.startsWith('+') && !line.startsWith('-')) continue;
    push(extractSymbolFromLine(line.slice(1), ext));
  }

  const enclosingBase = findEnclosingSymbol(baseLines, Math.max(0, hunk.oldStart - 1), ext);
  push(enclosingBase);
  if (!enclosingBase) {
    push(findEnclosingSymbol(proposedLines, Math.max(0, hunk.newStart - 1), ext));
  }
  return found;
}

function extractSymbolFromLine(line: string, ext: string): string | undefined {
  if (ext === '.py') {
    const match = /^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/.exec(line);
    return match?.[1];
  }
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    const match = /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function|class|interface|type|const|let)\s+([A-Za-z_$][\w$]*)/.exec(line);
    return match?.[1];
  }
  if (ext === '.md') {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    return match?.[1]?.slice(0, 40);
  }
  return undefined;
}

function findEnclosingSymbol(lines: string[], startIndex: number, ext: string): string | undefined {
  const from = Math.min(startIndex, lines.length - 1);
  if (ext === '.rst') {
    for (let i = from; i >= 1; i--) {
      if (/^[-=~^`]{3,}\s*$/.test(lines[i]) && lines[i - 1]?.trim()) {
        return lines[i - 1].trim().slice(0, 40);
      }
    }
    return undefined;
  }
  for (let i = from; i >= 0; i--) {
    const line = lines[i];
    if (ext === '.py') {
      const match = /^(\s*)(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/.exec(line);
      if (match) return match[2];
    } else if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
      const match = /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function|class|interface|type)\s+([A-Za-z_$][\w$]*)/.exec(line);
      if (match) return match[1];
    } else if (ext === '.md') {
      const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
      if (match) return match[1].slice(0, 40);
    }
  }
  return undefined;
}

/** Run zero-disk-write syntax verification for Python and JSON buffers. */
export async function checkBufferSyntax(
  filePath: string,
  content: string,
  workspaceRoot?: string,
): Promise<FileDiagnostics | undefined> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') {
    try {
      JSON.parse(content);
      return { status: 'clean', newErrorCount: 0, issues: [] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: 'errors', newErrorCount: 1, issues: [{ message, source: 'json' }] };
    }
  }
  if (ext === '.py') {
    const pythonBin = resolvePythonExecutable(workspaceRoot);
    const script = [
      'import ast, json, sys',
      'try:',
      '    ast.parse(sys.stdin.read(), filename=sys.argv[1])',
      '    print(json.dumps({"ok": True}))',
      'except SyntaxError as e:',
      '    print(json.dumps({"ok": False, "line": e.lineno, "message": f"{e.__class__.__name__}: {e.msg}"}))',
    ].join('\n');
    const parsed = await runPythonAst(pythonBin, script, filePath, content);
    if (!parsed) return undefined;
    if (parsed.ok) return { status: 'clean', newErrorCount: 0, issues: [] };
    return {
      status: 'errors',
      newErrorCount: 1,
      issues: [{ line: parsed.line, message: parsed.message ?? 'SyntaxError', source: 'python-ast' }],
    };
  }
  return undefined;
}

function resolvePythonExecutable(workspaceRoot?: string): string {
  if (workspaceRoot) {
    const venvWin = path.join(workspaceRoot, '.venv', 'Scripts', 'python.exe');
    if (existsSync(venvWin)) return venvWin;
    const venvUnix = path.join(workspaceRoot, '.venv', 'bin', 'python');
    if (existsSync(venvUnix)) return venvUnix;
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

function runPythonAst(
  executable: string,
  script: string,
  filePath: string,
  source: string,
): Promise<{ ok: boolean; line?: number; message?: string } | undefined> {
  return new Promise(resolve => {
    const child = spawn(executable, ['-c', script, filePath], { windowsHide: true });
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve(undefined);
    }, 3000);
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return resolve(undefined);
      try {
        resolve(JSON.parse(stdout.trim()) as { ok: boolean; line?: number; message?: string });
      } catch {
        resolve(undefined);
      }
    });
    child.stdin.end(source);
  });
}
