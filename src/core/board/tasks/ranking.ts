import {
  effortAttributeOf,
  isActiveStatus,
  isTerminalStatus,
  priorityAttributeOf,
  prefixFor,
} from '../../config/lookup.js';
import type { Issue, Period, Resource } from '../../model/types.js';
import { numberOf } from '../../storage/state.js';
import type { BlockingLookup, UpstreamEntry } from '../../../shared/blocking.js';
import { blockerIds, upstreamWork } from '../../../shared/blocking.js';
import type { CohesionLookup } from '../../../shared/cohesion.js';
import { progressComparator } from '../../../shared/cohesion.js';
import type { LoadedBoard } from '../load.js';
import { isGenericResource, periodOf, periodStance, workUnits } from '../query.js';
import type { ResolvedScope } from '../scope.js';
import { inScope } from '../scope.js';

/**
 * "What should I work on?" — ranking work by schedule, priority, status and
 * how far along the part of the plan it sits in already is.
 * Everything here derives from the board plus the config; nothing writes.
 * `lpm task` and `lpm task next` are thin printers over these functions.
 */

export interface TaskOptions {
  /** Also consider issues nobody is assigned to. */
  includeUnassigned?: boolean;
  /**
   * Also consider work in a period somebody switched off. Off by default: the
   * switch means "not this one", so parked work is not offered until it is
   * asked for. It stays reachable by id, like everything else the switch and a
   * profile's scope steer — see `isParked`.
   */
  includeParked?: boolean;
  /** Today as YYYY-MM-DD. Injectable so recommendations are testable. */
  today?: string;
  limit?: number;
  /**
   * Only offer work inside this scope — the reader's profile, resolved. Omit
   * it for the whole board. It narrows what is *offered*: `currentTasks` and
   * `previousTasks` deliberately ignore it, because work already picked up
   * stays yours even if the scope it came from moves.
   */
  scope?: ResolvedScope | null;
  /**
   * Prefer work under this parent (by id) ahead of everything else, so a run
   * finishes the feature it is inside before starting another. This is the
   * emphatic form of the cohesion every ranking applies (`src/shared/cohesion.ts`
   * keeps a queue inside the containers already under way); it outranks even the
   * schedule, which is why it is off by default and only `lpm queue agent` sets
   * it, to the parent of the task it just finished.
   * It reorders what is *offered* and never widens it: the sibling still has to
   * be a ready, in-scope, routable work unit to be picked at all.
   */
  focusParent?: string | null;
}

/** How a piece of work reached the person being advised. */
export type TaskRoute = 'direct' | 'pool' | 'unassigned';

export interface TaskCandidate {
  issue: Issue;
  route: TaskRoute;
  /** The pool the work is parked in, when `route` is 'pool'. */
  pool: Resource | null;
  period: Period | null;
  /** Issues that must finish first. Empty for anything `nextTasks` returns. */
  blockedBy: Issue[];
}

function today(options: TaskOptions): string {
  return options.today ?? new Date().toISOString().slice(0, 10);
}

/**
 * The shape of the issue tree, which nothing about ranking changes.
 *
 * Both answers depend on the parenting and the config alone, never on a status,
 * so they are cached against the `issues` array they were derived from. That is
 * what makes `simulateQueue` affordable: its overlay builds a fresh array for
 * every step (see `withFinished`), so a changed board is a cache miss by
 * construction, and a board whose statuses moved on disk was reloaded into a
 * new array anyway. Nothing here may start reading `status`.
 */
interface IssueStructure {
  /** Parent id -> the ids directly inside it. */
  children: Map<string, string[]>;
  /** Ids the board offers as one piece of work. */
  units: Set<string>;
}

const structureCache = new WeakMap<Issue[], IssueStructure>();

function structureOf(board: LoadedBoard): IssueStructure {
  const cached = structureCache.get(board.issues);
  if (cached) return cached;

  const children = new Map<string, string[]>();
  for (const issue of board.issues) {
    if (!issue.parentId) continue;
    const list = children.get(issue.parentId);
    if (list) list.push(issue.id);
    else children.set(issue.parentId, [issue.id]);
  }

  const structure: IssueStructure = {
    children,
    units: new Set(workUnits(board).map((issue) => issue.id)),
  };
  structureCache.set(board.issues, structure);
  return structure;
}

/**
 * Adapt a `LoadedBoard` to the id-based lookup `src/shared/blocking.ts` reads.
 *
 * Exported because `validation/checks/dependencies.ts` runs the cycle check
 * over the *inherited* graph these rules produce, and a second adapter there
 * would be a second answer to "what gates this issue".
 */
export function blockingLookupFor(board: LoadedBoard): BlockingLookup {
  const { children, units } = structureOf(board);
  return {
    exists: (id) => board.byId.has(id),
    parentOf: (id) => board.byId.get(id)?.parentId ?? null,
    dependenciesOf: (id) => board.byId.get(id)?.depends_on ?? [],
    childIdsOf: (id) => children.get(id) ?? [],
    isTerminal: (id) => {
      const issue = board.byId.get(id);
      return issue ? isTerminalStatus(board.config, issue.status) : false;
    },
    isWorkUnit: (id) => units.has(id),
  };
}

/**
 * Adapt a `LoadedBoard` to the id-based lookup `src/shared/cohesion.ts` reads.
 *
 * It shares `structureOf` with the blocking lookup — the parenting and the
 * units are the same two questions — and reads the statuses live, which is why
 * it is built per sort rather than cached: `simulateQueue` moves the board on
 * between steps and the whole point of the rule is that it notices.
 */
function cohesionLookupFor(board: LoadedBoard): CohesionLookup {
  const { children, units } = structureOf(board);
  const statusOf = (id: string): string | null => board.byId.get(id)?.status ?? null;
  return {
    parentOf: (id) => board.byId.get(id)?.parentId ?? null,
    childIdsOf: (id) => children.get(id) ?? [],
    isWorkUnit: (id) => units.has(id),
    isTerminal: (id) => {
      const status = statusOf(id);
      return status ? isTerminalStatus(board.config, status) : false;
    },
    isActive: (id) => {
      const status = statusOf(id);
      return status ? isActiveStatus(board.config, status) : false;
    },
  };
}

/**
 * Issues that must be finished before `issue` can start, nearest cause first.
 *
 * Dependencies are inherited: an issue waits on everything its ancestors wait
 * on. A dependency on a container is cleared by the work inside it rather than
 * by the container's own status.
 *
 * @see src/shared/blocking.ts for the rules and why they are that way.
 */
export function blockersOf(board: LoadedBoard, issue: Issue): Issue[] {
  return blockerIds(issue.id, blockingLookupFor(board))
    .map((id) => board.byId.get(id))
    .filter((other): other is Issue => Boolean(other));
}

export function isBlocked(board: LoadedBoard, issue: Issue): boolean {
  return blockersOf(board, issue).length > 0;
}

/** An upstream issue with the document resolved. @see upstreamOf */
export interface UpstreamIssue extends UpstreamEntry {
  issue: Issue;
}

/**
 * Everything that has to be finished before `issue` can be, nearest cause
 * first — the whole chain, not just the nearest link of it.
 *
 * `blockersOf` says why the work cannot start today. This says what would have
 * to happen for it to be closed at all: what the blockers wait on, what those
 * wait on, and the open work inside each blocking container, which is what a
 * container amounts to and what somebody would actually be handed.
 *
 * Read-only, and it answers for the board as it stands — a dangling id blocks
 * nothing, exactly as it does for the queue.
 *
 * @see src/shared/blocking.ts for the rules and why they are that way.
 */
export function upstreamOf(board: LoadedBoard, issue: Issue): UpstreamIssue[] {
  const lookup = blockingLookupFor(board);
  const found: UpstreamIssue[] = [];
  for (const entry of upstreamWork(issue.id, lookup)) {
    const document = board.byId.get(entry.id);
    if (document) found.push({ ...entry, issue: document });
  }
  return found;
}

/**
 * Work sitting in a period somebody switched off — including one nested inside
 * a switched-off period, since `periodStance` cascades the way parking an
 * increment parks the sprints in it.
 *
 * This is the one definition of "parked", and `candidatesFor` is the one place
 * that acts on it, so `lpm task next`, `lpm task start`, MCP `next_tasks` and
 * `simulateQueue` cannot disagree about whether a parked sprint is on offer.
 */
export function isParked(board: LoadedBoard, issue: Issue): boolean {
  const period = periodOf(board, issue);
  return period ? periodStance(board, period) === 'off' : false;
}

/** Effort declared on an issue, when the board measures effort at all. */
export function effortOf(board: LoadedBoard, issue: Issue): number | null {
  if (!effortAttributeOf(board.config, issue.type)) return null;
  const value = issue.attributes[board.config.effort_attribute];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Position of an issue's priority in its type's enum, most important first.
 * Issues whose type declares no priority, or that left it empty, sort last.
 */
function priorityRank(board: LoadedBoard, issue: Issue): number {
  const def = priorityAttributeOf(board.config, issue.type);
  const values = def?.values;
  if (!values) return Number.MAX_SAFE_INTEGER;
  const value = issue.attributes[board.config.priority_attribute];
  const index = typeof value === 'string' ? values.indexOf(value) : -1;
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

/**
 * Work already under way ranks first, then unscheduled work, then work parked
 * in a period that has not started — so nobody is told to start next quarter's
 * sprint while this one is running. A period somebody has switched off ranks
 * below all of that: it is the one bucket a reader asked for by hand, and
 * putting it last is what makes the switch a way of steering the team.
 *
 * Note that a period which has merely *ended* still ranks first. Overrunning
 * work is the most urgent thing on the board, not the least, and only the
 * switch moves work down.
 */
function scheduleRank(board: LoadedBoard, issue: Issue, now: string): [number, string] {
  const period = periodOf(board, issue);
  if (!period) return [1, ''];

  const stance = periodStance(board, period);
  if (stance === 'off') return [3, period.starts ?? ''];
  if (stance === 'on') return [0, period.starts ?? ''];

  if (!period.starts) return [1, ''];
  return period.starts <= now ? [0, period.starts] : [2, period.starts];
}

function statusRank(board: LoadedBoard, issue: Issue): number {
  const index = board.config.statuses.findIndex((status) => status.id === issue.status);
  // Later columns are closer to done, so they come first.
  return index < 0 ? 0 : -index;
}

/** Whether an issue sits anywhere under `parentId`, walking the parent chain. */
function underParent(board: LoadedBoard, issue: Issue, parentId: string): boolean {
  const seen = new Set<string>();
  let current = issue.parentId;
  while (current && !seen.has(current)) {
    if (current === parentId) return true;
    seen.add(current);
    current = board.byId.get(current)?.parentId ?? null;
  }
  return false;
}

function compareCandidates(board: LoadedBoard, now: string, focusParent?: string | null) {
  const prefix = prefixFor(board.config, 'issue');
  const byProgress = progressComparator(cohesionLookupFor(board));
  return (a: TaskCandidate, b: TaskCandidate): number => {
    // Cohesion first: keep a run inside the current feature until it is done.
    // Absent focusParent, this is skipped and the order is exactly as before.
    if (focusParent) {
      const near = Number(underParent(board, b.issue, focusParent)) - Number(underParent(board, a.issue, focusParent));
      if (near !== 0) return near;
    }

    const [bucketA, startA] = scheduleRank(board, a.issue, now);
    const [bucketB, startB] = scheduleRank(board, b.issue, now);
    if (bucketA !== bucketB) return bucketA - bucketB;
    if (startA !== startB) return startA.localeCompare(startB);

    const priority = priorityRank(board, a.issue) - priorityRank(board, b.issue);
    if (priority !== 0) return priority;

    const status = statusRank(board, a.issue) - statusRank(board, b.issue);
    if (status !== 0) return status;

    // Stay inside the part of the plan that is already moving. Below the three
    // signals a person set by hand (the schedule, the priority, the column) and
    // above the graph heuristics, so it decides exactly the case it is for: two
    // otherwise indistinguishable stories in two unrelated features.
    // @see src/shared/cohesion.ts
    const ongoing = byProgress(a.issue.id, b.issue.id);
    if (ongoing !== 0) return ongoing;

    const unblocks =
      (board.dependents.get(b.issue.id)?.length ?? 0) -
      (board.dependents.get(a.issue.id)?.length ?? 0);
    if (unblocks !== 0) return unblocks;

    return numberOf(a.issue.id, prefix) - numberOf(b.issue.id, prefix);
  };
}

/**
 * The order the queue offers work in, applied to candidates that did not come
 * from `candidatesFor` — work already under way, say. Exported so a caller that
 * assembles its own list still ranks it the one way the board ranks work.
 */
export function rankCandidates(
  board: LoadedBoard,
  candidates: TaskCandidate[],
  options: TaskOptions = {},
): TaskCandidate[] {
  return [...candidates].sort(compareCandidates(board, today(options), options.focusParent));
}

/** How an issue is routed to a resource, or null when it is none of its business. */
function routeFor(
  board: LoadedBoard,
  issue: Issue,
  resource: Resource,
  options: TaskOptions,
): { route: TaskRoute; pool: Resource | null } | null {
  if (!issue.assignee) {
    return options.includeUnassigned ? { route: 'unassigned', pool: null } : null;
  }
  if (issue.assignee === resource.id) return { route: 'direct', pool: null };
  if (!resource.covers.includes(issue.assignee)) return null;

  const pool = board.resourcesById.get(issue.assignee) ?? null;
  return pool && isGenericResource(board, pool) ? { route: 'pool', pool } : null;
}

/**
 * How a piece of work reaches a resource, or null when it never does: assigned
 * to it, parked in a pool it covers, or assigned to nobody when the caller is
 * willing to consider that.
 *
 * The public face of the rule `candidatesFor` filters by. It answers *routing*
 * alone and says nothing about whether the work is ready, in scope or finished
 * — a caller explaining why something was never offered needs to separate those
 * reasons, and asking this is how it does so without restating the rule.
 */
export function routeOf(
  board: LoadedBoard,
  issue: Issue,
  resource: Resource,
  options: TaskOptions = {},
): { route: TaskRoute; pool: Resource | null } | null {
  return routeFor(board, issue, resource, options);
}

/** Everything a resource could pick up, blocked or not, in recommended order. */
function candidatesFor(
  board: LoadedBoard,
  resourceId: string,
  options: TaskOptions,
): TaskCandidate[] {
  const resource = board.resourcesById.get(resourceId);
  if (!resource) return [];

  const units = new Set(workUnits(board).map((issue) => issue.id));
  const candidates: TaskCandidate[] = [];

  for (const issue of board.issues) {
    if (!units.has(issue.id)) continue;
    if (isTerminalStatus(board.config, issue.status)) continue;
    if (isActiveStatus(board.config, issue.status)) continue;
    // A flag says this work has stopped and needs a person. Most flagged work
    // is in progress and excluded by the line above, but a flag can be raised
    // on anything unfinished — "blocked, do not start this" is exactly what a
    // planner writes on a backlog issue — and offering that as the next thing
    // to pick up contradicts the flag. It stays reachable by id, like
    // everything else the queue steers rather than hides.
    if (issue.flag) continue;
    if (options.scope && !inScope(options.scope, issue)) continue;
    if (!options.includeParked && isParked(board, issue)) continue;

    const route = routeFor(board, issue, resource, options);
    if (!route) continue;

    // Squad gate: when an issue's period is owned by a squad, only that
    // squad's members can be offered work from it. A period with no squad
    // is the normal case and applies no filter.
    if (issue.period) {
      const members = board.periodSquadMembers.get(issue.period);
      if (members && !members.has(resourceId)) continue;
    }

    candidates.push({
      issue,
      route: route.route,
      pool: route.pool,
      period: periodOf(board, issue),
      blockedBy: blockersOf(board, issue),
    });
  }

  return candidates.sort(compareCandidates(board, today(options), options.focusParent));
}

/** What to work on next: ready, unblocked work, best first. */
export function nextTasks(
  board: LoadedBoard,
  resourceId: string,
  options: TaskOptions = {},
): TaskCandidate[] {
  const ready = candidatesFor(board, resourceId, options).filter(
    (candidate) => !candidate.blockedBy.length,
  );
  return options.limit === undefined ? ready : ready.slice(0, Math.max(0, options.limit));
}

/** Work that would be next if something else were finished first. */
export function blockedTasks(
  board: LoadedBoard,
  resourceId: string,
  options: TaskOptions = {},
): TaskCandidate[] {
  return candidatesFor(board, resourceId, options).filter(
    (candidate) => candidate.blockedBy.length > 0,
  );
}

/**
 * Work this resource has already picked up and may carry straight on with.
 *
 * The queue never offers what has been picked up — `candidatesFor` skips an
 * active status, because a thing in progress is not a thing to start. That
 * leaves a hole for anything working the queue on its own: a run that only ever
 * asked `nextTasks` could never come back to a task it left half-finished, so
 * one interrupted task dammed the board and everything waiting on it was
 * blocked for ever. This is the one definition of "what may I carry on with",
 * called by `simulateQueue` to seed a run and by `lpm queue agent` to resume
 * one, so the prediction and the run cannot disagree about it.
 *
 * Two things are not resumable. A container somebody moved into an active
 * column is not a thing you pick up — its children are, and counting it would
 * double the work it stands for. And a **flag** ends the licence: it says the
 * work has stopped and needs a person, which is a decision no one-person run
 * is going to make on its own, so carrying on with it would assume away the
 * very thing holding the queue up.
 *
 * Like `currentTasks`, this ignores scope and the period switch: work already
 * picked up stays yours even if the queue that offered it has moved. It is
 * ranked but never truncated — the caller decides how much of it to take.
 */
export function resumableTasks(
  board: LoadedBoard,
  resourceId: string,
  options: TaskOptions = {},
): TaskCandidate[] {
  const units = new Set(workUnits(board).map((issue) => issue.id));
  const candidates = currentTasks(board, resourceId)
    .filter((issue) => units.has(issue.id))
    .filter((issue) => !issue.flag)
    .map((issue) => ({
      issue,
      route: 'direct' as TaskRoute,
      pool: null,
      period: periodOf(board, issue),
      blockedBy: blockersOf(board, issue),
    }));
  return rankCandidates(board, candidates, options);
}

/** What a resource is working on right now: assigned to it, in an active status. */
export function currentTasks(board: LoadedBoard, resourceId: string): Issue[] {
  const resource = board.resourcesById.get(resourceId);
  if (!resource) return [];
  return board.issues.filter(
    (issue) => issue.assignee === resource.id && isActiveStatus(board.config, issue.status),
  );
}

/** What a resource finished most recently, newest first. */
export function previousTasks(board: LoadedBoard, resourceId: string, limit = 3): Issue[] {
  const resource = board.resourcesById.get(resourceId);
  if (!resource) return [];
  return board.issues
    .filter(
      (issue) => issue.assignee === resource.id && isTerminalStatus(board.config, issue.status),
    )
    .sort((a, b) => (b.updated ?? b.created ?? '').localeCompare(a.updated ?? a.created ?? ''))
    .slice(0, Math.max(0, limit));
}
