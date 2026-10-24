import { readFileSync } from 'node:fs';
import type { LoadedBoard } from '../../board/load.js';
import type { Problem } from '../../model/types.js';
import { renderBoardIndex } from '../../operations/board-index.js';
import { displayPath } from '../../storage/paths.js';

/**
 * `INDEX.md` is generated, so the only thing to say about it is whether it
 * still matches the board. A merge, a hand edit or a pull from a version that
 * did not write one all land here, and `--fix` regenerates it.
 */
export function checkIndex(board: LoadedBoard, problems: Problem[]): void {
  let current: string | null = null;
  try {
    current = readFileSync(board.paths.indexPath, 'utf8');
  } catch {
    // Absent, which is exactly the stale case below.
  }
  // git with `core.autocrlf=true` checks the file out with CRLF line ends. The
  // content is the same, so only the line ends are not compared.
  if (current !== null && current.replace(/\r\n/g, '\n') === renderBoardIndex(board)) return;
  problems.push({
    level: 'warn',
    path: displayPath(board.paths, board.paths.indexPath),
    message: current === null ? 'index is missing' : 'index no longer matches the board',
    fixable: true,
  });
}
