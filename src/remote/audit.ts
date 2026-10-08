/**
 * The sync audit log (LP-352) — one JSONL line per sync run, under
 * `.lpm/remotes/<name>/log.jsonl`.
 *
 * A sync is the first thing light-plan does that is visible to people who did
 * not run it, so "who filed all these" must have an answer that takes a minute
 * rather than a support ticket. Every applied sync appends one line recording
 * when it ran, who drove it, which remote, the operation counts and the
 * per-operation outcomes (what landed, what failed, and why). A run that threw
 * mid-flight appends a line whose `error` carries the reason, so a failure is
 * never silent either.
 *
 * ## Shape
 *
 * The file is append-only and line-delimited, exactly like `_comments.md`:
 * appends merge, structured lists do not. Two people syncing one checkout, or
 * a git merge, both leave a file that is still a sequence of valid lines — a
 * reader only ever appends or skips, never rewrites. Secrets never reach a
 * line: the entry is redacted against the resolved credentials before it is
 * written (`redact.ts`).
 *
 * The log is a record, not a mechanism: nothing in the sync reads it back.
 * `lpm remote log` renders it; the sync itself never consults it. A sibling
 * `audit.log` (in `resolutions.ts`) is the same idea for the *decisions* a
 * person records, rather than the syncs that apply them.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { LoadedBoard } from '../core/board/load.js';
import { currentUser } from '../core/operations/user.js';
import type { BoardPaths } from '../core/storage/paths.js';
import { redactValue } from './redact.js';
import type { RunSyncResult } from './sync.js';

/** Which direction a run went. */
export type SyncDirection = 'push' | 'pull' | 'both';

/** One per-operation outcome: what a single op did, and why. */
export interface SyncAuditOperation {
  /** The op's kind: `create`, `update`, `close`, `link`, `conflict`, … */
  kind: string;
  /** The board document the op acts on. */
  localId: string;
  /** `landed`, `failed`, `conflicted` or `skipped`. */
  status: 'landed' | 'failed' | 'conflicted' | 'skipped';
  /** The twin's remote id, on a landed op that resolved or wrote one. */
  remoteId?: string;
  /** Why the op failed or conflicted. */
  error?: string;
  /** Why a skipped op was never attempted. */
  reason?: string;
}

/** The operation counts one entry records, across both directions. */
export interface SyncAuditCounts {
  created: number;
  updated: number;
  skipped: number;
  conflicted: number;
  failed: number;
  /** Pull-side changes that reached disk. */
  pulled: number;
  linked: number;
  unlinked: number;
  decoupled: number;
}

/** One line of the audit log: a sync run, as it finished. */
export interface SyncAuditEntry {
  /** ISO timestamp. */
  at: string;
  /** Whoever `lpm me` / the environment said was driving. */
  author: string;
  /** The remote's name. */
  remote: string;
  /** The direction the run went. */
  direction: SyncDirection;
  /** Operation counts, aggregated across both sides. */
  counts: SyncAuditCounts;
  /** Per-operation outcomes: what landed, failed, conflicted and skipped. */
  operations: SyncAuditOperation[];
  /** Why the run itself did not complete — a refusal, preflight block, unreachable remote, or a throw. */
  error?: string;
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

/** The path to one remote's append-only sync log. */
export function syncAuditPath(paths: BoardPaths, remoteName: string): string {
  return path.join(paths.remotesDir, remoteName, 'log.jsonl');
}

/**
 * Append one sync to the audit log, creating the file on first use.  The log
 * is append-only and line-delimited: one JSON object per line, nothing ever
 * rewritten, so concurrent appends and git merges both leave a readable file.
 */
export function appendSyncAudit(
  paths: BoardPaths,
  remoteName: string,
  entry: SyncAuditEntry,
): void {
  const file = syncAuditPath(paths, remoteName);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
}

/**
 * Read a remote's sync log back, oldest first.  A missing file is an empty
 * log.  A line that does not parse is skipped rather than thrown — the file
 * survives a git merge, and one bad line must not hide the rest of the trail.
 */
export function readSyncAudit(paths: BoardPaths, remoteName: string): SyncAuditEntry[] {
  let raw: string;
  try {
    raw = readFileSync(syncAuditPath(paths, remoteName), 'utf8');
  } catch {
    return [];
  }

  const entries: SyncAuditEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed = JSON.parse(trimmed) as SyncAuditEntry;
      if (parsed && typeof parsed === 'object' && typeof parsed.at === 'string') {
        entries.push(parsed);
      }
    } catch {
      // A malformed line (a manual edit, a merge artefact) is skipped; the
      // rest of the log still answers "who filed these".
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Building an entry
// ---------------------------------------------------------------------------

/** The zeroed counts a failure entry starts from. */
function emptyCounts(): SyncAuditCounts {
  return { created: 0, updated: 0, skipped: 0, conflicted: 0, failed: 0, pulled: 0, linked: 0, unlinked: 0, decoupled: 0 };
}

/** An error message from any thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build the un-redacted entry for one finished run.  Pure: reads only the
 * result and the board's identity, writes nothing.
 */
export function buildSyncAuditEntry(
  board: LoadedBoard,
  result: RunSyncResult,
  at: string,
): SyncAuditEntry {
  const counts = emptyCounts();
  const operations: SyncAuditOperation[] = [];

  if (result.pushResult !== undefined) {
    counts.created = result.pushResult.summary.created;
    counts.updated = result.pushResult.summary.updated;
    counts.skipped = result.pushResult.summary.skipped;
    counts.conflicted = result.pushResult.summary.conflicted;
    counts.failed = result.pushResult.summary.failed;

    for (const op of result.pushResult.landed) {
      operations.push({
        kind: op.kind,
        localId: op.localId,
        status: 'landed',
        ...(op.remoteId !== undefined ? { remoteId: op.remoteId } : {}),
      });
    }
    for (const op of result.pushResult.failed) {
      operations.push({ kind: op.kind, localId: op.localId, status: 'failed', error: op.error });
    }
    for (const op of result.pushResult.conflicted) {
      operations.push({ kind: op.kind, localId: op.localId, status: 'conflicted', error: op.error });
    }
    for (const op of result.pushResult.skipped) {
      operations.push({ kind: op.kind, localId: op.localId, status: 'skipped', reason: op.reason });
    }
  }

  if (result.pullResult !== undefined) {
    counts.pulled = result.pullResult.applied.length;
    counts.linked = result.pullResult.linked.length;
    counts.unlinked = result.pullResult.unlinked.length;
    counts.decoupled = result.pullResult.decoupled.length;
    for (const failure of result.pullResult.failures) {
      operations.push({ kind: 'pull', localId: failure.id, status: 'failed', error: failure.error });
      counts.failed += 1;
    }
  }

  // The pull's unresolved conflicts are per-document outcomes too — the two
  // sides did not converge, which is the same signal a failure carries.
  if (result.pullPlan !== undefined) {
    for (const conflict of result.pullPlan.conflicts ?? []) {
      operations.push({ kind: 'conflict', localId: conflict.localId, status: 'conflicted', error: conflict.reason });
      counts.conflicted += 1;
    }
    for (const conflict of result.pullPlan.fieldConflicts ?? []) {
      operations.push({ kind: 'field_conflict', localId: conflict.localId, status: 'conflicted', error: conflict.field });
      counts.conflicted += 1;
    }
  }

  let error: string | undefined;
  if (result.consentRefused !== undefined) {
    error = `refused: ${result.consentRefused.reason} (${result.consentRefused.target})`;
  } else if (result.preflightBlocked) {
    error = 'preflight blocked';
  } else if (result.unreachable !== undefined) {
    error = `unreachable: ${result.unreachable}`;
  } else if (
    result.pushResult?.stopped !== undefined &&
    result.pushResult.stopped.reason !== 'limit'
  ) {
    // A run stopped by a budget or an abort did not finish — its reason is the
    // run's error. A `--limit` stop is not: the run did everything it was
    // allowed to do, and the counts already say how much landed.
    error = `${result.pushResult.stopped.reason}: ${result.pushResult.stopped.detail}`;
  }

  return {
    at,
    author: currentUser(board)?.ref ?? 'unknown',
    remote: result.remoteName,
    direction: result.direction,
    counts,
    operations,
    ...(error !== undefined ? { error } : {}),
  };
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * Record one finished sync.  The entry is redacted against the resolved
 * credentials before it is written, so a secret in an error message — a URL
 * carrying a token, say — never reaches the committed log.
 *
 * The write is best-effort: a sync that succeeded must stay succeeded even if
 * its record could not be written (a read-only filesystem, a full disk). The
 * record is the trail, not the outcome.
 */
export function recordSyncAudit(
  board: LoadedBoard,
  result: RunSyncResult,
  secrets: readonly string[],
  at: string = new Date().toISOString(),
): void {
  const entry = redactValue(buildSyncAuditEntry(board, result, at), secrets) as SyncAuditEntry;
  try {
    appendSyncAudit(board.paths, result.remoteName, entry);
  } catch {
    // The sync already landed; a record that cannot be written must not undo
    // or mis-report it. The original error, if any, still reaches the caller.
  }
}

/**
 * Record a run that threw before it produced a result.  The reason is the
 * error message, redacted; the counts are zero and the operations empty.
 * Best-effort, like `recordSyncAudit` — the caller still re-throws the
 * original error whether or not this line could be written.
 */
export function recordSyncFailure(
  board: LoadedBoard,
  remoteName: string,
  direction: SyncDirection,
  error: unknown,
  secrets: readonly string[],
  at: string = new Date().toISOString(),
): void {
  const entry: SyncAuditEntry = redactValue(
    {
      at,
      author: currentUser(board)?.ref ?? 'unknown',
      remote: remoteName,
      direction,
      counts: emptyCounts(),
      operations: [],
      error: messageOf(error),
    },
    secrets,
  ) as SyncAuditEntry;
  try {
    appendSyncAudit(board.paths, remoteName, entry);
  } catch {
    // Best-effort: the caller re-throws the original error regardless.
  }
}
