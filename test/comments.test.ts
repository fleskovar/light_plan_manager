import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { BoardPaths } from '../src/core/index.js';
import {
  BoardError,
  COMMENTS_FILE,
  addComment,
  checkBoard,
  createIssue,
  findIssue,
  listComments,
  removeComment,
  removeNode,
  updateNode,
} from '../src/core/index.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterAll(cleanupBoards);

function seed(): BoardPaths {
  const paths = makeBoard('scrum', 'LP');
  createIssue(reload(paths), { type: 'program', title: 'Platform' });
  return paths;
}

describe('comments', () => {
  it('appends to a file beside the document', () => {
    const paths = seed();
    const result = addComment(reload(paths), 'LP-1', {
      body: 'Started on the schema.',
      author: 'Ada <ada@example.com>',
    });

    expect(result.total).toBe(1);
    expect(result.comment).toMatchObject({
      index: 1,
      author: 'Ada <ada@example.com>',
      body: 'Started on the schema.',
    });

    const file = path.join(findIssue(reload(paths), 'LP-1')!.dir, COMMENTS_FILE);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('Started on the schema.');
  });

  it('keeps them in the order they were written', () => {
    const paths = seed();
    for (const body of ['first', 'second', 'third']) {
      addComment(reload(paths), 'LP-1', { body, author: 'Ada' });
    }
    const comments = listComments(reload(paths), 'LP-1');
    expect(comments.map((comment) => comment.body)).toEqual(['first', 'second', 'third']);
    expect(comments.map((comment) => comment.index)).toEqual([1, 2, 3]);
  });

  it('round-trips a multi-line body with markdown in it', () => {
    const paths = seed();
    const body = [
      'Tried the naive join first; it was too slow.',
      '',
      '## What worked',
      '',
      '- an index on `created`',
      '- batching the writes',
    ].join('\n');
    addComment(reload(paths), 'LP-1', { body, author: 'Ada' });

    // A `##` heading inside the text must not be read back as a new comment.
    const comments = listComments(reload(paths), 'LP-1');
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toBe(body);
  });

  it('records who and when, defaulting the author to the git identity', () => {
    const paths = seed();
    const before = new Date().toISOString();
    const { comment } = addComment(reload(paths), 'LP-1', { body: 'note' });
    expect(comment.at >= before).toBe(true);
    expect(comment.author).not.toBe('');
  });

  it('deletes one entry and renumbers the rest', () => {
    const paths = seed();
    for (const body of ['first', 'second', 'third']) {
      addComment(reload(paths), 'LP-1', { body, author: 'Ada' });
    }
    const removed = removeComment(reload(paths), 'LP-1', 2);
    expect(removed.body).toBe('second');

    const comments = listComments(reload(paths), 'LP-1');
    expect(comments.map((comment) => comment.body)).toEqual(['first', 'third']);
    expect(comments.map((comment) => comment.index)).toEqual([1, 2]);
  });

  it('rejects an empty comment and an unknown id', () => {
    const paths = seed();
    expect(() => addComment(reload(paths), 'LP-1', { body: '   ' })).toThrow(BoardError);
    expect(() => addComment(reload(paths), 'LP-99', { body: 'x' })).toThrow(/No issue/);
    expect(() => removeComment(reload(paths), 'LP-1', 1)).toThrow(/no comment 1/);
  });

  it('returns nothing for a document that has never been commented on', () => {
    expect(listComments(reload(seed()), 'LP-1')).toEqual([]);
  });

  it('travels with the document when it is renamed, and goes when it is deleted', () => {
    const paths = seed();
    addComment(reload(paths), 'LP-1', { body: 'note', author: 'Ada' });

    // The folder is renamed by a title change; the log must come along.
    updateNode(reload(paths), findIssue(reload(paths), 'LP-1')!, { title: 'Payments platform' });
    expect(listComments(reload(paths), 'LP-1').map((c) => c.body)).toEqual(['note']);

    const dir = findIssue(reload(paths), 'LP-1')!.dir;
    removeNode(reload(paths), findIssue(reload(paths), 'LP-1')!);
    expect(existsSync(path.join(dir, COMMENTS_FILE))).toBe(false);
  });

  it('is invisible to the engine: check still passes', () => {
    const paths = seed();
    addComment(reload(paths), 'LP-1', { body: 'note', author: 'Ada' });
    const board = reload(paths);
    expect(board.issues).toHaveLength(1);
    expect(checkBoard(board).filter((problem) => problem.level === 'error')).toEqual([]);
  });
});
