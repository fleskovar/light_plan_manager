import { parseArgs } from 'node:util';
import type { LoadedBoard, Period } from '../../core/index.js';
import {
  BoardError,
  findPeriod,
  isPeriodOverdue,
  nextPeriodAfter,
  openIssuesInPeriod,
  periodHoldsDate,
  periodStance,
  updateNode,
} from '../../core/index.js';
import { planCarryOver, planCompletePeriod, planStartNow } from '../../shared/index.js';
import { requireBoard } from '../context.js';
import { boardView, runPlan } from '../plan.js';
import { bold, cyan, dim, green, out, plural, red, yellow } from '../ui.js';

/**
 * Running the timeline: which timebox is live, and what to do about one that
 * ran out of calendar.
 *
 * Every branch is a thin printer over one core call or one planner from
 * `src/shared/plans.ts` — which is what keeps this command, the web app's
 * periods view and the MCP tools reshaping a board the same way.
 */

export const help = `Switch a period on or off, restart it, or correct one that overran.

Usage
  lpm period <id>             Say how it stands
  lpm period <id> [options]

Options
      --on           Run this period whatever the dates say
      --off          Park it: its work ranks last in every queue
      --dates        Take the switch off again and let the dates decide
      --start-now    Move it to start today, keeping how long it runs
      --complete     Move every open issue in it to the board's end state
      --carry-over   Move every open issue in it into the next period
      --dry-run      Say what would happen, change nothing

A period runs when today falls inside it. The switch is held over that, for
teams who do not plan by date and for rerouting a team mid-sprint: --on runs it
whatever the calendar says, --off parks it, --dates hands it back. Switching a
period off parks everything nested inside it; switching one on speaks for that
timebox alone. Work in a switched-off period ranks last in \`lpm task next\`.

--start-now rewrites dates: the period's own, every period inside it by the
same number of days so a restarted increment keeps its shape, and whatever was
running today is closed yesterday.

--complete and --carry-over are the two answers to a sprint that ended with
work still in it. Completing records that the team stopped; carrying over moves
what is unfinished into the next period beside it and leaves what was finished
where it was. Neither invents a period, so carrying over down a run is what
makes the last one's backlog grow.

Examples
  lpm period TL-3 --start-now
  lpm period TL-3 --off
  lpm period TL-2 --carry-over
  lpm period TL-2 --complete`;

/** How a period stands, said the same way before and after a change. */
function describe(board: LoadedBoard, period: Period, today: string): void {
  const stance = periodStance(board, period);
  const when = `${period.starts ?? '?'} → ${period.ends ?? '?'}`;
  const state =
    stance === 'on'
      ? green('switched on')
      : stance === 'off'
        ? yellow(period.active === false ? 'switched off' : 'off with the period around it')
        : periodHoldsDate(period, today)
          ? green('running')
          : dim('on its dates');

  out(`${bold(period.id)}  ${period.title}  ${dim(when)}  ${state}`);

  if (isPeriodOverdue(board, period, today)) {
    const open = openIssuesInPeriod(board, period.id);
    const next = nextPeriodAfter(board, period.id);
    out(`  ${red(`overdue: ended ${period.ends} with ${plural(open.length, 'issue')} still open`)}`);
    out(
      `  ${dim('fix it with')} ${cyan(`lpm period ${period.id} --complete`)}` +
        (next ? `${dim(' or')} ${cyan(`lpm period ${period.id} --carry-over`)}` : ''),
    );
  }
}

export function run(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      on: { type: 'boolean' },
      off: { type: 'boolean' },
      dates: { type: 'boolean' },
      'start-now': { type: 'boolean' },
      complete: { type: 'boolean' },
      'carry-over': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
    },
  });

  const id = positionals[0];
  if (!id) throw new BoardError('Missing id', ['Usage: lpm period <id> --start-now']);

  let board = requireBoard();
  const period = findPeriod(board, id);
  if (!period) throw new BoardError(`No period with id "${id}"`);

  const switches = [values.on, values.off, values.dates].filter(Boolean).length;
  if (switches > 1) {
    throw new BoardError('Pass only one of --on, --off and --dates', [
      'A period is switched on, switched off, or back on its dates.',
    ]);
  }
  if (values.complete && values['carry-over']) {
    throw new BoardError('Pass only one of --complete and --carry-over', [
      'They are the two answers to the same question.',
    ]);
  }

  const today = new Date().toISOString().slice(0, 10);
  const acting = switches > 0 || values['start-now'] || values.complete || values['carry-over'];
  if (!acting) {
    describe(board, period, today);
    return 0;
  }

  const dry = Boolean(values['dry-run']);
  if (dry) out(yellow(`Would change ${bold(period.id)}  ${period.title}`));

  if (switches > 0) {
    const active = values.on ? true : values.off ? false : null;
    const said = active === null ? 'back on its dates' : active ? 'on' : 'off';
    if (dry) {
      out(`  ${dim(`switch ${said}`)}`);
    } else {
      updateNode(board, period, { active });
      out(`${green('Switched')} ${bold(period.id)} ${said}`);
      board = requireBoard();
    }
  }

  // Dates after the switch, so `--on --start-now` reads as one intent and the
  // second half plans against the board the first half left behind.
  if (values['start-now']) {
    const plan = planStartNow(boardView(board), period.id, today);
    if (!plan.ok) throw new BoardError(plan.error, plan.details);
    out(`${dry ? yellow('Would start') : green('Starting')} ${bold(period.id)}  ${plan.starts} → ${plan.ends}`);
    for (const entry of plan.carried) out(`  ${dim(`${entry.id} moves with it`)}`);
    for (const entry of plan.closing) out(`  ${dim(`${entry.id} is closed yesterday`)}`);
    if (!dry) {
      runPlan(board, plan, 'Start');
      board = requireBoard();
    }
  }

  if (values.complete || values['carry-over']) {
    const open = openIssuesInPeriod(board, period.id);
    const plan = values.complete
      ? planCompletePeriod(boardView(board), period.id)
      : planCarryOver(boardView(board), period.id);
    if (!plan.ok) throw new BoardError(plan.error, plan.details);

    const next = values.complete ? null : nextPeriodAfter(board, period.id);
    const what = `${plural(open.length, 'issue')} in ${period.id}`;
    out(
      values.complete
        ? `${dry ? yellow('Would complete') : green('Completing')} ${what}`
        : `${dry ? yellow('Would move') : green('Moving')} ${what} ${dim(`-> ${next?.id ?? '?'}`)}`,
    );
    for (const issue of open) out(`  ${dim(issue.id)}  ${issue.title}`);
    if (!dry) {
      runPlan(board, plan, values.complete ? 'Complete' : 'Carry over');
      board = requireBoard();
    }
  }

  if (!dry) {
    out();
    describe(board, findPeriod(board, period.id) ?? period, today);
  }
  return 0;
}
