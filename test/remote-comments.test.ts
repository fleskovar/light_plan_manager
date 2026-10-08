import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  addComment,
  createIssue,
  listComments,
  type LoadedBoard,
} from '../src/core/index.js';
import {
  planCommentPull,
  planCommentPush,
  renderCommentForRemote,
} from '../src/remote/comments.js';
import {
  getSyncedCommentIndexes,
  getSyncedRemoteCommentIds,
  loadLinkStore,
  saveLinkStore,
  setCommentId,
  type LinkEntry,
  type LinkStore,
} from '../src/remote/links.js';
import {
  emptyCapabilities,
  executePush,
  type Connector,
  type OpenedRemote,
  type Provider,
  type RemoteRequest,
  type Translator,
} from '../src/remote/index.js';
import { MANAGED_BLOCK_BEGIN, MANAGED_BLOCK_END } from '../src/remote/managed-block.js';
import { planPull, planPush, type RemoteOp, type RemoteSnapshot } from '../src/remote/plan.js';
import { applyPull } from '../src/remote/pull.js';
import type { BoardFieldsPatch } from '../src/remote/provider.js';
import type { BoardView } from '../src/shared/index.js';
import { toSnapshot } from '../src/sync/index.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterAll(cleanupBoards);

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

function linkStore(entries: Record<string, LinkEntry> = {}): LinkStore {
  const links = new Map(Object.entries(entries));
  const byRemote = new Map<string, string>();
  for (const [localId, entry] of links) byRemote.set(entry.remoteId, localId);
  return { version: 1, cursor: null, links, byRemote, tombstones: new Map() };
}

function twin(remoteId: string, extra: Partial<LinkEntry> = {}): LinkEntry {
  return {
    remoteId,
    remoteKey: `acme/payments#${remoteId}`,
    remoteUrl: `https://github.com/acme/payments/issues/${remoteId}`,
    syncedAt: '2026-09-04T11:19:58Z',
    remoteRev: '2026-09-04T11:19:57Z',
    ...extra,
  };
}

function snapshot(
  direction: RemoteSnapshot['direction'] = 'both',
  extra: Partial<RemoteSnapshot> = {},
): RemoteSnapshot {
  return { direction, issues: new Map(), ...extra };
}

const COMMENT = (body: string): string =>
  `${MANAGED_BLOCK_BEGIN}\n| name | value |\n| --- | --- |\n${MANAGED_BLOCK_END}\n${body}`;

// ---------------------------------------------------------------------------
// The pure planners
// ---------------------------------------------------------------------------

describe('renderCommentForRemote', () => {
  it('names the local author in the posted body', () => {
    expect(renderCommentForRemote('Ada', 'Started on the schema.')).toBe(
      '**Ada** (light-plan)\n\nStarted on the schema.',
    );
  });
});

describe('planCommentPush', () => {
  it('posts only the entries whose index is not already recorded', () => {
    const local = [
      { index: 1, at: '2026-09-01T00:00:00Z', author: 'Ada', body: 'first' },
      { index: 2, at: '2026-09-02T00:00:00Z', author: 'Bob', body: 'second' },
      { index: 3, at: '2026-09-03T00:00:00Z', author: 'Cid', body: 'third' },
    ];
    expect(planCommentPush(local, new Set([2])).map((item) => item.index)).toEqual([1, 3]);
  });

  it('excludes the managed comment by body, never posted as a user comment', () => {
    const local = [
      { index: 1, at: '2026-09-01T00:00:00Z', author: 'Ada', body: 'a human note' },
      { index: 2, at: '2026-09-02T00:00:00Z', author: 'Ada', body: COMMENT('managed') },
    ];
    expect(planCommentPush(local, new Set()).map((item) => item.index)).toEqual([1]);
  });
});

describe('planCommentPull', () => {
  const remote = [
    { id: 'c1', author: 'bob', createdAt: '2026-09-01T00:00:00Z', body: 'one' },
    { id: 'c2', author: 'cid', createdAt: '2026-09-02T00:00:00Z', body: 'two' },
    { id: 'c3', author: 'ada', createdAt: '2026-09-03T00:00:00Z', body: COMMENT('managed') },
  ];

  it('appends only the ids not already recorded', () => {
    const out = planCommentPull(remote, new Set(['c2']), () => false);
    expect(out.map((c) => c.id)).toEqual(['c1', 'c3']);
  });

  it('excludes the managed comment through the caller predicate', () => {
    const out = planCommentPull(remote, new Set(), (id) => id === 'c3');
    expect(out.map((c) => c.id)).toEqual(['c1', 'c2']);
  });
});

// ---------------------------------------------------------------------------
// The link store
// ---------------------------------------------------------------------------

describe('link store comment ids', () => {
  it('round-trips the recorded mapping and reads it both ways', () => {
    const paths = makeBoard('scrum', 'LP');
    createIssue(reload(paths), { type: 'program', title: 'Programme' });
    const store = linkStore({ 'LP-1': twin('900') });
    setCommentId(store, 'LP-1', 1, 'c1');
    setCommentId(store, 'LP-1', 2, 'c2');

    expect(getSyncedCommentIndexes(store, 'LP-1')).toEqual(new Set([1, 2]));
    expect(getSyncedRemoteCommentIds(store, 'LP-1')).toEqual(new Set(['c1', 'c2']));
    expect(getSyncedCommentIndexes(store, 'LP-2')).toEqual(new Set());

    // A real save/load keeps the mapping (and validates it on the way in).
    saveLinkStore(paths, 'test', store);
    const reloaded = loadLinkStore(paths, 'test');
    expect(reloaded.links.get('LP-1')?.commentIds).toEqual({ '1': 'c1', '2': 'c2' });
    expect(getSyncedCommentIndexes(reloaded, 'LP-1')).toEqual(new Set([1, 2]));
  });
});

// ---------------------------------------------------------------------------
// planPush — emitting comment ops
// ---------------------------------------------------------------------------

describe('planPush — user comments (LP-316)', () => {
  it('emits a comment op for an unsynced entry, rendered with the author named', () => {
    const paths = makeBoard('scrum', 'LP');
    const programme = createIssue(reload(paths), { type: 'program', title: 'Programme' });
    addComment(reload(paths), programme.id, { body: 'Started.', author: 'Ada' });

    const store = linkStore({ [programme.id]: twin('900') });
    const local = listComments(reload(paths), programme.id);

    const ops = planPush(view(reload(paths)), store, snapshot(), new Map([[programme.id, local]])).ops;
    const comments = ops.filter((op): op is Extract<RemoteOp, { kind: 'comment' }> => op.kind === 'comment');

    expect(comments).toHaveLength(1);
    expect(comments[0]!.ref).toEqual({ kind: 'linked', localId: programme.id, remoteId: '900' });
    expect(comments[0]!.index).toBe(1);
    expect(comments[0]!.body).toBe('**Ada** (light-plan)\n\nStarted.');
  });

  it('emits no comment op for an entry already recorded in the link store', () => {
    const paths = makeBoard('scrum', 'LP');
    const programme = createIssue(reload(paths), { type: 'program', title: 'Programme' });
    addComment(reload(paths), programme.id, { body: 'Started.', author: 'Ada' });

    const store = linkStore({ [programme.id]: twin('900', { commentIds: { '1': 'c1' } }) });
    const local = listComments(reload(paths), programme.id);

    const ops = planPush(view(reload(paths)), store, snapshot(), new Map([[programme.id, local]])).ops;
    expect(ops.filter((op) => op.kind === 'comment')).toHaveLength(0);
  });

  it('emits a comment op against the create placeholder for a brand-new document', () => {
    const paths = makeBoard('scrum', 'LP');
    const programme = createIssue(reload(paths), { type: 'program', title: 'Programme' });
    addComment(reload(paths), programme.id, { body: 'Started.', author: 'Ada' });

    const local = listComments(reload(paths), programme.id);
    const ops = planPush(
      view(reload(paths)),
      linkStore({}),
      snapshot(),
      new Map([[programme.id, local]]),
    ).ops;

    const comment = ops.find((op): op is Extract<RemoteOp, { kind: 'comment' }> => op.kind === 'comment')!;
    expect(comment.ref.kind).toBe('created');
    expect(comment.ref.localId).toBe(programme.id);
  });
});

// ---------------------------------------------------------------------------
// planPull — emitting comment append ops
// ---------------------------------------------------------------------------

const toPatchEmpty = (): BoardFieldsPatch => ({});

describe('planPull — user comments (LP-316)', () => {
  it('appends remote comments for a twin when commentsMode is both', () => {
    const paths = makeBoard('scrum', 'LP');
    const programme = createIssue(reload(paths), { type: 'program', title: 'Programme' });
    const store = linkStore({ [programme.id]: twin('900') });

    const remote = snapshot('both', {
      commentsMode: 'both',
      remoteComments: new Map([
        ['900', [{ id: 'c1', author: 'bob', createdAt: '2026-09-01T00:00:00Z', body: 'remote note' }]],
      ]),
      issues: new Map([['900', {}]]),
    });

    const plan = planPull(view(reload(paths)), store, remote, { toPatch: toPatchEmpty });
    expect(plan.comments).toEqual([
      {
        kind: 'append',
        targetId: programme.id,
        remoteId: 'c1',
        author: 'bob',
        at: '2026-09-01T00:00:00Z',
        body: 'remote note',
      },
    ]);
  });

  it('appends nothing when commentsMode is absent (the push default)', () => {
    const paths = makeBoard('scrum', 'LP');
    const programme = createIssue(reload(paths), { type: 'program', title: 'Programme' });
    const store = linkStore({ [programme.id]: twin('900') });

    const remote = snapshot('both', {
      remoteComments: new Map([
        ['900', [{ id: 'c1', author: 'bob', createdAt: '2026-09-01T00:00:00Z', body: 'note' }]],
      ]),
      issues: new Map([['900', {}]]),
    });

    const plan = planPull(view(reload(paths)), store, remote, { toPatch: toPatchEmpty });
    expect(plan.comments).toBeUndefined();
  });

  it('skips an already-synced id and the managed comment, and points new issues at their temp id', () => {
    const paths = makeBoard('scrum', 'LP');
    const programme = createIssue(reload(paths), { type: 'program', title: 'Programme' });
    // Linked twin with one comment already synced, and the managed comment id recorded.
    const store = linkStore({
      [programme.id]: twin('900', { commentIds: { '1': 'c1' }, managedCommentId: 'IC_900' }),
    });

    const remote = snapshot('both', {
      commentsMode: 'both',
      remoteComments: new Map([
        [
          '900',
          [
            { id: 'c1', author: 'bob', createdAt: '2026-09-01T00:00:00Z', body: 'already synced' },
            { id: 'c2', author: 'cid', createdAt: '2026-09-02T00:00:00Z', body: 'new remote note' },
            { id: 'IC_900', author: 'ada', createdAt: '2026-09-03T00:00:00Z', body: COMMENT('managed') },
          ],
        ],
        // A brand-new remote issue with its own comments, referenced by temp id.
        ['901', [{ id: 'c3', author: 'dan', createdAt: '2026-09-04T00:00:00Z', body: 'new issue note' }]],
      ]),
      issues: new Map([['900', {}], ['901', {}]]),
    });

    const plan = planPull(view(reload(paths)), store, remote, { toPatch: toPatchEmpty });
    // New issues are planned first (by remote id), then existing twins.
    expect(plan.comments?.map((op) => op.remoteId)).toEqual(['c3', 'c2']);
    expect(plan.comments?.map((op) => op.targetId)).toEqual([
      plan.comments![0]!.targetId,
      programme.id,
    ]);
    // The new-issue op references a temporary id, not a real one.
    expect(plan.comments![0]!.targetId.startsWith('new:')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// executePush — posting and recording
// ---------------------------------------------------------------------------

function echoTranslator(): Translator {
  return {
    describeRequest(op) {
      if (op.kind === 'delete') {
        return { request: { kind: 'delete' }, problems: [], resourceGaps: [], periodGaps: [] };
      }
      return {
        request: { kind: op.kind, title: op.fields.title, body: op.fields.body, state: op.fields.status },
        problems: [],
        resourceGaps: [],
        periodGaps: [],
      };
    },
    fieldsFromRecord() {
      return { patch: {}, problems: [], unknownAccounts: [] };
    },
  };
}

function openedRemote(): OpenedRemote {
  const provider: Provider = {
    config: z.object({ connection: z.object({}), mapping: z.object({}) }),
    capabilities: emptyCapabilities(),
    translator: echoTranslator(),
    connector: () => {
      throw new Error('the executor drives a connector directly');
    },
  };
  return {
    name: 'test',
    provider,
    scope: undefined,
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

describe('executePush — posting comments (LP-316)', () => {
  it('posts the comment and records the remote id against the local index', async () => {
    const paths = makeBoard('scrum', 'LP');
    const programme = createIssue(reload(paths), { type: 'program', title: 'Programme' });
    const store = linkStore({ [programme.id]: twin('900') });

    const calls: Array<{ method: string; remoteId?: string; body?: string }> = [];
    const connector: Connector = {
      name: 'memory',
      async create() {
        throw new Error('unused');
      },
      async update(remoteId: string) {
        return { remoteId, remoteKey: remoteId, remoteUrl: '', remoteRev: 'r' };
      },
      async delete() {
        throw new Error('unused');
      },
      async get() {
        return null;
      },
      async list() {
        return { records: [], cursor: null };
      },
      async comment(remoteId: string, body: string) {
        calls.push({ method: 'comment', remoteId, body });
        return { remoteId, remoteKey: remoteId, remoteUrl: '', remoteRev: 'r', commentId: 'c42' };
      },
    };

    const plan: RemoteOp[] = [
      {
        kind: 'comment',
        ref: { kind: 'linked', localId: programme.id, remoteId: '900' },
        index: 1,
        author: 'Ada',
        body: '**Ada** (light-plan)\n\nStarted.',
      },
    ];

    const result = await executePush(reload(paths), openedRemote(), connector, store, plan);

    expect(result.landed.map((op) => op.kind)).toEqual(['comment']);
    expect(calls).toEqual([{ method: 'comment', remoteId: '900', body: '**Ada** (light-plan)\n\nStarted.' }]);
    expect(store.links.get(programme.id)?.commentIds).toEqual({ '1': 'c42' });
  });

  it('skips a comment whose create did not land', async () => {
    const paths = makeBoard('scrum', 'LP');
    const programme = createIssue(reload(paths), { type: 'program', title: 'Programme' });
    const store = linkStore({});

    const connector: Connector = {
      name: 'memory',
      async create() {
        throw new Error('unused');
      },
      async update(remoteId: string) {
        return { remoteId, remoteKey: remoteId, remoteUrl: '', remoteRev: 'r' };
      },
      async delete() {
        throw new Error('unused');
      },
      async get() {
        return null;
      },
      async list() {
        return { records: [], cursor: null };
      },
      async comment() {
        throw new Error('must not be called');
      },
    };

    const plan: RemoteOp[] = [
      {
        kind: 'comment',
        ref: { kind: 'created', localId: programme.id, placeholder: 'new:1' },
        index: 1,
        author: 'Ada',
        body: 'body',
      },
    ];

    const result = await executePush(reload(paths), openedRemote(), connector, store, plan);
    expect(result.skipped).toEqual([
      { kind: 'comment', localId: programme.id, status: 'skipped', reason: 'the twin was not created' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// applyPull — appending and recording
// ---------------------------------------------------------------------------

describe('applyPull — appending comments (LP-316)', () => {
  it('appends the remote comment to _comments.md and records its id', () => {
    const paths = makeBoard('scrum', 'LP');
    const programme = createIssue(reload(paths), { type: 'program', title: 'Programme' });
    const store = linkStore({ [programme.id]: twin('900') });

    applyPull(paths, 'test', store, {
      changes: [],
      links: [],
      comments: [
        {
          kind: 'append',
          targetId: programme.id,
          remoteId: 'c1',
          author: 'bob',
          at: '2026-09-01T00:00:00Z',
          body: 'remote note',
        },
      ],
    });

    const local = listComments(reload(paths), programme.id);
    expect(local).toHaveLength(1);
    expect(local[0]).toMatchObject({ index: 1, author: 'bob', body: 'remote note' });
    expect(store.links.get(programme.id)?.commentIds).toEqual({ '1': 'c1' });

    // A re-pull plans nothing for the same remote comment: the planner reads
    // the recorded id and skips it, so the log never duplicates on re-pull.
    const again = planPull(
      view(reload(paths)),
      store,
      snapshot('both', {
        commentsMode: 'both',
        remoteComments: new Map([
          ['900', [{ id: 'c1', author: 'bob', createdAt: '2026-09-01T00:00:00Z', body: 'remote note' }]],
        ]),
        issues: new Map([['900', {}]]),
      }),
      { toPatch: toPatchEmpty },
    );
    expect(again.comments).toBeUndefined();
    expect(listComments(reload(paths), programme.id)).toHaveLength(1);
  });
});
