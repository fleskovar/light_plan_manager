import type { ConfigDto, IssueDto, PeriodDto } from '$shared';
import { plansWithPeriods, statusOf } from '$shared';
import {
  ancestorsOf,
  blockersOf,
  byRecency,
  childrenOf,
  cohesionOrder,
  dependentsIndex,
  idSerial,
  isActive,
  isTerminal,
  issueEffort,
  isWorkUnit,
  nodesOfKind,
  priorityRank,
  statusRank,
  subtreeIds,
  workUnitsOf,
  workUnitsUnder,
} from '$lib/board/selectors.js';
import { isRunning, periodStance } from '$lib/board/periods.js';
import type { WorkingNodes } from '$lib/board/working.js';
import type { NodeIndex } from '$lib/board/index.js';

/**
 * What the overview dialog can say about a board.
 *
 * Three questions, and they are deliberately different ones. *Now* is the
 * calendar's answer: the increment and sprint that are running today, and what
 * is in them — or, on a board working as one queue, the whole board, which is
 * the one run everything is in. *Just added* is the board's own churn, so a plan somebody else
 * has been filling in is visible on arrival. *Open pathways* ignores the
 * calendar entirely and asks the graph instead: which epics and features could
 * be started, because nothing they rest on is unfinished.
 *
 * The rules are the engine's, mirrored — work units carry work, a container does
 * not; a blocker is a dependency that has not reached a terminal status;
 * priority is the position of a value in its type's enum, most important
 * first. Nothing here is a second opinion about any of that. If `board/tasks.ts`
 * changes what "ready" means, this has to follow.
 */

export interface TaskLine {
  issue: IssueDto;
  /** The period it actually sits in, which may be nested inside the sprint. */
  period: PeriodDto | null;
  /** Issues that must finish first. Empty for anything in `ready`. */
  blockedBy: IssueDto[];
  /** How many issues are waiting on this one. */
  unblocks: number;
  effort: number;
}

export interface Focus {
  /** The increment the work below came from, and the sprint inside it. */
  increment: PeriodDto | null;
  sprint: PeriodDto | null;
  /**
   * The board works as one queue: the work below is all of it, and there is
   * no period to name.
   */
  continuous: boolean;
  /** It has not started yet: today's period is finished, or there is none. */
  upcoming: boolean;
  /** Work already under way in that period. */
  active: TaskLine[];
  /** Unblocked work nobody has started, best first. */
  ready: TaskLine[];
  /** Issues in the period waiting on something unfinished. */
  blocked: number;
  /** Open work units in the period, and the effort they carry. */
  open: number;
  effort: number;
}

export interface Pathway {
  /** The epic or feature that could be picked up. */
  issue: IssueDto;
  /** Open work units under it, and how many of those someone could take today. */
  open: number;
  ready: number;
  /** Effort still to do inside it. */
  effort: number;
  /** Issues outside it that are waiting on something inside it. */
  unblocks: number;
  /** Work has already started somewhere inside it. */
  started: boolean;
}

export interface DigestOptions {
  /** Today as YYYY-MM-DD. Injected so a summary is testable. */
  today?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 6;

// The primitives behind "what is ready?" are shared with the queue board, so
// the two can never disagree about it — see `$lib/board/selectors.ts`.

function line(
  nodes: WorkingNodes,
  config: ConfigDto,
  dependents: Record<string, string[]>,
  issue: IssueDto,
  index?: NodeIndex,
): TaskLine {
  const period = issue.period ? nodes[issue.period] : undefined;
  return {
    issue,
    period: period?.kind === 'period' ? period : null,
    blockedBy: blockersOf(nodes, config, issue, index),
    unblocks: dependents[issue.id]?.length ?? 0,
    effort: issueEffort(config, issue),
  };
}

/**
 * The period tree from `id` down, which is what "work in this sprint" means —
 * minus anything switched off. Reading a quarter's open work has to leave out
 * the sprint somebody parked, or parking one would move its work up a level
 * instead of putting it away.
 */
function periodScope(nodes: WorkingNodes, id: string, index?: NodeIndex): Set<string> {
  return new Set(subtreeIds(nodes, id, index).filter((entry) => periodStance(nodes, entry) !== 'off'));
}

/**
 * The periods worth showing, best first: the sprint running today, then
 * whatever starts next, and only then the increment around them.
 *
 * The order matters when a sprint has been emptied. "This quarter still has
 * work in it" is true but too coarse to act on, so the increment is a last
 * resort — it would only repeat the contents of the sprints already tried.
 *
 * "Running" is `isRunning`, not the dates, so this page and the periods view
 * cannot disagree about what is now. A period somebody switched off is dropped
 * outright: pointing a reader at work they have just parked is the one answer
 * that is certainly wrong.
 */
function focusCandidates(nodes: WorkingNodes, today: string): PeriodDto[] {
  const periods = nodesOfKind(nodes, 'period')
    .filter((period) => period.starts)
    .filter((period) => periodStance(nodes, period.id) !== 'off');
  // Deepest first: an increment and its first sprint start on the same day, and
  // "the sprint" is the more useful of the two answers.
  const [running, ...around] = periods
    .filter((period) => isRunning(nodes, period, today))
    .sort((a, b) => b.depth - a.depth || a.starts!.localeCompare(b.starts!));
  const ahead = periods
    .filter((period) => !isRunning(nodes, period, today) && period.starts! > today)
    .sort((a, b) => a.starts!.localeCompare(b.starts!) || b.depth - a.depth);

  return [...(running ? [running] : []), ...ahead, ...around];
}

/** The increment above a period, and the period itself when it is a sprint. */
function placeOf(
  nodes: WorkingNodes,
  period: PeriodDto,
  index?: NodeIndex,
): { increment: PeriodDto | null; sprint: PeriodDto | null } {
  const root = ancestorsOf(nodes, period.id, index).at(-1);
  return {
    increment: root?.kind === 'period' ? root : period.depth === 0 ? period : null,
    sprint: period.depth > 0 ? period : null,
  };
}

export function currentFocus(
  nodes: WorkingNodes,
  config: ConfigDto,
  options: DigestOptions = {},
  index?: NodeIndex,
): Focus {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const limit = options.limit ?? DEFAULT_LIMIT;
  const candidates = focusCandidates(nodes, today);

  const empty: Focus = {
    increment: null,
    sprint: null,
    continuous: false,
    upcoming: false,
    active: [],
    ready: [],
    blocked: 0,
    open: 0,
    effort: 0,
  };
  const dependents = dependentsIndex(nodes, index);
  const units = workUnitsOf(nodes, config, index);

  // One queue: the omni period is the whole board.
  if (!plansWithPeriods(config)) {
    const open = units
      .filter((issue) => !isTerminal(config, issue))
      .map((issue) => line(nodes, config, dependents, issue, index));
    return { ...empty, continuous: true, ...summarise(nodes, config, open, limit, index) };
  }
  if (!candidates.length) return empty;

  const openIn = (period: PeriodDto): TaskLine[] => {
    const scope = periodScope(nodes, period.id, index);
    return units
      .filter((issue) => issue.period && scope.has(issue.period))
      .filter((issue) => !isTerminal(config, issue))
      .map((issue) => line(nodes, config, dependents, issue, index));
  };

  /*
   * The sprint that is running is the right answer only while it still has work
   * in it. On the last day of a finished one — or on any day of a board that is
   * between increments — "nothing to do" is true and useless, so the search
   * walks forward to the first period that has something, and says that it is
   * looking ahead.
   */
  const found = candidates.map((period) => ({ period, open: openIn(period) }));
  const chosen = found.find((entry) => entry.open.length) ?? found[0]!;
  const open = chosen.open;
  const covers = isRunning(nodes, chosen.period, today);

  const { increment, sprint } = placeOf(nodes, chosen.period, index);
  return {
    ...empty,
    increment,
    sprint,
    upcoming: !covers,
    ...summarise(nodes, config, open, limit, index),
  };
}

/** What is moving, what is ready and what waits, among the open work of one run. */
function summarise(
  nodes: WorkingNodes,
  config: ConfigDto,
  open: TaskLine[],
  limit: number,
  index?: NodeIndex,
): Pick<Focus, 'active' | 'ready' | 'blocked' | 'open' | 'effort'> {
  const started = open.filter((entry) => isActive(config, entry.issue));
  const waiting = open.filter((entry) => !isActive(config, entry.issue));
  const ready = waiting
    .filter((entry) => !entry.blockedBy.length)
    .sort(byReadiness(config, cohesionOrder(nodes, config, index)));
  return {
    active: started.sort((a, b) => b.unblocks - a.unblocks),
    ready: ready.slice(0, limit),
    blocked: waiting.length - ready.length,
    open: open.length,
    effort: open.reduce((total, entry) => total + entry.effort, 0),
  };
}

/**
 * The engine's order with the schedule taken out: everything here is already in
 * the same period, so what is left is priority, then how far along the board it
 * is, then which feature is already under way, then how much it unblocks.
 */
function byReadiness(config: ConfigDto, stayPut: (a: IssueDto, b: IssueDto) => number) {
  return (a: TaskLine, b: TaskLine): number =>
    priorityRank(config, a.issue) - priorityRank(config, b.issue) ||
    statusRank(config, a.issue) - statusRank(config, b.issue) ||
    stayPut(a.issue, b.issue) ||
    b.unblocks - a.unblocks ||
    idSerial(a.issue.id) - idSerial(b.issue.id);
}

/** The issues most recently written to the board, newest first. */
export function latestIssues(nodes: WorkingNodes, limit = DEFAULT_LIMIT): IssueDto[] {
  return nodesOfKind(nodes, 'issue')
    .slice()
    .sort(byRecency((node) => node.created ?? node.updated))
    .slice(0, limit);
}

/**
 * Epics and features that could be started, judged by the graph rather than by
 * the calendar.
 *
 * A container is a pathway when nothing it rests on is unfinished — not its own
 * dependencies and not those of anything inside it — and at least one work unit
 * under it could be picked up today. Ordering is by how much finishing it would
 * release: an epic that four other epics are waiting on is the one to start,
 * whatever the sprint board says.
 *
 * A work unit is never a pathway *into* itself, so an `atomic` story with
 * sub-tasks is offered as work rather than listed here as somewhere to start.
 */
export function openPathways(
  nodes: WorkingNodes,
  config: ConfigDto,
  limit = DEFAULT_LIMIT,
  index?: NodeIndex,
): Pathway[] {
  const dependents = dependentsIndex(nodes, index);
  const containers = nodesOfKind(nodes, 'issue').filter(
    (issue) => childrenOf(nodes, issue.id, index).length > 0 && !isWorkUnit(nodes, config, issue, index),
  );

  const pathways: Pathway[] = [];
  for (const issue of containers) {
    const inside = new Set(subtreeIds(nodes, issue.id, index));
    const members = [...inside]
      .map((id) => nodes[id])
      .filter((node): node is IssueDto => node?.kind === 'issue');
    const open = workUnitsUnder(nodes, config, issue.id, index).filter(
      (unit) => !isTerminal(config, unit),
    );
    if (!open.length) continue;

    // A dependency on something inside the subtree is this pathway's own
    // business — it is the order the work is done in, not a reason to wait.
    const held = members.some((node) =>
      blockersOf(nodes, config, node, index).some((blocker) => !inside.has(blocker.id)),
    );
    if (held) continue;

    // "Ready" means somebody could take it, so work already under way does not
    // count — that is what `started` is for. A pathway whose whole remainder is
    // in flight has nothing to offer and drops out of the list.
    const ready = open.filter(
      (unit) => !isActive(config, unit) && !blockersOf(nodes, config, unit, index).length,
    );
    if (!ready.length) continue;

    pathways.push({
      issue,
      open: open.length,
      ready: ready.length,
      effort: open.reduce((total, unit) => total + issueEffort(config, unit), 0),
      unblocks: members.reduce(
        (total, node) =>
          total + (dependents[node.id] ?? []).filter((id) => !inside.has(id)).length,
        0,
      ),
      started: members.some((node) => isActive(config, node)),
    });
  }

  // The deepest containers are the most concrete, so a feature is offered ahead
  // of the epic that holds it when both are equally unblocking.
  return pathways
    .sort(
      (a, b) =>
        b.unblocks - a.unblocks ||
        b.issue.depth - a.issue.depth ||
        b.ready - a.ready ||
        idSerial(a.issue.id) - idSerial(b.issue.id),
    )
    .slice(0, limit);
}
