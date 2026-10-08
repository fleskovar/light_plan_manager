/**
 * LP-325 — map `depends_on` and `relates_to` onto native Jira issue links.
 *
 * Jira holds native edges, so `depends_on` becomes a `Blocks` link (in the
 * direction Jira expects) and `relates_to` a `Relates` link. This file asserts
 * the story's acceptance criteria offline:
 *
 *   - the `Blocks` direction is right — **inward** (is blocked by) = the
 *     dependency, **outward** = the dependent — asserted on the wire, and
 *     measured against Jira Cloud rather than inferred from the field names,
 *     which invite the opposite arrangement;
 *   - `relates_to` becomes a `Relates` link;
 *   - a link removed on either side syncs (push plans an unlink, the connector
 *     deletes by link id, the pull removes the local edge);
 *   - a link to an issue outside the remote's scope is left alone in both
 *     directions;
 *   - a pulled dependency that would close a cycle is refused with the cycle
 *     named, and the rest of the pull continues.
 *
 * The connector half stubs the global `fetch` (jira.js v6 rides Node's built-in
 * fetch); the planner half drives the real `planPush` / `executePush` /
 * `planPull` against an in-memory connector, exactly like the conformance
 * suite.
 */

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createIssue, loadBoard, type LoadedBoard } from '../src/core/index.js';
import {
  computeBase,
  executePush,
  planPull,
  planPush,
  type BoardFields,
  type BoardFieldsPatch,
  type BoardOp,
  type Connector,
  type LinkKind,
  type LinkStore,
  type OpenedRemote,
  type Provider,
  type RemoteOp,
  type RemoteRecord,
  type RemoteRequest,
  type RemoteSnapshot,
  type Translator,
} from '../src/remote/index.js';
import { jiraConnector } from '../src/remote/providers/jira/connector.js';
import { jiraDependsOnOf, jiraRelatesToOf } from '../src/remote/providers/jira/links.js';
import type { BoardView, Change } from '../src/shared/index.js';
import { toSnapshot } from '../src/sync/index.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterAll(cleanupBoards);
afterEach(() => vi.unstubAllGlobals());

const SITE = 'https://acme.atlassian.net';
const CONNECTION = { site: SITE, project: 'PAY', email: 'me@acme.com', token: 'api-token' };

// ---------------------------------------------------------------------------
// The planner harness (a real board, an in-memory connector)
// ---------------------------------------------------------------------------

function view(board: LoadedBoard): BoardView {
  const snapshot = toSnapshot(board);
  const nodes = Object.fromEntries(
    [...snapshot.issues, ...snapshot.periods, ...snapshot.resources, ...snapshot.templates].map(
      (node) => [node.id, node],
    ),
  );
  return { config: snapshot.config, nodes };
}

function linkStore(): LinkStore {
  return { version: 1, cursor: null, links: new Map(), byRemote: new Map(), tombstones: new Map() };
}

/** A remote snapshot with both native edge kinds, over the given issue records. */
function snapshot(
  issues: Record<string, RemoteRecord> = {},
  opts: { scope?: string; onDelete?: RemoteSnapshot['onDelete'] } = {},
): RemoteSnapshot {
  return {
    direction: 'both',
    issues: new Map(Object.entries(issues)),
    edges: { dependsOn: true, relatesTo: true },
    ...opts,
  };
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

/** A translator that echoes the board fields, for driving `executePush`. */
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

function openedRemote(): OpenedRemote {
  return {
    name: 'jira',
    provider: {
      config: z.object({ connection: z.object({}), mapping: z.object({}) }),
      capabilities: {
        hierarchyDepth: 2,
        nativeTypes: true,
        status: { kind: 'transitions' as const },
        edges: { dependsOn: true, relatesTo: true },
        customFields: null,
        provisioning: { customFields: false, periods: false, labels: false },
        periods: { native: false, creatable: false },
        comments: { native: false, editable: false, deletable: false },
        incrementalRead: { kind: 'none' as const },
        vocabulary: 'fixed',
      },
      translator: echoTranslator,
      connector: () => {
        throw new Error('the executor drives a connector directly');
      },
    } satisfies Provider,
    direction: 'both',
    on_delete: 'unlink',
    conflict: 'manual',
    fields: {},
    encoding: 'block',
    comments: 'push',
    connection: {},
    mapping: {},
  };
}

interface Call {
  method: 'create' | 'update' | 'delete' | 'link' | 'unlink';
  remoteId?: string;
  dependency?: string;
  kind?: LinkKind;
  request?: RemoteRequest;
}

function resultOf(id: string) {
  return { remoteId: id, remoteKey: `mem#${id}`, remoteUrl: `https://mem/${id}`, remoteRev: `rev-${id}` };
}

/** An in-memory connector recording its link/unlink calls with their kind. */
function fakeConnector() {
  const calls: Call[] = [];
  let next = 100;
  const connector: Connector = {
    name: 'memory',
    async create(request: RemoteRequest) {
      calls.push({ method: 'create', request });
      return resultOf(String(next++));
    },
    async update(remoteId: string, request: RemoteRequest) {
      calls.push({ method: 'update', remoteId, request });
      return resultOf(remoteId);
    },
    async delete(remoteId: string) {
      calls.push({ method: 'delete', remoteId });
      return resultOf(remoteId);
    },
    async get() {
      return null;
    },
    async list() {
      return { records: [], cursor: null };
    },
    async link(dependentRemoteId: string, dependencyRemoteId: string, _signal?: AbortSignal, kind?: LinkKind) {
      calls.push({ method: 'link', remoteId: dependentRemoteId, dependency: dependencyRemoteId, kind: kind ?? 'depends' });
      return resultOf(dependentRemoteId);
    },
    async unlink(dependentRemoteId: string, dependencyRemoteId: string, _signal?: AbortSignal, kind?: LinkKind) {
      calls.push({ method: 'unlink', remoteId: dependentRemoteId, dependency: dependencyRemoteId, kind: kind ?? 'depends' });
      return resultOf(dependentRemoteId);
    },
  };
  return { connector, calls };
}

/** A simple pull adapter: recover title/status, read edges from flat arrays. */
const pullDepends = (record: RemoteRecord): string[] =>
  Array.isArray(record['dependsOn'])
    ? record['dependsOn'].filter((id): id is string => typeof id === 'string')
    : [];
const pullRelates = (record: RemoteRecord): string[] =>
  Array.isArray(record['relatesTo'])
    ? record['relatesTo'].filter((id): id is string => typeof id === 'string')
    : [];
const toPatch = (record: RemoteRecord): BoardFieldsPatch => {
  const patch: BoardFieldsPatch = {};
  if (typeof record['title'] === 'string') patch.title = record['title'] as string;
  if (typeof record['status'] === 'string') patch.status = record['status'] as string;
  return patch;
};
const pullOptions = { toPatch, dependsOnOf: pullDepends, relatesToOf: pullRelates };

// ---------------------------------------------------------------------------
// The connector: direction, relates, unlink
// ---------------------------------------------------------------------------

describe('jiraConnector native links (LP-325)', () => {
  it('links depends_on as Blocks with the dependency as the inward (blocks) side', async () => {
    const posts: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST' && url.endsWith('/rest/api/3/issueLink')) {
        posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response('', { status: 201, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const connector = jiraConnector(CONNECTION);
    await connector.link!('10042', '10041');

    expect(posts).toHaveLength(1);
    // `depends_on` → the dependent waits on the dependency, so the dependency
    // **blocks** the dependent. Measured against Jira Cloud, posting
    // `{outwardIssue: A, inwardIssue: B}` records "B blocks A" — the inward
    // issue does the blocking — so the dependency is the inward side.
    expect(posts[0]).toEqual({
      outwardIssue: { id: '10042' },
      inwardIssue: { id: '10041' },
      type: { name: 'Blocks' },
    });
  });

  it('links relates_to as a Relates link', async () => {
    const posts: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST' && url.endsWith('/rest/api/3/issueLink')) {
        posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response('', { status: 201, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const connector = jiraConnector(CONNECTION);
    await connector.link!('10042', '10043', undefined, 'relates');

    expect(posts[0]).toEqual({
      outwardIssue: { id: '10042' },
      inwardIssue: { id: '10043' },
      type: { name: 'Relates' },
    });
  });

  it('unlinks a Blocks link by reading its id and deleting it', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (method === 'GET' && url.includes('/rest/api/3/issue/10042')) {
        return new Response(
          JSON.stringify({
            id: '10042',
            key: 'PAY-42',
            fields: {
              // As Jira really answers: an entry names only the *other* end.
              // Read from the dependent (10042), the dependency (10041) is the
              // `inwardIssue` — "this issue is blocked by that one".
              issuelinks: [
                { id: '9001', type: { name: 'Blocks' }, inwardIssue: { id: '10041' } },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (method === 'DELETE' && url.endsWith('/rest/api/3/issueLink/9001')) {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const connector = jiraConnector(CONNECTION);
    await connector.unlink!('10042', '10041');

    expect(calls).toContain('DELETE https://acme.atlassian.net/rest/api/3/issueLink/9001');
  });

  it('unlinks a Relates link in either orientation, and a missing link is a no-op', async () => {
    const deletes: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('/rest/api/3/issue/10042')) {
        return new Response(
          JSON.stringify({
            id: '10042',
            key: 'PAY-42',
            fields: {
              // Relates is symmetric, so Jira may name the other end under
              // either key depending on which way round it was written.
              issuelinks: [
                { id: '9002', type: { name: 'Relates' }, outwardIssue: { id: '10043' } },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (method === 'DELETE' && url.includes('/rest/api/3/issueLink/')) {
        deletes.push(url);
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const connector = jiraConnector(CONNECTION);
    // Named under `outwardIssue` here, the reverse of how the push wrote it,
    // so the match must accept whichever key holds the other end.
    await connector.unlink!('10042', '10043', undefined, 'relates');
    expect(deletes).toContain('https://acme.atlassian.net/rest/api/3/issueLink/9002');

    // A link that does not exist is already gone — no delete is attempted.
    deletes.length = 0;
    await connector.unlink!('10042', '99999', undefined, 'relates');
    expect(deletes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The read seams
// ---------------------------------------------------------------------------

describe('jiraDependsOnOf / jiraRelatesToOf', () => {
  it('reads depends_on from Blocks links where the record is inward, and relates both ways', () => {
    const record: RemoteRecord = {
      id: '10042',
      key: 'PAY-42',
      fields: {
        // Exactly the shape Jira returns: one entry per edge, naming only the
        // *other* issue. Fixtures that carried both ends were the reason a
        // reader which tested "is this end me?" looked correct and returned
        // nothing at all against a live Jira.
        issuelinks: [
          // "10042 is blocked by 10041" → 10041 is a dependency.
          { type: { name: 'Blocks' }, inwardIssue: { id: '10041' } },
          // "10042 blocks 10043" → 10043 is a dependent, not a dependency.
          { type: { name: 'Blocks' }, outwardIssue: { id: '10043' } },
          // Relates is symmetric: the other end counts from either key.
          { type: { name: 'Relates' }, inwardIssue: { id: '10044' } },
          { type: { name: 'Relates' }, outwardIssue: { id: '10045' } },
        ],
      },
    };

    expect(jiraDependsOnOf(record)).toEqual(['10041']);
    expect(jiraRelatesToOf(record)).toEqual(['10044', '10045']);
  });
});

// ---------------------------------------------------------------------------
// The planner and executor
// ---------------------------------------------------------------------------

describe('native edges through planPush / executePush (LP-325)', () => {
  it('plans and executes a native Relates link for relates_to', async () => {
    const paths = makeBoard('scrum', 'LP');
    const a = createIssue(reload(paths), { type: 'program', title: 'A' });
    createIssue(reload(paths), { type: 'program', title: 'B', relatesTo: [a.id] });
    const board = reload(paths);
    const store = linkStore();

    const plan = planPush(view(board), store, snapshot());
    const relates = plan.ops.filter(
      (op): op is Extract<RemoteOp, { kind: 'link'; linkKind: 'relates' }> =>
        op.kind === 'link' && op.linkKind === 'relates',
    );
    expect(relates).toHaveLength(1);

    const { connector, calls } = fakeConnector();
    const result = await executePush(board, openedRemote(), connector, store, plan.ops);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);

    const linkCalls = calls.filter((call) => call.method === 'link');
    expect(linkCalls).toHaveLength(1);
    expect(linkCalls[0]!.kind).toBe('relates');
  });

  it('plans an unlink for a removed depends_on and a removed relates_to', async () => {
    const paths = makeBoard('scrum', 'LP');
    const a = createIssue(reload(paths), { type: 'program', title: 'A' });
    const b = createIssue(reload(paths), { type: 'program', title: 'B' });
    const board = reload(paths);

    // The base recorded both edges; the board now holds neither.
    const base = computeBase(board.byId.get(b.id)!, new Set(['title', 'body', 'status', 'dependsOn', 'relatesTo']));
    base['dependsOn'] = [a.id];
    base['relatesTo'] = [a.id];
    const store = linkStore();
    store.links.set(a.id, { remoteId: '1', remoteKey: 'mem#1', remoteUrl: '', syncedAt: '', remoteRev: '' });
    store.links.set(b.id, { remoteId: '2', remoteKey: 'mem#2', remoteUrl: '', syncedAt: '', remoteRev: '', base });
    store.byRemote.set('1', a.id);
    store.byRemote.set('2', b.id);

    const plan = planPush(view(board), store, snapshot());
    const unlinks = plan.ops.filter(
      (op): op is Extract<RemoteOp, { kind: 'unlink' }> => op.kind === 'unlink',
    );
    expect(unlinks.map((op) => op.linkKind).sort()).toEqual(['depends', 'relates']);
  });

  it('leaves a link to an issue outside the remote scope alone on push', async () => {
    const paths = makeBoard('scrum', 'LP');
    const outOfScope = createIssue(reload(paths), { type: 'program', title: 'Out of scope' });
    const inScope = createIssue(reload(paths), {
      type: 'program',
      title: 'In scope',
      dependsOn: [outOfScope.id],
      relatesTo: [outOfScope.id],
    });

    const board = reload(paths);
    const store = linkStore();
    // Both have twins, but the scope subtree is the in-scope issue alone.
    store.links.set(inScope.id, { remoteId: '1', remoteKey: 'mem#1', remoteUrl: '', syncedAt: '', remoteRev: '' });
    store.links.set(outOfScope.id, { remoteId: '2', remoteKey: 'mem#2', remoteUrl: '', syncedAt: '', remoteRev: '' });
    store.byRemote.set('1', inScope.id);
    store.byRemote.set('2', outOfScope.id);

    const plan = planPush(view(board), store, snapshot({}, { scope: inScope.id }));
    const links = plan.ops.filter(
      (op): op is Extract<RemoteOp, { kind: 'link' }> => op.kind === 'link',
    );
    expect(links).toEqual([]);
  });

  it('leaves a link to an issue outside the remote scope alone on pull', async () => {
    const paths = makeBoard('scrum', 'LP');
    createIssue(reload(paths), { type: 'program', title: 'In scope' });
    const board = reload(paths);
    const store = linkStore();

    // The remote issue 1 depends on remote issue 2, but 2 has no twin and is
    // not pulled (out of scope) — so the edge is dropped, never a local id.
    const plan = planPull(
      view(board),
      store,
      snapshot({
        '1': { id: '1', title: 'Remote A', dependsOn: ['2'] },
      }),
      pullOptions,
    );
    expect(plan.changes).toHaveLength(1);
    const create = plan.changes[0]!;
    expect(create.kind).toBe('create');
    const createPatch = (create as Extract<Change, { kind: 'create' }>).patch;
    expect(createPatch.dependsOn).toBeUndefined();
    expect(plan.edgeWarnings).toBeUndefined();
  });

  it('refuses a pulled dependency that would close a cycle, naming it, and continues', async () => {
    const paths = makeBoard('scrum', 'LP');
    createIssue(reload(paths), { type: 'program', title: 'Existing' });
    const board = reload(paths);
    const existing = board.issues[0]!;
    const store = linkStore();
    store.links.set(existing.id, { remoteId: '1', remoteKey: 'mem#1', remoteUrl: '', syncedAt: '', remoteRev: '' });
    store.byRemote.set('1', existing.id);

    // Remote issue 2 depends on remote issue 1 (existing), and remote issue 1
    // depends on remote issue 2 — a two-cycle. The pull must refuse one edge,
    // name the cycle, and still file both documents.
    const plan = planPull(
      view(board),
      store,
      snapshot({
        '1': { id: '1', title: 'Existing', dependsOn: ['2'] },
        '2': { id: '2', title: 'Remote B', dependsOn: ['1'] },
      }),
      pullOptions,
    );

    expect(plan.changes).toHaveLength(1); // only issue 2 is new
    expect(plan.edgeWarnings).toHaveLength(1);
    expect(plan.edgeWarnings![0]!.kind).toBe('cycle');
    expect(plan.edgeWarnings![0]!.field).toBe('depends_on');
    // The cycle is named member → member → member.
    expect(plan.edgeWarnings![0]!.cycle).toContain(' -> ');
  });

  it('pulls a remote edge removal onto the board', async () => {
    const paths = makeBoard('scrum', 'LP');
    const a = createIssue(reload(paths), { type: 'program', title: 'A' });
    const b = createIssue(reload(paths), { type: 'program', title: 'B', dependsOn: [a.id], relatesTo: [a.id] });
    const board = reload(paths);
    const store = linkStore();
    const base = computeBase(board.byId.get(b.id)!, new Set(['title', 'body', 'status', 'dependsOn', 'relatesTo']));
    base['dependsOn'] = [a.id];
    base['relatesTo'] = [a.id];
    store.links.set(a.id, { remoteId: '1', remoteKey: 'mem#1', remoteUrl: '', syncedAt: '', remoteRev: '' });
    store.links.set(b.id, { remoteId: '2', remoteKey: 'mem#2', remoteUrl: '', syncedAt: '', remoteRev: '', base });
    store.byRemote.set('1', a.id);
    store.byRemote.set('2', b.id);

    // The remote no longer holds either edge.
    const plan = planPull(
      view(board),
      store,
      snapshot({
        '1': { id: '1', title: 'A' },
        '2': { id: '2', title: 'B' },
      }),
      pullOptions,
    );

    const update = plan.changes.find((change) => change.kind === 'update' && change.id === b.id) as
      | Extract<Change, { kind: 'update' }>
      | undefined;
    expect(update).toBeDefined();
    expect(update!.patch.dependsOn).toEqual([]);
    expect(update!.patch.relatesTo).toEqual([]);
  });
});
