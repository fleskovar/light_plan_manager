/**
 * The pull applier — the pull-side mirror of the push executor (LP-490,
 * `execute.ts`).
 *
 * A pull is planned by `planPull` as a `PullPlan` (`Change[]` plus link-store
 * effects) and applied here in two steps:
 *
 *   1. the `Change[]` is handed to `applyChanges` from `src/sync` — the one
 *      applier every front end pushes a view through, so a pull inherits
 *      partial application, temporary-id remapping and the hold-back-and-replay
 *      of a create whose parent is created later in the same push;
 *   2. the link store is updated to match what actually landed: a `record`
 *      whose create reached disk is written, an `unlink` is applied — except
 *      when the `delete` change it accompanied failed, so the next pull retries
 *      the deletion rather than silently dropping the correspondence.
 *
 * `applyChanges` already reports the failures (`PushResult.failures`); the only
 * new code here is the correspondence bookkeeping, because the link store is
 * the remote layer's own state and no core operation writes it.
 */

import type { BoardPaths } from '../core/index.js';
import { appendComment, loadBoard, readComments } from '../core/index.js';
import type { BoardSnapshot, PushFailure } from '../shared/index.js';
import { applyChanges } from '../sync/apply.js';
import { decoupleLink, removeLink, saveLinkStore, setCommentId, setLink } from './links.js';
import type { LinkStore } from './links.js';
import type { PullPlan } from './plan.js';

/** What a pull landed: the sync result plus the correspondence it recorded. */
export interface PullResult {
  /** Ids of the changes that reached disk (temporary ids for creates). */
  applied: string[];
  /** Changes rejected, with reasons. The caller reports these. */
  failures: PushFailure[];
  /** Real local ids newly linked to their remote twin. */
  linked: string[];
  /** Local ids whose link was dropped (the twin is gone upstream). */
  unlinked: string[];
  /** Local ids decoupled with a tombstone, so the next push never re-files them. */
  decoupled: string[];
  /** How many remote comments were appended to `_comments.md` (LP-316). */
  appendedComments: number;
  /** The board as it stands after the pull. */
  board: BoardSnapshot;
}

/**
 * Apply a pull plan onto the board and the link store.
 *
 * Mutates `store` in place and writes it back to
 * `.lpm/remotes/<remoteName>/links.json`.  A partial pull is deliberate and
 * mirrors a partial push: what landed is recorded, what failed is reported and
 * left for the next pull.  A `record` whose create failed is skipped (there is
 * no real id to link); an `unlink` naming a failed `delete` is skipped too, so
 * a deletion that did not land is retried rather than forgotten.
 */
export function applyPull(
  paths: BoardPaths,
  remoteName: string,
  store: LinkStore,
  plan: PullPlan,
): PullResult {
  const result = applyChanges(paths, plan.changes);

  const failed = new Set(result.failures.map((failure) => failure.id));
  const linked: string[] = [];
  const unlinked: string[] = [];
  const decoupled: string[] = [];

  for (const op of plan.links) {
    if (op.kind === 'record') {
      const realId = result.idMap[op.tempId];
      if (!realId) continue; // the create did not land — nothing to link
      setLink(store, realId, {
        remoteId: op.remoteId,
        remoteKey: op.remoteId,
        remoteUrl: '',
        syncedAt: new Date().toISOString(),
        remoteRev: '',
      });
      linked.push(realId);
      continue;
    }

    // `decouple`: drop the link and record a tombstone, so the next push never
    // re-files the document (LP-365).  When the same local id was also a change
    // (a `close` status move) that failed, keep the link so the next pull
    // retries rather than silently decoupling a document it could not close.
    if (op.kind === 'decouple') {
      if (failed.has(op.localId)) continue;
      decoupleLink(store, op.localId, op.reason, new Date().toISOString());
      decoupled.push(op.localId);
      continue;
    }

    // `unlink`: drop the correspondence.  When the same local id was also a
    // `delete` change that failed, keep the link so the next pull retries the
    // deletion; otherwise the twin is gone and the link must go with it.
    if (failed.has(op.localId)) continue;
    if (removeLink(store, op.localId)) unlinked.push(op.localId);
  }

  // -- user comments (LP-316) -------------------------------------------------
  // Append the remote comments the planner selected to `_comments.md`, straight
  // through (comments are not board state and never ride the change protocol).
  // A temp target resolves through `idMap` exactly like a `record` op; the
  // recorded id makes the next pull skip the comment, so nothing is ever
  // appended twice.  The log stays append-only: an edited or deleted remote
  // comment is never rewritten here.
  let appendedComments = 0;
  if (plan.comments && plan.comments.length > 0) {
    const board = loadBoard(paths);
    /** Next 1-based index per document dir, seeded from what is already there. */
    const nextIndex = new Map<string, number>();
    const indexFor = (dir: string): number => {
      let next = nextIndex.get(dir);
      if (next === undefined) {
        next = readComments(dir).length + 1;
      }
      nextIndex.set(dir, next + 1);
      return next;
    };

    for (const op of plan.comments) {
      const realId = result.idMap[op.targetId] ?? op.targetId;
      const node = board.byId.get(realId);
      if (!node) continue; // the create did not land — nothing to append to
      const index = indexFor(node.dir);
      appendComment(node.dir, { at: op.at, author: op.author, body: op.body });
      setCommentId(store, realId, index, op.remoteId);
      appendedComments += 1;
    }
  }

  saveLinkStore(paths, remoteName, store);

  return {
    applied: result.applied,
    failures: result.failures,
    linked,
    unlinked,
    decoupled,
    appendedComments,
    board: result.board,
  };
}
