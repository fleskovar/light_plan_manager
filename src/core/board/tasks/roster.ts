import { isActiveStatus, isTerminalStatus } from '../../config/lookup.js';
import type { Issue, Period, Resource } from '../../model/types.js';
import type { LoadedBoard } from '../load.js';
import { isGenericResource, issuesInPeriod, workUnits } from '../query.js';
import { effortOf } from './ranking.js';

export interface LoadRow {
  /** The resource this row describes, or null for the unassigned bucket. */
  resource: Resource | null;
  generic: boolean;
  /** Full-time equivalents supplied. Zero for the unassigned bucket. */
  capacity: number;
  /** Issues not in a terminal status. */
  open: number;
  /** Issues in an active status. */
  wip: number;
  done: number;
  /** Total effort of the open issues; null when the board measures no effort. */
  effort: number | null;
  covers: string[];
  coveredBy: string[];
}

export interface LoadReport {
  rows: LoadRow[];
  unassigned: LoadRow;
  /** The period the report was scoped to, when one was given. */
  period: Period | null;
  /** Pools holding open work that no resource covers — nobody can pick it up. */
  uncovered: Resource[];
  totals: { capacity: number; open: number; wip: number; effort: number | null };
}

function emptyRow(board: LoadedBoard, resource: Resource | null): LoadRow {
  return {
    resource,
    generic: resource ? isGenericResource(board, resource) : false,
    capacity: resource ? resource.capacity : 0,
    open: 0,
    wip: 0,
    done: 0,
    effort: null,
    covers: resource ? [...resource.covers] : [],
    coveredBy: resource ? [...(board.coveredBy.get(resource.id) ?? [])] : [],
  };
}

function tally(board: LoadedBoard, row: LoadRow, issue: Issue): void {
  if (isTerminalStatus(board.config, issue.status)) {
    row.done += 1;
    return;
  }
  row.open += 1;
  if (isActiveStatus(board.config, issue.status)) row.wip += 1;
  const effort = effortOf(board, issue);
  if (effort !== null) row.effort = (row.effort ?? 0) + effort;
}

/**
 * Who is carrying how much. Optionally scoped to a period (including its child
 * periods), which is where over-commitment actually shows up.
 *
 * This is a load view, not a scheduler: it reports demand against declared
 * capacity and flags pools nobody can serve, and leaves the judgement to you.
 */
export function resourceLoad(
  board: LoadedBoard,
  options: { periodId?: string } = {},
): LoadReport {
  const period = options.periodId
    ? (board.periods.find((entry) => entry.id.toLowerCase() === options.periodId!.toLowerCase()) ??
      null)
    : null;

  // Only work units carry work: counting a feature as well as its stories would
  // report the same effort twice, and so would counting an `atomic` story
  // alongside the sub-tasks it was estimated to include.
  const units = workUnits(board);

  const scoped = period
    ? new Set(issuesInPeriod(board, period.id).map((issue) => issue.id))
    : null;
  const issues = scoped ? units.filter((issue) => scoped.has(issue.id)) : units;

  const rows = new Map<string, LoadRow>();
  for (const resource of board.resources) rows.set(resource.id, emptyRow(board, resource));
  const unassigned = emptyRow(board, null);

  for (const issue of issues) {
    const row = issue.assignee ? rows.get(issue.assignee) : unassigned;
    if (row) tally(board, row, issue);
  }

  const uncovered = board.resources.filter((resource) => {
    if (!isGenericResource(board, resource)) return false;
    if (!(rows.get(resource.id)?.open ?? 0)) return false;
    return (board.coveredBy.get(resource.id) ?? []).length === 0;
  });

  const list = [...rows.values()];
  const efforts = [...list, unassigned]
    .map((row) => row.effort)
    .filter((value): value is number => value !== null);

  return {
    rows: list,
    unassigned,
    period,
    uncovered,
    totals: {
      capacity: list.reduce((sum, row) => sum + row.capacity, 0),
      open: list.reduce((sum, row) => sum + row.open, 0) + unassigned.open,
      wip: list.reduce((sum, row) => sum + row.wip, 0),
      effort: efforts.length ? efforts.reduce((sum, value) => sum + value, 0) : null,
    },
  };
}
