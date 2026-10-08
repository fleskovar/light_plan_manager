/**
 * The seam between a transport failure and a `BoardError` (LP-294).
 *
 * The transport layer may not import `src/core` (LP-293's isolation), so it
 * cannot throw a `BoardError` itself. Its failures surface as a `RemoteError`,
 * and this file wraps one into a `BoardError` whose hint list is the error's
 * own `hints()` — which is what makes the CLI print a failed sync the way it
 * prints every other failure: a headline plus actionable detail lines, never a
 * stack trace.
 */

import { BoardError } from '../core/errors.js';
import { BudgetExhaustedError, RemoteError } from './transport/index.js';

/**
 * Wrap a transport failure into a `BoardError`. `remoteName` is the
 * config-declared remote the request was talking to, so the headline says which
 * one failed when several are in play. Accepts a `RemoteError` or the budget's
 * `BudgetExhaustedError` — both carry a `hints()` list.
 */
export function toBoardError(
  error: RemoteError | BudgetExhaustedError,
  remoteName?: string,
): BoardError {
  const prefix = remoteName ? `remote "${remoteName}": ` : '';
  return new BoardError(`${prefix}${error.message}`, error.hints());
}
