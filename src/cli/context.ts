import type { BoardPaths, LoadedBoard } from '../core/index.js';
import { BOARD_ENV_VAR, BoardError, describePull, findBoardPaths, loadBoard, pullBoard } from '../core/index.js';
import { err, yellow } from './ui.js';

/**
 * What every command that has to find a board says when it cannot — one
 * message, so the way out of it is offered wherever the search ran.
 */
export function noBoardFound(...hints: string[]): BoardError {
  return new BoardError('No light-plan board found here or in any parent folder', [
    'Run `lpm init` to create one.',
    `Or set ${BOARD_ENV_VAR} to a .lpm folder to work on it from anywhere.`,
    ...hints,
  ]);
}

/** Whether this process has already said why it could not pull. */
let warned = false;

/**
 * Bring the board in from its git remote before reading it, when it is shared
 * through git; a no-op otherwise.
 *
 * Best effort, and that is deliberate: a command that only *reads* the board
 * should still answer offline, from the board as it was last pulled. What
 * stops a stale checkout writing over somebody else's work is not this pull but
 * the write transaction in core, which refuses at the push. This pull is what
 * makes that refusal rare. One warning per process, on stderr, so a piped
 * `lpm instructions` stays pure content.
 */
export function refreshBoard(paths: BoardPaths): void {
  let note: string | null;
  try {
    // A command that loads the board twice fetches once.
    note = describePull(pullBoard(paths, { maxAgeMs: 5_000 }));
  } catch (error) {
    note = error instanceof Error ? error.message : String(error);
  }
  if (note && !warned) {
    warned = true;
    err(`${yellow('git')} ${note}`);
  }
}

/**
 * The board `LPM_BOARD_PATH` names, else the one at or above the cwd — or fail
 * with a useful message. Pulled from its git remote first, when it has one.
 */
export function requireBoard(): LoadedBoard {
  const paths = findBoardPaths();
  if (!paths) throw noBoardFound();
  refreshBoard(paths);
  return loadBoard(paths);
}
