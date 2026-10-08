import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createIssue, loadBoard, type LoadedBoard } from '../src/core/index.js';
import {
  applyRebase,
  emptyCapabilities,
  planRebase,
  saveMappingSnapshot,
  type Connector,
  type LinkStore,
  type OpenedRemote,
  type Provider,
  type RemoteRecord,
  type Translator,
  type BoardFieldsPatch,
} from '../src/remote/index.js';
import { loadLinkStore, loadMappingSnapshot } from '../src/remote/index.js';
import type { IssueDto } from '../src/shared/model.js';
import type { BoardView } from '../src/shared/plans/reading.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterAll(cleanupBoards);

/**
 * LP-371 — `lpm remote rebase` re-reads both sides under a changed mapping and
 * rewrites each base from the values that actually agree. Built against a real
 * board and an in-memory connector, so the "never writes to the remote" rule
 * can be asserted as "no write method was ever called".
 */

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

/** A translator that treats the remote record as an already-translated patch. */
const passthroughTranslator: Translator = {
  describeRequest() {
    return { request: { kind: 'create' }, problems: [], resourceGaps: [], periodGaps: [] };
  },
  fieldsFromRecord(record: RemoteRecord) {
    const patch: BoardFieldsPatch = {};
    if (typeof record.status === 'string') patch.status = record.status;
    if (record.assignee !== undefined) patch.assignee = record.assignee as string | null;
    if (record.period !== undefined) patch.period = record.period as string | null;
    if (record.attributes && typeof record.attributes === 'object') {
      patch.attributes = record.attributes as Record<string, unknown>;
    }
    return { patch, problems: [], unknownAccounts: [] };
  },
};

function openedRemote(mapping: Record<string, unknown>): OpenedRemote {
  const provider: Provider = {
    config: z.object({}),
    capabilities: emptyCapabilities(),
    translator: passthroughTranslator,
    connector: () => {
      throw new Error('applyRebase drives a connector directly');
    },
  };
  return {
    name: 'upstream',
    provider,
    scope: undefined,
    direction: 'both',
    on_delete: 'unlink',
    conflict: 'manual',
    fields: {},
    encoding: 'block',
    comments: 'push',
    connection: {},
    mapping,
  };
}

/** A connector that only ever reads, recording every call. */
function fakeConnector(
  records: Record<string, RemoteRecord | null>,
  opts: { throwOn?: Record<string, string> } = {},
): { connector: Connector; calls: string[] } {
  const calls: string[] = [];
  const connector: Connector = {
    name: 'memory',
    async create() {
      calls.push('create');
      throw new Error('rebase must never create');
    },
    async update() {
      calls.push('update');
      throw new Error('rebase must never update');
    },
    async delete() {
      calls.push('delete');
      throw new Error('rebase must never delete');
    },
    async get(remoteId: string) {
      calls.push(`get:${remoteId}`);
      if (opts.throwOn && remoteId in opts.throwOn) throw new Error(opts.throwOn[remoteId]);
      return records[remoteId] ?? null;
    },
    async list() {
      calls.push('list');
      return { records: [], cursor: null };
    },
  };
  return { connector, calls };
}

// ---------------------------------------------------------------------------
// Pure planner fixtures
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

function linkStore(entries: Record<string, { remoteId: string; base?: Record<string, unknown> }>): LinkStore {
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

const MAPPING = {
  statuses: {
    in_progress: { remote: ['In Progress'] },
    done: { remote: ['Done'] },
  },
  attributes: { story_points: 'Points' },
  accounts: { via: 'github' },
  periods: { container: 'sprint' },
};

// ---------------------------------------------------------------------------
// planRebase
// ---------------------------------------------------------------------------

describe('planRebase', () => {
  it('rewrites a base from the values that agree and preserves mapping-independent fields', () => {
    const store = linkStore({
      'LP-1': {
        remoteId: 'R1',
        base: {
          title: 'old title',
          body: 'sha256:oldbody',
          dependsOn: ['LP-9'],
          status: 'in_progress',
          story_points: 5,
          assignee: 'RS-1',
          period: 'TL-1',
        },
      },
    });
    const records = new Map([
      [
        'LP-1',
        {
          status: 'in_progress',
          assignee: 'RS-1',
          period: 'TL-1',
          attributes: { story_points: 5 },
        } as RemoteRecord,
      ],
    ]);

    const plan = planRebase(
      viewOf([
        issue('LP-1', {
          title: 'new title',
          status: 'in_progress',
          assignee: 'RS-1',
          period: 'TL-1',
          attributes: { story_points: 5 },
        }),
      ]),
      store,
      records,
      MAPPING,
      { translator: passthroughTranslator, attributes: {} },
    );

    expect(plan.outcomes).toHaveLength(1);
    const outcome = plan.outcomes[0]!;
    expect(outcome.state).toBe('rebased');
    expect(outcome.conflicts).toEqual([]);
    // Agreeing governed fields are written; title/body/edges are preserved
    // even though the local title moved (it is not a governed field).
    expect(outcome.base).toEqual({
      title: 'old title',
      body: 'sha256:oldbody',
      dependsOn: ['LP-9'],
      status: 'in_progress',
      story_points: 5,
      assignee: 'RS-1',
      period: 'TL-1',
    });
  });

  it('marks a document conflicted and drops the disagreeing field, never forcing local', () => {
    const store = linkStore({
      'LP-1': {
        remoteId: 'R1',
        base: { title: 't', body: 'sha256:b', dependsOn: [], status: 'in_progress', story_points: 5 },
      },
    });
    const records = new Map([
      ['LP-1', { status: 'done', attributes: { story_points: 8 } } as RemoteRecord],
    ]);

    const plan = planRebase(
      viewOf([issue('LP-1', { status: 'in_progress', attributes: { story_points: 5 } })]),
      store,
      records,
      MAPPING,
      { translator: passthroughTranslator, attributes: {} },
    );

    const outcome = plan.outcomes[0]!;
    expect(outcome.state).toBe('conflicted');
    expect(outcome.conflicts).toEqual([
      { localId: 'LP-1', field: 'status', local: 'in_progress', remote: 'done' },
      { localId: 'LP-1', field: 'story_points', local: 5, remote: 8 },
    ]);
    // The disagreeing fields are absent; local did not win by default.
    expect(outcome.base.status).toBeUndefined();
    expect(outcome.base.story_points).toBeUndefined();
    // Mapping-independent fields survive, and the governed fields that agree
    // (unassigned, unscheduled) are recorded as null.
    expect(outcome.base).toEqual({
      title: 't',
      body: 'sha256:b',
      dependsOn: [],
      assignee: null,
      period: null,
    });
  });

  it('agrees field by field — an agreeing attribute lands even when the status conflicts', () => {
    const store = linkStore({
      'LP-1': { remoteId: 'R1', base: { status: 'in_progress', story_points: 5 } },
    });
    const records = new Map([
      ['LP-1', { status: 'done', attributes: { story_points: 5 } } as RemoteRecord],
    ]);

    const plan = planRebase(
      viewOf([issue('LP-1', { status: 'in_progress', attributes: { story_points: 5 } })]),
      store,
      records,
      MAPPING,
      { translator: passthroughTranslator, attributes: {} },
    );

    const outcome = plan.outcomes[0]!;
    expect(outcome.state).toBe('conflicted');
    // story_points agreed, so it is written; status did not, so it is dropped.
    expect(outcome.base.story_points).toBe(5);
    expect(outcome.base.status).toBeUndefined();
  });

  it('treats an unrecovered remote field as a disagreement, not silence', () => {
    const store = linkStore({ 'LP-1': { remoteId: 'R1', base: { status: 'in_progress' } } });
    const records = new Map([['LP-1', {} as RemoteRecord]]);

    const plan = planRebase(
      viewOf([issue('LP-1', { status: 'in_progress' })]),
      store,
      records,
      MAPPING,
      { translator: passthroughTranslator, attributes: {} },
    );

    const outcome = plan.outcomes[0]!;
    expect(outcome.state).toBe('conflicted');
    expect(outcome.conflicts).toEqual([
      { localId: 'LP-1', field: 'status', local: 'in_progress', remote: null },
    ]);
  });

  it('skips a document with no local issue and one with no fetched record', () => {
    const store = linkStore({
      'LP-1': { remoteId: 'R1', base: { status: 'in_progress' } },
      'LP-2': { remoteId: 'R2', base: { status: 'done' } },
    });
    const records = new Map([['LP-1', { status: 'in_progress' } as RemoteRecord]]);

    const plan = planRebase(
      viewOf([issue('LP-1', { status: 'in_progress' })]),
      store,
      records,
      MAPPING,
      { translator: passthroughTranslator, attributes: {} },
    );

    // LP-1 has both sides; LP-2 has no record (skipped). Nothing for LP-9, an
    // id with no link at all.
    expect(plan.outcomes.map((outcome) => outcome.localId)).toEqual(['LP-1']);
  });
});

// ---------------------------------------------------------------------------
// applyRebase
// ---------------------------------------------------------------------------

/** A board with two top-level programmes, for the applier tests. */
function boardWithTwo(): { paths: ReturnType<typeof makeBoard>; board: LoadedBoard; one: string; two: string } {
  const paths = makeBoard('scrum', 'LP');
  const one = createIssue(reload(paths), { type: 'program', title: 'One', status: 'in_progress' }).id;
  const two = createIssue(reload(paths), { type: 'program', title: 'Two', status: 'done' }).id;
  return { paths, board: reload(paths), one, two };
}

function mappingStatusOnly(): Record<string, unknown> {
  return {
    statuses: {
      in_progress: { remote: ['In Progress'] },
      done: { remote: ['Done'] },
    },
  };
}

describe('applyRebase', () => {
  it('rewrites agreeing bases, updates the fingerprint, and only ever reads the remote', async () => {
    const { board, one, two } = boardWithTwo();
    const store = linkStore({
      [one]: { remoteId: 'R1', base: { status: 'in_progress', title: 't' } },
      [two]: { remoteId: 'R2', base: { status: 'done', title: 't' } },
    });
    const { connector, calls } = fakeConnector({
      R1: { status: 'in_progress' } as RemoteRecord,
      R2: { status: 'done' } as RemoteRecord,
    });
    const mapping = mappingStatusOnly();

    const report = await applyRebase(board, openedRemote(mapping), connector, store, {
      now: () => new Date('2027-01-01T00:00:00Z'),
    });

    expect(report.rebased).toEqual([one, two].sort());
    expect(report.conflicted).toEqual([]);
    expect(report.unreadable).toEqual([]);
    expect(report.orphaned).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(report.fingerprintUpdated).toBe(true);

    // Only reads, never writes.
    expect(calls).toEqual(['get:R1', 'get:R2']);

    // The base is rewritten from the agreed value and persisted to disk.
    const onDisk = loadLinkStore(board.paths, 'upstream');
    expect(onDisk.links.get(one)!.base?.status).toBe('in_progress');
    expect(onDisk.links.get(two)!.base?.status).toBe('done');

    // The fingerprint moved to the new mapping, so the next sync runs clean.
    expect(loadMappingSnapshot(board.paths, 'upstream')!.fingerprint).toBeDefined();
  });

  it('leaves a disagreeing document conflicted, not force-based', async () => {
    const { board, one } = boardWithTwo();
    const store = linkStore({
      [one]: { remoteId: 'R1', base: { status: 'in_progress', title: 'keep me' } },
    });
    const { connector } = fakeConnector({ R1: { status: 'done' } as RemoteRecord });

    const report = await applyRebase(board, openedRemote(mappingStatusOnly()), connector, store);

    expect(report.conflicted).toEqual([one]);
    expect(report.rebased).toEqual([]);
    expect(report.fingerprintUpdated).toBe(true);

    const base = store.links.get(one)!.base!;
    expect(base.status).toBeUndefined(); // dropped, not overwritten with local
    expect(base.title).toBe('keep me'); // preserved
  });

  it('a dry run produces the same report and writes nothing', async () => {
    const { board, one, two } = boardWithTwo();
    const store = linkStore({
      [one]: { remoteId: 'R1', base: { status: 'in_progress', title: 't' } },
      [two]: { remoteId: 'R2', base: { status: 'done', title: 't' } },
    });
    const { connector } = fakeConnector({
      R1: { status: 'done' } as RemoteRecord, // conflicts
      R2: { status: 'done' } as RemoteRecord, // agrees
    });

    const report = await applyRebase(board, openedRemote(mappingStatusOnly()), connector, store, {
      dryRun: true,
    });

    expect(report.dryRun).toBe(true);
    expect(report.conflicted).toEqual([one]);
    expect(report.rebased).toEqual([two]);
    expect(report.fingerprintUpdated).toBe(false);

    // Nothing landed: the in-memory store is untouched and no fingerprint was written.
    expect(store.links.get(one)!.base!.status).toBe('in_progress');
    expect(store.links.get(two)!.base!.status).toBe('done');
    expect(loadMappingSnapshot(board.paths, 'upstream')).toBeUndefined();
  });

  it('an interrupted re-base keeps completed bases and does not update the fingerprint', async () => {
    const { board, one, two } = boardWithTwo();
    const store = linkStore({
      [one]: { remoteId: 'R1', base: { status: 'in_progress', title: 't' } },
      [two]: { remoteId: 'R2', base: { status: 'done', title: 't' } },
    });
    const { connector } = fakeConnector(
      {
        R1: { status: 'in_progress' } as RemoteRecord,
        R2: { status: 'done' } as RemoteRecord,
      },
      { throwOn: { R2: 'network down' } },
    );

    const report = await applyRebase(board, openedRemote(mappingStatusOnly()), connector, store);

    expect(report.failed).toEqual([{ localId: two, remoteId: 'R2', error: 'network down' }]);
    expect(report.rebased).toEqual([one]);
    expect(report.fingerprintUpdated).toBe(false);

    // The completed document kept its new base; the failed one is untouched.
    expect(loadLinkStore(board.paths, 'upstream').links.get(one)!.base!.status).toBe('in_progress');
    expect(store.links.get(two)!.base!.status).toBe('done');

    // Re-running with the remote back finishes the job and records the fingerprint.
    const { connector: again } = fakeConnector({
      R1: { status: 'in_progress' } as RemoteRecord,
      R2: { status: 'done' } as RemoteRecord,
    });
    const second = await applyRebase(board, openedRemote(mappingStatusOnly()), again, store);
    expect(second.failed).toEqual([]);
    expect(second.fingerprintUpdated).toBe(true);
    expect(loadMappingSnapshot(board.paths, 'upstream')).toBeDefined();
  });

  it('a gone twin is reported and does not block the fingerprint', async () => {
    const { board, one, two } = boardWithTwo();
    const store = linkStore({
      [one]: { remoteId: 'R1', base: { status: 'in_progress', title: 't' } },
      [two]: { remoteId: 'R2', base: { status: 'done', title: 't' } },
    });
    const { connector } = fakeConnector({
      R1: { status: 'in_progress' } as RemoteRecord,
      R2: null,
    });

    const report = await applyRebase(board, openedRemote(mappingStatusOnly()), connector, store);

    expect(report.unreadable).toEqual([{ localId: two, remoteId: 'R2' }]);
    expect(report.rebased).toEqual([one]);
    expect(report.fingerprintUpdated).toBe(true);
    // The gone twin's base is left alone.
    expect(store.links.get(two)!.base!.status).toBe('done');
  });

  it('an orphaned link is reported and does not block the fingerprint', async () => {
    const { board, one } = boardWithTwo();
    const store = linkStore({
      [one]: { remoteId: 'R1', base: { status: 'in_progress', title: 't' } },
      'LP-999': { remoteId: 'R999', base: { status: 'done' } },
    });
    const { connector } = fakeConnector({ R1: { status: 'in_progress' } as RemoteRecord });

    const report = await applyRebase(board, openedRemote(mappingStatusOnly()), connector, store);

    expect(report.orphaned).toEqual([{ localId: 'LP-999' }]);
    expect(report.fingerprintUpdated).toBe(true);
  });
});
