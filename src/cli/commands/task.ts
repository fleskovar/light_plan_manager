import { parseArgs } from 'node:util';
import type {
  Issue,
  LoadedBoard,
  ResolvedScope,
  Resource,
  TaskCandidate,
  TaskOptions,
} from '../../core/index.js';
import {
  BoardError,
  blockedTasks,
  claimIssue,
  currentScope,
  currentTasks,
  describeScope,
  findIssue,
  flagLabel,
  isParked,
  moveNode,
  nextTasks,
  previousTasks,
  requireCurrentUser,
  terminalStatusId,
} from '../../core/index.js';
import { requireBoard } from '../context.js';
import { bold, cyan, dim, green, out, pad, printRollups, red, yellow } from '../ui.js';

export const help = `Find out what to work on next, and pick it up.

Usage
  lpm task next [options]     What to work on, best first
  lpm task current            What you are working on now
  lpm task prev [options]     What you finished most recently
  lpm task start [<id>]       Claim an issue: assign it to you and start it (atomic)
  lpm task done [<id>]        Move an issue to the board's end state

Options
      --limit <n>       How many to list (next, prev; default 3)
      --unassigned      Also consider work nobody is assigned to (next, start)
      --parked          Also consider periods somebody switched off (next, start)
      --force           Claim an issue even if it belongs to someone else (start)

"Next" lists work units assigned to you, or parked in a pool you cover, that
nothing is blocking. A work unit is an issue with nothing nested inside it, or
one whose type the board declares \`atomic\` -- taken whole, sub-tasks and all.
Overdue and current periods come first, then unscheduled work, then periods
that have not started; within that, the board's priority_attribute decides,
then the part of the plan already under way -- a feature somebody is inside,
then one closest to finished -- and then how much each issue unblocks.

Work in a period somebody switched off is not offered at all: the switch says
"not this one", so it is withheld rather than merely ranked last. Pass --parked
to consider it anyway. Nothing is hidden -- \`lpm open\` and \`lpm task start <id>\`
reach it by id either way.

If you are using a profile (\`lpm profile\`), its scope narrows what "next" and
"start" offer, and is printed with them. It does not narrow "current" or "prev":
work you have already picked up stays yours.

"Start" is a claim, and claiming is atomic: it re-reads the board, checks the
issue is still free, and only then writes your name and the in-progress status
into the document -- plus a line in its activity section saying you took it. If
somebody else claimed it first you are told who has it rather than quietly
taking it off them, so several people and agents can work one checkout.

Run \`lpm me <id or name>\` first so light-plan knows who you are.

Once you have picked something up, \`lpm instructions <id>\` prints everything
you need to start it: the issue, its ancestors' titles and bodies, the files it
names, its blockers and its work log, as one piece of markdown.

If the work stops — something outside the issue has to happen first, or you need
a person — say so with \`lpm flag --comment "..."\` rather than leaving it in
progress. It stays yours and turns red on the board.

"Done" carries upward: finishing the last issue in a feature finishes the
feature, and so on as far as it goes, because nobody works a container. Anything
waiting on it is offered straight away, and what was rolled up is printed.

Examples
  lpm task next
  lpm task next --unassigned --limit 5
  lpm task start
  lpm instructions LP-12
  lpm task done LP-12`;

function describe(board: LoadedBoard, issue: Issue): string {
  const type = board.config.issue_types[issue.type]?.label ?? issue.type;
  return `${bold(pad(issue.id, 8))}${pad(issue.title, 40)} ${dim(`${type} · ${issue.status}`)}`;
}

function suffix(candidate: TaskCandidate): string {
  const parts: string[] = [];
  if (candidate.period) parts.push(candidate.period.id);
  if (candidate.route === 'pool' && candidate.pool) parts.push(`pool ${candidate.pool.id}`);
  if (candidate.route === 'unassigned') parts.push('unassigned');
  return parts.length ? `  ${dim(parts.join(' · '))}` : '';
}

function listCandidates(board: LoadedBoard, candidates: TaskCandidate[]): void {
  for (const candidate of candidates) {
    out(`  ${describe(board, candidate.issue)}${suffix(candidate)}`);
  }
}

function limitOf(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new BoardError(`Invalid --limit "${value}"`, ['Expected a whole number of 1 or more.']);
  }
  return parsed;
}

function who(resource: Resource): string {
  return `${bold(resource.id)} ${resource.title}`;
}

/**
 * What a profile is filtering out, said once wherever work is offered — a
 * recommendation list that silently omits half the board is worse than a short
 * one you can explain.
 */
function announceScope(scope: ResolvedScope): void {
  if (!scope.active) return;
  out(`  ${dim(`scope ${describeScope(scope)}`)}`);
  if (scope.unknown.length) {
    out(`  ${yellow(`warn this board has nothing named ${scope.unknown.join(', ')}`)}`);
  }
}

/** Ready work the switch is holding back, so an empty queue can explain itself. */
function parkedCount(board: LoadedBoard, me: Resource, options: TaskOptions): number {
  return nextTasks(board, me.id, { ...options, includeParked: true }).filter((candidate) =>
    isParked(board, candidate.issue),
  ).length;
}

/** What the reader has asked the queue to consider, in the engine's own terms. */
function picks(values: Values, scope: ResolvedScope): TaskOptions {
  return {
    includeUnassigned: Boolean(values.unassigned),
    includeParked: Boolean(values.parked),
    scope,
  };
}

/** The issue a bare `lpm task start` claims. */
function topCandidate(
  board: LoadedBoard,
  me: Resource,
  options: TaskOptions,
  scope: ResolvedScope,
): Issue {
  const [top] = nextTasks(board, me.id, { ...options, limit: 1 });
  if (top) return top.issue;

  const blocked = blockedTasks(board, me.id, options);
  const parked = options.includeParked ? 0 : parkedCount(board, me, options);
  throw new BoardError('Nothing to start', [
    blocked.length
      ? `${blocked.length} issue(s) are waiting on something else, e.g. ${blocked[0]!.issue.id} blocked by ${blocked[0]!.blockedBy.map((issue) => issue.id).join(', ')}`
      : scope.active
        ? `Nothing your profile offers (${describeScope(scope)}) is assigned to you or to a pool you cover. Try --unassigned.`
        : 'Nothing is assigned to you or to a pool you cover. Try --unassigned.',
    // The one reason that is invisible from the board itself: somebody parked
    // the period this work sits in.
    ...(parked ? [`${parked} issue(s) are ready in switched-off periods. Try --parked.`] : []),
  ]);
}

function runNext(board: LoadedBoard, me: Resource, values: Values, scope: ResolvedScope): number {
  const options = picks(values, scope);
  const candidates = nextTasks(board, me.id, { ...options, limit: limitOf(values.limit, 3) });

  out(`${bold('Next up for')} ${who(me)}`);
  announceScope(scope);
  if (!candidates.length) {
    const blocked = blockedTasks(board, me.id, options);
    out(dim('  nothing ready'));
    if (blocked.length) {
      out();
      out(dim('Blocked:'));
      for (const candidate of blocked) {
        const by = candidate.blockedBy.map((issue) => issue.id).join(', ');
        out(`  ${describe(board, candidate.issue)}  ${yellow(`waiting on ${by}`)}`);
      }
    } else if (!options.includeUnassigned) {
      out(`${dim('  try')} ${cyan('lpm task next --unassigned')}`);
    }
    // A queue that is empty only because the team parked everything must say
    // so, or it reads as a board with nothing left on it.
    if (!options.includeParked && parkedCount(board, me, options)) {
      out(`${dim('  work is waiting in switched-off periods; see it with')} ${cyan('lpm task next --parked')}`);
    }
    return 0;
  }

  listCandidates(board, candidates);
  out();
  out(`${dim('Claim the first with')} ${cyan('lpm task start')}`);
  out(`${dim('Read one properly with')} ${cyan(`lpm instructions ${candidates[0]!.issue.id}`)}`);
  return 0;
}

function runCurrent(board: LoadedBoard, me: Resource): number {
  const issues = currentTasks(board, me.id);
  out(`${bold('In progress for')} ${who(me)}`);
  if (!issues.length) {
    out(dim('  nothing in progress'));
    out(`${dim('  pick something up with')} ${cyan('lpm task start')}`);
    return 0;
  }
  // A flag is the whole reason to look at this list: it is work you have
  // already picked up and stopped, and it is waiting on somebody else.
  for (const issue of issues) {
    out(`  ${describe(board, issue)}${issue.flag ? `  ${red(flagLabel(issue.flag))}` : ''}`);
  }
  if (issues.some((issue) => issue.flag)) {
    out();
    out(`${dim('Why:')} ${cyan('lpm comment <id> --list')}`);
  } else {
    out();
    out(`${dim('Stuck on one of these?')} ${cyan('lpm flag --comment "..."')}`);
  }
  return 0;
}

function runPrev(board: LoadedBoard, me: Resource, values: Values): number {
  const issues = previousTasks(board, me.id, limitOf(values.limit, 3));
  out(`${bold('Recently finished by')} ${who(me)}`);
  if (!issues.length) {
    out(dim('  nothing finished yet'));
    return 0;
  }
  for (const issue of issues) {
    const when = issue.updated?.slice(0, 10) ?? '';
    out(`  ${describe(board, issue)}  ${dim(when)}`);
  }
  return 0;
}

function runStart(
  board: LoadedBoard,
  me: Resource,
  id: string | undefined,
  values: Values,
  scope: ResolvedScope,
): number {
  // A named issue is claimed whatever the scope says: scope decides what you
  // are offered, never what you can reach.
  const issue = id
    ? findIssue(board, id)
    : topCandidate(board, me, picks(values, scope), scope);
  if (!issue) throw new BoardError(`No issue with id "${id}"`);

  // Not `moveNode`: claiming is a test-and-set, so it re-reads the board under
  // the lock and refuses if somebody took this between the list above and now.
  // On a shared checkout that is a real race, and losing it silently is how two
  // people do the same job. @see src/core/operations/claim.ts
  const result = claimIssue(board, issue, { assignee: me.id, force: values.force });
  out(`${green('Started')} ${bold(result.issue.id)}  ${result.issue.title}`);
  if (result.takenFrom) out(`  ${yellow(`taken from ${result.takenFrom}`)}`);
  if (result.assigneeChanged) out(`  assignee  ${issue.assignee ?? 'none'} ${dim('->')} ${me.id}`);
  if (result.statusChanged) out(`  status    ${issue.status} ${dim('->')} ${result.issue.status}`);
  if (result.alreadyHeld) out(dim('  already yours and in progress'));
  out();
  out(`${dim('What you need to know to do it:')} ${cyan(`lpm instructions ${issue.id}`)}`);
  return 0;
}

function runDone(board: LoadedBoard, me: Resource, id: string | undefined): number {
  let issue = id ? findIssue(board, id) : null;
  if (id && !issue) throw new BoardError(`No issue with id "${id}"`);

  if (!issue) {
    const wip = currentTasks(board, me.id);
    if (wip.length !== 1) {
      throw new BoardError(
        wip.length ? 'More than one issue is in progress' : 'Nothing is in progress',
        [wip.length ? `Name one: ${wip.map((entry) => entry.id).join(', ')}` : 'Start something with `lpm task start`.'],
      );
    }
    issue = wip[0]!;
  }

  const status = terminalStatusId(board.config);
  if (!status) {
    throw new BoardError('This board has no end state', [
      'Mark one of the statuses in .lpm/config.yml with `terminal: true`.',
    ]);
  }

  const result = moveNode(board, issue, { status });
  out(`${green('Done')} ${bold(issue.id)}  ${issue.title}`);
  if (result.statusChanged) out(`  status    ${issue.status} ${dim('->')} ${status}`);
  else out(dim('  already there'));
  if (result.flagCleared) {
    out(`  flag      ${dim(`${flagLabel(result.flagCleared)} -> cleared by finishing`)}`);
  }
  // Closing the last issue in a feature closes the feature, and so on upward.
  printRollups(result.rollups);
  return 0;
}

interface Values {
  limit?: string;
  unassigned?: boolean;
  parked?: boolean;
  force?: boolean;
}

export function run(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      limit: { type: 'string' },
      unassigned: { type: 'boolean' },
      parked: { type: 'boolean' },
      force: { type: 'boolean' },
    },
  });

  const sub = positionals[0];
  if (!sub) {
    out(help);
    return 1;
  }

  const board = requireBoard();
  const me = requireCurrentUser(board);
  const scope = currentScope(board);

  switch (sub) {
    case 'next':
      return runNext(board, me, values, scope);
    case 'current':
      return runCurrent(board, me);
    case 'prev':
    case 'previous':
      return runPrev(board, me, values);
    case 'start':
      return runStart(board, me, positionals[1], values, scope);
    case 'done':
      return runDone(board, me, positionals[1]);
    default:
      throw new BoardError(`Unknown subcommand "${sub}"`, [
        'Expected one of: next, current, prev, start, done.',
      ]);
  }
}
