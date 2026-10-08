import { isActiveStatus, isTerminalStatus, terminalStatusId } from '../config/lookup.js';
import { BoardError } from '../errors.js';
import type { Issue, Period, Resource } from '../model/types.js';
import type { LoadedBoard } from './load.js';
import { periodOf, workUnits } from './query.js';
import { inScope } from './scope.js';
import type { TaskCandidate, TaskOptions, TaskRoute } from './tasks.js';
import { blockersOf, effortOf, isParked, nextTasks, resumableTasks, routeOf } from './tasks.js';

/**
 * "If this one person were the only contributor, what would they do, and in
 * what order?"
 *
 * The queue answers "what is next" one step at a time, which is the question a
 * developer has. The question a plan owner has is the whole sequence: take the
 * top of the queue, finish it, ask again, and keep going until nothing is left
 * that this person could ever pick up. That is all this is — `nextTasks` in a
 * loop over a board held in memory.
 *
 * Two properties make it worth having rather than guessing:
 *
 *   - **It drives the real queue.** Every step comes from `nextTasks` against a
 *     board with the earlier steps marked finished, so the order it reports is
 *     the order the board would actually offer. A second copy of the ranking
 *     rules that agreed today and drifted tomorrow would be worse than nothing.
 *   - **Nothing is written and no clock moves.** The overlay lives for the
 *     length of the call, and `today` is fixed throughout, so a period that has
 *     not started stays not-started for the whole run. This reports an order,
 *     never a schedule: it does not know how long anything takes and must not
 *     appear to.
 *
 * There is deliberately nothing here that decides *what* may be picked up.
 * Every rule about that — routing, scope, work units, blockers, parked periods —
 * lives in `candidatesFor` and reaches this file only through `nextTasks`, so a
 * developer running `lpm task next` step by step gets the sequence this reports.
 * The moment this module grows a filter of its own, that stops being true.
 *
 * What the run *cannot* reach is the other half of the answer, and is reported
 * beside it. Under "only contributor", work held by somebody else is never
 * finished, so anything waiting on it waits forever — which is exactly the
 * thing a reader wants to see.
 *
 * The one place the run is allowed to start from something the queue does not
 * offer is work already in flight — it has been picked up, and pretending it is
 * not there would leave its dependents blocked forever. That licence stops at a
 * **flag**: a flag says the work has stopped and needs a person, and this run
 * has nobody else in it, so taking a flagged issue as step 1 would assume away
 * the very thing holding the queue up and report everything behind it as
 * reachable. Flagged work is reported as skipped instead, which is what makes
 * this agree with `lpm task next` and `lpm queue agent` on a stalled board.
 *
 * That licence is not this file's to grant either: it is `resumableTasks` in
 * `board/tasks/ranking.ts`, and `lpm queue agent` resumes through exactly the
 * same call. A private copy here is how the two came to disagree — the run
 * predicted a sequence starting from work the agent could never pick back up.
 */

/** Why a piece of work was never picked up. */
export type SkipReason =
  /** Flagged: whoever holds it has said the work has stopped. */
  | 'flagged'
  /** Somebody else has it in flight, and this run never finishes their work. */
  | 'active'
  /** The reader's profile does not offer it. */
  | 'scope'
  /** Assigned elsewhere, or to nobody when nobody was being considered. */
  | 'routing'
  /** The period is owned by a squad the resource does not belong to. */
  | 'squad'
  /** In a period somebody switched off. Asked for with `includeParked`. */
  | 'parked'
  /** Waiting on work this run never finished. */
  | 'blocked'
  /** Reachable and ready — only possible when `limit` cut the run short. */
  | 'ready';

export interface SimulationStep {
  /** 1-based position in the sequence. */
  order: number;
  issue: Issue;
  route: TaskRoute;
  /** The pool the work was parked in, when `route` is 'pool'. */
  pool: Resource | null;
  period: Period | null;
  /**
   * True when this issue was already in an active status when the run began.
   * Work in flight is not offered by the queue — it has been picked up — so it
   * is done first rather than ignored, or everything waiting on it would look
   * blocked forever.
   */
  started: boolean;
  /** Effort declared on this issue, or null when none is recorded. */
  effort: number | null;
  /** Effort of every step so far including this one; null on a board with none. */
  cumulative: number | null;
  /** Work that stopped being blocked because this step finished. */
  unblocked: Issue[];
}

export interface SimulationSkip {
  issue: Issue;
  reason: SkipReason;
  /** Unfinished blockers left when the run ended. Only for `reason` 'blocked'. */
  blockedBy: Issue[];
  /** Who is holding it, when somebody is and the board knows them. */
  holder: Resource | null;
  /** The period it sits in, so a parked one can be named rather than implied. */
  period: Period | null;
}

export interface QueueSimulation {
  resource: Resource;
  /** The sequence, in the order the board would offer it. */
  steps: SimulationStep[];
  /** Open work units the run never reached, with the reason for each. */
  skipped: SimulationSkip[];
  /** Total effort of the steps; null when the board measures no effort. */
  effort: number | null;
  /** Steps carrying no effort, when the board measures effort at all. */
  unestimated: number;
  /** True when `limit` stopped the run with work still takeable. */
  truncated: boolean;
  /**
   * Open work the queue withheld because its period is switched off. Always
   * reported, so a run that is short because the team parked six sprints says
   * so rather than looking like a board with nothing left on it.
   */
  parked: number;
  /**
   * Work of this resource's that is flagged, and so was never started from.
   * Reported for the same reason `parked` is: a run that is empty because every
   * issue this person holds has stopped is not a board with nothing left on it,
   * and the difference is the whole answer.
   */
  flagged: number;
}

export interface SimulateOptions extends TaskOptions {
  /** Stop after this many steps. Omit to run the queue dry. */
  limit?: number;
}

/**
 * The board as it would be with `issue` finished.
 *
 * A shallow overlay: only the status of one issue changes, so every index that
 * does not depend on status (`dependents`, `resourcesById`, the trees) is shared
 * rather than rebuilt. The trees are the one thing left holding a stale status,
 * and nothing that ranks work reads them.
 */
function withFinished(board: LoadedBoard, issue: Issue, status: string): LoadedBoard {
  const finished: Issue = { ...issue, status };
  const byId = new Map(board.byId);
  byId.set(issue.id, finished);
  return {
    ...board,
    issues: board.issues.map((other) => (other.id === issue.id ? finished : other)),
    byId,
  };
}

/** Work that had `issue` as its last unfinished blocker. */
function unblockedBy(before: LoadedBoard, after: LoadedBoard, issue: Issue): Issue[] {
  return (before.dependents.get(issue.id) ?? [])
    .map((id) => after.byId.get(id))
    .filter((other): other is Issue => Boolean(other))
    .filter((other) => blockersOf(after, other).length === 0);
}

/** Why this open work unit was never picked up. Most specific cause first. */
function classify(
  board: LoadedBoard,
  issue: Issue,
  resource: Resource,
  options: SimulateOptions,
): SimulationSkip {
  const holder = issue.assignee ? (board.resourcesById.get(issue.assignee) ?? null) : null;
  const skip = (reason: SkipReason, blockedBy: Issue[] = []): SimulationSkip => ({
    issue,
    reason,
    blockedBy,
    holder,
    period: periodOf(board, issue),
  });

  // Ahead of everything: a flag is a statement that this work has stopped and
  // needs a person, which is the answer a reader can act on. It is also why the
  // run is short, so it must not be reported as something vaguer.
  if (issue.flag) return skip('flagged');
  if (isActiveStatus(board.config, issue.status)) return skip('active');
  if (options.scope && !inScope(options.scope, issue)) return skip('scope');
  if (!routeOf(board, issue, resource, options)) return skip('routing');
  const squadGate = issue.period ? board.periodSquadMembers.get(issue.period) : undefined;
  if (squadGate && !squadGate.has(resource.id)) return skip('squad');
  // Ahead of 'blocked': parked work was never a candidate, so saying what it is
  // waiting on would answer a question the queue never got as far as asking.
  if (!options.includeParked && isParked(board, issue)) return skip('parked');

  const blockedBy = blockersOf(board, issue);
  return blockedBy.length ? skip('blocked', blockedBy) : skip('ready');
}

/**
 * Work the queue through as one person, and report the sequence.
 *
 * The caller resolves the resource, because naming somebody is the CLI's job
 * (`findResource` takes a name as readily as an id) and a report about a person
 * who does not exist has nothing to say.
 */
export function simulateQueue(
  board: LoadedBoard,
  resource: Resource,
  options: SimulateOptions = {},
): QueueSimulation {
  const done = terminalStatusId(board.config);
  if (!done) {
    throw new BoardError('This board has no end state, so nothing can be simulated as finished', [
      'Mark one of the statuses in .lpm/config.yml with `terminal: true`.',
    ]);
  }

  const measuresEffort = Boolean(board.config.effort_attribute);
  const limit = options.limit === undefined ? Infinity : Math.max(0, options.limit);

  const steps: SimulationStep[] = [];
  let state = board;
  let total = 0;

  const take = (candidate: TaskCandidate, started: boolean): void => {
    const effort = effortOf(state, candidate.issue);
    if (effort !== null) total += effort;
    const next = withFinished(state, candidate.issue, done);
    steps.push({
      order: steps.length + 1,
      issue: candidate.issue,
      route: candidate.route,
      pool: candidate.pool,
      period: candidate.period,
      started,
      effort,
      cumulative: measuresEffort ? total : null,
      unblocked: unblockedBy(state, next, candidate.issue),
    });
    state = next;
  };

  // The limit is checked only once something takeable has been found, so a run
  // that happened to end on exactly the limit is not reported as cut short.
  let truncated = false;

  // Work already picked up comes first: the queue does not offer it, and a run
  // that pretended it was not there would leave its dependents blocked forever.
  // `resumableTasks` is the same call `lpm queue agent` makes to resume its own
  // work, which is what keeps the prediction and the run in step.
  for (const candidate of resumableTasks(board, resource.id, options)) {
    if (steps.length >= limit) {
      truncated = true;
      break;
    }
    take(candidate, true);
  }

  // Then the queue itself, re-asked after every step — the whole point being
  // that finishing one thing changes what the board offers next.
  while (!truncated) {
    const [top] = nextTasks(state, resource.id, { ...options, limit: 1 });
    if (!top) break;
    if (steps.length >= limit) {
      truncated = true;
      break;
    }
    take(top, false);
  }

  const taken = new Set(steps.map((step) => step.issue.id));
  const skipped = workUnits(state)
    .filter((issue) => !taken.has(issue.id))
    .filter((issue) => !isTerminalStatus(state.config, issue.status))
    .map((issue) => classify(state, issue, resource, options));

  return {
    resource,
    steps,
    skipped,
    effort: measuresEffort ? total : null,
    unestimated: measuresEffort ? steps.filter((step) => step.effort === null).length : 0,
    truncated,
    parked: skipped.filter((skip) => skip.reason === 'parked').length,
    flagged: skipped.filter(
      (skip) => skip.reason === 'flagged' && skip.issue.assignee === resource.id,
    ).length,
  };
}
