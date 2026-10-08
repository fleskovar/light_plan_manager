import { describe, expect, it } from 'vitest';
import {
  planConflicts,
  trackedFields,
  type ConflictOptions,
  type DocumentMerge,
} from '../src/remote/conflicts.js';
import type { LinkStore } from '../src/remote/links.js';
import type { BoardFieldsPatch } from '../src/remote/provider.js';
import {
  recordDocumentResolution,
  recordFieldResolution,
  type ResolutionStore,
} from '../src/remote/resolutions.js';
import { NO_BASE } from '../src/remote/merge.js';
import type { IssueDto } from '../src/shared/model.js';
import type { BoardView } from '../src/shared/plans/reading.js';

/**
 * LP-287 — the conflict driver: the four-case merge across a whole document,
 * with policy and pending resolutions applied.  Pure: no board on disk, no
 * network — the remote side arrives as already-translated patches.
 */

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

function issue(id: string, over: Partial<IssueDto> & { attributes?: Record<string, unknown> } = {}): IssueDto {
  return {
    kind: 'issue',
    id,
    type: 'user_story',
    title: over.title ?? id,
    body: over.body ?? '',
    parentId: null,
    depth: 0,
    attributes: over.attributes ?? {},
    status: over.status ?? 'in_progress',
    assignee: over.assignee ?? null,
    period: over.period ?? null,
    flag: null,
    dependsOn: [],
    relatesTo: [],
    relatedFiles: [],
  };
}

function viewOf(issues: IssueDto[]): BoardView {
  const nodes = Object.fromEntries(issues.map((node) => [node.id, node]));
  return { config: {} as BoardView['config'], nodes };
}

function linkStore(
  entries: Record<string, { remoteId: string; base?: Record<string, unknown> }>,
): LinkStore {
  const links = new Map(
    Object.entries(entries).map(([localId, entry]) => [
      localId,
      {
        remoteId: entry.remoteId,
        remoteKey: entry.remoteId,
        remoteUrl: '',
        syncedAt: '2026-09-04T11:19:58Z',
        remoteRev: '2026-09-04T11:19:57Z',
        ...(entry.base ? { base: entry.base } : {}),
      },
    ]),
  );
  const byRemote = new Map<string, string>();
  for (const [localId, entry] of links) byRemote.set(entry.remoteId, localId);
  return { version: 1, cursor: null, links, byRemote, tombstones: new Map() };
}

function resolutions(): ResolutionStore {
  return { version: 1, resolutions: new Map() };
}

const MAPPING = {
  statuses: {
    in_progress: { remote: ['In Progress'] },
    done: { remote: ['Done'] },
  },
  attributes: { story_points: 'Points' },
  accounts: { via: 'github' },
  periods: { container: 'sprint' },
};

/** The default manual policy, matching a remote that lets conflicts surface. */
function manual(): ConflictOptions {
  return { conflict: 'manual', overrides: {}, resolutions: resolutions() };
}

/** Plan the merge for one document and return it, for focused assertions. */
function planOne(
  doc: IssueDto,
  patch: BoardFieldsPatch,
  base: Record<string, unknown> | undefined,
  options: ConflictOptions = manual(),
  fields: ReadonlySet<string> = trackedFields(MAPPING),
): DocumentMerge {
  const plan = planConflicts(
    viewOf([doc]),
    linkStore({ [doc.id]: { remoteId: 'R1', ...(base ? { base } : {}) } }),
    new Map([[doc.id, patch]]),
    options,
    fields,
  );
  return plan.documents[0]!;
}

function fieldOf(doc: DocumentMerge, field: string) {
  return doc.fields.find((entry) => entry.field === field)!;
}

// ---------------------------------------------------------------------------
// trackedFields
// ---------------------------------------------------------------------------

describe('trackedFields', () => {
  it('always tracks title, body and status', () => {
    const fields = trackedFields({});
    expect([...fields].sort()).toEqual(['body', 'status', 'title']);
  });

  it('adds assignee and period only when those mappings exist', () => {
    const fields = trackedFields({
      accounts: { via: 'github' },
      periods: { container: 'sprint' },
    });
    expect(fields.has('assignee')).toBe(true);
    expect(fields.has('period')).toBe(true);
    expect(trackedFields({}).has('assignee')).toBe(false);
  });

  it('adds every declared attribute name', () => {
    const fields = trackedFields({ attributes: { story_points: 'Points', priority: 'Pri' } });
    expect(fields.has('story_points')).toBe(true);
    expect(fields.has('priority')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The four cases
// ---------------------------------------------------------------------------

describe('planConflicts — the four cases', () => {
  it('a field only the local side changed is a push, not a conflict', () => {
    const doc = planOne(
      issue('LP-1', { title: 'new title', status: 'in_progress' }),
      { title: 'old title', status: 'in_progress' },
      { title: 'old title', status: 'in_progress' },
    );
    expect(fieldOf(doc, 'title').merge).toBe('push');
    expect(fieldOf(doc, 'title').outcome).toBe('push');
    expect(doc.conflicts).toEqual([]);
  });

  it('a field only the remote side changed is a pull', () => {
    const doc = planOne(
      issue('LP-1', { status: 'in_progress' }),
      { status: 'done' },
      { status: 'in_progress' },
    );
    expect(fieldOf(doc, 'status').merge).toBe('pull');
    expect(doc.conflicts).toEqual([]);
  });

  it('a field both sides edited is a conflict under manual policy', () => {
    const doc = planOne(
      issue('LP-1', { title: 'local title', status: 'done' }),
      { title: 'remote title', status: 'in_progress' },
      { title: 'base title', status: 'in_progress' },
    );
    expect(fieldOf(doc, 'title').outcome).toBe('conflict');
    expect(doc.conflicts.map((entry) => entry.field)).toEqual(['title']);
  });

  it('both sides agreeing is none, even when both moved', () => {
    const doc = planOne(
      issue('LP-1', { title: 'same' }),
      { title: 'same' },
      { title: 'base' },
    );
    expect(fieldOf(doc, 'title').outcome).toBe('none');
    expect(doc.conflicts).toEqual([]);
  });

  it('each field merges independently: a local title push and a remote status pull', () => {
    const doc = planOne(
      issue('LP-1', { title: 'local title', status: 'in_progress' }),
      { title: 'old title', status: 'done' },
      { title: 'old title', status: 'in_progress' },
    );
    expect(fieldOf(doc, 'title').outcome).toBe('push');
    expect(fieldOf(doc, 'status').outcome).toBe('pull');
    expect(doc.conflicts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

describe('planConflicts — config policy', () => {
  it('a local policy breaks a conflict to a push and reports the overwrite', () => {
    const doc = planOne(
      issue('LP-1', { title: 'local title' }),
      { title: 'remote title' },
      { title: 'base title' },
      { conflict: 'local', overrides: {}, resolutions: resolutions() },
    );
    expect(fieldOf(doc, 'title').outcome).toBe('push');
    expect(fieldOf(doc, 'title').overwrote).toBe('remote');
    expect(doc.conflicts).toEqual([]);
  });

  it('a remote-owned field never conflicts: both sides edited, remote wins', () => {
    const doc = planOne(
      issue('LP-1', { status: 'in_progress' }),
      { status: 'done' },
      { status: 'backlog' },
      { conflict: 'manual', overrides: { status: 'remote' }, resolutions: resolutions() },
    );
    expect(fieldOf(doc, 'status').outcome).toBe('pull');
    expect(fieldOf(doc, 'status').overwrote).toBe('local');
  });
});

// ---------------------------------------------------------------------------
// Pending resolutions
// ---------------------------------------------------------------------------

describe('planConflicts — pending resolutions', () => {
  it('a whole-document --local breaks every conflict to a push, and is listed pending', () => {
    const store = resolutions();
    recordDocumentResolution(store, 'LP-1', 'local');
    const doc = planOne(
      issue('LP-1', { title: 'local title', status: 'in_progress' }),
      { title: 'remote title', status: 'done' },
      { title: 'base title', status: 'backlog' },
      { conflict: 'manual', overrides: {}, resolutions: store },
    );
    expect(doc.conflicts).toEqual([]);
    expect(doc.pending.map((entry) => entry.field)).toEqual(['status', 'title']);
    expect(fieldOf(doc, 'title').outcome).toBe('push');
    expect(fieldOf(doc, 'title').resolution).toBe('local');
  });

  it('a per-field --field status --remote settles only that field', () => {
    const store = resolutions();
    recordFieldResolution(store, 'LP-1', 'status', 'remote');
    const doc = planOne(
      issue('LP-1', { title: 'local title', status: 'in_progress' }),
      { title: 'remote title', status: 'done' },
      { title: 'base title', status: 'backlog' },
      { conflict: 'manual', overrides: {}, resolutions: store },
    );
    expect(fieldOf(doc, 'status').outcome).toBe('pull');
    expect(fieldOf(doc, 'status').resolution).toBe('remote');
    // The un-named field stays conflicted.
    expect(fieldOf(doc, 'title').outcome).toBe('conflict');
    expect(doc.conflicts.map((entry) => entry.field)).toEqual(['title']);
    expect(doc.pending.map((entry) => entry.field)).toEqual(['status']);
  });

  it('a resolution outranks the config policy', () => {
    const store = resolutions();
    recordFieldResolution(store, 'LP-1', 'title', 'remote');
    const doc = planOne(
      issue('LP-1', { title: 'local title' }),
      { title: 'remote title' },
      { title: 'base title' },
      { conflict: 'local', overrides: {}, resolutions: store },
    );
    expect(fieldOf(doc, 'title').outcome).toBe('pull');
  });
});

// ---------------------------------------------------------------------------
// Base handling
// ---------------------------------------------------------------------------

describe('planConflicts — base handling', () => {
  it('skips a field the base does not record, rather than manufacturing a conflict', () => {
    const doc = planOne(
      issue('LP-1', { title: 't', attributes: { story_points: 8 } }),
      { title: 't', attributes: { story_points: 13 } },
      { title: 't' }, // story_points not in base
    );
    expect(doc.fields.map((entry) => entry.field)).toEqual(['title']);
  });

  it('a document with no base merges every tracked field against NO_BASE', () => {
    const doc = planOne(
      issue('LP-1', { title: 'local', attributes: { story_points: 8 } }),
      { title: 'remote', attributes: { story_points: 13 } },
      undefined,
    );
    expect(fieldOf(doc, 'title').outcome).toBe('conflict');
    expect(fieldOf(doc, 'story_points').outcome).toBe('conflict');
    expect(doc.conflicts.map((entry) => entry.field).sort()).toEqual(['story_points', 'title']);
  });

  it('a document with no base and no disagreement has no conflicts', () => {
    const doc = planOne(
      issue('LP-1', { title: 'same', attributes: { story_points: 8 } }),
      { title: 'same', attributes: { story_points: 8 } },
      undefined,
    );
    expect(doc.conflicts).toEqual([]);
  });

  it('the body is compared as a hash, so trailing whitespace is not an edit', () => {
    const doc = planOne(
      issue('LP-1', { body: 'the work' }),
      { body: 'the work\n' },
      { body: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' },
    );
    expect(fieldOf(doc, 'body').outcome).toBe('none');
  });

  it('a body both sides changed differently is a conflict, with the text reported', () => {
    const doc = planOne(
      issue('LP-1', { body: 'local body' }),
      { body: 'remote body' },
      { body: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' },
    );
    expect(fieldOf(doc, 'body').outcome).toBe('conflict');
    expect(fieldOf(doc, 'body').local).toBe('local body');
    expect(fieldOf(doc, 'body').remote).toBe('remote body');
    expect(fieldOf(doc, 'body').base).toMatch(/^sha256:/);
  });
});

// ---------------------------------------------------------------------------
// Unreadable / non-issue documents are skipped
// ---------------------------------------------------------------------------

describe('planConflicts — skipping', () => {
  it('skips a document whose remote side was not supplied', () => {
    const plan = planConflicts(
      viewOf([issue('LP-1'), issue('LP-2')]),
      linkStore({ 'LP-1': { remoteId: 'R1', base: {} }, 'LP-2': { remoteId: 'R2', base: {} } }),
      new Map([['LP-1', { title: 't' }]]),
      manual(),
      trackedFields(MAPPING),
    );
    expect(plan.documents.map((doc) => doc.localId)).toEqual(['LP-1']);
  });
});
