import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { BoardPaths, Issue, NewIssueInput } from '../src/core/index.js';
import {
  USER_ENV_VAR,
  blockedTasks,
  clearCurrentUser,
  clearFlag,
  createIssue,
  createPeriod,
  createResource,
  currentTasks,
  currentUser,
  effortOf,
  findIssue,
  findPeriod,
  findResource,
  flagIssue,
  linkIssue,
  linkResource,
  moveNode,
  nextTasks,
  previousTasks,
  removeNode,
  requireCurrentUser,
  resourceLoad,
  resumableTasks,
  setCurrentUser,
  startStatusId,
  terminalStatusId,
  updateNode,
} from '../src/core/index.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterAll(cleanupBoards);

const TODAY = '2026-08-10';

/**
 * A scrum board with Alice (covering the junior pool), Bob, the pool itself,
 * and a feature to hang stories off.
 */
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
  return createIssue(reload(paths), {
    type: 'user_story',
    title,
    parentId: 'LP-3',
    ...input,
  });
}

const ids = (candidates: Array<{ issue: Issue }>): string[] =>
  candidates.map((candidate) => candidate.issue.id);

/** Declare one more issue type taken whole, the way a board owner would. */
function makeAtomic(paths: BoardPaths, type: string): void {
  const text = readFileSync(paths.configPath, 'utf8');
  const anchor = new RegExp(`^(  ${type}:\\r?\\n    label: .*\\r?\\n)`, 'm');
  expect(text).toMatch(anchor);
  writeFileSync(paths.configPath, text.replace(anchor, '$1    atomic: true\n'), 'utf8');
}

/** A board that declares nothing taken whole — the rule before `atomic`. */
function clearAtomic(paths: BoardPaths): void {
  const text = readFileSync(paths.configPath, 'utf8');
  writeFileSync(paths.configPath, text.replace(/^ +atomic: true\r?\n/gm, ''), 'utf8');
}

describe('what to work on next', () => {
  it('offers work assigned to me and work parked in a pool I cover', () => {
    const paths = seed();
    story(paths, 'Mine', { assignee: 'RS-1' });
    story(paths, 'Pooled', { assignee: 'RS-3' });
    story(paths, 'Bobs', { assignee: 'RS-2' });

    const board = reload(paths);
    const candidates = nextTasks(board, 'RS-1', { today: TODAY });

    expect(ids(candidates)).toEqual(['LP-4', 'LP-5']);
    expect(candidates.map((candidate) => candidate.route)).toEqual(['direct', 'pool']);
    expect(candidates[1]!.pool!.id).toBe('RS-3');
  });

  it('leaves unassigned work out until asked for it', () => {
    const paths = seed();
    story(paths, 'Nobody');

    const board = reload(paths);
    expect(nextTasks(board, 'RS-1', { today: TODAY })).toEqual([]);
    const opened = nextTasks(board, 'RS-1', { today: TODAY, includeUnassigned: true });
    expect(ids(opened)).toEqual(['LP-4']);
    expect(opened[0]!.route).toBe('unassigned');
  });

  it('does not offer a pool to someone who does not cover it', () => {
    const paths = seed();
    story(paths, 'Pooled', { assignee: 'RS-3' });
    expect(nextTasks(reload(paths), 'RS-2', { today: TODAY })).toEqual([]);
  });

  it('holds back blocked work and says what it is waiting on', () => {
    const paths = seed();
    story(paths, 'First', { assignee: 'RS-1' });
    story(paths, 'Second', { assignee: 'RS-1' });
    linkIssue(reload(paths), findIssue(reload(paths), 'LP-5')!, { dependsOn: ['LP-4'] });

    const board = reload(paths);
    expect(ids(nextTasks(board, 'RS-1', { today: TODAY }))).toEqual(['LP-4']);
    const blocked = blockedTasks(board, 'RS-1', { today: TODAY });
    expect(ids(blocked)).toEqual(['LP-5']);
    expect(blocked[0]!.blockedBy.map((issue) => issue.id)).toEqual(['LP-4']);
  });

  it('releases the blocked work once the blocker is done', () => {
    const paths = seed();
    story(paths, 'First', { assignee: 'RS-1' });
    story(paths, 'Second', { assignee: 'RS-1' });
    linkIssue(reload(paths), findIssue(reload(paths), 'LP-5')!, { dependsOn: ['LP-4'] });
    moveNode(reload(paths), findIssue(reload(paths), 'LP-4')!, { status: 'done' });

    expect(ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual(['LP-5']);
  });

  it('never offers a container, only the work units under it', () => {
    const paths = seed();
    // LP-3 is the feature; it is nobody's job, the stories under it are.
    moveNode(reload(paths), findIssue(reload(paths), 'LP-3')!, { assignee: 'RS-1' });
    story(paths, 'Real work', { assignee: 'RS-1' });

    expect(ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual(['LP-4']);
  });

  it('offers an atomic story whole, and never its sub-tasks', () => {
    const paths = seed();
    story(paths, 'Parent', { assignee: 'RS-1' });
    createIssue(reload(paths), {
      type: 'sub_task',
      title: 'Child',
      parentId: 'LP-4',
      assignee: 'RS-1',
    });

    // Scrum declares `user_story` atomic: the story is the job, and the
    // sub-task under it is its checklist rather than a second ticket.
    expect(ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual(['LP-4']);
  });

  it('falls back to leaves when the board declares nothing atomic', () => {
    const paths = seed();
    clearAtomic(paths);
    story(paths, 'Parent', { assignee: 'RS-1' });
    createIssue(reload(paths), {
      type: 'sub_task',
      title: 'Child',
      parentId: 'LP-4',
      assignee: 'RS-1',
    });

    expect(ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual(['LP-5']);
  });

  it('lets the outermost atomic type win when they nest', () => {
    const paths = seed();
    makeAtomic(paths, 'feature');
    story(paths, 'Inner', { assignee: 'RS-1' });
    moveNode(reload(paths), findIssue(reload(paths), 'LP-3')!, { assignee: 'RS-1' });

    // Both the feature and the story are declared atomic. The feature is the
    // outer unit, so it is the one offered and the story is inside it.
    expect(ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual(['LP-3']);
  });

  it('skips work that is already finished or in flight', () => {
    const paths = seed();
    story(paths, 'Done', { assignee: 'RS-1', status: 'done' });
    story(paths, 'Doing', { assignee: 'RS-1', status: 'in_progress' });
    story(paths, 'Waiting', { assignee: 'RS-1' });

    expect(ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual(['LP-6']);
  });

  it('honours the limit', () => {
    const paths = seed();
    story(paths, 'One', { assignee: 'RS-1' });
    story(paths, 'Two', { assignee: 'RS-1' });
    expect(nextTasks(reload(paths), 'RS-1', { today: TODAY, limit: 1 })).toHaveLength(1);
  });

  it('returns nothing for someone who is not on the roster', () => {
    expect(nextTasks(reload(seed()), 'RS-99', { today: TODAY })).toEqual([]);
  });
});

describe('how work is ranked', () => {
  it('puts the running period first, then unscheduled, then what has not started', () => {
    const paths = seed();
    createPeriod(reload(paths), {
      type: 'increment',
      title: 'H2',
      starts: '2026-07-01',
      ends: '2026-12-31',
    });
    createPeriod(reload(paths), {
      type: 'sprint',
      title: 'Now',
      starts: '2026-08-03',
      ends: '2026-08-14',
      parentId: 'TL-1',
    });
    createPeriod(reload(paths), {
      type: 'sprint',
      title: 'Later',
      starts: '2026-08-17',
      ends: '2026-08-28',
      parentId: 'TL-1',
    });

    story(paths, 'Future', { assignee: 'RS-1', period: 'TL-3' });
    story(paths, 'Unscheduled', { assignee: 'RS-1' });
    story(paths, 'Current', { assignee: 'RS-1', period: 'TL-2' });

    expect(ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual([
      'LP-6',
      'LP-5',
      'LP-4',
    ]);
  });

  /**
   * The switch is a steering wheel: it does not hide work, it decides which
   * work is offered first. A switched-off timebox sinks below even unscheduled
   * work, because it is the one bucket somebody asked for by hand.
   */
  describe('when a period is switched on or off', () => {
    /** H2 with a sprint running now and one that has not started. */
    function timeline(paths: BoardPaths): void {
      createPeriod(reload(paths), {
        type: 'increment',
        title: 'H2',
        starts: '2026-07-01',
        ends: '2026-12-31',
      });
      createPeriod(reload(paths), {
        type: 'sprint',
        title: 'Now',
        starts: '2026-08-03',
        ends: '2026-08-14',
        parentId: 'TL-1',
      });
      createPeriod(reload(paths), {
        type: 'sprint',
        title: 'Later',
        starts: '2026-08-17',
        ends: '2026-08-28',
        parentId: 'TL-1',
      });
    }

    const setSwitch = (paths: BoardPaths, id: string, active: boolean | null): void => {
      const board = reload(paths);
      updateNode(board, findPeriod(board, id)!, { active });
    };

    it('withholds a switched-off period rather than merely ranking it last', () => {
      const paths = seed();
      timeline(paths);
      story(paths, 'In the parked sprint', { assignee: 'RS-1', period: 'TL-2' });
      story(paths, 'Unscheduled', { assignee: 'RS-1' });

      // On its dates, the running sprint leads.
      expect(ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual(['LP-4', 'LP-5']);

      // Switched off, it is not offered at all. Ranking it last is not enough:
      // once the unscheduled work runs out, "last" becomes "next", and a reader
      // who parked the sprint would be handed it anyway.
      setSwitch(paths, 'TL-2', false);
      expect(ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual(['LP-5']);
    });

    it('offers a switched-off period last when it is asked for', () => {
      const paths = seed();
      timeline(paths);
      story(paths, 'In the parked sprint', { assignee: 'RS-1', period: 'TL-2' });
      story(paths, 'Unscheduled', { assignee: 'RS-1' });
      setSwitch(paths, 'TL-2', false);

      const asked = nextTasks(reload(paths), 'RS-1', { today: TODAY, includeParked: true });
      expect(ids(asked)).toEqual(['LP-5', 'LP-4']);
    });

    it('parks everything inside an increment that is switched off', () => {
      const paths = seed();
      timeline(paths);
      story(paths, 'In a sprint', { assignee: 'RS-1', period: 'TL-2' });
      story(paths, 'Unscheduled', { assignee: 'RS-1' });

      setSwitch(paths, 'TL-1', false);
      expect(ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual(['LP-5']);
      expect(
        ids(nextTasks(reload(paths), 'RS-1', { today: TODAY, includeParked: true })),
      ).toEqual(['LP-5', 'LP-4']);
    });

    it('keeps a parked issue reachable, and out of the blocked list too', () => {
      const paths = seed();
      timeline(paths);
      story(paths, 'Parked and blocked', { assignee: 'RS-1', period: 'TL-2' });
      story(paths, 'Its blocker', { assignee: 'RS-2' });
      linkIssue(reload(paths), findIssue(reload(paths), 'LP-4')!, { dependsOn: ['LP-5'] });
      setSwitch(paths, 'TL-2', false);

      // Withholding is one rule applied in one place, so the blocked list agrees
      // with the ready list about what is on offer.
      expect(blockedTasks(reload(paths), 'RS-1', { today: TODAY })).toEqual([]);
      expect(
        ids(blockedTasks(reload(paths), 'RS-1', { today: TODAY, includeParked: true })),
      ).toEqual(['LP-4']);

      // Reachable by id regardless: this is routing, not permission.
      expect(findIssue(reload(paths), 'LP-4')).not.toBeNull();
    });

    it('lifts a period switched on before its dates', () => {
      const paths = seed();
      timeline(paths);
      story(paths, 'Next sprint', { assignee: 'RS-1', period: 'TL-3' });
      story(paths, 'Unscheduled', { assignee: 'RS-1' });

      // TL-3 has not started, so it ranks last of the two.
      expect(ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual(['LP-5', 'LP-4']);

      setSwitch(paths, 'TL-3', true);
      expect(ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual(['LP-4', 'LP-5']);
    });

    it('goes back to the dates when the switch is taken off', () => {
      const paths = seed();
      timeline(paths);
      story(paths, 'In the sprint', { assignee: 'RS-1', period: 'TL-2' });
      story(paths, 'Unscheduled', { assignee: 'RS-1' });

      setSwitch(paths, 'TL-2', false);
      setSwitch(paths, 'TL-2', null);
      expect(ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual(['LP-4', 'LP-5']);
    });

    /**
     * A sprint that merely ran out of calendar is the most urgent thing on the
     * board, not the least — only the switch moves work down.
     */
    it('leaves work in a period that has ended at the front', () => {
      const paths = seed();
      timeline(paths);
      story(paths, 'Overran', { assignee: 'RS-1', period: 'TL-2' });
      story(paths, 'Unscheduled', { assignee: 'RS-1' });

      expect(ids(nextTasks(reload(paths), 'RS-1', { today: '2026-09-01' }))).toEqual([
        'LP-4',
        'LP-5',
      ]);
    });
  });

  it('sorts by the declared priority order, most important first', () => {
    const paths = seed();
    story(paths, 'Low', { assignee: 'RS-1', attributes: { priority: 'low' } });
    story(paths, 'Critical', { assignee: 'RS-1', attributes: { priority: 'critical' } });
    story(paths, 'Medium', { assignee: 'RS-1', attributes: { priority: 'medium' } });

    expect(ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual([
      'LP-5',
      'LP-6',
      'LP-4',
    ]);
  });

  it('prefers the column closest to done when priorities tie', () => {
    const paths = seed();
    story(paths, 'Backlog', { assignee: 'RS-1' });
    story(paths, 'Ready', { assignee: 'RS-1', status: 'ready' });

    expect(ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual(['LP-5', 'LP-4']);
  });

  it('prefers work that unblocks the most, then the oldest id', () => {
    const paths = seed();
    story(paths, 'Quiet', { assignee: 'RS-1' });
    story(paths, 'Unblocks two', { assignee: 'RS-1' });
    story(paths, 'Waiting a', { assignee: 'RS-2' });
    story(paths, 'Waiting b', { assignee: 'RS-2' });
    linkIssue(reload(paths), findIssue(reload(paths), 'LP-6')!, { dependsOn: ['LP-5'] });
    linkIssue(reload(paths), findIssue(reload(paths), 'LP-7')!, { dependsOn: ['LP-5'] });

    expect(ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual(['LP-5', 'LP-4']);
  });

  /**
   * A queue that separated two ready stories by priority, column and id alone
   * handed out one story from each feature in turn: nothing in that order knew
   * that somebody had already finished half of the first one. Work whose
   * container is already moving comes first, so a run finishes what the board
   * has started rather than opening a front in every feature on the plan.
   *
   * @see src/shared/cohesion.ts for the rule and the order inside it.
   */
  describe('when one part of the plan is already under way', () => {
    /** A second feature (LP-4) beside `Guest flow`, under the same epic. */
    function twoFeatures(paths: BoardPaths): void {
      createIssue(reload(paths), { type: 'feature', title: 'Saved cards', parentId: 'LP-2' });
    }

    it('finishes the feature with work already done before opening another', () => {
      const paths = seed();
      twoFeatures(paths);
      story(paths, 'Done here', { status: 'done' });
      story(paths, 'Untouched feature', { assignee: 'RS-1', parentId: 'LP-4' });
      story(paths, 'Untouched feature too', { assignee: 'RS-1', parentId: 'LP-4' });
      story(paths, 'Left here', { assignee: 'RS-1' });

      // LP-8 is the rest of the feature somebody is half way through, and it
      // is the newest issue on the board: age is the tiebreak this replaced.
      expect(ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual([
        'LP-8',
        'LP-6',
        'LP-7',
      ]);
    });

    it('prefers the feature somebody is inside right now', () => {
      const paths = seed();
      twoFeatures(paths);
      story(paths, 'Finished', { status: 'done' });
      story(paths, 'Rest of the half-built feature', { assignee: 'RS-1' });
      story(paths, 'In flight', { assignee: 'RS-2', status: 'in_progress', parentId: 'LP-4' });
      story(paths, 'Beside the work in flight', { assignee: 'RS-1', parentId: 'LP-4' });

      // Work in flight beats work merely further along: the strongest reason
      // not to open a third front is that somebody is inside the second one.
      expect(ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual(['LP-8', 'LP-6']);
    });

    it('leaves a priority somebody set by hand above it', () => {
      const paths = seed();
      twoFeatures(paths);
      story(paths, 'Done here', { status: 'done' });
      story(paths, 'Ongoing but medium', {
        assignee: 'RS-1',
        attributes: { priority: 'medium' },
      });
      story(paths, 'Untouched but critical', {
        assignee: 'RS-1',
        parentId: 'LP-4',
        attributes: { priority: 'critical' },
      });

      // Cohesion is a tiebreak between work nobody has ranked, not a way to
      // out-vote the three signals a person set: the schedule, the priority
      // and the column.
      expect(ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual(['LP-7', 'LP-6']);
    });

    it('leaves the running period above it', () => {
      const paths = seed();
      twoFeatures(paths);
      createPeriod(reload(paths), {
        type: 'increment',
        title: 'H2',
        starts: '2026-07-01',
        ends: '2026-12-31',
      });
      createPeriod(reload(paths), {
        type: 'sprint',
        title: 'Now',
        starts: '2026-08-03',
        ends: '2026-08-14',
        parentId: 'TL-1',
      });
      story(paths, 'Done here', { status: 'done' });
      story(paths, 'Ongoing, unscheduled', { assignee: 'RS-1' });
      story(paths, 'Untouched, this sprint', {
        assignee: 'RS-1',
        parentId: 'LP-4',
        period: 'TL-2',
      });

      expect(ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual(['LP-7', 'LP-6']);
    });

    it('does not reorder two stories inside one feature', () => {
      const paths = seed();
      twoFeatures(paths);
      story(paths, 'Done here', { status: 'done' });
      story(paths, 'Blocks nothing', { assignee: 'RS-1' });
      story(paths, 'Unblocks one', { assignee: 'RS-1' });
      story(paths, 'Untouched feature', { assignee: 'RS-1', parentId: 'LP-4' });
      story(paths, 'Waiting', { assignee: 'RS-2', parentId: 'LP-4' });
      linkIssue(reload(paths), findIssue(reload(paths), 'LP-9')!, { dependsOn: ['LP-7'] });

      // Two stories in the same feature are not alternatives to each other in
      // this sense, so the order inside it is what it always was.
      expect(ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual([
        'LP-7',
        'LP-6',
        'LP-8',
      ]);
    });

    it('asks at the epic level before the feature level', () => {
      const paths = seed();
      createIssue(reload(paths), { type: 'feature', title: 'Wallet', parentId: 'LP-2' });
      createIssue(reload(paths), { type: 'epic', title: 'Refunds', parentId: 'LP-1' });
      createIssue(reload(paths), { type: 'feature', title: 'Cards', parentId: 'LP-5' });
      story(paths, 'Done in Refunds', { status: 'done', parentId: 'LP-6' });
      story(paths, 'Rest of Refunds', { assignee: 'RS-1', parentId: 'LP-6' });
      story(paths, 'In flight in Checkout', { assignee: 'RS-2', status: 'in_progress' });
      story(paths, 'Untouched feature of Checkout', { assignee: 'RS-1', parentId: 'LP-4' });

      // Two epics are where these two stories are really alternatives, and
      // Checkout is the one under way — so its untouched feature comes first
      // even though, feature against feature, Refunds is the half-built one.
      expect(ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual(['LP-10', 'LP-8']);
    });
  });
});

describe('current and previous work', () => {
  it('lists what I have in flight', () => {
    const paths = seed();
    story(paths, 'Doing', { assignee: 'RS-1', status: 'in_progress' });
    story(paths, 'Reviewing', { assignee: 'RS-1', status: 'in_review' });
    story(paths, 'Waiting', { assignee: 'RS-1' });
    story(paths, 'Someone else', { assignee: 'RS-2', status: 'in_progress' });

    expect(currentTasks(reload(paths), 'RS-1').map((issue) => issue.id)).toEqual(['LP-4', 'LP-5']);
  });

  it('lists what I finished, newest first', () => {
    const paths = seed();
    story(paths, 'Older', { assignee: 'RS-1', status: 'done' });
    story(paths, 'Newer', { assignee: 'RS-1', status: 'done' });
    // `updated` is what orders these, so touch the older one last.
    moveNode(reload(paths), findIssue(reload(paths), 'LP-4')!, { status: 'done' });

    const previous = previousTasks(reload(paths), 'RS-1');
    expect(previous.map((issue) => issue.id)).toEqual(['LP-4', 'LP-5']);
    expect(previousTasks(reload(paths), 'RS-1', 1).map((issue) => issue.id)).toEqual(['LP-4']);
  });
});

// The queue never offers work in an active status — it has been picked up. That
// leaves anything working the queue on its own (`lpm queue simulate`,
// `lpm queue agent`) unable to come back to a task it claimed and did not
// finish, so `resumableTasks` is the one answer to "what may I carry on with".
describe('work already picked up', () => {
  it('offers back what I am holding, ranked, blocked or not', () => {
    const paths = seed();
    story(paths, 'Mine', { assignee: 'RS-1', status: 'in_progress' });
    story(paths, 'Downstream', { assignee: 'RS-1', status: 'in_progress' });
    story(paths, 'Not started', { assignee: 'RS-1' });
    story(paths, 'Bobs', { assignee: 'RS-2', status: 'in_progress' });
    linkIssue(reload(paths), findIssue(reload(paths), 'LP-5')!, { dependsOn: ['LP-4'] });

    const board = reload(paths);
    const resumable = resumableTasks(board, 'RS-1', { today: TODAY });

    expect(ids(resumable)).toEqual(['LP-4', 'LP-5']);
    expect(resumable.every((candidate) => candidate.route === 'direct')).toBe(true);
    // Being blocked does not stop you carrying on with it: it is already yours.
    expect(ids(resumable.filter((candidate) => candidate.blockedBy.length))).toEqual(['LP-5']);
  });

  it('stops at a flag, because that work has stopped and needs a person', () => {
    const paths = seed();
    story(paths, 'Stalled', { assignee: 'RS-1', status: 'in_progress' });
    story(paths, 'Fine', { assignee: 'RS-1', status: 'in_progress' });
    flagIssue(reload(paths), findIssue(reload(paths), 'LP-4')!, {
      reason: 'blocked',
      comment: 'waiting on a credential',
    });

    expect(ids(resumableTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual(['LP-5']);
  });

  it('never offers a container somebody moved into an active column', () => {
    const paths = seed();
    moveNode(reload(paths), findIssue(reload(paths), 'LP-3')!, {
      assignee: 'RS-1',
      status: 'in_progress',
    });
    story(paths, 'Inside', { assignee: 'RS-1', status: 'in_progress' });

    expect(ids(resumableTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual(['LP-4']);
  });

  it('ignores the period switch and the scope, exactly as `currentTasks` does', () => {
    const paths = seed();
    createPeriod(reload(paths), {
      type: 'increment',
      title: 'PI 1',
      starts: '2026-08-03',
      ends: '2026-08-28',
    });
    createPeriod(reload(paths), {
      type: 'sprint',
      title: 'Parked',
      parentId: 'TL-1',
      starts: '2026-08-03',
      ends: '2026-08-14',
      active: false,
    });
    story(paths, 'Mine', { assignee: 'RS-1', status: 'in_progress', period: 'TL-2' });

    // The queue withholds it; carrying on with it is not the queue's call.
    expect(nextTasks(reload(paths), 'RS-1', { today: TODAY })).toEqual([]);
    expect(ids(resumableTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual(['LP-4']);
  });
});

// "A flagged task is never re-offered" is what `lpm queue agent` promises. Most
// flagged work is in progress and held back by that alone, but a flag can be
// raised on anything unfinished — and then the queue was offering work somebody
// had already said had stopped.
describe('flagged work is not offered', () => {
  it('is withheld from the queue whatever column it sits in', () => {
    const paths = seed();
    story(paths, 'Stopped', { assignee: 'RS-1' });
    story(paths, 'Fine', { assignee: 'RS-1' });
    flagIssue(reload(paths), findIssue(reload(paths), 'LP-4')!, {
      reason: 'blocked',
      comment: 'the vendor has not answered',
    });

    expect(ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual(['LP-5']);
  });

  it('is offered again the moment the flag is cleared', () => {
    const paths = seed();
    story(paths, 'Stopped', { assignee: 'RS-1' });
    flagIssue(reload(paths), findIssue(reload(paths), 'LP-4')!, {
      reason: 'blocked',
      comment: 'the vendor has not answered',
    });
    clearFlag(reload(paths), findIssue(reload(paths), 'LP-4')!, { comment: 'they answered' });

    expect(ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual(['LP-4']);
  });

  it('is still reachable by id — a flag steers the queue, it does not hide work', () => {
    const paths = seed();
    story(paths, 'Stopped', { assignee: 'RS-1' });
    flagIssue(reload(paths), findIssue(reload(paths), 'LP-4')!, {
      reason: 'blocked',
      comment: 'the vendor has not answered',
    });

    expect(findIssue(reload(paths), 'LP-4')!.flag).toBe('blocked');
  });
});

describe('the load report', () => {
  it('counts open, in-flight and finished work per resource', () => {
    const paths = seed();
    story(paths, 'A', { assignee: 'RS-1' });
    story(paths, 'B', { assignee: 'RS-1', status: 'in_progress' });
    story(paths, 'C', { assignee: 'RS-1', status: 'done' });
    story(paths, 'D', { assignee: 'RS-3' });
    story(paths, 'E');

    const report = resourceLoad(reload(paths));
    const alice = report.rows.find((row) => row.resource?.id === 'RS-1')!;

    expect([alice.open, alice.wip, alice.done]).toEqual([2, 1, 1]);
    expect(alice.capacity).toBe(1);
    expect(alice.covers).toEqual(['RS-3']);
    expect(report.rows.find((row) => row.resource?.id === 'RS-3')!.coveredBy).toEqual(['RS-1']);
    expect(report.unassigned.open).toBe(1);
    expect(report.totals.open).toBe(4);
  });

  it('adds up the effort attribute the board declares', () => {
    const paths = seed();
    story(paths, 'A', { assignee: 'RS-1', attributes: { story_points: 3 } });
    story(paths, 'B', { assignee: 'RS-1', attributes: { story_points: 5 } });
    story(paths, 'C', { assignee: 'RS-1', attributes: { story_points: 8 }, status: 'done' });

    const report = resourceLoad(reload(paths));
    expect(report.rows.find((row) => row.resource?.id === 'RS-1')!.effort).toBe(8);
    expect(report.totals.effort).toBe(8);
    expect(effortOf(reload(paths), findIssue(reload(paths), 'LP-4')!)).toBe(3);
  });

  it('counts a container once, through the work units under it', () => {
    const paths = seed();
    moveNode(reload(paths), findIssue(reload(paths), 'LP-3')!, { assignee: 'RS-1' });
    story(paths, 'A', { assignee: 'RS-1', attributes: { story_points: 3 } });
    story(paths, 'B', { assignee: 'RS-1', attributes: { story_points: 5 } });

    // The feature is assigned to Alice too, but it is not work — its stories are.
    const alice = resourceLoad(reload(paths)).rows.find((row) => row.resource?.id === 'RS-1')!;
    expect(alice.open).toBe(2);
    expect(alice.effort).toBe(8);
  });

  it('counts an atomic story once, and not the sub-tasks inside it', () => {
    const paths = seed();
    story(paths, 'Parent', { assignee: 'RS-1', attributes: { story_points: 8 } });
    createIssue(reload(paths), {
      type: 'sub_task',
      title: 'Child',
      parentId: 'LP-4',
      assignee: 'RS-1',
    });

    // The story is the unit, so its points are the load and the sub-task is not
    // a second open item. Before `atomic`, the story vanished behind the
    // sub-task and its 8 points went uncounted entirely.
    const alice = resourceLoad(reload(paths)).rows.find((row) => row.resource?.id === 'RS-1')!;
    expect(alice.open).toBe(1);
    expect(alice.effort).toBe(8);
  });

  it('scopes to a period and its child periods', () => {
    const paths = seed();
    createPeriod(reload(paths), {
      type: 'increment',
      title: 'H2',
      starts: '2026-07-01',
      ends: '2026-12-31',
    });
    createPeriod(reload(paths), {
      type: 'sprint',
      title: 'Sprint 1',
      starts: '2026-08-03',
      ends: '2026-08-14',
      parentId: 'TL-1',
    });
    story(paths, 'In sprint', { assignee: 'RS-1', period: 'TL-2' });
    story(paths, 'Elsewhere', { assignee: 'RS-1' });

    const report = resourceLoad(reload(paths), { periodId: 'TL-1' });
    expect(report.period!.id).toBe('TL-1');
    expect(report.rows.find((row) => row.resource?.id === 'RS-1')!.open).toBe(1);
  });

  it('names the pools nobody can serve', () => {
    const paths = seed();
    createResource(reload(paths), { type: 'role', title: 'Sr. data engineer' });
    story(paths, 'Needs a data engineer', { assignee: 'RS-4' });
    story(paths, 'Needs a junior', { assignee: 'RS-3' });

    const report = resourceLoad(reload(paths));
    expect(report.uncovered.map((resource) => resource.id)).toEqual(['RS-4']);
  });
});

describe('the current user', () => {
  it('is stored per checkout and kept out of git', () => {
    const paths = seed();
    setCurrentUser(reload(paths), 'alice');

    expect(currentUser(reload(paths))!.resource!.id).toBe('RS-1');
    expect(requireCurrentUser(reload(paths)).id).toBe('RS-1');
    expect(JSON.parse(readFileSync(paths.localPath, 'utf8'))).toEqual({
      user: 'RS-1',
      profile: null,
    });
    expect(readFileSync(path.join(paths.lpmDir, '.gitignore'), 'utf8')).toMatch(/^local\.json$/m);
  });

  it('can be cleared', () => {
    const paths = seed();
    setCurrentUser(reload(paths), 'RS-1');
    clearCurrentUser(reload(paths));
    expect(currentUser(reload(paths))).toBeNull();
    expect(() => requireCurrentUser(reload(paths))).toThrow(/No current user set/);
  });

  it('cannot be a pool', () => {
    const paths = seed();
    expect(() => setCurrentUser(reload(paths), 'RS-3')).toThrow(/is a pool, not a person/);
  });

  it('reports a stored user who has left the roster', () => {
    const paths = seed();
    setCurrentUser(reload(paths), 'RS-1');
    process.env[USER_ENV_VAR] = 'RS-42';
    try {
      expect(currentUser(reload(paths))).toEqual({
        ref: 'RS-42',
        resource: null,
        source: 'env',
      });
      expect(() => requireCurrentUser(reload(paths))).toThrow(/is not in the roster/);
    } finally {
      delete process.env[USER_ENV_VAR];
    }
  });

  it('lets the environment override the stored user', () => {
    const paths = seed();
    setCurrentUser(reload(paths), 'RS-1');
    process.env[USER_ENV_VAR] = 'Bob Jones';
    try {
      expect(requireCurrentUser(reload(paths)).id).toBe('RS-2');
    } finally {
      delete process.env[USER_ENV_VAR];
    }
  });
});

describe('status roles', () => {
  it('reads the start and end columns from the config', () => {
    const board = reload(makeBoard('scrum', 'LP'));
    expect(startStatusId(board.config)).toBe('in_progress');
    expect(terminalStatusId(board.config)).toBe('done');
  });

  it('falls back to the column after the default when none is marked active', () => {
    const board = reload(makeBoard('scrum', 'LP'));
    const config = {
      ...board.config,
      statuses: board.config.statuses.map((status) => ({ ...status, active: false })),
    };
    expect(startStatusId(config)).toBe('ready');
  });
});

describe('focusParent cohesion (opt-in ranking)', () => {
  it('prefers a sibling under the focus parent, and is off by default', () => {
    const paths = seed();
    // A second feature under the epic, so two features hold ready work.
    createIssue(reload(paths), { type: 'feature', title: 'Other flow', parentId: 'LP-2' }); // LP-4
    story(paths, 'A1', { assignee: 'RS-1' }); // LP-5, under LP-3
    createIssue(reload(paths), { type: 'user_story', title: 'B1', parentId: 'LP-4', assignee: 'RS-1' }); // LP-6, under LP-4
    story(paths, 'A2', { assignee: 'RS-1' }); // LP-7, under LP-3

    const board = reload(paths);
    // Without focusParent, ranking is by issue number.
    expect(ids(nextTasks(board, 'RS-1', { today: TODAY }))).toEqual(['LP-5', 'LP-6', 'LP-7']);
    // With it, both of LP-3's stories rank ahead of the other feature's,
    // keeping their own order — the other feature's LP-6 drops to last.
    expect(ids(nextTasks(board, 'RS-1', { today: TODAY, focusParent: 'LP-3' }))).toEqual([
      'LP-5',
      'LP-7',
      'LP-6',
    ]);
  });
});

describe('dependencies between parents', () => {
  /**
   * Two features under the epic, the second waiting on the first, with two
   * stories each. Nobody writes a dependency between the *stories*: the plan
   * says the second feature comes after the first, and the stories inherit it.
   */
  function twoFeatures(): BoardPaths {
    const paths = seed();
    createIssue(reload(paths), { type: 'feature', title: 'Card flow', parentId: 'LP-2' }); // LP-4
    linkIssue(reload(paths), findIssue(reload(paths), 'LP-4')!, { dependsOn: ['LP-3'] });
    story(paths, 'Guest A', { assignee: 'RS-1' }); // LP-5, under LP-3
    story(paths, 'Guest B', { assignee: 'RS-1' }); // LP-6, under LP-3
    createIssue(reload(paths), { type: 'user_story', title: 'Card A', parentId: 'LP-4', assignee: 'RS-1' }); // LP-7
    createIssue(reload(paths), { type: 'user_story', title: 'Card B', parentId: 'LP-4', assignee: 'RS-1' }); // LP-8
    return paths;
  }

  const done = (paths: BoardPaths, ...idList: string[]): void => {
    for (const id of idList) moveNode(reload(paths), findIssue(reload(paths), id)!, { status: 'done' });
  };

  it('holds back a story whose feature waits on another feature', () => {
    const paths = twoFeatures();
    const board = reload(paths);

    expect(ids(nextTasks(board, 'RS-1', { today: TODAY }))).toEqual(['LP-5', 'LP-6']);
    const blocked = blockedTasks(board, 'RS-1', { today: TODAY });
    expect(ids(blocked)).toEqual(['LP-7', 'LP-8']);
    // Reported as the plan writes it — the feature, not the stories inside it.
    expect(blocked[0]!.blockedBy.map((issue) => issue.id)).toEqual(['LP-3']);
  });

  it('clears the inherited dependency when the work inside the blocker is done', () => {
    const paths = twoFeatures();
    // Nobody moves LP-3 itself: a feature is the name of the stories under it,
    // and closing the last one rolls the feature up. @see src/shared/rollup.ts
    done(paths, 'LP-5');
    expect(ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual(['LP-6']);

    done(paths, 'LP-6');
    expect(findIssue(reload(paths), 'LP-3')!.status).toBe('done');
    expect(ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual(['LP-7', 'LP-8']);
  });

  it('takes a terminal status on the container as the answer for its contents', () => {
    const paths = twoFeatures();
    // Closing a feature answers for everything under it, so LP-4 stops waiting
    // even though its stories were never moved. Their own documents are
    // untouched, so they are still work anybody can pick up.
    done(paths, 'LP-3');
    expect(ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual([
      'LP-5',
      'LP-6',
      'LP-7',
      'LP-8',
    ]);
  });

  it('inherits from every issue above, not just the nearest one', () => {
    const paths = seed();
    // A second epic waiting on the first, with a feature and a story inside it.
    createIssue(reload(paths), { type: 'epic', title: 'Refunds', parentId: 'LP-1' }); // LP-4
    linkIssue(reload(paths), findIssue(reload(paths), 'LP-4')!, { dependsOn: ['LP-2'] });
    createIssue(reload(paths), { type: 'feature', title: 'Refund flow', parentId: 'LP-4' }); // LP-5
    createIssue(reload(paths), { type: 'user_story', title: 'Refund A', parentId: 'LP-5', assignee: 'RS-1' }); // LP-6
    story(paths, 'Guest A', { assignee: 'RS-1' }); // LP-7, under LP-3, inside LP-2

    const board = reload(paths);
    expect(ids(nextTasks(board, 'RS-1', { today: TODAY }))).toEqual(['LP-7']);
    // Two levels up: the story's grandparent epic is what it is waiting on.
    expect(
      blockedTasks(board, 'RS-1', { today: TODAY })[0]!.blockedBy.map((issue) => issue.id),
    ).toEqual(['LP-2']);

    done(paths, 'LP-7');
    expect(ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual(['LP-6']);
  });

  it('reports its own dependency before the ones it inherits', () => {
    const paths = twoFeatures();
    linkIssue(reload(paths), findIssue(reload(paths), 'LP-8')!, { dependsOn: ['LP-7'] });

    const blocked = blockedTasks(reload(paths), 'RS-1', { today: TODAY });
    expect(blocked.find((candidate) => candidate.issue.id === 'LP-8')!.blockedBy.map((i) => i.id))
      .toEqual(['LP-7', 'LP-3']);
  });

  it('ignores a dependency pointing back into the issue own lineage', () => {
    const paths = seed();
    story(paths, 'Guest A', { assignee: 'RS-1' }); // LP-4
    // Somebody wires a story to the feature it lives in. Honouring that would
    // block the work on itself for ever, so it is dropped instead.
    linkIssue(reload(paths), findIssue(reload(paths), 'LP-4')!, { dependsOn: ['LP-3'] });

    expect(ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual(['LP-4']);
  });

  it('is not blocked by a dependency the board no longer has', () => {
    const paths = twoFeatures();
    removeNode(reload(paths), findIssue(reload(paths), 'LP-3')!);
    // LP-4 still names LP-3 in depends_on; a dangling edge is `check`'s
    // business, not a reason to stop offering the work under it.
    expect(ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual(['LP-7', 'LP-8']);
  });
});

describe('a dependency on a spike gates the work that waits for it', () => {
  /** A spike beside two stories, one of which was written from its findings. */
  function withSpike(): BoardPaths {
    const paths = seed();
    createIssue(reload(paths), { type: 'research', title: 'Measure the gateway', parentId: 'LP-3', assignee: 'RS-1' }); // LP-4
    story(paths, 'Retry queue', { assignee: 'RS-1' }); // LP-5
    story(paths, 'Unrelated', { assignee: 'RS-1' }); // LP-6
    linkIssue(reload(paths), findIssue(reload(paths), 'LP-5')!, { dependsOn: ['LP-4'] });
    return paths;
  }

  it('withholds an issue until the research it waits on is finished', () => {
    const board = reload(withSpike());
    expect(ids(nextTasks(board, 'RS-1', { today: TODAY }))).toEqual(['LP-4', 'LP-6']);

    const blocked = blockedTasks(board, 'RS-1', { today: TODAY });
    expect(ids(blocked)).toEqual(['LP-5']);
    expect(blocked[0]!.blockedBy.map((issue) => issue.id)).toEqual(['LP-4']);
  });

  it('releases it once the research is done', () => {
    const paths = withSpike();
    moveNode(reload(paths), findIssue(reload(paths), 'LP-4')!, { status: 'done' });
    expect(ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual(['LP-5', 'LP-6']);
  });

  it('inherits a dependency written on a parent', () => {
    const paths = seed();
    createIssue(reload(paths), { type: 'feature', title: 'Card flow', parentId: 'LP-2' }); // LP-4
    createIssue(reload(paths), { type: 'research', title: 'Spike', parentId: 'LP-3', assignee: 'RS-1' }); // LP-5
    linkIssue(reload(paths), findIssue(reload(paths), 'LP-4')!, { dependsOn: ['LP-5'] });
    createIssue(reload(paths), { type: 'user_story', title: 'Card A', parentId: 'LP-4', assignee: 'RS-1' }); // LP-6

    expect(ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual(['LP-5']);
    moveNode(reload(paths), findIssue(reload(paths), 'LP-5')!, { status: 'done' });
    expect(ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual(['LP-6']);
  });

  it('does not let a spike inside a feature block the feature that waits on it', () => {
    const paths = seed();
    // The research lives in the feature that waits on it. Inheriting that onto
    // itself would stall it for ever, so the edge into its own lineage is dropped.
    createIssue(reload(paths), { type: 'research', title: 'Spike', parentId: 'LP-3', assignee: 'RS-1' }); // LP-4
    linkIssue(reload(paths), findIssue(reload(paths), 'LP-3')!, { dependsOn: ['LP-4'] });

    expect(ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual(['LP-4']);
  });
});
