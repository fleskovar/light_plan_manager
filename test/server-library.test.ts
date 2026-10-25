import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BoardPaths } from '../src/core/index.js';
import { createIssue, findIssue, readLibraryDoc } from '../src/core/index.js';
import { startBoardServer } from '../src/server/index.js';
import type { LibraryDocDto, LibraryListDto, LibraryMoveResultDto } from '../src/shared/index.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

/**
 * The library routes of `lpm ui`: list, read, create, edit with a revision,
 * and delete. The id holds a slash, so each request encodes it.
 */
let paths: BoardPaths;
let server: Server;
let base: string;

beforeAll(async () => {
  paths = makeBoard();
  createIssue(reload(paths), { type: 'program', title: 'Payments', relatedFiles: ['library:prd/payments'] });
  const running = await startBoardServer(paths, { port: 0, serveApp: false });
  server = running.server;
  base = running.url;
});

afterAll(() => {
  server.close();
  cleanupBoards();
});

async function call<T>(method: string, route: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as T };
}

const doc = (id: string): string => `/api/library/${encodeURIComponent(id)}`;

describe('the library routes', () => {
  it('creates a document, lists it without the body, and reads it with its references', async () => {
    const created = await call<LibraryDocDto>('POST', '/api/library', {
      id: 'prd/payments',
      title: 'Payments PRD',
      description: 'What payments must do',
      body: '## Goals\n',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: 'prd/payments', referencedBy: ['LP-1'] });

    const list = await call<LibraryListDto>('GET', '/api/library');
    expect(list.body.documents).toEqual([
      expect.objectContaining({ id: 'prd/payments', title: 'Payments PRD', path: '.lpm/library/prd/payments.md' }),
    ]);
    expect(list.body.folders).toEqual(['prd']);
    expect('body' in list.body.documents[0]!).toBe(false);

    const read = await call<LibraryDocDto>('GET', doc('prd/payments'));
    expect(read.body).toMatchObject({ body: '## Goals\n', description: 'What payments must do' });
  });

  it('edits a document with the revision it read, and answers 409 for a stale revision', async () => {
    const read = await call<LibraryDocDto>('GET', doc('prd/payments'));
    const edited = await call<LibraryDocDto>('PUT', doc('prd/payments'), {
      body: '## Goals\n\nTake cards.\n',
      revision: read.body.revision,
    });
    expect(edited.status).toBe(200);
    expect(readLibraryDoc(paths, 'prd/payments')!.body).toBe('## Goals\n\nTake cards.\n');

    const stale = await call<{ error: string }>('PUT', doc('prd/payments'), { body: 'Lost', revision: read.body.revision });
    expect(stale.status).toBe(409);
    expect(readLibraryDoc(paths, 'prd/payments')!.body).toBe('## Goals\n\nTake cards.\n');
  });

  it('answers 400 for an invalid id or a body that is not text, and 404 for a missing document', async () => {
    expect((await call('POST', '/api/library', { id: '../x' })).status).toBe(400);
    expect((await call('POST', '/api/library', { id: 'x', body: 12 })).status).toBe(400);
    expect((await call('POST', '/api/library', { id: 'prd/payments' })).status).toBe(400);
    expect((await call('GET', doc('nothing'))).status).toBe(404);
    expect((await call('PUT', doc('nothing'), { body: 'x' })).status).toBe(404);
    expect((await call('DELETE', doc('nothing'))).status).toBe(404);
  });

  it('renames a document, rewrites the reference of the issue, and moves it back', async () => {
    const moved = await call<LibraryMoveResultDto>('POST', `${doc('prd/payments')}/move`, { to: 'spec/payments' });
    expect(moved.status).toBe(200);
    expect(moved.body).toEqual({
      kind: 'document',
      moved: [{ from: 'prd/payments', to: 'spec/payments' }],
      rewritten: ['LP-1'],
      stale: [],
    });
    expect(findIssue(reload(paths), 'LP-1')!.related_files).toEqual(['library:spec/payments']);

    expect((await call('POST', `${doc('spec/payments')}/move`, {})).status).toBe(400);
    expect((await call('POST', `${doc('nothing')}/move`, { to: 'x' })).status).toBe(400);
    expect((await call('POST', `${doc('spec/payments')}/move`, { to: 'prd/payments' })).status).toBe(200);
  });

  it('deletes a document and names the issues that still reference it', async () => {
    const deleted = await call<{ deleted: string; referencedBy: string[] }>('DELETE', doc('prd/payments'));
    expect(deleted.body).toEqual({ deleted: 'prd/payments', referencedBy: ['LP-1'] });
    expect((await call<LibraryListDto>('GET', '/api/library')).body.documents).toEqual([]);
  });
});
