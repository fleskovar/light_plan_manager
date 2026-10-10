import type { BoardPaths } from '../../core/index.js';
import {
  defaultBoardTemplate,
  editBoardConfig,
  listBoardTemplates,
  removeBoardTemplate,
  saveBoardTemplate,
  setDefaultBoardTemplate,
  userDir,
} from '../../core/index.js';
import type {
  BoardTemplatesDto,
  ConfigEditRequest,
  ConfigEditResultDto,
  SaveBoardTemplateRequest,
} from '../../shared/index.js';
import { pullBeforeWrite } from '../git.js';
import { HttpError, readJson, sendJson } from '../http/respond.js';
import type { Router } from '../http/router.js';
import { renameViewTypes } from '../views/store.js';

/**
 * The routes behind File ▸ Board configuration.
 *
 * `POST /api/config/edits` changes the types, the statuses and the attributes
 * that `.lpm/config.yml` declares. Like the planning mode, the edits are
 * written straight through and are not queued in a view: they change the
 * vocabulary of the board, and `editBoardConfig` rewrites every document that
 * holds a renamed name in the same call. The route then renames the keys of
 * `display` in the view files, which core does not read.
 *
 * The four `/api/board-templates` routes read and write the user folder
 * (`~/.light-plan`), which holds the templates that `lpm init` accepts by name
 * and the template that `lpm init` uses by default. They change no board.
 */
export function configRoutes(router: Router, paths: BoardPaths): void {
  const templates = (): BoardTemplatesDto => ({
    templates: listBoardTemplates().map(({ name, source }) => ({ name, source })),
    default: defaultBoardTemplate(),
    folder: userDir(),
  });

  router.post('/api/config/edits', async ({ req, res }) => {
    const body = await readJson<Partial<ConfigEditRequest>>(req);
    if (!Array.isArray(body.edits) || body.edits.length === 0) {
      throw new HttpError(400, 'edits must be a list with at least one edit');
    }
    pullBeforeWrite(paths);
    const result: ConfigEditResultDto = editBoardConfig(paths, body.edits);
    renameViewTypes(paths, result.renamedTypes);
    sendJson(res, 200, result);
  });

  router.get('/api/board-templates', ({ res }) => {
    sendJson(res, 200, templates());
  });

  router.post('/api/board-templates', async ({ req, res }) => {
    const body = await readJson<Partial<SaveBoardTemplateRequest>>(req);
    if (typeof body.name !== 'string') throw new HttpError(400, 'name must be a string');
    saveBoardTemplate(paths, body.name.trim(), { overwrite: body.overwrite === true });
    sendJson(res, 200, templates());
  });

  router.put('/api/board-templates/default', async ({ req, res }) => {
    const body = await readJson<{ name?: unknown }>(req);
    if (typeof body.name !== 'string') throw new HttpError(400, 'name must be a string');
    setDefaultBoardTemplate(body.name);
    sendJson(res, 200, templates());
  });

  router.delete('/api/board-templates/:name', ({ res, params }) => {
    removeBoardTemplate(params.name!);
    sendJson(res, 200, templates());
  });
}
