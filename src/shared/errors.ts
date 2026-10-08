/** The body of every non-2xx API response. */
export interface ApiErrorBody {
  error: string;
  /** The `details` of a BoardError: hints about how to fix it. */
  details?: string[];
}

/** One failed change in a push, reported alongside the ones that succeeded. */
export interface PushFailure {
  /** Id of the change that failed, temporary ids included. */
  id: string;
  error: string;
  details?: string[];
}

/**
 * The distinct reasons a push was rejected, in the order they were hit.
 *
 * One bad change holds up every change that referenced it: a sprint the board
 * refuses takes down the eighty issues scheduled into it, and a list of eighty-
 * one lines buries the one thing that actually went wrong under eighty copies
 * of its consequence. Grouping by message puts the cause on the first line and
 * says how much rode on it.
 */
export function summarizePushFailures(failures: PushFailure[], limit = 6): string[] {
  const grouped = new Map<string, string[]>();
  for (const failure of failures) {
    const ids = grouped.get(failure.error);
    if (ids) ids.push(failure.id);
    else grouped.set(failure.error, [failure.id]);
  }
  const lines = [...grouped].map(([error, ids]) =>
    ids.length === 1 ? `${ids[0]}: ${error}` : `${ids.length} changes — ${error}`,
  );
  return lines.length > limit
    ? [...lines.slice(0, limit), `…and ${lines.length - limit} more`]
    : lines;
}
