import type { BoardPaths } from '../../core/index.js';
import { clearFlag, currentUser, findIssue, flagIssue, loadBoard } from '../../core/index.js';
import { pullBeforeWrite } from '../git.js';
import { HttpError, readJson, sendJson } from '../http/respond.js';
import type { Router } from '../http/router.js';

/**
 * Flags, like comments, are written immediately rather than queued in the view.
 *
 * Everything else the app changes is staged and pushed deliberately, because it
 * changes the plan. A flag says work has stopped **now** — holding that back
 * until somebody presses Push would be holding back the one edit that cannot
 * wait, and it is a request addressed to whoever is reading the board rather
 * than a change to what the board says should be built.
 *
 * One endpoint rather than two, because raising and clearing are the same
 * decision written in two directions: `reason: null` clears. Both need a
 * comment, and core is what insists on it.
 */
export function flagRoutes(router: Router, paths: BoardPaths): void {
  router.post('/api/documents/:id/flag', async ({ req, res, params }) => {
    const body = await readJson<{ reason?: string | null; comment?: string }>(req);
    if (!body.comment?.trim()) throw new HttpError(400, 'A flag needs a comment');

    pullBeforeWrite(paths);
    const board = loadBoard(paths);
    const issue = findIssue(board, params.id!);
    if (!issue) throw new HttpError(404, `No issue with id "${params.id}"`);

    // Signed as whoever this checkout is, so the note names the team member
    // rather than whatever git happens to be configured with.
    const user = currentUser(board);
    const author = user?.resource ? `${user.resource.title} (${user.resource.id})` : undefined;

    const result =
      body.reason === null
        ? clearFlag(board, issue, { comment: body.comment, author })
        : flagIssue(board, issue, { reason: body.reason, comment: body.comment, author });

    sendJson(res, 200, { id: issue.id, flag: result.flag, comment: result.comment });
  });
}
