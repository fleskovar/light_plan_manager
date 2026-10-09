import { owningSquad, routeWork, type WorkRoute } from '$shared';
import type { ConfigDto, IssueDto, NodeDto, PeriodDto, ResourceDto, StatusDto } from '$shared';
import {
  blockersOf,
  cohesionOrder,
  dependentsIndex,
  idSerial,
  isActive,
  isTerminal,
  issueEffort,
  priorityRank,
  subtreeIds,
  workUnitsOf,
} from '$lib/board/selectors.js';
import type { WorkingNodes } from '$lib/board/working.js';
import type { NodeIndex } from '$lib/board/index.js';

/**
 * Planning without a calendar: the model behind the queue panel.
 *
 * Not every team runs sprints. Plenty of boards are a dependency graph and a
 * queue: you take the next thing nothing is blocking, you finish it, something
 * else becomes takeable. This is that board — the same three questions the
 * periods view answers, asked of the graph instead of of the dates.
 *
 * Three lanes, and the middle one is the only place work is *promised*:
 *
 *   - **Ready** — unstarted work units with no unfinished blocker, in the
 *     engine's own order: priority first, then how much finishing one would
 *     release.
 *   - **In progress** — whatever sits in a status the board calls active.
 *   - **Blocked** — unstarted work with a blocker, so the queue says why it is
 *     not offering something rather than silently dropping it.
 *
 * Work units only, exactly like `nextTasks` in the engine: a feature is not a
 * thing you pick up, it is the name of the stories you do, and what is inside an
 * `atomic` story is that story's checklist rather than its own card. Nothing
 * here writes; the panel turns a drop into one status change.
 */
export type Lane = 'ready' | 'active' | 'blocked';

export interface QueueCard {
  issue: IssueDto;
  /** Unfinished issues this one is waiting on, nearest cause first. */
  blockedBy: IssueDto[];
  /** How many issues would stop being blocked if this one were finished. */
  unblocks: number;
  effort: number;
  /** Ancestor titles, outermost first: the feature a story belongs to. */
  lineage: string[];
  /**
   * How the work reaches the resource the queue is narrowed to — assigned to
   * it, or parked in a pool it covers. Null on everybody's queue.
   */
  route: WorkRoute | null;
  /** The pool the work is parked in, when `route` is `pool`. */
  pool: ResourceDto | null;
}

/**
 * How much open work one resource's queue holds, against what it can take.
 *
 * Assigned and pooled effort are reported side by side and never added, for
 * the reason the Team view gives: work in a pool is offered to everyone who
 * covers it, so counting it against each of them would report the same story
 * several times over.
 */
export interface Workload {
  resource: ResourceDto;
  /** Open effort assigned to the resource directly. */
  assigned: number;
  /** Open effort waiting in the pools it covers. */
  pooled: number;
  /** How many open issues those are, for a board that measures no effort. */
  assignedIssues: number;
  pooledIssues: number;
  capacity: number;
}

/** One entry in the queue's "whose queue?" picker. */
export interface AudienceOption {
  /** A resource id, or null for everybody's queue. */
  id: string | null;
  label: string;
  group: 'everyone' | 'me' | 'people' | 'roles';
}

/**
 * Whose queue the panel can show: everybody's, then the current user's, then
 * each person and each pool (a role — "a QA engineer") by name. A pool's queue
 * is the work parked in it, which is what anybody covering it would be offered.
 */
export function audienceOptions(nodes: WorkingNodes, me: string | null): AudienceOption[] {
  const resources = Object.values(nodes)
    .filter((node): node is ResourceDto => node.kind === 'resource')
    .sort((a, b) => a.title.localeCompare(b.title));
  const self = me ? resources.find((resource) => resource.id === me) : undefined;
  const entry = (resource: ResourceDto, group: AudienceOption['group']): AudienceOption => ({
    id: resource.id,
    label: group === 'me' ? `Me — ${resource.title}` : resource.title,
    group,
  });
  return [
    { id: null, label: 'Everyone', group: 'everyone' },
    ...(self ? [entry(self, 'me')] : []),
    ...resources.filter((r) => !r.generic && r !== self).map((r) => entry(r, 'people')),
    ...resources.filter((r) => r.generic && r !== self).map((r) => entry(r, 'roles')),
  ];
}

export interface QueueBoard {
  ready: QueueCard[];
  active: QueueCard[];
  blocked: QueueCard[];
  /** Finished units, most recently touched first — the "done lately" tail. */
  done: QueueCard[];
  /** Every issue the queue could offer, before the search narrowed it. */
  total: number;
  /** The resource the queue is narrowed to, or null for everybody's. */
  forResource: ResourceDto | null;
  /** That resource's open work, or null for everybody's queue. */
  workload: Workload | null;
}

export interface QueueOptions {
  search?: string;
  /** How many finished issues to keep. The rest are history, not a queue. */
  doneLimit?: number;
  /**
   * Narrow the queue to one person or pool: what `lpm task next --user` would
   * offer it, what it has in progress, and what it finished. Absent, or naming
   * nobody on the roster, is everybody's queue.
   */
  resourceId?: string | null;
}

export const DONE_LIMIT = 8;

function matches(issue: IssueDto, needle: string): boolean {
  return (
    issue.title.toLowerCase().includes(needle) ||
    issue.id.toLowerCase().includes(needle) ||
    issue.type.toLowerCase().includes(needle)
  );
}

/** The status a card moves into when it is pulled, or finished. */
export function laneStatus(config: ConfigDto, lane: 'ready' | 'active' | 'done'): string | null {
  const first = (predicate: (status: StatusDto) => boolean): string | null =>
    config.statuses.find(predicate)?.id ?? null;
  if (lane === 'active') return first((status) => status.active);
  if (lane === 'done') return first((status) => status.terminal);
  // Back to the queue: the first column that is neither started nor finished.
  return first((status) => !status.active && !status.terminal) ?? config.defaultStatus;
}

export function buildQueue(
  nodes: WorkingNodes,
  config: ConfigDto,
  options: QueueOptions = {},
  index?: NodeIndex,
): QueueBoard {
  const needle = options.search?.trim().toLowerCase() ?? '';
  const dependents = dependentsIndex(nodes, index);
  const units = workUnitsOf(nodes, config, index);
  const focus = resourceNamed(nodes, options.resourceId);
  const routing = focus ? routingFor(nodes, focus) : null;

  const card = (issue: IssueDto): QueueCard => {
    const route = routing?.route(issue) ?? null;
    const pool = route === 'pool' ? (nodes[issue.assignee ?? ''] as ResourceDto) : null;
    return {
      issue,
      blockedBy: blockersOf(nodes, config, issue, index),
      unblocks: (dependents[issue.id] ?? []).length,
      effort: issueEffort(config, issue),
      lineage: lineageOf(nodes, issue),
      route,
      pool,
    };
  };

  /*
   * Narrowed to one resource, each section asks the engine's question for it:
   * in progress and finished are *its own* work (`currentTasks`,
   * `previousTasks`), and what is offered or waiting is whatever routes to it
   * — directly or through a pool — inside a sprint its squad may work in.
   */
  const mine = (issue: IssueDto): boolean => !focus || issue.assignee === focus.id;
  const routed = (issue: IssueDto): boolean => !routing || routing.offered(issue);

  const cards = units
    .filter((issue) => !needle || matches(issue, needle))
    .filter((issue) =>
      isTerminal(config, issue) || isActive(config, issue) ? mine(issue) : routed(issue),
    )
    .map(card);

  // Stay inside the feature that is already moving, exactly as the engine's
  // queue does: below the priority somebody set by hand, above the heuristics.
  // @see src/shared/cohesion.ts
  const stayPut = cohesionOrder(nodes, config, index);

  const byQueueOrder = (a: QueueCard, b: QueueCard): number =>
    priorityRank(config, a.issue) - priorityRank(config, b.issue) ||
    stayPut(a.issue, b.issue) ||
    b.unblocks - a.unblocks ||
    idSerial(a.issue.id) - idSerial(b.issue.id);

  const open = cards.filter((entry) => !isTerminal(config, entry.issue));
  const active = open.filter((entry) => isActive(config, entry.issue));
  const waiting = open.filter((entry) => !isActive(config, entry.issue));

  // The engine withholds work in a switched-off period from `nextTasks`
  // (isParked in `candidatesFor`, since 1ce4a73).  The Digest already does
  // the same; without this guard the Queue's Ready lane would offer work
  // that `lpm task next` refuses, which is exactly the disagreement
  // the board must never show.  Active work and blocked work are left alone:
  // hiding in-flight work would be worse than showing it, and blocked-in-
  // parked work may still be relevant to a planner looking at the queue.
  //
  // Walks the parent chain: parking an increment parks its sprints too.
  const parked = (issue: IssueDto): boolean => {
    if (!issue.period) return false;
    const seen = new Set<string>();
    let current: string | null = issue.period;
    while (current && !seen.has(current)) {
      seen.add(current);
      const period: NodeDto | undefined = nodes[current];
      if (!period || period.kind !== 'period') break;
      if ((period as { active?: boolean | null }).active === false) return true;
      current = period.parentId;
    }
    return false;
  };

  // A flag withholds work whatever column it sits in, as `candidatesFor` does:
  // it says the work has stopped and needs a person. It is listed as waiting
  // rather than dropped, so the queue says why it is not offering it.
  const held = (entry: QueueCard): boolean => entry.blockedBy.length > 0 || !!entry.issue.flag;
  const ready = waiting.filter((entry) => !held(entry) && !parked(entry.issue));

  return {
    ready: ready.sort(byQueueOrder),
    active: active.sort(byQueueOrder),
    blocked: waiting.filter(held).sort(byQueueOrder),
    done: cards
      .filter((entry) => isTerminal(config, entry.issue))
      .sort((a, b) =>
        (b.issue.updated ?? b.issue.created ?? '').localeCompare(
          a.issue.updated ?? a.issue.created ?? '',
        ),
      )
      .slice(0, options.doneLimit ?? DONE_LIMIT),
    total: units.length,
    forResource: focus,
    workload: focus && routing ? workloadOf(units, config, focus, routing) : null,
  };
}

/**
 * Who starting a card in a narrowed queue should assign it to, or null to
 * leave the assignee alone.
 *
 * Starting work from somebody's queue means *they* are taking it, which is what
 * `lpm task start` writes too: work parked in a pool they cover becomes theirs,
 * or it would leave their queue the moment it started. A pool's own queue has
 * nobody to hand the work to, so it stays where it is.
 */
export function claimantFor(issue: IssueDto, forResource: ResourceDto | null): string | null {
  if (!forResource || forResource.generic || issue.assignee === forResource.id) return null;
  return forResource.id;
}

function resourceNamed(nodes: WorkingNodes, id: string | null | undefined): ResourceDto | null {
  const node = id ? nodes[id] : undefined;
  return node?.kind === 'resource' ? node : null;
}

interface Routing {
  /** How work reaches the resource, ignoring whether it is ready. */
  route(issue: IssueDto): WorkRoute | null;
  /** Whether the queue would offer it to the resource at all. */
  offered(issue: IssueDto): boolean;
}

/**
 * The engine's routing rule over the working copy: `routeWork` for whose work
 * it is, and the squad owning its sprint for whether this resource may take it.
 * @see src/shared/routing.ts
 */
function routingFor(nodes: WorkingNodes, resource: ResourceDto): Routing {
  const isPool = (id: string): boolean => {
    const node = nodes[id];
    return node?.kind === 'resource' && node.generic;
  };
  const periodOf = (id: string): PeriodDto | undefined => {
    const node = nodes[id];
    return node?.kind === 'period' ? node : undefined;
  };
  const squadAdmits = (issue: IssueDto): boolean => {
    if (!issue.period) return true;
    const squadId = owningSquad(issue.period, periodOf);
    const squad = squadId ? nodes[squadId] : undefined;
    // A squad the board no longer has filters nothing, exactly as in the engine.
    return squad?.kind !== 'squad' || squad.members.includes(resource.id);
  };
  const route = (issue: IssueDto): WorkRoute | null => routeWork(issue.assignee, resource, isPool);
  return { route, offered: (issue) => route(issue) !== null && squadAdmits(issue) };
}

function workloadOf(
  units: IssueDto[],
  config: ConfigDto,
  resource: ResourceDto,
  routing: Routing,
): Workload {
  const workload: Workload = {
    resource,
    assigned: 0,
    pooled: 0,
    assignedIssues: 0,
    pooledIssues: 0,
    capacity: resource.capacity,
  };
  for (const issue of units) {
    if (isTerminal(config, issue)) continue;
    const route = routing.route(issue);
    if (route === 'direct') {
      workload.assigned += issueEffort(config, issue);
      workload.assignedIssues += 1;
    } else if (route === 'pool' && routing.offered(issue)) {
      workload.pooled += issueEffort(config, issue);
      workload.pooledIssues += 1;
    }
  }
  return workload;
}

/**
 * The queue as it is read: one column, top to bottom.
 *
 * What is being worked on comes first, because it is the head of the queue —
 * the work that has already been taken off it. Then what comes next, in the
 * order it will be offered, which is the part of the panel people read for.
 * Then what is waiting, saying what it waits on, and last the tail of finished
 * work, folded because it is history rather than queue.
 */
export type SectionId = 'now' | 'next' | 'waiting' | 'done';

export interface QueueSection {
  id: SectionId;
  label: string;
  hint: string;
  cards: QueueCard[];
  /** The lane a card dropped here moves into, or null where a drop means nothing. */
  dropsInto: 'ready' | 'active' | 'done' | null;
  /** Whether the position in the queue is worth a number: only the line itself. */
  numbered: boolean;
  /** Folded until somebody opens it. */
  folded: boolean;
  empty: string;
}

export function queueSections(queue: QueueBoard): QueueSection[] {
  const whose = queue.forResource ? ` for ${queue.forResource.title}` : '';
  return [
    {
      id: 'now',
      label: 'In progress',
      hint: 'Being worked on',
      cards: queue.active,
      dropsInto: 'active',
      numbered: false,
      folded: false,
      empty: queue.forResource
        ? `${queue.forResource.title} has nothing in progress.`
        : 'Nothing started. Drag an issue here to start it.',
    },
    {
      id: 'next',
      label: 'Up next',
      hint: 'Ready to start, in the order the queue offers it',
      cards: queue.ready,
      dropsInto: 'ready',
      numbered: true,
      folded: false,
      empty: queue.total ? `Nothing ready${whose}.` : 'No issues yet.',
    },
    {
      id: 'waiting',
      label: 'Waiting',
      hint: 'Blocked by unfinished work, or flagged',
      cards: queue.blocked,
      // A blocked issue is blocked by the graph, not by its status: no drop
      // can put something here, only finishing what it waits on takes it out.
      dropsInto: null,
      numbered: false,
      folded: false,
      empty: `Nothing waiting${whose}.`,
    },
    {
      id: 'done',
      label: 'Recently finished',
      hint: 'The tail of the queue, newest first',
      cards: queue.done,
      dropsInto: 'done',
      numbered: false,
      folded: true,
      empty: 'Nothing finished yet.',
    },
  ];
}

/** The titles of the issues above this one, outermost first. */
function lineageOf(nodes: WorkingNodes, issue: IssueDto): string[] {
  const chain: string[] = [];
  const seen = new Set([issue.id]);
  let parentId = issue.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = nodes[parentId];
    if (!parent) break;
    chain.unshift(parent.title);
    parentId = parent.parentId;
  }
  return chain;
}

/**
 * What finishing this card would release: the issues waiting on it that have
 * nothing else unfinished in the way. It is the number that makes a queue an
 * order rather than a list.
 */
export function wouldRelease(
  nodes: WorkingNodes,
  config: ConfigDto,
  issue: IssueDto,
  index?: NodeIndex,
): IssueDto[] {
  const dependents = dependentsIndex(nodes, index);
  const finished = new Set(subtreeIds(nodes, issue.id, index));
  return (dependents[issue.id] ?? [])
    .map((id) => nodes[id])
    .filter((node): node is IssueDto => node?.kind === 'issue')
    .filter((waiting) =>
      blockersOf(nodes, config, waiting, index).every((blocker) => finished.has(blocker.id)),
    );
}
