import type { BoardPaths, LibraryDoc } from '../../core/index.js';
import {
  createLibraryDoc,
  displayPath,
  libraryDocExists,
  libraryReferrers,
  listLibraryDocs,
  moveLibraryDoc,
  readLibraryDoc,
  removeLibraryDoc,
  requireLibraryId,
  updateLibraryDoc,
} from '../../core/index.js';
import type { LibraryDocDto, LibraryDocPatch, LibraryEntryDto, LibraryMoveResultDto } from '../../shared/index.js';
import { readBoard } from '../board-cache.js';
import { pullBeforeWrite } from '../git.js';
import { HttpError, readJson, sendJson } from '../http/respond.js';
import type { Router } from '../http/router.js';

/**
 * The board library over HTTP, for the Library dialog of the web app:
 *
 * | Route | Body | Answer |
 * | --- | --- | --- |
 * | `GET /api/library` | — | `LibraryEntryDto[]`, sorted by id |
 * | `GET /api/library/:id` | — | `LibraryDocDto` |
 * | `POST /api/library` | `{ id, title?, description?, body? }` | 201 and the new `LibraryDocDto` |
 * | `PUT /api/library/:id` | `LibraryDocPatch` | The changed `LibraryDocDto`. 409 when `revision` is stale |
 * | `POST /api/library/:id/move` | `{ to, updateReferences? }` | `LibraryMoveResultDto`: the moves and the issues whose references changed |
 * | `DELETE /api/library/:id` | — | `{ deleted, referencedBy }` |
 *
 * The id holds `/` between folders, so a client encodes it with
 * `encodeURIComponent`, and the router decodes the one path segment.
 *
 * A write goes to disk at once, as a comment does. A library document is not
 * part of the plan, so a view holds no queued change for it.
 */
function entryOf(paths: BoardPaths, doc: LibraryDoc): LibraryEntryDto {
  return {
    id: doc.id,
    title: doc.title,
    description: doc.description,
    path: displayPath(paths, doc.file),
    updated: doc.updated,
  };
}

function docOf(paths: BoardPaths, doc: LibraryDoc): LibraryDocDto {
  return {
    ...entryOf(paths, doc),
    body: doc.body,
    revision: doc.revision,
    referencedBy: libraryReferrers(readBoard(paths), doc.id),
  };
}

function optionalText(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, `The key "${key}" must hold a string`);
  return value;
}

/** Answer 404 for an id that names no document. An invalid id answers 400 from the engine. */
function requireExisting(paths: BoardPaths, id: string): void {
  requireLibraryId(id);
  if (!libraryDocExists(paths, id)) throw new HttpError(404, `The library has no document "${id}"`);
}

export function libraryRoutes(router: Router, paths: BoardPaths): void {
  router.get('/api/library', ({ res }) => {
    sendJson(res, 200, listLibraryDocs(paths).map((doc) => entryOf(paths, doc)));
  });

  router.get('/api/library/:id', ({ res, params }) => {
    requireExisting(paths, params.id!);
    const doc = readLibraryDoc(paths, params.id!);
    if (!doc) throw new HttpError(404, `The library has no document "${params.id}"`);
    sendJson(res, 200, docOf(paths, doc));
  });

  router.post('/api/library', async ({ req, res }) => {
    const body = await readJson<Record<string, unknown>>(req);
    const id = optionalText(body, 'id');
    if (!id) throw new HttpError(400, 'A library document needs an id');
    const input = {
      id,
      title: optionalText(body, 'title'),
      description: optionalText(body, 'description'),
      body: optionalText(body, 'body'),
    };
    pullBeforeWrite(paths);
    const doc = createLibraryDoc(readBoard(paths), input);
    sendJson(res, 201, docOf(paths, doc));
  });

  router.put('/api/library/:id', async ({ req, res, params }) => {
    const body = await readJson<Record<string, unknown>>(req);
    const patch: LibraryDocPatch = {
      title: optionalText(body, 'title'),
      description: optionalText(body, 'description'),
      body: optionalText(body, 'body'),
      revision: optionalText(body, 'revision'),
    };
    pullBeforeWrite(paths);
    requireExisting(paths, params.id!);
    const doc = updateLibraryDoc(readBoard(paths), params.id!, patch);
    sendJson(res, 200, docOf(paths, doc));
  });

  router.post('/api/library/:id/move', async ({ req, res, params }) => {
    const body = await readJson<Record<string, unknown>>(req);
    const to = optionalText(body, 'to');
    if (!to) throw new HttpError(400, 'A move needs the new id in the key "to"');
    if (body.updateReferences !== undefined && typeof body.updateReferences !== 'boolean') {
      throw new HttpError(400, 'The key "updateReferences" must hold true or false');
    }
    pullBeforeWrite(paths);
    const result: LibraryMoveResultDto = moveLibraryDoc(readBoard(paths), params.id!, to, {
      updateReferences: body.updateReferences !== false,
    });
    sendJson(res, 200, result);
  });

  router.delete('/api/library/:id', ({ res, params }) => {
    pullBeforeWrite(paths);
    requireExisting(paths, params.id!);
    const result = removeLibraryDoc(readBoard(paths), params.id!);
    sendJson(res, 200, { deleted: result.doc.id, referencedBy: result.referencedBy });
  });
}
