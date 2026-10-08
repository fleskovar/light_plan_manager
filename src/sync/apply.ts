import type { BoardPaths } from '../core/index.js';
import { BoardError, removeNode, withBoardWrite } from '../core/index.js';
import type { BoardSnapshot, Change, NodePatch, PushFailure } from '../shared/index.js';
import { compactChanges, isTempId, patchReferences } from '../shared/index.js';
import { toSnapshot } from './dto.js';
import { applyPatch, createNode } from './patch.js';
import { PushSession } from './session.js';

export interface PushResult {
  /** Temporary id -> allocated id, for every document this push created. */
  idMap: Record<string, string>;
  /** Ids of the changes that reached disk. The client drops these. */
  applied: string[];
  /** Changes that were rejected. The client keeps these pending. */
  failures: PushFailure[];
  /** The board as it stands after the push. */
  board: BoardSnapshot;
}

/** The temporary ids this push allocates, so a reference to one can wait for it. */
function allocations(changes: Change[]): Set<string> {
  const ids = new Set<string>();
  for (const change of changes) {
    if (change.kind === 'create' && isTempId(change.id)) ids.add(change.id);
  }
  return ids;
}

/**
 * The references that decide whether a change can run yet.
 *
 * An update waits for any of them. A create waits only for its parent, because
 * `createNode` writes the document without the links, the period and the
 * assignee it cannot resolve and replays those at the end — so holding the
 * create back would reorder id allocation to no purpose.
 */
function blockers(change: Change): string[] {
  if (change.kind === 'delete') return [];
  if (change.kind === 'create') {
    return typeof change.patch.parentId === 'string' ? [change.patch.parentId] : [];
  }
  return patchReferences(change.patch);
}

/**
 * True when a change points at a document this push has not created yet.
 *
 * The queue is not in dependency order and cannot be made to be: merging an
 * edit into an earlier pending one is what keeps a dragged slider to a single
 * change, and that merge can carry a reference backwards past the create that
 * allocates it. So the reference decides the order, not the position.
 */
function awaitsCreate(session: PushSession, change: Change, upcoming: Set<string>): boolean {
  return blockers(change).some((id) => upcoming.has(id) && session.unresolved(id));
}

/**
 * Replay a view's pending changes onto the board.
 *
 * A failing change does not abort the push: everything before it is already on
 * disk, and the changes after it are usually unrelated. So each one is tried,
 * and the caller is told exactly which survived — the client keeps those as
 * still-pending and shows the errors.
 */
export function applyChanges(paths: BoardPaths, changes: Change[]): PushResult {
  // The whole push, not one change at a time. A push is somebody's draft of the
  // plan replayed in order — a create whose links land three changes later, a
  // sprint the next four issues are scheduled into — and letting an agent claim
  // work from the middle of that would show it a board nobody ever intended.
  // The operations inside take the same lock and find it already theirs.
  // On a board shared through git it is also one commit: the whole draft is
  // pushed to the remote, or refused, as the unit it was written as.
  return withBoardWrite(paths, `push ${changes.length} change(s)`, () => push(paths, changes));
}

function push(paths: BoardPaths, changes: Change[]): PushResult {
  const session = new PushSession(paths);
  const applied: string[] = [];
  const failures: PushFailure[] = [];
  /** Links held back because they pointed at something created later. */
  const deferredLinks: { id: string; nodeKind: Change['nodeKind']; patch: NodePatch }[] = [];

  const fail = (id: string, error: unknown): void => {
    failures.push({
      id,
      error: error instanceof Error ? error.message : String(error),
      details: error instanceof BoardError ? error.details : undefined,
    });
    session.reload();
  };

  const run = (change: Change): void => {
    switch (change.kind) {
      case 'create': {
        const created = createNode(session, change.nodeKind, change.patch);
        session.record(change.id, created.node.id);
        if (created.deferred) {
          deferredLinks.push({ id: change.id, nodeKind: change.nodeKind, patch: created.deferred });
        }
        session.reload();
        break;
      }
      case 'update':
        applyPatch(session, change.nodeKind, change.id, change.patch);
        break;
      case 'delete': {
        // A view can outlive the document it points at; deleting something
        // already gone is what the user asked for, not a failure.
        if (session.exists(change.id)) {
          removeNode(session.board, session.require(change.nodeKind, change.id));
          session.reload();
        }
        break;
      }
    }
    applied.push(change.id);
  };

  const queue = compactChanges(changes);
  const upcoming = allocations(queue);
  /** Changes whose turn has not come, in the order they were queued. */
  const held: Change[] = [];

  for (const change of queue) {
    if (awaitsCreate(session, change, upcoming)) {
      held.push(change);
      continue;
    }
    try {
      run(change);
    } catch (error) {
      fail(change.id, error);
    }
  }

  // Everything the push creates exists by now, so the references resolve. One
  // held change still naming an unallocated id was waiting on a create that
  // failed. Running it anyway would fail deep in core with "no document with id
  // new:2" — which reads as a board problem and, repeated once per issue that
  // was scheduled into the new sprint, buries the one error that actually
  // happened. So it is reported against the create it was waiting for.
  for (const change of held) {
    const missing = blockers(change).filter((id) => upcoming.has(id) && session.unresolved(id));
    if (missing.length) {
      failures.push({
        id: change.id,
        error: `Waiting on ${missing.join(', ')}, which ${missing.length === 1 ? 'was' : 'were'} not created`,
        details: ['Fix the error reported against it, then push again.'],
      });
      continue;
    }
    try {
      run(change);
    } catch (error) {
      fail(change.id, error);
    }
  }

  for (const entry of deferredLinks) {
    try {
      applyPatch(session, entry.nodeKind, entry.id, entry.patch);
    } catch (error) {
      fail(entry.id, error);
    }
  }

  return { idMap: session.idMap, applied, failures, board: toSnapshot(session.board) };
}
