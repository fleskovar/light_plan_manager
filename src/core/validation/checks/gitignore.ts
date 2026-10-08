import path from 'node:path';
import type { LoadedBoard } from '../../board/load.js';
import type { Problem } from '../../model/types.js';
import { missingIgnoredEntries } from '../../storage/local.js';
import { displayPath } from '../../storage/paths.js';

/**
 * `.lpm/.gitignore` keeps per-checkout state out of the shared repo:
 * `local.json` (who is sitting at this machine), `credentials.json` (remote
 * tokens), the write lock and per-remote credential files. A board created
 * before one of those existed is missing the entry, and a committed token is
 * unrecoverable — so `check` reports the gap and `--fix` writes it.
 */
export function checkGitignore(board: LoadedBoard, problems: Problem[]): void {
  const missing = missingIgnoredEntries(board.paths);
  if (missing.length === 0) return;
  problems.push({
    level: 'warn',
    path: displayPath(board.paths, path.join(board.paths.lpmDir, '.gitignore')),
    message: `.gitignore does not ignore: ${missing.join(', ')}`,
    fixable: true,
  });
}
