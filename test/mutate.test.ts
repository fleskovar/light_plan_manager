import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { BoardPaths } from '../src/core/index.js';
import {
  BoardError,
  ISSUE_FILE,
  createIssue,
  findIssue,
  moveIssue,
  parseFrontmatter,
  readState,
} from '../src/core/index.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterAll(cleanupBoards);

/** program > epic > feature > user_story, returning the board paths. */
function seed(): BoardPaths {
  const paths = makeBoard('scrum', 'LP');
  createIssue(reload(paths), { type: 'program', title: 'Payments platform' });
  createIssue(reload(paths), { type: 'epic', title: 'Checkout revamp', parentId: 'LP-1' });
  createIssue(reload(paths), { type: 'feature', title: 'Guest flow', parentId: 'LP-2' });
  createIssue(reload(paths), { type: 'user_story', title: 'Guest checkout', parentId: 'LP-3' });
  return paths;
}

describe('createIssue', () => {
  it('nests folders to mirror the hierarchy', () => {
    const paths = seed();
    const board = reload(paths);
    const story = findIssue(board, 'LP-4')!;
    expect(path.relative(paths.boardDir, story.dir).split(path.sep)).toEqual([
      'LP-1',
      'LP-2',
      'LP-3',
      'LP-4',
    ]);
    expect(story.depth).toBe(3);
    expect(story.parentId).toBe('LP-3');
  });

  it('writes frontmatter, the type body template, and metadata', () => {
    const paths = seed();
    const story = findIssue(reload(paths), 'LP-4')!;
    const { data, body } = parseFrontmatter(readFileSync(story.file, 'utf8'));
    expect(data.id).toBe('LP-4');
    expect(data.type).toBe('user_story');
    expect(data.status).toBe('backlog');
    expect(data.created).toEqual(expect.any(String));
    expect(data.author).toEqual(expect.any(String));
    expect(data.priority).toBe('medium');
    expect(data.labels).toEqual([]);
    expect(body).toContain('As a **<role>**');
  });

  it('increments ids and persists the counter', () => {
    const paths = seed();
    expect(readState(paths).counter).toBe(4);
    const next = createIssue(reload(paths), {
      type: 'bug',
      title: 'Cart total wrong',
      parentId: 'LP-3',
    });
    expect(next.id).toBe('LP-5');
  });

  it('allows sibling types declared on the same level', () => {
    const paths = seed();
    const bug = createIssue(reload(paths), { type: 'bug', title: 'Boom', parentId: 'LP-3' });
    expect(bug.depth).toBe(3);
  });

  it('applies and validates --set attributes', () => {
    const paths = seed();
    const story = createIssue(reload(paths), {
      type: 'user_story',
      title: 'Saved cards',
      parentId: 'LP-3',
      attributes: { story_points: 5, labels: ['web'] },
    });
    expect(story.attributes.story_points).toBe(5);
    expect(story.attributes.labels).toEqual(['web']);
  });

  it('rejects an unknown type', () => {
    const paths = seed();
    expect(() => createIssue(reload(paths), { type: 'saga', title: 'x' })).toThrow(BoardError);
  });

  it('rejects the wrong parent type', () => {
    const paths = seed();
    expect(() =>
      createIssue(reload(paths), { type: 'epic', title: 'x', parentId: 'LP-2' }),
    ).toThrow(/cannot be nested under/);
  });

  it('rejects a non-root type with no parent', () => {
    const paths = seed();
    expect(() => createIssue(reload(paths), { type: 'user_story', title: 'x' })).toThrow(
      /needs a parent issue/,
    );
  });

  it('rejects a root type given a parent', () => {
    const paths = seed();
    let thrown: BoardError | null = null;
    try {
      createIssue(reload(paths), { type: 'program', title: 'x', parentId: 'LP-1' });
    } catch (error) {
      thrown = error as BoardError;
    }
    expect(thrown?.message).toMatch(/cannot be nested under/);
    expect(thrown?.details.join()).toMatch(/top-level type/);
  });

  it('rejects an undeclared attribute and a bad value', () => {
    const paths = seed();
    expect(() =>
      createIssue(reload(paths), {
        type: 'user_story',
        title: 'x',
        parentId: 'LP-3',
        attributes: { nope: 1 },
      }),
    ).toThrow(/is not an attribute/);
    expect(() =>
      createIssue(reload(paths), {
        type: 'user_story',
        title: 'y',
        parentId: 'LP-3',
        attributes: { story_points: 'three' },
      }),
    ).toThrow(/expected an integer/);
  });

  it('rejects an empty title and an unknown status', () => {
    const paths = seed();
    expect(() => createIssue(reload(paths), { type: 'program', title: '  ' })).toThrow(
      /title cannot be empty/,
    );
    expect(() =>
      createIssue(reload(paths), { type: 'program', title: 'x', status: 'shipped' }),
    ).toThrow(/Unknown status/);
  });

  it('never reuses an id already on the board', () => {
    const paths = seed();
    // Simulate a counter rewound by a bad merge.
    const board = reload(paths);
    createIssue(board, { type: 'bug', title: 'A', parentId: 'LP-3' });
    const fresh = createIssue(reload(paths), { type: 'bug', title: 'B', parentId: 'LP-3' });
    expect(fresh.id).toBe('LP-6');
  });
});

describe('moveIssue', () => {
  it('changes status in place', () => {
    const paths = seed();
    const board = reload(paths);
    const result = moveIssue(board, findIssue(board, 'LP-4')!, { status: 'in_progress' });
    expect(result.statusChanged).toBe(true);
    expect(result.movedTo).toBeUndefined();
    expect(findIssue(reload(paths), 'LP-4')!.status).toBe('in_progress');
  });

  it('re-parents an issue and everything under it', () => {
    const paths = seed();
    createIssue(reload(paths), { type: 'epic', title: 'Hardening', parentId: 'LP-1' });
    const board = reload(paths);
    moveIssue(board, findIssue(board, 'LP-3')!, { parentId: 'LP-5' });

    const after = reload(paths);
    const feature = findIssue(after, 'LP-3')!;
    const story = findIssue(after, 'LP-4')!;
    expect(feature.parentId).toBe('LP-5');
    expect(path.relative(paths.boardDir, story.dir).split(path.sep)).toEqual([
      'LP-1',
      'LP-5',
      'LP-3',
      'LP-4',
    ]);
    expect(existsSync(path.join(story.dir, ISSUE_FILE))).toBe(true);
  });

  it('refuses a move that would break the hierarchy', () => {
    const paths = seed();
    const board = reload(paths);
    expect(() => moveIssue(board, findIssue(board, 'LP-2')!, { parentId: null })).toThrow(
      /break the hierarchy/,
    );
  });

  it('refuses to move an issue under its own descendant', () => {
    const paths = seed();
    const board = reload(paths);
    expect(() => moveIssue(board, findIssue(board, 'LP-2')!, { parentId: 'LP-4' })).toThrow(
      /own descendant/,
    );
  });

  it('refuses to make an issue its own parent', () => {
    const paths = seed();
    const board = reload(paths);
    expect(() => moveIssue(board, findIssue(board, 'LP-2')!, { parentId: 'LP-2' })).toThrow(
      /its own parent/,
    );
  });

  it('refuses an unknown status or parent', () => {
    const paths = seed();
    const board = reload(paths);
    const issue = findIssue(board, 'LP-4')!;
    expect(() => moveIssue(board, issue, { status: 'shipped' })).toThrow(/Unknown status/);
    expect(() => moveIssue(board, issue, { parentId: 'LP-99' })).toThrow(/No issue with id/);
  });

  it('bumps updated', () => {
    const paths = seed();
    const board = reload(paths);
    const before = findIssue(board, 'LP-4')!.updated;
    const result = moveIssue(board, findIssue(board, 'LP-4')!, { status: 'ready' });
    expect(result.node.updated).not.toBe(before);
  });
});

describe('findIssue', () => {
  it('matches ids case-insensitively', () => {
    const paths = seed();
    const board = reload(paths);
    expect(findIssue(board, 'lp-2')?.id).toBe('LP-2');
    expect(findIssue(board, 'LP-99')).toBeNull();
  });
});
