import type { LoadedBoard } from '../../board/load.js';
import { periodOf } from '../../board/query.js';
import { blockingLookupFor } from '../../board/tasks.js';
import { ignoresPeriods } from '../../config/lookup.js';
import { findCyclesIn, formatCycle } from '../../model/links.js';
import type { Issue, Problem } from '../../model/types.js';
import { effectiveDependencies } from '../../../shared/blocking.js';
import { displayPath } from '../../storage/paths.js';
import { at } from '../shared.js';

/**
 * What gates each issue once the edges are inherited — the same graph
 * `nextTasks` withholds work by, built through the one definition of it.
 *
 * Checked in this form rather than as written, because inheritance can close a
 * loop that no single document shows. A feature depending on a task that lives
 * inside a *later* feature is the worked example: neither edge is a cycle on
 * its own, and together they stall both features for ever.
 */
function gatingGraph(board: LoadedBoard): Map<string, string[]> {
  const lookup = blockingLookupFor(board);
  const graph = new Map<string, string[]>();
  for (const issue of board.issues) {
    graph.set(
      issue.id,
      effectiveDependencies(issue.id, lookup).filter((id) => board.byId.has(id)),
    );
  }
  return graph;
}

/**
 * Work scheduled before the work it waits on is a plan that cannot run. Not
 * asked on a board planning by queue, where no sprint runs and the order is
 * the graph's alone; the warning comes back with the periods.
 */
function checkSchedule(board: LoadedBoard, issue: Issue, problems: Problem[]): void {
  if (ignoresPeriods(board.config)) return;
  const own = periodOf(board, issue);
  if (!own?.starts) return;
  for (const id of issue.depends_on) {
    const blocker = board.byId.get(id);
    if (!blocker) continue;
    const other = periodOf(board, blocker);
    if (other?.starts && other.starts > own.starts) {
      problems.push({
        level: 'warn',
        path: at(board, issue),
        message: `scheduled in ${own.id} (${own.starts}) but depends on ${id}, scheduled later in ${other.id} (${other.starts})`,
      });
    }
  }
}

export function checkDependencies(board: LoadedBoard, problems: Problem[]): void {
  const order = board.issues.map((issue) => issue.id);
  for (const cycle of findCyclesIn(gatingGraph(board), order)) {
    const head = board.byId.get(cycle[0]!);
    problems.push({
      level: 'error',
      path: head ? at(board, head) : displayPath(board.paths, board.paths.boardDir),
      message:
        `dependency cycle: ${formatCycle(cycle)}` +
        ' — nothing in it can ever be offered. Reads depends_on, including edges' +
        ' inherited from a parent, because the queue does.',
    });
  }

  for (const issue of board.issues) checkSchedule(board, issue, problems);
}
