import type { LoadedBoard } from '../../board/load.js';
import { isCalendarDate } from '../../model/attributes.js';
import type { Period, Problem } from '../../model/types.js';
import { hasPeriods } from '../../model/types.js';
import { displayPath } from '../../storage/paths.js';
import { at } from '../shared.js';

export function checkPeriods(board: LoadedBoard, problems: Problem[]): void {
  if (board.periods.length && !hasPeriods(board.config)) {
    problems.push({
      level: 'error',
      path: displayPath(board.paths, board.paths.timelineDir),
      message: 'timeline contains documents but the config declares no period_types',
    });
    return;
  }

  for (const period of board.periods) {
    const where = at(board, period);

    for (const field of ['starts', 'ends'] as const) {
      const value = period[field];
      if (!value) {
        problems.push({ level: 'error', path: where, message: `missing ${field} date` });
      } else if (!isCalendarDate(value)) {
        problems.push({
          level: 'error',
          path: where,
          message: `${field} "${value}" is not a valid YYYY-MM-DD date`,
        });
      }
    }

    if (
      period.starts &&
      period.ends &&
      isCalendarDate(period.starts) &&
      isCalendarDate(period.ends)
    ) {
      if (period.ends < period.starts) {
        problems.push({
          level: 'error',
          path: where,
          message: `ends (${period.ends}) is before starts (${period.starts})`,
        });
      }
      const parent = period.parentId ? board.periodsById.get(period.parentId) : null;
      if (
        parent?.starts &&
        parent.ends &&
        (period.starts < parent.starts || period.ends > parent.ends)
      ) {
        problems.push({
          level: 'warn',
          path: where,
          message: `${period.starts}..${period.ends} falls outside ${parent.id} (${parent.starts}..${parent.ends})`,
        });
      }
    }

    if (period.squad) {
      const squad = board.squadsById.get(period.squad);
      if (!squad) {
        problems.push({
          level: 'error',
          path: where,
          message: `squad "${period.squad}" is not in the squad roster`,
        });
      }
    }
  }

  // Sibling periods that overlap in time usually mean a typo in a date.
  const groups = new Map<string, Period[]>();
  for (const period of board.periods) {
    const key = period.parentId ?? '';
    const group = groups.get(key);
    if (group) group.push(period);
    else groups.set(key, [period]);
  }
  for (const group of groups.values()) {
    const dated = group
      .filter((period) => period.starts && period.ends && period.ends >= period.starts)
      .sort((a, b) => a.starts!.localeCompare(b.starts!));
    for (let index = 1; index < dated.length; index += 1) {
      const previous = dated[index - 1]!;
      const current = dated[index]!;
      if (current.starts! <= previous.ends!) {
        problems.push({
          level: 'warn',
          path: at(board, current),
          message: `overlaps ${previous.id} (${previous.starts}..${previous.ends})`,
        });
      }
    }
  }
}
