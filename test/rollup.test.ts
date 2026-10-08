import { afterAll, describe, expect, it } from 'vitest';
import type { BoardPaths, LoadedBoard } from '../src/core/index.js';
import {
  applyFixes,
  blockersOf,
  boardRollups,
  checkBoard,
  createIssue,
  findIssue,
  flagIssue,
  linkIssue,
  moveIssue,
  parseActivity,
} from '../src/core/index.js';
import type { StatusRules } from '../src/shared/index.js';
import { rolledUpStatus } from '../src/shared/index.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterAll(cleanupBoards);

/**
 * program LP-1 > epic LP-2 > feature LP-3 > stories LP-4, LP-5.
 * The shape the roll-up exists for: nobody works LP-3, the stories are.
 */
function seed(): BoardPaths {
  const paths = makeBoard('scrum', 'LP');
  createIssue(reload(paths), { type: 'program', title: 'Payments platform' });
  createIssue(reload(paths), { type: 'epic', title: 'Checkout revamp', parentId: 'LP-1' });
  createIssue(reload(paths), { type: 'feature', title: 'Guest flow', parentId: 'LP-2' });
  createIssue(reload(paths), { type: 'user_story', title: 'Guest checkout', parentId: 'LP-3' });
  createIssue(reload(paths), { type: 'user_story', title: 'Guest receipt', parentId: 'LP-3' });
  return paths;
}

function statusOf(board: LoadedBoard, id: string): string {
  return findIssue(board, id)!.status;
}

function setStatus(paths: BoardPaths, id: string, status: string): LoadedBoard {
  const board = reload(paths);
  moveIssue(board, findIssue(board, id)!, { status });
  return reload(paths);
}

describe('rolledUpStatus', () => {
  const rules: StatusRules = {
    isTerminal: (status) => status === 'done' || status === 'cancelled',
    isActive: (status) => status === 'in_progress',
    terminalStatus: 'done',
    activeStatus: 'in_progress',
    defaultStatus: 'backlog',
  };

  it('leaves a childless issue alone', () => {
    expect(rolledUpStatus('backlog', [], rules)).toBeNull();
  });

  it('closes a parent whose children are all finished', () => {
    expect(rolledUpStatus('backlog', ['done', 'done'], rules)).toBe('done');
  });

  it('closes into the end state the children agree on', () => {
    expect(rolledUpStatus('backlog', ['cancelled', 'cancelled'], rules)).toBe('cancelled');
    expect(rolledUpStatus('backlog', ['cancelled', 'done'], rules)).toBe('done');
  });

  it('leaves a parent that is already finished alone', () => {
    expect(rolledUpStatus('cancelled', ['done', 'done'], rules)).toBeNull();
  });

  it('reopens a finished parent that has open work inside it', () => {
    expect(rolledUpStatus('done', ['done', 'backlog'], rules)).toBe('in_progress');
    expect(rolledUpStatus('done', ['backlog', 'ready'], rules)).toBe('backlog');
  });

  it('does not drag an open parent forward', () => {
    expect(rolledUpStatus('backlog', ['in_progress', 'done'], rules)).toBeNull();
  });

  it('rolls nothing up on a board with no end state', () => {
    const open: StatusRules = { ...rules, isTerminal: () => false, terminalStatus: null };
    expect(rolledUpStatus('backlog', ['done', 'done'], open)).toBeNull();
  });
});

describe('moveNode roll-up', () => {
  it('closes the feature and the epic when the last story is done', () => {
    const paths = seed();
    setStatus(paths, 'LP-4', 'done');
    expect(statusOf(reload(paths), 'LP-3')).toBe('backlog');

    const board = setStatus(paths, 'LP-5', 'done');
    expect(statusOf(board, 'LP-3')).toBe('done');
    expect(statusOf(board, 'LP-2')).toBe('done');
    expect(statusOf(board, 'LP-1')).toBe('done');
  });

  it('reports what it carried with it', () => {
    const paths = seed();
    setStatus(paths, 'LP-4', 'done');
    const board = reload(paths);
    const result = moveIssue(board, findIssue(board, 'LP-5')!, { status: 'done' });
    expect(result.rollups.map((entry) => [entry.issue.id, entry.from, entry.to])).toEqual([
      ['LP-3', 'backlog', 'done'],
      ['LP-2', 'backlog', 'done'],
      ['LP-1', 'backlog', 'done'],
    ]);
  });

  it('reopens the containers when a story is reopened', () => {
    const paths = seed();
    setStatus(paths, 'LP-4', 'done');
    setStatus(paths, 'LP-5', 'done');
    const board = setStatus(paths, 'LP-4', 'in_progress');
    expect(statusOf(board, 'LP-3')).toBe('in_progress');
    expect(statusOf(board, 'LP-2')).toBe('in_progress');
    expect(statusOf(board, 'LP-1')).toBe('in_progress');
  });

  it('records the roll-up in the parent\'s activity section', () => {
    const paths = seed();
    setStatus(paths, 'LP-4', 'done');
    const board = setStatus(paths, 'LP-5', 'done');
    const entries = parseActivity(findIssue(board, 'LP-3')!.body);
    expect(entries.at(-1)!.heading).toBe('status rolled up: backlog → done');
  });

  it('takes a flag off a container it closes', () => {
    const paths = seed();
    let board = reload(paths);
    flagIssue(board, findIssue(board, 'LP-3')!, { reason: 'blocked', comment: 'waiting on legal' });
    setStatus(paths, 'LP-4', 'done');
    board = setStatus(paths, 'LP-5', 'done');
    expect(findIssue(board, 'LP-3')!.flag).toBeNull();
  });

  it('reopens a closed container when a new issue is created inside it', () => {
    const paths = seed();
    setStatus(paths, 'LP-4', 'done');
    let board = setStatus(paths, 'LP-5', 'done');
    expect(statusOf(board, 'LP-3')).toBe('done');

    createIssue(reload(paths), { type: 'user_story', title: 'Guest refund', parentId: 'LP-3' });
    board = reload(paths);
    expect(statusOf(board, 'LP-3')).toBe('in_progress');
    expect(statusOf(board, 'LP-2')).toBe('in_progress');
  });

  it('leaves an open container alone when an issue is created inside it', () => {
    const paths = seed();
    createIssue(reload(paths), { type: 'user_story', title: 'Guest refund', parentId: 'LP-3' });
    expect(statusOf(reload(paths), 'LP-3')).toBe('backlog');
  });

  it('leaves the containers alone when asked not to roll up', () => {
    const paths = seed();
    setStatus(paths, 'LP-4', 'done');
    const board = reload(paths);
    const result = moveIssue(board, findIssue(board, 'LP-5')!, { status: 'done', rollUp: false });
    expect(result.rollups).toEqual([]);
    expect(statusOf(reload(paths), 'LP-3')).toBe('backlog');
  });

  it('unblocks work waiting on the feature', () => {
    const paths = seed();
    let board = reload(paths);
    createIssue(board, { type: 'feature', title: 'Payment capture', parentId: 'LP-2' });
    board = reload(paths);
    createIssue(board, { type: 'user_story', title: 'Capture on ship', parentId: 'LP-6' });

    board = reload(paths);
    linkIssue(board, findIssue(board, 'LP-6')!, { dependsOn: ['LP-3'] });
    board = reload(paths);
    expect(blockersOf(board, findIssue(board, 'LP-7')!).map((issue) => issue.id)).toEqual(['LP-3']);

    setStatus(paths, 'LP-4', 'done');
    board = setStatus(paths, 'LP-5', 'done');
    expect(statusOf(board, 'LP-3')).toBe('done');
    expect(blockersOf(board, findIssue(board, 'LP-7')!)).toEqual([]);
  });
});

describe('check and fix', () => {
  it('reports a container left behind by a hand edit, and fixes it', () => {
    const paths = seed();
    setStatus(paths, 'LP-4', 'done');
    setStatus(paths, 'LP-5', 'done');

    // Undo the roll-up the way a merge or a hand edit would.
    let board = reload(paths);
    moveIssue(board, findIssue(board, 'LP-3')!, { status: 'backlog', rollUp: false });
    moveIssue(board, findIssue(board, 'LP-2')!, { status: 'backlog', rollUp: false });
    moveIssue(board, findIssue(board, 'LP-1')!, { status: 'backlog', rollUp: false });

    board = reload(paths);
    const problems = checkBoard(board).filter((problem) => problem.message.includes('roll it up'));
    expect(problems).toHaveLength(3);
    expect(problems.every((problem) => problem.fixable)).toBe(true);

    applyFixes(reload(paths));
    board = reload(paths);
    expect(statusOf(board, 'LP-3')).toBe('done');
    expect(statusOf(board, 'LP-2')).toBe('done');
    expect(statusOf(board, 'LP-1')).toBe('done');
    expect(boardRollups(board)).toEqual([]);
  });

  it('reports a container closed over open work', () => {
    const paths = seed();
    const board = reload(paths);
    moveIssue(board, findIssue(board, 'LP-3')!, { status: 'done', rollUp: false });
    const problems = checkBoard(reload(paths)).filter((problem) =>
      problem.message.includes('open work inside it'),
    );
    expect(problems).toHaveLength(1);

    applyFixes(reload(paths));
    expect(statusOf(reload(paths), 'LP-3')).toBe('backlog');
  });

  it('says nothing about a board that is in step', () => {
    const paths = seed();
    const board = reload(paths);
    expect(boardRollups(board)).toEqual([]);
    expect(checkBoard(board).filter((problem) => problem.message.includes('roll'))).toEqual([]);
  });
});
