import { readFileSync } from 'node:fs';
import type { NodeKind } from '../model/types.js';
import { writeFileAtomic } from './atomic.js';
import type { BoardPaths } from './paths.js';

export interface BoardState {
  /** Highest issue number handed out so far. */
  counter: number;
  /** Highest period number handed out so far. */
  period_counter: number;
  /** Highest resource number handed out so far. */
  resource_counter: number;
  /** Highest squad number handed out so far. */
  squad_counter: number;
  /** Highest registry template number handed out so far. */
  template_counter: number;
}

export type CounterField = keyof BoardState;

export function counterFor(kind: NodeKind): CounterField {
  if (kind === 'issue') return 'counter';
  if (kind === 'period') return 'period_counter';
  if (kind === 'resource') return 'resource_counter';
  return kind === 'template' ? 'template_counter' : 'squad_counter';
}

function readCounter(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

export function readState(paths: BoardPaths): BoardState {
  try {
    const parsed = JSON.parse(readFileSync(paths.statePath, 'utf8')) as Partial<BoardState>;
    return {
      counter: readCounter(parsed.counter),
      period_counter: readCounter(parsed.period_counter),
      resource_counter: readCounter(parsed.resource_counter),
      squad_counter: readCounter(parsed.squad_counter),
      template_counter: readCounter(parsed.template_counter),
    };
  } catch {
    // Missing or corrupt state is recoverable: `check --fix` rebuilds it.
    return {
      counter: 0,
      period_counter: 0,
      resource_counter: 0,
      squad_counter: 0,
      template_counter: 0,
    };
  }
}

export function writeState(paths: BoardPaths, state: BoardState): void {
  writeFileAtomic(paths.statePath, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Hand out `count` fresh ids from one of the counters, skipping any already in
 * use so a stale counter can never produce a duplicate.
 *
 * Read-modify-write, so it is only safe because every caller runs under the
 * board lock: two processes creating documents at the same moment would
 * otherwise both read counter 5 and both write 6, and the board would grow two
 * `LP-6` folders. The skip-what-exists rule below repairs a *stale* counter; it
 * cannot see an id another process is allocating this instant.
 * @see src/core/storage/lock.ts
 */
export function allocateIds(
  paths: BoardPaths,
  field: CounterField,
  prefix: string,
  count: number,
  taken: ReadonlySet<string>,
): string[] {
  const state = readState(paths);
  let counter = state[field];
  const ids: string[] = [];
  while (ids.length < count) {
    counter += 1;
    const id = `${prefix}-${counter}`;
    if (!taken.has(id)) ids.push(id);
  }
  writeState(paths, { ...state, [field]: counter });
  return ids;
}

/** Extract the numeric part of `LP-12`, or 0 when it does not match the prefix. */
export function numberOf(id: string, prefix: string): number {
  if (!prefix || !id.startsWith(`${prefix}-`)) return 0;
  const value = Number.parseInt(id.slice(prefix.length + 1), 10);
  return Number.isInteger(value) && value > 0 ? value : 0;
}
