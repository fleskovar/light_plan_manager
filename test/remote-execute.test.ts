import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createIssue, type LoadedBoard } from '../src/core/index.js';
import {
  emptyCapabilities,
  computeBase,
  executePush,
  hashBody,
  loadLinkStore,
  planPush,
  type LinkEntry,
  type LinkStore,
  type OpProgress,
  type OpenedRemote,
  type Provider,
  type RemoteOp,
  type RemoteSnapshot,
  type Translator,
  type BoardFields,
  type BoardFieldsPatch,
  type BoardOp,
  type Connector,
  type ManagedBlockEntry,
  type RemoteRecord,
  type RemoteRequest,
} from '../src/remote/index.js';
import type { BoardView } from '../src/shared/index.js';
import { toSnapshot } from '../src/sync/index.js';
import { BudgetExhaustedError, RemoteError } from '../src/remote/transport/index.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterAll(cleanupBoards);

/**
 * LP-490 — `executePush` walks a `RemoteOp[]` through a provider and a
 * connector, recording each landed operation. Built against a real board
 * (`makeBoard`) and an in-memory connector — a literal plan, no network.
 */

/** The board as the planners read it, built from a snapshot. */
function view(board: LoadedBoard): BoardView {
  const snapshot = toSnapshot(board);
  const nodes = Object.fromEntries(
    [...snapshot.issues, ...snapshot.periods, ...snapshot.resources, ...snapshot.templates].map(
      (node) => [node.id, node],
    ),
  );
  return { config: snapshot.config, nodes };
}

function linkStore(entries: Record<string, LinkEntry>): LinkStore {
  const links = new Map(Object.entries(entries));
  const byRemote = new Map<string, string>();
  for (const [localId, entry] of links) byRemote.set(entry.remoteId, localId);
  return { version: 1, cursor: null, links, byRemote, tombstones: new Map() };
}

function twin(
  remoteId: string,
  base?: Record<string, unknown>,
  managedCommentId?: string,
): LinkEntry {
  return {
    remoteId,
    remoteKey: `acme/payments#${remoteId}`,
    remoteUrl: `https://github.com/acme/payments/issues/${remoteId}`,
    syncedAt: '2026-09-04T11:19:58Z',
    remoteRev: '2026-09-04T11:19:57Z',
    ...(base ? { base } : {}),
    ...(managedCommentId ? { managedCommentId } : {}),
  };
}

function snapshot(): RemoteSnapshot {
  return { direction: 'both', issues: new Map() };
}

/** The board fields a create op carries (the executor re-reads them from the board). */
function fieldsOf(board: LoadedBoard, id: string): BoardFields {
  const doc = board.byId.get(id)!;
  return {
    title: doc.title,
    body: doc.body,
    type: doc.type,
    status: doc.status,
    assignee: doc.assignee,
    period: doc.period,
    attributes: doc.attributes,
  };
}

/** programme > epic > feature > story, the story depending on the feature. */
function featureWithStory() {
  const paths = makeBoard('scrum', 'LP');
  const programme = createIssue(reload(paths), { type: 'program', title: 'Programme' });
  const epic = createIssue(reload(paths), { type: 'epic', title: 'Epic', parentId: programme.id });
  const feature = createIssue(reload(paths), { type: 'feature', title: 'Feature', parentId: epic.id });
  const story = createIssue(reload(paths), {
    type: 'user_story',
    title: 'Story',
    parentId: feature.id,
    dependsOn: [feature.id],
  });
  return { paths, programme, epic, feature, story };
}

// ---------------------------------------------------------------------------
// In-memory connector and provider doubles
// ---------------------------------------------------------------------------

interface Call {
  method:
    | 'create'
    | 'update'
    | 'delete'
    | 'link'
    | 'unlink'
    | 'comment'
    | 'editComment'
    | 'deleteComment';
  remoteId?: string;
  commentId?: string;
  dependency?: string;
  body?: string;
  request?: RemoteRequest;
}

/** A translator that echoes the board fields into the request, for asserting on them. */
const echoTranslator: Translator = {
  describeRequest(op: BoardOp) {
    if (op.kind === 'delete') {
      return { request: { kind: 'delete' }, problems: [], resourceGaps: [], periodGaps: [] };
    }
    return {
      request: {
        kind: op.kind,
        title: op.fields.title,
        body: op.fields.body,
        state: op.fields.status,
        assignee: op.fields.assignee ?? null,
      },
      problems: [],
      resourceGaps: [],
      periodGaps: [],
    };
  },
  fieldsFromRecord() {
    return { patch: {}, problems: [], unknownAccounts: [] };
  },
};

/** A provider whose `connector` is never used — the executor drives one directly. */
function makeProvider(): Provider {
  return {
    config: z.object({ connection: z.object({}), mapping: z.object({}) }),
    capabilities: emptyCapabilities(),
    translator: echoTranslator,
    connector: () => {
      throw new Error('the executor drives a connector directly');
    },
  };
}

function openedRemote(mapping: Record<string, unknown> = {}): OpenedRemote {
  return {
    name: 'test',
    provider: makeProvider(),
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

function resultOf(id: string, suffix = ''): {
  remoteId: string;
  remoteKey: string;
  remoteUrl: string;
  remoteRev: string;
} {
  return {
    remoteId: id,
    remoteKey: `mem#${id}`,
    remoteUrl: `https://mem/${id}`,
    remoteRev: `rev-${id}${suffix}`,
  };
}

/** A full connector double: records calls, allocates remote ids, and can fail a create. */
function fakeConnector(opts: { failCreate?: (request: RemoteRequest) => boolean } = {}) {
  const calls: Call[] = [];
  let next = 100;
  const connector: Connector = {
    name: 'memory',
    async create(request: RemoteRequest) {
      calls.push({ method: 'create', request });
      if (opts.failCreate?.(request)) throw new Error(`create rejected: ${request.title}`);
      return resultOf(String(next++));
    },
    async update(remoteId: string, request: RemoteRequest) {
      calls.push({ method: 'update', remoteId, request });
      return resultOf(remoteId, 'u');
    },
    async delete(remoteId: string) {
      calls.push({ method: 'delete', remoteId });
      return resultOf(remoteId, 'd');
    },
    async get() {
      return null;
    },
    async list() {
      return { records: [], cursor: null };
    },
    async link(dependentRemoteId: string, dependencyRemoteId: string) {
      calls.push({ method: 'link', remoteId: dependentRemoteId, dependency: dependencyRemoteId });
      return resultOf(dependentRemoteId, 'l');
    },
    async unlink(dependentRemoteId: string, dependencyRemoteId: string) {
      calls.push({ method: 'unlink', remoteId: dependentRemoteId, dependency: dependencyRemoteId });
      return resultOf(dependentRemoteId, 'ul');
    },
    async comment(remoteId: string, body: string) {
      calls.push({ method: 'comment', remoteId, body });
      return { ...resultOf(remoteId, 'c'), commentId: `cmt-${calls.length}` };
    },
    async editComment(remoteId: string, commentId: string, body: string) {
      calls.push({ method: 'editComment', remoteId, commentId, body });
      return { ...resultOf(remoteId, 'e'), commentId };
    },
    async deleteComment(remoteId: string, commentId: string) {
      calls.push({ method: 'deleteComment', remoteId, commentId });
      return { ...resultOf(remoteId, 'd'), commentId };
    },
  };
  return { connector, calls };
}

/** A connector with no edge/comment methods, to exercise the skip path. */
function bareConnector() {
  const calls: Call[] = [];
  let next = 200;
  const connector: Connector = {
    name: 'memory',
    async create(request: RemoteRequest) {
      calls.push({ method: 'create', request });
      return resultOf(String(next++));
    },
    async update(remoteId: string, request: RemoteRequest) {
      calls.push({ method: 'update', remoteId, request });
      return resultOf(remoteId, 'u');
    },
    async delete(remoteId: string) {
      calls.push({ method: 'delete', remoteId });
      return resultOf(remoteId, 'd');
    },
    async get() {
      return null;
    },
    async list() {
      return { records: [], cursor: null };
    },
  };
  return { connector, calls };
}

// ---------------------------------------------------------------------------
// executePush
// ---------------------------------------------------------------------------

describe('executePush', () => {
  it('executes ops in plan order and resolves a create placeholder for later ops', async () => {
    const { paths, programme, epic } = featureWithStory();
    const board = reload(paths);
    const { connector, calls } = fakeConnector();
    const store = linkStore({});

    const plan: RemoteOp[] = [
      { kind: 'create', placeholder: 'new:1', localId: programme.id, fields: fieldsOf(board, programme.id) },
      {
        kind: 'create',
        placeholder: 'new:2',
        localId: epic.id,
        fields: fieldsOf(board, epic.id) ,
        parent: { kind: 'created', localId: programme.id, placeholder: 'new:1' },
      },
      {
        kind: 'link',
        linkKind: 'depends',
        dependent: { kind: 'created', localId: epic.id, placeholder: 'new:2' },
        dependency: { kind: 'created', localId: programme.id, placeholder: 'new:1' },
      },
    ];

    const result = await executePush(board, openedRemote(), connector, store, plan);

    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.landed.map((op) => op.kind)).toEqual(['create', 'create', 'link']);

    const programmeRemoteId = result.landed.find((op) => op.localId === programme.id)?.remoteId;
    const epicRemoteId = result.landed.find((op) => op.localId === epic.id)?.remoteId;
    expect(programmeRemoteId).toBeDefined();
    expect(epicRemoteId).toBeDefined();

    const creates = calls.filter((c) => c.method === 'create');
    expect(creates.map((c) => c.request?.title)).toEqual(['Programme', 'Epic']);
    // The child create carries the parent's real remote id, not its placeholder.
    expect(creates[1]!.request?.parent).toBe(programmeRemoteId);

    // The link op resolved both placeholders.
    const link = calls.find((c) => c.method === 'link')!;
    expect(link.remoteId).toBe(epicRemoteId);
    expect(link.dependency).toBe(programmeRemoteId);
  });

  it('records link and base from the response, persisted before the next op', async () => {
    const { paths, programme, feature } = featureWithStory();
    const board = reload(paths);
    const { connector } = fakeConnector({ failCreate: (request) => request.title === 'Feature' });
    const store = linkStore({});

    const plan: RemoteOp[] = [
      { kind: 'create', placeholder: 'new:1', localId: programme.id, fields: fieldsOf(board, programme.id) },
      {
        kind: 'create',
        placeholder: 'new:2',
        localId: feature.id,
        fields: fieldsOf(board, feature.id) ,
        parent: { kind: 'created', localId: programme.id, placeholder: 'new:1' },
      },
    ];

    const result = await executePush(board, openedRemote(), connector, store, plan);

    expect(result.landed.map((op) => op.localId)).toEqual([programme.id]);
    expect(result.failed.map((op) => op.localId)).toEqual([feature.id]);

    // The link and base both come from the response, not from local intent.
    const link = store.links.get(programme.id)!;
    expect(link.remoteId).toBe('100');
    expect(link.remoteRev).toBe('rev-100');
    expect(link.base?.title).toBe('Programme');
    expect(link.base?.dependsOn).toEqual([]);
    // Shape (LP-368): the agreed parent and type ride along, so a later pull
    // can tell who moved the document.
    expect(link.base?.parent).toBeNull();
    expect(link.base?.type).toBe('program');

    // The landed create was written to disk before the failing op was attempted.
    const onDisk = loadLinkStore(paths, 'test');
    expect(onDisk.links.get(programme.id)?.remoteId).toBe('100');
    expect(onDisk.links.get(feature.id)).toBeUndefined();
  });

  it('records a field the remote would not take as unset, so the next push writes it', async () => {
    // The board's work and its timeline are pushed independently: an issue
    // scheduled into a sprint the tracker has not got is filed *unscheduled*,
    // and the connector says which field it dropped. Recording the local value
    // would make the two sides look agreed and the scheduling would never land
    // — the same trap `parentRemoteId` exists to avoid for a parent that
    // arrives later.
    const { paths, programme } = featureWithStory();
    const board = reload(paths);
    const calls: Call[] = [];
    let next = 100;
    const connector: Connector = {
      name: 'memory',
      async create(request: RemoteRequest) {
        calls.push({ method: 'create', request });
        return { ...resultOf(String(next++)), unwritten: ['period'] };
      },
      async update(remoteId: string) {
        return resultOf(remoteId, 'u');
      },
      async delete(remoteId: string) {
        return resultOf(remoteId, 'd');
      },
      async get() {
        return null;
      },
      async list() {
        return { records: [], cursor: null };
      },
    };
    const store = linkStore({});

    await executePush(board, openedRemote(), connector, store, [
      { kind: 'create', placeholder: 'new:1', localId: programme.id, fields: fieldsOf(board, programme.id) },
    ]);

    expect(store.links.get(programme.id)!.base?.period).toBeNull();
  });

  it('continues for independent documents and skips children of a failed create', async () => {
    const { paths, programme, epic, feature, story } = featureWithStory();
    const board = reload(paths);
    const { connector } = fakeConnector({ failCreate: (request) => request.title === 'Epic' });
    const store = linkStore({});

    const plan: RemoteOp[] = [
      { kind: 'create', placeholder: 'new:1', localId: programme.id, fields: fieldsOf(board, programme.id) },
      {
        kind: 'create',
        placeholder: 'new:2',
        localId: epic.id,
        fields: fieldsOf(board, epic.id) ,
        parent: { kind: 'created', localId: programme.id, placeholder: 'new:1' },
      },
      {
        kind: 'create',
        placeholder: 'new:3',
        localId: feature.id,
        fields: fieldsOf(board, feature.id) ,
        parent: { kind: 'created', localId: epic.id, placeholder: 'new:2' },
      },
      {
        kind: 'create',
        placeholder: 'new:4',
        localId: story.id,
        fields: fieldsOf(board, story.id) ,
        parent: { kind: 'created', localId: feature.id, placeholder: 'new:3' },
      },
    ];

    const result = await executePush(board, openedRemote(), connector, store, plan);

    expect(result.landed.map((op) => op.localId)).toEqual([programme.id]);
    expect(result.failed.map((op) => op.localId)).toEqual([epic.id]);
    expect(result.skipped.map((op) => op.localId)).toEqual([feature.id, story.id]);
    expect(result.skipped.map((op) => op.reason)).toEqual([
      `waits on ${epic.id}, which was not created`,
      `waits on ${feature.id}, which was not created`,
    ]);
  });

  it('continues past a failed create to land an independent document', async () => {
    const { paths, programme, epic } = featureWithStory();
    const board = reload(paths);
    const { connector } = fakeConnector({ failCreate: (request) => request.title === 'Programme' });
    const store = linkStore({});

    // The second create is independent: its plan op carries no parent, so the
    // executor files it at the root even though the board document has one.
    // A failed create must not stop later independent ops from landing.
    const plan: RemoteOp[] = [
      { kind: 'create', placeholder: 'new:1', localId: programme.id, fields: fieldsOf(board, programme.id) },
      { kind: 'create', placeholder: 'new:2', localId: epic.id, fields: fieldsOf(board, epic.id) },
    ];

    const result = await executePush(board, openedRemote(), connector, store, plan);

    expect(result.failed.map((op) => op.localId)).toEqual([programme.id]);
    expect(result.landed.map((op) => op.localId)).toEqual([epic.id]);
    expect(result.skipped).toEqual([]);
  });

  it('re-plans after a partial failure: landed creates plan to nothing, the rest retry', async () => {
    const { paths, programme, epic, feature, story } = featureWithStory();
    const board = reload(paths);
    const store = linkStore({});

    const plan = planPush(view(board), store, snapshot()).ops;
    const { connector } = fakeConnector({ failCreate: (request) => request.title === 'Feature' });
    const result = await executePush(board, openedRemote(), connector, store, plan);

    expect(result.landed.map((op) => op.localId).sort()).toEqual([programme.id, epic.id].sort());
    expect(result.failed.map((op) => op.localId)).toEqual([feature.id]);

    // Re-planning against the updated store: the landed creates are now linked
    // and their base matches, so they plan to nothing; the unlinked ones retry.
    const replanned = planPush(view(board), store, snapshot()).ops;
    const createLocalIds = replanned
      .filter((op): op is Extract<RemoteOp, { kind: 'create' }> => op.kind === 'create')
      .map((op) => op.localId);
    expect(createLocalIds).toEqual([feature.id, story.id]);
    // The edge never landed either, so it is re-planned too.
    expect(replanned.some((op) => op.kind === 'link')).toBe(true);
  });

  it('emits progress per op through the callback', async () => {
    const { paths, programme, epic } = featureWithStory();
    const board = reload(paths);
    const { connector } = fakeConnector();
    const store = linkStore({});

    const plan: RemoteOp[] = [
      { kind: 'create', placeholder: 'new:1', localId: programme.id, fields: fieldsOf(board, programme.id) },
      {
        kind: 'create',
        placeholder: 'new:2',
        localId: epic.id,
        fields: fieldsOf(board, epic.id) ,
        parent: { kind: 'created', localId: programme.id, placeholder: 'new:1' },
      },
    ];

    const progress: OpProgress[] = [];
    await executePush(board, openedRemote(), connector, store, plan, {
      onProgress: (p) => progress.push(p),
    });

    expect(progress.map((p) => ({ index: p.index, total: p.total, localId: p.localId }))).toEqual([
      { index: 1, total: 2, localId: programme.id },
      { index: 2, total: 2, localId: epic.id },
    ]);
  });

  it('skips link and comment when the connector lacks them, and lands them when it does not', async () => {
    const { paths, programme, feature } = featureWithStory();
    const board = reload(paths);
    const plan: RemoteOp[] = [
      {
        kind: 'link',
        linkKind: 'depends',
        dependent: { kind: 'linked', localId: feature.id, remoteId: '901' },
        dependency: { kind: 'linked', localId: programme.id, remoteId: '900' },
      },
      { kind: 'comment', ref: { kind: 'linked', localId: feature.id, remoteId: '901' }, index: 1, author: 'Ada', body: 'hi' },
    ];

    const bare = bareConnector();
    const bareResult = await executePush(
      board,
      openedRemote(),
      bare.connector,
      linkStore({ [programme.id]: twin('900'), [feature.id]: twin('901') }),
      plan,
    );
    expect(bareResult.skipped.map((op) => op.kind)).toEqual(['link', 'comment']);
    expect(bareResult.skipped.map((op) => op.reason)).toEqual([
      'connector does not support links',
      'connector does not support comments',
    ]);

    const full = fakeConnector();
    const fullResult = await executePush(
      board,
      openedRemote(),
      full.connector,
      linkStore({ [programme.id]: twin('900'), [feature.id]: twin('901') }),
      plan,
    );
    expect(fullResult.landed.map((op) => op.kind)).toEqual(['link', 'comment']);
  });

  it('unlinkLocal drops the correspondence without touching the remote', async () => {
    const { paths, programme } = featureWithStory();
    const board = reload(paths);
    const store = linkStore({ [programme.id]: twin('900') });
    const { connector, calls } = fakeConnector();

    const result = await executePush(board, openedRemote(), connector, store, [
      { kind: 'unlinkLocal', localId: programme.id },
    ]);

    expect(result.landed).toEqual([
      { kind: 'unlinkLocal', localId: programme.id, status: 'landed' },
    ]);
    expect(store.links.has(programme.id)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('decouple drops the link and its base, writes a tombstone, and never calls the remote', async () => {
    const { paths, programme } = featureWithStory();
    const board = reload(paths);
    const store = linkStore({ [programme.id]: twin('900', { title: 'Old' }) });
    const { connector, calls } = fakeConnector();
    const at = '2026-09-05T12:00:00.000Z';

    const result = await executePush(
      board,
      openedRemote(),
      connector,
      store,
      [{ kind: 'decouple', localId: programme.id, reason: 'out_of_scope' }],
      { now: () => new Date(at) },
    );

    expect(result.landed).toEqual([
      { kind: 'decouple', localId: programme.id, status: 'landed' },
    ]);
    // The link — and with it the base snapshot — is gone.
    expect(store.links.has(programme.id)).toBe(false);
    // The tombstone remembers the last remote key, the reason and when.
    expect(store.tombstones.get(programme.id)).toEqual({
      remoteKey: 'acme/payments#900',
      reason: 'out_of_scope',
      at,
    });
    expect(calls).toEqual([]);
  });

  it('delete removes the twin through the connector and drops the dangling link', async () => {
    const { paths } = featureWithStory();
    const board = reload(paths);
    const store = linkStore({ 'LP-404': twin('900') });
    const { connector, calls } = fakeConnector();

    const result = await executePush(board, openedRemote(), connector, store, [
      { kind: 'delete', localId: 'LP-404', ref: { kind: 'linked', localId: 'LP-404', remoteId: '900' } },
    ]);

    expect(result.landed).toEqual([
      { kind: 'delete', localId: 'LP-404', status: 'landed', remoteId: '900' },
    ]);
    expect(calls).toEqual([{ method: 'delete', remoteId: '900' }]);
    expect(store.links.has('LP-404')).toBe(false);
    expect(store.tombstones.has('LP-404')).toBe(false);
  });

  it('delete of an out-of-scope document decouples it (a tombstone) after the delete lands', async () => {
    const { paths, epic } = featureWithStory();
    const board = reload(paths);
    const store = linkStore({ [epic.id]: twin('900') });
    const { connector, calls } = fakeConnector();
    const at = '2026-09-05T12:00:00.000Z';

    const result = await executePush(
      board,
      openedRemote(),
      connector,
      store,
      [{ kind: 'delete', localId: epic.id, ref: { kind: 'linked', localId: epic.id, remoteId: '900' } }],
      { now: () => new Date(at) },
    );

    expect(result.landed).toEqual([
      { kind: 'delete', localId: epic.id, status: 'landed', remoteId: '900' },
    ]);
    expect(calls).toEqual([{ method: 'delete', remoteId: '900' }]);
    expect(store.links.has(epic.id)).toBe(false);
    expect(store.tombstones.get(epic.id)).toEqual({
      remoteKey: 'acme/payments#900',
      reason: 'out_of_scope',
      at,
    });
  });

  it('close with a note posts it, closes to the terminal status, and drops the dangling link', async () => {
    const { paths } = featureWithStory();
    const board = reload(paths);
    const store = linkStore({ 'LP-404': twin('900', { type: 'user_story', status: 'backlog' }) });
    const { connector, calls } = fakeConnector();

    const result = await executePush(board, openedRemote(), connector, store, [
      {
        kind: 'close',
        localId: 'LP-404',
        ref: { kind: 'linked', localId: 'LP-404', remoteId: '900' },
        note: 'Closed because deleted',
      },
    ]);

    expect(result.landed).toEqual([
      { kind: 'close', localId: 'LP-404', status: 'landed', remoteId: '900' },
    ]);
    expect(calls.map((call) => call.method)).toEqual(['comment', 'update']);
    expect(calls.find((call) => call.method === 'comment')).toMatchObject({
      remoteId: '900',
      body: 'Closed because deleted',
    });
    // The update closed to the board's terminal status, read from the base's type.
    expect(calls.find((call) => call.method === 'update')?.request).toMatchObject({ state: 'done' });
    expect(store.links.has('LP-404')).toBe(false);
    expect(store.tombstones.has('LP-404')).toBe(false);
  });

  it('records a base whose body and mapped fields match, so computeBase agrees', async () => {
    const { paths, programme } = featureWithStory();
    const board = reload(paths);
    const { connector } = fakeConnector();
    const store = linkStore({});

    await executePush(
      board,
      openedRemote(),
      connector,
      store,
      [{ kind: 'create', placeholder: 'new:1', localId: programme.id, fields: fieldsOf(board, programme.id) }],
    );

    const link = store.links.get(programme.id)!;
    const doc = board.byId.get(programme.id)!;
    const expected = computeBase(doc, new Set(['title', 'body', 'status']));
    expect(link.base?.title).toBe(expected.title);
    expect(link.base?.body).toBe(expected.body);
    expect(link.base?.status).toBe(expected.status);
  });

  it('sends only the changed title or body on an update (LP-307)', async () => {
    const { paths, programme } = featureWithStory();
    const board = reload(paths);
    const { connector, calls } = fakeConnector();
    const base = computeBase(board.byId.get(programme.id)!, new Set(['title', 'body', 'status']));
    const store = linkStore({ [programme.id]: twin('900', base) });

    await executePush(board, openedRemote(), connector, store, [
      {
        kind: 'update',
        localId: programme.id,
        ref: { kind: 'linked', localId: programme.id, remoteId: '900' },
        fields: { title: 'Renamed' },
      },
      {
        kind: 'update',
        localId: programme.id,
        ref: { kind: 'linked', localId: programme.id, remoteId: '900' },
        fields: { body: 'New body' },
      },
    ]);

    const updates = calls.filter((c) => c.method === 'update');
    // Title changed, body did not: the patch carries the title and nothing
    // else for the body — an unchanged field must not travel (LP-307).
    expect(updates[0]!.request?.title).toBe('Renamed');
    expect(updates[0]!.request?.body).toBeUndefined();
    // Body changed, title did not: the mirror case.
    expect(updates[1]!.request?.title).toBeUndefined();
    expect(updates[1]!.request?.body).toBe('New body');
  });

  it('a transition or close re-sends neither title nor body (LP-307)', async () => {
    const { paths, programme } = featureWithStory();
    const board = reload(paths);
    const { connector, calls } = fakeConnector();
    const base = computeBase(board.byId.get(programme.id)!, new Set(['title', 'body', 'status']));
    const store = linkStore({ [programme.id]: twin('900', base) });

    await executePush(board, openedRemote(), connector, store, [
      { kind: 'close', localId: programme.id, ref: { kind: 'linked', localId: programme.id, remoteId: '900' } },
    ]);

    const update = calls.find((c) => c.method === 'update')!;
    expect(update.request?.title).toBeUndefined();
    expect(update.request?.body).toBeUndefined();
  });

  it('records the node id on the link when the connector supplies one (LP-307)', async () => {
    const { paths, programme } = featureWithStory();
    const board = reload(paths);
    const connector: Connector = {
      name: 'memory',
      async create() {
        return {
          remoteId: '42',
          remoteKey: 'mem#42',
          remoteUrl: 'https://mem/42',
          remoteRev: 'rev-42',
          nodeId: 'N_42',
        };
      },
      async update(remoteId: string) {
        return { remoteId, remoteKey: '', remoteUrl: '', remoteRev: '' };
      },
      async delete(remoteId: string) {
        return { remoteId, remoteKey: '', remoteUrl: '', remoteRev: '' };
      },
      async get() {
        return null;
      },
      async list() {
        return { records: [], cursor: null };
      },
    };
    const store = linkStore({});

    await executePush(board, openedRemote(), connector, store, [
      { kind: 'create', placeholder: 'new:1', localId: programme.id, fields: fieldsOf(board, programme.id) },
    ]);

    expect(store.links.get(programme.id)?.nodeId).toBe('N_42');
  });
});

// ---------------------------------------------------------------------------
// LP-288 — the base is recorded from the remote's response, not from intent
// ---------------------------------------------------------------------------

/** A translator that recovers fields from a remote record, so the executor's
 *  base-from-response path can be exercised end to end. */
const recoverTranslator: Translator = {
  describeRequest(op) {
    if (op.kind === 'delete') {
      return { request: { kind: 'delete' }, problems: [], resourceGaps: [], periodGaps: [] };
    }
    return {
      request: {
        kind: op.kind,
        title: op.fields.title,
        body: op.fields.body,
        state: op.fields.status,
        assignee: op.fields.assignee ?? null,
      },
      problems: [],
      resourceGaps: [],
      periodGaps: [],
    };
  },
  fieldsFromRecord(record: RemoteRecord) {
    const patch: BoardFieldsPatch = {};
    if (typeof record.title === 'string') patch.title = record.title;
    if (typeof record.body === 'string') patch.body = record.body;
    if (typeof record.state === 'string') patch.status = record.state;
    return { patch, problems: [], unknownAccounts: [] };
  },
};

function makeRecoverProvider(): Provider {
  return {
    config: z.object({ connection: z.object({}), mapping: z.object({}) }),
    capabilities: emptyCapabilities(),
    translator: recoverTranslator,
    connector: () => {
      throw new Error('the executor drives a connector directly');
    },
  };
}

function openedRecoverRemote(mapping: Record<string, unknown> = {}): OpenedRemote {
  return { ...openedRemote(mapping), provider: makeRecoverProvider() };
}

/**
 * A connector whose remote rewrites the body on every write — the way a real
 * tracker might auto-format markdown — and returns the post-write record. The
 * rewrite is deliberately *not* canonical-absorbable, so a base recorded from
 * intent would differ from a base recorded from the response.
 */
function normalisingConnector() {
  const calls: Call[] = [];
  const issues = new Map<string, RemoteRecord>();
  let next = 700;
  const connector: Connector = {
    name: 'normalising',
    async create(request: RemoteRequest) {
      const remoteId = String(next++);
      const record: RemoteRecord = {
        id: remoteId,
        title: request.title,
        body: `${request.body ?? ''}\n\n_auto-formatted by remote_`,
        state: request.state,
      };
      issues.set(remoteId, record);
      calls.push({ method: 'create', request });
      return {
        remoteId,
        remoteKey: `norm#${remoteId}`,
        remoteUrl: '',
        remoteRev: `rev-${remoteId}`,
        record,
      };
    },
    async update(remoteId: string, request: RemoteRequest) {
      const record: RemoteRecord = {
        id: remoteId,
        title: request.title,
        body: `${request.body ?? ''}\n\n_auto-formatted by remote_`,
        state: request.state,
      };
      issues.set(remoteId, record);
      calls.push({ method: 'update', remoteId, request });
      return {
        remoteId,
        remoteKey: `norm#${remoteId}`,
        remoteUrl: '',
        remoteRev: `rev-${remoteId}-u`,
        record,
      };
    },
    async delete(remoteId: string) {
      issues.delete(remoteId);
      return { remoteId, remoteKey: `norm#${remoteId}`, remoteUrl: '', remoteRev: `rev-${remoteId}-d` };
    },
    async get(remoteId: string) {
      return issues.get(remoteId) ?? null;
    },
    async list() {
      return { records: [...issues.values()], cursor: null };
    },
  };
  return { connector, calls };
}

describe('executePush — LP-288 base from the remote response', () => {
  it('records the base from the post-write record, absorbing a body rewrite', async () => {
    const { paths, programme } = featureWithStory();
    const board = reload(paths);
    const { connector } = normalisingConnector();
    const store = linkStore({});

    await executePush(
      board,
      openedRecoverRemote(),
      connector,
      store,
      [{ kind: 'create', placeholder: 'new:1', localId: programme.id, fields: fieldsOf(board, programme.id) }],
    );

    const doc = board.byId.get(programme.id)!;
    const link = store.links.get(programme.id)!;

    // The base body is the *rewritten* body the remote stored, not the body we
    // asked it to write. If the executor recorded intent, this hash would be
    // `hashBody(doc.body)` and the next pull would see the rewrite as a remote
    // edit — the ping-pong LP-288 exists to prevent.
    expect(link.base?.body).toBe(hashBody(`${doc.body}\n\n_auto-formatted by remote_`));
    expect(link.base?.body).not.toBe(hashBody(doc.body));
  });

  it('falls back to the local document when the connector returns no record', async () => {
    const { paths, programme } = featureWithStory();
    const board = reload(paths);
    const { connector } = fakeConnector();
    const store = linkStore({});

    await executePush(
      board,
      openedRecoverRemote(),
      connector,
      store,
      [{ kind: 'create', placeholder: 'new:1', localId: programme.id, fields: fieldsOf(board, programme.id) }],
    );

    const doc = board.byId.get(programme.id)!;
    expect(store.links.get(programme.id)!.base?.body).toBe(hashBody(doc.body));
  });

  it('does not advance the base of a document whose update failed', async () => {
    const { paths, programme } = featureWithStory();
    const board = reload(paths);

    // The base matches the board now; the connector rejects the update.
    const base = computeBase(board.byId.get(programme.id)!, new Set(['title', 'body', 'status']));
    const store = linkStore({ [programme.id]: twin('900', base) });

    const calls: Call[] = [];
    const connector: Connector = {
      name: 'memory',
      async create() {
        throw new Error('unused');
      },
      async update(remoteId: string, request: RemoteRequest) {
        calls.push({ method: 'update', remoteId, request });
        throw new Error('update rejected');
      },
      async delete(remoteId: string) {
        return { remoteId, remoteKey: '', remoteUrl: '', remoteRev: '' };
      },
      async get() {
        return null;
      },
      async list() {
        return { records: [], cursor: null };
      },
    };

    const result = await executePush(
      board,
      openedRecoverRemote(),
      connector,
      store,
      [{ kind: 'update', localId: programme.id, ref: { kind: 'linked', localId: programme.id, remoteId: '900' }, fields: { title: 'Changed' } }],
    );

    expect(result.failed.map((op) => op.localId)).toEqual([programme.id]);
    // The base is unchanged — a failed write must not snapshot intent, and the
    // executor's `recordBase` (which also adds the tracked edge list) never ran.
    expect(store.links.get(programme.id)!.base).toEqual(base);
  });
});

// ---------------------------------------------------------------------------
// The managed-comment op (LP-278)
// ---------------------------------------------------------------------------

const COMMENT_ENTRIES: ManagedBlockEntry[] = [
  { name: 'type', kind: 'text', value: 'user_story' },
  { name: 'depends_on', kind: 'ids', value: ['LP-4', 'LP-7'] },
];

const COMMENTS = { native: true, editable: true, deletable: true };
const NO_EDIT = { native: true, editable: false, deletable: true };
const NO_COMMENTS = { native: false, editable: false, deletable: false };

function managedCommentOp(localId: string, remoteId: string, entries: ManagedBlockEntry[] = COMMENT_ENTRIES): RemoteOp {
  return {
    kind: 'managedComment',
    localId,
    ref: { kind: 'linked', localId, remoteId },
    entries,
  };
}

describe('executePush — managedComment', () => {
  it('posts the block as a comment and records its id in the link store', async () => {
    const { paths, programme } = featureWithStory();
    const board = reload(paths);
    const { connector, calls } = fakeConnector();
    const store = linkStore({ [programme.id]: twin('900') });

    const result = await executePush(board, openedRemote(), connector, store, [
      managedCommentOp(programme.id, '900'),
    ], { comments: COMMENTS });

    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.landed.map((op) => op.kind)).toEqual(['managedComment']);

    const comment = calls.find((c) => c.method === 'comment')!;
    expect(comment.remoteId).toBe('900');
    expect(comment.body).toContain('<!-- lpm:begin -->');
    expect(comment.body).toContain('<!-- lpm:end -->');
    expect(store.links.get(programme.id)!.managedCommentId).toBe('cmt-1');
  });

  it('edits an existing managed comment rather than duplicating it', async () => {
    const { paths, programme } = featureWithStory();
    const board = reload(paths);
    const { connector, calls } = fakeConnector();
    const store = linkStore({ [programme.id]: twin('900', undefined, 'IC_900') });

    const result = await executePush(board, openedRemote(), connector, store, [
      managedCommentOp(programme.id, '900'),
    ], { comments: COMMENTS });

    expect(result.failed).toEqual([]);
    const edit = calls.find((c) => c.method === 'editComment')!;
    expect(edit.remoteId).toBe('900');
    expect(edit.commentId).toBe('IC_900');
    expect(calls.some((c) => c.method === 'comment')).toBe(false); // no duplicate
    expect(store.links.get(programme.id)!.managedCommentId).toBe('IC_900');
  });

  it('deletes and reposts when comments cannot be edited, recording the new id', async () => {
    const { paths, programme } = featureWithStory();
    const board = reload(paths);
    const { connector, calls } = fakeConnector();
    const store = linkStore({ [programme.id]: twin('900', undefined, 'IC_900') });

    const result = await executePush(board, openedRemote(), connector, store, [
      managedCommentOp(programme.id, '900'),
    ], { comments: NO_EDIT });

    expect(result.failed).toEqual([]);
    const methods = calls.map((c) => c.method);
    expect(methods).toEqual(['deleteComment', 'comment']);
    expect(calls[0]!.commentId).toBe('IC_900');
    expect(store.links.get(programme.id)!.managedCommentId).toBe('cmt-2');
  });

  it('removes the managed comment when the entries are gone', async () => {
    const { paths, programme } = featureWithStory();
    const board = reload(paths);
    const { connector, calls } = fakeConnector();
    const store = linkStore({ [programme.id]: twin('900', undefined, 'IC_900') });

    const result = await executePush(board, openedRemote(), connector, store, [
      managedCommentOp(programme.id, '900', []),
    ], { comments: COMMENTS });

    expect(result.failed).toEqual([]);
    expect(calls.map((c) => c.method)).toEqual(['deleteComment']);
    expect(store.links.get(programme.id)!.managedCommentId).toBeUndefined();
  });

  it('fails the op when the remote holds no comments', async () => {
    const { paths, programme } = featureWithStory();
    const board = reload(paths);
    const { connector } = fakeConnector();
    const store = linkStore({ [programme.id]: twin('900') });

    const result = await executePush(board, openedRemote(), connector, store, [
      managedCommentOp(programme.id, '900'),
    ], { comments: NO_COMMENTS });

    expect(result.failed.map((op) => op.kind)).toEqual(['managedComment']);
    expect(result.failed[0]!.error).toBe('the remote holds no comments');
  });

  it('skips the op when the connector has no comment methods at all', async () => {
    const { paths, programme } = featureWithStory();
    const board = reload(paths);
    const bare = bareConnector();
    const store = linkStore({ [programme.id]: twin('900') });

    const result = await executePush(board, openedRemote(), bare.connector, store, [
      managedCommentOp(programme.id, '900'),
    ], { comments: COMMENTS });

    expect(result.skipped.map((op) => op.kind)).toEqual(['managedComment']);
    expect(result.skipped[0]!.reason).toBe('connector does not support comments');
  });
});

// ---------------------------------------------------------------------------
// LP-298 — legibility and resumability: abort, budget stop, --limit, summary
// ---------------------------------------------------------------------------

describe('executePush — abort, budget stop, --limit and the summary', () => {
  it('passes the caller\'s signal into every connector write', async () => {
    const { paths, programme } = featureWithStory();
    const board = reload(paths);
    const controller = new AbortController();
    const received: (AbortSignal | undefined)[] = [];

    const connector: Connector = {
      name: 'memory',
      async create(_request: RemoteRequest, signal?: AbortSignal) {
        received.push(signal);
        return resultOf('1');
      },
      async update() {
        return resultOf('1');
      },
      async delete() {
        return resultOf('1');
      },
      async get() {
        return null;
      },
      async list() {
        return { records: [], cursor: null };
      },
    };

    await executePush(
      board,
      openedRemote(),
      connector,
      linkStore({}),
      [{ kind: 'create', placeholder: 'new:1', localId: programme.id, fields: fieldsOf(board, programme.id) }],
      { signal: controller.signal },
    );

    expect(received).toEqual([controller.signal]);
  });

  it('stops before the next op when the signal is already aborted', async () => {
    const { paths, programme, epic } = featureWithStory();
    const board = reload(paths);
    const controller = new AbortController();
    controller.abort();

    const result = await executePush(
      board,
      openedRemote(),
      fakeConnector().connector,
      linkStore({}),
      [
        { kind: 'create', placeholder: 'new:1', localId: programme.id, fields: fieldsOf(board, programme.id) },
        { kind: 'create', placeholder: 'new:2', localId: epic.id, fields: fieldsOf(board, epic.id) },
      ],
      { signal: controller.signal },
    );

    expect(result.stopped).toEqual({
      reason: 'aborted',
      atOp: 1,
      detail: 'interrupted before the op was attempted',
    });
    expect(result.landed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.conflicted).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.summary).toEqual({ created: 0, updated: 0, skipped: 0, conflicted: 0, failed: 0 });
  });

  it('an aborted in-flight write ends the run, not recorded as a failure', async () => {
    const { paths, programme, epic } = featureWithStory();
    const board = reload(paths);
    const controller = new AbortController();
    const connector: Connector = {
      name: 'memory',
      async create() {
        throw new RemoteError({ kind: 'abort', purpose: 'create issue' });
      },
      async update() {
        return resultOf('1');
      },
      async delete() {
        return resultOf('1');
      },
      async get() {
        return null;
      },
      async list() {
        return { records: [], cursor: null };
      },
    };

    const result = await executePush(
      board,
      openedRemote(),
      connector,
      linkStore({}),
      [
        { kind: 'create', placeholder: 'new:1', localId: programme.id, fields: fieldsOf(board, programme.id) },
        { kind: 'create', placeholder: 'new:2', localId: epic.id, fields: fieldsOf(board, epic.id) },
      ],
      { signal: controller.signal },
    );

    expect(result.stopped?.reason).toBe('aborted');
    expect(result.landed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.conflicted).toEqual([]);
    // The second op was never attempted.
    expect(result.summary).toEqual({ created: 0, updated: 0, skipped: 0, conflicted: 0, failed: 0 });
  });

  it('stops the whole run when the budget is exhausted, with how far it got', async () => {
    const { paths, programme, epic } = featureWithStory();
    const board = reload(paths);
    const connector: Connector = {
      name: 'memory',
      async create() {
        throw new BudgetExhaustedError(3, 5, 'push issues');
      },
      async update() {
        return resultOf('1');
      },
      async delete() {
        return resultOf('1');
      },
      async get() {
        return null;
      },
      async list() {
        return { records: [], cursor: null };
      },
    };

    const result = await executePush(
      board,
      openedRemote(),
      connector,
      linkStore({}),
      [
        { kind: 'create', placeholder: 'new:1', localId: programme.id, fields: fieldsOf(board, programme.id) },
        { kind: 'create', placeholder: 'new:2', localId: epic.id, fields: fieldsOf(board, epic.id) },
      ],
    );

    expect(result.stopped?.reason).toBe('budget');
    expect(result.stopped?.detail).toContain('3 of 5');
    expect(result.landed).toEqual([]);
    expect(result.failed).toEqual([]); // budget exhaustion is a stop, not a per-op failure
  });

  it('--limit stops before the (N+1)th write', async () => {
    const { paths, programme, epic } = featureWithStory();
    const board = reload(paths);
    const { connector } = fakeConnector();
    const store = linkStore({});

    const result = await executePush(
      board,
      openedRemote(),
      connector,
      store,
      [
        { kind: 'create', placeholder: 'new:1', localId: programme.id, fields: fieldsOf(board, programme.id) },
        {
          kind: 'create',
          placeholder: 'new:2',
          localId: epic.id,
          fields: fieldsOf(board, epic.id),
          parent: { kind: 'created', localId: programme.id, placeholder: 'new:1' },
        },
      ],
      { limit: 1 },
    );

    expect(result.landed.map((op) => op.localId)).toEqual([programme.id]);
    expect(result.stopped?.reason).toBe('limit');
    expect(result.stopped?.detail).toContain('--limit 1');
    expect(result.summary.created).toBe(1);
  });

  it('does not spend the --limit on local bookkeeping (unlinkLocal)', async () => {
    const { paths, programme } = featureWithStory();
    const board = reload(paths);
    const { connector, calls } = fakeConnector();
    const store = linkStore({ [programme.id]: twin('900') });

    const result = await executePush(
      board,
      openedRemote(),
      connector,
      store,
      [
        { kind: 'unlinkLocal', localId: programme.id },
        { kind: 'create', placeholder: 'new:1', localId: programme.id, fields: fieldsOf(board, programme.id) },
      ],
      { limit: 1 },
    );

    // The local unlink runs, the one allowed write follows, and the run ends
    // having spent exactly one write.
    expect(result.landed.map((op) => op.kind)).toEqual(['unlinkLocal', 'create']);
    expect(calls.filter((c) => c.method === 'create')).toHaveLength(1);
    expect(result.stopped).toBeUndefined();
  });

  it('classifies a 409 conflict separately from an ordinary failure', async () => {
    const { paths, programme, epic } = featureWithStory();
    const board = reload(paths);
    let created = 0;
    const connector: Connector = {
      name: 'memory',
      async create(request: RemoteRequest) {
        created += 1;
        if (request.title === 'Programme') {
          throw new RemoteError({ status: 409, code: 'conflict', purpose: 'create issue' });
        }
        return resultOf(String(created));
      },
      async update() {
        return resultOf('1');
      },
      async delete() {
        return resultOf('1');
      },
      async get() {
        return null;
      },
      async list() {
        return { records: [], cursor: null };
      },
    };

    const result = await executePush(
      board,
      openedRemote(),
      connector,
      linkStore({}),
      [
        { kind: 'create', placeholder: 'new:1', localId: programme.id, fields: fieldsOf(board, programme.id) },
        { kind: 'create', placeholder: 'new:2', localId: epic.id, fields: fieldsOf(board, epic.id) },
      ],
    );

    // A conflict does not stop the run: the independent second op still lands.
    expect(result.conflicted.map((op) => op.localId)).toEqual([programme.id]);
    expect(result.conflicted[0]!.error).toContain('conflict');
    expect(result.failed).toEqual([]);
    expect(result.summary.conflicted).toBe(1);
    expect(result.summary.failed).toBe(0);
    expect(result.landed.map((op) => op.localId)).toEqual([epic.id]);
  });

  it('reports created, updated, skipped and failed counts in the summary', async () => {
    const { paths, programme, epic, feature, story } = featureWithStory();
    const board = reload(paths);
    const { connector } = fakeConnector({ failCreate: (request) => request.title === 'Epic' });
    const store = linkStore({});

    const result = await executePush(
      board,
      openedRemote(),
      connector,
      store,
      [
        { kind: 'create', placeholder: 'new:1', localId: programme.id, fields: fieldsOf(board, programme.id) },
        {
          kind: 'create',
          placeholder: 'new:2',
          localId: epic.id,
          fields: fieldsOf(board, epic.id),
          parent: { kind: 'created', localId: programme.id, placeholder: 'new:1' },
        },
        {
          kind: 'create',
          placeholder: 'new:3',
          localId: feature.id,
          fields: fieldsOf(board, feature.id),
          parent: { kind: 'created', localId: epic.id, placeholder: 'new:2' },
        },
        {
          kind: 'create',
          placeholder: 'new:4',
          localId: story.id,
          fields: fieldsOf(board, story.id),
          parent: { kind: 'created', localId: feature.id, placeholder: 'new:3' },
        },
      ],
    );

    expect(result.summary).toEqual({ created: 1, updated: 0, skipped: 2, conflicted: 0, failed: 1 });
  });

  it('counts an update on an existing twin as updated, not created', async () => {
    const { paths, programme } = featureWithStory();
    const board = reload(paths);
    const { connector } = fakeConnector();
    const store = linkStore({ [programme.id]: twin('900') });

    const result = await executePush(
      board,
      openedRemote(),
      connector,
      store,
      [
        {
          kind: 'update',
          localId: programme.id,
          ref: { kind: 'linked', localId: programme.id, remoteId: '900' },
          fields: { title: 'Changed' },
        },
      ],
    );

    expect(result.summary).toEqual({ created: 0, updated: 1, skipped: 0, conflicted: 0, failed: 0 });
  });
});

// ---------------------------------------------------------------------------
// LP-312 — the executor sets the Project status after a status-affecting write
// ---------------------------------------------------------------------------

/** A translator that always emits the status as the Project status value, the
 * way the GitHub translator does for the full document it receives. */
const projectStatusTranslator: Translator = {
  describeRequest(op) {
    if (op.kind === 'delete') {
      return { request: { kind: 'delete' }, problems: [], resourceGaps: [], periodGaps: [] };
    }
    return {
      request: {
        kind: op.kind,
        title: op.fields.title,
        body: op.fields.body,
        state: op.fields.status,
        projectStatus: op.fields.status,
      },
      problems: [],
      resourceGaps: [],
      periodGaps: [],
    };
  },
  fieldsFromRecord() {
    return { patch: {}, problems: [], unknownAccounts: [] };
  },
};

function projectStatusProvider(): Provider {
  return {
    config: z.object({ connection: z.object({}), mapping: z.object({}) }),
    capabilities: emptyCapabilities(),
    translator: projectStatusTranslator,
    connector: () => {
      throw new Error('the executor drives a connector directly');
    },
  };
}

function projectStatusRemote(): OpenedRemote {
  return { ...openedRemote(), provider: projectStatusProvider() };
}

/** A connector recording its `setProjectStatus` calls. */
function projectStatusConnector() {
  const setValues: string[] = [];
  const connector: Connector = {
    name: 'memory',
    async create() {
      return resultOf('700');
    },
    async update(remoteId: string) {
      return resultOf(remoteId, 'u');
    },
    async delete(remoteId: string) {
      return resultOf(remoteId, 'd');
    },
    async get() {
      return null;
    },
    async list() {
      return { records: [], cursor: null };
    },
    async setProjectStatus(_remoteId: string, value: string) {
      setValues.push(value);
    },
  };
  return { connector, setValues };
}

describe('executePush — Project status (LP-312)', () => {
  it('sets the Project status after a landed create', async () => {
    const { paths, programme } = featureWithStory();
    const board = reload(paths);
    const doc = board.byId.get(programme.id)!;
    const store = linkStore({});
    const { connector, setValues } = projectStatusConnector();

    const result = await executePush(board, projectStatusRemote(), connector, store, [
      { kind: 'create', placeholder: 'new:1', localId: programme.id, fields: fieldsOf(board, programme.id) },
    ]);

    expect(result.failed).toEqual([]);
    expect(setValues).toEqual([doc.status]);
  });

  it('sets the Project status on a transition but not on a plain update', async () => {
    const { paths, programme } = featureWithStory();
    const board = reload(paths);
    const doc = board.byId.get(programme.id)!;
    const base = computeBase(doc, new Set(['title', 'body', 'status']));
    const store = linkStore({ [programme.id]: twin('900', base) });
    const { connector, setValues } = projectStatusConnector();

    await executePush(board, projectStatusRemote(), connector, store, [
      {
        kind: 'update',
        localId: programme.id,
        ref: { kind: 'linked', localId: programme.id, remoteId: '900' },
        fields: { title: 'Renamed' },
      },
      {
        kind: 'transition',
        localId: programme.id,
        ref: { kind: 'linked', localId: programme.id, remoteId: '900' },
        status: doc.status,
      },
    ]);

    // The title update must not touch the Project column; the transition does.
    expect(setValues).toEqual([doc.status]);
  });

  it('records a failure when the Project status write fails, keeping the link for the re-push', async () => {
    const { paths, programme } = featureWithStory();
    const board = reload(paths);
    const store = linkStore({});
    const connector: Connector = {
      name: 'memory',
      async create() {
        return resultOf('700');
      },
      async update(remoteId: string) {
        return resultOf(remoteId, 'u');
      },
      async delete(remoteId: string) {
        return resultOf(remoteId, 'd');
      },
      async get() {
        return null;
      },
      async list() {
        return { records: [], cursor: null };
      },
      async setProjectStatus() {
        throw new Error('no option "Done"');
      },
    };

    const result = await executePush(board, projectStatusRemote(), connector, store, [
      { kind: 'create', placeholder: 'new:1', localId: programme.id, fields: fieldsOf(board, programme.id) },
    ]);

    // The op did not land — the Project status write failed, so it is reported.
    expect(result.landed).toEqual([]);
    expect(result.failed.map((op) => op.error)).toEqual(['no option "Done"']);
    // The link is recorded (the issue write did land) and the base is not, so
    // the next push re-attempts the status write rather than re-creating.
    expect(store.links.get(programme.id)?.remoteId).toBe('700');
    expect(store.links.get(programme.id)?.base).toBeUndefined();
  });
});
