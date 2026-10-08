import type { LoadedBoard } from '../../board/load.js';
import { boardFlagRollups } from '../../board/flag-rollup.js';
import { boardRollups } from '../../board/rollup.js';
import { isTerminalStatus } from '../../config/lookup.js';
import type { Problem } from '../../model/types.js';
import { at } from '../shared.js';

/**
 * Containers whose status disagrees with the work inside them.
 *
 * `moveNode` keeps the two in step as work is done, so what this finds is a
 * board where that never ran: frontmatter edited by hand, a merge that took one
 * side of a status, or a board written before the roll-up existed. Every one of
 * them is fixable — the children are the evidence, and the parent is the copy.
 *
 * @see src/shared/rollup.ts for the rule.
 */
export function checkRollup(board: LoadedBoard, problems: Problem[]): void {
  for (const rollup of boardRollups(board)) {
    const closing = isTerminalStatus(board.config, rollup.to);
    problems.push({
      level: 'warn',
      path: at(board, rollup.issue),
      message: closing
        ? `is "${rollup.from}" but every issue inside it is finished; roll it up to "${rollup.to}"`
        : `is "${rollup.from}" but has open work inside it; reopen it as "${rollup.to}"`,
      fixable: true,
    });
  }
}

/**
 * Containers whose flag disagrees with the stopped work inside them.
 *
 * `flagIssue`, `clearFlag` and `moveNode` keep the two in step as flags are
 * raised and answered, so what this finds is the same set of cases the status
 * roll-up leaves behind: a hand edit, a merge, a board written before this
 * existed — and the two the operations deliberately do not chase, a deleted
 * subtree and an issue reparented out of the container its flag was standing
 * in for. Both need the board reloaded mid-operation, which core operations do
 * not do, so they are left here where one pass repairs them.
 *
 * @see src/shared/flag-rollup.ts for the rule.
 */
export function checkFlagRollup(board: LoadedBoard, problems: Problem[]): void {
  for (const rollup of boardFlagRollups(board)) {
    problems.push({
      level: 'warn',
      path: at(board, rollup.issue),
      message: rollup.to
        ? 'has stopped work inside it but carries no flag; roll it up'
        : 'is flagged for work inside it, but nothing inside it is stopped any more',
      fixable: true,
    });
  }
}
