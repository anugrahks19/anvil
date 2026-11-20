import { createHash, randomUUID } from 'node:crypto';
import { structuredPatch } from 'diff';

export interface Hunk {
  id: string;
  path: string;
  header: string;
  oldStart: number;
  newStart: number;
  oldLines: string[];
  newLines: string[];
  diffLines: string[];
}

export interface ProposalFile {
  path: string;
  baseText: string;
  proposedText: string;
  baseHash: string;
  hunks: Hunk[];
}

export interface Proposal {
  id: string;
  files: ProposalFile[];
}

export class ProposalStore {
  private active: Proposal | undefined;
  private selectedHunks: Set<string> | undefined;

  current(): Proposal | undefined {
    return this.active ? this.get(this.active.id) : undefined;
  }

  stage(path: string, baseText: string, proposedText: string): Proposal {
    if (!this.active) this.active = { id: randomUUID(), files: [] };
    const existing = this.active.files.find(file => file.path === path);
    if (existing && existing.baseText !== baseText) {
      throw new Error(`Source changed since the first proposal: ${path}`);
    }
    const hunks = buildHunks(path, baseText, proposedText);
    const file: ProposalFile = {
      path,
      baseText,
      proposedText,
      baseHash: hashText(baseText),
      hunks,
    };
    if (existing) this.active.files.splice(this.active.files.indexOf(existing), 1, file);
    else this.active.files.push(file);
    this.selectedHunks = undefined;
    return this.get(this.active.id)!;
  }

  get(id: string): Proposal | undefined {
    if (this.active?.id !== id) return undefined;
    return {
      id: this.active.id,
      files: this.active.files.map(file => ({
        ...file,
        hunks: file.hunks.map(hunk => ({
          ...hunk,
          oldLines: [...hunk.oldLines],
          newLines: [...hunk.newLines],
          diffLines: [...hunk.diffLines],
        })),
      })),
    };
  }

  select(id: string, hunkIds: readonly string[]): void {
    const proposal = this.get(id);
    if (!proposal) throw new Error('Proposal no longer exists');
    const allowed = new Set(proposal.files.flatMap(file => file.hunks.map(hunk => hunk.id)));
    for (const hunkId of hunkIds) {
      if (!allowed.has(hunkId)) throw new Error(`Unknown hunk: ${hunkId}`);
    }
    this.selectedHunks = new Set(hunkIds);
  }

  selected(id: string): { path: string; baseText: string; baseHash: string; resultText: string }[] {
    const proposal = this.get(id);
    if (!proposal) throw new Error('Proposal no longer exists');
    if (!this.selectedHunks) throw new Error('Review each hunk in the editor before applying');
    return proposal.files.map(file => ({
      path: file.path,
      baseText: file.baseText,
      baseHash: file.baseHash,
      resultText: applySelectedHunks(file, this.selectedHunks!),
    })).filter(file => file.baseText !== file.resultText);
  }

  selectedCount(id: string): number {
    if (!this.get(id) || !this.selectedHunks) throw new Error('Proposal has not been reviewed');
    return this.selectedHunks.size;
  }

  clear(): void {
    this.active = undefined;
    this.selectedHunks = undefined;
  }
}

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function buildHunks(path: string, oldText: string, newText: string): Hunk[] {
  const patch = structuredPatch(path, path, oldText, newText, '', '', { context: 3 });
  return patch.hunks.map((hunk, index) => {
    const oldLines = hunk.lines.filter(line => line.startsWith(' ') || line.startsWith('-')).map(line => line.slice(1).replace(/\r$/, ''));
    const newLines = hunk.lines.filter(line => line.startsWith(' ') || line.startsWith('+')).map(line => line.slice(1).replace(/\r$/, ''));
    return {
      id: `${path}:${index}:${hashText(hunk.lines.join('\n')).slice(0, 10)}`,
      path,
      header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      oldStart: hunk.oldStart,
      newStart: hunk.newStart,
      oldLines,
      newLines,
      diffLines: hunk.lines,
    };
  });
}

function applySelectedHunks(file: ProposalFile, selected: Set<string>): string {
  if (!file.hunks.some(hunk => selected.has(hunk.id))) return file.baseText;
  const newline = file.baseText.includes('\r\n') ? '\r\n' : '\n';
  const baseTrailingNewline = file.baseText.endsWith('\n');
  const lines = file.baseText.length === 0 ? [] : file.baseText.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  for (const hunk of [...file.hunks].reverse()) {
    if (!selected.has(hunk.id)) continue;
    const at = Math.max(0, hunk.oldStart - 1);
    const actual = lines.slice(at, at + hunk.oldLines.length);
    if (actual.join('\n') !== hunk.oldLines.join('\n')) {
      throw new Error(`Hunk source does not match: ${file.path}`);
    }
    lines.splice(at, hunk.oldLines.length, ...hunk.newLines);
  }
  const result = lines.join(newline);
  const lastLine = file.baseText.length === 0 ? 0 : file.baseText.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length;
  const touchesEnd = file.baseText.length === 0 || file.hunks.some(hunk => selected.has(hunk.id) && hunk.oldStart + hunk.oldLines.length - 1 >= lastLine);
  const trailing = touchesEnd ? file.proposedText.endsWith('\n') : baseTrailingNewline;
  return result + (trailing ? newline : '');
}
