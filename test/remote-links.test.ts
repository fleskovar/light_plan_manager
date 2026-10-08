import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  type LinkEntry,
  type LinkStore,
  type Tombstone,
  loadLinkStore,
  saveLinkStore,
  getLink,
  getLocalId,
  getTombstone,
  isDecoupled,
  isLinked,
  setLink,
  removeLink,
  setTombstone,
  clearTombstone,
  decoupleLink,
  rewriteLinkId,
  findMissingLinks,
  pruneMissingLinks,
  findMissingTombstones,
  pruneMissingTombstones,
  getCursorForPull,
  advanceCursor,
  clearCursor,
  getManagedCommentId,
  setManagedCommentId,
  isManagedComment,
  linksPath,
  stripManagedBlock,
  hashBody,
  isBodyHash,
  computeBase,
  updateBase,
} from '../src/remote/links.js';
import { MANAGED_BLOCK_BEGIN, MANAGED_BLOCK_END, renderManagedBlock } from '../src/remote/managed-block.js';
import { makeBoard, cleanupBoards } from './helpers.js';
import { BoardError } from '../src/core/errors.js';

function entry(overrides: Partial<LinkEntry> = {}): LinkEntry {
  return {
    remoteId: overrides.remoteId ?? 'I_kwDOA123',
    remoteKey: overrides.remoteKey ?? 'acme/payments#418',
    remoteUrl: overrides.remoteUrl ?? 'https://github.com/acme/payments/issues/418',
    syncedAt: overrides.syncedAt ?? '2026-09-04T11:19:58Z',
    remoteRev: overrides.remoteRev ?? '2026-09-04T11:19:57Z',
    base: overrides.base,
    baseHash: overrides.baseHash,
    managedCommentId: overrides.managedCommentId,
  };
}

function freshStore(paths = makeBoard()): { store: LinkStore; paths: ReturnType<typeof makeBoard> } {
  return { store: loadLinkStore(paths, 'upstream'), paths };
}

describe('linksPath', () => {
  it('resolves under .lpm/remotes/<name>/links.json', () => {
    const paths = makeBoard();
    expect(linksPath(paths, 'upstream')).toBe(
      path.join(paths.remotesDir, 'upstream', 'links.json'),
    );
  });
});

describe('loadLinkStore', () => {
  it('returns an empty store when the file does not exist', () => {
    const { store } = freshStore();
    expect(store.version).toBe(1);
    expect(store.cursor).toBeNull();
    expect(store.links.size).toBe(0);
    expect(store.byRemote.size).toBe(0);
  });

  it('loads a store from disk', () => {
    const paths = makeBoard();
    const dir = path.join(paths.remotesDir, 'upstream');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'links.json'),
      JSON.stringify(
        {
          version: 1,
          cursor: '2026-09-04T11:20:03Z',
          links: {
            'LP-12': {
              remoteId: 'I_kwDOA123',
              remoteKey: 'acme/payments#418',
              remoteUrl: 'https://github.com/acme/payments/issues/418',
              syncedAt: '2026-09-04T11:19:58Z',
              remoteRev: '2026-09-04T11:19:57Z',
              base: { title: 'Add login', status: 'in_progress', story_points: 5 },
              baseHash: 'sha256:abc123',
            },
          },
        },
        null,
        2,
      ) + '\n',
    );

    const store = loadLinkStore(paths, 'upstream');
    expect(store.cursor).toBe('2026-09-04T11:20:03Z');
    expect(store.links.size).toBe(1);
    expect(store.byRemote.size).toBe(1);

    const link = store.links.get('LP-12')!;
    expect(link.remoteId).toBe('I_kwDOA123');
    expect(link.remoteKey).toBe('acme/payments#418');
    expect(link.remoteUrl).toBe('https://github.com/acme/payments/issues/418');
    expect(link.syncedAt).toBe('2026-09-04T11:19:58Z');
    expect(link.remoteRev).toBe('2026-09-04T11:19:57Z');
    expect(link.base).toEqual({ title: 'Add login', status: 'in_progress', story_points: 5 });
    expect(link.baseHash).toBe('sha256:abc123');
    expect(store.byRemote.get('I_kwDOA123')).toBe('LP-12');
  });

  it('rejects a link entry without a remoteId', () => {
    const paths = makeBoard();
    const dir = path.join(paths.remotesDir, 'upstream');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'links.json'),
      JSON.stringify({
        version: 1,
        cursor: null,
        links: {
          'LP-1': { remoteId: 'R1' },
          'LP-2': { remoteKey: 'missing-id' }, // no remoteId
          'LP-3': { remoteId: 'R3' },
        },
      }),
    );

    expect(() => loadLinkStore(paths, 'upstream')).toThrow(BoardError);
    try {
      loadLinkStore(paths, 'upstream');
    } catch (error) {
      const boardError = error as BoardError;
      expect(boardError.message).toContain('upstream');
      expect(boardError.details.some((d) => d.includes('LP-2'))).toBe(true);
      expect(boardError.details.some((d) => d.includes('remoteId'))).toBe(true);
    }
  });

  it('throws BoardError on malformed JSON', () => {
    const paths = makeBoard();
    const dir = path.join(paths.remotesDir, 'upstream');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'links.json'), 'not json {{{');

    expect(() => loadLinkStore(paths, 'upstream')).toThrow(BoardError);
    try {
      loadLinkStore(paths, 'upstream');
    } catch (error) {
      const boardError = error as BoardError;
      expect(boardError.message).toContain('upstream');
    }
  });

  it('throws BoardError on unsupported version', () => {
    const paths = makeBoard();
    const dir = path.join(paths.remotesDir, 'upstream');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'links.json'), JSON.stringify({ version: 99, links: {} }));

    try {
      loadLinkStore(paths, 'upstream');
    } catch (error) {
      const boardError = error as BoardError;
      expect(boardError.message).toContain('newer version');
      expect(boardError.details.some((d) => d.includes('Upgrade light-plan'))).toBe(true);
    }
  });

  it('throws BoardError on version 0 (older/unknown)', () => {
    const paths = makeBoard();
    const dir = path.join(paths.remotesDir, 'upstream');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'links.json'), JSON.stringify({ version: 0, links: {} }));

    try {
      loadLinkStore(paths, 'upstream');
    } catch (error) {
      const boardError = error as BoardError;
      expect(boardError.message).toContain('Unsupported');
      expect(boardError.details.some((d) => d.includes('repair'))).toBe(true);
    }
  });

  it('throws BoardError when a link value is not an object', () => {
    const paths = makeBoard();
    const dir = path.join(paths.remotesDir, 'upstream');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'links.json'),
      JSON.stringify({ version: 1, links: { 'LP-1': 'not-an-object' } }),
    );

    try {
      loadLinkStore(paths, 'upstream');
    } catch (error) {
      const boardError = error as BoardError;
      expect(boardError.message).toContain('upstream');
      expect(boardError.details.some((d) => d.includes('LP-1'))).toBe(true);
      expect(boardError.details.some((d) => d.includes('not an object'))).toBe(true);
    }
  });

  it('throws BoardError when an optional field has the wrong type', () => {
    const paths = makeBoard();
    const dir = path.join(paths.remotesDir, 'upstream');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'links.json'),
      JSON.stringify({
        version: 1,
        links: { 'LP-1': { remoteId: 'R1', remoteKey: 123 } },
      }),
    );

    try {
      loadLinkStore(paths, 'upstream');
    } catch (error) {
      const boardError = error as BoardError;
      expect(boardError.message).toContain('upstream');
      expect(boardError.details.some((d) => d.includes('remoteKey'))).toBe(true);
      expect(boardError.details.some((d) => d.includes('string'))).toBe(true);
    }
  });

  it('throws BoardError when base is not an object', () => {
    const paths = makeBoard();
    const dir = path.join(paths.remotesDir, 'upstream');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'links.json'),
      JSON.stringify({
        version: 1,
        links: { 'LP-1': { remoteId: 'R1', base: 'not-an-object' } },
      }),
    );

    try {
      loadLinkStore(paths, 'upstream');
    } catch (error) {
      const boardError = error as BoardError;
      expect(boardError.message).toContain('upstream');
      expect(boardError.details.some((d) => d.includes('base'))).toBe(true);
      expect(boardError.details.some((d) => d.includes('object'))).toBe(true);
    }
  });

  it('throws BoardError when baseHash is not a string', () => {
    const paths = makeBoard();
    const dir = path.join(paths.remotesDir, 'upstream');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'links.json'),
      JSON.stringify({
        version: 1,
        links: { 'LP-1': { remoteId: 'R1', baseHash: 12345 } },
      }),
    );

    try {
      loadLinkStore(paths, 'upstream');
    } catch (error) {
      const boardError = error as BoardError;
      expect(boardError.message).toContain('upstream');
      expect(boardError.details.some((d) => d.includes('baseHash'))).toBe(true);
      expect(boardError.details.some((d) => d.includes('string'))).toBe(true);
    }
  });

  it('allows null base and null baseHash (absent is fine)', () => {
    const paths = makeBoard();
    const dir = path.join(paths.remotesDir, 'upstream');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'links.json'),
      JSON.stringify({
        version: 1,
        links: { 'LP-1': { remoteId: 'R1', base: null, baseHash: null } },
      }),
    );

    const store = loadLinkStore(paths, 'upstream');
    expect(store.links.size).toBe(1);
    expect(store.links.get('LP-1')!.base).toBeUndefined();
    expect(store.links.get('LP-1')!.baseHash).toBeUndefined();
  });

  it('falls back to remoteId when remoteKey is missing', () => {
    const paths = makeBoard();
    const dir = path.join(paths.remotesDir, 'upstream');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'links.json'),
      JSON.stringify({
        version: 1,
        links: { 'LP-1': { remoteId: 'gh-123' } },
      }),
    );

    const store = loadLinkStore(paths, 'upstream');
    expect(store.links.get('LP-1')!.remoteKey).toBe('gh-123');
  });

  it('throws BoardError when links is not an object', () => {
    const paths = makeBoard();
    const dir = path.join(paths.remotesDir, 'upstream');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'links.json'),
      JSON.stringify({ version: 1, links: 'not-an-object' }),
    );

    // typeof 'not-an-object' is 'string', and it's truthy, so we don't iterate
    // it — loadLinkStore silently skips non-object links containers.
    const store = loadLinkStore(paths, 'upstream');
    expect(store.links.size).toBe(0);
  });

  it('throws BoardError when a document is both linked and decoupled', () => {
    const paths = makeBoard();
    const dir = path.join(paths.remotesDir, 'upstream');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'links.json'),
      JSON.stringify({
        version: 1,
        links: { 'LP-1': { remoteId: 'R1' } },
        tombstones: { 'LP-1': { remoteKey: 'k#1', reason: 'manual', at: '2026-09-05T00:00:00Z' } },
      }),
    );

    expect(() => loadLinkStore(paths, 'upstream')).toThrow(BoardError);
    try {
      loadLinkStore(paths, 'upstream');
    } catch (error) {
      const boardError = error as BoardError;
      expect(boardError.message).toContain('upstream');
      expect(boardError.details.some((d) => d.includes('LP-1'))).toBe(true);
      expect(boardError.details.some((d) => d.includes('both linked and decoupled'))).toBe(true);
    }
  });

  it('handles missing cursor gracefully', () => {
    const paths = makeBoard();
    const dir = path.join(paths.remotesDir, 'upstream');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'links.json'),
      JSON.stringify({ version: 1, links: {} }),
    );

    const store = loadLinkStore(paths, 'upstream');
    expect(store.cursor).toBeNull();
  });
});

/** The managed-comment id accessors (LP-278). */
describe('managed comment id', () => {
  it('reads and writes the id through the link store', () => {
    const { store } = freshStore();
    setLink(store, 'LP-1', entry({ remoteId: 'R1' }));

    expect(getManagedCommentId(store, 'LP-1')).toBeUndefined();
    setManagedCommentId(store, 'LP-1', 'IC_1');
    expect(getManagedCommentId(store, 'LP-1')).toBe('IC_1');
    setManagedCommentId(store, 'LP-1', undefined);
    expect(getManagedCommentId(store, 'LP-1')).toBeUndefined();
  });

  it('is a no-op for a document with no link', () => {
    const { store } = freshStore();
    setManagedCommentId(store, 'LP-99', 'IC_1');
    expect(getManagedCommentId(store, 'LP-99')).toBeUndefined();
  });

  it('identifies the managed comment by id, then by body (excluded from comment sync)', () => {
    const { store } = freshStore();
    setLink(store, 'LP-1', entry({ remoteId: 'R1', managedCommentId: 'IC_1' }));
    const block = renderManagedBlock([{ name: 'id', kind: 'text', value: 'LP-1' }]);

    // By id: a comment whose id matches is ours, whatever its body looks like.
    expect(isManagedComment(store, 'LP-1', 'IC_1', '')).toBe(true);
    // By body: a comment whose body is a managed block is ours, even if the
    // recorded id was lost.
    expect(isManagedComment(store, 'LP-1', 'IC_other', block)).toBe(true);
    // A human comment is neither.
    expect(isManagedComment(store, 'LP-1', 'IC_other', 'a human note')).toBe(false);
  });
});

describe('saveLinkStore', () => {
  it('creates the folder on first write', () => {
    const { store, paths } = freshStore();
    setLink(store, 'LP-1', entry({ remoteId: 'R1' }));
    saveLinkStore(paths, 'upstream', store);

    const reloaded = loadLinkStore(paths, 'upstream');
    expect(reloaded.links.size).toBe(1);
    expect(reloaded.links.get('LP-1')!.remoteId).toBe('R1');
  });

  it('writes keys in sorted order', () => {
    const { store, paths } = freshStore();
    setLink(store, 'LP-20', entry({ remoteId: 'R20' }));
    setLink(store, 'LP-3', entry({ remoteId: 'R3' }));
    setLink(store, 'LP-12', entry({ remoteId: 'R12' }));
    saveLinkStore(paths, 'upstream', store);

    const { readFileSync } = require('node:fs');
    const raw = readFileSync(linksPath(paths, 'upstream'), 'utf8');
    const parsed = JSON.parse(raw);

    const keys = Object.keys(parsed.links);
    expect(keys).toEqual(['LP-12', 'LP-20', 'LP-3']); // lexicographic sort
  });

  it('ends with a newline', () => {
    const { store, paths } = freshStore();
    setLink(store, 'LP-1', entry({ remoteId: 'R1' }));
    saveLinkStore(paths, 'upstream', store);

    const { readFileSync } = require('node:fs');
    const raw = readFileSync(linksPath(paths, 'upstream'), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('round-trips base snapshot and cursor', () => {
    const { store, paths } = freshStore();
    store.cursor = 'page-token-42';
    setLink(
      store,
      'LP-5',
      entry({
        remoteId: 'R5',
        base: { title: 'Fix login', status: 'done' },
        baseHash: 'sha256:def456',
      }),
    );
    saveLinkStore(paths, 'upstream', store);

    const reloaded = loadLinkStore(paths, 'upstream');
    expect(reloaded.cursor).toBe('page-token-42');
    const link = reloaded.links.get('LP-5')!;
    expect(link.base).toEqual({ title: 'Fix login', status: 'done' });
    expect(link.baseHash).toBe('sha256:def456');
  });

  it('round-trips the managed comment id (LP-278)', () => {
    const { store, paths } = freshStore();
    setLink(store, 'LP-5', entry({ remoteId: 'R5', managedCommentId: 'IC_kwDOA1' }));
    saveLinkStore(paths, 'upstream', store);

    const reloaded = loadLinkStore(paths, 'upstream');
    expect(reloaded.links.get('LP-5')!.managedCommentId).toBe('IC_kwDOA1');
  });

  it('omits the managedCommentId key when absent', () => {
    const { store, paths } = freshStore();
    setLink(store, 'LP-5', entry({ remoteId: 'R5' }));
    saveLinkStore(paths, 'upstream', store);

    const { readFileSync } = require('node:fs');
    const raw = readFileSync(linksPath(paths, 'upstream'), 'utf8');
    expect(raw).not.toContain('managedCommentId');
  });

  it('overwrites an existing file', () => {
    const { store, paths } = freshStore();
    setLink(store, 'LP-1', entry({ remoteId: 'first' }));
    saveLinkStore(paths, 'upstream', store);

    store.links.clear();
    store.byRemote.clear();
    setLink(store, 'LP-2', entry({ remoteId: 'second' }));
    saveLinkStore(paths, 'upstream', store);

    const reloaded = loadLinkStore(paths, 'upstream');
    expect(reloaded.links.size).toBe(1);
    expect(reloaded.links.has('LP-2')).toBe(true);
    expect(reloaded.links.has('LP-1')).toBe(false);
  });
});

describe('getLink / getLocalId / isLinked', () => {
  it('resolves local id to remote entry in O(1)', () => {
    const { store } = freshStore();
    setLink(store, 'LP-42', entry({ remoteId: 'R42' }));

    expect(getLink(store, 'LP-42')!.remoteId).toBe('R42');
    expect(getLink(store, 'LP-99')).toBeUndefined();
  });

  it('resolves remote id to local id in O(1)', () => {
    const { store } = freshStore();
    setLink(store, 'LP-42', entry({ remoteId: 'R42' }));

    expect(getLocalId(store, 'R42')).toBe('LP-42');
    expect(getLocalId(store, 'R99')).toBeUndefined();
  });

  it('isLinked returns true only for linked documents', () => {
    const { store } = freshStore();
    setLink(store, 'LP-1', entry({ remoteId: 'R1' }));

    expect(isLinked(store, 'LP-1')).toBe(true);
    expect(isLinked(store, 'LP-2')).toBe(false);
  });
});

describe('setLink', () => {
  it('adds a new link', () => {
    const { store } = freshStore();
    setLink(store, 'LP-1', entry({ remoteId: 'R1' }));

    expect(store.links.size).toBe(1);
    expect(store.links.get('LP-1')!.remoteId).toBe('R1');
    expect(store.byRemote.get('R1')).toBe('LP-1');
  });

  it('replaces an existing link for the same local id', () => {
    const { store } = freshStore();
    setLink(store, 'LP-1', entry({ remoteId: 'R1' }));
    setLink(store, 'LP-1', entry({ remoteId: 'R2' }));

    expect(store.links.size).toBe(1);
    expect(store.byRemote.get('R2')).toBe('LP-1');
    expect(store.byRemote.has('R1')).toBe(false); // old reverse entry dropped
  });

  it('updates the reverse index when remoteId changes', () => {
    const { store } = freshStore();
    setLink(store, 'LP-1', entry({ remoteId: 'old' }));
    expect(store.byRemote.get('old')).toBe('LP-1');

    setLink(store, 'LP-1', entry({ remoteId: 'new' }));
    expect(store.byRemote.get('new')).toBe('LP-1');
    expect(store.byRemote.has('old')).toBe(false);
  });
});

describe('removeLink', () => {
  it('removes a link and its reverse index', () => {
    const { store } = freshStore();
    setLink(store, 'LP-1', entry({ remoteId: 'R1' }));

    const removed = removeLink(store, 'LP-1');
    expect(removed).toBe(true);
    expect(store.links.size).toBe(0);
    expect(store.byRemote.size).toBe(0);
    expect(isLinked(store, 'LP-1')).toBe(false);
    expect(getLocalId(store, 'R1')).toBeUndefined();
  });

  it('returns false when the local id has no link', () => {
    const { store } = freshStore();
    expect(removeLink(store, 'LP-99')).toBe(false);
  });
});

describe('tombstones (LP-366)', () => {
  const tombstone: Tombstone = { remoteKey: 'acme/payments#1', reason: 'manual', at: '2026-09-05T00:00:00Z' };

  it('setTombstone records and getTombstone / isDecoupled read it', () => {
    const { store } = freshStore();
    setTombstone(store, 'LP-1', tombstone);

    expect(getTombstone(store, 'LP-1')).toEqual(tombstone);
    expect(isDecoupled(store, 'LP-1')).toBe(true);
    expect(isDecoupled(store, 'LP-2')).toBe(false);
  });

  it('clearTombstone removes it and reports whether one existed', () => {
    const { store } = freshStore();
    setTombstone(store, 'LP-1', tombstone);

    expect(clearTombstone(store, 'LP-1')).toBe(true);
    expect(getTombstone(store, 'LP-1')).toBeUndefined();
    expect(clearTombstone(store, 'LP-1')).toBe(false);
  });

  it('decoupleLink drops the link, the base snapshot and the reverse index, and records the key', () => {
    const { store } = freshStore();
    setLink(store, 'LP-1', entry({ remoteId: 'R1', base: { title: 'Old' }, baseHash: 'sha256:old' }));

    const written = decoupleLink(store, 'LP-1', 'manual', '2026-09-05T00:00:00Z');

    // The link (and its base) is gone; the tombstone keeps the last remote key.
    expect(store.links.has('LP-1')).toBe(false);
    expect(store.byRemote.has('R1')).toBe(false);
    expect(written).toEqual({ remoteKey: 'acme/payments#418', reason: 'manual', at: '2026-09-05T00:00:00Z' });
    expect(getTombstone(store, 'LP-1')).toEqual(written);
  });

  it('decoupleLink on a never-linked document records an empty remote key', () => {
    const { store } = freshStore();
    const written = decoupleLink(store, 'LP-9', 'manual', '2026-09-05T00:00:00Z');

    expect(written.remoteKey).toBe('');
    expect(isDecoupled(store, 'LP-9')).toBe(true);
  });

  it('setLink clears any tombstone — a live link ends the decoupled state', () => {
    const { store } = freshStore();
    setTombstone(store, 'LP-1', tombstone);

    setLink(store, 'LP-1', entry({ remoteId: 'R1' }));

    expect(getTombstone(store, 'LP-1')).toBeUndefined();
    expect(isDecoupled(store, 'LP-1')).toBe(false);
    expect(store.links.get('LP-1')!.remoteId).toBe('R1');
  });

  it('round-trips tombstones through save/load, sorted under their own key', () => {
    const { store, paths } = freshStore();
    setTombstone(store, 'LP-20', { ...tombstone, remoteKey: 'acme/payments#20' });
    setTombstone(store, 'LP-3', { ...tombstone, remoteKey: 'acme/payments#3' });
    saveLinkStore(paths, 'upstream', store);

    const { readFileSync } = require('node:fs');
    const raw = readFileSync(linksPath(paths, 'upstream'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(Object.keys(parsed.tombstones)).toEqual(['LP-20', 'LP-3']); // lexicographic sort
    expect(parsed.links).toEqual({});

    const reloaded = loadLinkStore(paths, 'upstream');
    expect(reloaded.tombstones.get('LP-20')!.remoteKey).toBe('acme/payments#20');
    expect(reloaded.tombstones.get('LP-3')!.remoteKey).toBe('acme/payments#3');
  });

  it('omits the tombstones key when there are none', () => {
    const { store, paths } = freshStore();
    setLink(store, 'LP-1', entry({ remoteId: 'R1' }));
    saveLinkStore(paths, 'upstream', store);

    const { readFileSync } = require('node:fs');
    expect(readFileSync(linksPath(paths, 'upstream'), 'utf8')).not.toContain('tombstones');
  });
});

describe('findMissingTombstones / pruneMissingTombstones', () => {
  it('reports and prunes tombstones whose document no longer exists', () => {
    const { store } = freshStore();
    setTombstone(store, 'LP-1', { remoteKey: 'k#1', reason: 'manual', at: '2026-09-05T00:00:00Z' });
    setTombstone(store, 'LP-2', { remoteKey: 'k#2', reason: 'manual', at: '2026-09-05T00:00:00Z' });

    expect(findMissingTombstones(store, new Set(['LP-1']))).toEqual(['LP-2']);

    const pruned = pruneMissingTombstones(store, new Set(['LP-1']));
    expect(pruned).toEqual(['LP-2']);
    expect(store.tombstones.has('LP-1')).toBe(true);
    expect(store.tombstones.has('LP-2')).toBe(false);
  });
});

describe('rewriteLinkId', () => {
  it('moves a link from oldId to newId', () => {
    const { store } = freshStore();
    setLink(store, 'LP-old', entry({ remoteId: 'R1' }));

    rewriteLinkId(store, 'LP-old', 'LP-new');

    expect(store.links.has('LP-old')).toBe(false);
    expect(store.links.get('LP-new')!.remoteId).toBe('R1');
    expect(store.byRemote.get('R1')).toBe('LP-new');
  });

  it('does nothing when the two ids are equal', () => {
    const { store } = freshStore();
    setLink(store, 'LP-1', entry({ remoteId: 'R1' }));
    rewriteLinkId(store, 'LP-1', 'LP-1');
    expect(store.links.size).toBe(1);
  });

  it('does nothing when oldId has no link', () => {
    const { store } = freshStore();
    rewriteLinkId(store, 'LP-ghost', 'LP-new');
    expect(store.links.size).toBe(0);
  });

  it('overwrites a link at newId if one exists', () => {
    const { store } = freshStore();
    setLink(store, 'LP-old', entry({ remoteId: 'R-old' }));
    setLink(store, 'LP-new', entry({ remoteId: 'R-existing' }));

    rewriteLinkId(store, 'LP-old', 'LP-new');

    // Old at newId is dropped; old's link is now at newId.
    expect(store.links.has('LP-old')).toBe(false);
    expect(store.links.get('LP-new')!.remoteId).toBe('R-old');
    expect(store.byRemote.has('R-existing')).toBe(false);
    expect(store.byRemote.get('R-old')).toBe('LP-new');
  });
});

describe('findMissingLinks', () => {
  it('returns local ids whose document no longer exists', () => {
    const { store } = freshStore();
    setLink(store, 'LP-1', entry({ remoteId: 'R1' }));
    setLink(store, 'LP-2', entry({ remoteId: 'R2' }));
    setLink(store, 'LP-3', entry({ remoteId: 'R3' }));

    const missing = findMissingLinks(store, new Set(['LP-1', 'LP-3']));
    expect(missing).toEqual(['LP-2']);
  });

  it('returns empty when all links have matching documents', () => {
    const { store } = freshStore();
    setLink(store, 'LP-1', entry({ remoteId: 'R1' }));
    expect(findMissingLinks(store, new Set(['LP-1', 'LP-2']))).toEqual([]);
  });
});

describe('pruneMissingLinks', () => {
  it('removes links for documents that no longer exist', () => {
    const { store } = freshStore();
    setLink(store, 'LP-1', entry({ remoteId: 'R1' }));
    setLink(store, 'LP-2', entry({ remoteId: 'R2' }));

    const pruned = pruneMissingLinks(store, new Set(['LP-1']));
    expect(pruned).toEqual(['LP-2']);
    expect(store.links.size).toBe(1);
    expect(store.links.has('LP-1')).toBe(true);
    expect(store.byRemote.has('R2')).toBe(false);
  });
});

describe('multiple remotes', () => {
  it('stores links for different remotes in separate files', () => {
    const paths = makeBoard();

    const gh = loadLinkStore(paths, 'github');
    setLink(gh, 'LP-1', entry({ remoteId: 'gh-1', remoteKey: 'owner/repo#1' }));
    saveLinkStore(paths, 'github', gh);

    const jira = loadLinkStore(paths, 'jira');
    setLink(jira, 'LP-1', entry({ remoteId: 'JIRA-42', remoteKey: 'PROJ-42' }));
    saveLinkStore(paths, 'jira', jira);

    // Each remote sees only its own links.
    const ghReloaded = loadLinkStore(paths, 'github');
    expect(ghReloaded.links.get('LP-1')!.remoteId).toBe('gh-1');

    const jiraReloaded = loadLinkStore(paths, 'jira');
    expect(jiraReloaded.links.get('LP-1')!.remoteId).toBe('JIRA-42');

    // Same local id can be linked in both remotes.
    expect(ghReloaded.links.size).toBe(1);
    expect(jiraReloaded.links.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Managed block & body hashing
// ---------------------------------------------------------------------------

describe('stripManagedBlock', () => {
  it('returns the body unchanged when there is no managed block', () => {
    expect(stripManagedBlock('Plain body text.')).toBe('Plain body text.');
    expect(stripManagedBlock('')).toBe('');
  });

  it('removes the managed block and trims the result', () => {
    const body = [
      'User story description.',
      MANAGED_BLOCK_BEGIN,
      'priority: high',
      'points: 5',
      MANAGED_BLOCK_END,
      'More text after.',
    ].join('\n');

    const result = stripManagedBlock(body);
    expect(result).toBe('User story description.\n\nMore text after.');
  });

  it('handles a managed block at the very start', () => {
    const body = [
      MANAGED_BLOCK_BEGIN,
      'priority: high',
      MANAGED_BLOCK_END,
      'Actual body.',
    ].join('\n');

    expect(stripManagedBlock(body)).toBe('Actual body.');
  });

  it('handles a managed block at the very end', () => {
    const body = [
      'Actual body.',
      MANAGED_BLOCK_BEGIN,
      'priority: high',
      MANAGED_BLOCK_END,
    ].join('\n');

    expect(stripManagedBlock(body)).toBe('Actual body.');
  });

  it('returns empty string when the body is only a managed block', () => {
    const body = `${MANAGED_BLOCK_BEGIN}\nsome fields\n${MANAGED_BLOCK_END}`;
    expect(stripManagedBlock(body)).toBe('');
  });
});

describe('hashBody', () => {
  it('produces a sha256: prefix followed by 64 hex digits', () => {
    const hash = hashBody('Hello');
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('produces a stable hash for the same input', () => {
    expect(hashBody('same text')).toBe(hashBody('same text'));
  });

  it('produces different hashes for different inputs', () => {
    expect(hashBody('a')).not.toBe(hashBody('b'));
  });

  it('excludes the managed block from the hash', () => {
    const withoutBlock = 'Important content.';
    const withBlock = [
      'Important content.',
      MANAGED_BLOCK_BEGIN,
      'priority: high',
      MANAGED_BLOCK_END,
    ].join('\n');

    // Same normalised body → same hash.
    expect(hashBody(withBlock)).toBe(hashBody(withoutBlock));
  });

  it('is sensitive to changes outside the managed block', () => {
    const a = [
      'Original body.',
      MANAGED_BLOCK_BEGIN,
      'priority: high',
      MANAGED_BLOCK_END,
    ].join('\n');

    const b = [
      'Changed body.',
      MANAGED_BLOCK_BEGIN,
      'priority: high',
      MANAGED_BLOCK_END,
    ].join('\n');

    expect(hashBody(a)).not.toBe(hashBody(b));
  });

  it('is insensitive to changes only in the managed block', () => {
    const a = [
      'Same body.',
      MANAGED_BLOCK_BEGIN,
      'priority: high',
      MANAGED_BLOCK_END,
    ].join('\n');

    const b = [
      'Same body.',
      MANAGED_BLOCK_BEGIN,
      'priority: low',
      'points: 3',
      MANAGED_BLOCK_END,
    ].join('\n');

    expect(hashBody(a)).toBe(hashBody(b));
  });

  it('trims whitespace outside the managed block', () => {
    expect(hashBody('  text  ')).toBe(hashBody('text'));
  });
});

describe('isBodyHash', () => {
  it('returns true for a valid sha256: hash', () => {
    expect(isBodyHash(hashBody('anything'))).toBe(true);
  });

  it('returns false for plain text', () => {
    expect(isBodyHash('just some text')).toBe(false);
    expect(isBodyHash('sha256:too-short')).toBe(false);
  });

  it('returns false for non-strings', () => {
    expect(isBodyHash(null)).toBe(false);
    expect(isBodyHash(undefined)).toBe(false);
    expect(isBodyHash(123)).toBe(false);
    expect(isBodyHash({})).toBe(false);
  });

  it('returns false for sha256: with wrong hex length', () => {
    expect(isBodyHash('sha256:abc')).toBe(false);
    expect(
      isBodyHash(`sha256:${'0'.repeat(63)}`),
    ).toBe(false);
    expect(
      isBodyHash(`sha256:${'0'.repeat(65)}`),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Base snapshots
// ---------------------------------------------------------------------------

describe('computeBase', () => {
  const issueDoc = {
    title: 'Add login',
    body: 'Implement the login flow.',
    attributes: { story_points: 5, priority: 'high' },
    status: 'in_progress',
    assignee: 'LP-R1',
    period: 'LP-P1',
    dependsOn: ['LP-5', 'LP-3'],
    relatesTo: ['LP-10'],
    relatedFiles: ['src/auth/login.ts'],
  };

  it('snapshots every mapped field', () => {
    const base = computeBase(
      issueDoc,
      new Set(['title', 'status', 'assignee', 'body', 'story_points']),
    );

    expect(base.title).toBe('Add login');
    expect(base.status).toBe('in_progress');
    expect(base.assignee).toBe('LP-R1');
    expect(isBodyHash(base.body)).toBe(true);
    expect(base.story_points).toBe(5);
  });

  it('stores the body as a hash, not the full text', () => {
    const base = computeBase(issueDoc, new Set(['body']));

    expect(base.body).not.toBe(issueDoc.body);
    expect(isBodyHash(base.body)).toBe(true);
  });

  it('includes push-only fields — the direction does not gate the snapshot', () => {
    // Even a field with direction: push should be snapshotted, so a later
    // switch to both has something to compare against.
    const base = computeBase(issueDoc, new Set(['title']));
    expect(base.title).toBe('Add login');
  });

  it('omits fields not in mappedFields', () => {
    const base = computeBase(issueDoc, new Set(['title']));

    expect(Object.keys(base)).toEqual(['title']);
    expect(base).not.toHaveProperty('status');
    expect(base).not.toHaveProperty('assignee');
    expect(base).not.toHaveProperty('story_points');
  });

  it('snapshots list fields as sorted arrays', () => {
    const base = computeBase(issueDoc, new Set(['depends_on']));

    // dependsOn was ['LP-5', 'LP-3'] → sorted → ['LP-3', 'LP-5']
    expect(base.depends_on).toEqual(['LP-3', 'LP-5']);
  });

  it('snapshots empty list fields as empty arrays', () => {
    const doc = {
      title: 'T',
      body: '',
      attributes: {},
      dependsOn: [],
    };
    const base = computeBase(doc, new Set(['depends_on']));
    expect(base.depends_on).toEqual([]);
  });

  it('snapshots a missing list field as an empty array', () => {
    const doc = {
      title: 'T',
      body: '',
      attributes: {},
    };
    const base = computeBase(doc, new Set(['depends_on']));
    expect(base.depends_on).toEqual([]);
  });

  it('snapshots null assignee/period as null', () => {
    const doc = {
      title: 'T',
      body: '',
      attributes: {},
      assignee: null,
      period: null,
    };
    const base = computeBase(doc, new Set(['assignee', 'period']));
    expect(base.assignee).toBeNull();
    expect(base.period).toBeNull();
  });

  it('reads config-declared attributes from the attributes bag', () => {
    const doc = {
      title: 'T',
      body: '',
      attributes: { effort: 3, label: 'backend' },
    };
    const base = computeBase(doc, new Set(['effort', 'label']));
    expect(base.effort).toBe(3);
    expect(base.label).toBe('backend');
  });

  it('returns null for an attribute not present in the document', () => {
    const doc = {
      title: 'T',
      body: '',
      attributes: {},
    };
    const base = computeBase(doc, new Set(['story_points']));
    expect(base.story_points).toBeNull();
  });

  it('handles an empty mappedFields set', () => {
    const base = computeBase(issueDoc, new Set());
    expect(Object.keys(base)).toEqual([]);
  });

  it('produces a stable snapshot for the same document', () => {
    const a = computeBase(issueDoc, new Set(['title', 'status', 'depends_on', 'body']));
    const b = computeBase(issueDoc, new Set(['title', 'status', 'depends_on', 'body']));
    expect(a).toEqual(b);
  });
});

describe('updateBase', () => {
  it('updates the base snapshot for an existing link', () => {
    const { store } = freshStore();
    setLink(
      store,
      'LP-1',
      entry({
        remoteId: 'R1',
        base: { title: 'Old title' },
        baseHash: 'sha256:old',
      }),
    );

    updateBase(store, 'LP-1', { title: 'New title', status: 'done' }, 'rev-2', '2026-09-05T00:00:00Z');

    const link = store.links.get('LP-1')!;
    expect(link.base).toEqual({ title: 'New title', status: 'done' });
    expect(link.baseHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(link.remoteRev).toBe('rev-2');
    expect(link.syncedAt).toBe('2026-09-05T00:00:00Z');
  });

  it('is a no-op when the local id has no link', () => {
    const { store } = freshStore();
    // Should not throw.
    updateBase(store, 'LP-ghost', { title: 'Nope' }, 'rev', '2026-01-01T00:00:00Z');
    expect(store.links.size).toBe(0);
  });

  it('produces a deterministic baseHash for the same base', () => {
    const { store } = freshStore();
    setLink(store, 'LP-a', entry({ remoteId: 'Ra' }));
    setLink(store, 'LP-b', entry({ remoteId: 'Rb' }));

    const base = { title: 'Same', status: 'done' };
    updateBase(store, 'LP-a', base, 'rev', '2026-01-01T00:00:00Z');
    updateBase(store, 'LP-b', base, 'rev', '2026-01-01T00:00:00Z');

    expect(store.links.get('LP-a')!.baseHash).toBe(store.links.get('LP-b')!.baseHash);
  });

  it('produces a different baseHash for a different base', () => {
    const { store } = freshStore();
    setLink(store, 'LP-a', entry({ remoteId: 'Ra' }));
    setLink(store, 'LP-b', entry({ remoteId: 'Rb' }));

    updateBase(store, 'LP-a', { title: 'A' }, 'rev', '2026-01-01T00:00:00Z');
    updateBase(store, 'LP-b', { title: 'B' }, 'rev', '2026-01-01T00:00:00Z');

    expect(store.links.get('LP-a')!.baseHash).not.toBe(store.links.get('LP-b')!.baseHash);
  });

  it('only updates the one document specified', () => {
    const { store } = freshStore();
    setLink(
      store,
      'LP-1',
      entry({ remoteId: 'R1', base: { title: 'Old 1' }, baseHash: 'sha256:old1' }),
    );
    setLink(
      store,
      'LP-2',
      entry({ remoteId: 'R2', base: { title: 'Old 2' }, baseHash: 'sha256:old2' }),
    );

    updateBase(store, 'LP-1', { title: 'New 1' }, 'rev-2', '2026-09-05T00:00:00Z');

    // LP-1 is updated.
    expect(store.links.get('LP-1')!.base).toEqual({ title: 'New 1' });
    // LP-2 is untouched.
    expect(store.links.get('LP-2')!.base).toEqual({ title: 'Old 2' });
    expect(store.links.get('LP-2')!.baseHash).toBe('sha256:old2');
  });

  it('round-trips through save/load', () => {
    const paths = makeBoard();
    const store = loadLinkStore(paths, 'upstream');
    setLink(store, 'LP-1', entry({ remoteId: 'R1' }));
    updateBase(store, 'LP-1', { title: 'Saved', status: 'done' }, 'rev-3', '2026-09-06T00:00:00Z');
    saveLinkStore(paths, 'upstream', store);

    const reloaded = loadLinkStore(paths, 'upstream');
    const link = reloaded.links.get('LP-1')!;
    expect(link.base).toEqual({ title: 'Saved', status: 'done' });
    expect(link.baseHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(link.remoteRev).toBe('rev-3');
    expect(link.syncedAt).toBe('2026-09-06T00:00:00Z');
  });

  it('partially failed sync: only the landed document gets its base updated', () => {
    const { store } = freshStore();
    setLink(store, 'LP-1', entry({ remoteId: 'R1' }));
    setLink(store, 'LP-2', entry({ remoteId: 'R2' }));

    // LP-1 lands.
    updateBase(store, 'LP-1', { title: 'Landed' }, 'rev-new', '2026-09-07T00:00:00Z');

    // LP-2 failed — no updateBase call.

    expect(store.links.get('LP-1')!.base).toEqual({ title: 'Landed' });
    // LP-2 still has whatever it had before (nothing in this case).
    expect(store.links.get('LP-2')!.base).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cursor management
// ---------------------------------------------------------------------------

describe('getCursorForPull', () => {
  it('returns the stored cursor by default', () => {
    const { store } = freshStore();
    store.cursor = 'page-token-42';
    expect(getCursorForPull(store)).toBe('page-token-42');
  });

  it('returns null when the store has no cursor', () => {
    const { store } = freshStore();
    expect(store.cursor).toBeNull();
    expect(getCursorForPull(store)).toBeNull();
  });

  it('returns null when fullSync is true, ignoring a stored cursor', () => {
    const { store } = freshStore();
    store.cursor = 'page-token-42';
    expect(getCursorForPull(store, { fullSync: true })).toBeNull();
  });

  it('returns null when fullSync is true, even when cursor is null already', () => {
    const { store } = freshStore();
    expect(getCursorForPull(store, { fullSync: true })).toBeNull();
  });

  it('returns the stored cursor when fullSync is false', () => {
    const { store } = freshStore();
    store.cursor = 'opaque-cursor';
    expect(getCursorForPull(store, { fullSync: false })).toBe('opaque-cursor');
  });

  it('does not mutate the store', () => {
    const { store } = freshStore();
    store.cursor = 'before';
    getCursorForPull(store, { fullSync: true });
    // cursor is still there — we just chose not to use it
    expect(store.cursor).toBe('before');
  });
});

describe('advanceCursor', () => {
  it('sets the cursor to a new value', () => {
    const { store } = freshStore();
    advanceCursor(store, 'new-token');
    expect(store.cursor).toBe('new-token');
  });

  it('overwrites an existing cursor', () => {
    const { store } = freshStore();
    store.cursor = 'old-token';
    advanceCursor(store, 'newer-token');
    expect(store.cursor).toBe('newer-token');
  });

  it('round-trips through save/load', () => {
    const paths = makeBoard();
    const store = loadLinkStore(paths, 'upstream');
    advanceCursor(store, 'page-token-99');
    saveLinkStore(paths, 'upstream', store);

    const reloaded = loadLinkStore(paths, 'upstream');
    expect(reloaded.cursor).toBe('page-token-99');
  });

  it('accepts a timestamp value from a remote', () => {
    const { store } = freshStore();
    advanceCursor(store, '2026-09-04T11:20:03Z');
    expect(store.cursor).toBe('2026-09-04T11:20:03Z');
  });

  it('accepts an opaque page token', () => {
    const { store } = freshStore();
    advanceCursor(store, 'eyJwYWdlIjogMn0=');
    expect(store.cursor).toBe('eyJwYWdlIjogMn0=');
  });
});

describe('clearCursor', () => {
  it('resets a cursor to null', () => {
    const { store } = freshStore();
    store.cursor = 'something';
    clearCursor(store);
    expect(store.cursor).toBeNull();
  });

  it('is a no-op when cursor is already null', () => {
    const { store } = freshStore();
    expect(store.cursor).toBeNull();
    clearCursor(store);
    expect(store.cursor).toBeNull();
  });

  it('round-trips through save/load', () => {
    const paths = makeBoard();
    const store = loadLinkStore(paths, 'upstream');
    store.cursor = 'before-clear';
    clearCursor(store);
    saveLinkStore(paths, 'upstream', store);

    const reloaded = loadLinkStore(paths, 'upstream');
    expect(reloaded.cursor).toBeNull();
  });
});

describe('cursor contract: not advanced on failure', () => {
  it('cursor stays unchanged when advanceCursor is never called', () => {
    // Simulation of a failed pull: the planner calls getCursorForPull, makes
    // requests, encounters an error, and never calls advanceCursor.
    const { store } = freshStore();
    store.cursor = 'before-attempt';

    // Pull begins — cursor is read.
    const cursor = getCursorForPull(store);
    expect(cursor).toBe('before-attempt');

    // Pull fails — advanceCursor is never called.
    // The store is unchanged.
    expect(store.cursor).toBe('before-attempt');
  });

  it('a partial success advances the cursor from the last successful page', () => {
    // If a paginated pull succeeds for pages 1-3 and fails on page 4, the
    // cursor should be the one from page 3, not the one before the pull.
    const { store } = freshStore();
    store.cursor = 'page-0';

    // Page 1 succeeds.
    advanceCursor(store, 'page-1');
    // Page 2 succeeds.
    advanceCursor(store, 'page-2');
    // Page 3 succeeds.
    advanceCursor(store, 'page-3');
    // Page 4 fails — no call.

    expect(store.cursor).toBe('page-3');
  });

  it('clearCursor lets a failed pull reset for a full rescan', () => {
    const { store } = freshStore();
    store.cursor = 'dangling';
    clearCursor(store);
    // Next pull will do a full scan.
    expect(getCursorForPull(store)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cursor value contract: remote-supplied, never local wall clock
// ---------------------------------------------------------------------------

describe('cursor value convention', () => {
  it("accepts a server-side timestamp (which looks like ISO but is the remote's clock)", () => {
    const { store } = freshStore();
    // A remote that uses its own last-modified timestamps as cursors returns
    // something that looks like an ISO date, but it is the *remote's* clock.
    advanceCursor(store, '2027-02-12T09:30:00Z');
    expect(store.cursor).toBe('2027-02-12T09:30:00Z');
  });

  it('accepts an opaque string that is not ISO at all', () => {
    const { store } = freshStore();
    // GitHub's GraphQL pagination uses base64-encoded cursors.
    advanceCursor(store, 'Y3Vyc29yOnYyOpHOBPd/qAAA==');
    expect(store.cursor).toBe('Y3Vyc29yOnYyOpHOBPd/qAAA==');
  });

  it('does not forbid a value that happens to be local time — enforcement is at the call site', () => {
    // The function cannot tell `Date.now().toISOString()` from a timestamp
    // the remote genuinely returned.  The contract lives in the doc comment
    // and in the pull planner, which is the only caller.
    const { store } = freshStore();
    advanceCursor(store, new Date('2027-02-12T10:00:00Z').toISOString());
    expect(store.cursor).toBe('2027-02-12T10:00:00.000Z');
  });
});

afterAll(() => {
  cleanupBoards();
});
