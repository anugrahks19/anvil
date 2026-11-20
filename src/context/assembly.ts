import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const IGNORED = ['!node_modules', '!.git', '!dist', '!out', '!.venv', '!venv', '!__pycache__'];
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into', 'is', 'it', 'of', 'on', 'or',
  'the', 'to', 'with', 'add', 'new', 'make', 'show', 'that', 'this', 'these', 'those', 'must',
  'should', 'update', 'change', 'values', 'value', 'any', 'all', 'user', 'file', 'files',
  'fix', 'when', 'how', 'work', 'works', 'working', 'check', 'inspect', 'investigate', 'extend',
  'support', 'handling', 'behavior', 'option', 'settings', 'setting', 'custom', 'unit', 'cover',
  'covered', 'coverage', 'test', 'tests', 'tested', 'doc', 'docs', 'document', 'documented',
  'documentation', 'alongside', 'other', 'built', 'appear', 'loaded', 'application', 'prints',
  'containing', 'code', 'function', 'method', 'class', 'return', 'request', 'selected', 'lines',
  'inline', 'edit', 'instruction', 'keep', 'scoped', 'region', 'editor', 'mcp', 'tools', 'stage',
  'proposed', 'review', 'before', 'applying', 'well', 'treat', 'also', 'every', 'list', 'treated',
]);

export interface ContextSelection {
  path: string;
  reason: string;
  tokens: number;
}

export interface ContextResult {
  text: string;
  selections: ContextSelection[];
  budgetTokens: number;
  usedTokens: number;
}

export interface ContextOptions {
  budgetTokens?: number;
  activeFile?: string;
  selection?: string;
}

type PathRole = 'production' | 'test' | 'docs' | 'noise';

interface Candidate {
  path: string;
  role: PathRole;
  score: number;
  reason: string[];
  explicit: boolean;
  explicitPriority: number;
  matchedTerms: Set<string>;
}

function tokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function stemToken(token: string): string {
  const lower = token.toLowerCase();
  if (lower.length <= 4) return lower;
  if (lower.endsWith('ating')) return lower.slice(0, -3);
  if (lower.endsWith('ing') && lower.length > 5) return lower.slice(0, -3);
  if (lower.endsWith('ies') && lower.length > 4) return `${lower.slice(0, -3)}y`;
  if (lower.endsWith('es') && lower.length > 4 && !lower.endsWith('tes')) return lower.slice(0, -2);
  if (lower.endsWith('s') && !lower.endsWith('ss')) return lower.slice(0, -1);
  return lower;
}

function splitCamel(ident: string): string[] {
  return ident
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(part => part.length >= 3 && !STOP_WORDS.has(part));
}

function extractCodeIdentifiers(prompt: string): string[] {
  const cleaned = prompt.replace(/@(?:file|symbol)(?:\([^)]*\)|:[^\s,]+)|@[\w./\\-]+/g, ' ');
  const found = new Set<string>();
  // snake_case identifiers (e.g. send_from_directory, from_prefixed_env, url_prefix)
  for (const match of cleaned.matchAll(/\b([a-zA-Z][a-zA-Z0-9]*_[a-zA-Z0-9_]+)\b/g)) {
    found.add(match[1]);
  }
  // CamelCase identifiers (e.g. MethodView, DefaultJSONProvider, SecureCookieSessionInterface)
  for (const match of cleaned.matchAll(/\b([A-Z][a-z0-9]+(?:[A-Z][a-zA-Z0-9]*)+|[A-Z]{2,}[a-z][a-zA-Z0-9]*)\b/g)) {
    found.add(match[1]);
  }
  // Dotted member access (e.g. Config.from_prefixed_env)
  for (const match of cleaned.matchAll(/\b([A-Z][A-Za-z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\b/g)) {
    found.add(match[1]);
    found.add(match[2]);
  }
  return [...found].slice(0, 12);
}

function words(text: string): string[] {
  const raw = text.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? [];
  const out: string[] = [];
  for (const token of raw) {
    const lower = token.toLowerCase();
    if (!STOP_WORDS.has(lower)) out.push(lower);
    if (/[A-Z]/.test(token) && /[a-z]/.test(token)) {
      for (const part of splitCamel(token)) out.push(part);
    }
    if (token.includes('_')) {
      for (const part of lower.split('_')) {
        if (part.length >= 3 && !STOP_WORDS.has(part)) out.push(part);
      }
    }
  }
  return [...new Set(out)];
}

function parseMentions(prompt: string): { files: string[]; symbols: string[] } {
  const files = [...prompt.matchAll(/@file\(([^)]+)\)|@file:([^\s,]+)|@([\w./\\-]+\.[\w]+)\b/g)]
    .map(match => (match[1] ?? match[2] ?? match[3]).replace(/\\/g, '/'));
  const symbols = [...prompt.matchAll(/@symbol\(([^)]+)\)|@symbol:([\w.]+)|@([A-Za-z_]\w*)(?![\w./\\-])/g)]
    .map(match => match[1] ?? match[2] ?? match[3])
    .filter(symbol => symbol !== 'file' && symbol !== 'symbol');
  return { files: [...new Set(files)], symbols: [...new Set(symbols)] };
}

function classifyPathRole(filePath: string): PathRole {
  const lower = filePath.toLowerCase();
  const base = path.posix.basename(lower);
  if (
    lower.startsWith('examples/') ||
    lower.includes('/examples/') ||
    /^changes(?:\.|$)|^changelog(?:\.|$)|^license(?:\.|$)/i.test(base) ||
    lower.startsWith('docs/patterns/') ||
    lower.startsWith('docs/tutorial/') ||
    lower.startsWith('docs/deploying/') ||
    lower.startsWith('tests/static/') ||
    lower.startsWith('tests/templates/') ||
    lower.startsWith('tests/test_apps/') ||
    lower.startsWith('tests/type_check/')
  ) {
    return 'noise';
  }
  if (
    lower.startsWith('tests/') ||
    lower.startsWith('test/') ||
    lower.includes('/tests/') ||
    lower.includes('/__tests__/') ||
    /^test_/.test(base) ||
    /(?:\.|_)(?:test|spec)\.[^.]+$/.test(base)
  ) {
    return 'test';
  }
  if (lower.startsWith('docs/') || lower.startsWith('doc/') || /\.(?:rst|md|adoc)$/.test(base)) {
    return 'docs';
  }
  return 'production';
}

function pathStems(filePath: string): string[] {
  const lower = filePath.toLowerCase();
  const withoutExt = lower.replace(/\.[^/.]+$/, '');
  const parts = withoutExt.split(/[\/._-]+/).filter(p => p.length >= 3 && !['src', 'lib', 'app', 'tests', 'test', 'docs', 'doc', 'init', 'index', 'main'].includes(p));
  const out = new Set<string>();
  for (const part of parts) {
    out.add(part);
    out.add(stemToken(part));
  }
  return [...out];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function rg(root: string, args: string[]): Promise<string> {
  try {
    // An explicit path keeps ripgrep from waiting for execFile's piped stdin.
    const { stdout } = await execFileAsync('rg', [...args, '.'], {
      cwd: root,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    });
    return stdout;
  } catch (error: any) {
    if (error.code === 1) return ''; // ripgrep uses 1 for no matches.
    if (error.code === 'ENOENT') return fallbackSearch(root, args);
    throw new Error(`Repository search failed: ${error.message}`);
  }
}

async function fallbackSearch(root: string, args: string[]): Promise<string> {
  const ignored = new Set(['.git', 'node_modules', 'dist', 'out', '.venv', 'venv', '__pycache__']);
  const files: string[] = [];
  const visit = async (directory: string, relative: string): Promise<void> => {
    if (files.length >= 20_000) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const child = path.join(directory, entry.name);
      const name = path.join(relative, entry.name).replace(/\\/g, '/');
      if (entry.isDirectory()) await visit(child, name);
      else if (entry.isFile()) files.push(name);
    }
  };
  await visit(root, '');
  if (args.includes('--files')) return files.join('\n');
  const fixed = args.includes('-F');
  const ignoreCase = args.includes('-i');
  const rawTerms = args.flatMap((arg, index) => arg === '-e' ? [args[index + 1]] : []);
  const matchers = rawTerms.map(term => {
    if (fixed) {
      const needle = ignoreCase ? term.toLowerCase() : term;
      return (content: string) => {
        const hay = ignoreCase ? content.toLowerCase() : content;
        return hay.split(needle).length - 1;
      };
    }
    const regex = new RegExp(term, ignoreCase ? 'gim' : 'gm');
    return (content: string) => (content.match(regex) ?? []).length;
  });
  const output: string[] = [];
  for (const file of files) {
    const info = await stat(path.join(root, file));
    if (info.size > 512 * 1024) continue;
    const content = await readFile(path.join(root, file), 'utf8').catch(() => '');
    if (content.includes('\0')) continue;
    const count = matchers.reduce((total, match) => total + match(content), 0);
    if (count > 0) output.push(args.includes('-l') ? file : `${file}:${count}`);
  }
  return output.join('\n');
}

function relativePath(root: string, candidate: string): string | undefined {
  const absolute = path.resolve(root, candidate);
  const relative = path.relative(root, absolute).replace(/\\/g, '/');
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) return;
  return relative;
}

function chooseLines(content: string, terms: string[], maxLines: number): string {
  const lines = content.split(/\r?\n/);
  const hits = lines.map((line, index) => {
    const lower = line.toLowerCase();
    const matches = terms.filter(term => lower.includes(term));
    const structural = /^\s*(?:def |class |export |function |@|self\.add_command|#{1,6} )/.test(line);
    return { index, score: matches.reduce((sum, term) => sum + Math.min(term.length, 10), 0) + (matches.length && structural ? 8 : 0) };
  }).filter(hit => hit.score > 0);
  const centers: number[] = [];
  const windowSize = 8;
  const windowCount = Math.max(1, Math.min(3, Math.floor(maxLines / windowSize)));
  const addCenter = (index: number) => {
    if (centers.length < windowCount && centers.every(other => Math.abs(other - index) >= windowSize * 2)) centers.push(index);
  };
  // One high-value match per region shows the shape of a large file; ranking
  // only the first matches tends to expose imports while hiding implementations.
  for (let position = 0; position < windowCount; position++) {
    const bucket = Math.floor((position + 0.5) * 5 / windowCount);
    const start = Math.floor(bucket * lines.length / 5);
    const end = Math.floor((bucket + 1) * lines.length / 5);
    const best = hits.filter(hit => hit.index >= start && hit.index < end)
      .sort((a, b) => b.score - a.score || a.index - b.index)[0];
    if (best) addCenter(best.index);
  }
  for (const hit of hits.sort((a, b) => b.score - a.score || a.index - b.index)) addCenter(hit.index);
  const selected = new Set<number>();
  if (lines.length > maxLines && maxLines >= 24) {
    for (let i = 0; i < Math.min(8, lines.length); i++) selected.add(i);
  }
  for (const center of centers) {
    for (let i = Math.max(0, center - 3); i <= Math.min(lines.length - 1, center + 4); i++) selected.add(i);
  }
  if (selected.size === 0) for (let i = 0; i < Math.min(lines.length, maxLines); i++) selected.add(i);
  let previous = -2;
  const output: string[] = [];
  for (const i of [...selected].sort((a, b) => a - b).slice(0, maxLines)) {
    if (i > previous + 1) output.push('...');
    output.push(`${i + 1}: ${lines[i]}`);
    previous = i;
  }
  return output.join('\n');
}

function resolveModuleCandidate(baseDir: string, modulePath: string, fileSet: Set<string>, extensions: string[]): string | undefined {
  const normalized = path.posix.normalize(path.posix.join(baseDir === '.' ? '' : baseDir, modulePath)).replace(/^\.\//, '');
  const candidates = [normalized, ...extensions.map(ext => `${normalized}${ext}`)];
  return candidates.find(candidate => fileSet.has(candidate));
}

/** Extract 1-hop workspace file neighbors imported or referenced by a seed file. */
export function extractReferencedFiles(seedPath: string, content: string, fileSet: Set<string>): string[] {
  const refs = new Set<string>();
  const ext = path.posix.extname(seedPath).toLowerCase();
  const dir = path.posix.dirname(seedPath);
  const addPy = (rawModule: string, importedNames = '') => {
    const dotsMatch = /^(\.+)(.*)$/.exec(rawModule.trim());
    const names = importedNames.split(',').map(part => part.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    if (dotsMatch) {
      let base = dir;
      for (let i = 1; i < dotsMatch[1].length; i++) base = path.posix.dirname(base);
      const rest = dotsMatch[2].replace(/\./g, '/');
      if (rest) {
        const hit = resolveModuleCandidate(base, rest, fileSet, ['.py', '/__init__.py']);
        if (hit && hit !== seedPath) refs.add(hit);
      } else {
        for (const name of names) {
          const hit = resolveModuleCandidate(base, name, fileSet, ['.py', '/__init__.py']);
          if (hit && hit !== seedPath) refs.add(hit);
        }
      }
      return;
    }
    const modPath = rawModule.trim().replace(/\./g, '/');
    if (!modPath) return;
    for (const prefix of ['', 'src/']) {
      const hit = resolveModuleCandidate('.', `${prefix}${modPath}`, fileSet, ['.py', '/__init__.py']);
      if (hit && hit !== seedPath) refs.add(hit);
    }
  };

  if (ext === '.py') {
    for (const match of content.matchAll(/^\s*from\s+([\w.]+)\s+import\s+([^\n#\\]+)/gm)) {
      addPy(match[1], match[2]);
    }
    for (const match of content.matchAll(/^\s*import\s+([\w., ]+)/gm)) {
      for (const item of match[1].split(',')) {
        const mod = item.trim().split(/\s+as\s+/)[0].trim();
        if (mod) addPy(mod);
      }
    }
  } else if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    for (const match of content.matchAll(/(?:from|import)\s+['"](\.[^'"]+)['"]|require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      const spec = match[1] ?? match[2];
      if (!spec) continue;
      const hit = resolveModuleCandidate(dir, spec, fileSet, ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']);
      if (hit && hit !== seedPath) refs.add(hit);
    }
  } else if (ext === '.rst' || ext === '.md') {
    for (const match of content.matchAll(/(?:module::\s*|:mod:`|:func:`|:class:`|~?)([\w.]+)/g)) {
      addPy(match[1]);
    }
  }
  return [...refs];
}

/** Assemble bounded, inspectable context without loading whole repository files. */
export async function assembleContext(
  workspaceRoot: string,
  prompt: string,
  options: ContextOptions = {},
): Promise<ContextResult> {
  const root = path.resolve(workspaceRoot);
  const budget = Math.max(1000, options.budgetTokens ?? 6000);
  const { files: mentionedFiles, symbols } = parseMentions(prompt);
  const codeIdents = extractCodeIdentifiers(prompt);
  const cleanedPrompt = prompt.replace(/@(?:file|symbol)(?:\([^)]*\)|:[^\s,]+)|@[\w./\\-]+/g, '');
  const queryTerms = words(cleanedPrompt).filter(term => term.length >= 3).slice(0, 18);
  const searchTerms = [...new Set([...symbols.map(s => s.toLowerCase()), ...queryTerms])];
  const stemSet = new Set(searchTerms.map(stemToken));
  const wantsTests = /\b(test|tests|tested|testing|coverage|covered)\b/i.test(prompt);
  const wantsDocs = /\b(doc|docs|document|documented|documentation)\b/i.test(prompt);
  const wantsCli = /\b(cli|command|commands)\b/i.test(prompt);
  const ignoredFlags = IGNORED.flatMap(pattern => ['-g', pattern]);
  const fileList = (await rg(root, ['--files', ...ignoredFlags]))
    .split(/\r?\n/).filter(Boolean).map(name => relativePath(root, name)).filter((name): name is string => !!name);
  const fileSet = new Set(fileList);
  const candidates = new Map<string, Candidate>();
  const add = (
    name: string,
    score: number,
    reason: string,
    explicit = false,
    explicitPriority = 0,
    matchedTerm?: string,
  ) => {
    const safe = relativePath(root, name);
    if (!safe || !fileSet.has(safe)) return;
    const existing = candidates.get(safe) ?? {
      path: safe,
      role: classifyPathRole(safe),
      score: 0,
      reason: [],
      explicit: false,
      explicitPriority: 0,
      matchedTerms: new Set<string>(),
    };
    existing.score += score;
    if (reason) existing.reason.push(reason);
    existing.explicit ||= explicit;
    if (explicitPriority > existing.explicitPriority) existing.explicitPriority = explicitPriority;
    if (matchedTerm) existing.matchedTerms.add(matchedTerm);
    candidates.set(safe, existing);
  };

  // Detect repository package/root name so generic mentions like "flask" don't swamp path matching.
  const dirCounts = new Map<string, number>();
  for (const name of fileList) {
    for (const seg of name.toLowerCase().split('/').slice(0, -1)) {
      dirCounts.set(seg, (dirCounts.get(seg) ?? 0) + 1);
    }
  }
  const repoCommonDirs = new Set(
    [...dirCounts.entries()].filter(([, count]) => count >= Math.max(8, fileList.length * 0.12)).map(([seg]) => seg),
  );

  // 1. Path & explicit @file scoring
  for (const name of fileList) {
    const lower = name.toLowerCase();
    const role = classifyPathRole(name);
    const segments = lower.replace(/\.[^/.]+$/, '').split(/[\/._-]+/).filter(Boolean);
    const segSet = new Set(segments);
    const segStems = new Set(segments.map(stemToken));
    const roleMult = role === 'noise' ? 0.45 : 1;

    for (const term of searchTerms) {
      if (repoCommonDirs.has(term)) continue;
      const termStem = stemToken(term);
      if (segSet.has(term)) {
        add(name, Math.round(28 * roleMult), `path matches ${term}`, false, 0, term);
      } else if (termStem.length >= 4 && segStems.has(termStem)) {
        add(name, Math.round(20 * roleMult), `path matches ${term}`, false, 0, term);
      }
    }
    if (wantsCli && segSet.has('cli')) {
      add(name, Math.round(35 * roleMult), 'CLI entry point', false, 0, 'cli');
    }
    for (const mention of mentionedFiles) {
      if (lower === mention.toLowerCase() || lower.endsWith(`/${mention.toLowerCase()}`)) {
        add(name, 140, `explicit @file ${mention}`, true, 3);
      }
    }
  }

  if (options.activeFile) {
    const active = relativePath(root, options.activeFile);
    if (active) add(active, 130, 'active editor file', true, 3);
  }

  // 2. Definition-aware symbol lookup (both explicit @symbol and prompt code identifiers)
  const allSymbolTargets = [...new Set([...symbols, ...codeIdents])].filter(sym => sym.length >= 3);
  if (allSymbolTargets.length) {
    const defPattern = `(?:^|\\s)(?:async\\s+)?(?:def|class|function|interface|type|const|let|var|fn|func)\\s+(?:${allSymbolTargets.map(escapeRegex).join('|')})\\b`;
    const defHits = await rg(root, ['-l', ...ignoredFlags, '-e', defPattern]);
    const explicitSet = new Set(symbols);
    for (const hit of defHits.split(/\r?\n/).filter(Boolean)) {
      const normalized = hit.replace(/\\/g, '/');
      const role = classifyPathRole(normalized);
      const isExplicit = symbols.length > 0 && (
        symbols.length === 1 ||
        allSymbolTargets.some(sym => explicitSet.has(sym))
      );
      if (isExplicit) {
        add(normalized, role === 'production' ? 140 : 100, `defines @symbol ${symbols.join(', ')}`, true, role === 'production' ? 3 : 2);
      } else {
        add(normalized, role === 'production' ? 75 : 45, 'defines referenced symbol', false, 0);
      }
    }
  }

  // Also check explicit @symbol references (ranked strictly below definitions & production files)
  if (symbols.length) {
    const symbolHits = await rg(root, ['-l', '-F', ...ignoredFlags, ...symbols.flatMap(symbol => ['-e', symbol])]);
    for (const name of symbolHits.split(/\r?\n/).filter(Boolean)) {
      const normalized = name.replace(/\\/g, '/');
      const role = classifyPathRole(normalized);
      const baseScore = role === 'production' ? 70 : role === 'test' ? 45 : role === 'docs' ? 30 : 12;
      add(normalized, baseScore, `explicit @symbol ${symbols.join(', ')}`, role !== 'noise', role === 'production' ? 2 : 1);
    }
  }

  // 3. IDF-weighted distinct-term lexical retrieval (parallel fixed-string ripgrep)
  const lexicalTerms = [...new Set([
    ...codeIdents.map(id => id.toLowerCase()),
    ...searchTerms.filter(term => !repoCommonDirs.has(term)),
  ])].slice(0, 10);

  if (lexicalTerms.length) {
    const perTermHits = await Promise.all(lexicalTerms.map(async term => {
      const out = await rg(root, ['-l', '-i', '-F', ...ignoredFlags, '-e', term]);
      const files = out.split(/\r?\n/).filter(Boolean).map(f => f.replace(/\\/g, '/'));
      return { term, files };
    }));
    const totalDocs = Math.max(1, fileList.length);
    for (const { term, files } of perTermHits) {
      if (files.length === 0) continue;
      // Skip ubiquitous terms appearing in >60% of the repo unless it's a code identifier.
      if (files.length > totalDocs * 0.6 && !term.includes('_')) continue;
      const idf = Math.log2(1 + totalDocs / (1 + files.length));
      const weight = Math.max(4, Math.min(26, Math.round(idf * 6)));
      for (const file of files) {
        const role = classifyPathRole(file);
        const adjusted = role === 'noise' ? Math.max(1, Math.round(weight * 0.35)) : weight;
        add(file, adjusted, '', false, 0, term);
      }
    }
    for (const candidate of candidates.values()) {
      if (candidate.matchedTerms.size > 0) {
        const preview = [...candidate.matchedTerms].slice(0, 3).join(', ');
        candidate.reason.push(`matches ${preview}`);
        if (candidate.role === 'production' && candidate.matchedTerms.size >= 2) {
          candidate.score += Math.min(24, candidate.matchedTerms.size * 6);
        }
      }
    }
  }

  // 4. Stem-matched test & docs pairing from top production candidates (general across any repo)
  const topProduction = [...candidates.values()]
    .filter(c => c.role === 'production')
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 3);
  const topProdStems = new Set(topProduction.flatMap(c => pathStems(c.path)));

  if (wantsTests || wantsDocs) {
    const joinedIdents = new Set(codeIdents.map(id => id.toLowerCase().replace(/_/g, '')));
    for (const name of fileList) {
      const role = classifyPathRole(name);
      if (role !== 'test' && role !== 'docs') continue;
      const fileStems = pathStems(name);
      const sharesProdStem = fileStems.some(s =>
        topProdStems.has(s) || [...topProdStems].some(ps => ps.length >= 3 && s.endsWith(ps)),
      );
      const sharesQueryStem = fileStems.some(s => stemSet.has(s) || joinedIdents.has(s));
      const existing = candidates.get(name);
      const contentMatches = existing?.matchedTerms.size ?? 0;

      if (wantsTests && role === 'test') {
        if (sharesProdStem || sharesQueryStem) {
          add(name, 48, 'requested test coverage');
        } else if (contentMatches >= 2) {
          add(name, 22, 'requested test coverage');
        }
      }
      if (wantsDocs && role === 'docs') {
        if (sharesProdStem || sharesQueryStem) {
          add(name, 48, 'requested documentation');
        } else if (contentMatches >= 2) {
          add(name, 20, 'requested documentation');
        }
      }
    }
  }

  // 5. 1-hop import / reference graph expansion from top seeds
  const orderedSeeds = [...candidates.values()].sort((a, b) =>
    Number(b.explicit) - Number(a.explicit) ||
    b.explicitPriority - a.explicitPriority ||
    Number(b.role === 'production') - Number(a.role === 'production') ||
    b.score - a.score ||
    a.path.localeCompare(b.path));
  const loadedContent = new Map<string, string>();
  for (const seed of orderedSeeds.slice(0, 3)) {
    const absolute = path.join(root, seed.path);
    const info = await stat(absolute).catch(() => undefined);
    if (!info?.isFile() || info.size > 512 * 1024) continue;
    const content = await readFile(absolute, 'utf8').catch(() => undefined);
    if (!content || content.includes('\0')) continue;
    loadedContent.set(seed.path, content);
    const relation = /\.(rst|md)$/i.test(seed.path) ? 'referenced by' : 'imported by';
    for (const neighbor of extractReferencedFiles(seed.path, content, fileSet)) {
      add(neighbor, 24, `${relation} ${seed.path}`);
    }
  }

  // 6. Category-balanced selection within the strict token budget
  const byScore = (a: Candidate, b: Candidate) =>
    Number(b.explicit) - Number(a.explicit) ||
    b.explicitPriority - a.explicitPriority ||
    b.score - a.score ||
    a.path.localeCompare(b.path);

  const allSorted = [...candidates.values()].sort(byScore);
  const prioritized: Candidate[] = [];
  const pickedPaths = new Set<string>();
  const take = (candidate?: Candidate) => {
    if (!candidate || pickedPaths.has(candidate.path)) return;
    pickedPaths.add(candidate.path);
    prioritized.push(candidate);
  };

  // Explicit @file / @symbol definitions & active file first
  for (const c of allSorted.filter(item => item.explicit)) take(c);
  // Guarantee top production files aren't crowded out by tests/docs
  for (const c of allSorted.filter(item => item.role === 'production').slice(0, 2)) take(c);
  if (wantsTests) {
    for (const c of allSorted.filter(item => item.role === 'test').slice(0, 2)) take(c);
  }
  if (wantsDocs) {
    for (const c of allSorted.filter(item => item.role === 'docs').slice(0, 2)) take(c);
  }
  for (const c of allSorted) take(c);

  const mapBudget = Math.min(2000, Math.floor(budget / 6));
  const explicitBudget = Math.min(4000, Math.floor(budget / 3));
  const automaticBudget = budget - mapBudget - explicitBudget;
  const automaticFileCap = Math.min(750, Math.max(220, Math.floor(automaticBudget / 8)));
  const repoMap = fileList.slice(0, 240).join('\n').slice(0, mapBudget * 4);
  const chunks = [`Repository file map (${fileList.length} files, truncated):\n${repoMap}`];
  const selections: ContextSelection[] = [];
  let explicitUsed = 0;
  let automaticUsed = 0;
  const excerptTerms = [...new Set([...symbols.map(s => s.toLowerCase()), ...codeIdents.map(s => s.toLowerCase()), ...queryTerms])];

  for (const candidate of prioritized) {
    if (selections.length >= 8) break;
    const limit = candidate.explicit
      ? Math.min(1000, explicitBudget - explicitUsed)
      : Math.min(automaticFileCap, automaticBudget - automaticUsed);
    if (limit < 150) continue;
    let content = loadedContent.get(candidate.path);
    if (content === undefined) {
      const absolute = path.join(root, candidate.path);
      const info = await stat(absolute).catch(() => undefined);
      if (!info?.isFile() || info.size > 512 * 1024) continue;
      content = await readFile(absolute, 'utf8').catch(() => undefined);
    }
    if (!content || content.includes('\0')) continue;
    const excerpt = chooseLines(content, excerptTerms, Math.min(140, Math.floor(limit * 4 / 55)));
    const uniqueReasons = [...new Set(candidate.reason.filter(Boolean))];
    const reasonText = uniqueReasons.join('; ');
    const header = `File: ${candidate.path}\nReason: ${reasonText}\n`;
    const allowedChars = Math.max(0, limit * 4 - header.length);
    const chunk = header + excerpt.slice(0, allowedChars);
    const used = tokens(chunk);
    if (candidate.explicit) explicitUsed += used;
    else automaticUsed += used;
    chunks.push(chunk);
    selections.push({ path: candidate.path, reason: reasonText, tokens: used });
  }

  if (options.selection) {
    const selected = options.selection.slice(0, Math.max(0, (budget - tokens(chunks.join('\n\n'))) * 4));
    if (selected) chunks.push(`Selected code in editor:\n${selected}`);
  }
  const text = chunks.join('\n\n');
  return { text, selections, budgetTokens: budget, usedTokens: tokens(text) };
}
