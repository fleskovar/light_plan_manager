import type { LoadedBoard } from '../../board/load.js';
import { DEFAULT_CAPACITY } from '../../board/load.js';
import { isGenericType, isTerminalStatus } from '../../config/lookup.js';
import type { Problem } from '../../model/types.js';
import { hasResources } from '../../model/types.js';
import { displayPath } from '../../storage/paths.js';
import { at } from '../shared.js';

export function checkResources(board: LoadedBoard, problems: Problem[]): void {
  if (board.resources.length && !hasResources(board.config)) {
    problems.push({
      level: 'error',
      path: displayPath(board.paths, board.paths.teamDir),
      message: 'team contains documents but the config declares no resource_types',
    });
    return;
  }

  for (const resource of board.resources) {
    const where = at(board, resource);

    if ((board.derived.get(resource.dir) ?? []).includes('capacity')) {
      problems.push({
        level: 'warn',
        path: where,
        message: `missing capacity (assuming ${DEFAULT_CAPACITY})`,
        fixable: true,
      });
    } else if (resource.capacity < 0) {
      problems.push({
        level: 'error',
        path: where,
        message: `capacity ${resource.capacity} is negative; use 0 for someone unavailable`,
      });
    }

    const seen = new Set<string>();
    for (const id of resource.covers) {
      if (id === resource.id) {
        problems.push({ level: 'error', path: where, message: 'covers itself', fixable: true });
        continue;
      }
      if (seen.has(id)) {
        problems.push({
          level: 'warn',
          path: where,
          message: `covers lists "${id}" more than once`,
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
          message: `covers "${id}", which is not in the team roster`,
        });
      } else if (!isGenericType(board.config, target.type)) {
        problems.push({
          level: 'error',
          path: where,
          message: `covers ${target.id} (${target.title}), which is a named resource, not a pool`,
        });
      }
    }

    // Work parked in a pool nobody can serve will never be picked up.
    if (isGenericType(board.config, resource.type) && !(board.coveredBy.get(resource.id) ?? []).length) {
      const open = board.issues.filter(
        (issue) => issue.assignee === resource.id && !isTerminalStatus(board.config, issue.status),
      );
      if (open.length) {
        problems.push({
          level: 'warn',
          path: where,
          message: `holds ${open.length} open issue${open.length === 1 ? '' : 's'} but no one covers it`,
        });
      }
    }
  }
}
