import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { BoardPaths, Issue, NewIssueInput, QueueSimulation } from '../src/core/index.js';
import {
  BoardError,
  clearFlag,
  createIssue,
  createPeriod,
  createResource,
  createSquad,
  findIssue,
  findPeriod,
  findResource,
  flagIssue,
  linkIssue,
  linkResource,
  moveNode,
  nextTasks,
  simulateQueue,
  updateNode,
} from '../src/core/index.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterAll(cleanupBoards);

const TODAY = '2026-08-10';

/** Alice (covering the junior pool), Bob, the pool, and a feature to hang stories off. */
function seed(): BoardPaths {
  const paths = makeBoard('scrum', 'LP');
  createResource(reload(paths), { type: 'person', title: 'Alice Smith' });
  createResource(reload(paths), { type: 'person', title: 'Bob Jones' });
  createResource(reload(paths), { type: 'role', title: 'Jr. software developer', capacity: 3 });
  linkResource(reload(paths), findResource(reload(paths), 'RS-1')!, { covers: ['RS-3'] });

  createIssue(reload(paths), { type: 'program', title: 'Payments' });
  createIssue(reload(paths), { type: 'epic', title: 'Checkout', parentId: 'LP-1' });
  createIssue(reload(paths), { type: 'feature', title: 'Guest flow', parentId: 'LP-2' });
  return paths;
}

function story(paths: BoardPaths, title: string, input: Partial<NewIssueInput> = {}): Issue {
  return createIssue(reload(paths), { type: 'user_story', title, parentId: 'LP-3', ...input });
}

/** An increment (TL-1) holding a running sprint (TL-2) and a later one (TL-3). */
function timeline(paths: BoardPaths): void {
  createPeriod(reload(paths), {
    type: 'increment',
    title: 'PI 1',
    starts: '2026-08-03',
    ends: '2026-08-28',
  });
  createPeriod(reload(paths), {
    type: 'sprint',
    title: 'Running',
    parentId: 'TL-1',
    starts: '2026-08-03',
    ends: '2026-08-14',
  });
  createPeriod(reload(paths), {
    type: 'sprint',
    title: 'Later',
    parentId: 'TL-1',
    starts: '2026-08-17',
    ends: '2026-08-28',
  });
}

function depends(paths: BoardPaths, id: string, on: string[]): void {
  linkIssue(reload(paths), findIssue(reload(paths), id)!, { dependsOn: on });
}

/** Run the queue dry for one resource on the board as it stands. */
function run(
  paths: BoardPaths,
  resourceId: string,
  options: Parameters<typeof simulateQueue>[2] = {},
): QueueSimulation {
  const board = reload(paths);
  return simulateQueue(board, board.resourcesById.get(resourceId)!, { today: TODAY, ...options });
}

const order = (simulation: QueueSimulation): string[] =>
  simulation.steps.map((step) => step.issue.id);

const skipsFor = (simulation: QueueSimulation, reason: string): string[] =>
  simulation.skipped.filter((skip) => skip.reason === reason).map((skip) => skip.issue.id);

const byReason = (simulation: QueueSimulation): string[] =>
  simulation.skipped.map((skip) => skip.reason);

const SQUAD_BOARD_CONFIG = `version: 1
key_prefix: LP
statuses:
  - id: backlog
    label: Backlog
  - id: ready
    label: Ready
  - id: in_progress
    label: In Progress
    active: true
  - id: in_review
    label: In Review
    active: true
  - id: done
    label: Done
    terminal: true
issue_types:
  program:
    label: Program
    attributes:
      priority: { type: enum, values: [critical, high, medium, low] }
  epic:
    label: Epic
    attributes:
      priority: { type: enum, values: [critical, high, medium, low] }
  feature:
    label: Feature
    attributes:
      priority: { type: enum, values: [critical, high, medium, low] }
  user_story:
    label: User Story
    attributes:
      priority: { type: enum, values: [critical, high, medium, low] }
      story_points: { type: int }
    atomic: true
  sub_task:
    label: Sub-task
    attributes: {}
hierarchy:
  - program
  - epic
  - feature
  - [user_story, sub_task]
priority_attribute: priority
effort_attribute: story_points

period_prefix: TL
period_types:
  increment:
    label: Increment
    attributes: {}
  sprint:
    label: Sprint
    attributes: {}
period_hierarchy:
  - [increment]
  - [sprint]

resource_prefix: RS
resource_types:
  person:
    label: Person
    attributes: {}
  role:
    label: Role
    generic: true
    attributes: {}
resource_hierarchy:
  - person
  - role

squad_prefix: SP
squad_types:
  squad:
    label: Squad
    attributes: {}
    body: ""
squad_hierarchy:
  - squad
`;

describe('simulating one person working the queue', () => {
  it('runs the queue dry, in the order the board would offer it', () => {
    const paths = seed();
    story(paths, 'First', { assignee: 'RS-1' });
    story(paths, 'Second', { assignee: 'RS-1' });
    story(paths, 'Third', { assignee: 'RS-1' });
    depends(paths, 'LP-5', ['LP-4']);
    depends(paths, 'LP-6', ['LP-5']);

    const simulation = run(paths, 'RS-1');
    expect(order(simulation)).toEqual(['LP-4', 'LP-5', 'LP-6']);
    expect(simulation.skipped).toEqual([]);
    expect(simulation.truncated).toBe(false);
  });

  /**
   * Three features, their stories created round-robin so the ids interleave,
   * and one story already finished in the first of them. A run that ranked by
   * id once the priorities and columns tied worked one story from each feature
   * in turn and left all three half built; it now finishes what the board has
   * started before opening the next front.
   *
   * @see src/shared/cohesion.ts
   */
  function threeFeatures(paths: BoardPaths): void {
    createIssue(reload(paths), { type: 'feature', title: 'Saved cards', parentId: 'LP-2' });
    createIssue(reload(paths), { type: 'feature', title: 'Refund flow', parentId: 'LP-2' });
    const features = ['LP-3', 'LP-4', 'LP-5'];
    story(paths, 'Guest flow 1', { status: 'done' });
    story(paths, 'Saved cards 1', { assignee: 'RS-1', parentId: 'LP-4' });
    story(paths, 'Refund flow 1', { assignee: 'RS-1', parentId: 'LP-5' });
    for (const round of [2, 3]) {
      for (const [index, feature] of features.entries()) {
        story(paths, `Feature ${index + 1} story ${round}`, {
          assignee: 'RS-1',
          parentId: feature,
        });
      }
    }
  }

  it('finishes one feature before starting the next', () => {
    const paths = seed();
    threeFeatures(paths);

    // Guest flow first, because a story in it is already done; then Saved
    // cards whole, then Refund flow. The ids say otherwise at every step.
    expect(order(run(paths, 'RS-1'))).toEqual([
      'LP-9',
      'LP-12',
      'LP-7',
      'LP-10',
      'LP-13',
      'LP-8',
      'LP-11',
      'LP-14',
    ]);
  });

  it('agrees with the queue about which feature to stay in', () => {
    const paths = seed();
    threeFeatures(paths);

    // The overlay the simulation ranks against has to move the same way the
    // board does: each step it predicts must be the step `lpm task next` takes
    // once the previous one is really finished.
    for (const id of order(run(paths, 'RS-1'))) {
      const board = reload(paths);
      expect(nextTasks(board, 'RS-1', { today: TODAY, limit: 1 })[0]!.issue.id).toBe(id);
      moveNode(board, findIssue(board, id)!, { status: 'done' });
    }
    expect(nextTasks(reload(paths), 'RS-1', { today: TODAY })).toEqual([]);
  });

  it('agrees with the queue at every step', () => {
    const paths = seed();
    timeline(paths);
    updateNode(reload(paths), findPeriod(reload(paths), 'TL-3')!, { active: false });
    story(paths, 'High', { assignee: 'RS-1', attributes: { priority: 'critical' } });
    story(paths, 'Low', { assignee: 'RS-1', attributes: { priority: 'low' } });
    story(paths, 'Pooled', { assignee: 'RS-3' });
    story(paths, 'Scheduled', { assignee: 'RS-1', period: 'TL-2' });
    story(paths, 'Parked', { assignee: 'RS-1', period: 'TL-3' });

    // The whole claim of the command is that it is `lpm task next` in a loop.
    // Replaying it one step at a time against the real board must give the same
    // sequence, and must run out at the same point -- a filter living in
    // simulate.ts rather than in the engine is exactly what this catches.
    const simulation = run(paths, 'RS-1');
    for (const id of order(simulation)) {
      const board = reload(paths);
      expect(nextTasks(board, 'RS-1', { today: TODAY, limit: 1 })[0]!.issue.id).toBe(id);
      moveNode(board, findIssue(board, id)!, { status: 'done' });
    }
    expect(nextTasks(reload(paths), 'RS-1', { today: TODAY })).toEqual([]);
  });

  it('says what each step released', () => {
    const paths = seed();
    story(paths, 'Gate', { assignee: 'RS-1' });
    story(paths, 'After A', { assignee: 'RS-1' });
    story(paths, 'After B', { assignee: 'RS-1' });
    depends(paths, 'LP-5', ['LP-4']);
    depends(paths, 'LP-6', ['LP-4']);

    const simulation = run(paths, 'RS-1');
    const freed = simulation.steps.map((step) => step.unblocked.map((issue) => issue.id));
    expect(freed[0]).toEqual(['LP-5', 'LP-6']);
    expect(freed[1]).toEqual([]);
  });

  it('reports work released only once its last blocker is done', () => {
    const paths = seed();
    story(paths, 'One', { assignee: 'RS-1' });
    story(paths, 'Two', { assignee: 'RS-1' });
    story(paths, 'Needs both', { assignee: 'RS-1' });
    depends(paths, 'LP-6', ['LP-4', 'LP-5']);

    const simulation = run(paths, 'RS-1');
    expect(simulation.steps[0]!.unblocked).toEqual([]);
    expect(simulation.steps[1]!.unblocked.map((issue) => issue.id)).toEqual(['LP-6']);
  });

  it('does the work already in flight first, and marks it', () => {
    const paths = seed();
    story(paths, 'Waiting', { assignee: 'RS-1' });
    story(paths, 'Under way', { assignee: 'RS-1', status: 'in_progress' });

    const simulation = run(paths, 'RS-1');
    expect(order(simulation)).toEqual(['LP-5', 'LP-4']);
    expect(simulation.steps.map((step) => step.started)).toEqual([true, false]);
  });

  it('lets work in flight release what depends on it', () => {
    const paths = seed();
    story(paths, 'Under way', { assignee: 'RS-1', status: 'in_progress' });
    story(paths, 'Waiting on it', { assignee: 'RS-1' });
    depends(paths, 'LP-5', ['LP-4']);

    // The queue never offers LP-4 -- it has been picked up already. A run that
    // ignored it would report LP-5 as blocked forever, which is the opposite of
    // the truth.
    expect(order(run(paths, 'RS-1'))).toEqual(['LP-4', 'LP-5']);
  });

  it('does not start from flagged work, and says that is why', () => {
    const paths = seed();
    story(paths, 'Stopped', { assignee: 'RS-1', status: 'in_progress' });
    story(paths, 'Waiting on it', { assignee: 'RS-1' });
    depends(paths, 'LP-5', ['LP-4']);
    flagIssue(reload(paths), findIssue(reload(paths), 'LP-4')!, {
      reason: 'blocked',
      comment: 'the API contract has not been agreed',
    });

    // A flag says the work has stopped and needs a person. Nobody else is in
    // this run, so taking LP-4 as step 1 would assume away the very thing
    // holding the queue up and report LP-5 as reachable -- which is what made
    // `lpm queue simulate` disagree with `lpm queue agent` on a stalled board.
    const simulation = run(paths, 'RS-1');
    expect(simulation.steps).toEqual([]);
    expect(skipsFor(simulation, 'flagged')).toEqual(['LP-4']);
    expect(skipsFor(simulation, 'blocked')).toEqual(['LP-5']);
    expect(simulation.flagged).toBe(1);
  });

  it('agrees with the queue when everything in flight is flagged', () => {
    const paths = seed();
    story(paths, 'Stopped', { assignee: 'RS-1', status: 'in_progress' });
    story(paths, 'Also stopped', { assignee: 'RS-1', status: 'in_progress' });
    for (const id of ['LP-4', 'LP-5']) {
      flagIssue(reload(paths), findIssue(reload(paths), id)!, {
        reason: 'help',
        comment: 'needs a decision',
      });
    }

    // Both commands read the same board: `lpm task next` offers nothing, so
    // `lpm queue agent` stops, and the simulation must not claim otherwise.
    expect(run(paths, 'RS-1').steps).toEqual([]);
    expect(nextTasks(reload(paths), 'RS-1', { today: TODAY })).toEqual([]);
  });

  it('still starts from work in flight once the flag is cleared', () => {
    const paths = seed();
    story(paths, 'Stopped', { assignee: 'RS-1', status: 'in_progress' });
    const board = reload(paths);
    flagIssue(board, findIssue(board, 'LP-4')!, { reason: 'blocked', comment: 'waiting' });
    clearFlag(reload(paths), findIssue(reload(paths), 'LP-4')!, { comment: 'contract agreed' });

    expect(order(run(paths, 'RS-1'))).toEqual(['LP-4']);
  });

  it('does not take flagged work that was never started either', () => {
    const paths = seed();
    story(paths, 'Stopped', { assignee: 'RS-1' });
    story(paths, 'Fine', { assignee: 'RS-1' });
    flagIssue(reload(paths), findIssue(reload(paths), 'LP-4')!, {
      reason: 'blocked',
      comment: 'the vendor has not answered',
    });

    // Most flagged work is in progress and never offered for that reason alone.
    // A flag on a backlog issue says the same thing -- this has stopped -- and
    // the queue has to hear it, or the run takes work the board says nobody
    // should start and the skip reasons describe a run that did not happen.
    const simulation = run(paths, 'RS-1');
    expect(order(simulation)).toEqual(['LP-5']);
    expect(skipsFor(simulation, 'flagged')).toEqual(['LP-4']);
    expect(nextTasks(reload(paths), 'RS-1', { today: TODAY, limit: 1 })[0]!.issue.id).toBe('LP-5');
  });

  it('never reaches work held by somebody else, and says who has it', () => {
    const paths = seed();
    story(paths, 'Mine', { assignee: 'RS-1' });
    story(paths, 'Bobs', { assignee: 'RS-2' });

    const simulation = run(paths, 'RS-1');
    expect(order(simulation)).toEqual(['LP-4']);
    expect(skipsFor(simulation, 'routing')).toEqual(['LP-5']);
    expect(simulation.skipped[0]!.holder!.id).toBe('RS-2');
  });

  it('leaves work waiting forever on somebody else, and says on what', () => {
    const paths = seed();
    story(paths, 'Bobs', { assignee: 'RS-2' });
    story(paths, 'Mine, but after Bob', { assignee: 'RS-1' });
    depends(paths, 'LP-5', ['LP-4']);

    // Nobody else contributes, so LP-4 is never finished and LP-5 never starts.
    const simulation = run(paths, 'RS-1');
    expect(simulation.steps).toEqual([]);
    expect(skipsFor(simulation, 'blocked')).toEqual(['LP-5']);
    const blocked = simulation.skipped.find((skip) => skip.reason === 'blocked')!;
    expect(blocked.blockedBy.map((issue) => issue.id)).toEqual(['LP-4']);
  });

  it('reports work somebody else has in flight as in flight, not as unrouted', () => {
    const paths = seed();
    story(paths, 'Pooled and under way', { assignee: 'RS-3', status: 'in_progress' });

    // Alice covers the pool, so it is routed to her -- but it has been picked
    // up, and this run does not finish other people's work.
    const simulation = run(paths, 'RS-1');
    expect(simulation.steps).toEqual([]);
    expect(skipsFor(simulation, 'active')).toEqual(['LP-4']);
  });

  it('takes work out of a pool it covers', () => {
    const paths = seed();
    story(paths, 'Pooled', { assignee: 'RS-3' });

    const simulation = run(paths, 'RS-1');
    expect(order(simulation)).toEqual(['LP-4']);
    expect(simulation.steps[0]!.route).toBe('pool');
    expect(simulation.steps[0]!.pool!.id).toBe('RS-3');
  });

  it('simulates a pool working out of itself', () => {
    const paths = seed();
    story(paths, 'Pooled', { assignee: 'RS-3' });
    story(paths, 'Alices', { assignee: 'RS-1' });

    const simulation = run(paths, 'RS-3');
    expect(order(simulation)).toEqual(['LP-4']);
    expect(simulation.steps[0]!.route).toBe('direct');
    expect(skipsFor(simulation, 'routing')).toEqual(['LP-5']);
  });

  it('leaves unassigned work alone until asked for it', () => {
    const paths = seed();
    story(paths, 'Nobody');

    const closed = run(paths, 'RS-1');
    expect(closed.steps).toEqual([]);
    expect(skipsFor(closed, 'routing')).toEqual(['LP-4']);
    expect(closed.skipped[0]!.holder).toBeNull();

    const opened = run(paths, 'RS-1', { includeUnassigned: true });
    expect(order(opened)).toEqual(['LP-4']);
    expect(opened.steps[0]!.route).toBe('unassigned');
  });

  it('adds up effort as it goes, and counts what carries none', () => {
    const paths = seed();
    story(paths, 'Three', { assignee: 'RS-1', attributes: { story_points: 3 } });
    story(paths, 'Five', { assignee: 'RS-1', attributes: { story_points: 5 } });
    createIssue(reload(paths), {
      type: 'test',
      title: 'No points on this type',
      parentId: 'LP-3',
      assignee: 'RS-1',
    });

    const simulation = run(paths, 'RS-1');
    expect(simulation.steps.map((step) => step.effort)).toEqual([3, 5, null]);
    expect(simulation.steps.map((step) => step.cumulative)).toEqual([3, 8, 8]);
    expect(simulation.effort).toBe(8);
    expect(simulation.unestimated).toBe(1);
  });

  it('stops at a limit and says the queue had more', () => {
    const paths = seed();
    story(paths, 'One', { assignee: 'RS-1' });
    story(paths, 'Two', { assignee: 'RS-1' });
    story(paths, 'Three', { assignee: 'RS-1' });

    const simulation = run(paths, 'RS-1', { limit: 2 });
    expect(order(simulation)).toEqual(['LP-4', 'LP-5']);
    expect(simulation.truncated).toBe(true);
    expect(skipsFor(simulation, 'ready')).toEqual(['LP-6']);
  });

  it('does not call a run that ended on the limit truncated', () => {
    const paths = seed();
    story(paths, 'One', { assignee: 'RS-1' });
    story(paths, 'Two', { assignee: 'RS-1' });

    const simulation = run(paths, 'RS-1', { limit: 2 });
    expect(order(simulation)).toEqual(['LP-4', 'LP-5']);
    expect(simulation.truncated).toBe(false);
  });

  it('offers a story whole and never its sub-tasks', () => {
    const paths = seed();
    story(paths, 'Parent', { assignee: 'RS-1' });
    createIssue(reload(paths), {
      type: 'sub_task',
      title: 'Child',
      parentId: 'LP-4',
      assignee: 'RS-1',
    });

    // Scrum declares `user_story` atomic, so the sub-task is its checklist. It
    // must be neither a step nor a leftover: it is not a piece of work at all.
    const simulation = run(paths, 'RS-1');
    expect(order(simulation)).toEqual(['LP-4']);
    expect(simulation.skipped).toEqual([]);
  });

  it('ranks a running period ahead of one that has not started', () => {
    const paths = seed();
    timeline(paths);
    story(paths, 'Later work', { assignee: 'RS-1', period: 'TL-3' });
    story(paths, 'Now work', { assignee: 'RS-1', period: 'TL-2' });

    // A period that has merely not started yet is still the plan: it is ranked
    // after the running one, not left out the way a parked one is.
    const simulation = run(paths, 'RS-1');
    expect(order(simulation)).toEqual(['LP-5', 'LP-4']);
    expect(simulation.parked).toBe(0);
  });

  it('leaves out work in a period somebody switched off, and counts it', () => {
    const paths = seed();
    timeline(paths);
    updateNode(reload(paths), findPeriod(reload(paths), 'TL-3')!, { active: false });
    story(paths, 'Parked work', { assignee: 'RS-1', period: 'TL-3' });
    story(paths, 'Live work', { assignee: 'RS-1', period: 'TL-2' });

    // Withheld by the engine, not by this module: `nextTasks` does not offer
    // parked work, so the run cannot reach it either. See tasks.test.ts.
    const simulation = run(paths, 'RS-1');
    expect(order(simulation)).toEqual(['LP-5']);
    expect(skipsFor(simulation, 'parked')).toEqual(['LP-4']);
    expect(simulation.parked).toBe(1);
    expect(simulation.skipped[0]!.period!.id).toBe('TL-3');
  });

  it('works through parked periods when asked to', () => {
    const paths = seed();
    timeline(paths);
    updateNode(reload(paths), findPeriod(reload(paths), 'TL-3')!, { active: false });
    story(paths, 'Parked work', { assignee: 'RS-1', period: 'TL-3' });

    const simulation = run(paths, 'RS-1', { includeParked: true });
    expect(order(simulation)).toEqual(['LP-4']);
    expect(simulation.parked).toBe(0);
  });

  it('leaves out a sprint parked by the increment above it', () => {
    const paths = seed();
    createPeriod(reload(paths), {
      type: 'increment',
      title: 'PI parked',
      starts: '2026-08-03',
      ends: '2026-08-28',
    });
    createPeriod(reload(paths), {
      type: 'sprint',
      title: 'Sprint inside it',
      parentId: 'TL-1',
      starts: '2026-08-03',
      ends: '2026-08-14',
    });
    updateNode(reload(paths), findPeriod(reload(paths), 'TL-1')!, { active: false });
    story(paths, 'Inside a parked increment', { assignee: 'RS-1', period: 'TL-2' });

    // The sprint says nothing about the switch; parking an increment parks the
    // sprints in it, exactly as `periodStance` cascades it.
    const simulation = run(paths, 'RS-1');
    expect(simulation.steps).toEqual([]);
    expect(skipsFor(simulation, 'parked')).toEqual(['LP-4']);
  });

  it('steps over parked work to reach what is behind it', () => {
    const paths = seed();
    timeline(paths);
    updateNode(reload(paths), findPeriod(reload(paths), 'TL-3')!, { active: false });
    story(paths, 'Parked', { assignee: 'RS-1', period: 'TL-3' });
    story(paths, 'Unscheduled', { assignee: 'RS-1' });
    story(paths, 'Also unscheduled', { assignee: 'RS-1' });

    // Parked work must not stop the run: what is behind it is still offered.
    const simulation = run(paths, 'RS-1');
    expect(order(simulation)).toEqual(['LP-5', 'LP-6']);
    expect(simulation.parked).toBe(1);
  });

  it('counts parked work left out even when a limit cut the run', () => {
    const paths = seed();
    timeline(paths);
    updateNode(reload(paths), findPeriod(reload(paths), 'TL-3')!, { active: false });
    story(paths, 'Parked', { assignee: 'RS-1', period: 'TL-3' });
    story(paths, 'One', { assignee: 'RS-1' });
    story(paths, 'Two', { assignee: 'RS-1' });

    const simulation = run(paths, 'RS-1', { limit: 1 });
    expect(order(simulation)).toEqual(['LP-5']);
    expect(simulation.truncated).toBe(true);
    expect(simulation.parked).toBe(1);
    expect(skipsFor(simulation, 'ready')).toEqual(['LP-6']);
  });

  it('narrows to the scope it is given, and says what it left out', () => {
    const paths = seed();
    createIssue(reload(paths), { type: 'epic', title: 'Other', parentId: 'LP-1' });
    createIssue(reload(paths), { type: 'feature', title: 'Other flow', parentId: 'LP-4' });
    story(paths, 'In the epic', { assignee: 'RS-1' });
    createIssue(reload(paths), {
      type: 'user_story',
      title: 'Out of the epic',
      parentId: 'LP-5',
      assignee: 'RS-1',
    });

    const board = reload(paths);
    const scope = {
      under: [findIssue(board, 'LP-2')!],
      exclude: [],
      types: null,
      periods: null,
      unknown: [],
      active: true,
    };
    const simulation = simulateQueue(board, board.resourcesById.get('RS-1')!, {
      today: TODAY,
      scope,
    });
    expect(order(simulation)).toEqual(['LP-6']);
    expect(skipsFor(simulation, 'scope')).toEqual(['LP-7']);
  });

  it('writes nothing to disk', () => {
    const paths = seed();
    story(paths, 'One', { assignee: 'RS-1' });
    story(paths, 'Two', { assignee: 'RS-1', status: 'in_progress' });

    const before = readFileSync(findIssue(reload(paths), 'LP-4')!.file, 'utf8');
    expect(order(run(paths, 'RS-1'))).toHaveLength(2);

    const after = reload(paths);
    expect(readFileSync(findIssue(after, 'LP-4')!.file, 'utf8')).toBe(before);
    expect(findIssue(after, 'LP-4')!.status).toBe('backlog');
    expect(findIssue(after, 'LP-5')!.status).toBe('in_progress');
  });

  it('refuses a board with no end state rather than looping forever', () => {
    const paths = seed();
    story(paths, 'One', { assignee: 'RS-1' });

    const text = readFileSync(paths.configPath, 'utf8');
    writeFileSync(paths.configPath, text.replace(/^ +terminal: true\r?\n/gm, ''), 'utf8');

    const board = reload(paths);
    expect(() => simulateQueue(board, board.resourcesById.get('RS-1')!, { today: TODAY })).toThrow(
      BoardError,
    );
  });

  it('ignores work that is already finished', () => {
    const paths = seed();
    story(paths, 'Done', { assignee: 'RS-1', status: 'done' });
    story(paths, 'Open', { assignee: 'RS-1' });

    const simulation = run(paths, 'RS-1');
    expect(order(simulation)).toEqual(['LP-5']);
    expect(simulation.skipped).toEqual([]);
  });

  it('carries a renamed issue through as it stands', () => {
    const paths = seed();
    const issue = story(paths, 'Original', { assignee: 'RS-1' });
    updateNode(reload(paths), findIssue(reload(paths), issue.id)!, { title: 'Renamed' });

    expect(run(paths, 'RS-1').steps[0]!.issue.title).toBe('Renamed');
  });

  // -- Squad routing: independent queues ----------------------------------

  it('offers a squad member only their own squad period work', () => {
    const paths = makeBoard('scrum', 'LP');
    writeFileSync(paths.configPath, SQUAD_BOARD_CONFIG, 'utf8');

    // Reload with the new config
    const board = reload(paths);

    // Alice and Bob, plus a "Frontend" squad of which only Alice is a member.
    createResource(board, { type: 'person', title: 'Alice Smith' });
    createResource(board, { type: 'person', title: 'Bob Jones' });
    const b2 = reload(paths);
    const sq = createSquad(b2, { type: 'squad', title: 'Frontend', members: ['RS-1'] });

    // Create a period owned by the squad, and another with no squad.
    const b3 = reload(paths);
    createPeriod(b3, {
      type: 'increment',
      title: 'Frontend PI',
      starts: '2026-08-03',
      ends: '2026-08-28',
      squad: sq.id,
    });
    createPeriod(b3, {
      type: 'increment',
      title: 'Unbound PI',
      starts: '2026-08-03',
      ends: '2026-08-28',
    });

    // Work in each period, both assigned to Alice.
    const b4 = reload(paths);
    createIssue(b4, { type: 'program', title: 'P' });
    const b5 = reload(paths);
    createIssue(b5, { type: 'epic', title: 'E', parentId: 'LP-1' });
    const b6 = reload(paths);
    createIssue(b6, { type: 'feature', title: 'F', parentId: 'LP-2' });
    const b7 = reload(paths);
    createIssue(b7, {
      type: 'user_story',
      title: 'Squad work',
      parentId: 'LP-3',
      assignee: 'RS-1',
      period: 'TL-1',
    });
    createIssue(b7, {
      type: 'user_story',
      title: 'Free work',
      parentId: 'LP-3',
      period: 'TL-2',
    });

    // Alice is in the squad: she gets both (squad work + unbound period work).
    const alice = run(paths, 'RS-1', { includeUnassigned: true });
    expect(order(alice)).toEqual(['LP-4', 'LP-5']);

    // Bob is not in the squad: only unbound period work.
    const bob = run(paths, 'RS-2', { includeUnassigned: true });
    expect(order(bob)).toEqual(['LP-5']);
  });

  it('classifies squad-rejected work, not routing or ready', () => {
    const paths = makeBoard('scrum', 'LP');
    writeFileSync(paths.configPath, SQUAD_BOARD_CONFIG, 'utf8');

    const b0 = reload(paths);
    createResource(b0, { type: 'person', title: 'Alice' });
    createResource(b0, { type: 'person', title: 'Bob' });
    const b1 = reload(paths);
    const sq = createSquad(b1, { type: 'squad', title: 'Backend', members: ['RS-1'] });

    const b2 = reload(paths);
    createPeriod(b2, {
      type: 'increment',
      title: 'Backend PI',
      starts: '2026-08-03',
      ends: '2026-08-28',
      squad: sq.id,
    });

    const b3 = reload(paths);
    createIssue(b3, { type: 'program', title: 'P' });
    const b4 = reload(paths);
    createIssue(b4, { type: 'epic', title: 'E', parentId: 'LP-1' });
    const b5 = reload(paths);
    createIssue(b5, { type: 'feature', title: 'F', parentId: 'LP-2' });
    const b6 = reload(paths);
    createIssue(b6, {
      type: 'user_story',
      title: 'Squad-only work',
      parentId: 'LP-3',
      assignee: 'RS-2',
      period: 'TL-1',
    });

    // Bob is assigned but not in the squad → skipped as 'squad', not 'routing'.
    const bob = run(paths, 'RS-2');
    expect(skipsFor(bob, 'squad')).toEqual(['LP-4']);
    expect(skipsFor(bob, 'routing')).toEqual([]);
  });

  it('produces the same sequence on a board with no squads as before', () => {
    // Squad-free regression: a board that declares no squad types must behave
    // identically to how it did before the squad epic.
    const paths = seed();
    timeline(paths);
    story(paths, 'A', { assignee: 'RS-1', period: 'TL-2' });
    story(paths, 'B', { assignee: 'RS-1', period: 'TL-2' });
    story(paths, 'C', { assignee: 'RS-1', period: 'TL-3' });

    const simulation = run(paths, 'RS-1');
    // The running sprint (TL-2) first, then the later one (TL-3).
    expect(order(simulation)).toEqual(['LP-4', 'LP-5', 'LP-6']);
    expect(byReason(simulation)).not.toContain('squad');
  });

  it('a sprint without a squad inherits from its increment', () => {
    const paths = makeBoard('scrum', 'LP');
    writeFileSync(paths.configPath, SQUAD_BOARD_CONFIG, 'utf8');

    const b0 = reload(paths);
    createResource(b0, { type: 'person', title: 'Alice' });
    createResource(b0, { type: 'person', title: 'Bob' });
    const b1 = reload(paths);
    const sq = createSquad(b1, { type: 'squad', title: 'Frontend', members: ['RS-1'] });

    // Increment is owned by the squad, sprint has no squad.
    const b2 = reload(paths);
    createPeriod(b2, { type: 'increment', title: 'PI', starts: '2026-08-03', ends: '2026-08-28', squad: sq.id });
    const b3 = reload(paths);
    createPeriod(b3, { type: 'sprint', title: 'S1', starts: '2026-08-03', ends: '2026-08-14', parentId: 'TL-1' });

    // Work in the sprint, assigned to Alice (in the squad).
    const b4 = reload(paths);
    createIssue(b4, { type: 'program', title: 'P' });
    const b5 = reload(paths);
    createIssue(b5, { type: 'epic', title: 'E', parentId: 'LP-1' });
    const b6 = reload(paths);
    createIssue(b6, { type: 'feature', title: 'F', parentId: 'LP-2' });
    const b7 = reload(paths);
    createIssue(b7, { type: 'user_story', title: 'Sprint work', parentId: 'LP-3', assignee: 'RS-1', period: 'TL-2' });

    // Alice is in the squad: she gets it.
    const alice = run(paths, 'RS-1');
    expect(order(alice)).toEqual(['LP-4']);
  });

  it('a sprint can override its increment\'s squad', () => {
    const paths = makeBoard('scrum', 'LP');
    writeFileSync(paths.configPath, SQUAD_BOARD_CONFIG, 'utf8');

    const b0 = reload(paths);
    createResource(b0, { type: 'person', title: 'Alice' });
    createResource(b0, { type: 'person', title: 'Bob' });
    const b1 = reload(paths);
    const sqA = createSquad(b1, { type: 'squad', title: 'Frontend', members: ['RS-1'] });
    const b2 = reload(paths);
    const sqB = createSquad(b2, { type: 'squad', title: 'Backend', members: ['RS-2'] });

    // Increment is Frontend, sprint explicitly overrides to Backend.
    const b3 = reload(paths);
    createPeriod(b3, { type: 'increment', title: 'PI', starts: '2026-08-03', ends: '2026-08-28', squad: sqA.id });
    const b4 = reload(paths);
    createPeriod(b4, { type: 'sprint', title: 'S1', starts: '2026-08-03', ends: '2026-08-14', parentId: 'TL-1', squad: sqB.id });

    // Work in the sprint.
    const b5 = reload(paths);
    createIssue(b5, { type: 'program', title: 'P' });
    const b6 = reload(paths);
    createIssue(b6, { type: 'epic', title: 'E', parentId: 'LP-1' });
    const b7 = reload(paths);
    createIssue(b7, { type: 'feature', title: 'F', parentId: 'LP-2' });
    const b8 = reload(paths);
    createIssue(b8, { type: 'user_story', title: 'Override story', parentId: 'LP-3', assignee: 'RS-2', period: 'TL-2' });

    // Alice (in Frontend) does NOT get the sprint's work — Backend owns it.
    expect(order(run(paths, 'RS-1'))).toEqual([]);

    // Bob is in Backend: he gets it.
    expect(order(run(paths, 'RS-2'))).toEqual(['LP-4']);
  });
});
