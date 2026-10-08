import { statusRulesFor } from '../config/lookup.js';
import type { Issue } from '../model/types.js';
import type { RollupLookup, StatusRollup } from '../../shared/rollup.js';
import { rollupsAcross, rollupsUpward } from '../../shared/rollup.js';
import type { LoadedBoard } from './load.js';

/**
 * Reading a board for the status roll-up: which parents disagree with the work
 * inside them.
 *
 * Read-only, like the rest of `board/`. `operations/rollup.ts` is what writes
 * the answer, and `validation/checks/rollup.ts` is what reports it.
 *
 * @see src/shared/rollup.ts for the rule itself and why it is that way.
 */

/** An ancestor that has to move, resolved to the document a caller can write. */
export interface IssueRollup {
  issue: Issue;
  from: string;
  to: string;
}

/**
 * Adapt a `LoadedBoard` to the id-based lookup `src/shared/rollup.ts` reads.
 *
 * Both overlays carry facts that are true but not yet on the board handle: core
 * operations write straight to disk, so the issue `moveNode` just closed is
 * still open in memory, one it reparented in the same call still sits where it
 * was, and one `createIssue` just wrote is not there at all. Anything not named
 * in an overlay is read off the board.
 */
function rollupLookupFor(
  board: LoadedBoard,
  status: Map<string, string>,
  parent: Map<string, string | null>,
): RollupLookup {
  // `has`, not `??`: a node moved to the top level has a parent of `null`, and
  // that is an answer rather than a miss.
  const parentOf = (id: string): string | null =>
    parent.has(id) ? parent.get(id)! : (board.byId.get(id)?.parentId ?? null);

  // The overlay's own ids as well, so an issue written a moment ago counts
  // among its parent's contents even though the handle has never seen it.
  const ids = [...board.issues.map((issue) => issue.id), ...parent.keys()];
  const children = new Map<string, string[]>();
  for (const id of new Set(ids)) {
    const above = parentOf(id);
    if (!above) continue;
    const list = children.get(above);
    if (list) list.push(id);
    else children.set(above, [id]);
  }

  return {
    parentOf,
    childIdsOf: (id) => children.get(id) ?? [],
    statusOf: (id) => status.get(id) ?? board.byId.get(id)?.status ?? '',
  };
}

function resolve(board: LoadedBoard, rollups: StatusRollup[]): IssueRollup[] {
  const out: IssueRollup[] = [];
  for (const rollup of rollups) {
    const issue = board.byId.get(rollup.id);
    if (issue) out.push({ issue, from: rollup.from, to: rollup.to });
  }
  return out;
}

/**
 * The ancestors of `issue` that its new status carries with it, nearest first.
 *
 * `issue` is the document as it now stands and `status` the status it now
 * holds — pass both, because the board handle still shows what was there before
 * the operation wrote, including the parent it sat under.
 */
export function rollupsFor(board: LoadedBoard, issue: Issue, status: string): IssueRollup[] {
  return resolve(
    board,
    rollupsUpward(
      issue.id,
      rollupLookupFor(
        board,
        new Map([[issue.id, status]]),
        new Map([[issue.id, issue.parentId]]),
      ),
      statusRulesFor(board.config),
    ),
  );
}

/**
 * Every parent on the board whose status disagrees with what is inside it.
 *
 * Deepest first, so one pass carries a closed story up through its feature to
 * the epic above it, and the list can be written in the order it is returned.
 */
export function boardRollups(board: LoadedBoard): IssueRollup[] {
  const ids = [...board.issues]
    .sort((a, b) => b.depth - a.depth)
    .map((issue) => issue.id);
  return resolve(
    board,
    rollupsAcross(
      ids,
      rollupLookupFor(board, new Map(), new Map()),
      statusRulesFor(board.config),
    ),
  );
}
