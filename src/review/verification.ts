import { execFile } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { hashText } from './proposalStore';

const exec = promisify(execFile);

export interface VerificationPatch {
  path: string;
  baseHash: string;
  resultText: string;
}

function within(root: string, candidate: string): string {
  const absolute = path.resolve(root, candidate);
  const relative = path.relative(root, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || candidate.includes(':')) {
    throw new Error(`Path is outside the workspace: ${candidate}`);
  }
  return absolute;
}

async function fileInfo(filename: string) {
  try { return await lstat(filename); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

export async function workspacePython(root: string): Promise<string> {
  const executable = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python';
  const local = path.join(root, '.venv', executable);
  return await fileInfo(local) ? local : process.platform === 'win32' ? 'python' : 'python3';
}

export async function verifySelectedHunks(
  workspaceRoot: string, patches: readonly VerificationPatch[], python: string, testPath: string, signal: AbortSignal,
): Promise<{ passed: boolean; output: string }> {
  if (!patches.length) throw new Error('Select at least one changed hunk to verify');
  if (!/^[\w./-]+\.py$/.test(testPath) || testPath.startsWith('-') || path.isAbsolute(testPath)) {
    throw new Error('Enter a workspace-relative Python test path, such as tests/test_cli.py');
  }
  const root = await realpath(workspaceRoot);
  within(root, testPath);
  const { stdout } = await exec('git', ['ls-files', '--cached', '-z'], { cwd: root, signal, timeout: 10_000, maxBuffer: 2_000_000, windowsHide: true });
  const files = [...new Set(stdout.split('\0').filter(Boolean))];
  if (!files.length || files.length > 20_000) throw new Error('Verification requires a Git workspace with at most 20,000 tracked files');
  const snapshot = await mkdtemp(path.join(tmpdir(), 'anvil-verify-'));
  const tracked = new Set(files);
  try {
    let bytes = 0;
    for (const name of files) {
      signal.throwIfAborted();
      if (/^\.env(?:\.[^/]+)?$/i.test(name) || /(?:^|\/)(?:\.npmrc|\.netrc|\.pypirc)$/i.test(name)) continue;
      const from = within(root, name);
      const info = await fileInfo(from);
      if (!info?.isFile() || path.relative(root, await realpath(from)) !== path.relative(root, from)) continue;
      bytes += info.size;
      if (bytes > 128 * 1024 * 1024) throw new Error('The tracked source snapshot exceeds the 128 MB verification limit');
      const to = within(snapshot, name);
      await mkdir(path.dirname(to), { recursive: true });
      await copyFile(from, to);
    }
    for (const patch of patches) {
      signal.throwIfAborted();
      const from = within(root, patch.path);
      const to = within(snapshot, patch.path);
      const info = await fileInfo(from);
      if (info && (!tracked.has(patch.path.replace(/\\/g, '/')) || !info.isFile() || !(await fileInfo(to)))) {
        throw new Error(`Cannot verify a file outside the tracked snapshot: ${patch.path}`);
      }
      const original = info ? (await readFile(to, 'utf8')).replace(/^\uFEFF/, '') : '';
      if (hashText(original) !== patch.baseHash) throw new Error(`Source changed during review: ${patch.path}`);
      await mkdir(path.dirname(to), { recursive: true });
      await writeFile(to, patch.resultText);
    }
    if (!(await fileInfo(within(snapshot, testPath)))?.isFile()) throw new Error(`Test file is absent from the snapshot: ${testPath}`);
    try {
      const { stdout, stderr } = await exec(python, ['-B', '-m', 'pytest', '-q', '-p', 'no:cacheprovider', '--', testPath], {
        cwd: snapshot, signal, timeout: 120_000, maxBuffer: 256_000, windowsHide: true,
        env: { ...process.env, PYTHONPATH: [path.join(snapshot, 'src'), snapshot].join(path.delimiter) },
      });
      return { passed: true, output: [stdout, stderr].filter(Boolean).join('\n').trim().slice(-1600) };
    } catch (error) {
      signal.throwIfAborted();
      const failure = error as Error & { stdout?: string; stderr?: string };
      return { passed: false, output: [failure.stdout, failure.stderr].filter(Boolean).join('\n').trim().slice(-1600) || failure.message };
    }
  } finally {
    await rm(snapshot, { recursive: true, force: true, maxRetries: 2 });
  }
}
