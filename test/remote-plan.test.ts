import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createIssue, type LoadedBoard } from '../src/core/index.js';
import { computeBase, hashBody, loadLinkStore, type LinkEntry, type LinkStore, type Tombstone } from '../src/remote/links.js';
import {
  emptyCapabilities,
  executePush,
  type Connector,
  type OpenedRemote,
  type Provider,
  type RemoteRequest,
  type Translator,
} from '../src/remote/index.js';
import { planPull, planPush, type PullPlan, type PushPlan, type RemoteOp, type RemoteSnapshot } from '../src/remote/plan.js';
import type { BoardFieldsPatch, RemoteRecord } from '../src/remote/provider.js';
import { applyPull } from '../src/remote/pull.js';
import { mergeLists } from '../src/remote/merge.js';
import type { BoardView, Change } from '../src/shared/index.js';
import { applyChanges } from '../src/sync/apply.js';
import { toSnapshot } from '../src/sync/index.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterAll(cleanupBoards);

/**
 * LP-280 — `planPush` computes the push as an ordered `RemoteOp[]` and makes no
 * request. Built against a real board (`makeBoard`) and an in-memory link store
 * and snapshot — no fixtures, no network.
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

function twin(remoteId: string, base?: Record<string, unknown>): LinkEntry {
  return {
    remoteId,
    remoteKey: `acme/payments#${remoteId}`,
    remoteUrl: `https://github.com/acme/payments/issues/${remoteId}`,
    syncedAt: '2026-09-04T11:19:58Z',
    remoteRev: '2026-09-04T11:19:57Z',
    ...(base ? { base } : {}),
  };
}

function snapshot(direction: RemoteSnapshot['direction'] = 'both', scope?: string): RemoteSnapshot {
  return { direction, issues: new Map(), ...(scope ? { scope } : {}) };
}

function creates(ops: RemoteOp[]): Extract<RemoteOp, { kind: 'create' }>[] {
  return ops.filter((op): op is Extract<RemoteOp, { kind: 'create' }> => op.kind === 'create');
}

/** The base snapshot `computeBase` records for a document, over the mirrored fields. */
function baseOf(board: LoadedBoard, id: string): Record<string, unknown> {
  const doc = toSnapshot(board).issues.find((issue) => issue.id === id)!;
  return computeBase(
    doc,
    new Set(['title', 'body', 'status', 'assignee', 'period', 'dependsOn']),
  );
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

describe('planPush', () => {
  it('plans a new subtree with parents before children and edges after both endpoints', () => {
    const { paths, programme, epic, feature, story } = featureWithStory();

    const ops = planPush(view(reload(paths)), linkStore({}), snapshot()).ops;

    // Parents before children: programme, epic, feature, story.
    expect(creates(ops).map((op) => op.localId)).toEqual([
      programme.id,
      epic.id,
      feature.id,
      story.id,
    ]);

    const epicCreate = creates(ops).find((op) => op.localId === epic.id)!;
    const featureCreate = creates(ops).find((op) => op.localId === feature.id)!;
    const storyCreate = creates(ops).find((op) => op.localId === story.id)!;

    // A create's parent is the parent's own placeholder.
    expect(featureCreate.parent).toEqual({
      kind: 'created',
      localId: epic.id,
      placeholder: epicCreate.placeholder,
    });
    expect(storyCreate.parent).toEqual({
      kind: 'created',
      localId: feature.id,
      placeholder: featureCreate.placeholder,
    });

    // The edge sits after every create and points at the feature's placeholder.
    const link = ops.find((op): op is Extract<RemoteOp, { kind: 'link' }> => op.kind === 'link')!;
    expect(ops.indexOf(link)).toBeGreaterThan(ops.indexOf(storyCreate));
    expect(link.dependent).toEqual({
      kind: 'created',
      localId: story.id,
      placeholder: storyCreate.placeholder,
    });
    expect(link.dependency).toEqual({
      kind: 'created',
      localId: feature.id,
      placeholder: featureCreate.placeholder,
    });
  });

  it('references a same-push create by placeholder when another issue depends on it', () => {
    const { paths, feature } = featureWithStory();

    const ops = planPush(view(reload(paths)), linkStore({}), snapshot()).ops;

    const featureCreate = creates(ops).find((op) => op.localId === feature.id)!;
    const links = ops.filter((op): op is Extract<RemoteOp, { kind: 'link' }> => op.kind === 'link');
    expect(links).toHaveLength(1);
    expect(links[0]!.dependency).toEqual({
      kind: 'created',
      localId: feature.id,
      placeholder: featureCreate.placeholder,
    });
  });

  it('plans nothing when every linked document matches its base snapshot', () => {
    const paths = makeBoard('scrum', 'LP');
    const programme = createIssue(reload(paths), { type: 'program', title: 'Programme' });
    const epic = createIssue(reload(paths), { type: 'epic', title: 'Epic', parentId: programme.id });

    const board = reload(paths);
    const store = linkStore({
      [programme.id]: twin('418', baseOf(board, programme.id)),
      [epic.id]: twin('419', baseOf(board, epic.id)),
    });

    expect(planPush(view(board), store, snapshot())).toEqual({ ops: [], skipped: [] });
  });

  it('plans a transition for a non-terminal status change and a close for a terminal one', () => {
    const paths = makeBoard('scrum', 'LP');
    const programme = createIssue(reload(paths), { type: 'program', title: 'Programme' });
    const epic = createIssue(reload(paths), { type: 'epic', title: 'Epic', parentId: programme.id });
    const feature = createIssue(reload(paths), { type: 'feature', title: 'Feature', parentId: epic.id });
    const moving = createIssue(reload(paths), {
      type: 'user_story',
      title: 'Moving',
      parentId: feature.id,
      status: 'in_progress',
    });
    const finished = createIssue(reload(paths), {
      type: 'user_story',
      title: 'Finished',
      parentId: feature.id,
      status: 'done',
    });

    const board = reload(paths);
    const store = linkStore({
      [moving.id]: twin('420', { ...baseOf(board, moving.id), status: 'backlog' }),
      [finished.id]: twin('421', { ...baseOf(board, finished.id), status: 'backlog' }),
    });

    const ops = planPush(view(board), store, snapshot()).ops;
    expect(
      ops.find((op) => op.kind === 'transition' && op.localId === moving.id),
    ).toBeDefined();
    expect(
      ops.find((op) => op.kind === 'close' && op.localId === finished.id),
    ).toBeDefined();
  });

  it('contributes nothing for a pull-only remote, and nothing outside scope', () => {
    const paths = makeBoard('scrum', 'LP');
    const programme = createIssue(reload(paths), { type: 'program', title: 'Programme' });
    const epic = createIssue(reload(paths), { type: 'epic', title: 'Epic', parentId: programme.id });

    const board = reload(paths);
    expect(planPush(view(board), linkStore({}), snapshot('pull'))).toEqual({ ops: [], skipped: [] });

    // Scope = the epic only; the programme is outside it and contributes nothing.
    const ops = planPush(view(board), linkStore({}), snapshot('both', epic.id)).ops;
    expect(creates(ops).map((op) => op.localId)).toEqual([epic.id]);
  });

  it('emits an unlink when a dependency is removed locally', () => {
    const paths = makeBoard('scrum', 'LP');
    const programme = createIssue(reload(paths), { type: 'program', title: 'Programme' });
    const epic = createIssue(reload(paths), { type: 'epic', title: 'Epic', parentId: programme.id });
    const feature = createIssue(reload(paths), { type: 'feature', title: 'Feature', parentId: epic.id });
    const story = createIssue(reload(paths), {
      type: 'user_story',
      title: 'Story',
      parentId: feature.id,
    });

    // The base recorded the dependency; the board no longer has it.
    const board = reload(paths);
    const store = linkStore({
      [feature.id]: twin('421', baseOf(board, feature.id)),
      [story.id]: twin('422', { ...baseOf(board, story.id), dependsOn: [feature.id] }),
    });

    const ops = planPush(view(board), store, snapshot()).ops;
    const unlink = ops.find(
      (op): op is Extract<RemoteOp, { kind: 'unlink' }> => op.kind === 'unlink',
    );
    expect(unlink).toBeDefined();
    expect(unlink!.dependency).toEqual({
      kind: 'linked',
      localId: feature.id,
      remoteId: '421',
    });
  });
});

// ---------------------------------------------------------------------------
// LP-366 — decoupled documents: skipped, never created; out-of-scope decoupled
// ---------------------------------------------------------------------------

describe('planPush — decoupled documents (LP-366)', () => {
  const tombstone: Tombstone = { remoteKey: 'acme/payments#9', reason: 'manual', at: '2026-09-05T00:00:00Z' };

  function linkStoreWithTombstone(entries: Record<string, LinkEntry>, tombstones: Record<string, Tombstone>): LinkStore {
    const store = linkStore(entries);
    for (const [id, t] of Object.entries(tombstones)) store.tombstones.set(id, t);
    return store;
  }

  it('a decoupled in-scope document is skipped, never created, and reported', () => {
    const { paths, programme, epic, feature, story } = featureWithStory();
    const store = linkStoreWithTombstone({}, { [story.id]: tombstone });

    const plan: PushPlan = planPush(view(reload(paths)), store, snapshot());

    // The tombstoned story is not created; its three ancestors are.
    expect(creates(plan.ops).map((op) => op.localId)).toEqual([
      programme.id,
      epic.id,
      feature.id,
    ]);
    // …and it is listed as skipped, not silently omitted.
    expect(plan.skipped).toEqual([
      { localId: story.id, reason: 'manual', remoteKey: 'acme/payments#9' },
    ]);
  });

  it('a pull-only remote reports an empty plan and nothing skipped', () => {
    const { paths, story } = featureWithStory();
    const store = linkStoreWithTombstone({}, { [story.id]: tombstone });

    expect(planPush(view(reload(paths)), store, snapshot('pull'))).toEqual({
      ops: [],
      skipped: [],
    });
  });

  it('a linked document that left the scope subtree is decoupled with reason out_of_scope', () => {
    const { paths, epic, feature, story } = featureWithStory();
    // The epic is linked but the scope names only the feature — the epic has
    // moved out of scope, so its twin must be left alone and a tombstone written.
    const board = reload(paths);
    const store = linkStore({ [epic.id]: twin('422') });

    const plan = planPush(view(board), store, snapshot('both', feature.id));

    const decouple = plan.ops.find(
      (op): op is Extract<RemoteOp, { kind: 'decouple' }> => op.kind === 'decouple',
    );
    expect(decouple).toEqual({ kind: 'decouple', localId: epic.id, reason: 'out_of_scope' });
    // No create is planned for the epic — its twin is left alone.
    expect(creates(plan.ops).map((op) => op.localId)).not.toContain(epic.id);
    // The in-scope work is still planned as before.
    expect(creates(plan.ops).map((op) => op.localId)).toEqual([feature.id, story.id]);
    expect(plan.skipped).toEqual([]);
  });

  it('an out-of-scope document with no link is not decoupled (nothing to drop)', () => {
    const { paths, feature } = featureWithStory();
    const plan = planPush(view(reload(paths)), linkStore({}), snapshot('both', feature.id));

    expect(plan.ops.filter((op) => op.kind === 'decouple')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// LP-351 — push-side on_delete: a local document went away
// ---------------------------------------------------------------------------

describe('planPush — on_delete for a gone local document (LP-351)', () => {
  const goneId = 'LP-404'; // linked, but no document exists on the board

  function goneStore(remoteId = '422'): LinkStore {
    return linkStore({ [goneId]: twin(remoteId) });
  }

  it('unlink (the default) leaves the twin alone and drops the dangling link', () => {
    const { paths } = featureWithStory();
    const plan = planPush(view(reload(paths)), goneStore(), snapshot());

    expect(plan.ops.find((op) => op.kind === 'unlinkLocal')).toEqual({
      kind: 'unlinkLocal',
      localId: goneId,
    });
    // The remote is never touched: no close, no delete.
    expect(plan.ops.some((op) => op.kind === 'close' || op.kind === 'delete')).toBe(false);
  });

  it('close closes the twin and posts a note saying why', () => {
    const { paths } = featureWithStory();
    const plan = planPush(view(reload(paths)), goneStore(), { ...snapshot(), onDelete: 'close' });

    const closeOp = plan.ops.find(
      (op): op is Extract<RemoteOp, { kind: 'close' }> => op.kind === 'close',
    );
    expect(closeOp).toMatchObject({
      kind: 'close',
      localId: goneId,
      ref: { kind: 'linked', localId: goneId, remoteId: '422' },
    });
    expect(closeOp!.note).toContain('deleted');
  });

  it('delete emits a delete op', () => {
    const { paths } = featureWithStory();
    const plan = planPush(view(reload(paths)), goneStore(), { ...snapshot(), onDelete: 'delete' });

    expect(
      plan.ops.find((op): op is Extract<RemoteOp, { kind: 'delete' }> => op.kind === 'delete'),
    ).toEqual({
      kind: 'delete',
      localId: goneId,
      ref: { kind: 'linked', localId: goneId, remoteId: '422' },
    });
  });

  it('restore and manual (pull-only values) fall back to unlink, never delete or close', () => {
    const { paths } = featureWithStory();
    for (const onDelete of ['restore', 'manual'] as const) {
      const plan = planPush(view(reload(paths)), goneStore(), { ...snapshot(), onDelete });
      expect(plan.ops.some((op) => op.kind === 'delete' || op.kind === 'close')).toBe(false);
      expect(plan.ops.find((op) => op.kind === 'unlinkLocal')).toEqual({
        kind: 'unlinkLocal',
        localId: goneId,
      });
    }
  });

  it('an out-of-scope document applies the same policy (close)', () => {
    const { paths, epic, feature } = featureWithStory();
    const board = reload(paths);
    const store = linkStore({ [epic.id]: twin('422') });

    const plan = planPush(view(board), store, { ...snapshot('both', feature.id), onDelete: 'close' });

    const closeOp = plan.ops.find(
      (op): op is Extract<RemoteOp, { kind: 'close' }> => op.kind === 'close',
    );
    expect(closeOp).toMatchObject({ kind: 'close', localId: epic.id });
    expect(closeOp!.note).toContain('scope');
  });
});
// ---------------------------------------------------------------------------
// LP-281 — planPull / applyPull
// ---------------------------------------------------------------------------

/** A minimal pull translation: the record's own fields become the patch. */
function pullPatch(record: RemoteRecord, _depth: number): BoardFieldsPatch {
  const patch: BoardFieldsPatch = {};
  if (typeof record.type === 'string') patch.type = record.type;
  if (typeof record.title === 'string') patch.title = record.title;
  if (typeof record.body === 'string') patch.body = record.body;
  if (typeof record.status === 'string') patch.status = record.status;
  return patch;
}

/** The remote parent of a record, for tests that exercise hierarchy. */
function pullParent(record: RemoteRecord): string | undefined {
  return typeof record.parent === 'string' ? record.parent : undefined;
}

/** The remote dependencies of a record, for tests that exercise edges. */
function pullDepends(record: RemoteRecord): string[] {
  return Array.isArray(record.dependsOn)
    ? record.dependsOn.filter((id): id is string => typeof id === 'string')
    : [];
}

/** A pull snapshot over an in-memory remote. */
function pullSnapshot(
  issues: Record<string, RemoteRecord>,
  direction: RemoteSnapshot['direction'] = 'both',
  opts: { scope?: string; onDelete?: RemoteSnapshot['onDelete']; unreachable?: boolean } = {},
): RemoteSnapshot {
  return {
    direction,
    issues: new Map(Object.entries(issues)),
    ...(opts.scope ? { scope: opts.scope } : {}),
    ...(opts.onDelete ? { onDelete: opts.onDelete } : {}),
    ...(opts.unreachable ? { unreachable: true } : {}),
  };
}

function createsOf(plan: PullPlan): Extract<Change, { kind: 'create' }>[] {
  return plan.changes.filter(
    (change): change is Extract<Change, { kind: 'create' }> => change.kind === 'create',
  );
}

describe('planPull', () => {
  it('plans a create per remote issue with no twin, temp ids from a counter, no disk writes', () => {
    const paths = makeBoard('scrum', 'LP');
    const board = reload(paths);

    const remote = pullSnapshot({
      '101': { type: 'program', title: 'Remote programme', body: 'body', status: 'backlog' },
    });

    const plan = planPull(view(board), linkStore({}), remote, { toPatch: pullPatch });

    expect(plan.changes).toHaveLength(1);
    const create = createsOf(plan)[0]!;
    expect(create.id).toBe('new:1'); // from a fresh counter, never a pending list
    expect(create.nodeKind).toBe('issue');
    expect(create.patch).toEqual({
      type: 'program',
      title: 'Remote programme',
      body: 'body',
      status: 'backlog',
      // Stated even when the tracker has none, so the board's catch-all
      // period can never claim an issue the tracker holds unscheduled.
      period: null,
    });
    expect(plan.links).toEqual([{ kind: 'record', tempId: 'new:1', remoteId: '101' }]);

    // Pure: the board on disk is untouched until applyPull runs.
    expect(reload(paths).issues).toHaveLength(0);
  });

  it('defaults a record with no type to the deepest declared type (LP-315)', () => {
    const paths = makeBoard('scrum', 'LP');
    const board = reload(paths);

    // A remote issue with no mapped label and no type: `pullPatch` recovers
    // nothing, so the create falls back to the deepest declared issue type.
    const remote = pullSnapshot({
      '101': { title: 'Triaged upstream, no label' },
    });

    const plan = planPull(view(board), linkStore({}), remote, { toPatch: pullPatch });

    const create = createsOf(plan)[0]!;
    expect(create.patch.type).toBe('sub_task');
    expect(create.patch.title).toBe('Triaged upstream, no label');
  });

  it('keeps a type the record implies rather than defaulting it (LP-315)', () => {
    const paths = makeBoard('scrum', 'LP');
    const board = reload(paths);

    const remote = pullSnapshot({
      '101': { type: 'epic', title: 'Triaged as an epic' },
    });

    const plan = planPull(view(board), linkStore({}), remote, { toPatch: pullPatch });

    const create = createsOf(plan)[0]!;
    expect(create.patch.type).toBe('epic');
  });

  it('references a same-pull parent by temp id, so the hold-back wires them', () => {
    const paths = makeBoard('scrum', 'LP');
    const board = reload(paths);

    const remote = pullSnapshot({
      '200': { type: 'program', title: 'Programme' },
      '201': { type: 'epic', title: 'Epic', parent: '200' },
    });

    const plan = planPull(view(board), linkStore({}), remote, {
      toPatch: pullPatch,
      parentIdOf: pullParent,
    });

    const programme = createsOf(plan).find((create) => create.patch.type === 'program')!;
    const epic = createsOf(plan).find((create) => create.patch.type === 'epic')!;
    expect(programme.id).toBe('new:1');
    expect(epic.patch.parentId).toBe('new:1'); // the parent's temp id, held back by applyChanges
  });

  it('plans nothing for a push-only remote, and ignores issues outside scope', () => {
    const paths = makeBoard('scrum', 'LP');
    const programme = createIssue(reload(paths), { type: 'program', title: 'Programme' });
    const epic = createIssue(reload(paths), { type: 'epic', title: 'Epic', parentId: programme.id });

    const board = reload(paths);
    const store = linkStore({ [epic.id]: twin('200', {}) });

    expect(
      planPull(view(board), store, pullSnapshot({ '200': {} }, 'push'), { toPatch: pullPatch }),
    ).toEqual({ changes: [], links: [] });

    // Scope = the epic.  A new issue under the linked epic is in scope; a
    // rootless issue is not anchored to anything and is ignored.
    const plan = planPull(
      view(board),
      store,
      pullSnapshot(
        {
          '200': { type: 'epic', title: 'Epic' },
          '201': { type: 'feature', title: 'Under epic', parent: '200' },
          '202': { type: 'feature', title: 'Unanchored' },
        },
        'both',
        { scope: epic.id },
      ),
      { toPatch: pullPatch, parentIdOf: pullParent },
    );

    expect(createsOf(plan).map((create) => create.patch.title)).toEqual(['Under epic']);
  });

  it('applies on_delete: unlink by default and on_delete: delete as a change', () => {
    const { paths, story } = featureWithStory();
    const board = reload(paths);

    // The twin vanished from the listing.  `unlink` decouples: the link is
    // dropped and a tombstone records the decision, so the next push never
    // re-files it — the document becomes `decoupled`, not `local_only`.
    const unlinkPlan = planPull(view(board), linkStore({ [story.id]: twin('300', {}) }), pullSnapshot({}), {
      toPatch: pullPatch,
    });
    expect(unlinkPlan.changes).toEqual([]);
    expect(unlinkPlan.links).toEqual([{ kind: 'decouple', localId: story.id, reason: 'remote_deleted' }]);

    const deletePlan = planPull(
      view(board),
      linkStore({ [story.id]: twin('300', {}) }),
      pullSnapshot({}, 'both', { onDelete: 'delete' }),
      { toPatch: pullPatch },
    );
    expect(deletePlan.changes).toEqual([{ kind: 'delete', id: story.id, nodeKind: 'issue' }]);
    expect(deletePlan.links).toEqual([{ kind: 'unlink', localId: story.id }]);
  });

  it('plans nothing when the run is unreachable, even under on_delete: delete (LP-364)', () => {
    const { paths, story } = featureWithStory();
    const board = reload(paths);

    // The twin vanished from the listing, and the run was judged unreachable —
    // a delete policy must not turn an expired credential into a deletion.
    const plan = planPull(
      view(board),
      linkStore({ [story.id]: twin('300', {}) }),
      pullSnapshot({}, 'both', { onDelete: 'delete', unreachable: true }),
      { toPatch: pullPatch },
    );

    expect(plan).toEqual({ changes: [], links: [] });
  });
});

// ---------------------------------------------------------------------------
// LP-365 — resolve a vanished twin: unlink, close, delete, restore, manual
// ---------------------------------------------------------------------------

describe('planPull — on_delete resolutions (LP-365)', () => {
  it('unlink decouples: the document is untouched and never re-filed', () => {
    const { paths, story } = featureWithStory();
    const board = reload(paths);

    const plan = planPull(
      view(board),
      linkStore({ [story.id]: twin('300', {}) }),
      pullSnapshot({}, 'both', { onDelete: 'unlink' }),
      { toPatch: pullPatch },
    );

    expect(plan.changes).toEqual([]);
    expect(plan.links).toEqual([{ kind: 'decouple', localId: story.id, reason: 'remote_deleted' }]);
    expect(plan.restore).toBeUndefined();
    expect(plan.conflicts).toBeUndefined();
  });

  it('close moves the document to the board\'s terminal status and decouples', () => {
    const { paths, story } = featureWithStory();
    const board = reload(paths);

    const plan = planPull(
      view(board),
      linkStore({ [story.id]: twin('300', {}) }),
      pullSnapshot({}, 'both', { onDelete: 'close' }),
      { toPatch: pullPatch },
    );

    // `done` is the scrum board's declared terminal status — never hard-coded.
    expect(plan.changes).toEqual([
      { kind: 'update', id: story.id, nodeKind: 'issue', patch: { status: 'done' } },
    ]);
    expect(plan.links).toEqual([{ kind: 'decouple', localId: story.id, reason: 'remote_deleted' }]);
  });

  it('manual moves neither side and reports the document as conflicted', () => {
    const { paths, story } = featureWithStory();
    const board = reload(paths);

    const plan = planPull(
      view(board),
      linkStore({ [story.id]: twin('300', {}) }),
      pullSnapshot({}, 'both', { onDelete: 'manual' }),
      { toPatch: pullPatch },
    );

    expect(plan.changes).toEqual([]);
    expect(plan.links).toEqual([]);
    expect(plan.conflicts).toEqual([
      {
        localId: story.id,
        remoteId: '300',
        reason: 'on_delete: manual — the twin is gone and a human must choose',
      },
    ]);
  });

  it('restore plans a re-file, parents before children, child referenced by placeholder', () => {
    const { paths, feature, story } = featureWithStory();
    const board = reload(paths);

    const plan = planPull(
      view(board),
      linkStore({ [feature.id]: twin('300', {}), [story.id]: twin('301', {}) }),
      pullSnapshot({}, 'both', { onDelete: 'restore' }),
      { toPatch: pullPatch },
    );

    expect(plan.restore).toHaveLength(2);
    expect(plan.changes).toEqual([]);
    expect(plan.links).toEqual([]);

    const featureRestore = plan.restore!.find((op) => op.localId === feature.id)!;
    const storyRestore = plan.restore!.find((op) => op.localId === story.id)!;

    // Parents before children, exactly as a push creates them.
    expect(plan.restore!.map((op) => op.localId)).toEqual([feature.id, story.id]);
    // The child re-files under its parent's placeholder — the executor resolves
    // it against the parent's landed restore.
    expect(storyRestore.parent).toEqual({
      kind: 'created',
      localId: feature.id,
      placeholder: featureRestore.placeholder,
    });
    expect(featureRestore.parent).toBeUndefined();
    expect(featureRestore.oldRemoteId).toBe('300');
    expect(storyRestore.oldRemoteId).toBe('301');
    expect(featureRestore.fields.title).toBe('Feature');
  });

  it('delete refuses to orphan a linked child, naming it', () => {
    const { paths, story } = featureWithStory();
    const child = createIssue(reload(paths), {
      type: 'sub_task',
      title: 'Child',
      parentId: story.id,
    });
    const board = reload(paths);

    // The story's twin is gone; the child's twin still exists in the listing.
    const store = linkStore({ [story.id]: twin('300', {}), [child.id]: twin('301', {}) });
    const plan = planPull(
      view(board),
      store,
      pullSnapshot({ '301': { type: 'sub_task', title: 'Child' } }, 'both', { onDelete: 'delete' }),
      { toPatch: pullPatch },
    );

    expect(plan.changes).toEqual([]);
    expect(plan.links).toEqual([]);
    expect(plan.conflicts).toEqual([
      {
        localId: story.id,
        remoteId: '300',
        reason: `delete refused — would orphan linked child ${child.id}`,
        childId: child.id,
      },
    ]);
  });

  it('delete proceeds when the linked child is also being deleted', () => {
    const { paths, story } = featureWithStory();
    const child = createIssue(reload(paths), {
      type: 'sub_task',
      title: 'Child',
      parentId: story.id,
    });
    const board = reload(paths);

    // Both twins are gone — the child is not orphaned, it is deleted with its
    // parent, so the delete is allowed.
    const store = linkStore({ [story.id]: twin('300', {}), [child.id]: twin('301', {}) });
    const plan = planPull(
      view(board),
      store,
      pullSnapshot({}, 'both', { onDelete: 'delete' }),
      { toPatch: pullPatch },
    );

    expect(plan.conflicts).toBeUndefined();
    expect(plan.changes.map((change) => (change.kind === 'delete' ? change.id : null))).toEqual([
      story.id,
      child.id,
    ]);
  });
});

describe('applyPull', () => {
  it('records links for what landed and wires a same-pull parent', () => {
    const paths = makeBoard('scrum', 'LP');
    const board = reload(paths);
    const store = linkStore({});

    const plan = planPull(
      view(board),
      store,
      pullSnapshot({
        '200': { type: 'program', title: 'Programme' },
        '201': { type: 'epic', title: 'Epic', parent: '200' },
      }),
      { toPatch: pullPatch, parentIdOf: pullParent },
    );

    const result = applyPull(paths, 'test', store, plan);

    expect(result.failures).toEqual([]);
    expect(result.linked).toHaveLength(2);
    expect(result.unlinked).toEqual([]);

    // The real ids came back from the counter; the link store maps them to the
    // remote ids, and the epic's parent is the programme's real id — wired by
    // the existing hold-back-and-replay, not by plan order.
    const after = reload(paths);
    const programme = after.issues.find((issue) => issue.title === 'Programme')!;
    const epic = after.issues.find((issue) => issue.title === 'Epic')!;
    expect(epic.parentId).toBe(programme.id);
    expect(store.links.get(programme.id)?.remoteId).toBe('200');
    expect(store.links.get(epic.id)?.remoteId).toBe('201');

    // The link store was written to disk alongside the documents.
    const onDisk = loadLinkStore(paths, 'test');
    expect(onDisk.links.get(programme.id)?.remoteId).toBe('200');
    expect(onDisk.links.get(epic.id)?.remoteId).toBe('201');
  });

  it('records only what landed: a failing create is reported and not linked', () => {
    const paths = makeBoard('scrum', 'LP');
    const board = reload(paths);
    const store = linkStore({});

    // The second issue carries no type, so its create cannot land.
    const plan = planPull(
      view(board),
      store,
      pullSnapshot({
        '200': { type: 'program', title: 'Programme' },
        '201': { title: 'No type' },
      }),
      { toPatch: pullPatch },
    );

    const result = applyPull(paths, 'test', store, plan);

    expect(result.failures).toHaveLength(1);
    expect(result.linked).toHaveLength(1);
    const linked = reload(paths).issues.find((issue) => issue.title === 'Programme')!;
    expect(store.links.get(linked.id)?.remoteId).toBe('200');
    expect([...store.links.values()].some((entry) => entry.remoteId === '201')).toBe(false);
  });

  it('decouples a vanished twin under unlink, and removes it under on_delete: delete', () => {
    const { paths, story } = featureWithStory();
    const board = reload(paths);

    // on_delete: unlink keeps the document, drops the correspondence, and
    // records a tombstone so the next push never re-files it.
    const unlinkStore = linkStore({ [story.id]: twin('300', {}) });
    const unlinkResult = applyPull(
      paths,
      'test',
      unlinkStore,
      planPull(view(board), unlinkStore, pullSnapshot({}), { toPatch: pullPatch }),
    );
    expect(unlinkResult.unlinked).toEqual([]);
    expect(unlinkResult.decoupled).toEqual([story.id]);
    expect(unlinkStore.tombstones.get(story.id)?.reason).toBe('remote_deleted');
    expect(reload(paths).issues.some((issue) => issue.id === story.id)).toBe(true);

    // on_delete: delete removes the document and the correspondence.
    const deleteStore = linkStore({ [story.id]: twin('300', {}) });
    const deleteResult = applyPull(
      paths,
      'test',
      deleteStore,
      planPull(view(board), deleteStore, pullSnapshot({}, 'both', { onDelete: 'delete' }), {
        toPatch: pullPatch,
      }),
    );
    expect(deleteResult.unlinked).toEqual([story.id]);
    expect(reload(paths).issues.some((issue) => issue.id === story.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LP-283 — round-trip through an in-memory remote, and a pull that reproduces
// a remote tree with parents and edges.
// ---------------------------------------------------------------------------

/** A translator that echoes board fields into the request, for the round-trip. */
const echoTranslator: Translator = {
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
  fieldsFromRecord() {
    return { patch: {}, problems: [], unknownAccounts: [] };
  },
};

/** A provider whose connector is never used — the executor drives one directly. */
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

function openedRemote(): OpenedRemote {
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
    mapping: {},
  };
}

/**
 * An in-memory remote: the executor writes issues into it and `snapshot()`
 * hands them back to the pull planner as a `RemoteSnapshot`.  No network, no
 * disk beyond the throwaway board's own link store.
 */
function memoryRemote() {
  const issues = new Map<string, RemoteRecord>();
  let next = 400;

  const connector: Connector = {
    name: 'memory',
    async create(request: RemoteRequest) {
      const remoteId = String(next++);
      issues.set(remoteId, { ...request, id: remoteId });
      return { remoteId, remoteKey: `mem#${remoteId}`, remoteUrl: `https://mem/${remoteId}`, remoteRev: `rev-${remoteId}` };
    },
    async update(remoteId: string, request: RemoteRequest) {
      issues.set(remoteId, { ...issues.get(remoteId), ...request });
      return { remoteId, remoteKey: `mem#${remoteId}`, remoteUrl: `https://mem/${remoteId}`, remoteRev: `rev-${remoteId}-u` };
    },
    async delete(remoteId: string) {
      issues.delete(remoteId);
      return { remoteId, remoteKey: `mem#${remoteId}`, remoteUrl: '', remoteRev: `rev-${remoteId}-d` };
    },
    async get(remoteId: string) {
      return issues.get(remoteId) ?? null;
    },
    async list() {
      return { records: [...issues.values()], cursor: null };
    },
    async link(dependentRemoteId: string, dependencyRemoteId: string) {
      // The fake remote stores the edge, exactly as a real platform would —
      // the pull then reads it back and the round-trip plans nothing.
      const issue = issues.get(dependentRemoteId);
      if (issue) {
        const current = Array.isArray(issue.dependsOn)
          ? issue.dependsOn.filter((id): id is string => typeof id === 'string')
          : [];
        if (!current.includes(dependencyRemoteId)) issue.dependsOn = [...current, dependencyRemoteId];
      }
      return { remoteId: dependentRemoteId, remoteKey: `mem#${dependentRemoteId}`, remoteUrl: '', remoteRev: `rev-${dependentRemoteId}-l` };
    },
    async unlink(dependentRemoteId: string, dependencyRemoteId: string) {
      const issue = issues.get(dependentRemoteId);
      if (issue && Array.isArray(issue.dependsOn)) {
        issue.dependsOn = issue.dependsOn.filter(
          (id): id is string => typeof id === 'string' && id !== dependencyRemoteId,
        );
      }
      return { remoteId: dependentRemoteId, remoteKey: `mem#${dependentRemoteId}`, remoteUrl: '', remoteRev: `rev-${dependentRemoteId}-ul` };
    },
    async comment() {
      return { remoteId: '', remoteKey: '', remoteUrl: '', remoteRev: '' };
    },
  };

  return {
    connector,
    /** The planner's view of this remote: every stored issue, keyed by id. */
    snapshot(direction: RemoteSnapshot['direction'] = 'both'): RemoteSnapshot {
      return { direction, issues: new Map(issues) };
    },
  };
}

describe('planPush / planPull round-trip', () => {
  it('push then pull plans zero changes and leaves the board unchanged', async () => {
    const { paths } = featureWithStory();
    const board = reload(paths);
    const store = linkStore({});
    const remote = memoryRemote();

    const shape = (b: LoadedBoard) =>
      toSnapshot(b).issues.map(({ id, title, parentId, dependsOn }) => ({
        id,
        title,
        parentId,
        dependsOn,
      }));
    const before = shape(board);

    // Push the whole board into the in-memory remote through the executor.
    const pushPlan = planPush(view(board), store, snapshot());
    const pushed = await executePush(board, openedRemote(), remote.connector, store, pushPlan.ops);
    expect(pushed.failed).toEqual([]);
    expect(pushed.skipped).toEqual([]);
    expect(store.links.size).toBe(4);

    // The push also converges: re-planning a push finds nothing left to do.
    expect(planPush(view(board), store, snapshot())).toEqual({ ops: [], skipped: [] });

    // Pull the remote listing back: every issue has a twin, none is gone, so
    // the plan is empty — the loop bug would show up here as a spurious change.
    const pull = planPull(view(board), store, remote.snapshot(), {
      toPatch: pullPatch,
      parentIdOf: pullParent,
      dependsOnOf: pullDepends,
    });
    expect(pull).toEqual({ changes: [], links: [] });

    // And the board still holds exactly the structure it started with.
    expect(shape(reload(paths))).toEqual(before);
  });

  it('executePush restores a vanished twin: re-files, repoints the link, rewrites the base', async () => {
    const { paths, story } = featureWithStory();
    const board = reload(paths);
    const store = linkStore({ [story.id]: twin('300', {}) });
    const remote = memoryRemote();

    // The twin is deleted upstream: `on_delete: restore` plans a re-file.
    const plan = planPull(
      view(board),
      store,
      pullSnapshot({}, 'both', { onDelete: 'restore' }),
      { toPatch: pullPatch },
    );
    expect(plan.restore).toHaveLength(1);

    // The executor files the document afresh and repoints the link.
    const executed = await executePush(board, openedRemote(), remote.connector, store, plan.restore!);
    expect(executed.failed).toEqual([]);
    expect(executed.skipped).toEqual([]);
    expect(executed.landed.map((op) => op.kind)).toEqual(['restore']);

    // The link names the new remote id, not the vanished one, and the base
    // snapshot was rewritten to the re-filed values.
    const entry = store.links.get(story.id)!;
    expect(entry.remoteId).not.toBe('300');
    expect(entry.base?.title).toBe('Story');
    // The vanished twin's id is gone from the store's reverse index.
    expect(store.byRemote.has('300')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LP-288 — push then pull is a no-op, even through a normalising remote
// ---------------------------------------------------------------------------

/** A translator that recovers fields from a remote record, so the executor's
 *  base-from-response path runs in the loop below. */
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

function openedRecoverRemote(): OpenedRemote {
  return {
    ...openedRemote(),
    provider: {
      config: z.object({ connection: z.object({}), mapping: z.object({}) }),
      capabilities: emptyCapabilities(),
      translator: recoverTranslator,
      connector: () => {
        throw new Error('the executor drives a connector directly');
      },
    },
  };
}

/**
 * An in-memory remote that rewrites the body on every write — adding a
 * trailing newline, the classic tracker normalisation. `hashBody` trims, so
 * the rewrite is canonical-absorbable: the base records it and the second
 * cycle is stable rather than ping-ponging the newline back and forth.
 */
function normalisingMemoryRemote() {
  const issues = new Map<string, RemoteRecord>();
  let next = 800;

  const connector: Connector = {
    name: 'memory',
    async create(request: RemoteRequest) {
      const remoteId = String(next++);
      const record: RemoteRecord = {
        ...request,
        id: remoteId,
        body: `${request.body ?? ''}\n`,
      };
      issues.set(remoteId, record);
      return { remoteId, remoteKey: `mem#${remoteId}`, remoteUrl: '', remoteRev: `rev-${remoteId}`, record };
    },
    async update(remoteId: string, request: RemoteRequest) {
      const record: RemoteRecord = {
        ...issues.get(remoteId),
        ...request,
        id: remoteId,
        body: `${request.body ?? ''}\n`,
      };
      issues.set(remoteId, record);
      return { remoteId, remoteKey: `mem#${remoteId}`, remoteUrl: '', remoteRev: `rev-${remoteId}-u`, record };
    },
    async delete(remoteId: string) {
      issues.delete(remoteId);
      return { remoteId, remoteKey: '', remoteUrl: '', remoteRev: '' };
    },
    async get(remoteId: string) {
      return issues.get(remoteId) ?? null;
    },
    async list() {
      return { records: [...issues.values()], cursor: null };
    },
    async link(dependentRemoteId: string, dependencyRemoteId: string) {
      const issue = issues.get(dependentRemoteId);
      if (issue) {
        const current = Array.isArray(issue.dependsOn)
          ? issue.dependsOn.filter((id): id is string => typeof id === 'string')
          : [];
        if (!current.includes(dependencyRemoteId)) issue.dependsOn = [...current, dependencyRemoteId];
      }
      return { remoteId: dependentRemoteId, remoteKey: '', remoteUrl: '', remoteRev: '' };
    },
    async unlink(dependentRemoteId: string, dependencyRemoteId: string) {
      const issue = issues.get(dependentRemoteId);
      if (issue && Array.isArray(issue.dependsOn)) {
        issue.dependsOn = issue.dependsOn.filter(
          (id): id is string => typeof id === 'string' && id !== dependencyRemoteId,
        );
      }
      return { remoteId: dependentRemoteId, remoteKey: '', remoteUrl: '', remoteRev: '' };
    },
    async comment() {
      return { remoteId: '', remoteKey: '', remoteUrl: '', remoteRev: '' };
    },
  };

  return {
    connector,
    /** The planner's view of this remote: every stored issue, keyed by id. */
    snapshot(direction: RemoteSnapshot['direction'] = 'both'): RemoteSnapshot {
      return { direction, issues: new Map(issues) };
    },
  };
}

describe('LP-288 — push then pull is a no-op', () => {
  it('push → pull → push → pull: runs 2 through 4 plan nothing', async () => {
    const { paths } = featureWithStory();
    const board = reload(paths);
    const store = linkStore({});
    const remote = normalisingMemoryRemote();
    const opened = openedRecoverRemote();
    const pullOptions = { toPatch: pullPatch, parentIdOf: pullParent, dependsOnOf: pullDepends };

    // Run 1: push. The remote appends a trailing newline to every body; the
    // base must come back from that response, not from what we intended.
    const push1 = planPush(view(board), store, snapshot());
    const executed = await executePush(board, opened, remote.connector, store, push1.ops);
    expect(executed.failed).toEqual([]);
    expect(executed.skipped).toEqual([]);
    expect(store.links.size).toBe(4);

    // The recorded base has absorbed the normalisation (canonical form trims).
    for (const [id, link] of store.links) {
      expect(link.base?.body).toBe(hashBody(board.byId.get(id)!.body));
    }

    // Run 2: pull — no change.
    expect(planPull(view(board), store, remote.snapshot(), pullOptions)).toEqual({
      changes: [],
      links: [],
    });

    // Run 3: push — no change (the normalisation did not become a local edit).
    expect(planPush(view(board), store, snapshot())).toEqual({ ops: [], skipped: [] });

    // Run 4: pull — no change. The loop has settled.
    expect(planPull(view(board), store, remote.snapshot(), pullOptions)).toEqual({
      changes: [],
      links: [],
    });
  });
});

describe('planPull reproduces a remote tree', () => {
  it('an empty board and a populated remote: parents and edges are pulled', () => {
    const paths = makeBoard('scrum', 'LP');
    const board = reload(paths);
    const store = linkStore({});

    const remote = pullSnapshot({
      '300': { type: 'program', title: 'Programme' },
      '301': { type: 'epic', title: 'Epic', parent: '300' },
      '302': { type: 'feature', title: 'Feature', parent: '301' },
      '303': { type: 'user_story', title: 'Story', parent: '302', dependsOn: ['302'] },
    });

    const plan = planPull(view(board), store, remote, {
      toPatch: pullPatch,
      parentIdOf: pullParent,
      dependsOnOf: pullDepends,
    });

    const creates = createsOf(plan);
    expect(creates).toHaveLength(4);

    // The story's parent and its dependency both name the feature's temp id,
    // so the existing hold-back-and-replay wires them after everything exists.
    const feature = creates.find((create) => create.patch.title === 'Feature')!;
    const story = creates.find((create) => create.patch.title === 'Story')!;
    expect(story.patch.parentId).toBe(feature.id);
    expect(story.patch.dependsOn).toEqual([feature.id]);

    const result = applyPull(paths, 'test', store, plan);
    expect(result.failures).toEqual([]);
    expect(result.linked).toHaveLength(4);

    // The board now mirrors the remote tree, parents and edges included.
    const after = reload(paths);
    const programme = after.issues.find((issue) => issue.title === 'Programme')!;
    const epic = after.issues.find((issue) => issue.title === 'Epic')!;
    const featureDoc = after.issues.find((issue) => issue.title === 'Feature')!;
    const storyDoc = after.issues.find((issue) => issue.title === 'Story')!;
    expect(epic.parentId).toBe(programme.id);
    expect(featureDoc.parentId).toBe(epic.id);
    expect(storyDoc.parentId).toBe(featureDoc.id);
    expect(storyDoc.depends_on).toEqual([featureDoc.id]);
  });
});


// ---------------------------------------------------------------------------
// LP-285 — a dependency arriving from the remote that would close a cycle is
// refused with the cycle named, and the rest of the pull proceeds.
// ---------------------------------------------------------------------------

describe('LP-285 — cycle-closing dependency from the remote', () => {
  it('mergeLists surfaces the remote edge, and applyChanges refuses it by name', () => {
    const paths = makeBoard('scrum', 'LP');
    const programme = createIssue(reload(paths), { type: 'program', title: 'Programme' });
    const epic = createIssue(reload(paths), { type: 'epic', title: 'Epic', parentId: programme.id });
    const feature = createIssue(reload(paths), { type: 'feature', title: 'Feature', parentId: epic.id });
    const b = createIssue(reload(paths), { type: 'user_story', title: 'B', parentId: feature.id });
    // A depends on B locally — fine alone.
    const a = createIssue(reload(paths), {
      type: 'user_story',
      title: 'A',
      parentId: feature.id,
      dependsOn: [b.id],
    });

    // The remote independently added the reverse edge: B now waits on A there.
    // Merging B's depends_on as a set yields [A] as the remote addition.
    const merged = mergeLists(
      [], // local: B has no dependency of its own
      [a.id], // remote: B waits on A upstream
      [], // base: B had none at the last sync
    );
    expect(merged.remoteAdded).toEqual([a.id]);
    expect(merged.conflicts).toEqual([]);

    // What the pull planner will hand to applyChanges: B gains the merged edge,
    // plus an unrelated rename that must still land when the edge is refused.
    const changes: Change[] = [
      { kind: 'update', id: b.id, nodeKind: 'issue', patch: { dependsOn: merged.merged } },
      { kind: 'update', id: a.id, nodeKind: 'issue', patch: { title: 'A renamed' } },
    ];

    const result = applyChanges(paths, changes);

    // The edge is refused, the cycle is named, and the rest of the pull lands.
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.id).toBe(b.id);
    expect(result.failures[0]!.error).toContain('cycle');
    expect(result.failures[0]!.details?.some((line) => line.includes(a.id) && line.includes(b.id))).toBe(true);

    const after = reload(paths);
    expect(after.issues.find((issue) => issue.id === a.id)?.title).toBe('A renamed');
    expect(after.issues.find((issue) => issue.id === b.id)?.depends_on).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// LP-283 AC #2 — planPull reads the base snapshot and merges fields: a remote-
// only change is pulled, a both-sides change is a conflict, and a local-only
// change is left alone (the push planner's to carry upstream).
// ---------------------------------------------------------------------------

describe('planPull — field diffs against the base snapshot (LP-283 AC #2)', () => {
  it('pulls a field the remote alone changed, and nothing else', () => {
    const { paths, story } = featureWithStory();
    const board = reload(paths);

    // Base and local agree on "Story"; the remote renamed it upstream.
    const store = linkStore({
      [story.id]: twin('300', { title: 'Story', status: 'backlog' }),
    });

    const plan = planPull(
      view(board),
      store,
      pullSnapshot({ '300': { title: 'Story (renamed upstream)', status: 'backlog' } }),
      { toPatch: pullPatch },
    );

    expect(plan.changes).toEqual([
      {
        kind: 'update',
        id: story.id,
        nodeKind: 'issue',
        patch: { title: 'Story (renamed upstream)' },
      },
    ]);
    expect(plan.fieldConflicts).toBeUndefined();
    expect(plan.links).toEqual([]);
  });

  it('reports a conflict when both sides changed the same field, and writes neither', () => {
    const paths = makeBoard('scrum', 'LP');
    const programme = createIssue(reload(paths), { type: 'program', title: 'Programme' });
    const epic = createIssue(reload(paths), { type: 'epic', title: 'Epic', parentId: programme.id });
    const feature = createIssue(reload(paths), { type: 'feature', title: 'Feature', parentId: epic.id });
    const story = createIssue(reload(paths), {
      type: 'user_story',
      title: 'Story (local edit)',
      parentId: feature.id,
    });

    const board = reload(paths);
    const store = linkStore({ [story.id]: twin('300', { title: 'Story', status: 'backlog' }) });

    const plan = planPull(
      view(board),
      store,
      pullSnapshot({ '300': { title: 'Story (remote edit)', status: 'backlog' } }),
      { toPatch: pullPatch },
    );

    expect(plan.changes).toEqual([]);
    expect(plan.fieldConflicts).toEqual([
      {
        localId: story.id,
        remoteId: '300',
        field: 'title',
        local: 'Story (local edit)',
        remote: 'Story (remote edit)',
      },
    ]);
  });

  it('leaves a local-only change alone — planPush carries it upstream', () => {
    const paths = makeBoard('scrum', 'LP');
    const programme = createIssue(reload(paths), { type: 'program', title: 'Programme' });
    const epic = createIssue(reload(paths), { type: 'epic', title: 'Epic', parentId: programme.id });
    const feature = createIssue(reload(paths), { type: 'feature', title: 'Feature', parentId: epic.id });
    const story = createIssue(reload(paths), {
      type: 'user_story',
      title: 'Story (local edit)',
      parentId: feature.id,
    });

    const board = reload(paths);
    const store = linkStore({ [story.id]: twin('300', { title: 'Story', status: 'backlog' }) });

    const plan = planPull(
      view(board),
      store,
      pullSnapshot({ '300': { title: 'Story', status: 'backlog' } }),
      { toPatch: pullPatch },
    );

    // The local title edit is not pulled and does not conflict: the push
    // planner's diff against base is what carries it to the remote.
    expect(plan.changes).toEqual([]);
    expect(plan.fieldConflicts).toBeUndefined();
  });

  it('merges field by field: a remote title edit and a local status edit coexist', () => {
    const paths = makeBoard('scrum', 'LP');
    const programme = createIssue(reload(paths), { type: 'program', title: 'Programme' });
    const epic = createIssue(reload(paths), { type: 'epic', title: 'Epic', parentId: programme.id });
    const feature = createIssue(reload(paths), { type: 'feature', title: 'Feature', parentId: epic.id });
    // The board moved this story to in_progress; base still says backlog.
    const story = createIssue(reload(paths), {
      type: 'user_story',
      title: 'Story',
      parentId: feature.id,
      status: 'in_progress',
    });

    const board = reload(paths);
    const store = linkStore({ [story.id]: twin('300', { title: 'Story', status: 'backlog' }) });

    const plan = planPull(
      view(board),
      store,
      pullSnapshot({ '300': { title: 'Story (renamed upstream)', status: 'backlog' } }),
      { toPatch: pullPatch },
    );

    // The title is a clean remote pull; the status is a local-only edit, left
    // for the push planner — neither infects the other.
    expect(plan.changes).toEqual([
      {
        kind: 'update',
        id: story.id,
        nodeKind: 'issue',
        patch: { title: 'Story (renamed upstream)' },
      },
    ]);
    expect(plan.fieldConflicts).toBeUndefined();
  });

  it('pulls a body the remote alone changed, comparing hash to hash', () => {
    const { paths, story } = featureWithStory();
    const board = reload(paths);

    // The base stores a body hash; local still matches it, the remote rewrote
    // the body upstream.  The planner hashes both sides and compares hash to
    // hash, so the raw text change is pulled as-is.
    const store = linkStore({
      [story.id]: twin('300', { title: 'Story', status: 'backlog', body: hashBody(story.body) }),
    });

    const plan = planPull(
      view(board),
      store,
      pullSnapshot({ '300': { title: 'Story', status: 'backlog', body: 'As a user, I want X, changed upstream.' } }),
      { toPatch: pullPatch },
    );

    expect(plan.changes).toEqual([
      {
        kind: 'update',
        id: story.id,
        nodeKind: 'issue',
        patch: { body: 'As a user, I want X, changed upstream.' },
      },
    ]);
    expect(plan.fieldConflicts).toBeUndefined();
  });
});

describe('a selective push (`only`)', () => {
  it('acts on the named documents and leaves every other twin exactly as it was', () => {
    // The property this whole distinction exists for. Narrowing `scope` would
    // have said the other twins had left the mirror, and a push of one story
    // would have decoupled the rest of the board.
    const { paths, programme, epic, feature, story } = featureWithStory();
    const board = reload(paths);
    // Two twins have drifted from their base — the feature and the story — and
    // there is a document with no twin at all. Only the story is pushed.
    const store = linkStore({
      [programme.id]: twin('1', baseOf(board, programme.id)),
      [epic.id]: twin('2', baseOf(board, epic.id)),
      [feature.id]: twin('3', { ...baseOf(board, feature.id), title: 'Stale feature title' }),
      [story.id]: twin('4', { ...baseOf(board, story.id), title: 'Stale story title' }),
    });
    createIssue(reload(paths), { type: 'user_story', title: 'Fresh', parentId: feature.id });
    const changed = reload(paths);
    const plan = planPush(view(changed), store, {
      ...snapshot(),
      only: new Set([story.id]),
    });

    expect(plan.ops.filter((op) => op.kind === 'decouple')).toEqual([]);
    expect(plan.ops.filter((op) => op.kind === 'close')).toEqual([]);
    // A link op names its two endpoints rather than one document; every other
    // op in this plan is about the selected story and nothing else.
    const touched = new Set(
      plan.ops.flatMap((op) =>
        'localId' in op ? [op.localId] : 'dependent' in op ? [op.dependent.localId] : [],
      ),
    );
    expect([...touched]).toEqual([story.id]);
    // And nothing was created for the document that has no twin.
    expect(creates(plan.ops)).toEqual([]);
  });

  it('still resolves a reference to a document outside the selection', () => {
    // A selected child names its already-filed parent: selection says what to
    // act on, never what may be referred to.
    const { paths, programme, epic, feature, story } = featureWithStory();
    const board = reload(paths);
    const store = linkStore({
      [programme.id]: twin('1', baseOf(board, programme.id)),
      [epic.id]: twin('2', baseOf(board, epic.id)),
      [feature.id]: twin('3', baseOf(board, feature.id)),
    });

    const plan = planPush(view(board), store, { ...snapshot(), only: new Set([story.id]) });

    const created = creates(plan.ops);
    expect(created).toHaveLength(1);
    expect(created[0]!.localId).toBe(story.id);
    expect(created[0]!.parent).toEqual({ kind: 'linked', localId: feature.id, remoteId: '3' });
  });
});

describe('a plan filed a piece at a time', () => {
  it('re-parents a twin filed at the root once its parent arrives', () => {
    // The story went up before the feature existed upstream, so it was filed at
    // the remote's top level. Pushing the feature must move it — the local
    // parent never changed, so nothing else in the planner would notice.
    const { paths, feature, story } = featureWithStory();
    const board = reload(paths);
    const store = linkStore({
      [story.id]: { ...twin('4', baseOf(board, story.id)), parentRemoteId: null },
    });

    const plan = planPush(view(board), store, snapshot());

    const reparents = plan.ops.filter((op) => op.kind === 'reparent');
    expect(reparents).toHaveLength(1);
    expect(reparents[0]!.localId).toBe(story.id);
    // The parent is the create this same push is making, by placeholder.
    const featureCreate = creates(plan.ops).find((op) => op.localId === feature.id)!;
    expect(reparents[0]).toMatchObject({
      parent: { kind: 'created', localId: feature.id, placeholder: featureCreate.placeholder },
    });
  });

  it('leaves a twin alone when its filed parent is already the right one', () => {
    const { paths, feature, story } = featureWithStory();
    const board = reload(paths);
    const store = linkStore({
      [feature.id]: twin('3', baseOf(board, feature.id)),
      [story.id]: { ...twin('4', baseOf(board, story.id)), parentRemoteId: '3' },
    });

    const plan = planPush(view(board), store, snapshot());

    expect(plan.ops.filter((op) => op.kind === 'reparent')).toEqual([]);
  });

  it('reads a link that never recorded a filed parent as unknown, not as rootless', () => {
    // Every link written before this was recorded has no `parentRemoteId`. An
    // unknown must change nothing: the alternative is a reparent op for every
    // twin on the board the first time anybody pushes after upgrading.
    const { paths, feature, story } = featureWithStory();
    const board = reload(paths);
    const store = linkStore({
      [feature.id]: twin('3', baseOf(board, feature.id)),
      [story.id]: twin('4', baseOf(board, story.id)),
    });

    const plan = planPush(view(board), store, snapshot());

    expect(plan.ops.filter((op) => op.kind === 'reparent')).toEqual([]);
  });
});

describe('a targeted pull (`partial`)', () => {
  it('infers no deletion from a listing that only fetched what was asked for', () => {
    // A one-issue fetch says nothing about the other twins. Without this, every
    // targeted pull would plan the `on_delete` policy for the whole board.
    const paths = makeBoard('scrum', 'LP');
    const programme = createIssue(reload(paths), { type: 'program', title: 'Programme' });
    const board = reload(paths);
    const store = linkStore({ [programme.id]: twin('1', baseOf(board, programme.id)) });

    const partial = {
      ...pullSnapshot({ '99': { type: 'program', title: 'Only this one' } }),
      partial: true,
    };
    const plan = planPull(view(board), store, partial, { toPatch: pullPatch });

    // The new issue is created; the untouched twin is not unlinked or deleted.
    expect(createsOf(plan)).toHaveLength(1);
    expect(plan.changes.some((change) => change.kind === 'delete')).toBe(false);
    expect(plan.links).toEqual([{ kind: 'record', tempId: 'new:1', remoteId: '99' }]);
  });

  it('puts an issue with no remote parent under the document the caller names', () => {
    // A tracker keeps a flat list and a board keeps a tree, so an issue
    // imported on its own needs somewhere to go — and the level it lands at is
    // its adopting parent's, not the root's.
    const { paths, feature } = featureWithStory();
    const board = reload(paths);

    const plan = planPull(
      view(board),
      linkStore({}),
      { ...pullSnapshot({ '77': { type: 'user_story', title: 'Reported upstream' } }), partial: true },
      { toPatch: pullPatch, underParent: feature.id },
    );

    const create = createsOf(plan)[0]!;
    expect(create.patch.parentId).toBe(feature.id);
  });
});
