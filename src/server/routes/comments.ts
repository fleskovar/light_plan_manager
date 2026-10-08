import type { BoardPaths } from '../../core/index.js';
import { addComment, listComments, loadBoard, removeComment } from '../../core/index.js';
import { pullBeforeWrite } from '../git.js';
import { HttpError, readJson, sendJson } from '../http/respond.js';
import type { Router } from '../http/router.js';

/**
 * Comments are the one part of a document the app writes immediately rather
 * than queueing.
 *
 * Everything else is staged in a view and pushed deliberately, because it
 * changes the plan. A comment is a record of something that already happened,
 * and holding it back until someone presses Push would be a good way to lose
 * it — so these endpoints go straight to disk, the way the CLI and the MCP
 * server do.
 */
export function commentRoutes(router: Router, paths: BoardPaths): void {
  router.get('/api/documents/:id/comments', ({ res, params }) => {
    sendJson(res, 200, { comments: listComments(loadBoard(paths), params.id!) });
  });

  router.post('/api/documents/:id/comments', async ({ req, res, params }) => {
    const body = await readJson<{ body?: string; author?: string }>(req);
    if (!body.body?.trim()) throw new HttpError(400, 'A comment cannot be empty');

    pullBeforeWrite(paths);
    const board = loadBoard(paths);
    const result = addComment(board, params.id!, { body: body.body, author: body.author });
    sendJson(res, 201, { comment: result.comment, total: result.total });
  });

  router.delete('/api/documents/:id/comments/:index', ({ res, params }) => {
    const index = Number(params.index);
    if (!Number.isInteger(index) || index < 1) throw new HttpError(400, 'Invalid comment number');
    pullBeforeWrite(paths);
    removeComment(loadBoard(paths), params.id!, index);
    sendJson(res, 200, { ok: true });
  });
}
