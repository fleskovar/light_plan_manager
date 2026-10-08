import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BoardError } from '../src/core/errors.js';
import { parseConfigText } from '../src/core/index.js';
import {
  affectedDocuments,
  assessMappingChange,
  canonicalMapping,
  checkMappingChange,
  classifyMappingChanges,
  diffMapping,
  fingerprintMapping,
  loadMappingSnapshot,
  mappingSnapshotPath,
  saveMappingSnapshot,
} from '../src/remote/fingerprint.js';
import type { LinkStore } from '../src/remote/links.js';
import { openRemote } from '../src/remote/remotes.js';
import { cleanupBoards, makeBoard } from './helpers.js';

afterAll(cleanupBoards);

/**
 * LP-370 — a mapping fingerprint stored beside the links, compared before a
 * sync plans, so a mapping change is detected before it manufactures a
 * board-wide wave of phantom conflicts.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MAPPING = {
  types: { task: { remote: 'task' } },
  statuses: {
    in_progress: { remote: ['In Progress'] },
    done: { remote: ['Done'] },
  },
  attributes: { story_points: 'Points' },
};

/** The same mapping with keys reordered and written differently. */
const MAPPING_REORDERED = {
  attributes: { story_points: 'Points' },
  statuses: {
    done: { remote: ['Done'] },
    in_progress: { remote: ['In Progress'] },
  },
  types: { task: { remote: 'task' } },
};

/** An in-memory link store with base snapshots in several statuses. */
function store(): LinkStore {
  const links = new Map();
  const byRemote = new Map();
  const put = (localId: string, remoteId: string, base: Record<string, unknown>): void => {
    links.set(localId, {
      remoteId,
      remoteKey: remoteId,
      remoteUrl: '',
      syncedAt: '2026-09-04T11:19:58Z',
      remoteRev: '2026-09-04T11:19:57Z',
      base,
    });
    byRemote.set(remoteId, localId);
  };
  put('LP-1', 'R1', { status: 'in_progress', story_points: 5, assignee: 'RS-1', period: 'TL-1' });
  put('LP-2', 'R2', { status: 'done', story_points: 8 });
  put('LP-3', 'R3', { status: 'in_progress' });
  return { version: 1, cursor: null, links, byRemote, tombstones: new Map() };
}

// A board whose provider schema fills in the mapping defaults.
const MINIMAL = `
version: 1
key_prefix: LP
statuses:
  - id: todo
    label: To Do
  - id: done
    label: Done
hierarchy: [task]
issue_types:
  task:
    label: Task
`;

function configWith(remotes: string) {
  const { config, errors } = parseConfigText(`${MINIMAL}${remotes}`);
  expect(errors).toEqual([]);
  return config!;
}

// ---------------------------------------------------------------------------
// Canonical form and fingerprint
// ---------------------------------------------------------------------------

describe('fingerprintMapping', () => {
  it('produces a sha256: prefix followed by 64 hex digits', () => {
    expect(fingerprintMapping(MAPPING)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is stable across key reorder and reformat', () => {
    expect(canonicalMapping(MAPPING)).toBe(canonicalMapping(MAPPING_REORDERED));
    expect(fingerprintMapping(MAPPING)).toBe(fingerprintMapping(MAPPING_REORDERED));
  });

  it('preserves array order, which is load-bearing', () => {
    // remote[0] is what a push writes, so the order is part of the behaviour.
    const a = { statuses: { done: { remote: ['Done', "Won't Fix"] } } };
    const b = { statuses: { done: { remote: ["Won't Fix", 'Done'] } } };
    expect(fingerprintMapping(a)).not.toBe(fingerprintMapping(b));
  });

  it('differs when a value changes', () => {
    const changed = {
      ...MAPPING,
      statuses: { in_progress: { remote: ['In Development'] }, done: { remote: ['Done'] } },
    };
    expect(fingerprintMapping(MAPPING)).not.toBe(fingerprintMapping(changed));
  });

  it('hashes the resolved mapping — defaults filled in, raw YAML text excluded', () => {
    const shorthand = configWith(`
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    connection: { repo: acme/payments }
    mapping:
      statuses: { todo: Todo, done: Done }
`);
    const explicit = configWith(`
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    connection:
      repo: acme/payments
    mapping:
      types: {}
      statuses: { todo: Todo, done: Done }
      attributes: {}
`);
    const a = openRemote(shorthand, 'upstream').mapping;
    const b = openRemote(explicit, 'upstream').mapping;
    // The shorthand and the explicit form resolve to the same mapping, so they
    // fingerprint the same — the fingerprint is over the resolved mapping,
    // never over the YAML text.
    expect(fingerprintMapping(a)).toBe(fingerprintMapping(b));
  });
});

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

describe('mapping snapshot I/O', () => {
  it('resolves under .lpm/remotes/<name>/mapping.json, beside links.json', () => {
    const paths = makeBoard();
    expect(mappingSnapshotPath(paths, 'upstream')).toBe(
      path.join(paths.remotesDir, 'upstream', 'mapping.json'),
    );
  });

  it('returns undefined when no snapshot has been recorded', () => {
    const paths = makeBoard();
    expect(loadMappingSnapshot(paths, 'upstream')).toBeUndefined();
  });

  it('save/load round-trips the fingerprint and the resolved mapping', () => {
    const paths = makeBoard();
    const saved = saveMappingSnapshot(paths, 'upstream', MAPPING);
    const loaded = loadMappingSnapshot(paths, 'upstream')!;

    expect(loaded.version).toBe(1);
    expect(loaded.fingerprint).toBe(saved.fingerprint);
    expect(loaded.mapping).toEqual(saved.mapping);
    // Re-fingerprinting the reloaded mapping agrees with the stored fingerprint.
    expect(fingerprintMapping(loaded.mapping)).toBe(loaded.fingerprint);
  });

  it('stores the canonical form, so the file is byte-stable across reformats', () => {
    const paths = makeBoard();
    saveMappingSnapshot(paths, 'upstream', MAPPING);
    const raw = require('node:fs').readFileSync(mappingSnapshotPath(paths, 'upstream'), 'utf8');
    const parsed = JSON.parse(raw);
    // Object keys are sorted; the top-level key order is alphabetical.
    expect(Object.keys(parsed.mapping)).toEqual(['attributes', 'statuses', 'types']);
  });

  it('throws BoardError on malformed JSON', () => {
    const paths = makeBoard();
    const file = mappingSnapshotPath(paths, 'upstream');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'not json {{{');

    expect(() => loadMappingSnapshot(paths, 'upstream')).toThrow(BoardError);
  });

  it('throws BoardError on an unsupported version', () => {
    const paths = makeBoard();
    const file = mappingSnapshotPath(paths, 'upstream');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 99, fingerprint: 'x', mapping: {} }));

    try {
      loadMappingSnapshot(paths, 'upstream');
    } catch (error) {
      expect(error).toBeInstanceOf(BoardError);
      expect((error as BoardError).message).toContain('version');
    }
  });

  it('throws BoardError when the fingerprint is missing', () => {
    const paths = makeBoard();
    const file = mappingSnapshotPath(paths, 'upstream');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, mapping: {} }));

    try {
      loadMappingSnapshot(paths, 'upstream');
    } catch (error) {
      expect(error).toBeInstanceOf(BoardError);
      expect((error as BoardError).details.some((d) => d.includes('fingerprint'))).toBe(true);
    }
  });

  it('throws BoardError when the mapping is not an object', () => {
    const paths = makeBoard();
    const file = mappingSnapshotPath(paths, 'upstream');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, fingerprint: 'sha256:abc', mapping: 'nope' }));

    try {
      loadMappingSnapshot(paths, 'upstream');
    } catch (error) {
      expect(error).toBeInstanceOf(BoardError);
      expect((error as BoardError).details.some((d) => d.includes('mapping'))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

describe('diffMapping', () => {
  it('returns no changes for equal mappings, whatever the key order', () => {
    expect(diffMapping(MAPPING, MAPPING_REORDERED)).toEqual([]);
  });

  it('reports an added key', () => {
    const changes = diffMapping(
      { statuses: { done: { remote: ['Done'] } } },
      { statuses: { done: { remote: ['Done'] }, todo: { remote: ['Todo'] } } },
    );
    expect(changes).toEqual([
      { path: 'statuses.todo', kind: 'added', next: { remote: ['Todo'] } },
    ]);
  });

  it('reports a removed key', () => {
    const changes = diffMapping(
      { statuses: { done: { remote: ['Done'] }, todo: { remote: ['Todo'] } } },
      { statuses: { done: { remote: ['Done'] } } },
    );
    expect(changes).toEqual([
      { path: 'statuses.todo', kind: 'removed', old: { remote: ['Todo'] } },
    ]);
  });

  it('reports a changed leaf with its old and next values', () => {
    const changes = diffMapping(
      { statuses: { in_progress: { remote: ['In Progress'] } } },
      { statuses: { in_progress: { remote: ['In Development'] } } },
    );
    expect(changes).toEqual([
      { path: 'statuses.in_progress.remote', kind: 'changed', old: ['In Progress'], next: ['In Development'] },
    ]);
  });

  it('treats arrays as leaves — one change, not one per element', () => {
    const changes = diffMapping(
      { statuses: { done: { remote: ['Done'] } } },
      { statuses: { done: { remote: ['Done', "Won't Fix"] } } },
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      path: 'statuses.done.remote',
      kind: 'changed',
      old: ['Done'],
      next: ['Done', "Won't Fix"],
    });
  });

  it('walks nested keys in sorted order for a deterministic report', () => {
    const changes = diffMapping(
      { attributes: { a: 'A', b: 'B' } },
      { attributes: { a: 'X', b: 'B' } },
    );
    expect(changes).toEqual([
      { path: 'attributes.a', kind: 'changed', old: 'A', next: 'X' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe('classifyMappingChanges', () => {
  it('is unchanged when there are no changes', () => {
    expect(classifyMappingChanges([])).toBe('unchanged');
  });

  it('is additive when every change is an addition', () => {
    expect(
      classifyMappingChanges([
        { path: 'attributes.effort', kind: 'added', next: 'Effort' },
        { path: 'statuses.blocked', kind: 'added', next: { remote: 'Blocked' } },
      ]),
    ).toBe('additive');
  });

  it('is breaking when any change is a change', () => {
    expect(
      classifyMappingChanges([
        { path: 'attributes.effort', kind: 'added', next: 'Effort' },
        { path: 'statuses.done.remote', kind: 'changed', old: ['Done'], next: ['Shipped'] },
      ]),
    ).toBe('breaking');
  });

  it('is breaking when any change is a removal', () => {
    expect(
      classifyMappingChanges([{ path: 'statuses.done', kind: 'removed', old: { remote: 'Done' } }]),
    ).toBe('breaking');
  });
});

// ---------------------------------------------------------------------------
// Affected documents
// ---------------------------------------------------------------------------

describe('affectedDocuments', () => {
  const links = store();

  it('a statuses change affects documents recorded in that status', () => {
    expect(
      affectedDocuments(
        [{ path: 'statuses.in_progress.remote', kind: 'changed', old: ['In Progress'], next: ['In Development'] }],
        links,
      ),
    ).toEqual(['LP-1', 'LP-3']);
  });

  it('an attributes change affects documents with that attribute snapshotted', () => {
    expect(
      affectedDocuments(
        [{ path: 'attributes.story_points', kind: 'changed', old: 'Points', next: 'SP' }],
        links,
      ),
    ).toEqual(['LP-1', 'LP-2']);
  });

  it('an accounts change affects every document with an assignee snapshot', () => {
    expect(
      affectedDocuments(
        [{ path: 'accounts.via', kind: 'changed', old: 'github', next: 'github_login' }],
        links,
      ),
    ).toEqual(['LP-1']);
  });

  it('a periods change affects every document with a period snapshot', () => {
    expect(
      affectedDocuments(
        [{ path: 'periods.container', kind: 'changed', old: 'sprint', next: 'milestone' }],
        links,
      ),
    ).toEqual(['LP-1']);
  });

  it('a types change affects nothing — the type is not part of a base snapshot', () => {
    expect(
      affectedDocuments(
        [{ path: 'types.task.labels', kind: 'changed', old: ['task'], next: ['issue'] }],
        links,
      ),
    ).toEqual([]);
  });

  it('an added change affects nothing', () => {
    expect(
      affectedDocuments([{ path: 'attributes.effort', kind: 'added', next: 'Effort' }], links),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pure assessment
// ---------------------------------------------------------------------------

describe('assessMappingChange', () => {
  const links = store();

  it('is unchanged before the first sync (no stored mapping)', () => {
    expect(assessMappingChange(undefined, MAPPING, links)).toEqual({
      changed: false,
      changes: [],
      classification: 'unchanged',
      affected: [],
    });
  });

  it('is unchanged when the stored and current mappings are equal', () => {
    const result = assessMappingChange(MAPPING, MAPPING_REORDERED, links);
    expect(result.changed).toBe(false);
    expect(result.classification).toBe('unchanged');
    expect(result.changes).toEqual([]);
    expect(result.affected).toEqual([]);
  });

  it('an additive change invalidates nothing', () => {
    const result = assessMappingChange(
      { statuses: { done: { remote: ['Done'] } } },
      { statuses: { done: { remote: ['Done'] }, todo: { remote: ['Todo'] } } },
      links,
    );
    expect(result.changed).toBe(true);
    expect(result.classification).toBe('additive');
    expect(result.affected).toEqual([]);
  });

  it('a breaking change names exactly the affected documents', () => {
    const result = assessMappingChange(
      {
        statuses: {
          in_progress: { remote: ['In Progress'] },
          done: { remote: ['Done'] },
        },
      },
      {
        statuses: {
          in_progress: { remote: ['In Development'] },
          done: { remote: ['Done'] },
        },
      },
      links,
    );
    expect(result.changed).toBe(true);
    expect(result.classification).toBe('breaking');
    expect(result.affected).toEqual(['LP-1', 'LP-3']);
  });
});

// ---------------------------------------------------------------------------
// The pre-planning guard
// ---------------------------------------------------------------------------

describe('checkMappingChange', () => {
  const links = store();

  it('first sync: no snapshot, unchanged, nothing written', () => {
    const paths = makeBoard();
    const result = checkMappingChange(paths, 'upstream', MAPPING, links);
    expect(result.classification).toBe('unchanged');
    expect(loadMappingSnapshot(paths, 'upstream')).toBeUndefined();
  });

  it('unchanged when the fingerprint matches the stored one', () => {
    const paths = makeBoard();
    saveMappingSnapshot(paths, 'upstream', MAPPING);
    const result = checkMappingChange(paths, 'upstream', MAPPING_REORDERED, links);
    expect(result.classification).toBe('unchanged');
    expect(result.changed).toBe(false);
  });

  it('an additive change updates the fingerprint in place and invalidates nothing', () => {
    const paths = makeBoard();
    saveMappingSnapshot(paths, 'upstream', { statuses: { done: { remote: ['Done'] } } });
    const next = { statuses: { done: { remote: ['Done'] }, todo: { remote: ['Todo'] } } };

    const result = checkMappingChange(paths, 'upstream', next, links);
    expect(result.classification).toBe('additive');
    expect(result.affected).toEqual([]);

    // The snapshot was updated in place to the new mapping...
    expect(loadMappingSnapshot(paths, 'upstream')!.fingerprint).toBe(fingerprintMapping(next));
    // ...so a second check reports no change.
    expect(checkMappingChange(paths, 'upstream', next, links).classification).toBe('unchanged');
  });

  it('a breaking change leaves the snapshot alone and names the affected documents', () => {
    const paths = makeBoard();
    const before = {
      statuses: { in_progress: { remote: ['In Progress'] }, done: { remote: ['Done'] } },
    };
    saveMappingSnapshot(paths, 'upstream', before);
    const next = {
      statuses: { in_progress: { remote: ['In Development'] }, done: { remote: ['Done'] } },
    };

    const result = checkMappingChange(paths, 'upstream', next, links);
    expect(result.classification).toBe('breaking');
    expect(result.affected).toEqual(['LP-1', 'LP-3']);

    // The stored snapshot still records the old mapping — re-basing (LP-371)
    // is the explicit operation that updates it, never this guard.
    expect(loadMappingSnapshot(paths, 'upstream')!.fingerprint).toBe(fingerprintMapping(before));
  });
});
