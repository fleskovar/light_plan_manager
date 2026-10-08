import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  appendResolveAudit,
  auditLogPath,
  clearResolutions,
  clearResolvedFields,
  loadResolutions,
  ownerFor,
  recordDocumentResolution,
  recordFieldResolution,
  resolutionsPath,
  saveResolutions,
  type ResolutionStore,
} from '../src/remote/resolutions.js';
import { BoardError } from '../src/core/errors.js';
import { cleanupBoards, makeBoard } from './helpers.js';

afterAll(cleanupBoards);

/**
 * LP-287 — the resolution store: pending decisions `lpm remote resolve`
 * records and the next sync applies.  Pure lookups are tested with literals;
 * the I/O round-trips against a throwaway board on disk.
 */

function fresh(paths = makeBoard()): { store: ResolutionStore; paths: ReturnType<typeof makeBoard> } {
  return { store: loadResolutions(paths, 'upstream'), paths };
}

function writeStore(paths: ReturnType<typeof makeBoard>, body: unknown): void {
  const dir = path.join(paths.remotesDir, 'upstream');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'resolutions.json'), JSON.stringify(body), 'utf8');
}

describe('resolutionsPath / auditLogPath', () => {
  it('resolves under .lpm/remotes/<name>/', () => {
    const paths = makeBoard();
    expect(resolutionsPath(paths, 'upstream')).toBe(
      path.join(paths.remotesDir, 'upstream', 'resolutions.json'),
    );
    expect(auditLogPath(paths, 'upstream')).toBe(
      path.join(paths.remotesDir, 'upstream', 'audit.log'),
    );
  });
});

describe('loadResolutions', () => {
  it('returns an empty store when the file does not exist', () => {
    const { store } = fresh();
    expect(store.version).toBe(1);
    expect(store.resolutions.size).toBe(0);
  });

  it('loads a store from disk, with a default and per-field decisions', () => {
    const paths = makeBoard();
    writeStore(paths, {
      version: 1,
      resolutions: {
        'LP-12': { default: 'local', fields: { status: 'remote', title: 'local' } },
        'LP-13': { fields: { story_points: 'remote' } },
      },
    });

    const store = loadResolutions(paths, 'upstream');
    expect(store.resolutions.get('LP-12')).toEqual({
      default: 'local',
      fields: { status: 'remote', title: 'local' },
    });
    expect(store.resolutions.get('LP-13')).toEqual({ fields: { story_points: 'remote' } });
  });

  it('rejects a wrong version with a BoardError naming the path', () => {
    const paths = makeBoard();
    writeStore(paths, { version: 2, resolutions: {} });
    expect(() => loadResolutions(paths, 'upstream')).toThrowError(BoardError);
  });

  it('rejects an owner that is neither local nor remote', () => {
    const paths = makeBoard();
    writeStore(paths, { version: 1, resolutions: { 'LP-12': { default: 'me' } } });
    try {
      loadResolutions(paths, 'upstream');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BoardError);
      expect((error as BoardError).details.join('\n')).toMatch(/default/);
    }
  });

  it('rejects a non-object resolution entry', () => {
    const paths = makeBoard();
    writeStore(paths, { version: 1, resolutions: { 'LP-12': 'local' } });
    expect(() => loadResolutions(paths, 'upstream')).toThrowError(BoardError);
  });
});

describe('saveResolutions', () => {
  it('round-trips and writes keys sorted', () => {
    const { store, paths } = fresh();
    recordDocumentResolution(store, 'LP-2', 'local');
    recordFieldResolution(store, 'LP-1', 'title', 'remote');
    saveResolutions(paths, 'upstream', store);

    const onDisk = JSON.parse(readFileSync(resolutionsPath(paths, 'upstream'), 'utf8'));
    expect(Object.keys(onDisk.resolutions)).toEqual(['LP-1', 'LP-2']);

    const reloaded = loadResolutions(paths, 'upstream');
    expect(reloaded.resolutions.get('LP-1')).toEqual({ fields: { title: 'remote' } });
    expect(reloaded.resolutions.get('LP-2')).toEqual({ default: 'local' });
  });
});

describe('ownerFor', () => {
  it('a per-field decision beats the document default', () => {
    const { store } = fresh();
    recordDocumentResolution(store, 'LP-12', 'local');
    recordFieldResolution(store, 'LP-12', 'status', 'remote');
    expect(ownerFor(store, 'LP-12', 'status')).toBe('remote');
    expect(ownerFor(store, 'LP-12', 'title')).toBe('local');
  });

  it('is undefined when the document has no decision', () => {
    const { store } = fresh();
    expect(ownerFor(store, 'LP-12', 'title')).toBeUndefined();
  });

  it('a default alone answers every field', () => {
    const { store } = fresh();
    recordDocumentResolution(store, 'LP-12', 'remote');
    expect(ownerFor(store, 'LP-12', 'anything')).toBe('remote');
  });
});

describe('recordDocumentResolution', () => {
  it('replaces a per-field decision — the whole-document call is stronger', () => {
    const { store } = fresh();
    recordFieldResolution(store, 'LP-12', 'status', 'remote');
    recordDocumentResolution(store, 'LP-12', 'local');
    expect(store.resolutions.get('LP-12')).toEqual({ default: 'local' });
  });
});

describe('recordFieldResolution', () => {
  it('creates an entry when none exists', () => {
    const { store } = fresh();
    recordFieldResolution(store, 'LP-12', 'title', 'local');
    expect(store.resolutions.get('LP-12')).toEqual({ fields: { title: 'local' } });
  });

  it('preserves the default and the other per-field decisions', () => {
    const { store } = fresh();
    recordDocumentResolution(store, 'LP-12', 'local');
    recordFieldResolution(store, 'LP-12', 'title', 'remote');
    recordFieldResolution(store, 'LP-12', 'status', 'remote');
    expect(store.resolutions.get('LP-12')).toEqual({
      default: 'local',
      fields: { title: 'remote', status: 'remote' },
    });
  });
});

describe('clearResolutions / clearResolvedFields', () => {
  it('clearResolutions drops the whole document', () => {
    const { store } = fresh();
    recordFieldResolution(store, 'LP-12', 'title', 'local');
    clearResolutions(store, 'LP-12');
    expect(store.resolutions.has('LP-12')).toBe(false);
  });

  it('clearResolvedFields removes only the applied fields, keeping a default', () => {
    const { store } = fresh();
    recordDocumentResolution(store, 'LP-12', 'local');
    recordFieldResolution(store, 'LP-12', 'status', 'remote');
    clearResolvedFields(store, 'LP-12', ['status']);
    expect(store.resolutions.get('LP-12')).toEqual({ default: 'local' });
  });

  it('clearResolvedFields drops the entry when nothing remains', () => {
    const { store } = fresh();
    recordFieldResolution(store, 'LP-12', 'status', 'remote');
    clearResolvedFields(store, 'LP-12', ['status']);
    expect(store.resolutions.has('LP-12')).toBe(false);
  });
});

describe('appendResolveAudit', () => {
  it('appends one JSON line per decision and creates the file', () => {
    const paths = makeBoard();
    appendResolveAudit(paths, 'upstream', {
      at: '2026-08-15T22:36:15.848Z',
      author: 'fran',
      localId: 'LP-12',
      default: 'local',
    });
    appendResolveAudit(paths, 'upstream', {
      at: '2026-08-15T22:36:16.000Z',
      author: 'fran',
      localId: 'LP-12',
      fields: { status: 'remote' },
    });

    const lines = readFileSync(auditLogPath(paths, 'upstream'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({
      at: '2026-08-15T22:36:15.848Z',
      author: 'fran',
      localId: 'LP-12',
      default: 'local',
    });
    expect(JSON.parse(lines[1]!)).toEqual({
      at: '2026-08-15T22:36:16.000Z',
      author: 'fran',
      localId: 'LP-12',
      fields: { status: 'remote' },
    });
  });
});
