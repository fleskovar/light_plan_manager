import type { LoadedBoard } from '../../board/load.js';
import type { Problem } from '../../model/types.js';
import { hasSquads } from '../../model/types.js';
import { displayPath } from '../../storage/paths.js';
import { at } from '../shared.js';

export function checkSquads(board: LoadedBoard, problems: Problem[]): void {
  if (board.squads.length && !hasSquads(board.config)) {
    problems.push({
      level: 'error',
      path: displayPath(board.paths, board.paths.squadsDir),
      message: 'squads contains documents but the config declares no squad_types',
    });
    return;
  }

  for (const squad of board.squads) {
    const where = at(board, squad);

    const seen = new Set<string>();
    for (const id of squad.members) {
      if (id === squad.id) {
        problems.push({ level: 'error', path: where, message: 'members lists itself', fixable: true });
        continue;
      }
      if (seen.has(id)) {
        problems.push({
          level: 'warn',
          path: where,
          message: `members lists "${id}" more than once`,
          fixable: true,
        });
        continue;
      }
      seen.add(id);

      const target = board.resourcesById.get(id);
      if (!target) {
        problems.push({
          level: 'error',
          path: where,
          message: `members lists "${id}", which is not in the team roster`,
        });
      }
    }
  }
}
