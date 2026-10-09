import type { BoardPaths } from '../../core/index.js';
import { currentUser, loadBoard } from '../../core/index.js';
import type { CurrentUserDto } from '../../shared/index.js';
import { sendJson } from '../http/respond.js';
import type { Router } from '../http/router.js';

/**
 * Who "me" is, for the queue panel's person filter. Read on every request
 * rather than at start-up, because `lpm user` can change the answer while the
 * server is running.
 */
export function meRoutes(router: Router, paths: BoardPaths): void {
  router.get('/api/me', ({ res }) => {
    const user = currentUser(loadBoard(paths));
    const body: CurrentUserDto = { id: user?.resource?.id ?? null, ref: user?.ref ?? null };
    sendJson(res, 200, body);
  });
}
