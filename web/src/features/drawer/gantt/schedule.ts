import type { ConfigDto, IssueDto, NodeDto, PeriodDto } from '$shared';
import {
  childrenOf,
  isWorkUnit,
  nodesOfKind,
  statusTone,
  type StatusTone,
} from '$lib/board/selectors.js';
import type { WorkingNodes } from '$lib/board/working.js';
import type { NodeIndex } from '$lib/board/index.js';

/**
 * Laying the timeline out.
 *
 * light-plan schedules issues by putting them *in a period* rather than by
 * giving them dates, which is the agile way round and keeps the documents
 * honest. So a Gantt row for an issue borrows the dates of the period it is
 * scheduled in, and issues with no period land in an "unscheduled" bucket
 * instead of being silently dropped.
 *
 * Two things follow from that, and they are what the rows below are for:
 *
 *   - **A parent is dated by its children.** An epic scheduled nowhere, whose
 *     stories are spread over three sprints, has a perfectly good bar: the one
 *     that covers them. It is marked `rolled` so the chart can say so, and it
 *     is the only way to read a plan at more than one level at once.
 *   - **Rows nest, and nesting folds.** Collapsing an epic hides its stories
 *     behind that rolled-up bar rather than removing them from the picture,
 *     which is what makes a hundred-story board legible.
 *
 * Nothing here schedules anything: dates are read from the periods documents
 * say they are in, never inferred back onto a document. Rolling up is
 * reporting, in the same sense `lpm team` reports load without levelling it.
 */
export const DAY = 86_400_000;

/** Rows down the side: the period tree, or the issue tree. */
export type GanttGrouping = 'period' | 'hierarchy';

export interface GanttRow {
  /** Stable across rebuilds, and what folding is remembered against. */
  key: string;
  node: NodeDto;
  kind: 'period' | 'issue';
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
  /** Where the bar sits, as fractions of the chart width; null when undated. */
  bar: { offset: number; span: number } | null;
  /** The bar comes from what is under this row, not from its own period. */
  rolled: boolean;
  tone: StatusTone;
  critical: boolean;
  starts: string;
  ends: string;
}

export interface Timeline {
  start: number;
  end: number;
  rows: GanttRow[];
  /** Month boundaries for the header, as fractions of the width. */
  ticks: { label: string; offset: number }[];
  unscheduled: IssueDto[];
}

export interface TimelineOptions {
  grouping?: GanttGrouping;
  isCollapsed?: (key: string) => boolean;
}

/** Half-open: `to` is the day after the last day, so a one-day period has span. */
interface Span {
  from: number;
  to: number;
}

const parse = (iso: string | undefined): number | null => {
  if (!iso) return null;
  const time = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(time) ? time : null;
};

const iso = (time: number): string => new Date(time).toISOString().slice(0, 10);

const union = (a: Span | null, b: Span | null): Span | null => {
  if (!a) return b;
  if (!b) return a;
  return { from: Math.min(a.from, b.from), to: Math.max(a.to, b.to) };
};

function bounds(periods: PeriodDto[]): { start: number; end: number } {
  const starts = periods.map((period) => parse(period.starts)).filter((v): v is number => v !== null);
  const ends = periods.map((period) => parse(period.ends)).filter((v): v is number => v !== null);
  if (!starts.length || !ends.length) {
    const today = Date.now();
    return { start: today, end: today + 30 * DAY };
  }
  return { start: Math.min(...starts), end: Math.max(...ends) + DAY };
}

function monthTicks(start: number, end: number): { label: string; offset: number }[] {
  const ticks: { label: string; offset: number }[] = [];
  const total = end - start;
  const cursor = new Date(start);
  cursor.setUTCDate(1);
  cursor.setUTCHours(0, 0, 0, 0);

  while (cursor.getTime() <= end && ticks.length < 60) {
    const time = cursor.getTime();
    if (time >= start) {
      ticks.push({
        label: cursor.toLocaleDateString(undefined, { month: 'short', year: '2-digit' }),
        offset: (time - start) / total,
      });
    }
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return ticks;
}

export function buildTimeline(
  nodes: WorkingNodes,
  config: ConfigDto,
  critical: Set<string>,
  options: TimelineOptions = {},
  index?: NodeIndex,
): Timeline {
  const grouping = options.grouping ?? 'period';
  const isCollapsed = options.isCollapsed ?? (() => false);

  const periods = nodesOfKind(nodes, 'period');
  const issues = nodesOfKind(nodes, 'issue');
  const { start, end } = bounds(periods);
  const total = Math.max(end - start, DAY);

  const byTitle = (a: NodeDto, b: NodeDto): number => a.title.localeCompare(b.title);

  /** Period id -> the dates it gives to everything scheduled in it. */
  const dates = new Map<string, Span>();
  for (const period of periods) {
    const from = parse(period.starts);
    const to = parse(period.ends);
    if (from === null && to === null) continue;
    dates.set(period.id, { from: from ?? to!, to: (to ?? from!) + DAY });
  }

  // A timeline reads in time order, so periods go by when they start and fall
  // back on their name only when two start together (or neither has a date).
  const byStart = (a: PeriodDto, b: PeriodDto): number =>
    (dates.get(a.id)?.from ?? Infinity) - (dates.get(b.id)?.from ?? Infinity) ||
    a.title.localeCompare(b.title);

  const kids = new Map<string, IssueDto[]>();
  for (const issue of issues) {
    if (!issue.parentId) continue;
    kids.set(issue.parentId, [...(kids.get(issue.parentId) ?? []), issue]);
  }
  const childrenOfIssue = (id: string): IssueDto[] => (kids.get(id) ?? []).slice().sort(byTitle);

  const own = (issue: IssueDto): Span | null =>
    (issue.period ? dates.get(issue.period) : undefined) ?? null;

  /** An issue's own dates widened by everything underneath it. */
  const reach = new Map<string, Span | null>();
  const spanOf = (issue: IssueDto): Span | null => {
    const cached = reach.get(issue.id);
    if (cached !== undefined) return cached;
    // Guard against a parent cycle a hand-edited board could contain.
    reach.set(issue.id, null);
    let span = own(issue);
    for (const child of childrenOfIssue(issue.id)) span = union(span, spanOf(child));
    reach.set(issue.id, span);
    return span;
  };

  const place = (span: Span | null): { offset: number; span: number } | null =>
    span ? { offset: (span.from - start) / total, span: Math.max((span.to - span.from) / total, 0.004) } : null;

  const issueRow = (
    issue: IssueDto,
    depth: number,
    span: Span | null,
    hasChildren: boolean,
    rolled: boolean,
  ): GanttRow => ({
    key: `issue:${issue.id}`,
    node: issue,
    kind: 'issue',
    depth,
    hasChildren,
    collapsed: hasChildren && isCollapsed(`issue:${issue.id}`),
    bar: place(span),
    rolled,
    tone: statusTone(config, issue.status),
    critical: critical.has(issue.id),
    starts: span ? iso(span.from) : '',
    ends: span ? iso(span.to - DAY) : '',
  });

  const rows: GanttRow[] =
    grouping === 'hierarchy'
      ? hierarchyRows()
      : periodRows();

  /** The issue tree, every row dated by itself or by what is under it. */
  function hierarchyRows(): GanttRow[] {
    const out: GanttRow[] = [];
    const walk = (issue: IssueDto, depth: number): void => {
      const span = spanOf(issue);
      if (!span) return;
      const children = childrenOfIssue(issue.id).filter((child) => spanOf(child));
      const row = issueRow(issue, depth, span, children.length > 0, own(issue) === null);
      out.push(row);
      if (row.collapsed) return;
      for (const child of children) walk(child, depth + 1);
    };
    for (const root of issues.filter((issue) => !issue.parentId).sort(byTitle)) walk(root, 0);
    return out;
  }

  /**
   * The period tree, with the issues scheduled in each period nested by their
   * own hierarchy: a story sits under its feature when both are in the sprint,
   * and stands on its own when the feature is scheduled somewhere else.
   */
  function periodRows(): GanttRow[] {
    const out: GanttRow[] = [];
    const scheduledIn = new Map<string, IssueDto[]>();
    for (const issue of issues) {
      if (!issue.period) continue;
      scheduledIn.set(issue.period, [...(scheduledIn.get(issue.period) ?? []), issue]);
    }

    const addIssues = (periodId: string, depth: number): void => {
      const here = (scheduledIn.get(periodId) ?? []).slice().sort(byTitle);
      const inPeriod = new Set(here.map((issue) => issue.id));

      const anchor = (issue: IssueDto): string | null => {
        const seen = new Set([issue.id]);
        let parentId = issue.parentId;
        while (parentId && !seen.has(parentId)) {
          if (inPeriod.has(parentId)) return parentId;
          seen.add(parentId);
          parentId = nodes[parentId]?.parentId ?? null;
        }
        return null;
      };

      const nested = new Map<string | null, IssueDto[]>();
      for (const issue of here) {
        const parent = anchor(issue);
        nested.set(parent, [...(nested.get(parent) ?? []), issue]);
      }

      const walk = (issue: IssueDto, level: number): void => {
        const children = nested.get(issue.id) ?? [];
        const row = issueRow(issue, level, own(issue), children.length > 0, false);
        out.push(row);
        if (row.collapsed) return;
        for (const child of children) walk(child, level + 1);
      };

      for (const issue of nested.get(null) ?? []) walk(issue, depth);
    };

    const addPeriod = (period: PeriodDto, depth: number): void => {
      const span = dates.get(period.id) ?? null;
      const children = childrenOf(nodes, period.id, index).filter(
        (child): child is PeriodDto => child.kind === 'period',
      );
      const key = `period:${period.id}`;
      const hasChildren = children.length > 0 || (scheduledIn.get(period.id) ?? []).length > 0;
      const collapsed = hasChildren && isCollapsed(key);

      out.push({
        key,
        node: period,
        kind: 'period',
        depth,
        hasChildren,
        collapsed,
        bar: place(span),
        rolled: false,
        tone: 'todo',
        critical: false,
        starts: period.starts ?? '',
        ends: period.ends ?? '',
      });

      if (collapsed) return;
      addIssues(period.id, depth + 1);
      for (const child of children.sort(byStart)) addPeriod(child, depth + 1);
    };

    for (const period of periods.filter((entry) => entry.parentId === null).sort(byStart)) {
      addPeriod(period, 0);
    }
    return out;
  }

  // Work units that nothing dates: no period, or a period with no dates on it.
  const unscheduled = issues.filter((issue) => !own(issue) && isWorkUnit(nodes, config, issue, index));

  return { start, end, rows, ticks: monthTicks(start, end), unscheduled };
}

/** Every row key a chart can fold, for "collapse all". */
export function foldableKeys(timeline: Timeline): string[] {
  return timeline.rows.filter((row) => row.hasChildren).map((row) => row.key);
}

/**
 * Reading the chart at one level.
 *
 * "By period" nests two hierarchies inside each other — increments hold
 * sprints, sprints hold whatever issues are scheduled in them, and those nest
 * by their own levels again — so "show me this at sprint level" is the question
 * people actually ask, and folding row by row is a poor way to answer it. The
 * two hierarchies are laid end to end into one ranking, and a level is a rank
 * in it: everything at or below the chosen rank folds up.
 */
export interface GanttLevel {
  key: string;
  label: string;
  kind: 'period' | 'issue';
  /** Depth within its own hierarchy. */
  depth: number;
  /** Position in the combined ranking, which is what folding compares. */
  rank: number;
}

/** Where the issue hierarchy starts, once the period one is in front of it. */
function issueOffset(config: ConfigDto, grouping: GanttGrouping): number {
  return grouping === 'period' ? config.hierarchy.period.length : 0;
}

export function rowRank(config: ConfigDto, grouping: GanttGrouping, row: GanttRow): number {
  return row.kind === 'period'
    ? row.node.depth
    : issueOffset(config, grouping) + row.node.depth;
}

export function ganttLevels(config: ConfigDto, grouping: GanttGrouping): GanttLevel[] {
  const name = (types: string[]): string => {
    const labels = types.map((type) => config.types[type]?.label ?? type);
    return labels.length > 2 ? `${labels[0]}…` : labels.join(' / ');
  };

  const levels: GanttLevel[] = [];
  if (grouping === 'period') {
    for (const [depth, types] of config.hierarchy.period.entries()) {
      levels.push({ key: `period:${depth}`, label: name(types), kind: 'period', depth, rank: depth });
    }
  }
  for (const [depth, types] of config.hierarchy.issue.entries()) {
    levels.push({
      key: `issue:${depth}`,
      label: name(types),
      kind: 'issue',
      depth,
      rank: issueOffset(config, grouping) + depth,
    });
  }
  return levels;
}

/**
 * The keys to fold so the chart shows down to `rank` and no further. Give it a
 * fully expanded timeline: a row that is already folded away is still a row
 * that has to stay folded, or opening its parent would spill the whole subtree.
 */
export function foldToLevel(
  config: ConfigDto,
  grouping: GanttGrouping,
  timeline: Timeline,
  rank: number,
): Set<string> {
  return new Set(
    timeline.rows
      .filter((row) => row.hasChildren && rowRank(config, grouping, row) >= rank)
      .map((row) => row.key),
  );
}
