import { afterAll, describe, expect, it } from 'vitest';
import type { BoardPaths, LoadedBoard } from '../src/core/index.js';
import {
  createIssue,
  createPeriod,
  createResource,
  findIssue,
  linkIssue,
  moveNode,
  upstreamOf,
} from '../src/core/index.js';
import type { BoardView } from '../src/shared/index.js';
import { scheduleUpstream } from '../src/shared/index.js';
import { applyChanges, toSnapshot } from '../src/sync/index.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterAll(cleanupBoards);

/**
 * The chain of work behind an issue, and pushing it into a queue.
 *
 * The rules under test live in `src/shared/blocking.ts` (what is upstream) and
 * `src/shared/plans/upstream.ts` (what scheduling it means). They are exercised
 * here through the engine and the planner, which is how the CLI, the MCP server
 * and the canvas reach them.
 */

const view = (board: LoadedBoard): BoardView => {
  const snapshot = toSnapshot(board);
  const nodes = Object.fromEntries(
    [...snapshot.issues, ...snapshot.periods, ...snapshot.resources, ...snapshot.templates].map(
      (node) => [node.id, node],
    ),
  );
  return { config: snapshot.config, nodes };
};

const upstream = (paths: BoardPaths, id: string): ReturnType<typeof upstreamOf> => {
  const board = reload(paths);
  return upstreamOf(board, findIssue(board, id)!);
};

const idsOf = (paths: BoardPaths, id: string): string[] =>
  upstream(paths, id).map((entry) => entry.id);

const depend = (paths: BoardPaths, blocked: string, on: string[]): void => {
  const board = reload(paths);
  linkIssue(board, findIssue(board, blocked)!, { dependsOn: on });
};

const finish = (paths: BoardPaths, id: string): void => {
  const board = reload(paths);
  moveNode(board, findIssue(board, id)!, { status: 'done' });
};

/**
 * A chain of three stories under one feature, each waiting on the one before:
 * LP-3 is the feature, LP-4 -> LP-5 -> LP-6 the stories.
 */
function chain(): BoardPaths {
  const paths = makeBoard('scrum', 'LP');
  createIssue(reload(paths), { type: 'program', title: 'Payments' });
  createIssue(reload(paths), { type: 'epic', title: 'Checkout', parentId: 'LP-1' });
  createIssue(reload(paths), { type: 'feature', title: 'Guest flow', parentId: 'LP-2' });
  for (const title of ['Gateway', 'Guest checkout', 'Refunds']) {
    createIssue(reload(paths), { type: 'user_story', title, parentId: 'LP-3' });
  }
  depend(paths, 'LP-5', ['LP-4']);
  depend(paths, 'LP-6', ['LP-5']);
  return paths;
}

describe('upstreamOf', () => {
  it('follows the chain past the first blocker, nearest cause first', () => {
    const paths = chain();
    // `blockersOf` would stop at LP-5. The whole chain is LP-5 then LP-4.
    expect(idsOf(paths, 'LP-6')).toEqual(['LP-5', 'LP-4']);
    expect(upstream(paths, 'LP-6').map((entry) => entry.distance)).toEqual([1, 2]);
  });

  it('is empty when everything it waits on is finished', () => {
    const paths = chain();
    finish(paths, 'LP-4');
    finish(paths, 'LP-5');
    expect(idsOf(paths, 'LP-6')).toEqual([]);
  });

  it('stops at the finished part of a chain', () => {
    const paths = chain();
    finish(paths, 'LP-4');
    expect(idsOf(paths, 'LP-6')).toEqual(['LP-5']);
  });

  it('reports a blocking container and the open work inside it', () => {
    const paths = makeBoard('scrum', 'LP');
    createIssue(reload(paths), { type: 'program', title: 'Payments' });
    createIssue(reload(paths), { type: 'epic', title: 'Checkout', parentId: 'LP-1' });
    createIssue(reload(paths), { type: 'feature', title: 'Gateway', parentId: 'LP-2' });
    createIssue(reload(paths), { type: 'feature', title: 'Guest flow', parentId: 'LP-2' });
    createIssue(reload(paths), { type: 'user_story', title: 'Tokens', parentId: 'LP-3' });
    createIssue(reload(paths), { type: 'user_story', title: 'Webhooks', parentId: 'LP-3' });
    createIssue(reload(paths), { type: 'user_story', title: 'Checkout page', parentId: 'LP-4' });
    depend(paths, 'LP-4', ['LP-3']);

    // The feature is what the edge names, so it is reported as written — and
    // its two open stories come with it, because they are what it amounts to.
    const found = upstream(paths, 'LP-7');
    expect(found.map((entry) => entry.id)).toEqual(['LP-3', 'LP-5', 'LP-6']);
    expect(found.map((entry) => entry.reason)).toEqual(['dependency', 'contents', 'contents']);
    expect(found.map((entry) => entry.through)).toEqual(['LP-7', 'LP-3', 'LP-3']);
  });

  it('leaves out the finished work inside a blocking container', () => {
    const paths = makeBoard('scrum', 'LP');
    createIssue(reload(paths), { type: 'program', title: 'Payments' });
    createIssue(reload(paths), { type: 'epic', title: 'Checkout', parentId: 'LP-1' });
    createIssue(reload(paths), { type: 'feature', title: 'Gateway', parentId: 'LP-2' });
    createIssue(reload(paths), { type: 'feature', title: 'Guest flow', parentId: 'LP-2' });
    createIssue(reload(paths), { type: 'user_story', title: 'Tokens', parentId: 'LP-3' });
    createIssue(reload(paths), { type: 'user_story', title: 'Webhooks', parentId: 'LP-3' });
    createIssue(reload(paths), { type: 'user_story', title: 'Checkout page', parentId: 'LP-4' });
    depend(paths, 'LP-4', ['LP-3']);
    finish(paths, 'LP-5');

    expect(idsOf(paths, 'LP-7')).toEqual(['LP-3', 'LP-6']);
  });

  it('inherits a dependency written on an ancestor', () => {
    const paths = makeBoard('scrum', 'LP');
    createIssue(reload(paths), { type: 'program', title: 'Payments' });
    createIssue(reload(paths), { type: 'epic', title: 'Checkout', parentId: 'LP-1' });
    createIssue(reload(paths), { type: 'feature', title: 'Gateway', parentId: 'LP-2' });
    createIssue(reload(paths), { type: 'feature', title: 'Guest flow', parentId: 'LP-2' });
    createIssue(reload(paths), { type: 'user_story', title: 'Groundwork', parentId: 'LP-3' });
    createIssue(reload(paths), { type: 'user_story', title: 'Checkout page', parentId: 'LP-4' });
    // The edge is on the feature; the story inside it waits on it too.
    depend(paths, 'LP-4', ['LP-3']);

    expect(idsOf(paths, 'LP-6')).toContain('LP-3');
    expect(idsOf(paths, 'LP-6')).toContain('LP-5');
  });

  it('never reports the issue itself, and reports each other issue once', () => {
    const paths = chain();
    // A diamond: LP-6 waits on both, and both wait on LP-4.
    createIssue(reload(paths), { type: 'user_story', title: 'Fees', parentId: 'LP-3' });
    depend(paths, 'LP-7', ['LP-4']);
    depend(paths, 'LP-6', ['LP-5', 'LP-7']);

    const ids = idsOf(paths, 'LP-6');
    expect(ids).not.toContain('LP-6');
    expect(new Set(ids).size).toBe(ids.length);
    // Reached two ways, LP-4 keeps its nearest distance.
    expect(upstream(paths, 'LP-6').find((entry) => entry.id === 'LP-4')?.distance).toBe(2);
  });

  it('does not hang on a dependency cycle', () => {
    const paths = chain();
    // `linkIssue` refuses a cycle, so this is the hand-edited/merged case: it
    // reaches the engine through the loaded board rather than through the
    // operation, exactly as a bad merge would.
    const board = reload(paths);
    const issue = findIssue(board, 'LP-4')!;
    issue.depends_on = ['LP-6'];
    board.byId.set('LP-4', issue);

    expect(upstreamOf(board, findIssue(board, 'LP-6')!).map((entry) => entry.id)).toEqual([
      'LP-5',
      'LP-4',
    ]);
  });
});

// -- scheduling ------------------------------------------------------------

/** A sprint inside an increment, and two people. Ids vary by board prefix. */
interface Roster {
  sprint: string;
  ana: string;
  bo: string;
}

function staff(paths: BoardPaths): Roster {
  const increment = createPeriod(reload(paths), {
    type: 'increment',
    title: '2026 H2',
    starts: '2026-07-01',
    ends: '2026-12-31',
  });
  const sprint = createPeriod(reload(paths), {
    type: 'sprint',
    title: 'Sprint 7',
    starts: '2026-08-10',
    ends: '2026-08-21',
    parentId: increment.id,
  });
  const ana = createResource(reload(paths), { type: 'person', title: 'Ana' });
  const bo = createResource(reload(paths), { type: 'person', title: 'Bo' });
  return { sprint: sprint.id, ana: ana.id, bo: bo.id };
}

/** The chain, staffed, with LP-6 scheduled and assigned to Ana. */
function staffed(): { paths: BoardPaths; roster: Roster } {
  const paths = chain();
  const roster = staff(paths);
  const board = reload(paths);
  moveNode(board, findIssue(board, 'LP-6')!, { period: roster.sprint, assignee: roster.ana });
  return { paths, roster };
}

const run = (paths: BoardPaths, id: string, options = {}) => {
  const board = reload(paths);
  const result = scheduleUpstream(view(board), id, options);
  if (result.plan.ok && result.plan.changes.length) applyChanges(paths, result.plan.changes);
  return result;
};

describe('scheduleUpstream', () => {
  it('puts the unclaimed chain in the same period, with the same owner', () => {
    const { paths, roster } = staffed();
    const result = run(paths, 'LP-6');

    expect(result.period).toBe(roster.sprint);
    expect(result.assignee).toBe(roster.ana);
    for (const id of ['LP-4', 'LP-5']) {
      const issue = findIssue(reload(paths), id)!;
      expect(issue.period).toBe(roster.sprint);
      expect(issue.assignee).toBe(roster.ana);
    }
    // The issue that was waiting is not itself rescheduled.
    expect(result.decisions.some((entry) => entry.id === 'LP-6')).toBe(false);
  });

  it('leaves work somebody already holds alone, period included', () => {
    const { paths, roster } = staffed();
    const board = reload(paths);
    moveNode(board, findIssue(board, 'LP-4')!, { assignee: roster.bo });

    const result = run(paths, 'LP-6');
    const after = findIssue(reload(paths), 'LP-4')!;
    expect(after.assignee).toBe(roster.bo);
    expect(after.period).toBeNull();
    expect(result.decisions.find((entry) => entry.id === 'LP-4')?.skipped).toBe('assigned');
  });

  it('schedules the work inside a blocking container, never the container', () => {
    const paths = makeBoard('scrum', 'LP');
    createIssue(reload(paths), { type: 'program', title: 'Payments' });
    createIssue(reload(paths), { type: 'epic', title: 'Checkout', parentId: 'LP-1' });
    createIssue(reload(paths), { type: 'feature', title: 'Gateway', parentId: 'LP-2' });
    createIssue(reload(paths), { type: 'feature', title: 'Guest flow', parentId: 'LP-2' });
    createIssue(reload(paths), { type: 'user_story', title: 'Tokens', parentId: 'LP-3' });
    createIssue(reload(paths), { type: 'user_story', title: 'Checkout page', parentId: 'LP-4' });
    depend(paths, 'LP-4', ['LP-3']);
    const roster = staff(paths);
    const board = reload(paths);
    moveNode(board, findIssue(board, 'LP-6')!, { period: roster.sprint, assignee: roster.ana });

    const result = run(paths, 'LP-6');
    expect(result.decisions.find((entry) => entry.id === 'LP-3')?.skipped).toBe('container');
    // A period on the feature would offer nobody anything; the story gets it.
    expect(findIssue(reload(paths), 'LP-3')!.period).toBeNull();
    expect(findIssue(reload(paths), 'LP-5')!.period).toBe(roster.sprint);
    expect(findIssue(reload(paths), 'LP-5')!.assignee).toBe(roster.ana);
  });

  it('refuses when the issue has neither a period nor an assignee', () => {
    const { paths } = staffed();
    const result = run(paths, 'LP-5');
    expect(result.plan.ok).toBe(false);
    if (!result.plan.ok) expect(result.plan.error).toMatch(/not scheduled and not assigned/);
  });

  it('takes an explicit period and assignee over the issue’s own', () => {
    const { paths, roster } = staffed();
    run(paths, 'LP-6', { period: null, assignee: roster.bo });

    const issue = findIssue(reload(paths), 'LP-4')!;
    expect(issue.assignee).toBe(roster.bo);
    expect(issue.period).toBeNull();
  });

  it('reports what it found even when nothing changed', () => {
    const { paths } = staffed();
    run(paths, 'LP-6');
    const again = run(paths, 'LP-6');

    expect(again.plan.ok && again.plan.changes).toEqual([]);
    expect(again.decisions.map((entry) => entry.skipped)).toEqual(['assigned', 'assigned']);
  });

  it('refuses a document that is not an issue', () => {
    const { paths, roster } = staffed();
    const result = run(paths, roster.sprint);
    expect(result.plan.ok).toBe(false);
    if (!result.plan.ok) expect(result.plan.error).toMatch(/only issues have upstream work/);
  });
});
