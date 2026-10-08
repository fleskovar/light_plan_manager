/**
 * LP-300 — the provider conformance suite.
 *
 * One table of providers; the same scenarios run against each, offline, through
 * the real translator and connector with the in-memory tracker
 * (`test/support/memory-tracker.ts`) standing in for the platform. A provider
 * that cannot do something declares it (in `capabilities`, and in the entry's
 * `degraded` map) and the suite asserts the *degraded* behaviour instead of
 * skipping — so a provider may be less capable, never less tested.
 *
 * Adding a provider is one entry in `entries` below and nothing else: the
 * scenario bodies never name a provider.
 */

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { createIssue, moveNode, updateNode } from '../src/core/index.js';
import { githubProvider, githubParentIdOf, githubBlockEdgesOf } from '../src/remote/providers/github/index.js';
import {
  jsonfileDependsOnOf,
  jsonfileParentIdOf,
  jsonfileProvider,
  jsonfileRemoteIdOf,
} from '../src/remote/providers/jsonfile/index.js';
import {
  linearDependsOnOf,
  linearParentIdOf,
  linearProvider,
  linearRelatesToOf,
} from '../src/remote/providers/linear/index.js';
import { executePush } from '../src/remote/index.js';
import { planPull, planPush, type RemoteOp } from '../src/remote/plan.js';
import { applyPull } from '../src/remote/pull.js';
import { toSnapshot } from '../src/sync/index.js';
import { cleanupBoards } from './helpers.js';
import { jsonFileTracker, jsonIssueOf, mutateJsonIssue, type JsonFileTracker } from './support/jsonfile-tracker.js';
import {
  buildHarness,
  plantTree,
  providerPull,
  viewOf,
  type ConformanceEntry,
  type ConformanceRemote,
} from './support/provider-conformance.js';

afterAll(cleanupBoards);
afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// The table. One entry per provider.
// ---------------------------------------------------------------------------

/** The GitHub mapping the suite uses: every board status and the types it files. */
const GITHUB_MAPPING: Record<string, unknown> = {
  types: {
    program: { remote: 'program' },
    epic: { remote: 'epic' },
    feature: { remote: 'feature' },
    user_story: { remote: 'story' },
  },
  statuses: {
    backlog: { remote: ['Backlog'], closed: false },
    ready: { remote: ['Ready'], closed: false },
    in_progress: { remote: ['In Progress'], closed: false },
    in_review: { remote: ['In Review'], closed: false },
    done: { remote: ['Done'], closed: true },
  },
};

/** The Linear mapping the suite uses: types ride labels, statuses ride workflow states. */
const LINEAR_MAPPING: Record<string, unknown> = {
  types: {
    program: { remote: 'program' },
    epic: { remote: 'epic' },
    feature: { remote: 'feature' },
    user_story: { remote: 'story' },
  },
  statuses: {
    backlog: { remote: ['Backlog'], closed: false },
    ready: { remote: ['Ready'], closed: false },
    in_progress: { remote: ['In Progress'], closed: false },
    in_review: { remote: ['In Review'], closed: false },
    done: { remote: ['Done'], closed: true },
  },
};

/** GitHub's spelling of the remote seam: status is a label, close is `state: closed`. */
const githubRemote: ConformanceRemote = {
  isClosed(tracker, remoteId) {
    return tracker.issues().get(Number(remoteId))?.state === 'closed';
  },
  typeValueOf(tracker, remoteId) {
    const labels = tracker.issues().get(Number(remoteId))?.labels ?? [];
    return labels.find((label) => label === 'story');
  },
  statusValueOf(tracker, remoteId) {
    const labels = tracker.issues().get(Number(remoteId))?.labels ?? [];
    for (const entry of Object.values(GITHUB_MAPPING.statuses as Record<string, { remote: string[] }>)) {
      for (const remote of entry.remote) if (labels.includes(remote)) return remote;
    }
    return undefined;
  },
  reopen(tracker, remoteId, boardStatus) {
    const label = (GITHUB_MAPPING.statuses as Record<string, { remote: string[] }>)[boardStatus]?.remote[0] ?? boardStatus;
    tracker.mutateIssue(remoteId, { labels: ['story', label], state: 'open' });
  },
  deleteRemote(tracker, remoteId) {
    tracker.deleteIssue(remoteId);
  },
  triage(tracker, remoteId, labels) {
    tracker.mutateIssue(remoteId, { labels: ['story', 'Backlog', ...labels] });
  },
  seedEdgeIssues(holdsEdges) {
    return [
      { number: 1, title: 'Programme A', labels: ['program', 'Backlog'] },
      holdsEdges
        ? { number: 2, title: 'Programme B', labels: ['program', 'Backlog'], dependencies: [1] }
        : {
            number: 2,
            title: 'Programme B',
            labels: ['program', 'Backlog'],
            body: [
              'prose',
              '',
              '<!-- lpm:begin -->',
              '| light-plan | |',
              '| --- | --- |',
              '| depends_on | #1 |',
              '<!-- lpm:end -->',
            ].join('\n'),
          },
    ];
  },
};

/** Linear's spelling of the remote seam: status is a workflow state, close is the terminal state. */
const linearRemote: ConformanceRemote = {
  isClosed(tracker, remoteId) {
    return tracker.issues().get(Number(remoteId))?.workflowState === 'Done';
  },
  typeValueOf(tracker, remoteId) {
    return (tracker.issues().get(Number(remoteId))?.labels ?? []).find((l) => l === 'story');
  },
  statusValueOf(tracker, remoteId) {
    return tracker.issues().get(Number(remoteId))?.workflowState;
  },
  reopen(tracker, remoteId, boardStatus) {
    const state = (LINEAR_MAPPING.statuses as Record<string, { remote: string[] }>)[boardStatus]?.remote[0] ?? boardStatus;
    tracker.mutateIssue(remoteId, { workflowState: state });
  },
  deleteRemote(tracker, remoteId) {
    tracker.deleteIssue(remoteId);
  },
  triage(tracker, remoteId, labels) {
    tracker.mutateIssue(remoteId, { labels: ['story', ...labels] });
  },
  seedEdgeIssues() {
    // Linear holds a native blocking edge, so the seed always carries it.
    return [
      { number: 1, title: 'Programme A', labels: ['program'], workflowState: 'Backlog' },
      {
        number: 2,
        title: 'Programme B',
        labels: ['program'],
        workflowState: 'Backlog',
        dependencies: [1],
      },
    ];
  },
};

/** The jsonfile mapping the suite uses: native `type` and `status` fields, a human type label kept beside each. */
const JSONFILE_MAPPING: Record<string, unknown> = {
  types: {
    program: { remote: 'program' },
    epic: { remote: 'epic' },
    feature: { remote: 'feature' },
    user_story: { remote: 'story' },
  },
  statuses: {
    backlog: { remote: ['Backlog'], closed: false },
    ready: { remote: ['Ready'], closed: false },
    in_progress: { remote: ['In Progress'], closed: false },
    in_review: { remote: ['In Review'], closed: false },
    done: { remote: ['Done'], closed: true },
  },
};

/** The jsonfile terminal status name — the native `status` value that reads as closed. */
const JSONFILE_TERMINAL_STATUS = 'Done';

/** jsonfile's spelling of the remote seam: status is the native `status` field, close is its terminal value. */
const jsonfileRemote: ConformanceRemote = {
  isClosed(tracker, remoteId) {
    return jsonIssueOf(tracker, remoteId)?.status === JSONFILE_TERMINAL_STATUS;
  },
  typeValueOf(tracker, remoteId) {
    // Native `type` field — the value never rides a label here.
    return jsonIssueOf(tracker, remoteId)?.type;
  },
  statusValueOf(tracker, remoteId) {
    return jsonIssueOf(tracker, remoteId)?.status;
  },
  reopen(tracker, remoteId, boardStatus) {
    const status =
      (JSONFILE_MAPPING.statuses as Record<string, { remote: string[] }>)[boardStatus]?.remote[0] ??
      boardStatus;
    mutateJsonIssue(tracker, remoteId, { status });
  },
  deleteRemote(tracker, remoteId) {
    tracker.deleteIssue(remoteId);
  },
  triage(tracker, remoteId, labels) {
    const issue = jsonIssueOf(tracker, remoteId);
    mutateJsonIssue(tracker, remoteId, { labels: [...(issue?.labels ?? []), ...labels] });
  },
  seedEdgeIssues() {
    // The file holds a native `depends_on` edge, so the seed always carries it.
    return [
      { number: 1, title: 'Programme A', labels: ['program'], workflowState: 'Backlog' },
      {
        number: 2,
        title: 'Programme B',
        labels: ['program'],
        workflowState: 'Backlog',
        dependencies: [1],
      },
    ];
  },
};

const entries: ConformanceEntry[] = [
  {
    name: 'github',
    provider: githubProvider,
    connection: { repo: 'acme/payments', base_url: 'https://api.github.com' },
    mapping: GITHUB_MAPPING,
    pull: providerPull(githubProvider, GITHUB_MAPPING, {
      parentIdOf: githubParentIdOf,
      blockEdgesOf: githubBlockEdgesOf,
    }),
    remote: githubRemote,
    degraded: {
      // `depends_on` / `relates_to` have no native edge on GitHub, but they no
      // longer count as degraded — they ride the managed block (LP-314).
      hardDelete: 'GitHub issues cannot be hard-deleted over REST; delete closes the issue',
    },
  },
  {
    name: 'linear',
    provider: linearProvider,
    connection: { team: 'ENG', base_url: 'https://api.linear.app' },
    mapping: LINEAR_MAPPING,
    pull: providerPull(linearProvider, LINEAR_MAPPING, {
      parentIdOf: linearParentIdOf,
      dependsOnOf: linearDependsOnOf,
      relatesToOf: linearRelatesToOf,
    }),
    remote: linearRemote,
    recordsOf: (tracker) => tracker.linearRecords(),
    remoteIdOf: (record) => String(record.id ?? ''),
  },
  {
    name: 'jsonfile',
    provider: jsonfileProvider,
    // Overridden per-harness by `trackerAndConnection` — the connector is
    // fs-backed, so the file path is resolved against the board's own root.
    connection: { file: '' },
    mapping: JSONFILE_MAPPING,
    pull: providerPull(jsonfileProvider, JSONFILE_MAPPING, {
      parentIdOf: jsonfileParentIdOf,
      dependsOnOf: jsonfileDependsOnOf,
    }),
    remote: jsonfileRemote,
    trackerAndConnection: (paths, { tracker, seed }) => {
      const t = (
        tracker ?? jsonFileTracker({ file: path.join(paths.root, 'tracker.json'), seed })
      ) as JsonFileTracker;
      return { tracker: t, connection: { file: t.file } };
    },
    recordsOf: (tracker) => tracker.records(),
    remoteIdOf: jsonfileRemoteIdOf,
  },
];

/** Push a single programme and return the harness, the issue and its remote id. */
async function pushedIssue(entry: ConformanceEntry, title: string) {
  const h = await buildHarness(entry);
  const issue = createIssue(h.reload(), { type: 'program', title });
  const board = h.reload();
  const plan = planPush(viewOf(board), h.store, h.snapshot());
  const result = await executePush(board, h.opened, h.connector, h.store, plan.ops);
  expect(result.failed).toEqual([]);
  return { h, issue, remoteId: h.store.links.get(issue.id)!.remoteId };
}

for (const entry of entries) {
  describe(`provider conformance: ${entry.name}`, () => {
    // Every conformance entry declares the remote seam; the type keeps it
    // optional only because the GitHub-specific edge/hierarchy tests reuse
    // `ConformanceEntry` without it.
    const remote = entry.remote!;

    it('first push: files every issue and records a twin', async () => {
      const h = await buildHarness(entry);
      const { program, epic, feature, story } = plantTree(h.paths);

      const board = h.reload();
      const plan = planPush(viewOf(board), h.store, h.snapshot());
      const result = await executePush(board, h.opened, h.connector, h.store, plan.ops);

      // Every op landed, nothing was skipped, and every document has a twin.
      expect(result.failed).toEqual([]);
      expect(result.skipped).toEqual([]);
      expect(result.landed.map((op) => op.kind)).toEqual(['create', 'create', 'create', 'create']);
      expect(h.store.links.size).toBe(4);
      expect(new Set([...h.store.links.keys()])).toEqual(
        new Set([program.id, epic.id, feature.id, story.id]),
      );

      // The remote holds exactly the filed issues, titles intact.
      const titles = [...h.tracker.issues().values()].map((issue) => issue.title).sort();
      expect(titles).toEqual(['Epic', 'Feature', 'Programme', 'Story']);
    });

    it('first push: a document already finished is filed finished (not open)', async () => {
      // The status a board document carries has to survive its *first* push,
      // not only a later one. Two connectors got this wrong in a way nothing
      // could report: neither platform can set a state on the create call
      // (Jira moves status only through a transition, GitHub's POST takes no
      // `state`), so a board of completed work arrived as a tracker full of
      // open issues — and then *stayed* that way, because the base is
      // recomputed from the echo and a remote state that maps back to more
      // than one board status leaves the local value standing. Both sides
      // recorded agreement on a state the remote did not hold, so no later
      // push had anything to disagree with.
      const h = await buildHarness(entry);
      const { story } = plantTree(h.paths);
      moveNode(h.reload(), h.reload().byId.get(story.id)!, { status: 'done', rollUp: false });

      const board = h.reload();
      const plan = planPush(viewOf(board), h.store, h.snapshot());
      const result = await executePush(board, h.opened, h.connector, h.store, plan.ops);

      expect(result.failed).toEqual([]);
      expect(remote.isClosed(h.tracker, h.store.links.get(story.id)!.remoteId)).toBe(true);
    });

    it('incremental push: only the change is planned and applied', async () => {
      const h = await buildHarness(entry);
      const { story } = plantTree(h.paths);

      let board = h.reload();
      await executePush(
        board,
        h.opened,
        h.connector,
        h.store,
        planPush(viewOf(board), h.store, h.snapshot()).ops,
      );

      // Rename one story; everything else is untouched.
      const stale = h.reload();
      updateNode(stale, stale.byId.get(story.id)!, { title: 'Story (renamed)' });
      board = h.reload();

      const plan = planPush(viewOf(board), h.store, h.snapshot());
      expect(plan.ops).toHaveLength(1);
      expect(plan.ops[0]).toMatchObject({ kind: 'update', localId: story.id });

      const result = await executePush(board, h.opened, h.connector, h.store, plan.ops);
      expect(result.failed).toEqual([]);
      expect(result.skipped).toEqual([]);

      const remote = [...h.tracker.issues().values()].find((issue) => issue.number === Number(h.store.links.get(story.id)!.remoteId))!;
      expect(remote.title).toBe('Story (renamed)');

      // Converged: a third push plans nothing.
      expect(planPush(viewOf(h.reload()), h.store, h.snapshot())).toEqual({ ops: [], skipped: [] });
    });

    it('pull of a remote-only issue', async () => {
      // An issue exists remotely that this board has never seen: file it from a
      // throwaway board, then pull it into a fresh board over the same tracker.
      const { h: producer } = await pushedIssue(entry, 'Remote-only');

      const consumer = await buildHarness(entry, { tracker: producer.tracker });
      const plan = planPull(consumer.view(), consumer.store, consumer.snapshot(), consumer.pullOptions);
      expect(plan.changes).toHaveLength(1);

      const result = applyPull(consumer.paths, entry.name, consumer.store, plan);
      expect(result.failures).toEqual([]);
      expect(result.linked).toHaveLength(1);

      const pulled = consumer.reload().issues.find((issue) => issue.title === 'Remote-only')!;
      expect(pulled.type).toBe('program');
      expect(pulled.status).toBe('backlog');
    });

    it('status change each way', async () => {
      const h = await buildHarness(entry);
      const { story } = plantTree(h.paths);
      let board = h.reload();
      await executePush(
        board,
        h.opened,
        h.connector,
        h.store,
        planPush(viewOf(board), h.store, h.snapshot()).ops,
      );

      // Push direction: a terminal status closes the remote issue.
      moveNode(h.reload(), h.reload().byId.get(story.id)!, { status: 'done', rollUp: false });
      board = h.reload();
      const pushPlan = planPush(viewOf(board), h.store, h.snapshot());
      expect(
        pushPlan.ops.find((op) => op.kind === 'close' && op.localId === story.id),
      ).toBeDefined();
      await executePush(board, h.opened, h.connector, h.store, pushPlan.ops);
      const closedRemoteId = h.store.links.get(story.id)!.remoteId;
      expect(remote.isClosed(h.tracker, closedRemoteId)).toBe(true);

      // Pull direction: a remote-only status change is recovered onto the
      // board. The close push above recorded base "done"; the remote now
      // reopens the issue and moves it back to "Backlog" on its own — a
      // change only the remote made, simulated through the provider's own
      // spelling of a reopen (LP-312).
      await remote.reopen(h.tracker, h.store.links.get(story.id)!.remoteId, 'backlog');
      const pullPlan = planPull(viewOf(h.reload()), h.store, h.snapshot(), h.pullOptions);
      expect(pullPlan.changes).toContainEqual({
        kind: 'update',
        id: story.id,
        nodeKind: 'issue',
        patch: { status: 'backlog' },
      });
    });

    it('edge each way', async () => {
      const h = await buildHarness(entry);
      const holdsEdges = h.capabilities.edges.dependsOn === true;
      const { feature, story } = plantTree(h.paths, { edge: true });

      const board = h.reload();
      const plan = planPush(viewOf(board), h.store, h.snapshot());
      const result = await executePush(board, h.opened, h.connector, h.store, plan.ops);
      expect(result.failed).toEqual([]);
      expect(result.skipped).toEqual([]);

      const storyRemoteId = Number(h.store.links.get(story.id)!.remoteId);
      const featureRemoteId = Number(h.store.links.get(feature.id)!.remoteId);

      if (holdsEdges) {
        // A native blocking edge is linked directly, no managed block involved.
        const linkOps = plan.ops.filter(
          (op): op is Extract<RemoteOp, { kind: 'link' }> => op.kind === 'link',
        );
        expect(linkOps).toHaveLength(1);
        expect(h.tracker.dependencies(storyRemoteId)).toEqual([featureRemoteId]);
      } else {
        // No native edge (LP-314): the dependency rides the managed block as a
        // `#<n>` reference a person reading GitHub can click.
        expect(h.capabilities.edges.dependsOn).toBe(false);
        const edgeOps = plan.ops.filter(
          (op): op is Extract<RemoteOp, { kind: 'edges' }> => op.kind === 'edges',
        );
        expect(edgeOps).toHaveLength(1);
        const storyRecord = h.tracker.issues().get(storyRemoteId)!;
        expect(storyRecord.body).toContain('<!-- lpm:begin -->');
        expect(storyRecord.body).toContain(`| depends_on | #${featureRemoteId} |`);
        expect(h.tracker.dependencies(storyRemoteId)).toEqual([]);
      }

      // Pull direction: an edge on the remote is imported. A native-edge
      // provider carries it as a native dependency; a block provider as a
      // `#<n>` row in the body, resolved back through the link store.
      const seeded = await buildHarness(entry, { seed: remote.seedEdgeIssues(holdsEdges) });
      const pullPlan = planPull(seeded.view(), seeded.store, seeded.snapshot(), seeded.pullOptions);
      const applied = applyPull(seeded.paths, entry.name, seeded.store, pullPlan);
      expect(applied.failures).toEqual([]);

      const pulledB = seeded.reload().issues.find((issue) => issue.title === 'Programme B')!;
      expect(pulledB.depends_on).toHaveLength(1);
    });

    it('comment each way', async () => {
      const h = await buildHarness(entry);
      const { story } = plantTree(h.paths);
      const board = h.reload();
      await executePush(
        board,
        h.opened,
        h.connector,
        h.store,
        planPush(viewOf(board), h.store, h.snapshot()).ops,
      );
      const remoteId = h.store.links.get(story.id)!.remoteId;

      if (h.capabilities.comments.native) {
        // Push a comment; the remote holds it.
        const posted = await h.connector.comment!(remoteId, 'a note');
        expect(posted.commentId).toBeTruthy();
        expect(h.tracker.comments(Number(remoteId))).toHaveLength(1);
        expect(h.tracker.comments(Number(remoteId))[0]!.body).toBe('a note');

        // Pull it back: the remote returns exactly what was posted, and a
        // provider that can edit or delete its comments does so.
        if (h.capabilities.comments.editable) {
          await h.connector.editComment!(remoteId, posted.commentId!, 'an edited note');
          expect(h.tracker.comments(Number(remoteId))[0]!.body).toBe('an edited note');
        }
        if (h.capabilities.comments.deletable) {
          await h.connector.deleteComment!(remoteId, posted.commentId!);
          expect(h.tracker.comments(Number(remoteId))).toHaveLength(0);
        }
      } else {
        // Declared absent, asserted degraded: no comment method at all.
        expect(h.capabilities.comments.native).toBe(false);
        expect(entry.degraded?.comments).toBeTruthy();
        expect(typeof h.connector.comment).not.toBe('function');
      }
    });

    it('delete policy', async () => {
      // connector.delete: a provider that cannot hard-delete degrades to close.
      const { h, remoteId } = await pushedIssue(entry, 'To delete');
      await h.connector.delete(remoteId);
      if (entry.degraded?.hardDelete) {
        expect(h.tracker.issues().get(Number(remoteId))?.state).toBe('closed');
      } else {
        expect(h.tracker.issues().has(Number(remoteId))).toBe(false);
      }

      // on_delete: unlink (the default) keeps the document and decouples it.
      const unlink = await pushedIssue(entry, 'Vanished (unlink)');
      remote.deleteRemote(unlink.h.tracker, unlink.remoteId);
      const unlinkPlan = planPull(
        unlink.h.view(),
        unlink.h.store,
        unlink.h.snapshot(),
        unlink.h.pullOptions,
      );
      expect(unlinkPlan.links).toEqual([
        { kind: 'decouple', localId: unlink.issue.id, reason: 'remote_deleted' },
      ]);
      applyPull(unlink.h.paths, entry.name, unlink.h.store, unlinkPlan);
      expect(unlink.h.reload().issues).toHaveLength(1);
      expect(unlink.h.store.tombstones.get(unlink.issue.id)?.reason).toBe('remote_deleted');

      // on_delete: delete removes the local document and the correspondence.
      const del = await pushedIssue(entry, 'Vanished (delete)');
      remote.deleteRemote(del.h.tracker, del.remoteId);
      const delPlan = planPull(
        del.h.view(),
        del.h.store,
        del.h.snapshot('both', 'delete'),
        del.h.pullOptions,
      );
      expect(delPlan.changes).toEqual([{ kind: 'delete', id: del.issue.id, nodeKind: 'issue' }]);
      applyPull(del.h.paths, entry.name, del.h.store, delPlan);
      expect(del.h.reload().issues).toHaveLength(0);
    });

    it('label reconciliation preserves a human triage label (LP-308)', async () => {
      const h = await buildHarness(entry);
      const { story } = plantTree(h.paths);
      let board = h.reload();
      await executePush(
        board,
        h.opened,
        h.connector,
        h.store,
        planPush(viewOf(board), h.store, h.snapshot()).ops,
      );
      const remoteId = h.store.links.get(story.id)!.remoteId;

      // A human triages the issue by hand: they keep our type/status labels and
      // add two of their own.
      remote.triage(h.tracker, remoteId, ['needs-triage', 'team:frontend']);

      // The board moves the story to done; the push must change only the
      // status label (Backlog → Done) and leave both triage labels untouched.
      moveNode(h.reload(), h.reload().byId.get(story.id)!, { status: 'done', rollUp: false });
      board = h.reload();
      const plan = planPush(viewOf(board), h.store, h.snapshot());
      expect(plan.ops).toContainEqual(expect.objectContaining({ kind: 'close', localId: story.id }));
      const result = await executePush(board, h.opened, h.connector, h.store, plan.ops);
      expect(result.failed).toEqual([]);

      const remoteIssue = [...h.tracker.issues().values()].find(
        (issue) => issue.number === Number(remoteId),
      )!;
      // The human's triage labels survive, and the type is still whatever
      // carrier this provider keeps it in.
      expect(remoteIssue.labels).toEqual(expect.arrayContaining(['needs-triage', 'team:frontend']));
      expect(remote.typeValueOf(h.tracker, remoteId)).toBe('story');
      expect(remote.statusValueOf(h.tracker, remoteId)).toBe('Done');
      expect(remote.isClosed(h.tracker, remoteId)).toBe(true);
    });

    it('push → pull → assert-nothing round trip', async () => {
      const h = await buildHarness(entry);
      plantTree(h.paths);

      const shape = () =>
        toSnapshot(h.reload()).issues.map(({ id, title, parentId, dependsOn }) => ({
          id,
          title,
          parentId,
          dependsOn,
        }));
      const before = shape();

      const board = h.reload();
      const pushed = await executePush(
        board,
        h.opened,
        h.connector,
        h.store,
        planPush(viewOf(board), h.store, h.snapshot()).ops,
      );
      expect(pushed.failed).toEqual([]);
      expect(pushed.skipped).toEqual([]);

      // The awkward tracker normalisation (markdown + label order) is absorbed
      // into the base, so re-planning a push, then a pull, each find nothing.
      expect(planPush(viewOf(h.reload()), h.store, h.snapshot())).toEqual({ ops: [], skipped: [] });
      expect(planPull(viewOf(h.reload()), h.store, h.snapshot(), h.pullOptions)).toEqual({
        changes: [],
        links: [],
      });

      // And the board still holds exactly the structure it started with.
      expect(shape()).toEqual(before);
    });
  });
}
