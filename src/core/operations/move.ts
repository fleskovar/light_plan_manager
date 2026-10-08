import type { LoadedBoard } from '../board/load.js';
import { isTerminalStatus } from '../config/lookup.js';
import { BoardError } from '../errors.js';
import type { AnyNode, Issue } from '../model/types.js';
import { nowIso } from '../storage/document.js';
import { gitIdentity } from '../storage/git.js';
import { writeBoardIndex } from './board-index.js';
import type { AppliedFlagRollup, AppliedRollup } from './rollup.js';
import { propagateFlag, propagateStatus } from './rollup.js';
import {
  boardWrite,
  relocateFolder,
  requirePeriod,
  requireResource,
  requireStatus,
  requireSubtreeFits,
  requireUnchanged,
  resolveNewParent,
  setFlag,
  writeDocument,
} from './shared.js';

export interface MoveInput {
  /** Issues only. */
  status?: string;
  /**
   * Issues only: carry the new status up to the containers above it — a feature
   * whose last story is done is done. On by default, because a parent's status
   * is derived from its contents rather than typed by anybody; pass `false` to
   * set one issue's status and nothing else.
   *
   * @see src/shared/rollup.ts
   */
  rollUp?: boolean;
  /** New parent id, or `null` for the top level. Omit to keep the parent. */
  parentId?: string | null;
  /** Issues only: period id, or `null` to unschedule. Omit to keep it. */
  period?: string | null;
  /** Issues only: resource id or name, or `null` to unassign. Omit to keep it. */
  assignee?: string | null;
}

export interface MoveResult {
  node: AnyNode;
  statusChanged: boolean;
  periodChanged: boolean;
  assigneeChanged: boolean;
  /** The flag finishing the issue took off, when there was one. */
  flagCleared?: string;
  /** Set when the folder moved, as a board-relative path. */
  movedTo?: string;
  /** Containers this status change carried with it, nearest first. */
  rollups: AppliedRollup[];
  /**
   * Containers whose *flag* changed with it: finishing flagged work takes the
   * flag off, and the last flag out of a container takes its derived one off
   * too. @see src/shared/flag-rollup.ts
   */
  flagRollups: AppliedFlagRollup[];
}

export function moveNode(board: LoadedBoard, target: AnyNode, input: MoveInput): MoveResult {
  return boardWrite(board, `move ${target.id}`, () => moveUnderLock(board, target, input));
}

function moveUnderLock(board: LoadedBoard, target: AnyNode, input: MoveInput): MoveResult {
  const { config } = board;
  // Before anything is validated or moved: writing a status over somebody
  // else's claim is exactly the race this operation is at the sharp end of.
  requireUnchanged(board, target);
  const node: AnyNode = { ...target };
  let statusChanged = false;
  let periodChanged = false;
  let assigneeChanged = false;
  let flagCleared: string | undefined;

  if (input.status !== undefined) {
    if (node.kind !== 'issue') {
      throw new BoardError(`${node.id} is a ${node.type}; --status applies to issues only`);
    }
    requireStatus(board, input.status);
    statusChanged = input.status !== node.status;
    node.status = input.status;
    // Finishing the work answers the flag. Left on, it would paint the canvas
    // red for something nobody is doing. The activity section records the
    // auto-clear so the issue's own body is a self-contained record — the
    // comment `flagIssue` wrote is still in `_comments.md` alongside it.
    if (node.kind === 'issue' && node.flag && isTerminalStatus(config, input.status)) {
      flagCleared = node.flag;
      setFlag(node, null, {
        at: nowIso(),
        author: gitIdentity(board.paths.lpmDir) || 'unknown',
        heading: 'flag cleared — work finished',
      });
    }
  }

  if (input.period !== undefined) {
    if (node.kind !== 'issue') {
      throw new BoardError(`${node.id} is a ${node.type}; --period applies to issues only`);
    }
    const next = input.period === null ? null : requirePeriod(board, input.period).id;
    periodChanged = next !== node.period;
    node.period = next;
  }

  if (input.assignee !== undefined) {
    if (node.kind !== 'issue') {
      throw new BoardError(`${node.id} is a ${node.type}; --assignee applies to issues only`);
    }
    const next = input.assignee === null ? null : requireResource(board, input.assignee).id;
    assigneeChanged = next !== node.assignee;
    node.assignee = next;
  }

  let movedTo: string | undefined;

  if (input.parentId !== undefined) {
    const parent = resolveNewParent(board, node, input.parentId);
    const newDepth = parent ? parent.depth + 1 : 0;
    if (newDepth !== node.depth) requireSubtreeFits(board, target, newDepth);
    movedTo = relocateFolder(board, node, parent);
  }

  node.updated = nowIso();
  writeDocument(board, node);
  writeBoardIndex(board, { node, ...(movedTo ? { from: target.dir } : {}) });

  // After the write, so a container is never closed on the strength of a change
  // that failed to land. The board handle is stale by now — `propagateStatus`
  // is told the new status rather than reading it back.
  const rollups =
    statusChanged && node.kind === 'issue' && input.rollUp !== false
      ? propagateStatus(board, node, node.status)
      : [];

  // Finishing work can take flags off in two places — this issue, and any
  // container the status roll-up closed on the way up — and every one of them
  // may be the last stopped work inside something. The overlay carries all of
  // them, because the board handle has seen none of it.
  const cleared = new Map<string, string | null>();
  if (flagCleared) cleared.set(node.id, null);
  for (const rollup of rollups) {
    if (rollup.flagCleared) cleared.set(rollup.issue.id, null);
  }
  const flagRollups =
    cleared.size && node.kind === 'issue' && input.rollUp !== false
      ? propagateFlag(board, node, cleared)
      : [];

  return {
    node,
    statusChanged,
    periodChanged,
    assigneeChanged,
    flagCleared,
    movedTo,
    rollups,
    flagRollups,
  };
}

/** Kept for the common case; `moveNode` handles periods too. */
export function moveIssue(board: LoadedBoard, target: Issue, input: MoveInput): MoveResult {
  return moveNode(board, target, input);
}
