import type { LoadedBoard } from '../../board/load.js';
import { nodesOf } from '../../board/query.js';
import { prefixFor } from '../../config/lookup.js';
import type { Problem } from '../../model/types.js';
import { displayPath } from '../../storage/paths.js';
import { counterFor, numberOf, readState } from '../../storage/state.js';
import { KINDS } from '../shared.js';

export function checkCounters(board: LoadedBoard, problems: Problem[]): void {
  const state = readState(board.paths);
  for (const kind of KINDS) {
    const prefix = prefixFor(board.config, kind);
    if (!prefix) continue;
    const highest = nodesOf(board, kind).reduce(
      (max, node) => Math.max(max, numberOf(node.id, prefix)),
      0,
    );
    if (state[counterFor(kind)] < highest) {
      problems.push({
        level: 'warn',
        path: displayPath(board.paths, board.paths.statePath),
        message: `${kind} id counter is behind the board (highest is ${prefix}-${highest})`,
        fixable: true,
      });
    }
  }
}
