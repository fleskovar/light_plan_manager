/**
 * LP-314 — dependencies and relates edges in the managed block, as `#418`
 * references a person reading GitHub can click.
 *
 * GitHub holds no native `depends_on` / `relates_to` edge, so both ride the
 * managed block: the push writes a `| depends_on | #418 |` row per edge, and
 * the pull resolves `#418` back to a local id through the link store.  The
 * scenarios here drive the real provider end to end, exactly like the
 * conformance suite — the in-memory tracker stands in for GitHub.
 */

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createIssue, loadBoard } from '../src/core/index.js';
import { applyPull, executePush, planPull, planPush } from '../src/remote/index.js';
import { githubBlockEdgesOf, githubParentIdOf, githubProvider } from '../src/remote/providers/github/index.js';
import { toSnapshot } from '../src/sync/index.js';
import { cleanupBoards } from './helpers.js';
import {
  buildHarness,
  providerPull,
  viewOf,
  type ConformanceEntry,
} from './support/provider-conformance.js';

afterAll(cleanupBoards);
afterEach(() => vi.unstubAllGlobals());

const MAPPING: Record<string, unknown> = {
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

const entry: ConformanceEntry = {
  name: 'github',
  provider: githubProvider,
  connection: { repo: 'acme/payments', base_url: 'https://api.github.com' },
  mapping: MAPPING,
  pull: providerPull(githubProvider, MAPPING, {
    parentIdOf: githubParentIdOf,
    blockEdgesOf: githubBlockEdgesOf,
  }),
};

describe('managed-block edges (LP-314)', () => {
  it('writes depends_on and relates_to as `#<n>` references in the block', async () => {
    const h = await buildHarness(entry);
    const paths = h.paths;
    const a = createIssue(loadBoard(paths), { type: 'program', title: 'A' });
    const b = createIssue(loadBoard(paths), {
      type: 'program',
      title: 'B',
      dependsOn: [a.id],
      relatesTo: [a.id],
    });

    const board = loadBoard(paths);
    const plan = planPush(viewOf(board), h.store, h.snapshot());
    expect(plan.ops.some((op) => op.kind === 'edges')).toBe(true);

    const result = await executePush(board, h.opened, h.connector, h.store, plan.ops);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);

    const aRemote = h.store.links.get(a.id)!.remoteId;
    const record = h.tracker.issues().get(Number(h.store.links.get(b.id)!.remoteId))!;
    expect(record.body).toContain('<!-- lpm:begin -->');
    expect(record.body).toContain(`| depends_on | #${aRemote} |`);
    expect(record.body).toContain(`| relates_to | #${aRemote} |`);
    // A native edge never reached the (flat) tracker.
    expect(h.tracker.dependencies(Number(h.store.links.get(b.id)!.remoteId))).toEqual([]);
  });

  it('never writes a dangling local id: an unfiled dependency is omitted, then written on the next pass', async () => {
    const h = await buildHarness(entry);
    const paths = h.paths;
    const a = createIssue(loadBoard(paths), { type: 'program', title: 'A' });
    const b = createIssue(loadBoard(paths), { type: 'program', title: 'B', dependsOn: [a.id] });

    // A's create fails; B still files, but its block may not reference A.
    h.tracker.failNext({ status: 500 });
    let board = loadBoard(paths);
    let result = await executePush(
      board,
      h.opened,
      h.connector,
      h.store,
      planPush(viewOf(board), h.store, h.snapshot()).ops,
    );
    expect(result.failed).toHaveLength(1); // A's create
    expect(result.skipped.some((op) => op.kind === 'edges')).toBe(true);

    const bRecord = h.tracker.issues().get(Number(h.store.links.get(b.id)!.remoteId))!;
    expect(bRecord.body).not.toContain('depends_on');
    expect(bRecord.body).not.toContain(`#${h.store.links.get(a.id)?.remoteId}`);

    // The next pass: A files, and B's row is written once the number exists.
    board = loadBoard(paths);
    result = await executePush(
      board,
      h.opened,
      h.connector,
      h.store,
      planPush(viewOf(board), h.store, h.snapshot()).ops,
    );
    expect(result.failed).toEqual([]);
    const aRemote = h.store.links.get(a.id)!.remoteId;
    const after = h.tracker.issues().get(Number(h.store.links.get(b.id)!.remoteId))!;
    expect(after.body).toContain(`| depends_on | #${aRemote} |`);
  });

  it('pulls a `#<n>` row back to a local id, and reports cross-repo and unknown references', async () => {
    const h = await buildHarness(entry, {
      seed: [
        { number: 1, title: 'Programme A', labels: ['program', 'Backlog'] },
        {
          number: 2,
          title: 'Programme B',
          labels: ['program', 'Backlog'],
          body: [
            'prose',
            '',
            '<!-- lpm:begin -->',
            '| light-plan | |',
            '| --- | --- |',
            '| depends_on | #1, acme/other#9, LP-404 |',
            '| relates_to | #1 |',
            '<!-- lpm:end -->',
          ].join('\n'),
        },
      ],
    });

    const plan = planPull(h.view(), h.store, h.snapshot(), h.pullOptions);
    const applied = applyPull(h.paths, entry.name, h.store, plan);
    expect(applied.failures).toEqual([]);

    const a = h.reload().issues.find((issue) => issue.title === 'Programme A')!;
    const b = h.reload().issues.find((issue) => issue.title === 'Programme B')!;
    expect(b.depends_on).toEqual([a.id]);
    expect(b.relates_to).toEqual([a.id]);

    // Cross-repo and unknown references are reported, never mangled into a
    // local id.
    expect(plan.edgeWarnings).toEqual([
      { remoteId: '2', field: 'depends_on', reference: 'acme/other#9', kind: 'cross_repo' },
      { remoteId: '2', field: 'depends_on', reference: 'LP-404', kind: 'unknown' },
    ]);
  });

  it('converges: a board pushed then pulled plans nothing', async () => {
    const h = await buildHarness(entry);
    const paths = h.paths;
    const a = createIssue(loadBoard(paths), { type: 'program', title: 'A' });
    createIssue(loadBoard(paths), { type: 'program', title: 'B', dependsOn: [a.id] });

    const board = loadBoard(paths);
    const pushed = await executePush(
      board,
      h.opened,
      h.connector,
      h.store,
      planPush(viewOf(board), h.store, h.snapshot()).ops,
    );
    expect(pushed.failed).toEqual([]);

    const view = () => viewOf(loadBoard(paths));
    expect(planPush(view(), h.store, h.snapshot())).toEqual({ ops: [], skipped: [] });
    expect(planPull(view(), h.store, h.snapshot(), h.pullOptions)).toEqual({
      changes: [],
      links: [],
    });
  });

  it('leaves a cross-repository reference in the block alone on pull, without touching it', async () => {
    const h = await buildHarness(entry, {
      seed: [
        {
          number: 3,
          title: 'Cross-repo consumer',
          labels: ['program', 'Backlog'],
          body: [
            'prose',
            '',
            '<!-- lpm:begin -->',
            '| light-plan | |',
            '| --- | --- |',
            '| depends_on | acme/other#12 |',
            '<!-- lpm:end -->',
          ].join('\n'),
        },
      ],
    });

    const plan = planPull(h.view(), h.store, h.snapshot(), h.pullOptions);
    applyPull(h.paths, entry.name, h.store, plan);

    const pulled = h.reload().issues.find((issue) => issue.title === 'Cross-repo consumer')!;
    expect(pulled.depends_on).toEqual([]); // out of scope, never a local id
    expect(plan.edgeWarnings).toEqual([
      { remoteId: '3', field: 'depends_on', reference: 'acme/other#12', kind: 'cross_repo' },
    ]);
  });
});
