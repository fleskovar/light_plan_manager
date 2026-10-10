import type { BoardPaths } from '../../core/index.js';
import { loadBoard, viewExists } from '../../core/index.js';
import type { ViewDocument } from '../../shared/index.js';
import { remapChanges } from '../../shared/index.js';
import { toSnapshot } from '../../sync/dto.js';
import { pullBeforeWrite } from '../git.js';
import { HttpError, readJson, sendJson } from '../http/respond.js';
import type { Router } from '../http/router.js';
import { applyChanges } from '../../sync/apply.js';
import { parseView } from '../views/schema.js';
import {
  createView,
  listViews,
  loadView,
  pruneView,
  removeView,
  saveView,
  updateView,
} from '../views/store.js';

/**
 * Views: the app's own state, and the one endpoint that writes to the board.
 *
 * `PUT` is the autosave and touches nothing but the view file. `POST /push` is
 * the deliberate one: it replays the view's pending changes onto the documents
 * and hands back both the outcome and a fresh board.
 */
export function viewRoutes(router: Router, paths: BoardPaths): void {
  router.get('/api/views', ({ res }) => {
    sendJson(res, 200, listViews(paths));
  });

  router.post('/api/views', async ({ req, res }) => {
    const body = await readJson<{ name?: string; mode?: string }>(req);
    if (!body.name) throw new HttpError(400, 'A view needs a name');
    if (body.mode !== undefined && body.mode !== 'board' && body.mode !== 'templates') {
      throw new HttpError(400, `Unknown view mode "${body.mode}"`);
    }
    sendJson(res, 201, createView(paths, body.name, body.mode ?? 'board'));
  });

  router.get('/api/views/:id', ({ res, params }) => {
    const view = loadView(paths, params.id!);
    sendJson(res, 200, pruneView(view, toSnapshot(loadBoard(paths))));
  });

  router.put('/api/views/:id', async ({ req, res, params }) => {
    const body = await readJson<unknown>(req);
    const view = parseView(body, params.id!);
    sendJson(res, 200, updateView(paths, view));
  });

  router.delete('/api/views/:id', ({ res, params }) => {
    removeView(paths, params.id!);
    sendJson(res, 200, { ok: true });
  });

  router.post('/api/views/:id/push', async ({ req, res, params }) => {
    const id = params.id!;
    const body = await readJson<{ view?: ViewDocument }>(req);
    // The client pushes the view it holds, so an autosave is never a
    // prerequisite for a push and the two can never disagree about the queue.
    const view = parseView(body.view ?? loadView(paths, id), id);

    pullBeforeWrite(paths);
    const result = applyChanges(paths, view.changes);
    // What the board rejected stays pending — but pointing at the ids the push
    // allocated, not at the `new:` ones it has just used up. A change left
    // naming a temporary id could never land again.
    const remaining = remapChanges(
      view.changes.filter((change) => !result.applied.includes(change.id)),
      result.idMap,
    );
    // A push from a window that still holds a deleted view writes the board
    // and leaves the view deleted.
    const pruned = pruneView({ ...view, changes: remaining }, result.board);
    const saved = viewExists(paths, id) ? saveView(paths, pruned) : pruned;

    sendJson(res, 200, {
      idMap: result.idMap,
      failures: result.failures,
      board: result.board,
      view: saved,
    });
  });
}
