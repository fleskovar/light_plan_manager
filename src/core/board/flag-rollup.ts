import type { Issue } from '../model/types.js';
import type { FlagLookup, FlagRollup } from '../../shared/flag-rollup.js';
import { flagRollupsAcross, flagRollupsUpward } from '../../shared/flag-rollup.js';
import type { LoadedBoard } from './load.js';

/**
 * Reading a board for the flag roll-up: which containers disagree with the
 * stopped work inside them.
 *
 * Read-only, like the rest of `board/`. `operations/rollup.ts` is what writes
 * the answer, and `validation/checks/rollup.ts` is what reports it — the same
 * three-file shape the status roll-up has, for the same reason.
 *
 * @see src/shared/flag-rollup.ts for the rule itself and why it is that way.
 */

/** An ancestor that has to change, resolved to the document a caller can write. */
export interface IssueFlagRollup {
  issue: Issue;
  from: string | null;
  to: string | null;
}

/**
 * Adapt a `LoadedBoard` to the id-based lookup `src/shared/flag-rollup.ts` reads.
 *
 * The overlay carries flags that are true on disk but not on the handle: core
 * operations write straight through, so the issue `flagIssue` just flagged is
 * still unflagged in memory, and so is every ancestor a status roll-up has just
 * taken a flag off. Anything not named in it is read off the board.
 */
function flagLookupFor(board: LoadedBoard, flags: Map<string, string | null>): FlagLookup {
  const children = new Map<string, string[]>();
  for (const issue of board.issues) {
    if (!issue.parentId) continue;
    const list = children.get(issue.parentId);
    if (list) list.push(issue.id);
    else children.set(issue.parentId, [issue.id]);
  }

  return {
    parentOf: (id) => board.byId.get(id)?.parentId ?? null,
    childIdsOf: (id) => children.get(id) ?? [],
    flagOf: (id) => (flags.has(id) ? flags.get(id)! : (board.byId.get(id)?.flag ?? null)),
  };
}

function resolve(board: LoadedBoard, rollups: FlagRollup[]): IssueFlagRollup[] {
  const out: IssueFlagRollup[] = [];
  for (const rollup of rollups) {
    const issue = board.byId.get(rollup.id);
    if (issue) out.push({ issue, from: rollup.from, to: rollup.to });
  }
  return out;
}

/**
 * The ancestors of `from` that a flag change carries with it, nearest first.
 *
 * `flags` names every id whose flag has just been written, `from` included —
 * a single `flagIssue` is one entry, and finishing a subtree can be several,
 * because closing a parent takes its flag off too.
 */
export function flagRollupsFor(
  board: LoadedBoard,
  from: string,
  flags: Map<string, string | null>,
): IssueFlagRollup[] {
  return resolve(board, flagRollupsUpward(from, flagLookupFor(board, flags)));
}

/**
 * Every container on the board whose flag disagrees with what is inside it.
 *
 * Deepest first, so one pass carries a flagged story up through its feature to
 * the epic above it, and the list can be written in the order it is returned.
 */
export function boardFlagRollups(board: LoadedBoard): IssueFlagRollup[] {
  const ids = [...board.issues].sort((a, b) => b.depth - a.depth).map((issue) => issue.id);
  return resolve(board, flagRollupsAcross(ids, flagLookupFor(board, new Map())));
}
