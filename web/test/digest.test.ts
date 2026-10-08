import { describe, expect, it } from 'vitest';
import type { PeriodDto } from '$shared';
import { currentFocus, latestIssues, openPathways } from '$features/welcome/digest.js';
import { board, config, issue, period } from './fixtures.js';

/**
 * A quarter with two sprints, and a graph with one edge that crosses a feature
 * boundary — which is what tells "what is in this sprint?" and "what could be
 * started?" apart:
 *
 *   PI  Jan 1 .. Mar 31
 *     SP1  Jan 1 .. Jan 14    S1 done, S2 in progress, S3 waits on S2, S4, S7
 *     SP2  Jan 15 .. Jan 28   S5
 *
 *   P > E1 > F1 > S1..S4, S7
 *          > F2 > S5
 *      > E2 > F3 > S6, which waits on S4
 */
const sample = () =>
  board(
    period('PI', '2026-01-01', '2026-03-31', null, 'increment'),
    period('SP1', '2026-01-01', '2026-01-14', 'PI'),
    period('SP2', '2026-01-15', '2026-01-28', 'PI'),
    issue('P', 'program', null, { created: '2026-01-01' }),
    issue('E1', 'epic', 'P', { created: '2026-01-02' }),
    issue('E2', 'epic', 'P', { created: '2026-01-02' }),
    issue('F1', 'feature', 'E1', { created: '2026-01-03' }),
    issue('F2', 'feature', 'E1', { created: '2026-01-03' }),
    issue('F3', 'feature', 'E2', { created: '2026-01-03' }),
    issue('S1', 'user_story', 'F1', { period: 'SP1', status: 'done', created: '2026-01-04' }),
    issue('S2', 'user_story', 'F1', {
      period: 'SP1',
      status: 'in_progress',
      created: '2026-01-05',
      attributes: { story_points: 3 },
    }),
    issue('S3', 'user_story', 'F1', { period: 'SP1', dependsOn: ['S2'], created: '2026-01-06' }),
    issue('S4', 'user_story', 'F1', {
      period: 'SP1',
      created: '2026-01-07',
      attributes: { priority: 'high', story_points: 5 },
    }),
    issue('S7', 'user_story', 'F1', {
      period: 'SP1',
      created: '2026-01-08',
      attributes: { priority: 'medium' },
    }),
    issue('S5', 'user_story', 'F2', { period: 'SP2', created: '2026-01-09' }),
    issue('S6', 'user_story', 'F3', { dependsOn: ['S4'], created: '2026-01-10' }),
  );

const TODAY = '2026-01-07';
const focus = (today = TODAY) => currentFocus(sample(), config, { today });
const ids = (entries: { issue: { id: string } }[]): string[] => entries.map((one) => one.issue.id);

describe('currentFocus', () => {
  it('takes the deepest period covering today, and the increment holding it', () => {
    const now = focus();
    expect([now.increment?.id, now.sprint?.id]).toEqual(['PI', 'SP1']);
    expect(now.upcoming).toBe(false);
  });

  it('falls back to the next period to start, and says so', () => {
    const soon = focus('2025-12-01');
    expect([soon.increment?.id, soon.sprint?.id]).toEqual(['PI', 'SP1']);
    expect(soon.upcoming).toBe(true);
  });

  /**
   * The landing page and the periods view must not disagree about what is now,
   * so the digest reads the switch through the same `isRunning` they do.
   */
  it('stops pointing at a sprint somebody switched off', () => {
    const nodes = sample();
    nodes.SP1 = { ...(nodes.SP1 as PeriodDto), active: false };
    const parked = currentFocus(nodes, config, { today: TODAY });

    // The quarter is the deepest thing still running, so it takes over.
    expect(parked.increment?.id).toBe('PI');
    expect(parked.sprint).toBeNull();
    // And the parked sprint's work does not resurface under it: only S5, in
    // SP2, is left. Parking a sprint puts its work away rather than up a level.
    expect(parked.open).toBe(1);
    expect(parked.ready.map((entry) => entry.issue.id)).toEqual(['S5']);
  });

  it('takes a sprint switched on before its dates as now', () => {
    const nodes = sample();
    nodes.SP2 = { ...(nodes.SP2 as PeriodDto), active: true };
    const forced = currentFocus(nodes, config, { today: TODAY });
    // SP2 is deeper-or-equal and switched on, so both are running; the deepest
    // one covering today still wins, which is SP1.
    expect(forced.sprint?.id).toBe('SP1');

    // With SP1 out of the way, the switched-on sprint is what is running.
    nodes.SP1 = { ...(nodes.SP1 as PeriodDto), active: false };
    const only = currentFocus(nodes, config, { today: TODAY });
    expect(only.sprint?.id).toBe('SP2');
    expect(only.upcoming).toBe(false);
  });

  it('has nothing to show for a board whose periods carry no dates', () => {
    const undated = currentFocus(board(issue('X', 'program', null)), config, { today: TODAY });
    expect([undated.increment, undated.sprint, undated.ready]).toEqual([null, null, []]);
  });

  it('counts the open leaves of the sprint, and leaves the finished ones out', () => {
    const now = focus();
    // S1 is done; S2, S3, S4 and S7 are not.
    expect(now.open).toBe(4);
    expect(now.effort).toBe(8);
  });

  it('separates what is under way from what could be started', () => {
    const now = focus();
    expect(ids(now.active)).toEqual(['S2']);
    // S3 waits on S2, so it is neither ready nor silently dropped.
    expect(now.blocked).toBe(1);
  });

  it('offers the higher priority story first', () => {
    expect(ids(focus().ready)).toEqual(['S4', 'S7']);
  });

  it('offers the feature already under way before an untouched one', () => {
    // Both features are in the running sprint and nothing separates their
    // stories by priority or column — so the half-built one leads, exactly as
    // the queue board and `lpm task next` order it.
    const nodes = board(
      period('PI', '2026-01-01', '2026-03-31', null, 'increment'),
      period('SP1', '2026-01-01', '2026-01-14', 'PI'),
      issue('E', 'epic', null),
      issue('FA', 'feature', 'E'),
      issue('FB', 'feature', 'E'),
      issue('B1', 'user_story', 'FB', { period: 'SP1' }),
      issue('B2', 'user_story', 'FB', { period: 'SP1' }),
      issue('A1', 'user_story', 'FA', { period: 'SP1', status: 'done' }),
      issue('A2', 'user_story', 'FA', { period: 'SP1' }),
    );

    expect(ids(currentFocus(nodes, config, { today: TODAY }).ready)).toEqual(['A2', 'B1', 'B2']);
  });

  it('reads the whole tree of a period, not just its own issues', () => {
    // Nothing is scheduled in the increment itself; its sprints hold the work.
    const wide = currentFocus(sample(), config, { today: '2026-02-01' });
    expect(wide.sprint).toBeNull();
    expect(wide.increment?.id).toBe('PI');
    expect(wide.open).toBe(5);
  });

  it('looks past a sprint with nothing left in it', () => {
    // Every open issue in the sample sits in SP1 except S5, which is in SP2.
    const nodes = sample();
    for (const id of ['S2', 'S3', 'S4', 'S7']) (nodes[id] as { status: string }).status = 'done';

    const now = currentFocus(nodes, config, { today: TODAY });
    // SP1 is running but finished, so the queue shown is the next sprint's...
    expect(now.sprint?.id).toBe('SP2');
    expect(ids(now.ready)).toEqual(['S5']);
    // ...and the card says so rather than pretending it is under way.
    expect(now.upcoming).toBe(true);
  });

  it('still names the running period when the whole plan is finished', () => {
    const nodes = sample();
    for (const node of Object.values(nodes)) {
      if (node.kind === 'issue') (node as { status: string }).status = 'done';
    }
    const now = currentFocus(nodes, config, { today: TODAY });
    expect(now.sprint?.id).toBe('SP1');
    expect(now.upcoming).toBe(false);
    expect([now.open, now.ready.length]).toEqual([0, 0]);
  });

  it('keeps the list short enough to read', () => {
    expect(currentFocus(sample(), config, { today: TODAY, limit: 1 }).ready).toHaveLength(1);
  });
});

describe('latestIssues', () => {
  it('is newest first, by when the board wrote them', () => {
    expect(latestIssues(sample(), 3).map((one) => one.id)).toEqual(['S6', 'S5', 'S7']);
  });

  it('falls back to the id order for documents with no stamp', () => {
    const nodes = board(issue('LP-1', 'program', null), issue('LP-2', 'program', null));
    expect(latestIssues(nodes).map((one) => one.id)).toEqual(['LP-2', 'LP-1']);
  });
});

describe('openPathways', () => {
  it('offers the containers whose blockers are all done, concrete ones first', () => {
    // F3 waits on S4, which is unfinished, so neither it nor the epic above it
    // can be started; P can, because that dependency is internal to it.
    expect(openPathways(sample(), config).map((one) => one.issue.id)).toEqual([
      'F1',
      'E1',
      'F2',
      'P',
    ]);
  });

  it('reports what starting one would release, and what is left in it', () => {
    const f1 = openPathways(sample(), config).find((one) => one.issue.id === 'F1')!;
    // S1 is done; S2, S3, S4, S7 are open, and S4 and S7 could start today.
    expect([f1.open, f1.ready]).toEqual([4, 2]);
    expect(f1.effort).toBe(8);
    // S6, outside F1, is waiting on S4.
    expect(f1.unblocks).toBe(1);
    expect(f1.started).toBe(true);
  });

  it('leaves out a container with nothing left to do', () => {
    const done = board(
      issue('E', 'epic', null),
      issue('F', 'feature', 'E'),
      issue('S', 'user_story', 'F', { status: 'done' }),
    );
    expect(openPathways(done, config)).toEqual([]);
  });

  it('leaves out a container whose every leaf is waiting on something', () => {
    const stuck = board(
      issue('BLOCKER', 'program', null),
      issue('E', 'epic', null),
      issue('S', 'user_story', 'E', { dependsOn: ['BLOCKER'] }),
    );
    expect(openPathways(stuck, config).map((one) => one.issue.id)).toEqual([]);
  });
});
