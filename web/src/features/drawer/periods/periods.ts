import type { ConfigDto, IssueDto, PeriodDto } from '$shared';
import { DEFAULT_PERIOD_DAYS, nextPeriodAfter, shiftDate } from '$shared';
import {
  currentPeriodIds,
  holdsDate,
  periodStance,
  todayIso,
  type PeriodStance,
} from '$lib/board/periods.js';
import { isTerminal, issueEffort, isWorkUnit, nodesOfKind } from '$lib/board/selectors.js';
import type { WorkingNodes } from '$lib/board/working.js';

/**
 * The timeline as columns of work.
 *
 * The Gantt answers "when does this land?" and is deliberately read-only about
 * scheduling — it rolls dates up, it never writes one. This answers the other
 * half: *what is in this increment, and what is in this sprint?* Scheduling in
 * light-plan is a field on the issue rather than a list on the period, so the
 * whole view is one column per period plus a column for everything that is in
 * none, and moving a card between them is a single `period` update.
 *
 * The columns nest the way the periods do: a sprint's column is drawn *inside*
 * its increment's, because that containment is the thing a reader is checking
 * — is this quarter's work actually in its sprints? Flattening the tree and
 * indenting a header instead loses exactly that, so the shape here is a tree
 * and the component recurses over it.
 *
 * A period holds work at every level, not only at its leaves: an epic can be
 * scheduled in the increment while its stories sit in the sprints. So every
 * column has its own list of cards *and* its children, and effort is reported
 * both ways — its own, and rolled up through the periods under it.
 */
export const UNSCHEDULED = '_none';

/**
 * The attribute every box carries, so a drag that started somewhere else can
 * find one.
 *
 * Dragging a card *inside* the drawer is ordinary HTML5 drag-and-drop and needs
 * none of this. But a node dragged off the canvas is a SvelteFlow pointer drag,
 * which has no drop targets at all — the canvas has to ask what is under the
 * pointer. Keeping the attribute name and the lookup here means the convention
 * lives beside the component that emits it rather than in whatever feature
 * happens to be dragging.
 */
export const PERIOD_DROP_ATTRIBUTE = 'data-period-drop';

export interface PeriodDropTarget {
  /** The column's key, which is what lights it up. */
  key: string;
  /** The period to schedule into; null for the backlog box. */
  period: string | null;
}

/** The box at a point on screen, innermost first — a sprint, not its increment. */
export function periodDropAt(x: number, y: number): PeriodDropTarget | null {
  if (typeof document === 'undefined') return null;
  const box = document.elementFromPoint(x, y)?.closest(`[${PERIOD_DROP_ATTRIBUTE}]`);
  const key = box?.getAttribute(PERIOD_DROP_ATTRIBUTE);
  if (!key) return null;
  return { key, period: key === UNSCHEDULED ? null : key };
}

const DAY = 86_400_000;

const shift = (iso: string, days: number): string => shiftDate(iso, days);

const lengthOf = (period: PeriodDto): number => {
  if (!period.starts || !period.ends) return DEFAULT_PERIOD_DAYS;
  const days = Math.round((Date.parse(period.ends) - Date.parse(period.starts)) / DAY) + 1;
  return days > 0 ? days : DEFAULT_PERIOD_DAYS;
};

export interface PeriodEdit {
  id: string;
  patch: { starts?: string; ends?: string };
}

/** Every box in the board, so "collapse all" can reach the deep ones. */
export function columnKeys(board: PeriodBoard): string[] {
  const keys: string[] = [board.backlog.key];
  const walk = (column: PeriodColumn): void => {
    keys.push(column.key);
    for (const child of column.children) walk(child);
  };
  for (const root of board.roots) walk(root);
  return keys;
}

/**
 * Reordering periods, which on a board like this means moving their dates.
 *
 * A sprint has no "position" to change: the order sprints run in *is* their
 * dates, so dragging one above another has to rewrite windows. Two things are
 * kept while doing it, because they are what the calendar means:
 *
 *   - **each period keeps its own length** — a one-week sprint moved to the
 *     front is still a week, it does not inherit the fortnight it displaced;
 *   - **the gaps stay where they were** — a break between two sprints belongs
 *     to the calendar (a holiday, a release window), not to the sprint that
 *     happened to be before it.
 *
 * So the run of windows is rebuilt from the first one's start, in the new
 * order, with the same lengths and the same gaps between them.
 */
export function planResequence(
  nodes: WorkingNodes,
  movedId: string,
  targetId: string,
  today = todayIso(),
): PeriodEdit[] {
  const moved = nodes[movedId];
  const target = nodes[targetId];
  if (moved?.kind !== 'period' || target?.kind !== 'period') return [];
  if (movedId === targetId || moved.parentId !== target.parentId) return [];

  const siblings = nodesOfKind(nodes, 'period')
    .filter((period) => period.parentId === moved.parentId)
    .sort(byStart);

  const from = siblings.findIndex((period) => period.id === movedId);
  const to = siblings.findIndex((period) => period.id === targetId);
  if (from < 0 || to < 0 || from === to) return [];

  const reordered = siblings.slice();
  reordered.splice(to, 0, ...reordered.splice(from, 1));

  // The rhythm of the run as it stands: where it starts, and the gap after each
  // slot. Both belong to the calendar rather than to any one period.
  const first = siblings[0]!;
  const gaps = siblings.slice(0, -1).map((period, index) => {
    const next = siblings[index + 1]!;
    if (!period.ends || !next.starts) return 0;
    const days = Math.round((Date.parse(next.starts) - Date.parse(period.ends)) / DAY) - 1;
    return days > 0 ? days : 0;
  });

  const edits: PeriodEdit[] = [];
  let cursor = first.starts ?? today;
  reordered.forEach((period, index) => {
    const starts = cursor;
    const ends = shift(starts, lengthOf(period) - 1);
    if (starts !== period.starts || ends !== period.ends) {
      edits.push({ id: period.id, patch: { starts, ends } });
    }
    cursor = shift(ends, 1 + (gaps[index] ?? 0));
  });
  return edits;
}

/**
 * Switching a period on when today falls outside its dates: the timebox is
 * being reused, so the plan in it is worth keeping and the calendar around it
 * is not. The view asks rather than assumes, because a team that plans by date
 * may want the switch *without* moving anything — that is the whole point of
 * having two controls.
 */
export function needsFreshDates(period: PeriodDto, today = todayIso()): boolean {
  return !holdsDate(period, today);
}

/**
 * Dates for a period being added beside `siblings`, inside `parent`: it picks
 * up where the last one leaves off, and starts today when there is nothing to
 * follow — but never outside the period it is being added to.
 *
 * The parent is the load-bearing half. `createPeriod` *refuses* a child that
 * does not fit its parent's window, so a default worked out from the siblings
 * alone produced a document that could be drawn on screen and never pushed:
 * the first sprint in a quarter that has not begun took today, and today is
 * not in next year's quarter. It starts on the parent's first day instead, and
 * a run that has filled the parent is squeezed against its last day rather
 * than run past it — a short period a reader can widen beats a red push.
 */
export function nextPeriodDates(
  siblings: PeriodDto[],
  today = todayIso(),
  parent?: PeriodDto | null,
): { starts: string; ends: string } {
  const last = siblings
    .filter((period) => period.ends)
    .sort((a, b) => a.ends!.localeCompare(b.ends!))
    .at(-1);
  const length = last ? lengthOf(last) : DEFAULT_PERIOD_DAYS;
  let starts = last?.ends && last.ends >= today ? shift(last.ends, 1) : today;

  // A parent fences its children only when it has a whole window to fence with:
  // that is the same condition `createPeriod` checks, so the two agree about
  // when there is a rule to obey at all.
  if (!parent?.starts || !parent.ends || parent.ends < parent.starts) {
    return { starts, ends: shift(starts, length - 1) };
  }

  if (starts < parent.starts) starts = parent.starts;
  if (starts > parent.ends) starts = parent.ends;
  const ends = shift(starts, length - 1);
  return { starts, ends: ends > parent.ends ? parent.ends : ends };
}

export interface PeriodColumn {
  /** Period id, or `UNSCHEDULED` for the backlog column. */
  key: string;
  period: PeriodDto | null;
  depth: number;
  /** This period is the one running today — the innermost one that holds it. */
  current: boolean;
  /** Something inside it is running today, which is what lights an increment. */
  holdsCurrent: boolean;
  /**
   * Where the switch stands. `auto` is the ordinary answer; `off` is inherited
   * from an increment somebody parked, which is why it is read off the chain
   * rather than off this document.
   */
  stance: PeriodStance;
  /** Switched off on this very document, so the toggle here is what undid it. */
  switchedOff: boolean;
  /**
   * It ran out of calendar with work still in it: ended before today, and
   * holding issues nobody finished. Drawn in red, and the only state that
   * offers a correction.
   */
  overdue: boolean;
  /** Unfinished issues scheduled here — what a correction would act on. */
  open: IssueDto[];
  /** The period after this one, where carried-over work goes. Null for the last. */
  nextId: string | null;
  /** Issues scheduled directly in this period, parents before their children. */
  issues: IssueDto[];
  /**
   * Effort of the issues in this column. Leaves only, exactly as the roster
   * counts it: a feature and its stories in the same sprint are one piece of
   * work, not two.
   */
  effort: number;
  /** Effort in this column and in every period nested under it. */
  rolledEffort: number;
  /** Type a "new child" button on this column would create, if any. */
  childType: string | null;
  /** The periods nested inside this one, in date order. */
  children: PeriodColumn[];
}

export interface PeriodBoard {
  /** Everything in no period, drawn beside the tree rather than inside it. */
  backlog: PeriodColumn;
  /** Top-level periods, each holding the ones nested under it. */
  roots: PeriodColumn[];
  /** How many issues the board has no period for, before any filtering. */
  unscheduled: number;
  /** How many top-level periods were hidden by the archive filter. */
  hidden: number;
}

export interface PeriodBoardOptions {
  /** Show only issues whose title, id or type matches. */
  search?: string;
  /** `YYYY-MM-DD`. Passed in so a test can say what day it is. */
  today?: string;
  /** Sort direction for sibling periods. Defaults to newest-first. */
  newestFirst?: boolean;
  /**
   * Hide periods that have ended (past their end date with no unfinished work
   * anywhere under them) or are switched off. Default true; set to false to
   * show everything. A branch that has overrunning work anywhere inside it is
   * never hidden.
   */
  hideArchived?: boolean;
  /** Only periods owned by this squad (or with no squad assigned). */
  squadId?: string;
}

function matches(issue: IssueDto, needle: string): boolean {
  return (
    issue.title.toLowerCase().includes(needle) ||
    issue.id.toLowerCase().includes(needle) ||
    issue.type.toLowerCase().includes(needle)
  );
}

/** Periods read in time order, and by name when two start together. */
function byStart(a: PeriodDto, b: PeriodDto): number {
  const at = a.starts ?? '';
  const bt = b.starts ?? '';
  if (at && bt && at !== bt) return at < bt ? -1 : 1;
  if (at && !bt) return -1;
  if (!at && bt) return 1;
  return a.title.localeCompare(b.title);
}

/** Parents before children, so a feature sits above the stories under it. */
function byDepthThenTitle(a: IssueDto, b: IssueDto): number {
  return a.depth - b.depth || a.title.localeCompare(b.title);
}

export function buildPeriodBoard(
  nodes: WorkingNodes,
  config: ConfigDto,
  options: PeriodBoardOptions = {},
): PeriodBoard {
  const needle = options.search?.trim().toLowerCase() ?? '';
  const today = options.today ?? todayIso();
  const newestFirst = options.newestFirst !== false; // default true
  const hideArchived = options.hideArchived !== false; // default true
  const current = currentPeriodIds(nodes, today);
  const periods = nodesOfKind(nodes, 'period');
  const issues = nodesOfKind(nodes, 'issue');
  // Effort is summed over work units, so a container never double-counts what is
  // under it and an `atomic` story never double-counts its own sub-tasks.
  const carriesEffort = (issue: IssueDto): boolean => isWorkUnit(nodes, config, issue);

  const scheduled = new Map<string, IssueDto[]>();
  const issuesByPeriod = new Map<string, IssueDto[]>();
  const loose: IssueDto[] = [];
  for (const issue of issues) {
    if (issue.period) {
      issuesByPeriod.set(issue.period, [...(issuesByPeriod.get(issue.period) ?? []), issue]);
    }
    if (needle && !matches(issue, needle)) continue;
    if (issue.period && nodes[issue.period]?.kind === 'period') {
      scheduled.set(issue.period, [...(scheduled.get(issue.period) ?? []), issue]);
    } else {
      loose.push(issue);
    }
  }

  const effortOf = (list: IssueDto[]): number =>
    list.filter(carriesEffort).reduce((total, issue) => total + issueEffort(config, issue), 0);

  const backlog: PeriodColumn = {
    key: UNSCHEDULED,
    period: null,
    depth: 0,
    current: false,
    holdsCurrent: false,
    stance: 'auto',
    switchedOff: false,
    overdue: false,
    open: [],
    nextId: null,
    issues: loose.slice().sort(byDepthThenTitle),
    effort: effortOf(loose),
    rolledEffort: effortOf(loose),
    childType: null,
    children: [],
  };

  const childPeriods = (id: string | null): PeriodDto[] => {
    const sorted = periods.filter((period) => period.parentId === id).sort(byStart);
    return newestFirst ? sorted.reverse() : sorted;
  };

  // A hand-edited board can point a period at itself or at its own child; the
  // walk would never come back, so an id is only ever visited once.
  const seen = new Set<string>();
  const walk = (period: PeriodDto, depth: number): PeriodColumn => {
    seen.add(period.id);
    const here = scheduled.get(period.id) ?? [];
    const children = childPeriods(period.id)
      .filter((child) => !seen.has(child.id))
      .map((child) => walk(child, depth + 1));

    const effort = effortOf(here);
    // Unfinished work is counted off the *board*, not off the filtered cards:
    // a search that hides a story must not talk a sprint out of being late.
    const open = (issuesByPeriod.get(period.id) ?? []).filter(
      (issue) => !isTerminal(config, issue),
    );
    return {
      key: period.id,
      period,
      depth,
      current: current.has(period.id),
      holdsCurrent: children.some((child) => child.current || child.holdsCurrent),
      stance: periodStance(nodes, period.id),
      switchedOff: period.active === false,
      overdue: Boolean(period.ends && period.ends < today) && open.length > 0,
      open,
      nextId: nextPeriodAfter({ config, nodes }, period.id)?.id ?? null,
      issues: here.slice().sort(byDepthThenTitle),
      effort,
      rolledEffort: children.reduce((total, child) => total + child.rolledEffort, effort),
      childType: config.hierarchy.period[depth + 1]?.[0] ?? null,
      children,
    };
  };

  const rawRoots = childPeriods(null).map((root) => walk(root, 0));
  const { roots, hidden } = hideArchived ? pruneArchived(rawRoots, today) : { roots: rawRoots, hidden: 0 };
  const squadId = options.squadId;
  const filteredRoots = squadId ? roots.filter((root) => root.period?.squad === squadId) : roots;

  return {
    backlog,
    roots: filteredRoots,
    unscheduled: issues.filter((issue) => !issue.period || !nodes[issue.period]).length,
    hidden,
  };
}

/**
 * Prune branches that are fully archived: the root period has ended (past its
 * end date with no unfinished work anywhere under it) or is switched off.  A
 * branch with overrunning work anywhere inside it is never hidden.
 *
 * Returns the kept roots and the count of hidden top-level periods.
 */
function pruneArchived(
  roots: PeriodColumn[],
  today: string,
): { roots: PeriodColumn[]; hidden: number } {
  const keep = (col: PeriodColumn): boolean => {
    // Switched-off periods are hidden unless something under them has open work.
    if (col.switchedOff || col.stance === 'off') {
      return col.open.length > 0 || col.children.some((child) => keep(child));
    }
    // Ended periods with no work open anywhere inside them are hidden.
    if (col.period?.ends && col.period.ends < today) {
      // An ended period with its own open work stays.
      if (col.open.length > 0) return true;
      // An ended period with an overdue child stays.
      if (col.children.some((child) => child.overdue)) return true;
      // An ended period with a non-archived child stays.
      if (col.children.some((child) => keep(child))) return true;
      return false;
    }
    // Current and future periods always stay.
    return true;
  };

  // Prune children recursively first — an archived child is removed.
  const prune = (cols: PeriodColumn[]): PeriodColumn[] =>
    cols
      .filter((col) => keep(col))
      .map((col) => ({ ...col, children: prune(col.children) }));

  const kept = prune(roots);
  return { roots: kept, hidden: roots.length - kept.length };
}

/**
 * The column key to scroll to so "now" is in view.
 *
 * The innermost period whose chain is current (the sprint, not the increment
 * around it); no current period falls back to the one nearest to today by
 * start date; none at all returns null — the caller keeps today's behaviour.
 */
export function currentColumnKey(board: PeriodBoard, today: string): string | null {
  const flatten = (columns: PeriodColumn[]): PeriodColumn[] =>
    columns.flatMap((col) => [col, ...flatten(col.children)]);
  const all = flatten(board.roots);

  // Innermost current period — deepest first.
  const current = all
    .filter((col) => col.current)
    .sort((a, b) => b.depth - a.depth);
  if (current.length) return current[0]!.key;

  // Fall back to the period nearest to today by start date.
  const byProximity = all
    .filter((col) => col.period?.starts)
    .sort(
      (a, b) =>
        Math.abs(a.period!.starts!.localeCompare(today)) -
        Math.abs(b.period!.starts!.localeCompare(today)),
    );
  return byProximity[0]?.key ?? null;
}
