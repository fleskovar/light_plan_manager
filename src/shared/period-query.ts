/**
 * Common graph-walking queries against the timeline, written once against a
 * minimal structural interface so the engine and the planners cannot drift
 * apart.
 *
 * Both `src/shared/plans/timeline.ts` and `src/core/board/query.ts` call these
 * through thin adapters; neither imports anything from the other.
 */

/** The minimal shape `nextPeriodAfter` needs from a period. */
export interface DatedPeriod {
  id: string;
  parentId: string | null;
  starts?: string | null;
}

/**
 * The period that comes after this one beside it, in date order.
 *
 * Null for the last one in its parent — there is nowhere further to push, and
 * quietly falling back to unscheduled would lose work.
 */
export function nextPeriodAfter(
  periods: DatedPeriod[],
  periodId: string,
): DatedPeriod | null {
  const period = periods.find((entry) => entry.id === periodId);
  if (!period || !period.starts) return null;
  return (
    periods
      .filter(
        (other) =>
          other.id !== period.id &&
          other.parentId === period.parentId &&
          Boolean(other.starts) &&
          other.starts! > period.starts!,
      )
      .sort((a, b) => a.starts!.localeCompare(b.starts!))[0] ?? null
  );
}
