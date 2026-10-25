import { existsSync, mkdirSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BoardError,
  createIssue,
  createLibraryDoc,
  createLibraryFolder,
  findIssue,
  libraryDir,
  listLibraryDocs,
  listLibraryFolders,
  moveLibraryDoc,
  removeLibraryDoc,
  removeLibraryFolder,
} from '../src/core/index.js';
import { startBoardServer } from '../src/server/index.js';
import type { LibraryFolderRemovalDto, LibraryListDto, LibraryMoveResultDto } from '../src/shared/index.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterAll(cleanupBoards);

/**
 * The folders of the board library: created on purpose, kept when they are
 * empty, moved with everything inside them, and deleted.
 *
 *   library/
 *   ├── archive/            (empty)
 *   └── prompts/
 *       ├── deep/           (empty)
 *       └── review.md       LP-1 references library:prompts/review
 */
function seed() {
  const paths = makeBoard();
  createLibraryFolder(reload(paths), 'archive');
  createLibraryFolder(reload(paths), 'prompts/deep');
  createLibraryDoc(reload(paths), { id: 'prompts/review', body: 'Review.\n' });
  createIssue(reload(paths), { type: 'program', title: 'One', relatedFiles: ['library:prompts/review'] });
  return paths;
}

const keep = (paths: ReturnType<typeof makeBoard>, folder: string): boolean =>
  existsSync(path.join(libraryDir(paths), ...folder.split('/'), '.gitkeep'));

describe('library folders', () => {
  it('lists every folder, also the empty ones, and writes the keep file into each', () => {
    const paths = seed();
    expect(listLibraryFolders(paths)).toEqual(['archive', 'prompts', 'prompts/deep']);
    expect(['archive', 'prompts', 'prompts/deep'].every((folder) => keep(paths, folder))).toBe(true);
    // The keep file is no document.
    expect(listLibraryDocs(paths).map((doc) => doc.id)).toEqual(['prompts/review']);
  });

  it('refuses a folder that exists, or a name that breaks the id rule', () => {
    const paths = seed();
    expect(() => createLibraryFolder(reload(paths), 'archive')).toThrow('already has a folder "archive"');
    expect(() => createLibraryFolder(reload(paths), 'My Folder')).toThrow(BoardError);
  });

  it('leaves out a folder whose name breaks the id rule', () => {
    const paths = seed();
    mkdirSync(path.join(libraryDir(paths), 'Bad Name'));
    expect(listLibraryFolders(paths)).not.toContain('Bad Name');
  });

  it('keeps a folder when its last document is deleted or moved out', () => {
    const paths = seed();
    moveLibraryDoc(reload(paths), 'prompts/review', 'archive/review');
    expect(listLibraryFolders(paths)).toContain('prompts');
    removeLibraryDoc(reload(paths), 'archive/review');
    expect(listLibraryFolders(paths)).toEqual(['archive', 'prompts', 'prompts/deep']);
  });

  it('moves a folder with its documents and its empty folders, and rewrites the references', () => {
    const paths = seed();
    const result = moveLibraryDoc(reload(paths), 'prompts', 'archive/prompts');

    expect(result).toEqual({
      kind: 'folder',
      moved: [{ from: 'prompts/review', to: 'archive/prompts/review' }],
      rewritten: ['LP-1'],
      stale: [],
    });
    expect(listLibraryFolders(paths)).toEqual(['archive', 'archive/prompts', 'archive/prompts/deep']);
    expect(findIssue(reload(paths), 'LP-1')!.related_files).toEqual(['library:archive/prompts/review']);
  });

  it('moves an empty folder', () => {
    const paths = seed();
    expect(moveLibraryDoc(reload(paths), 'archive', 'old').moved).toEqual([]);
    expect(listLibraryFolders(paths)).toEqual(['old', 'prompts', 'prompts/deep']);
  });

  it('refuses a move onto a folder that exists, and changes nothing', () => {
    const paths = seed();
    expect(() => moveLibraryDoc(reload(paths), 'prompts', 'archive')).toThrow('already has a folder "archive"');
    expect(listLibraryFolders(paths)).toEqual(['archive', 'prompts', 'prompts/deep']);
  });

  it('refuses to delete a folder that holds documents, unless asked to delete them too', () => {
    const paths = seed();
    expect(() => removeLibraryFolder(reload(paths), 'prompts')).toThrow('The folder "prompts" holds 1 document');

    expect(removeLibraryFolder(reload(paths), 'archive')).toEqual({ folder: 'archive', removed: [], referencedBy: [] });

    expect(removeLibraryFolder(reload(paths), 'prompts', { recursive: true })).toEqual({
      folder: 'prompts',
      removed: ['prompts/review'],
      referencedBy: ['LP-1'],
    });
    expect(listLibraryFolders(paths)).toEqual([]);
    expect(() => removeLibraryFolder(reload(paths), 'prompts')).toThrow('has no folder "prompts"');
  });
});

describe('the library folder routes', () => {
  let server: Server | null = null;
  afterAll(() => server?.close());

  it('lists, creates, moves and deletes folders over HTTP', async () => {
    const paths = seed();
    const running = await startBoardServer(paths, { port: 0, serveApp: false });
    server = running.server;
    const call = async <T>(method: string, route: string, body?: unknown) => {
      const response = await fetch(`${running.url}${route}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as T };
    };

    expect((await call<LibraryListDto>('GET', '/api/library')).body.folders).toEqual(['archive', 'prompts', 'prompts/deep']);
    expect((await call('POST', '/api/library-folders', { path: 'drafts/2026' })).status).toBe(201);
    expect((await call('POST', '/api/library-folders', { path: 'drafts/2026' })).status).toBe(400);
    expect((await call('POST', '/api/library-folders', {})).status).toBe(400);

    const moved = await call<LibraryMoveResultDto>('POST', `/api/library/${encodeURIComponent('drafts/2026')}/move`, {
      to: 'archive/2026',
    });
    expect(moved.body.kind).toBe('folder');

    const folder = (name: string) => `/api/library-folders/${encodeURIComponent(name)}`;
    expect((await call('DELETE', folder('prompts'))).status).toBe(400);
    expect((await call('DELETE', folder('nothing'))).status).toBe(404);
    const removed = await call<LibraryFolderRemovalDto>('DELETE', `${folder('prompts')}?recursive=true`);
    expect(removed.body).toEqual({ folder: 'prompts', removed: ['prompts/review'], referencedBy: ['LP-1'] });
    expect((await call<LibraryListDto>('GET', '/api/library')).body.folders).toEqual(['archive', 'archive/2026', 'drafts']);
  });
});
