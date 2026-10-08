import type { Change } from '../changes.js';
import type { ConfigDto, IssueDto, NodeDto, PeriodDto } from '../model.js';
import type { BoardView } from './reading.js';
import { create, fail, update } from './breakdown.js';
import type { Plan } from './breakdown.js';
import {
  nextPeriodAfter as sharedNextPeriodAfter,
} from '../period-query.js';
import type { DatedPeriod } from '../period-query.js';

// -- running the timeline ---------------------------------------------------

const DAY = 86_400_000;

/** How long a period runs when the board gives nothing to copy. */
export const DEFAULT_PERIOD_DAYS = 14;

const atUtc = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);

export const shiftDate = (iso: string, days: number): string =>
  new Date(atUtc(iso) + days * DAY).toISOString().slice(0, 10);

const lengthOf = (period: PeriodDto): number => {
  if (!period.starts || !period.ends) return DEFAULT_PERIOD_DAYS;
  const days = Math.round((atUtc(period.ends) - atUtc(period.starts)) / DAY) + 1;
  return days > 0 ? days : DEFAULT_PERIOD_DAYS;
};

/**
 * Dates that make a period the one running today, keeping how long it runs.
 *
 * "This is the sprint we are in now" is a thing teams say on a Monday that the
 * plan disagrees with, and correcting it by hand means working out two dates
 * and typing them. The length is taken from the period itself when it has one,
 * so starting a two-week sprint today ends it a fortnight from today.
 */
export function startNowDates(
  period: PeriodDto,
  today: string,
): { starts: string; ends: string } {
  return { starts: today, ends: shiftDate(today, lengthOf(period) - 1) };
}

/** Whether `today` falls inside a period. An open end runs on indefinitely. */
export function holdsDate(period: PeriodDto, today: string): boolean {
  if (!period.starts) return false;
  if (period.starts > today) return false;
  return !period.ends || period.ends >= today;
}

function periodsIn(view: BoardView): PeriodDto[] {
  return Object.values(view.nodes).filter((node): node is PeriodDto => node.kind === 'period');
}

/** A period and its ancestors, outermost first, guarded against a cycle. */
function periodChainOf(view: BoardView, id: string): PeriodDto[] {
  const chain: PeriodDto[] = [];
  const seen = new Set<string>();
  let current: string | null = id;
  while (current && !seen.has(current)) {
    seen.add(current);
    const node: NodeDto | undefined = view.nodes[current];
    if (node?.kind !== 'period') break;
    chain.unshift(node);
    current = node.parentId;
  }
  return chain;
}

/** Every period nested inside this one, at any depth. */
function periodsInside(view: BoardView, id: string): PeriodDto[] {
  const found: PeriodDto[] = [];
  const walk = (parentId: string): void => {
    for (const period of periodsIn(view)) {
      if (period.parentId !== parentId || period.id === id) continue;
      if (found.some((entry) => entry.id === period.id)) continue;
      found.push(period);
      walk(period.id);
    }
  };
  walk(id);
  return found;
}

/** A start-now plan, plus what a reader has to be told before it runs. */
export type StartNowPlan =
  | { ok: false; error: string; details?: string[] }
  | {
      ok: true;
      changes: Change[];
      created: string[];
      /** The dates the period itself takes. */
      starts: string;
      ends: string;
      /** Periods that were running today and are being closed to make room. */
      closing: PeriodDto[];
      /** Periods nested inside it, moved by the same number of days. */
      carried: PeriodDto[];
    };

/**
 * Everything "this is the sprint we are in now" actually means.
 *
 * Moving one timebox onto today is not enough on its own: the sprint that *was*
 * running still covers today, so the board would claim two; the increment
 * around the new dates may not reach them; and an increment dragged onto today
 * would leave its own sprints behind in last quarter, outside their parent. So
 * the move is planned as a whole — the period takes today, everything nested
 * inside it shifts by the same number of days so the run keeps its shape,
 * whatever was running is closed the day before, and the periods above stretch.
 *
 * It returns a plan rather than making the edits, because closing somebody
 * else's sprint is a real change and every caller asks first.
 */
export function planStartNow(view: BoardView, id: string, today: string): StartNowPlan {
  const refuse = (error: string): StartNowPlan => ({ ok: false, error });
  const target = view.nodes[id];
  if (!target) return refuse(`No document with id "${id}"`);
  if (target.kind !== 'period') return refuse(`${id} is a ${target.kind}, not a period`);

  const moved = startNowDates(target, today);
  const changes: Change[] = [update(view, id, moved)];
  const closing: PeriodDto[] = [];
  const carried: PeriodDto[] = [];

  const offset = target.starts
    ? Math.round((atUtc(moved.starts) - atUtc(target.starts)) / DAY)
    : 0;
  const inside = new Set(periodsInside(view, id).map((period) => period.id));
  const ancestors = new Set(periodChainOf(view, id).map((period) => period.id));

  for (const period of periodsIn(view)) {
    if (period.id === id) continue;

    // The whole run inside it travels together: sprint 1 still starts on day
    // one of the increment, and the gaps between them stay gaps.
    if (inside.has(period.id)) {
      if (!offset || !period.starts || !period.ends) continue;
      carried.push(period);
      changes.push(
        update(view, period.id, {
          starts: shiftDate(period.starts, offset),
          ends: shiftDate(period.ends, offset),
        }),
      );
      continue;
    }

    // A period above the one being started grows to hold its new dates.
    if (ancestors.has(period.id)) {
      const starts = !period.starts || period.starts > moved.starts ? moved.starts : period.starts;
      const ends = !period.ends || period.ends < moved.ends ? moved.ends : period.ends;
      if (starts !== period.starts || ends !== period.ends) {
        changes.push(update(view, period.id, { starts, ends }));
      }
      continue;
    }

    // Anything else that covers today stops covering it, or the board would
    // claim two current sprints. One that starts today or later is not in the
    // way and is left alone.
    if (
      period.depth === target.depth &&
      holdsDate(period, today) &&
      period.starts! < today
    ) {
      closing.push(period);
      changes.push(update(view, period.id, { ends: shiftDate(today, -1) }));
    }
  }

  return { ok: true, changes, created: [], starts: moved.starts, ends: moved.ends, closing, carried };
}

// -- correcting a period that overran --------------------------------------

/**
 * Issues scheduled *directly* in a period. Directly, because an overrun is
 * corrected one timebox at a time: an increment answers for its own epics and
 * the sprints inside it answer for their own stories, so a fix applied to a
 * quarter must not reach in and reschedule six sprints' worth of work.
 *
 * Works against the flat DTO record — direct-period only.
 * `src/core/board/query.ts` carries the engine's version, which adds an
 * `includeDescendants` option (default `true`) and guards a missing period.
 * They stay duplicated because the engine version's `subtreeOf` walk needs
 * the typed `LoadedBoard`. When one changes, the other must follow.
 */
export function issuesInPeriod(view: BoardView, periodId: string): IssueDto[] {
  return Object.values(view.nodes).filter(
    (node): node is IssueDto => node.kind === 'issue' && node.period === periodId,
  );
}

function isTerminal(config: ConfigDto, issue: IssueDto): boolean {
  return config.statuses.find((status) => status.id === issue.status)?.terminal === true;
}

/** Unfinished work sitting in a period — what an overrun is actually made of. */
export function openIssuesInPeriod(view: BoardView, periodId: string): IssueDto[] {
  return issuesInPeriod(view, periodId).filter((issue) => !isTerminal(view.config, issue));
}

/**
 * The period that comes after this one beside it, in date order.
 *
 * @see src/shared/period-query.ts for the single definition.
 */
export function nextPeriodAfter(view: BoardView, periodId: string): PeriodDto | null {
  const periods: DatedPeriod[] = Object.values(view.nodes)
    .filter((node): node is PeriodDto => node.kind === 'period')
    .map((entry) => ({ id: entry.id, parentId: entry.parentId, starts: entry.starts }));
  const result = sharedNextPeriodAfter(periods, periodId);
  return result ? (view.nodes[result.id] as PeriodDto | undefined) ?? null : null;
}

/**
 * Declare a period finished: everything open in it moves to a terminal status.
 *
 * One of the two honest answers to "this sprint ended and the work in it did
 * not". It is a *record* of what the team decided, not an achievement — which
 * is why it is offered beside carrying the work over rather than instead of it.
 */
export function planCompletePeriod(view: BoardView, periodId: string, status?: string): Plan {
  const period = view.nodes[periodId];
  if (!period) return fail(`No document with id "${periodId}"`);
  if (period.kind !== 'period') return fail(`${periodId} is a ${period.kind}, not a period`);

  const terminal = status ?? view.config.statuses.find((entry) => entry.terminal)?.id;
  if (!terminal) return fail('This board declares no terminal status');
  if (!view.config.statuses.some((entry) => entry.id === terminal)) {
    return fail(`Unknown status "${terminal}"`);
  }

  const open = openIssuesInPeriod(view, periodId);
  return {
    ok: true,
    created: [],
    changes: open.map((issue) => update(view, issue.id, { status: terminal })),
  };
}

/**
 * Carry a period's unfinished work into the next one, leaving what was finished
 * where it was.
 *
 * The other honest answer, and the one that keeps the plan true: the sprint
 * that ran holds what it actually delivered, and the rest moves one sprint
 * along. Nothing is invented to hold it — the increment is as long as it was,
 * so pushing work down the run is what makes the last sprint's backlog grow,
 * which is the fact a reader needs to see.
 */
export function planCarryOver(view: BoardView, periodId: string): Plan {
  const period = view.nodes[periodId];
  if (!period) return fail(`No document with id "${periodId}"`);
  if (period.kind !== 'period') return fail(`${periodId} is a ${period.kind}, not a period`);

  const next = nextPeriodAfter(view, periodId);
  if (!next) {
    return fail(`There is no period after ${period.title}`, [
      'Add one beside it, or mark the work complete where it is.',
    ]);
  }

  const open = openIssuesInPeriod(view, periodId);
  return {
    ok: true,
    created: [],
    changes: open.map((issue) => update(view, issue.id, { period: next.id })),
  };
}
