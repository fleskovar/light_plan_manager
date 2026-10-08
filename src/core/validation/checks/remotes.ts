import {
  declaredScopes,
  scopeOverlaps,
  staleScopes,
} from '../../board/remote-scopes.js';
import type { LoadedBoard } from '../../board/load.js';
import type { Problem } from '../../model/types.js';
import { displayPath } from '../../storage/paths.js';

/**
 * The half of "two remotes may never claim the same document" that needs the
 * board tree.
 *
 * `config/schema.ts` refuses two equal scopes, and any scope alongside a
 * remote that claims the whole board, before the config will load at all.
 * What it cannot see is *nesting*: a remote on `LP-10` and another on the
 * `LP-42` inside it are two different ids, and only the tree says they are the
 * same work. A board reaches that state without anybody meaning to — an issue
 * is reparented under a scope root, or two branches each add a remote — so it
 * is reported here rather than only refused at `lpm remote add`.
 *
 * It is an **error**, not a warning: a document mirrored to two trackers is
 * filed twice and edited from two directions, and neither remote can see the
 * other to sort it out. It is not `fixable` — which remote should lose the
 * work is a decision about somebody's tracker, not a repair.
 */
export function checkRemoteScopes(board: LoadedBoard, problems: Problem[]): void {
  const remotes = declaredScopes(board.config.remotes);
  if (remotes.length === 0) return;

  const configPath = displayPath(board.paths, board.paths.configPath);

  for (const stale of staleScopes(board.issues, remotes)) {
    problems.push({
      level: 'warn',
      path: configPath,
      message: `remotes.${stale.name}.scope: "${stale.scope}" names no document, so this remote mirrors nothing`,
    });
  }

  for (const overlap of scopeOverlaps(board.issues, remotes)) {
    problems.push({
      level: 'error',
      path: configPath,
      message:
        `remotes: "${overlap.inner}" (scope ${overlap.innerScope}) is inside "${overlap.outer}" ` +
        `(scope ${overlap.outerScope}) — two remotes may not mirror the same work. ` +
        `Narrow one scope so they do not overlap, or remove one remote.`,
    });
  }
}
