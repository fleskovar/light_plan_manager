import { rmSync } from 'node:fs';
import type { LoadedBoard } from '../board/load.js';
import { nodesOf, subtreeOf } from '../board/query.js';
import type { AnyNode } from '../model/types.js';
import { nowIso } from '../storage/document.js';
import { displayPath } from '../storage/paths.js';
import { writeBoardIndex } from './board-index.js';
import { boardWrite, requireUnchanged, writeDocument } from './shared.js';

export interface RemoveResult {
  /** Ids that were deleted: the target plus every descendant. */
  removed: string[];
  /** Board-relative path of the folder that was deleted. */
  path: string;
  /** Ids of documents rewritten because they referenced something removed. */
  detached: string[];
}

/** Drop every removed id from a stored list, or return null when nothing changed. */
function without(list: string[], removed: Set<string>): string[] | null {
  const kept = list.filter((id) => !removed.has(id));
  return kept.length === list.length ? null : kept;
}

/**
 * Delete a document and everything nested under it.
 *
 * Deleting is not just an `rm`: only forward edges are stored, so any document
 * that pointed *at* the deleted subtree has to be rewritten, otherwise the board
 * is left with dangling references for `check` to complain about.
 */
export function removeNode(board: LoadedBoard, target: AnyNode): RemoveResult {
  return boardWrite(board, `delete ${target.id}`, () => removeUnderLock(board, target));
}

function removeUnderLock(board: LoadedBoard, target: AnyNode): RemoveResult {
  // Deleting is irreversible and rewrites every document that pointed into the
  // subtree, so it is the one operation where a stale handle costs the most.
  requireUnchanged(board, target);
  const doomed = subtreeOf(nodesOf(board, target.kind), target);
  const removed = new Set(doomed.map((node) => node.id));
  const removedDirs = new Set(doomed.map((node) => node.dir));

  rmSync(target.dir, { recursive: true, force: true });

  const detached: string[] = [];
  const rewrite = (node: AnyNode, mutate: (draft: AnyNode) => boolean): void => {
    if (removedDirs.has(node.dir)) return;
    const draft: AnyNode = { ...node };
    if (!mutate(draft)) return;
    draft.updated = nowIso();
    writeDocument(board, draft);
    detached.push(draft.id);
  };

  for (const issue of board.issues) {
    rewrite(issue, (draft) => {
      if (draft.kind !== 'issue') return false;
      let changed = false;
      const dependsOn = without(draft.depends_on, removed);
      if (dependsOn) {
        draft.depends_on = dependsOn;
        changed = true;
      }
      const relatesTo = without(draft.relates_to, removed);
      if (relatesTo) {
        draft.relates_to = relatesTo;
        changed = true;
      }
      if (draft.assignee && removed.has(draft.assignee)) {
        draft.assignee = null;
        changed = true;
      }
      if (draft.period && removed.has(draft.period)) {
        draft.period = null;
        changed = true;
      }
      return changed;
    });
  }

  for (const resource of board.resources) {
    rewrite(resource, (draft) => {
      if (draft.kind !== 'resource') return false;
      const covers = without(draft.covers, removed);
      if (!covers) return false;
      draft.covers = covers;
      return true;
    });
  }

  for (const squad of board.squads) {
    rewrite(squad, (draft) => {
      if (draft.kind !== 'squad') return false;
      const members = without(draft.members, removed);
      if (!members) return false;
      draft.members = members;
      return true;
    });
  }

  for (const template of board.templates) {
    rewrite(template, (draft) => {
      if (draft.kind !== 'template') return false;
      let changed = false;
      const dependsOn = without(draft.depends_on, removed);
      if (dependsOn) {
        draft.depends_on = dependsOn;
        changed = true;
      }
      const relatesTo = without(draft.relates_to, removed);
      if (relatesTo) {
        draft.relates_to = relatesTo;
        changed = true;
      }
      return changed;
    });
  }

  writeBoardIndex(board, { node: target, removed: true });

  return {
    removed: doomed.map((node) => node.id),
    path: displayPath(board.paths, target.dir),
    detached,
  };
}
