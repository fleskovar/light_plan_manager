import { parseArgs } from 'node:util';
import type { LoadedBoard, PlanningMode } from '../../core/index.js';
import { BoardError, hasPeriods, parsePlanningMode, planningOf, setPlanning } from '../../core/index.js';
import { requireBoard } from '../context.js';
import { bold, cyan, dim, green, out } from '../ui.js';

/**
 * Switching between planning with the periods and working one queue. A thin
 * printer over `setPlanning`, which is the one write and the one place the
 * rule about a board with no period types lives.
 */

export const help = `Plan with sprints and increments, or work the board as one continuous queue.

Usage
  lpm planning               Say which mode the board is in
  lpm planning queue         Work the board as one continuous queue
  lpm planning periods       Plan with sprints and increments again (also: pi, sprints)

In queue mode the board reads as one increment holding one sprint holding
everything. \`lpm task next\`, \`lpm queue simulate\`, \`lpm queue agent\`, the MCP
tools and the web queue all ignore every period: no sprint ranks ahead of
another, a switched-off period no longer holds work back, and no squad owns a
sprint. The order is priority, column, the feature already under way, and how
much finishing a task unblocks.

Nothing on the board is changed. Every issue keeps its period, every period
keeps its dates and its switch, and \`lpm planning periods\` gives the plan back
exactly as it was. The only write is the \`planning:\` line in .lpm/config.yml,
which is shared with the team like the rest of the config — and committed and
pushed when the board is shared through git.

A board with no period types is always in queue mode: there is nothing to plan
with.

Examples
  lpm planning
  lpm planning queue
  lpm planning periods`;

function describe(mode: PlanningMode): string {
  return mode === 'queue'
    ? `${bold('queue')}  ${dim('one continuous run; every period is ignored')}`
    : `${bold('periods')}  ${dim('sprints and increments decide what comes first')}`;
}

function report(board: LoadedBoard): void {
  const mode = planningOf(board.config);
  out(`Planning  ${describe(mode)}`);
  if (!hasPeriods(board.config)) {
    out(dim('  this board declares no period types, so the queue is the only mode'));
  } else if (mode === 'queue') {
    out(`${dim('  plan with sprints again with')} ${cyan('lpm planning periods')}`);
  } else {
    out(`${dim('  work the board as one queue with')} ${cyan('lpm planning queue')}`);
  }
}

export function run(args: string[]): number {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  if (positionals.length > 1) {
    throw new BoardError('Name one mode', ['lpm planning queue  or  lpm planning periods']);
  }

  const board = requireBoard();
  const [wanted] = positionals;
  if (!wanted) {
    report(board);
    return 0;
  }

  const result = setPlanning(board.paths, parsePlanningMode(wanted));
  if (!result.changed) {
    out(`${dim('Already')} ${describe(result.planning)}`);
    return 0;
  }
  out(`${green('Planning')}  ${describe(result.planning)}`);
  out(
    dim(
      result.planning === 'queue'
        ? '  no document was changed: periods, dates and switches are kept for when you switch back'
        : '  the periods, dates and switches are back exactly as they were',
    ),
  );
  return 0;
}
