import { parseArgs } from 'node:util';
import type {
  Issue,
  IssueDependencyRollup,
  LoadedBoard,
  UpstreamIssue,
} from '../../core/index.js';
import {
  BoardError,
  findIssue,
  findNode,
  rolledUpDependenciesOf,
  upstreamOf,
} from '../../core/index.js';
import type { UpstreamDecision } from '../../shared/index.js';
import { scheduleUpstream } from '../../shared/index.js';
import { requireBoard } from '../context.js';
import { boardView, runPlan } from '../plan.js';
import { bold, cyan, dim, green, out, plural, yellow } from '../ui.js';

export const help = `Everything that has to happen before an issue can be closed.

Usage
  lpm upstream <id>              List the whole chain of work behind an issue
  lpm upstream <id> --schedule   Put the unclaimed part of it in the same sprint

Options
      --schedule          Schedule and assign the upstream work (see below)
      --period <id>       Schedule into this period instead of the issue's own
      --assignee <id>     Give it to this resource instead of the issue's own
      --unscheduled       Assign only; do not write a period
      --unassigned        Schedule only; do not write an assignee
      --dry-run           Say what would happen, change nothing

\`lpm task next\` tells you what is blocking an issue *today* and stops at the
first thing. This is the whole chain behind that answer: what those blockers
wait on, what those wait on, and the open work inside each blocking container.
A container is finished when its contents are, so a feature standing in the way
is really its unfinished stories standing in the way -- and they are what
somebody can actually be handed.

For a container, the report ends with what the work inside it puts it after:
the dependency between two stories puts the two features they sit in in the
same order, up to the container they share. Nothing is written on either
container -- both stand for the work inside them -- so that part of the report
is read off the graph and is never scheduled by --schedule.

--schedule pushes that work into the queue: every unclaimed upstream work unit
is put in the same period as <id> and given to the same person or pool. Two
rules, and both are deliberately narrow:

  * Work somebody already holds is left alone, its period included. It is their
    work, and moving it between sprints would be a worse surprise than a short
    list. It is still reported, so you can see it.
  * Only work units are scheduled. A period written on an epic offers nobody
    anything, because the queue hands out units -- so containers are listed and
    left as they are.

Examples
  lpm upstream LP-42
  lpm upstream LP-42 --schedule
  lpm upstream LP-42 --schedule --dry-run
  lpm upstream LP-42 --schedule --assignee ana --period sprint-7`;

export function run(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      schedule: { type: 'boolean' },
      period: { type: 'string' },
      assignee: { type: 'string' },
      unscheduled: { type: 'boolean' },
      unassigned: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
    },
  });

  const id = positionals[0];
  if (!id) throw new BoardError('Missing id', ['Usage: lpm upstream <id>']);
  if (values.period && values.unscheduled) {
    throw new BoardError('Pick one of --period and --unscheduled');
  }
  if (values.assignee && values.unassigned) {
    throw new BoardError('Pick one of --assignee and --unassigned');
  }

  const board = requireBoard();
  const issue = findIssue(board, id);
  if (!issue) throw new BoardError(`No issue with id "${id}"`);

  const upstream = upstreamOf(board, issue);
  if (!values.schedule) return report(board, issue, upstream);

  return schedule(board, issue, values);
}

// -- listing ---------------------------------------------------------------

/** The board's word for a status, so the report speaks the board's language. */
function statusLabel(board: LoadedBoard, issue: Issue): string {
  return board.config.statuses.find((status) => status.id === issue.status)?.label ?? issue.status;
}

function titleOf(board: LoadedBoard, id: string | null): string | null {
  if (!id) return null;
  return findNode(board, id)?.title ?? id;
}

/** One upstream issue: what it is, where it stands, and who has it. */
function line(board: LoadedBoard, entry: UpstreamIssue): string {
  const { issue } = entry;
  const type = board.config.issue_types[issue.type]?.label ?? issue.type;
  const where: string[] = [statusLabel(board, issue)];

  const who = titleOf(board, issue.assignee);
  if (who) where.push(who);
  const when = titleOf(board, issue.period);
  if (when) where.push(when);
  if (issue.flag) where.push(yellow(`flagged: ${issue.flag}`));

  // The indent is the distance back down the chain, and contents sit one
  // deeper than the container they were found in — they are at the same
  // distance, but reading them as a flat list loses which one they came out of.
  const indent = '  '.repeat(entry.distance - 1 + (entry.reason === 'contents' ? 1 : 0));
  const mark = entry.reason === 'contents' ? dim('·') : cyan('←');
  return `  ${indent}${mark} ${bold(issue.id)}  ${issue.title}  ${dim(`(${type} — ${where.join(', ')})`)}`;
}

/**
 * One container this one stands behind because of the work inside them both,
 * naming the written dependency it reflects — without that, a reader has no
 * way to find the two stories the ordering actually comes from.
 */
function rolledLine(board: LoadedBoard, entry: IssueDependencyRollup): string {
  const { blocker } = entry;
  const type = board.config.issue_types[blocker.type]?.label ?? blocker.type;
  return (
    `  ${cyan('←')} ${bold(blocker.id)}  ${blocker.title}  ${dim(`(${type})`)}  ` +
    `${dim(`via ${entry.source} → ${entry.target}`)}`
  );
}

function report(board: LoadedBoard, issue: Issue, upstream: UpstreamIssue[]): number {
  out(`${bold(issue.id)}  ${issue.title}`);
  const rolled = rolledUpDependenciesOf(board, issue.id);

  if (!upstream.length && !rolled.length) {
    out(dim('  nothing upstream — everything it waits on is finished'));
    return 0;
  }

  if (upstream.length) {
    out(dim(`  ${plural(upstream.length, 'issue')} must be finished first`));
    out();
    for (const entry of upstream) out(line(board, entry));
    out();
    out(dim('  ← something it waits on   · open work inside one'));
  }

  if (rolled.length) {
    out();
    out(dim('  the work inside it puts it after:'));
    for (const entry of rolled) out(rolledLine(board, entry));
    out(dim('  Nothing is written on either container; both stand for the work inside them.'));
  }
  return 0;
}

// -- scheduling ------------------------------------------------------------

interface ScheduleFlags {
  period?: string;
  assignee?: string;
  unscheduled?: boolean;
  unassigned?: boolean;
  'dry-run'?: boolean;
}

/**
 * `undefined` means "take it from the issue", which is the whole point of the
 * command; a flag is the only way to say anything else. `--unscheduled` and
 * `--unassigned` are how you say "not that half" — `util.parseArgs` has no
 * negation, and an empty string would be a period id nobody has.
 */
function override(value: string | undefined, off: boolean | undefined): string | null | undefined {
  if (off) return null;
  return value;
}

function schedule(board: LoadedBoard, issue: Issue, values: ScheduleFlags): number {
  requireExists(board, values.period, 'period');
  requireExists(board, values.assignee, 'resource');

  const result = scheduleUpstream(boardView(board), issue.id, {
    period: override(values.period, values.unscheduled),
    assignee: override(values.assignee, values.unassigned),
  });
  if (!result.plan.ok) throw new BoardError(result.plan.error, result.plan.details);

  const moved = result.decisions.filter((entry) => !entry.skipped);
  const where = titleOf(board, result.period) ?? 'no period';
  const who = titleOf(board, result.assignee) ?? 'nobody';

  if (values['dry-run']) {
    out(`${yellow('Would schedule')} the work behind ${bold(issue.id)} into ${bold(where)}, for ${bold(who)}`);
    printDecisions(board, result.decisions);
    return 0;
  }

  // `runPlan` announces an empty plan itself, which would be a second "nothing
  // happened" line over the top of the one below that says *why* nothing did.
  if (result.plan.changes.length) runPlan(board, result.plan, 'Scheduling upstream work');
  out(
    moved.length
      ? `${green('Scheduled')} ${plural(moved.length, 'issue')} into ${bold(where)}, for ${bold(who)}`
      : dim('nothing to schedule'),
  );
  printDecisions(board, result.decisions);
  return 0;
}

/** A period or resource that does not exist is a typo, not an empty result. */
function requireExists(board: LoadedBoard, id: string | undefined, kind: string): void {
  if (!id) return;
  const node = findNode(board, id);
  if (!node) throw new BoardError(`No ${kind} with id "${id}"`);
  if (node.kind !== kind) throw new BoardError(`${id} is a ${node.kind}, not a ${kind}`);
}

const SKIP_REASONS: Record<NonNullable<UpstreamDecision['skipped']>, string> = {
  assigned: 'already taken',
  container: 'a container — its work is listed separately',
  unchanged: 'already there',
};

/**
 * Everything the plan looked at, including what it left alone. A command that
 * printed only what it changed would report "nothing to schedule" for a chain
 * of six issues six people are already working on, which is a different board.
 */
function printDecisions(board: LoadedBoard, decisions: UpstreamDecision[]): void {
  if (!decisions.length) {
    out(dim('  nothing upstream — everything it waits on is finished'));
    return;
  }
  for (const entry of decisions) {
    const issue = findIssue(board, entry.id);
    if (!issue) continue;
    const note = entry.skipped ? dim(`  (left alone: ${SKIP_REASONS[entry.skipped]})`) : '';
    const mark = entry.skipped ? dim('-') : green('+');
    out(`  ${mark} ${bold(issue.id)}  ${issue.title}${note}`);
  }
}
