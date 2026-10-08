import { afterAll, describe, expect, it } from 'vitest';
import { createIssue, type LoadedBoard } from '../src/core/index.js';
import { isInScope, linksOutsideScope, resolveScope } from '../src/remote/scope.js';
import { pulls, pushes } from '../src/remote/remotes.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterAll(cleanupBoards);

/**
 * LP-261 — scope a remote to a subtree, and pin its direction. `resolveScope`
 * turns a `scope:` id into the set of issue ids the remote mirrors; the
 * direction helpers say which planner a remote runs.
 */

/** program LP-1 > epic LP-2 > feature LP-3 > story LP-4, plus epic LP-5 > feature LP-6. */
function scopedBoard(): LoadedBoard {
  const paths = makeBoard('scrum', 'LP');
  createIssue(reload(paths), { type: 'program', title: 'Programme' }); // LP-1
  createIssue(reload(paths), { type: 'epic', title: 'Epic A', parentId: 'LP-1' }); // LP-2
  createIssue(reload(paths), { type: 'feature', title: 'Feature A', parentId: 'LP-2' }); // LP-3
  createIssue(reload(paths), { type: 'user_story', title: 'Story A', parentId: 'LP-3' }); // LP-4
  createIssue(reload(paths), { type: 'epic', title: 'Epic B', parentId: 'LP-1' }); // LP-5
  createIssue(reload(paths), { type: 'feature', title: 'Feature B', parentId: 'LP-5' }); // LP-6
  return reload(paths);
}

describe('resolveScope', () => {
  it('returns the scope root and every descendant, and nothing else', () => {
    const board = scopedBoard();
    const scope = resolveScope(board.issues, 'LP-2');
    expect(scope).not.toBeNull();
    expect([...(scope as ReadonlySet<string>)].sort()).toEqual(['LP-2', 'LP-3', 'LP-4']);
  });

  it('returns the whole board when there is no scope id', () => {
    const board = scopedBoard();
    expect(resolveScope(board.issues, undefined)).toBeNull();
  });

  it('returns a scope holding just a leaf when the root has no children', () => {
    const board = scopedBoard();
    expect([...(resolveScope(board.issues, 'LP-6') as ReadonlySet<string>)]).toEqual(['LP-6']);
  });

  it('returns an empty set for a scope id that no longer exists', () => {
    const board = scopedBoard();
    const scope = resolveScope(board.issues, 'LP-999');
    expect(scope).not.toBeNull();
    expect([...(scope as ReadonlySet<string>)]).toEqual([]);
  });

  it('treats an empty scope as "nothing", distinct from null ("everything")', () => {
    expect(isInScope(new Set<string>(), 'LP-2')).toBe(false);
    expect(isInScope(null, 'LP-2')).toBe(true);
  });
});

describe('isInScope', () => {
  it('holds everything under a null scope', () => {
    expect(isInScope(null, 'LP-anything')).toBe(true);
  });

  it('answers membership for a resolved scope', () => {
    const board = scopedBoard();
    const scope = resolveScope(board.issues, 'LP-2')!;
    expect(isInScope(scope, 'LP-2')).toBe(true);
    expect(isInScope(scope, 'LP-4')).toBe(true);
    expect(isInScope(scope, 'LP-5')).toBe(false);
  });
});

describe('linksOutsideScope', () => {
  it('reports linked ids that moved out of the subtree, never silently', () => {
    const board = scopedBoard();
    const scope = resolveScope(board.issues, 'LP-2')!;
    const linked = ['LP-2', 'LP-4', 'LP-5', 'LP-999'];
    expect(linksOutsideScope(scope, linked).sort()).toEqual(['LP-5', 'LP-999']);
  });

  it('reports nothing when the remote has no scope', () => {
    expect(linksOutsideScope(null, ['LP-1', 'LP-2'])).toEqual([]);
  });
});

describe('direction', () => {
  it('pulls on both and pull, never on push', () => {
    expect(pulls('both')).toBe(true);
    expect(pulls('pull')).toBe(true);
    expect(pulls('push')).toBe(false);
  });

  it('pushes on both and push, never on pull', () => {
    expect(pushes('both')).toBe(true);
    expect(pushes('push')).toBe(true);
    expect(pushes('pull')).toBe(false);
  });
});
