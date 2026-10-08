import { BoardError, ConflictError } from '../errors.js';
import type { GitSyncConfig } from '../model/types.js';
import { withBoardLock } from '../storage/lock.js';
import type { BoardPaths } from '../storage/paths.js';
import type { IntegrateOptions, IntegrateResult } from './integrate.js';
import { integrate, materialize } from './integrate.js';
import {
  changedBetween,
  commitFiles,
  dirtyPaths,
  fileState,
  headOf,
  isOwnRepo,
  moveHead,
  remoteUrl,
  syncIndex,
  trackingRef,
  writeWorkingFile,
} from './repo.js';
import type { FileState } from './repo.js';
import { firstLine, git, gitAsync } from './run.js';

/**
 * The network half: fetching, pulling, and the transaction every board write
 * runs inside when the board is shared through git.
 *
 * ## The transaction
 *
 * `sharedWrite` wraps an operation that is about to change the board. It
 * notes which files were already dirty, runs the operation, commits **exactly
 * the files the operation changed**, and pushes. Then one of three things:
 *
 *   - the push lands — done;
 *   - the push is rejected because somebody pushed first — fetch, `integrate`,
 *     push again. If their change and ours touched different files, both stand.
 *     If they touched the same file, ours is **undone** and a `ConflictError`
 *     names the documents: the board on disk is theirs, and nothing of ours is
 *     left half-applied. That is the claim guarantee — two people claiming one
 *     story both write its `_issue.md`, and the second to push is told;
 *   - the remote cannot be reached — ours is undone and the write refused,
 *     because a claim nobody else can see is not a claim. `LPM_GIT_OFFLINE=1`
 *     is the explicit way to work without the remote: commits stay local and
 *     the next sync pushes them.
 *
 * Undoing is not `reset --hard`: the board folder is somebody's working tree,
 * with views the web app keeps saving and hand edits in progress. Only the
 * files this operation changed are put back, each to what it was before the
 * operation ran — committed content, or the uncommitted edit it carried.
 *
 * Freshness is the front ends' job (they pull before they load); correctness
 * is this file's. A front end that forgot to pull still cannot overwrite
 * somebody else's work — it is refused at the push instead.
 */

/** Set to work without the remote: no fetch, no push, commits stay local. */
export const GIT_OFFLINE_ENV = 'LPM_GIT_OFFLINE';

export function isOffline(): boolean {
  const raw = process.env[GIT_OFFLINE_ENV]?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/** Where the board is shared, validated. */
export interface SyncTarget {
  dir: string;
  sync: GitSyncConfig;
}

/** Why sync cannot run here, or null when it can. */
export function syncProblem(dir: string, sync: GitSyncConfig): string | null {
  if (!isOwnRepo(dir)) return 'the board folder is not a git repository of its own';
  if (!remoteUrl(dir, sync.remote)) return `the board repository has no git remote named "${sync.remote}"`;
  if (!headOf(dir)) return 'the board repository has no commits yet';
  return null;
}

function requireTarget(paths: BoardPaths, sync: GitSyncConfig): SyncTarget {
  const problem = syncProblem(paths.lpmDir, sync);
  if (problem) {
    throw new BoardError(`This board is shared through git, but ${problem}`, [
      'Run `lpm git setup` to connect it, or `lpm git join` in a fresh project to clone it.',
      'To stop sharing it instead, remove the `git_sync:` block from .lpm/config.yml.',
    ]);
  }
  return { dir: paths.lpmDir, sync };
}

// ---------------------------------------------------------------------------
// Fetching

export type FetchResult =
  | { ok: true; /** The branch is not on the remote yet. */ missing: boolean }
  | { ok: false; error: string };

/** What this process last heard from each board's remote. */
interface FetchMemory {
  at: number;
  error: string | null;
}
const lastFetch = new Map<string, FetchMemory>();

export function lastFetchOf(dir: string): FetchMemory | null {
  return lastFetch.get(dir) ?? null;
}

function fetchArgs(sync: GitSyncConfig): string[] {
  return ['fetch', '--no-tags', sync.remote, `+refs/heads/${sync.branch}:${trackingRef(sync.remote, sync.branch)}`];
}

function settleFetch(dir: string, sync: GitSyncConfig, ok: boolean, stderr: string): FetchResult {
  if (ok) {
    lastFetch.set(dir, { at: Date.now(), error: null });
    return { ok: true, missing: false };
  }
  if (/couldn't find remote ref/i.test(stderr)) {
    // Not an error: nobody has pushed the branch yet. Forget any stale copy.
    git(dir, ['update-ref', '-d', trackingRef(sync.remote, sync.branch)]);
    lastFetch.set(dir, { at: Date.now(), error: null });
    return { ok: true, missing: true };
  }
  const error = firstLine(stderr);
  lastFetch.set(dir, { at: Date.now(), error });
  return { ok: false, error };
}

export function fetchBoard(dir: string, sync: GitSyncConfig): FetchResult {
  const result = git(dir, fetchArgs(sync), { network: true });
  return settleFetch(dir, sync, result.ok, result.stderr);
}

/** The same fetch without blocking the event loop, for the server's background pull. */
export async function fetchBoardAsync(dir: string, sync: GitSyncConfig): Promise<FetchResult> {
  const result = await gitAsync(dir, fetchArgs(sync), { network: true });
  return settleFetch(dir, sync, result.ok, result.stderr);
}

// ---------------------------------------------------------------------------
// Pulling

export type PullOutcome =
  /** The board is not shared through git. */
  | { kind: 'disabled' }
  /** `LPM_GIT_OFFLINE` is set; nothing was fetched. */
  | { kind: 'offline' }
  /** Fetched recently enough in this process; nothing was done. */
  | { kind: 'fresh' }
  /** Sync is configured but cannot run here (no repository, no remote). */
  | { kind: 'unavailable'; error: string }
  /** The remote could not be reached. */
  | { kind: 'unreachable'; error: string }
  | IntegrateResult;

export interface PullOptions extends IntegrateOptions {
  /** Skip the fetch when this process fetched within this many milliseconds. */
  maxAgeMs?: number;
  /** Do not fetch at all; integrate what was fetched before. */
  noFetch?: boolean;
}

/**
 * Fetch, then integrate under the board lock. Never throws for the network or
 * for a conflict — those are outcomes a reader carries on past — only for a
 * repository git itself cannot read.
 */
export function pullBoard(
  paths: BoardPaths,
  sync: GitSyncConfig | null,
  options: PullOptions = {},
): PullOutcome {
  if (!sync) return { kind: 'disabled' };
  const dir = paths.lpmDir;
  const problem = syncProblem(dir, sync);
  if (problem) return { kind: 'unavailable', error: problem };

  if (!options.noFetch) {
    if (isOffline()) return { kind: 'offline' };
    const last = lastFetch.get(dir);
    const fresh =
      options.maxAgeMs !== undefined && last && last.error === null && Date.now() - last.at < options.maxAgeMs;
    if (fresh) return { kind: 'fresh' };
    const fetched = fetchBoard(dir, sync);
    if (!fetched.ok) return { kind: 'unreachable', error: fetched.error };
  }

  return withBoardLock(paths, 'bring in the latest board from git', () => integrate(dir, sync, options));
}

// ---------------------------------------------------------------------------
// Pushing

type PushResult = { kind: 'ok' } | { kind: 'rejected' } | { kind: 'failed'; error: string };

function pushHead(dir: string, sync: GitSyncConfig): PushResult {
  const result = git(dir, ['push', '--porcelain', sync.remote, `HEAD:refs/heads/${sync.branch}`], {
    network: true,
  });
  if (result.ok) {
    // Keep the tracking ref honest even for a remote with no fetch refspec.
    git(dir, ['update-ref', trackingRef(sync.remote, sync.branch), 'HEAD']);
    lastFetch.set(dir, { at: Date.now(), error: null });
    return { kind: 'ok' };
  }
  const text = `${result.stdout}\n${result.stderr}`;
  if (/\[rejected\]|non-fast-forward|fetch first|\[remote rejected\].*(?:lock|cannot lock)/i.test(text)) {
    return { kind: 'rejected' };
  }
  return { kind: 'failed', error: firstLine(result.stderr || result.stdout) };
}

/** Push whatever is committed, integrating and retrying when somebody got there first. */
export function publish(paths: BoardPaths, sync: GitSyncConfig, options: IntegrateOptions = {}): IntegrateResult | { kind: 'pushed' } {
  const dir = paths.lpmDir;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const pushed = pushHead(dir, sync);
    if (pushed.kind === 'ok') return { kind: 'pushed' };
    if (pushed.kind === 'failed') {
      throw new BoardError(`Could not push the board to ${sync.remote}`, [pushed.error]);
    }
    const fetched = fetchBoard(dir, sync);
    if (!fetched.ok) throw new BoardError(`Could not fetch the board from ${sync.remote}`, [fetched.error]);
    const result = integrate(dir, sync, options);
    if (result.kind === 'conflict') return result;
  }
  throw new BoardError(`${sync.remote} kept moving while the board was being pushed`, [
    `Tried ${MAX_ATTEMPTS} times. Somebody is writing to the board continuously; try again in a moment.`,
  ]);
}

const MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// The write transaction

/** How deep this process is inside a shared write, per board. */
const depth = new Map<string, number>();

/** What the working tree looked like before an operation ran. */
type Snapshot = Map<string, FileState>;

function snapshot(dir: string): Snapshot {
  const out: Snapshot = new Map();
  for (const file of dirtyPaths(dir)) out.set(file, fileState(dir, file));
  return out;
}

/** Files whose content differs between two snapshots. */
function changedFiles(dir: string, before: Snapshot, after: Snapshot): string[] {
  const out: string[] = [];
  for (const file of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(file)?.hash;
    // A file dirty before and clean after was rewritten to what HEAD holds —
    // still a change the operation made.
    const b = after.has(file) ? after.get(file)!.hash : before.has(file) ? fileState(dir, file).hash : undefined;
    if (a !== b) out.push(file);
  }
  return out.sort();
}

/**
 * Put every file the operation changed back to what it was before it ran, and
 * move the branch back to where it was. Files the operation did not touch —
 * somebody's uncommitted view, a hand edit — are left exactly alone.
 */
function undo(dir: string, base: string, files: readonly string[], before: Snapshot): void {
  // A retry may already have laid our commit over somebody else's, so the
  // branch can be ahead of `base` by more than our own files.
  const head = headOf(dir);
  const moved = head && head !== base ? changedBetween(dir, base, head) : [];
  const all = [...new Set([...moved, ...files])];
  materialize(dir, base, all);
  moveHead(dir, base, 'lpm: undo a board change that could not be shared');
  syncIndex(dir, all);
  for (const file of files) {
    const prior = before.get(file);
    if (prior && (prior.bytes !== null || prior.hash === null)) writeWorkingFile(dir, file, prior.bytes);
  }
}

/** Document ids (or plain paths) for a list of board files, for a message. */
export function describeFiles(files: readonly string[]): string[] {
  const out = new Set<string>();
  for (const file of files) {
    const parts = file.split('/');
    const name = parts.at(-1) ?? file;
    const folder = parts.at(-2);
    const id = folder?.match(/^[A-Z][A-Z0-9]*-\d+/)?.[0];
    out.add(id && name.startsWith('_') ? id : file);
  }
  return [...out];
}

/**
 * Run `run` as a write to a board shared through git: commit what it changed,
 * push it, and undo it when it cannot be shared. Re-entrant — an operation
 * built from operations commits once, at the outermost call.
 *
 * With no `sync`, `run` is simply called: a board that is not shared behaves
 * exactly as it always did.
 */
export function sharedWrite<T>(
  paths: BoardPaths,
  sync: GitSyncConfig | null,
  what: string,
  run: () => T,
  options: IntegrateOptions = {},
): T {
  const dir = paths.lpmDir;
  const level = depth.get(dir) ?? 0;
  if (!sync || level > 0) return run();

  requireTarget(paths, sync);
  depth.set(dir, level + 1);
  try {
    const before = snapshot(dir);
    const result = run();
    const files = changedFiles(dir, before, snapshot(dir));
    if (!files.length) return result;

    const base = headOf(dir)!;
    const commit = commitFiles(dir, files, `lpm: ${what}`);
    if (!commit || isOffline()) return result;

    let outcome: ReturnType<typeof publish>;
    try {
      outcome = publish(paths, sync, options);
    } catch (error) {
      undo(dir, base, files, before);
      const details = error instanceof BoardError ? [error.message, ...error.details] : [String(error)];
      throw new BoardError(`Nothing was changed: the board could not be shared through ${sync.remote}`, [
        ...details,
        `Check the connection with \`lpm git status\`. To work offline on purpose, set ${GIT_OFFLINE_ENV}=1 — changes are then committed locally and pushed by the next \`lpm git sync\`.`,
      ]);
    }

    if (outcome.kind === 'conflict') {
      undo(dir, base, files, before);
      // Show the reader what won, now that ours is out of the way. Best effort:
      // a board that cannot be brought level is still a board that refused.
      try {
        integrate(dir, sync, options);
      } catch {
        // Reported by the next pull.
      }
      const documents = describeFiles(outcome.paths);
      throw new ConflictError(
        outcome.reason === 'uncommitted'
          ? `Nothing was changed: incoming board changes collide with uncommitted edits to ${documents.join(', ')}`
          : `Nothing was changed: ${documents.join(', ')} changed upstream while you were working`,
        outcome.reason === 'uncommitted'
          ? ['Commit or discard those edits (`lpm git sync` commits them), then repeat the change.']
          : [
              'Somebody else wrote the same document and pushed first. The board now shows their version.',
              'Read it again and repeat the change if it still makes sense.',
            ],
      );
    }
    return result;
  } finally {
    depth.set(dir, level);
  }
}
