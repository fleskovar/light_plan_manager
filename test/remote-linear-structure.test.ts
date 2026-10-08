/**
 * LP-334 — map sub-issues, relations and cycles onto the board's structure.
 *
 * The Linear-specific half of "the same plan the canvas draws": the direction
 * of the native `blocks` relation (LP-334 AC #1), the symmetric `related`
 * relation (AC #2), sub-issues for one level with the managed block for the
 * rest (AC #3), cycles by name (AC #4) and the one-team-per-remote preflight
 * (AC #5). The shared machinery — the hierarchy encoding, the edge planner,
 * the period mapping — is tested in `remote-hierarchy`, `remote-edges`,
 * `remote-periods` and the conformance suite; this file pins down the Linear
 * spellings of each.
 */

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { createIssue, createPeriod } from '../src/core/index.js';
import { checkRemoteConfiguration } from '../src/remote/check.js';
import { executePush } from '../src/remote/index.js';
import { planPull, planPush } from '../src/remote/plan.js';
import { applyPull } from '../src/remote/pull.js';
import { linearConnector } from '../src/remote/providers/linear/connector.js';
import {
  linearDependsOnOf,
  linearParentIdOf,
  linearProvider,
  linearRelatesToOf,
} from '../src/remote/providers/linear/index.js';
import { toSnapshot } from '../src/sync/index.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';
import {
  buildHarness,
  plantTree,
  providerPull,
  viewOf,
  type ConformanceEntry,
} from './support/provider-conformance.js';

afterAll(cleanupBoards);
afterEach(() => {
  vi.unstubAllGlobals();
});

/** The Linear mapping the suite uses, optionally with a cycle container. */
function linearEntry(extra: Record<string, unknown> = {}): ConformanceEntry {
  const mapping: Record<string, unknown> = {
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
    ...extra,
  };
  return {
    name: 'linear',
    provider: linearProvider,
    connection: { team: 'ENG', base_url: 'https://api.linear.app' },
    mapping,
    pull: providerPull(linearProvider, mapping, {
      parentIdOf: linearParentIdOf,
      dependsOnOf: linearDependsOnOf,
      relatesToOf: linearRelatesToOf,
    }),
    recordsOf: (tracker) => tracker.linearRecords(),
    remoteIdOf: (record) => String(record.id ?? ''),
  };
}

/** Push a planted board and fail the test on any op that did not land. */
async function pushAll(h: Awaited<ReturnType<typeof buildHarness>>) {
  const board = h.reload();
  const result = await executePush(
    board,
    h.opened,
    h.connector,
    h.store,
    planPush(viewOf(board), h.store, h.snapshot()).ops,
  );
  expect(result.failed).toEqual([]);
  expect(result.skipped).toEqual([]);
  return result;
}

// ---------------------------------------------------------------------------
// The relation direction (AC #1, AC #2)
// ---------------------------------------------------------------------------

describe('the Linear connector relation direction', () => {
  it('links depends_on as "dependency blocks dependent" (LP-334)', async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> });
        return new Response(
          JSON.stringify({ data: { issueRelationCreate: { success: true } } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const connector = linearConnector({ team: 'ENG' });

    await connector.link!('story-id', 'feature-id', undefined, 'depends');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.query).toContain('issueRelationCreate');
    // Linear reads "issueId blocks relatedIssueId": the *dependency* is the
    // blocker, the *dependent* is the blocked issue.
    expect(calls[0]!.variables.input).toEqual({
      issueId: 'feature-id',
      relatedIssueId: 'story-id',
      type: 'blocks',
    });
  });

  it('links relates_to as a "related" relation, dependent leading', async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> });
        return new Response(
          JSON.stringify({ data: { issueRelationCreate: { success: true } } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const connector = linearConnector({ team: 'ENG' });

    await connector.link!('a-id', 'b-id', undefined, 'relates');

    expect(calls[0]!.variables.input).toEqual({
      issueId: 'a-id',
      relatedIssueId: 'b-id',
      type: 'related',
    });
  });

  it('unlinks the blocks relation by the corrected direction', async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
        calls.push(body);
        if (body.query.includes('issue(id: $id)')) {
          return new Response(
            JSON.stringify({
              data: {
                issue: {
                  id: 'story-id',
                  relations: { nodes: [] },
                  inverseRelations: {
                    nodes: [
                      {
                        id: 'rel-feature-id-blocks-story-id',
                        type: 'blocks',
                        issue: { id: 'feature-id' },
                        relatedIssue: { id: 'story-id' },
                      },
                    ],
                  },
                },
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({ data: { issueRelationDelete: { success: true } } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const connector = linearConnector({ team: 'ENG' });

    await connector.unlink!('story-id', 'feature-id', undefined, 'depends');

    const del = calls.find((call) => call.query.includes('issueRelationDelete'));
    expect(del?.variables).toEqual({ id: 'rel-feature-id-blocks-story-id' });
  });
});

// ---------------------------------------------------------------------------
// The edges end to end (AC #1, AC #2)
// ---------------------------------------------------------------------------

describe('Linear edges round-trip', () => {
  it('pushes relates_to as a related relation and pulls it back', async () => {
    const entry = linearEntry();
    const producer = await buildHarness(entry);
    const a = createIssue(producer.reload(), { type: 'program', title: 'A' });
    const b = createIssue(producer.reload(), { type: 'program', title: 'B', relatesTo: [a.id] });
    await pushAll(producer);

    const aRemote = Number(producer.store.links.get(a.id)!.remoteId);
    const bRemote = Number(producer.store.links.get(b.id)!.remoteId);
    // The `related` relation is stored on its source (B), naming A.
    expect(producer.tracker.issues().get(bRemote)?.related).toEqual([aRemote]);

    // A fresh board pulls both issues and recovers B's relates_to edge.
    const consumer = await buildHarness(entry, { tracker: producer.tracker });
    const plan = planPull(consumer.view(), consumer.store, consumer.snapshot(), consumer.pullOptions);
    const applied = applyPull(consumer.paths, 'linear', consumer.store, plan);
    expect(applied.failures).toEqual([]);

    const pulledB = consumer.reload().issues.find((issue) => issue.title === 'B')!;
    const pulledA = consumer.reload().issues.find((issue) => issue.title === 'A')!;
    expect(pulledB.relates_to).toEqual([pulledA.id]);
  });

  it('pushes depends_on so the dependency blocks the dependent', async () => {
    const entry = linearEntry();
    const h = await buildHarness(entry);
    const { feature, story } = plantTree(h.paths, { edge: true });
    await pushAll(h);

    const featureRemote = Number(h.store.links.get(feature.id)!.remoteId);
    const storyRemote = Number(h.store.links.get(story.id)!.remoteId);
    // The dependent (story) records the dependency (feature) as its blocker.
    expect(h.tracker.dependencies(storyRemote)).toEqual([featureRemote]);
    // And the pull seam reads the blocker out of `inverseRelations`.
    const record = h.tracker.linearRecords().find((r) => String(r.id) === String(storyRemote))!;
    expect(linearDependsOnOf(record)).toEqual([String(featureRemote)]);
  });
});

// ---------------------------------------------------------------------------
// Hierarchy: sub-issues for one level, the managed block beyond (AC #3)
// ---------------------------------------------------------------------------

describe('Linear hierarchy encoding', () => {
  it('files depth 1 as a native sub-issue and depth 2+ in the managed block', async () => {
    const entry = linearEntry();
    const producer = await buildHarness(entry);
    const { program, epic, feature, story } = plantTree(producer.paths);

    const before = treeShape(producer.paths);
    await pushAll(producer);

    const programRemote = Number(producer.store.links.get(program.id)!.remoteId);
    const epicRemote = Number(producer.store.links.get(epic.id)!.remoteId);
    const featureRemote = Number(producer.store.links.get(feature.id)!.remoteId);
    const storyRemote = Number(producer.store.links.get(story.id)!.remoteId);

    // `hierarchyDepth: 1` → one native parent edge (issue › sub-issue): the
    // epic is a sub-issue of the programme, everything deeper rides the block.
    expect(producer.tracker.issues().get(epicRemote)!.parent).toBe(programRemote);
    expect(producer.tracker.issues().get(featureRemote)!.parent).toBeNull();
    expect(producer.tracker.issues().get(featureRemote)!.body).toContain('<!-- lpm:begin -->');
    expect(producer.tracker.issues().get(featureRemote)!.body).toContain(`| parent | ${epicRemote} |`);
    expect(producer.tracker.issues().get(storyRemote)!.body).toContain('<!-- lpm:begin -->');

    // The tree round-trips through a fresh board.
    const consumer = await buildHarness(entry, { tracker: producer.tracker });
    const plan = planPull(consumer.view(), consumer.store, consumer.snapshot(), consumer.pullOptions);
    expect(applyPull(consumer.paths, 'linear', consumer.store, plan).failures).toEqual([]);
    expect(treeShape(consumer.paths)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Cycles by name (AC #4)
// ---------------------------------------------------------------------------

describe('Linear cycle mapping', () => {
  it('schedules into a cycle by name and recovers the period on pull', async () => {
    const entry = linearEntry({ periods: { container: 'sprint' } });
    const h = await buildHarness(entry);
    const increment = createPeriod(h.reload(), {
      type: 'increment',
      title: 'PI-1',
      starts: '2026-08-01',
      ends: '2026-09-30',
    });
    const sprint12 = createPeriod(h.reload(), {
      type: 'sprint',
      title: 'Cycle 12',
      starts: '2026-08-16',
      ends: '2026-08-29',
      parentId: increment.id,
    });
    const sprint13 = createPeriod(h.reload(), {
      type: 'sprint',
      title: 'Cycle 13',
      starts: '2026-08-30',
      ends: '2026-09-12',
      parentId: increment.id,
    });
    const story = createIssue(h.reload(), {
      type: 'program',
      title: 'Programme',
      period: sprint12.id,
    });
    await pushAll(h);

    const storyRemote = Number(h.store.links.get(story.id)!.remoteId);
    // The push wrote the period's title as the cycle id (the name stands in
    // for the UUID the resolution layer will resolve — LP-334).
    expect(h.tracker.issues().get(storyRemote)?.cycle?.name).toBe('Cycle 12');

    // A human moves the issue to the next cycle in Linear; the pull recovers
    // the new period by name. The pull options must be bound to the board as
    // it stands now (periods included), not the one captured at build time.
    h.tracker.mutateIssue(String(storyRemote), { cycle: { name: 'Cycle 13' } });
    const pullOptions = entry.pull(h.reload());
    const plan = planPull(h.view(), h.store, h.snapshot(), pullOptions);
    expect(plan.changes).toContainEqual({
      kind: 'update',
      id: story.id,
      nodeKind: 'issue',
      patch: { period: sprint13.id },
    });
    expect(applyPull(h.paths, 'linear', h.store, plan).failures).toEqual([]);
    expect(h.reload().byId.get(story.id)!.period).toBe(sprint13.id);
  });
});

// ---------------------------------------------------------------------------
// One team per remote (AC #5)
// ---------------------------------------------------------------------------

describe('the one-team-per-remote preflight', () => {
  const remotesBlock = (team: string) => `
remotes:
  upstream:
    provider: linear
    on_delete: unlink
    conflict: manual
    connection:
      team: ${team}
    mapping:
      statuses: { backlog: Backlog, done: { remote: Done, closed: true } }
`;

  it('refuses a remote naming several teams', () => {
    const paths = makeBoard('scrum', 'LP');
    writeFileSync(paths.configPath, `${readFileSync(paths.configPath, 'utf8')}${remotesBlock('[ENG, DES]')}`, 'utf8');
    const messages = checkRemoteConfiguration(reload(paths)).map((problem) => problem.message);
    expect(messages).toContain(
      'remotes.upstream.connection.team: a Linear remote names one team — declare one remote per team',
    );
  });

  it('refuses a comma-separated team list too', () => {
    const paths = makeBoard('scrum', 'LP');
    writeFileSync(paths.configPath, `${readFileSync(paths.configPath, 'utf8')}${remotesBlock('ENG, DES')}`, 'utf8');
    const messages = checkRemoteConfiguration(reload(paths)).map((problem) => problem.message);
    expect(messages).toContain(
      'remotes.upstream.connection.team: a Linear remote names one team — declare one remote per team',
    );
  });

  it('is silent on a single team', () => {
    const paths = makeBoard('scrum', 'LP');
    writeFileSync(paths.configPath, `${readFileSync(paths.configPath, 'utf8')}${remotesBlock('ENG')}`, 'utf8');
    const messages = checkRemoteConfiguration(reload(paths)).map((problem) => problem.message);
    expect(messages.filter((message) => message.includes('connection.team'))).toEqual([]);
  });
});

/** A board's tree as title + parent title + type, for the round-trip claim. */
function treeShape(paths: ReturnType<typeof makeBoard>) {
  const board = reload(paths);
  const issues = toSnapshot(board).issues;
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  return issues
    .map((issue) => ({
      title: issue.title,
      type: issue.type,
      parent: issue.parentId ? byId.get(issue.parentId)?.title ?? null : null,
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
}
