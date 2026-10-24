import path from 'node:path';
import type { BoardStore } from '../core/index.js';
import { BoardError, centralBoardsDir, centralStorePath } from '../core/index.js';
import { choose } from './prompt.js';

/**
 * Where a new board goes: `lpm init` and `lpm git join` ask the same question.
 *
 * A flag answers it. Without a flag, the question is asked only when a central
 * store is set and stdin is a terminal. A script or a CI job that runs either
 * command keeps getting a local board, as before the central store existed.
 */
export function chooseStore(root: string, central: boolean, local: boolean): BoardStore {
  if (central && local) throw new BoardError('Pass --central or --local, not both');
  if (central) return 'central';
  if (local) return 'local';
  const store = centralStorePath();
  if (store === null || !process.stdin.isTTY) return 'local';
  return choose<BoardStore>(
    `Create the board in the central store ${store}, or in this folder?`,
    [
      {
        value: 'central',
        label: 'Central store',
        detail: path.join(centralBoardsDir() ?? store, path.basename(root)),
      },
      { value: 'local', label: 'This folder', detail: path.join(root, '.lpm') },
    ],
    '--central or --local',
  );
}
