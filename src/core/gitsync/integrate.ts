import { existsSync } from 'node:fs';
import path from 'node:path';
import { BoardError } from '../errors.js';
import type { GitSyncConfig } from '../model/types.js';
import { INDEX_FILE, STATE_FILE } from '../storage/paths.js';
import {
  changedBetween,
  commitFiles,
  dirtyPaths,
  fileAt,
  filesAt,
  headOf,
  mergeBase,
  moveHead,
  countBetween,
  resolveRef,
  subjectsBetween,
  syncIndex,
  trackingRef,
  writeWorkingFile,
} from './repo.js';
import { firstLine, git } from './run.js';

/**
 * Bringing what was fetched into the board.
 *
 * Three shapes, and the rule that separates the last two is the whole design:
 *
 *   - **behind** — fast-forward. Somebody else wrote; nothing here did.
 *   - **diverged, different files** — what this checkout committed is laid on
 *     top of upstream as one commit, and both changes stand. Two people
 *     editing two stories is not a conflict, and refusing it would make a
 *     shared board unusable.
 *   - **diverged, the same file** — a conflict, and nothing moves. light-plan
 *     cannot know whether your title and their status change belong together,
 *     any more than `requireUnchanged` can, so it says so instead of merging
 *     lines inside a document. A claim is exactly this case: two people wrote
 *     the same `_issue.md`, and the second must be told rather than win.
 *
 * Two files are exempt from "the same file", because neither is anybody's
 * writing: `INDEX.md` is derived and is rendered again from the result, and
 * `state.json` holds counters, which merge by taking the larger of each. Two
 * people creating an issue at the same moment still collide — on the folder
 * both allocated, which *is* a document — but an issue here and a sprint there
 * do not.
 *
 * Works through plumbing (`checkout <commit> -- <paths>`, `update-ref`) rather
 * than `merge` or `rebase`, so it touches exactly the files it names and never
 * leaves conflict markers, a half-finished rebase, or a stash behind in a
 * folder people open in an editor.
 */

export type Resolution = 'ours' | 'theirs';

export type IntegrateResult =
  /** The branch does not exist on the remote yet; the first push creates it. */
  | { kind: 'no-upstream' }
  | { kind: 'current' }
  /** Only local commits — nothing to bring in, something to push. */
  | { kind: 'ahead'; ahead: number }
  | { kind: 'fast-forward'; files: string[] }
  /** Local work laid over upstream. */
  | { kind: 'rebased'; files: string[] }
  | {
      kind: 'conflict';
      /**
       * `diverged`: committed work here and upstream changed the same files.
       * `uncommitted`: incoming work would overwrite edits nobody committed.
       */
      reason: 'diverged' | 'uncommitted';
      paths: string[];
    };

export interface IntegrateOptions {
  /**
   * Settle a `diverged` conflict instead of reporting it: `ours` keeps this
   * checkout's version of every contested file, `theirs` takes upstream's.
   */
  resolve?: Resolution;
  /** The board's index rendered from what is on disk now, or null if it cannot be. */
  renderIndex?: () => string | null;
  /** Say what would happen, and change nothing. */
  dryRun?: boolean;
}

/** Files nobody writes by hand, which therefore never count as contested. */
const DERIVED = new Set([INDEX_FILE, STATE_FILE]);

/** Make the working tree hold `commit`'s version of `files` (absent ones deleted). */
export function materialize(dir: string, commit: string, files: readonly string[]): void {
  if (!files.length) return;
  const present = filesAt(dir, commit);
  const there = files.filter((file) => present.has(file));
  const gone = files.filter((file) => !present.has(file));
  if (there.length) {
    const result = git(dir, ['checkout', commit, '--pathspec-from-file=-', '--pathspec-file-nul'], {
      input: there.join('\0'),
    });
    if (!result.ok) throw new BoardError('Could not update the board from git', [firstLine(result.stderr)]);
  }
  for (const file of gone) {
    if (existsSync(path.join(dir, file))) writeWorkingFile(dir, file, null);
  }
}

/** `state.json` from both sides, keeping the higher of every counter. */
function mergedState(dir: string, ours: string, theirs: string): Buffer | null {
  const read = (commit: string): Record<string, unknown> => {
    const bytes = fileAt(dir, commit, STATE_FILE);
    if (!bytes) return {};
    try {
      return JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const a = read(ours);
  const b = read(theirs);
  const merged: Record<string, unknown> = { ...b, ...a };
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const left = a[key];
    const right = b[key];
    if (typeof left === 'number' && typeof right === 'number') merged[key] = Math.max(left, right);
  }
  return Object.keys(merged).length ? Buffer.from(`${JSON.stringify(merged, null, 2)}\n`, 'utf8') : null;
}

export function integrate(
  dir: string,
  sync: GitSyncConfig,
  options: IntegrateOptions = {},
): IntegrateResult {
  const upstream = resolveRef(dir, trackingRef(sync.remote, sync.branch));
  if (!upstream) return { kind: 'no-upstream' };
  const head = headOf(dir);
  if (!head) {
    throw new BoardError('The board repository has no commits yet', ['Run `lpm git setup` to share it.']);
  }
  if (head === upstream) return { kind: 'current' };

  const base = mergeBase(dir, head, upstream);
  if (base === upstream) return { kind: 'ahead', ahead: countBetween(dir, upstream, head) };
  if (!base) {
    throw new BoardError(`The board and ${sync.remote}/${sync.branch} share no history`, [
      'They are two different boards. Run `lpm git status` for the remote this one points at,',
      'or move this .lpm aside and run `lpm git join` to work on the shared one.',
    ]);
  }

  const incoming = changedBetween(dir, base, upstream);
  const ours = base === head ? [] : changedBetween(dir, base, head);
  const touched = new Set([...incoming, ...ours]);

  // Uncommitted edits in the way. The index is derived, so a local copy of it
  // is simply dropped and taken from whichever side wins.
  const dirty = dirtyPaths(dir);
  const blocked = dirty.filter((file) => touched.has(file) && file !== INDEX_FILE);
  if (blocked.length) return { kind: 'conflict', reason: 'uncommitted', paths: blocked.sort() };

  if (base === head) {
    if (options.dryRun) return { kind: 'fast-forward', files: incoming };
    materialize(dir, upstream, incoming);
    moveHead(dir, upstream, `lpm: fast-forward to ${sync.remote}/${sync.branch}`);
    syncIndex(dir, incoming);
    return { kind: 'fast-forward', files: incoming };
  }

  const incomingSet = new Set(incoming);
  const contested = ours.filter((file) => incomingSet.has(file) && !DERIVED.has(file)).sort();
  if (contested.length && !options.resolve) {
    return { kind: 'conflict', reason: 'diverged', paths: contested };
  }

  if (options.dryRun) return { kind: 'rebased', files: [...touched].sort() };

  const subjects = subjectsBetween(dir, base, head);
  const contestedSet = new Set(contested);
  const keep = ours.filter(
    (file) => !DERIVED.has(file) && (options.resolve === 'ours' || !contestedSet.has(file)),
  );

  // Stand on upstream for everything either side changed, then lay our files
  // back over it. The commit `head` stays in the object store, so nothing of
  // ours is lost even if a step below fails.
  materialize(dir, upstream, [...touched]);
  moveHead(dir, upstream, `lpm: re-apply local work on ${sync.remote}/${sync.branch}`);
  syncIndex(dir, [...touched]);
  materialize(dir, head, keep);

  const state = mergedState(dir, head, upstream);
  if (state) writeWorkingFile(dir, STATE_FILE, state);
  const index = options.renderIndex?.();
  if (index) writeWorkingFile(dir, INDEX_FILE, Buffer.from(index, 'utf8'));

  const message =
    subjects.length === 1 ? subjects[0]! : `lpm: ${subjects.length} board changes\n\n${subjects.map((s) => `- ${s}`).join('\n')}`;
  commitFiles(dir, [...keep, STATE_FILE, INDEX_FILE], message);
  return { kind: 'rebased', files: [...touched].sort() };
}
