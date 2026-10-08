import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BoardError } from '../errors.js';
import { firstLine, git, gitBytes } from './run.js';

/**
 * Questions about the `.lpm` repository, and the handful of writes the sync
 * layer makes to it. Every path in and out of here is relative to the
 * repository root (the board folder), with forward slashes — git's spelling.
 */

/** True when `dir` is the root of a git repository of its own. */
export function isOwnRepo(dir: string): boolean {
  // `.git` beside the board, not merely "inside some work tree": a `.lpm` with
  // no repository of its own sits inside the project's, and every command here
  // would otherwise run against the code.
  return existsSync(path.join(dir, '.git'));
}

/** The commit a ref names, or null when it names nothing. */
export function resolveRef(dir: string, ref: string): string | null {
  const result = git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return result.ok ? result.stdout.trim() || null : null;
}

export function headOf(dir: string): string | null {
  return resolveRef(dir, 'HEAD');
}

/** The remote-tracking ref this board's branch is fetched into. */
export function trackingRef(remote: string, branch: string): string {
  return `refs/remotes/${remote}/${branch}`;
}

export function remoteUrl(dir: string, remote: string): string | null {
  const result = git(dir, ['remote', 'get-url', remote]);
  return result.ok ? result.stdout.trim() || null : null;
}

/** The name of the checked-out branch, or null on a detached HEAD. */
export function currentBranch(dir: string): string | null {
  const result = git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return result.ok ? result.stdout.trim() || null : null;
}

export function mergeBase(dir: string, a: string, b: string): string | null {
  const result = git(dir, ['merge-base', a, b]);
  return result.ok ? result.stdout.trim() || null : null;
}

/** How many commits `from` has that `to` does not. */
export function countBetween(dir: string, to: string, from: string): number {
  const result = git(dir, ['rev-list', '--count', `${to}..${from}`]);
  return result.ok ? Number(result.stdout.trim()) || 0 : 0;
}

function splitZ(text: string): string[] {
  return text.split('\0').filter(Boolean);
}

/** Files that differ between two commits. */
export function changedBetween(dir: string, from: string, to: string): string[] {
  const result = git(dir, ['diff', '--name-only', '-z', '--no-renames', from, to]);
  if (!result.ok) throw new BoardError('Could not compare two versions of the board', [firstLine(result.stderr)]);
  return splitZ(result.stdout);
}

/**
 * Paths with uncommitted changes, untracked files included and ignored ones not.
 * `--no-optional-locks` because this runs on every write, and a status that
 * takes the index lock to refresh stat data collides with whatever git command
 * the person is running in another window.
 */
export function dirtyPaths(dir: string): string[] {
  const result = git(dir, [
    '--no-optional-locks',
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--no-renames',
  ]);
  if (!result.ok) throw new BoardError('Could not read the state of the board repository', [firstLine(result.stderr)]);
  return splitZ(result.stdout).map((entry) => entry.slice(3));
}

/** Every path the commit holds. */
export function filesAt(dir: string, commit: string): Set<string> {
  const result = git(dir, ['ls-tree', '-r', '-z', '--name-only', commit]);
  return new Set(result.ok ? splitZ(result.stdout) : []);
}

/** A file as one commit holds it, or null when it does not. */
export function fileAt(dir: string, commit: string, file: string): Buffer | null {
  return gitBytes(dir, ['cat-file', 'blob', `${commit}:${file}`]);
}

/** Subject lines of the commits in `from..to`, oldest first. */
export function subjectsBetween(dir: string, from: string, to: string): string[] {
  const result = git(dir, ['log', '--reverse', '--format=%s', `${from}..${to}`]);
  return result.ok ? result.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : [];
}

/**
 * The bytes of a working-tree file — the before-and-after picture a write is
 * measured by. `null` means "not there".
 */
export interface FileState {
  hash: string | null;
  /** The content itself, kept so an undone write can put it back. */
  bytes: Buffer | null;
}

/** Files above this size are compared by hash only and never restored from memory. */
const KEEP_BYTES_LIMIT = 4 * 1024 * 1024;

export function fileState(dir: string, file: string): FileState {
  const full = path.join(dir, file);
  try {
    if (!statSync(full).isFile()) return { hash: null, bytes: null };
    const bytes = readFileSync(full);
    const hash = createHash('sha1').update(bytes).digest('hex');
    return { hash, bytes: bytes.length <= KEEP_BYTES_LIMIT ? bytes : null };
  } catch {
    return { hash: null, bytes: null };
  }
}

/** Put a working-tree file back to `bytes`, or delete it when `bytes` is null. */
export function writeWorkingFile(dir: string, file: string, bytes: Buffer | null): void {
  const full = path.join(dir, file);
  if (bytes === null) {
    rmSync(full, { force: true });
    return;
  }
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, bytes);
}

/**
 * Who a commit is signed by when git has not been told. A board written from a
 * web page has nobody at a terminal to run `git config user.name`, and failing
 * every write over a missing name would be a strange way to find out.
 */
function identityEnv(dir: string): Record<string, string> {
  const name = git(dir, ['config', 'user.name']).stdout.trim();
  const email = git(dir, ['config', 'user.email']).stdout.trim();
  if (name && email) return {};
  let user = 'light-plan';
  try {
    user = os.userInfo().username || user;
  } catch {
    // Keep the fallback.
  }
  const fallbackName = name || user;
  const fallbackEmail = email || `${user}@${os.hostname() || 'localhost'}`;
  return {
    GIT_AUTHOR_NAME: fallbackName,
    GIT_AUTHOR_EMAIL: fallbackEmail,
    GIT_COMMITTER_NAME: fallbackName,
    GIT_COMMITTER_EMAIL: fallbackEmail,
  };
}

/**
 * Commit exactly `files` — their current working-tree state, deletions
 * included — on top of HEAD, and nothing else.
 *
 * Built in a private index rather than the repository's own, so whatever the
 * person had staged, or left dirty in another file (a view the web app keeps
 * saving, a hand edit in progress), is neither swept into the commit nor
 * disturbed by it. The real index is then brought level for these paths only.
 *
 * Returns the new commit, or null when the files already match HEAD.
 */
export function commitFiles(dir: string, files: readonly string[], message: string): string | null {
  if (!files.length) return null;
  const head = headOf(dir);
  const gitDir = path.resolve(dir, git(dir, ['rev-parse', '--git-dir']).stdout.trim() || '.git');
  const indexFile = path.join(gitDir, `lpm-index-${process.pid}-${Date.now()}`);
  const env = { GIT_INDEX_FILE: indexFile, ...identityEnv(dir) };

  try {
    const read = git(dir, head ? ['read-tree', head] : ['read-tree', '--empty'], { env });
    if (!read.ok) throw new BoardError('Could not prepare a commit of the board', [firstLine(read.stderr)]);

    // A path that is neither on disk nor in HEAD (created and deleted again
    // within one write) is not a change git can name; leave it out rather than
    // fail the whole commit on it.
    const tracked = head ? filesAt(dir, head) : new Set<string>();
    const wanted = files.filter((file) => tracked.has(file) || existsSync(path.join(dir, file)));
    if (!wanted.length) return null;

    const add = git(dir, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], {
      env,
      input: wanted.join('\0'),
    });
    if (!add.ok) throw new BoardError('Could not stage the board change', [firstLine(add.stderr)]);

    const tree = git(dir, ['write-tree'], { env }).stdout.trim();
    if (!tree) throw new BoardError('Could not write the board change to git');
    if (head && git(dir, ['rev-parse', `${head}^{tree}`]).stdout.trim() === tree) return null;

    const commit = git(dir, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', message], { env });
    if (!commit.ok) throw new BoardError('Could not commit the board change', [firstLine(commit.stderr)]);
    const sha = commit.stdout.trim();

    // Compare-and-swap: if something else moved HEAD while this was being
    // built, refuse rather than write over it.
    const update = git(dir, ['update-ref', '-m', message, 'HEAD', sha, ...(head ? [head] : [])]);
    if (!update.ok) throw new BoardError('The board repository moved while a change was being committed', [firstLine(update.stderr)]);
  } finally {
    rmSync(indexFile, { force: true });
  }

  syncIndex(dir, files);
  return headOf(dir);
}

/** Bring the repository's own index level with HEAD for these paths only. */
export function syncIndex(dir: string, files: readonly string[]): void {
  if (!files.length || !headOf(dir)) return;
  git(dir, ['reset', '-q', 'HEAD', '--pathspec-from-file=-', '--pathspec-file-nul'], {
    input: files.join('\0'),
  });
}

/** Move the branch to `commit` without touching the working tree. */
export function moveHead(dir: string, commit: string, message: string): void {
  const result = git(dir, ['update-ref', '-m', message, 'HEAD', commit]);
  if (!result.ok) throw new BoardError('Could not move the board branch', [firstLine(result.stderr)]);
}
