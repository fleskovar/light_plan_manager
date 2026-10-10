import type { BoardPaths } from '../../core/index.js';
import { findResource, loadBoard, planningOf, setPlanning, simulateQueue } from '../../core/index.js';
import type { Planning, QueueSequenceDto } from '../../shared/index.js';
import { toQueueSequence } from '../../sync/dto.js';
import { pullBeforeWrite } from '../git.js';
import { HttpError, readJson, sendJson } from '../http/respond.js';
import type { Router } from '../http/router.js';

/**
 * The queue the panel down the left edge reads, and the switch above it.
 *
 * `GET /api/queue` is the engine's sequence — `simulateQueue`, which is
 * `lpm task next` asked again after every step — so the panel numbers its
 * cards in the order developers and agents will actually be handed the work.
 * Mirroring that ranking in the browser was tried and drifted (the panel left
 * out the schedule and the column); asking the engine cannot.
 *
 * `PUT /api/planning` switches the board between its periods and one queue.
 * Like a flag it is written straight through rather than queued in a view: it
 * is board config, not a change to the plan, and `setPlanning` touches no
 * document.
 */
export function planningRoutes(router: Router, paths: BoardPaths): void {
  router.get('/api/queue', ({ res, query }) => {
    const board = loadBoard(paths);
    const wanted = query.get('resource');
    // The editor shows the whole board whoever is looking, as the panel always
    // has: no profile scope, and nothing parked asked back for.
    const resource = wanted ? findResource(board, wanted) : null;
    if (wanted && !resource) throw new HttpError(404, `No resource with id "${wanted}"`);
    const body: QueueSequenceDto = toQueueSequence(board, simulateQueue(board, resource));
    sendJson(res, 200, body);
  });

  router.put('/api/planning', async ({ req, res }) => {
    const body = await readJson<{ planning?: string }>(req);
    if (body.planning !== 'periods' && body.planning !== 'queue') {
      throw new HttpError(400, 'planning must be "periods" or "queue"');
    }
    pullBeforeWrite(paths);
    const result = setPlanning(paths, body.planning);
    const planning: Planning = planningOf(loadBoard(paths).config);
    sendJson(res, 200, { planning, changed: result.changed });
  });
}
