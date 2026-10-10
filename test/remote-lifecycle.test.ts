import { describe, expect, it } from 'vitest';
import {
  setLink,
  type LinkEntry,
  type LinkStore,
  type Tombstone,
} from '../src/remote/links.js';
import {
  resolveLifecycle,
  type LifecycleEntry,
  type LifecycleReport,
} from '../src/remote/lifecycle.js';
import type { RemoteSnapshot } from '../src/remote/plan.js';
import type { RemoteRecord } from '../src/remote/provider.js';
import type { ConfigDto, IssueDto, NodeDto } from '../src/shared/model.js';
import type { BoardView } from '../src/shared/plans/reading.js';

/**
 * LP-363 — `resolveLifecycle` classifies every in-scope correspondence into
 * exactly one lifecycle state, from literals: a board view, a link store and a
 * fetched remote snapshot.  No fixtures, no disk, no network — the resolver is
 * pure, so the whole state table is testable here.
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

function view(nodes: IssueDto[]): BoardView {
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

function store(
  links: Record<string, LinkEntry> = {},
  tombstones: Record<string, Tombstone> = {},
): LinkStore {
  const s: LinkStore = {
    version: 1,
    cursor: null,
    links: new Map(),
    byRemote: new Map(),
    tombstones: new Map(),
  };
  for (const [id, entry] of Object.entries(links)) setLink(s, id, entry);
  for (const [id, tombstone] of Object.entries(tombstones)) s.tombstones.set(id, tombstone);
  return s;
}

function snapshot(
  issues: Record<string, RemoteRecord> = {},
  opts: { direction?: RemoteSnapshot['direction']; scope?: string } = {},
): RemoteSnapshot {
  return {
    direction: opts.direction ?? 'both',
    issues: new Map(Object.entries(issues)),
    ...(opts.scope ? { scope: opts.scope } : {}),
  };
}

/** The states of every entry, for terse assertions. */
function states(report: LifecycleReport): LifecycleEntry['state'][] {
  return report.entries.map((entry) => entry.state);
}

/** Find the one entry with the given state (test boards have at most one). */
function entryOf(report: LifecycleReport, state: LifecycleEntry['state']): LifecycleEntry {
  const matches = report.entries.filter((entry) => entry.state === state);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${state} entry, got ${matches.length}`);
  }
  return matches[0]!;
}

// -- linked -----------------------------------------------------------------

describe('linked', () => {
  it('reports a document whose twin is present in the fetched set', () => {
    const links = store({ 'LP-1': twin('R1') });
    const remote = snapshot({ R1: {} });

    const report = resolveLifecycle(view([issue('LP-1')]), links, remote);

    expect(report.entries).toEqual([
      {
        state: 'linked',
        localId: 'LP-1',
        remoteId: 'R1',
        remoteKey: 'acme/repo#R1',
        remoteUrl: 'https://github.com/acme/repo/issues/R1',
      },
    ]);
  });
});

// -- local_only -------------------------------------------------------------

describe('local_only', () => {
  it('reports an in-scope document with no link', () => {
    const report = resolveLifecycle(view([issue('LP-1')]), store(), snapshot());
    expect(report.entries).toEqual([{ state: 'local_only', localId: 'LP-1' }]);
  });

  it('reports every in-scope document, container and leaf alike', () => {
    const report = resolveLifecycle(
      view([issue('LP-1'), issue('LP-2', 'LP-1', 1)]),
      store(),
      snapshot(),
    );
    expect(states(report)).toEqual(['local_only', 'local_only']);
  });
});

// -- scope ------------------------------------------------------------------

describe('scope', () => {
  it('reports nothing for a document outside the scope subtree', () => {
    const report = resolveLifecycle(
      view([issue('LP-1'), issue('LP-2')]), // LP-2 is not under LP-1
      store(),
      snapshot({}, { scope: 'LP-1' }),
    );
    expect(report.entries).toEqual([{ state: 'local_only', localId: 'LP-1' }]);
  });

  it('reports the scope root and its descendants', () => {
    const report = resolveLifecycle(
      view([issue('LP-1'), issue('LP-2', 'LP-1', 1), issue('LP-3', 'LP-2', 2)]),
      store(),
      snapshot({}, { scope: 'LP-1' }),
    );
    expect(report.entries.map((entry) => entry.localId)).toEqual(['LP-1', 'LP-2', 'LP-3']);
  });

  it('does not report an out-of-scope document even when it has a link', () => {
    const report = resolveLifecycle(
      view([issue('LP-1'), issue('LP-2')]),
      store({ 'LP-2': twin('R2') }),
      snapshot({}, { scope: 'LP-1' }),
    );
    // LP-2's link names a live, out-of-scope document — silent here, not
    // orphaned and not linked; LP-366 turns that into a decoupled tombstone.
    expect(report.entries).toEqual([{ state: 'local_only', localId: 'LP-1' }]);
  });
});

// -- remote_only ------------------------------------------------------------

describe('remote_only', () => {
  it('reports an unlinked remote issue, carrying its remote id for adoption', () => {
    const report = resolveLifecycle(view([issue('LP-1')]), store(), snapshot({ R9: {} }));
    expect(entryOf(report, 'remote_only')).toEqual({ state: 'remote_only', remoteId: 'R9' });
  });

  it('ignores a remote issue that already has a link', () => {
    const links = store({ 'LP-1': twin('R1') });
    const report = resolveLifecycle(view([issue('LP-1')]), links, snapshot({ R1: {} }));
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]!.state).toBe('linked');
  });
});

// -- orphaned ---------------------------------------------------------------

describe('orphaned', () => {
  it('distinguishes a link whose local document is gone (local side)', () => {
    const links = store({ 'LP-ghost': twin('Rg') });
    const report = resolveLifecycle(view([issue('LP-1')]), links, snapshot());

    expect(entryOf(report, 'orphaned')).toEqual({
      state: 'orphaned',
      side: 'local',
      localId: 'LP-ghost',
      remoteId: 'Rg',
      remoteKey: 'acme/repo#Rg',
      remoteUrl: 'https://github.com/acme/repo/issues/Rg',
    });
  });

  it('distinguishes a link whose remote twin is absent (remote side)', () => {
    const links = store({ 'LP-1': twin('R1') });
    const report = resolveLifecycle(view([issue('LP-1')]), links, snapshot());

    // With no reachability probe and no direct read, the only linked twin
    // vanishing is the whole board going missing at once — the bulk guard
    // declines to call that a deletion (LP-364).
    expect(report.runUnreachable).toBe(true);
    expect(entryOf(report, 'orphaned')).toMatchObject({
      state: 'orphaned',
      side: 'remote',
      absence: 'unreachable',
      localId: 'LP-1',
      remoteId: 'R1',
    });
    expect(report.runUnreachableReason).toContain('1 of 1 linked twins are missing');
  });

  it('reports both directions side by side without conflating them', () => {
    const links = store({ 'LP-1': twin('R1'), 'LP-gone': twin('Rg') });
    const report = resolveLifecycle(view([issue('LP-1')]), links, snapshot());

    const remote = report.entries.find((entry) => entry.state === 'orphaned' && entry.side === 'remote');
    const local = report.entries.find((entry) => entry.state === 'orphaned' && entry.side === 'local');
    expect(remote?.localId).toBe('LP-1');
    expect(remote?.remoteId).toBe('R1');
    expect(local?.localId).toBe('LP-gone');
    expect(local?.remoteId).toBe('Rg');
  });
});

// -- LP-364: deleted vs unreachable vs out_of_scope -------------------------

describe('LP-364 — why a remote twin is absent', () => {
  const probeOk = { reachable: true, evidence: 'GET /repos/acme/payments → 200' };
  const probeFail = { reachable: false, evidence: 'GET /repos/acme/payments → 404 Not Found' };

  /** Three linked documents; R2 and R3 are fetched, R1 is absent. */
  const threeLinks = () => ({
    links: store({ 'LP-1': twin('R1'), 'LP-2': twin('R2'), 'LP-3': twin('R3') }),
    board: view([issue('LP-1'), issue('LP-2'), issue('LP-3')]),
  });

  it('a twin that 404s while its siblings fetch is `deleted`', () => {
    const { links, board } = threeLinks();
    const report = resolveLifecycle(board, links, snapshot({ R2: {}, R3: {} }), {
      reachability: probeOk,
      readOf: (id) =>
        id === 'R1'
          ? { kind: 'not_found', evidence: 'GET /repos/acme/payments/issues/1 → 404' }
          : undefined,
    });

    expect(report.runUnreachable).toBe(false);
    expect(entryOf(report, 'orphaned')).toMatchObject({
      state: 'orphaned',
      side: 'remote',
      absence: 'deleted',
      localId: 'LP-1',
      remoteId: 'R1',
      evidence: 'GET /repos/acme/payments/issues/1 → 404',
    });
    expect(report.entries.filter((entry) => entry.state === 'linked')).toHaveLength(2);
  });

  it('a failed reachability probe makes the run unreachable and deletes nothing', () => {
    const { links, board } = threeLinks();
    const report = resolveLifecycle(board, links, snapshot({}), {
      reachability: probeFail,
      // Individual reads say 404 — a failed probe overrides them all (AC #2).
      readOf: () => ({ kind: 'not_found', evidence: 'GET …/issues/1 → 404' }),
    });

    expect(report.runUnreachable).toBe(true);
    expect(report.runUnreachableReason).toBe('GET /repos/acme/payments → 404 Not Found');
    for (const entry of report.entries.filter((entry) => entry.state === 'orphaned')) {
      expect(entry.absence).toBe('unreachable');
    }
    expect(report.entries.filter((entry) => entry.absence === 'deleted')).toHaveLength(0);
  });

  it('more than the configured fraction missing at once is unreachable, whatever each code said', () => {
    // Ten links, eight missing, all individually 404 (AC #3).
    const links = store(
      Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [`LP-${i + 1}`, twin(`R${i + 1}`)]),
      ),
    );
    const board = view(Array.from({ length: 10 }, (_, i) => issue(`LP-${i + 1}`)));
    const report = resolveLifecycle(board, links, snapshot({ R9: {}, R10: {} }), {
      reachability: probeOk,
      readOf: () => ({ kind: 'not_found', evidence: 'GET …/issues/1 → 404' }),
    });

    expect(report.runUnreachable).toBe(true);
    expect(report.runUnreachableReason).toContain('8 of 10 linked twins are missing');
    for (const entry of report.entries.filter((entry) => entry.state === 'orphaned')) {
      expect(entry.absence).toBe('unreachable');
    }
  });

  it('an issue that exists but left the configured scope is `out_of_scope`, never `deleted`', () => {
    const { links, board } = threeLinks();
    const report = resolveLifecycle(board, links, snapshot({ R2: {}, R3: {} }), {
      reachability: probeOk,
      readOf: (id) =>
        id === 'R1'
          ? { kind: 'found', evidence: 'GET /repos/acme/payments/issues/1 → 200 (moved to another repo)' }
          : undefined,
    });

    expect(report.runUnreachable).toBe(false);
    expect(entryOf(report, 'orphaned')).toMatchObject({
      absence: 'out_of_scope',
      localId: 'LP-1',
    });
    expect(report.entries.filter((entry) => entry.absence === 'deleted')).toHaveLength(0);
  });

  it('a twin with no direct read and no probe is classified conservatively', () => {
    // One missing of two (0.5) does not trip the bulk guard; but with no
    // probe and no direct read, the missing twin cannot be proven deleted.
    const links = store({ 'LP-1': twin('R1'), 'LP-2': twin('R2') });
    const report = resolveLifecycle(
      view([issue('LP-1'), issue('LP-2')]),
      links,
      snapshot({ R2: {} }),
    );

    expect(report.runUnreachable).toBe(false);
    expect(entryOf(report, 'orphaned')).toMatchObject({
      absence: 'unreachable',
      localId: 'LP-1',
    });
  });

  it('bulk_guard: 1 disables the guard, so a lone 404 is a deletion', () => {
    const links = store({ 'LP-1': twin('R1') });
    const report = resolveLifecycle(view([issue('LP-1')]), links, snapshot({}), {
      reachability: probeOk,
      bulkGuard: 1,
      readOf: () => ({ kind: 'not_found', evidence: 'GET …/issues/1 → 404' }),
    });

    expect(report.runUnreachable).toBe(false);
    expect(entryOf(report, 'orphaned')).toMatchObject({ absence: 'deleted' });
  });

  it('each classification names the evidence it used', () => {
    const links = store({
      'LP-1': twin('R1'),
      'LP-2': twin('R2'),
      'LP-3': twin('R3'),
      'LP-4': twin('R4'),
    });
    const board = view([issue('LP-1'), issue('LP-2'), issue('LP-3'), issue('LP-4')]);
    const report = resolveLifecycle(board, links, snapshot({}), {
      reachability: probeOk,
      bulkGuard: 1, // let each read decide; nothing to trip the bulk guard
      readOf: (id) => {
        if (id === 'R1') return { kind: 'not_found', evidence: 'GET …/issues/1 → 404' };
        if (id === 'R2') return { kind: 'found', evidence: 'GET …/issues/2 → 200 (moved)' };
        if (id === 'R3') return { kind: 'error', evidence: 'GET …/issues/3 → 403 Forbidden' };
        return undefined;
      },
    });

    const byId = new Map(report.entries.map((entry) => [entry.localId, entry]));
    expect(byId.get('LP-1')).toMatchObject({ absence: 'deleted', evidence: 'GET …/issues/1 → 404' });
    expect(byId.get('LP-2')).toMatchObject({ absence: 'out_of_scope', evidence: 'GET …/issues/2 → 200 (moved)' });
    expect(byId.get('LP-3')).toMatchObject({ absence: 'unreachable', evidence: 'GET …/issues/3 → 403 Forbidden' });
    expect(byId.get('LP-4')).toMatchObject({ absence: 'unreachable', evidence: 'no reachability signal and no direct read of the twin' });
  });
});

// -- decoupled --------------------------------------------------------------

describe('decoupled', () => {
  const tombstone: Tombstone = { remoteKey: 'acme/repo#R1', reason: 'manual', at: '2026-09-05T00:00:00Z' };

  it('reports a decoupled document as decoupled, never local_only', () => {
    const links = store({}, { 'LP-1': tombstone });
    const report = resolveLifecycle(view([issue('LP-1')]), links, snapshot());

    expect(report.entries).toEqual([
      { state: 'decoupled', localId: 'LP-1', remoteKey: 'acme/repo#R1', reason: 'manual' },
    ]);
  });

  it('outranks whatever either side now looks like', () => {
    // A stray link and a still-present twin must not resurrect the twin.
    const links = store({ 'LP-1': twin('R1') }, { 'LP-1': tombstone });
    const report = resolveLifecycle(view([issue('LP-1')]), links, snapshot({ R1: {} }));

    expect(states(report)).toEqual(['decoupled']);
  });
});

// -- direction: push --------------------------------------------------------

describe('direction: push', () => {
  it('keeps linked documents linked without assessing the remote side', () => {
    const links = store({ 'LP-1': twin('R1') });
    const report = resolveLifecycle(
      view([issue('LP-1')]),
      links,
      snapshot({}, { direction: 'push' }),
    );
    expect(states(report)).toEqual(['linked']);
  });

  it('reports no remote_only issues and no remote-side orphan for a push-only remote', () => {
    const links = store({ 'LP-1': twin('R1') });
    const report = resolveLifecycle(
      view([issue('LP-1')]),
      links,
      snapshot({ R9: {} }, { direction: 'push' }),
    );
    expect(states(report)).toEqual(['linked']);
  });
});

// -- conflicted (existence disagreement) -------------------------------------

describe('conflicted', () => {
  it('marks two live documents that claim one remote twin', () => {
    const links = store({ 'LP-1': twin('R1'), 'LP-2': twin('R1') });
    const report = resolveLifecycle(
      view([issue('LP-1'), issue('LP-2')]),
      links,
      snapshot({ R1: {} }),
    );
    expect(states(report)).toEqual(['conflicted', 'conflicted']);
  });

  it('does not treat a ghost link as a claimant', () => {
    // LP-1 lives, LP-gone is gone — only the live document is a claimant, so
    // the twin is unambiguous for LP-1 and the ghost is orphaned, not conflicted.
    const links = store({ 'LP-1': twin('R1'), 'LP-gone': twin('R1') });
    const report = resolveLifecycle(view([issue('LP-1')]), links, snapshot({ R1: {} }));

    expect(report.entries.map((entry) => [entry.state, entry.side ?? null])).toEqual([
      ['linked', null],
      ['orphaned', 'local'],
    ]);
  });
});

// -- remote scope via anchor -------------------------------------------------

describe('remote scope anchoring', () => {
  const parentIdOf = (record: RemoteRecord): string | undefined =>
    record['parent'] as string | undefined;

  it('admits an unlinked remote issue whose parent chain anchors in scope', () => {
    const links = store({ 'LP-1': twin('R1') });
    const remote = snapshot({ R1: {}, R2: { parent: 'R1' } }, { scope: 'LP-1' });
    const report = resolveLifecycle(
      view([issue('LP-1'), issue('LP-2', 'LP-1', 1)]),
      links,
      remote,
      { parentIdOf },
    );

    expect(entryOf(report, 'remote_only')).toEqual({ state: 'remote_only', remoteId: 'R2' });
  });

  it('excludes an unanchored remote issue from a scoped remote', () => {
    const links = store({ 'LP-1': twin('R1') });
    const remote = snapshot({ R1: {}, R9: {} }, { scope: 'LP-1' });
    const report = resolveLifecycle(view([issue('LP-1')]), links, remote, { parentIdOf });

    // R9 has no link and no remote parent — nothing anchors it, so it is not
    // in scope and not reported.
    expect(report.entries).toEqual([
      {
        state: 'linked',
        localId: 'LP-1',
        remoteId: 'R1',
        remoteKey: 'acme/repo#R1',
        remoteUrl: 'https://github.com/acme/repo/issues/R1',
      },
    ]);
  });
});
