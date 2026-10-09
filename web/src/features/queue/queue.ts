import type { ConfigDto, IssueDto, NodeDto, StatusDto } from '$shared';
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
}

export interface QueueBoard {
  ready: QueueCard[];
  active: QueueCard[];
  blocked: QueueCard[];
  /** Finished units, most recently touched first — the "done lately" tail. */
  done: QueueCard[];
  /** Every issue the queue could offer, before the search narrowed it. */
  total: number;
}

export interface QueueOptions {
  search?: string;
  /** How many finished issues to keep. The rest are history, not a queue. */
  doneLimit?: number;
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

  const card = (issue: IssueDto): QueueCard => ({
    issue,
    blockedBy: blockersOf(nodes, config, issue, index),
    unblocks: (dependents[issue.id] ?? []).length,
    effort: issueEffort(config, issue),
    lineage: lineageOf(nodes, issue),
  });

  const cards = units.filter((issue) => !needle || matches(issue, needle)).map(card);

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

  const ready = waiting.filter((entry) => !entry.blockedBy.length && !parked(entry.issue));

  return {
    ready: ready.sort(byQueueOrder),
    active: active.sort(byQueueOrder),
    blocked: waiting.filter((entry) => entry.blockedBy.length).sort(byQueueOrder),
    done: cards
      .filter((entry) => isTerminal(config, entry.issue))
      .sort((a, b) =>
        (b.issue.updated ?? b.issue.created ?? '').localeCompare(
          a.issue.updated ?? a.issue.created ?? '',
        ),
      )
      .slice(0, options.doneLimit ?? DONE_LIMIT),
    total: units.length,
  };
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
  return [
    {
      id: 'now',
      label: 'In progress',
      hint: 'Being worked on',
      cards: queue.active,
      dropsInto: 'active',
      numbered: false,
      folded: false,
      empty: 'Nothing started. Drag an issue here to start it.',
    },
    {
      id: 'next',
      label: 'Up next',
      hint: 'Ready to start, in the order the queue offers it',
      cards: queue.ready,
      dropsInto: 'ready',
      numbered: true,
      folded: false,
      empty: queue.total ? 'Nothing ready.' : 'No issues yet.',
    },
    {
      id: 'waiting',
      label: 'Waiting',
      hint: 'Blocked by unfinished work',
      cards: queue.blocked,
      // A blocked issue is blocked by the graph, not by its status: no drop
      // can put something here, only finishing what it waits on takes it out.
      dropsInto: null,
      numbered: false,
      folded: false,
      empty: 'Nothing blocked.',
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
