/**
 * LP-309 — hierarchy encoding: sub-issues where the account has them, type
 * label plus the parent id in the managed block everywhere else. LP-493 closes
 * the two pieces LP-309 left open: an encoding switch is *detected* (the link
 * store records the last-used encoding) and each existing twin is migrated in
 * place, and a local reparent on a linked board reaches the remote through a
 * `reparent` op rather than leaving the twin stale.
 *
 * The pure decision (`resolveHierarchyEncoding`) is tested as a unit; the two
 * encodings are then driven end to end through the real GitHub provider, the
 * in-memory tracker and `planPush` / `executePush` / `planPull` / `applyPull`
 * — a five-level board round-trips to the same tree under both encodings, a
 * forced `--hierarchy` overrides detection, and a switch of encoding migrates
 * in place rather than re-filing.
 */

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createIssue, loadBoard, moveNode } from '../src/core/index.js';
import type { BoardPaths } from '../src/core/storage/paths.js';
import {
  PARENT_FIELD,
  carrierChanged,
  parentBlockEntry,
  parentIsNative,
  parentRemoteIdFromBlock,
  recordOf,
  resolveHierarchyEncoding,
} from '../src/remote/hierarchy.js';
import { githubProvider, githubParentIdOf } from '../src/remote/providers/github/index.js';
import { applyManagedBlock } from '../src/remote/managed-block.js';
import {
  applyPull,
  executePush,
  planPull,
  planPush,
  renderPlan,
  type RemoteOp,
} from '../src/remote/index.js';
import { toSnapshot } from '../src/sync/index.js';
import { cleanupBoards } from './helpers.js';
import {
  buildHarness,
  providerPull,
  viewOf,
  type ConformanceEntry,
  type ConformanceHarness,
} from './support/provider-conformance.js';

afterAll(cleanupBoards);
afterEach(() => vi.unstubAllGlobals());

// The board's five-level issue hierarchy (scrum template).
const HIERARCHY = [
  ['program'],
  ['epic'],
  ['feature'],
  ['user_story', 'bug', 'test', 'review', 'research'],
  ['sub_task'],
];

/** The GitHub mapping covering all five levels (the conformance one stops at stories). */
const MAPPING: Record<string, unknown> = {
  types: {
    program: { remote: 'program' },
    epic: { remote: 'epic' },
    feature: { remote: 'feature' },
    user_story: { remote: 'story' },
    sub_task: { remote: 'sub-task' },
  },
  statuses: {
    backlog: { remote: ['Backlog'], closed: false },
    ready: { remote: ['Ready'], closed: false },
    in_progress: { remote: ['In Progress'], closed: false },
    in_review: { remote: ['In Review'], closed: false },
    done: { remote: ['Done'], closed: true },
  },
};

function entry(subIssues: boolean): ConformanceEntry {
  return {
    name: 'github',
    provider: githubProvider,
    connection: { repo: 'acme/payments', base_url: 'https://api.github.com' },
    mapping: MAPPING,
    pull: providerPull(githubProvider, MAPPING, { parentIdOf: githubParentIdOf }),
    trackerCapabilities: { subIssues },
  };
}

/** programme > epic > feature > story > sub-task — five levels. */
function plantDeepTree(paths: BoardPaths) {
  const program = createIssue(loadBoard(paths), { type: 'program', title: 'Programme' });
  const epic = createIssue(loadBoard(paths), { type: 'epic', title: 'Epic', parentId: program.id });
  const feature = createIssue(loadBoard(paths), { type: 'feature', title: 'Feature', parentId: epic.id });
  const story = createIssue(loadBoard(paths), {
    type: 'user_story',
    title: 'Story',
    parentId: feature.id,
  });
  const subTask = createIssue(loadBoard(paths), {
    type: 'sub_task',
    title: 'Sub-task',
    parentId: story.id,
  });
  return { program, epic, feature, story, subTask };
}

/** A board's tree, as title + parent title + type — the round-trip's "identical" claim. */
function treeShape(paths: BoardPaths) {
  const board = loadBoard(paths);
  const issues = toSnapshot(board).issues;
  const byId = new Map(issues.map((i) => [i.id, i]));
  return issues
    .map((issue) => ({
      title: issue.title,
      type: issue.type,
      parent: issue.parentId ? byId.get(issue.parentId)?.title ?? null : null,
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** Push a planted board and fail the test on any op that did not land. */
async function pushAll(h: ConformanceHarness) {
  const board = h.reload();
  const plan = planPush(viewOf(board), h.store, h.snapshot());
  const result = await executePush(board, h.opened, h.connector, h.store, plan.ops, {
    hierarchy: h.hierarchy,
  });
  expect(result.failed).toEqual([]);
  expect(result.skipped).toEqual([]);
  return result;
}

/** Pull everything from a shared tracker into a fresh board and return it. */
async function pullFresh(producer: ConformanceHarness, e: ConformanceEntry) {
  const consumer = await buildHarness(e, { tracker: producer.tracker });
  const plan = planPull(consumer.view(), consumer.store, consumer.snapshot(), consumer.pullOptions);
  const result = applyPull(consumer.paths, e.name, consumer.store, plan);
  expect(result.failures).toEqual([]);
  return consumer;
}

// ---------------------------------------------------------------------------
// The pure decision
// ---------------------------------------------------------------------------

describe('resolveHierarchyEncoding', () => {
  it('reads a flat capability as labels', () => {
    const resolved = resolveHierarchyEncoding({ hierarchyDepth: 0 }, HIERARCHY);
    expect(resolved.kind).toBe('labels');
    expect(resolved.nativeDepth).toBe(1);
    expect(resolved.degraded.map((level) => level.depth)).toEqual([1, 2, 3, 4]);
  });

  it('reads one native parent level as sub-issues', () => {
    const resolved = resolveHierarchyEncoding({ hierarchyDepth: 1 }, HIERARCHY);
    expect(resolved.kind).toBe('sub-issues');
    expect(resolved.nativeDepth).toBe(2);
    expect(resolved.degraded.map((level) => level.depth)).toEqual([2, 3, 4]);
  });

  it('lets --hierarchy force labels over a sub-issues capability', () => {
    const resolved = resolveHierarchyEncoding({ hierarchyDepth: 1 }, HIERARCHY, {
      force: 'labels',
    });
    expect(resolved.kind).toBe('labels');
    expect(resolved.nativeDepth).toBe(1);
  });

  it('lets --hierarchy force sub-issues over a flat capability', () => {
    const resolved = resolveHierarchyEncoding({ hierarchyDepth: 0 }, HIERARCHY, {
      force: 'sub-issues',
    });
    expect(resolved.kind).toBe('sub-issues');
    expect(resolved.nativeDepth).toBe(2);
  });
});

describe('parentIsNative', () => {
  it('covers the native span only', () => {
    // sub-issues, root-anchored: nativeDepth 2 → depth 1 native, 2+ degraded.
    const one = resolveHierarchyEncoding({ hierarchyDepth: 1 }, HIERARCHY);
    expect(parentIsNative(0, one)).toBe(false);
    expect(parentIsNative(1, one)).toBe(true);
    expect(parentIsNative(2, one)).toBe(false);
    // labels: nothing has a native parent.
    const flat = resolveHierarchyEncoding({ hierarchyDepth: 0 }, HIERARCHY);
    expect(parentIsNative(1, flat)).toBe(false);
    expect(parentIsNative(2, flat)).toBe(false);
  });
});

describe('a leaf-anchored hierarchy (Jira)', () => {
  // HIERARCHY is five levels deep (0..4).
  it('spends the native chain on the deepest levels, not the shallowest', () => {
    // Jira: `Subtask` < standard < `Epic`, so a probe of 2 means three levels
    // nest — and they are the *bottom* three. Anchored at the root instead,
    // the native edge lands on the two levels Jira refuses (an Epic may not sit
    // under an Epic) and the work items degrade, which files a flat board.
    const resolved = resolveHierarchyEncoding(
      { hierarchyDepth: 2, hierarchyAnchor: 'leaf' },
      HIERARCHY,
    );
    expect(resolved.anchor).toBe('leaf');
    expect(resolved.nativeFrom).toBe(3);
    expect(resolved.nativeTo).toBe(4);
    // The work items and the sub-tasks nest natively…
    expect(parentIsNative(3, resolved)).toBe(true);
    expect(parentIsNative(4, resolved)).toBe(true);
    // …and everything above rides the block.
    expect(parentIsNative(1, resolved)).toBe(false);
    expect(parentIsNative(2, resolved)).toBe(false);
    expect(resolved.degraded.map((level) => level.depth)).toEqual([1, 2]);
  });

  it('leaves a root-anchored provider exactly as it was', () => {
    const resolved = resolveHierarchyEncoding({ hierarchyDepth: 2 }, HIERARCHY);
    expect(resolved.anchor).toBe('root');
    expect(resolved.nativeFrom).toBe(1);
    expect(resolved.nativeTo).toBe(2);
    expect(resolved.degraded.map((level) => level.depth)).toEqual([3, 4]);
  });

  it('detects the anchor change as a carrier switch, so twins migrate', () => {
    // A board filed root-anchored and re-pushed leaf-anchored must re-parent,
    // not sit half one way and half the other.
    const leaf = resolveHierarchyEncoding({ hierarchyDepth: 2, hierarchyAnchor: 'leaf' }, HIERARCHY);
    const wasRoot = { kind: 'sub-issues' as const, nativeDepth: 3, anchor: 'root' as const };
    expect(carrierChanged(wasRoot, leaf, 1)).toBe(true);
    expect(carrierChanged(wasRoot, leaf, 3)).toBe(true);
    expect(carrierChanged(recordOf(leaf), leaf, 3)).toBe(false);
  });
});

describe('the block parent carrier', () => {
  it('writes and reads the remote parent id through the managed block', () => {
    const entry = parentBlockEntry('99');
    expect(entry).toEqual({ name: PARENT_FIELD, kind: 'text', value: '99' });

    // Round-trip through the body codec.
    const body = applyManagedBlock('As a user…', [entry]);
    expect(parentRemoteIdFromBlock(body)).toBe('99');
  });

  it('reads undefined when there is no block or no parent row', () => {
    expect(parentRemoteIdFromBlock('plain prose')).toBeUndefined();
    const body = applyManagedBlock('prose', [{ name: 'type', kind: 'text', value: 'epic' }]);
    expect(parentRemoteIdFromBlock(body)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The two encodings, end to end
// ---------------------------------------------------------------------------

describe('a five-level board round-trips', () => {
  it('under labels: every parent rides the managed block, type rides a label', async () => {
    const e = entry(false);
    const producer = await buildHarness(e);
    const { epic, feature, story, subTask } = plantDeepTree(producer.paths);

    const before = treeShape(producer.paths);
    await pushAll(producer);

    // Nothing is a native sub-issue (the tracker holds no `parent` field), and
    // every non-root issue carries its parent's remote id in the block.
    const records = [...producer.tracker.issues().values()];
    expect(records.every((r) => r.parent === null)).toBe(true);
    const typeLabel: Record<string, string> = {
      [epic.id]: 'epic',
      [feature.id]: 'feature',
      [story.id]: 'story',
      [subTask.id]: 'sub-task',
    };
    for (const [localId, label] of Object.entries(typeLabel)) {
      const remoteId = producer.store.links.get(localId)!.remoteId;
      const record = producer.tracker.issues().get(Number(remoteId))!;
      expect(record.body).toContain('<!-- lpm:begin -->');
      expect(record.body).toContain(`| ${PARENT_FIELD} |`);
      expect(record.labels).toContain(label);
    }

    const consumer = await pullFresh(producer, e);
    expect(treeShape(consumer.paths)).toEqual(before);
  });

  it('under sub-issues: the first level is native, deeper levels use the block', async () => {
    const e = entry(true);
    // Seed one issue so the sub-issues probe sees the `parent` field on a
    // listed record, then drop it before the real tree is filed.
    const producer = await buildHarness(e, {
      seed: [{ number: 1, title: 'probe-seed', parent: null }],
    });
    await producer.tracker.fetch('https://api.github.com/repos/acme/payments/issues/1', {
      method: 'DELETE',
    });
    const { program, epic, feature, story, subTask } = plantDeepTree(producer.paths);

    const before = treeShape(producer.paths);
    await pushAll(producer);

    const parentNumber = Number(producer.store.links.get(program.id)!.remoteId);
    const epicNumber = Number(producer.store.links.get(epic.id)!.remoteId);
    const featureNumber = Number(producer.store.links.get(feature.id)!.remoteId);

    // Depth 1 is a native sub-issue of the programme; depth 2+ keep the block.
    expect(producer.tracker.issues().get(epicNumber)!.parent).toBe(parentNumber);
    expect(producer.tracker.issues().get(featureNumber)!.parent).toBeNull();
    expect(producer.tracker.issues().get(featureNumber)!.body).toContain('<!-- lpm:begin -->');
    expect(producer.tracker.issues().get(featureNumber)!.body).toContain(`| ${PARENT_FIELD} | ${epicNumber} |`);
    for (const localId of [story.id, subTask.id]) {
      const remoteId = producer.store.links.get(localId)!.remoteId;
      expect(producer.tracker.issues().get(Number(remoteId))!.body).toContain('<!-- lpm:begin -->');
    }

    const consumer = await pullFresh(producer, e);
    expect(treeShape(consumer.paths)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Encoding switch: migrated in place, not re-filed
// ---------------------------------------------------------------------------

describe('a switch of encoding', () => {
  it('does not re-file: the correspondence survives the switch', async () => {
    const producer = await buildHarness(entry(false)); // labels
    plantDeepTree(producer.paths);
    await pushAll(producer);

    const linksBefore = [...producer.store.links.entries()].sort(([a], [b]) => a.localeCompare(b));

    // Switch to sub-issues and re-plan against the same board and store. The
    // documents already have twins, so the plan holds no `create` — the ids
    // survive, and no issue is filed a second time.
    const switched = await buildHarness(entry(true), { tracker: producer.tracker });
    const board = producer.reload();
    const plan = planPush(viewOf(board), producer.store, switched.snapshot());

    expect(plan.ops.filter((op) => op.kind === 'create')).toEqual([]);

    // The link store still names the same remote ids.
    const linksAfter = [...producer.store.links.entries()].sort(([a], [b]) => a.localeCompare(b));
    expect(linksAfter.map(([id, link]) => [id, link.remoteId])).toEqual(
      linksBefore.map(([id, link]) => [id, link.remoteId]),
    );
  });

  it('labels → sub-issues is forced through resolveHierarchyEncoding, not the probe', () => {
    const flat = resolveHierarchyEncoding({ hierarchyDepth: 0 }, HIERARCHY, { force: 'sub-issues' });
    expect(flat.kind).toBe('sub-issues');
    const deep = resolveHierarchyEncoding({ hierarchyDepth: 2 }, HIERARCHY, { force: 'labels' });
    expect(deep.kind).toBe('labels');
  });
});

// ---------------------------------------------------------------------------
// LP-493 — encoding switches migrate twins in place, and a local reparent
// reaches the remote through a `reparent` op
// ---------------------------------------------------------------------------

/** Build a sub-issues producer: seed one issue so the probe reads `parent`. */
async function subIssuesHarness() {
  const h = await buildHarness(entry(true), {
    seed: [{ number: 1, title: 'probe-seed', parent: null }],
  });
  await h.tracker.fetch('https://api.github.com/repos/acme/payments/issues/1', {
    method: 'DELETE',
  });
  return h;
}

/** programme > epic A / epic B > feature (under epic A) — two same-depth parents. */
function plantTwoEpics(paths: BoardPaths) {
  const program = createIssue(loadBoard(paths), { type: 'program', title: 'Programme' });
  const epicA = createIssue(loadBoard(paths), { type: 'epic', title: 'Epic A', parentId: program.id });
  const epicB = createIssue(loadBoard(paths), { type: 'epic', title: 'Epic B', parentId: program.id });
  const feature = createIssue(loadBoard(paths), { type: 'feature', title: 'Feature', parentId: epicA.id });
  return { program, epicA, epicB, feature };
}

/** Two programmes, one epic under the first — for a native-carrier reparent. */
function plantTwoProgrammes(paths: BoardPaths) {
  const programA = createIssue(loadBoard(paths), { type: 'program', title: 'Programme A' });
  const programB = createIssue(loadBoard(paths), { type: 'program', title: 'Programme B' });
  const epic = createIssue(loadBoard(paths), { type: 'epic', title: 'Epic', parentId: programA.id });
  return { programA, programB, epic };
}

function reparentOps(ops: readonly RemoteOp[]) {
  return ops.filter((op): op is Extract<RemoteOp, { kind: 'reparent' }> => op.kind === 'reparent');
}

describe('LP-493 — migration and reparenting', () => {
  it('labels → sub-issues: depth-1 twins gain a native edge and drop the block row, in place', async () => {
    const producer = await buildHarness(entry(false)); // labels
    const { program, epic, feature } = plantDeepTree(producer.paths);
    await pushAll(producer);

    const programNumber = Number(producer.store.links.get(program.id)!.remoteId);
    const epicNumber = Number(producer.store.links.get(epic.id)!.remoteId);
    const featureNumber = Number(producer.store.links.get(feature.id)!.remoteId);

    // Labels: the parent rides the block, not a native edge.
    expect(producer.tracker.issues().get(epicNumber)!.body).toContain(`| ${PARENT_FIELD} | ${programNumber} |`);

    // The account gains the sub-issue API.
    producer.tracker.setSubIssues(true);
    const switched = await buildHarness(entry(true), { tracker: producer.tracker });
    const plan = planPush(viewOf(producer.reload()), producer.store, switched.snapshot());

    // No re-file; only the depth-1 epic changes carrier (depth 2+ stay in the block).
    expect(plan.ops.filter((op) => op.kind === 'create')).toEqual([]);
    const reparents = reparentOps(plan.ops);
    expect(reparents).toHaveLength(1);
    expect(reparents[0]).toMatchObject({
      localId: epic.id,
      parent: { kind: 'linked', localId: program.id },
    });

    const result = await executePush(
      producer.reload(),
      producer.opened,
      producer.connector,
      producer.store,
      plan.ops,
      { hierarchy: switched.hierarchy },
    );
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);

    // Native edge set, block row gone; the twin kept its remote id.
    expect(producer.store.links.get(epic.id)!.remoteId).toBe(String(epicNumber));
    expect(producer.tracker.issues().get(epicNumber)!.parent).toBe(programNumber);
    expect(producer.tracker.issues().get(epicNumber)!.body).not.toContain(`| ${PARENT_FIELD} |`);

    // Depth 2 stayed on the block, untouched.
    expect(producer.tracker.issues().get(featureNumber)!.body).toContain('<!-- lpm:begin -->');

    // Idempotent: once recorded, a re-plan finds nothing to migrate.
    expect(producer.store.hierarchy).toEqual({ kind: 'sub-issues', nativeDepth: 2, anchor: 'root' });
    expect(planPush(viewOf(producer.reload()), producer.store, switched.snapshot())).toEqual({
      ops: [],
      skipped: [],
    });
  });

  it('sub-issues → labels: the parent moves into the block and the native edge clears, in place', async () => {
    const producer = await subIssuesHarness();
    const { program, epic } = plantDeepTree(producer.paths);
    await pushAll(producer);

    const programNumber = Number(producer.store.links.get(program.id)!.remoteId);
    const epicNumber = Number(producer.store.links.get(epic.id)!.remoteId);
    expect(producer.tracker.issues().get(epicNumber)!.parent).toBe(programNumber);

    // Force labels even though the account still holds the sub-issue API.
    const switched = await buildHarness(entry(false), { tracker: producer.tracker, force: 'labels' });
    const plan = planPush(viewOf(producer.reload()), producer.store, switched.snapshot());

    expect(plan.ops.filter((op) => op.kind === 'create')).toEqual([]);
    const reparents = reparentOps(plan.ops);
    expect(reparents).toHaveLength(1);
    expect(reparents[0]).toMatchObject({
      localId: epic.id,
      blockParent: { kind: 'linked', localId: program.id },
    });

    const result = await executePush(
      producer.reload(),
      producer.opened,
      producer.connector,
      producer.store,
      plan.ops,
      { hierarchy: switched.hierarchy },
    );
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);

    expect(producer.store.links.get(epic.id)!.remoteId).toBe(String(epicNumber));
    expect(producer.tracker.issues().get(epicNumber)!.parent).toBeNull();
    expect(producer.tracker.issues().get(epicNumber)!.body).toContain(`| ${PARENT_FIELD} | ${programNumber} |`);
  });

  it('a local reparent on a linked board is pushed on the block carrier (AC #4, #5)', async () => {
    const producer = await buildHarness(entry(false)); // labels — every parent rides the block
    const { epicB, feature } = plantTwoEpics(producer.paths);
    await pushAll(producer);

    const epicBNumber = Number(producer.store.links.get(epicB.id)!.remoteId);
    const featureNumber = Number(producer.store.links.get(feature.id)!.remoteId);

    // Reparent the feature from epic A to epic B (same depth: block → block).
    const board = producer.reload();
    moveNode(board, board.byId.get(feature.id)!, { parentId: epicB.id, rollUp: false });

    const plan = planPush(viewOf(producer.reload()), producer.store, producer.snapshot());
    const reparents = reparentOps(plan.ops);
    expect(reparents).toHaveLength(1);
    // Depth 2 is beyond the native depth (labels = nativeDepth 1), so the
    // parent degrades to the managed block — matching `parentRefFor`.
    expect(reparents[0]).toMatchObject({
      localId: feature.id,
      blockParent: { kind: 'linked', localId: epicB.id },
    });

    const result = await executePush(
      producer.reload(),
      producer.opened,
      producer.connector,
      producer.store,
      plan.ops,
      { hierarchy: producer.hierarchy },
    );
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);

    expect(producer.tracker.issues().get(featureNumber)!.body).toContain(`| ${PARENT_FIELD} | ${epicBNumber} |`);

    // Converged: nothing left to push.
    expect(planPush(viewOf(producer.reload()), producer.store, producer.snapshot())).toEqual({
      ops: [],
      skipped: [],
    });
  });

  it('a local reparent under sub-issues is pushed on the native carrier', async () => {
    const producer = await subIssuesHarness();
    const { programB, epic } = plantTwoProgrammes(producer.paths);
    await pushAll(producer);

    const programBNumber = Number(producer.store.links.get(programB.id)!.remoteId);
    const epicNumber = Number(producer.store.links.get(epic.id)!.remoteId);

    const board = producer.reload();
    moveNode(board, board.byId.get(epic.id)!, { parentId: programB.id, rollUp: false });

    const plan = planPush(viewOf(producer.reload()), producer.store, producer.snapshot());
    const reparents = reparentOps(plan.ops);
    expect(reparents).toHaveLength(1);
    expect(reparents[0]).toMatchObject({
      localId: epic.id,
      parent: { kind: 'linked', localId: programB.id },
    });

    const result = await executePush(
      producer.reload(),
      producer.opened,
      producer.connector,
      producer.store,
      plan.ops,
      { hierarchy: producer.hierarchy },
    );
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);

    expect(producer.tracker.issues().get(epicNumber)!.parent).toBe(programBNumber);
  });

  it('a dry-run renders the migration, names each twin, and writes nothing', async () => {
    const producer = await buildHarness(entry(false));
    const { epic } = plantDeepTree(producer.paths);
    await pushAll(producer);
    producer.tracker.setSubIssues(true);
    const switched = await buildHarness(entry(true), { tracker: producer.tracker });

    const board = producer.reload();
    const plan = planPush(viewOf(board), producer.store, switched.snapshot());
    const render = renderPlan({ direction: 'push', ops: plan.ops }, { board: viewOf(board), links: producer.store });

    const section = render.sections.find((s) => s.kind === 'reparent')!;
    expect(section).toBeDefined();
    expect(section.documents.map((doc) => doc.localId)).toContain(epic.id);
    expect(section.documents.map((doc) => doc.title)).toContain('Epic');
    expect(render.text).toContain('reparent');

    // The dry-run made no request: the tracker is exactly as it was.
    const epicNumber = Number(producer.store.links.get(epic.id)!.remoteId);
    expect(producer.tracker.issues().get(epicNumber)!.parent).toBeNull();
    expect(producer.tracker.issues().get(epicNumber)!.body).toContain(`| ${PARENT_FIELD} |`);
  });

  it('a migration interrupted part-way is safe to re-run (idempotent)', async () => {
    const producer = await buildHarness(entry(false));
    const { program, epic } = plantDeepTree(producer.paths);
    await pushAll(producer);
    producer.tracker.setSubIssues(true);

    const programNumber = Number(producer.store.links.get(program.id)!.remoteId);
    const epicNumber = Number(producer.store.links.get(epic.id)!.remoteId);

    // Simulate a crash after the native edge landed but before the block row
    // was removed: set the native parent by hand and leave the recorded
    // encoding pointing at labels.
    producer.tracker.mutateIssue(String(epicNumber), { parent: programNumber });
    expect(producer.store.hierarchy?.kind).toBe('labels');

    const switched = await buildHarness(entry(true), { tracker: producer.tracker });
    const plan = planPush(viewOf(producer.reload()), producer.store, switched.snapshot());
    expect(reparentOps(plan.ops)).toHaveLength(1);

    const result = await executePush(
      producer.reload(),
      producer.opened,
      producer.connector,
      producer.store,
      plan.ops,
      { hierarchy: switched.hierarchy },
    );
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);

    // The native edge (already there) is untouched and the block row is gone.
    expect(producer.tracker.issues().get(epicNumber)!.parent).toBe(programNumber);
    expect(producer.tracker.issues().get(epicNumber)!.body).not.toContain(`| ${PARENT_FIELD} |`);

    // And, recorded now, the migration is not planned a second time.
    expect(producer.store.hierarchy).toEqual({ kind: 'sub-issues', nativeDepth: 2, anchor: 'root' });
    expect(planPush(viewOf(producer.reload()), producer.store, switched.snapshot())).toEqual({
      ops: [],
      skipped: [],
    });
  });
});
