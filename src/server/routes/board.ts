import type { BoardPaths } from '../../core/index.js';
import { loadBoard } from '../../core/index.js';
import { toSnapshot } from '../../sync/dto.js';
import { pullInBackground } from '../git.js';
import { sendJson } from '../http/respond.js';
import type { Router } from '../http/router.js';

/**
 * Reading the board. There is exactly one endpoint because there is exactly one
 * thing the app wants: everything, as it stands on disk right now. Boards are
 * small enough that paging them would cost more than it saves.
 */
export function boardRoutes(router: Router, paths: BoardPaths): void {
  router.get('/api/board', ({ res }) => {
    // The app polls this, which makes it the place to keep a board shared
    // through git in step: a fetch starts in the background, and what it
    // brings is in the next poll's answer.
    pullInBackground(paths);
    sendJson(res, 200, toSnapshot(loadBoard(paths)));
  });
}
