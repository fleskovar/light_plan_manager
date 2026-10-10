import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ownIdOfManagedBlock,
  planAdoption,
  suggestManagedPairings,
  type AdoptSeeds,
  type AdoptionPlan,
} from '../src/remote/adopt.js';
import { setLink, type LinkEntry, type LinkStore } from '../src/remote/links.js';
import {
  MANAGED_BLOCK_BEGIN,
  MANAGED_BLOCK_END,
} from '../src/remote/managed-block.js';
import type { RemoteRecord } from '../src/remote/provider.js';
import type { ConfigDto, IssueDto, NodeDto, PeriodDto } from '../src/shared/model.js';
import type { BoardView } from '../src/shared/plans/reading.js';

/**
 * LP-367 — adopting an existing remote issue into an existing document.
 *
 * `planAdoption`, `ownIdOfManagedBlock` and `suggestManagedPairings` are pure
 * functions: board in, links in, fetched remote record in, a plan (or a
 * refusal, or a suggestion) out.  No disk, no network, so every acceptance
 * criterion is testable from literals here.  The CLI (`lpm remote link` /
 * `unlink`) is exercised in test/remote-cli.test.ts; this file is the pure
 * half.
 */

// -- fixtures ---------------------------------------------------------------

const config: ConfigDto = {
  boardName: 'test',
  statuses: [],
  defaultStatus: 'backlog',
  types: {},
  hierarchy: { issue: [], period: [], resource: [], squad: [], template: [] },
  hasPeriods: false,
  hasResources: false,
  hasSquads: false,
  priorityAttribute: '',
  effortAttribute: '',
  planning: 'periods',
};

function issue(id: string, parentId: string | null = null, depth = 0): IssueDto {
  return {
    kind: 'issue',
    id,
    type: 'user_story',
    title: `Issue ${id}`,
    body: '',
    parentId,
    depth,
    attributes: {},
    status: 'backlog',
    assignee: null,
    period: null,
    flag: null,
    dependsOn: [],
    relatesTo: [],
    relatedFiles: [],
  };
}

function period(id: string): PeriodDto {
  return {
    kind: 'period',
    id,
    type: 'sprint',
    title: `Sprint ${id}`,
    body: '',
    parentId: null,
    depth: 0,
    attributes: {},
    squad: null,
  };
}

function view(nodes: NodeDto[]): BoardView {
  const byId: Record<string, NodeDto> = {};
  for (const node of nodes) byId[node.id] = node;
  return { config, nodes: byId };
}

function twin(remoteId: string): LinkEntry {
  return {
    remoteId,
    remoteKey: `acme/repo#${remoteId}`,
    remoteUrl: `https://github.com/acme/repo/issues/${remoteId}`,
    syncedAt: '2026-09-04T11:19:58Z',
    remoteRev: '2026-09-04T11:19:57Z',
  };
}

function store(links: Record<string, LinkEntry> = {}): LinkStore {
  const s: LinkStore = {
    version: 1,
    cursor: null,
    links: new Map(),
    byRemote: new Map(),
    tombstones: new Map(),
  };
  for (const [id, entry] of Object.entries(links)) setLink(s, id, entry);
  return s;
}

function seeds(overrides: Partial<AdoptSeeds> = {}): AdoptSeeds {
  return {
    remoteId: 'R1',
    remoteKey: 'acme/payments#1',
    remoteUrl: 'https://github.com/acme/payments/issues/1',
    remoteRev: 'r1',
    remoteBody: 'Remote body text',
    patch: { title: 'Remote title', status: 'in_progress', attributes: { story_points: 8 } },
    ...overrides,
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** A managed block naming one light-plan id — the `id` cell a filing wrote. */
function managedBlockBody(id: string, prose = 'Some prose'): string {
  return [
    prose,
    '',
    MANAGED_BLOCK_BEGIN,
    '| light-plan | |',
    '| --- | --- |',
    `| id | ${id} |`,
    MANAGED_BLOCK_END,
  ].join('\n');
}

function remoteIssue(overrides: Record<string, unknown> = {}): RemoteRecord {
  return { ...overrides };
}

/** Unwrap an ok plan; fails the test on a refusal. */
function plan(board: BoardView, links: LinkStore, localId: string, s = seeds(), syncedAt = '2026-09-05T00:00:00Z', options?: Parameters<typeof planAdoption>[5]): NonNullable<Extract<AdoptionPlan, { ok: true }>['plan']> {
  const result = planAdoption(board, links, localId, s, syncedAt, options);
  if (!result.ok) {
    throw new Error(`expected ok, got refusal ${JSON.stringify(result.refusal)}`);
  }
  return result.plan;
}

// -- planAdoption: success ---------------------------------------------------

describe('planAdoption — the happy path', () => {
  it('records a correspondence and seeds the base from the remote, not local', () => {
    const links = store();
    const board = view([issue('LP-1')]);

    const p = plan(board, links, 'LP-1');

    // The link carries the remote's identity, not a write to either side.
    expect(p.entry).toEqual({
      remoteId: 'R1',
      remoteKey: 'acme/payments#1',
      remoteUrl: 'https://github.com/acme/payments/issues/1',
      syncedAt: '2026-09-05T00:00:00Z',
      remoteRev: 'r1',
    });
    // The base is the remote's current values (AC #1): body hashed from the
    // remote prose, title and status from the translated patch. Shape (parent
    // and type) is seeded from the local document (LP-368): adoption agrees the
    // two are the same work, so the local shape is the agreed shape.
    expect(p.base).toEqual({
      title: 'Remote title',
      body: `sha256:${sha256('Remote body text')}`,
      status: 'in_progress',
      dependsOn: [],
      parent: null,
      type: 'user_story',
    });
    // Neither flag of the two refusals that can accompany an ok plan.
    expect(p.clearedTombstone).toBe(false);
    expect(p.repointed).toBe(false);
  });

  it('seeds a mapped attribute from the remote patch, never from local', () => {
    const links = store();
    const board = view([{ ...issue('LP-1'), attributes: { story_points: 1 } }]);

    const p = plan(board, links, 'LP-1', seeds(), '2026-09-05T00:00:00Z', {
      mappedFields: new Set(['title', 'body', 'status', 'story_points']),
    });

    expect(p.base.story_points).toBe(8);
  });

  it('hashes the body after stripping our own managed block', () => {
    const links = store();
    const board = view([issue('LP-1')]);

    const p = plan(
      board,
      links,
      'LP-1',
      seeds({ remoteBody: managedBlockBody('LP-1') }),
    );

    // The base stores the remote prose — the block we filed ourselves is not
    // part of their content, so it must not come back as a remote edit.
    expect(p.base.body).toBe(`sha256:${sha256('Some prose')}`);
  });

  it('is pure: neither the store nor the document is modified by planning', () => {
    const links = store();
    const doc = issue('LP-1');
    const board = view([doc]);

    plan(board, links, 'LP-1');

    expect(links.links.size).toBe(0);
    expect(links.byRemote.size).toBe(0);
    expect(board.nodes['LP-1']).toBe(doc);
  });
});

// -- planAdoption: refusals --------------------------------------------------

describe('planAdoption — refusals', () => {
  it('refuses a local id that is not an issue', () => {
    const board = view([period('TL-1')]);
    const result = planAdoption(board, store(), 'TL-1', seeds(), '2026-09-05T00:00:00Z');
    expect(result).toEqual({ ok: false, refusal: { kind: 'no_such_document', localId: 'TL-1' } });
  });

  it('refuses a local id that does not exist at all', () => {
    const board = view([issue('LP-1')]);
    const result = planAdoption(board, store(), 'LP-999', seeds(), '2026-09-05T00:00:00Z');
    expect(result).toEqual({ ok: false, refusal: { kind: 'no_such_document', localId: 'LP-999' } });
  });

  it('refuses a document already linked, naming the existing link, without --repoint', () => {
    const existing = twin('R0');
    const board = view([issue('LP-1')]);
    const result = planAdoption(board, store({ 'LP-1': existing }), 'LP-1', seeds(), '2026-09-05T00:00:00Z');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toEqual({ kind: 'already_linked', localId: 'LP-1', existing });
  });

  it('allows an already-linked document when --repoint is explicit', () => {
    const board = view([issue('LP-1')]);
    const links = store({ 'LP-1': twin('R0') });

    const p = plan(board, links, 'LP-1', seeds(), '2026-09-05T00:00:00Z', { repoint: true });

    expect(p.repointed).toBe(true);
    expect(p.entry.remoteId).toBe('R1');
  });

  it('refuses a remote issue already linked to a different document', () => {
    const board = view([issue('LP-1'), issue('LP-2')]);
    const result = planAdoption(board, store({ 'LP-2': twin('R1') }), 'LP-1', seeds(), '2026-09-05T00:00:00Z');

    expect(result).toEqual({
      ok: false,
      refusal: { kind: 'remote_claimed', localId: 'LP-1', remoteId: 'R1', holder: 'LP-2' },
    });
  });

  it('allows re-adopting the very same twin when the local id already holds it', () => {
    // A link to the same remote id is a re-link, not a claim — `--repoint`
    // moves between twins; the same twin is the idempotent case.
    const board = view([issue('LP-1')]);
    const links = store({ 'LP-1': twin('R1') });

    const result = planAdoption(board, links, 'LP-1', seeds(), '2026-09-05T00:00:00Z', {
      repoint: true,
    });

    expect(result.ok).toBe(true);
  });
});

// -- planAdoption: tombstones ------------------------------------------------

describe('planAdoption — decoupled documents', () => {
  it('clears the tombstone when a decoupled document is adopted', () => {
    const board = view([issue('LP-1')]);
    const links = store();
    links.tombstones.set('LP-1', { remoteKey: 'acme/repo#9', reason: 'manual', at: '2026-09-01T00:00:00Z' });

    const p = plan(board, links, 'LP-1');

    expect(p.clearedTombstone).toBe(true);
    // Planning reports the tombstone; the caller's `setLink` is what removes it.
    expect(links.tombstones.has('LP-1')).toBe(true);
  });

  it('reports no tombstone clear for a document that was never decoupled', () => {
    const p = plan(view([issue('LP-1')]), store(), 'LP-1');
    expect(p.clearedTombstone).toBe(false);
  });
});

// -- ownIdOfManagedBlock -----------------------------------------------------

describe('ownIdOfManagedBlock', () => {
  it('reads the id cell out of a managed block', () => {
    const record = remoteIssue({ body: managedBlockBody('LP-42') });
    expect(ownIdOfManagedBlock(record)).toBe('LP-42');
  });

  it('unwraps an id cell rendered as a markdown link', () => {
    const body = [
      'Prose',
      '',
      MANAGED_BLOCK_BEGIN,
      '| light-plan | |',
      '| --- | --- |',
      '| id | [LP-42](https://github.com/acme/payments/issues/1) |',
      MANAGED_BLOCK_END,
    ].join('\n');
    expect(ownIdOfManagedBlock(remoteIssue({ body }))).toBe('LP-42');
  });

  it('returns undefined when there is no managed block', () => {
    expect(ownIdOfManagedBlock(remoteIssue({ body: 'Plain prose' }))).toBeUndefined();
  });

  it('returns undefined when the block has no id cell', () => {
    const body = [
      'Prose',
      '',
      MANAGED_BLOCK_BEGIN,
      '| light-plan | |',
      '| --- | --- |',
      '| parent | LP-9 |',
      MANAGED_BLOCK_END,
    ].join('\n');
    expect(ownIdOfManagedBlock(remoteIssue({ body }))).toBeUndefined();
  });

  it('returns undefined when the body is not a string', () => {
    expect(ownIdOfManagedBlock(remoteIssue({ body: 42 }))).toBeUndefined();
  });
});

// -- suggestManagedPairings --------------------------------------------------

describe('suggestManagedPairings', () => {
  it('offers an exact pairing for an unlinked document named by an unlinked remote issue', () => {
    const board = view([issue('LP-42')]);
    const remoteIssues = new Map<string, RemoteRecord>([
      ['R9', remoteIssue({ body: managedBlockBody('LP-42') })],
    ]);

    const suggestions = suggestManagedPairings(remoteIssues, store(), board);

    expect(suggestions).toEqual([{ remoteId: 'R9', localId: 'LP-42' }]);
  });

  it('skips a remote issue that already has a twin', () => {
    const board = view([issue('LP-42'), issue('LP-43')]);
    const links = store({ 'LP-43': twin('R9') });
    const remoteIssues = new Map<string, RemoteRecord>([
      ['R9', remoteIssue({ body: managedBlockBody('LP-42') })],
    ]);

    expect(suggestManagedPairings(remoteIssues, links, board)).toEqual([]);
  });

  it('skips a named local id that is not an issue', () => {
    const board = view([period('TL-1')]);
    const remoteIssues = new Map<string, RemoteRecord>([
      ['R9', remoteIssue({ body: managedBlockBody('TL-1') })],
    ]);

    expect(suggestManagedPairings(remoteIssues, store(), board)).toEqual([]);
  });

  it('skips a local document that already points at a different twin', () => {
    const board = view([issue('LP-42')]);
    const links = store({ 'LP-42': twin('R0') });
    const remoteIssues = new Map<string, RemoteRecord>([
      ['R9', remoteIssue({ body: managedBlockBody('LP-42') })],
    ]);

    expect(suggestManagedPairings(remoteIssues, links, board)).toEqual([]);
  });

  it('returns suggestions in a stable order', () => {
    const board = view([issue('LP-1'), issue('LP-2')]);
    const remoteIssues = new Map<string, RemoteRecord>([
      ['RB', remoteIssue({ body: managedBlockBody('LP-2') })],
      ['RA', remoteIssue({ body: managedBlockBody('LP-1') })],
    ]);

    const suggestions = suggestManagedPairings(remoteIssues, store(), board);

    expect(suggestions).toEqual([
      { remoteId: 'RA', localId: 'LP-1' },
      { remoteId: 'RB', localId: 'LP-2' },
    ]);
  });
});
