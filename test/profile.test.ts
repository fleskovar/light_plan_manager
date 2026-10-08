import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { BoardPaths, Issue, NewIssueInput } from '../src/core/index.js';
import {
  PROFILE_ENV_VAR,
  USER_ENV_VAR,
  clearProfileFile,
  createIssue,
  createPeriod,
  createResource,
  currentProfile,
  currentScope,
  currentTasks,
  currentUser,
  describeScope,
  inScope,
  linkResource,
  findIssue,
  findResource,
  moveNode,
  nextTasks,
  parseProfileText,
  resolveScope,
  scopedIssues,
  setCurrentUser,
  setProfileFile,
  startStatusId,
} from '../src/core/index.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterAll(cleanupBoards);
afterEach(() => {
  delete process.env[PROFILE_ENV_VAR];
  delete process.env[USER_ENV_VAR];
});

const TODAY = '2026-08-10';

/**
 * Two epics with a feature and stories under each, two sprints inside one
 * increment, and Alice covering the junior pool — enough for a scope to have
 * something to leave out.
 *
 *   LP-1 Payments (program)
 *     LP-2 Checkout (epic)      LP-3 Guest flow (feature)   -> LP-6, LP-7
 *     LP-4 Refunds (epic)       LP-5 Partial refund (feat.) -> LP-8
 *
 *   TL-1 PI-1 (increment)       TL-2 Sprint 1, TL-3 Sprint 2
 */
function seed(): BoardPaths {
  const paths = makeBoard('scrum', 'LP');
  createResource(reload(paths), { type: 'person', title: 'Alice Smith' });
  createResource(reload(paths), { type: 'role', title: 'Jr. software developer', capacity: 3 });
  linkResource(reload(paths), findResource(reload(paths), 'RS-1')!, { covers: ['RS-2'] });

  createPeriod(reload(paths), { type: 'increment', title: 'PI-1', starts: '2026-08-03', ends: '2026-08-28' });
  createPeriod(reload(paths), {
    type: 'sprint',
    title: 'Sprint 1',
    parentId: 'TL-1',
    starts: '2026-08-03',
    ends: '2026-08-14',
  });
  createPeriod(reload(paths), {
    type: 'sprint',
    title: 'Sprint 2',
    parentId: 'TL-1',
    starts: '2026-08-17',
    ends: '2026-08-28',
  });

  createIssue(reload(paths), { type: 'program', title: 'Payments' });
  createIssue(reload(paths), { type: 'epic', title: 'Checkout', parentId: 'LP-1' });
  createIssue(reload(paths), { type: 'feature', title: 'Guest flow', parentId: 'LP-2' });
  createIssue(reload(paths), { type: 'epic', title: 'Refunds', parentId: 'LP-1' });
  createIssue(reload(paths), { type: 'feature', title: 'Partial refund', parentId: 'LP-4' });

  story(paths, 'Checkout A', { parentId: 'LP-3', assignee: 'RS-1', period: 'TL-2' });
  story(paths, 'Checkout B', { parentId: 'LP-3', assignee: 'RS-2', period: 'TL-3' });
  story(paths, 'Refund A', { parentId: 'LP-5', assignee: 'RS-1', period: 'TL-2' });
  return paths;
}

function story(paths: BoardPaths, title: string, input: Partial<NewIssueInput> = {}): Issue {
  return createIssue(reload(paths), { type: 'user_story', title, ...input } as NewIssueInput);
}

/** Write a profile file beside the board and point this checkout at it. */
function useProfile(paths: BoardPaths, body: string, name = 'profile.yml'): string {
  const file = path.join(paths.root, name);
  writeFileSync(file, body, 'utf8');
  setProfileFile(reload(paths), name);
  return file;
}

const ids = (candidates: Array<{ issue: Issue }>): string[] =>
  candidates.map((candidate) => candidate.issue.id);

describe('parsing a profile', () => {
  it('reads an identity and a scope', () => {
    const { profile, errors } = parseProfileText(`
user: RS-1
scope:
  under: [LP-2]
  exclude: [LP-9]
  types: [user_story]
  periods: [TL-1]
`);
    expect(errors).toEqual([]);
    expect(profile).toEqual({
      user: 'RS-1',
      scope: { under: ['LP-2'], exclude: ['LP-9'], types: ['user_story'], periods: ['TL-1'] },
    });
  });

  it('accepts a bare string where a list is allowed', () => {
    const { profile } = parseProfileText('scope:\n  under: LP-2\n');
    expect(profile?.scope.under).toEqual(['LP-2']);
  });

  it('treats an empty file as a profile that claims nothing', () => {
    const { profile, errors } = parseProfileText('');
    expect(errors).toEqual([]);
    expect(profile).toEqual({ user: null, scope: {} });
  });

  /**
   * The whole point of being strict: a mistyped key that was silently ignored
   * would hand someone the whole board and nothing would ever say so.
   */
  it('refuses a key it does not know', () => {
    const { profile, errors } = parseProfileText('scope:\n  excludes: [LP-9]\n');
    expect(profile).toBeNull();
    expect(errors.join(' ')).toMatch(/excludes/);
  });

  it('refuses a scope that is not a mapping', () => {
    expect(parseProfileText('scope: LP-2\n').profile).toBeNull();
  });
});

describe('resolving a scope against a board', () => {
  it('keeps a document and everything below it', () => {
    const board = reload(seed());
    const scope = resolveScope(board, { under: ['LP-2'] });

    expect(scopedIssues(board, scope).map((issue) => issue.id)).toEqual(['LP-2', 'LP-3', 'LP-6', 'LP-7']);
    expect(inScope(scope, findIssue(board, 'LP-8')!)).toBe(false);
  });

  it('excludes a subtree, and exclusion wins over inclusion', () => {
    const board = reload(seed());
    const scope = resolveScope(board, { under: ['LP-1'], exclude: ['LP-3'] });

    const kept = scopedIssues(board, scope).map((issue) => issue.id);
    expect(kept).toContain('LP-8');
    expect(kept).not.toContain('LP-3');
    expect(kept).not.toContain('LP-6');
  });

  it('filters by issue type and by period, folding in child periods', () => {
    const board = reload(seed());

    const byType = resolveScope(board, { types: ['user_story'] });
    expect(scopedIssues(board, byType).map((issue) => issue.id)).toEqual(['LP-6', 'LP-7', 'LP-8']);

    const bySprint = resolveScope(board, { periods: ['TL-2'] });
    expect(scopedIssues(board, bySprint).map((issue) => issue.id)).toEqual(['LP-6', 'LP-8']);

    // Naming the increment must not mean "the sprints inside it do not count".
    const byIncrement = resolveScope(board, { periods: ['TL-1'] });
    expect(scopedIssues(board, byIncrement).map((issue) => issue.id)).toEqual([
      'LP-6',
      'LP-7',
      'LP-8',
    ]);
  });

  it('reports a name the board does not have, and fails closed rather than open', () => {
    const board = reload(seed());
    const scope = resolveScope(board, { under: ['LP-404'] });

    expect(scope.unknown).toEqual(['LP-404']);
    // A stale `under` offers nothing. Quietly widening it to the whole board
    // would be the one failure nobody would notice.
    expect(scopedIssues(board, scope)).toEqual([]);
  });

  it('is inert when it declares nothing', () => {
    const board = reload(seed());
    const scope = resolveScope(board, {});
    expect(scope.active).toBe(false);
    expect(scopedIssues(board, scope).length).toBe(board.issues.length);
    expect(describeScope(scope)).toBe('the whole board');
  });
});

describe('what a profile changes', () => {
  it('narrows what is offered without touching how it is ranked', () => {
    const paths = seed();
    const board = reload(paths);

    expect(ids(nextTasks(board, 'RS-1', { today: TODAY }))).toEqual(['LP-6', 'LP-8', 'LP-7']);

    const scope = resolveScope(board, { under: ['LP-2'] });
    expect(ids(nextTasks(board, 'RS-1', { today: TODAY, scope }))).toEqual(['LP-6', 'LP-7']);
  });

  it('does not hide work already picked up', () => {
    const paths = seed();
    const status = startStatusId(reload(paths).config)!;
    moveNode(reload(paths), findIssue(reload(paths), 'LP-8')!, { status, assignee: 'RS-1' });

    useProfile(paths, 'user: RS-1\nscope:\n  under: [LP-2]\n');
    const board = reload(paths);

    // LP-8 is outside the scope, and still in flight for the person holding it.
    expect(ids(nextTasks(board, 'RS-1', { today: TODAY, scope: currentScope(board) }))).toEqual([
      'LP-6',
      'LP-7',
    ]);
    expect(currentTasks(board, 'RS-1').map((issue) => issue.id)).toEqual(['LP-8']);
  });

  it('is read from the file the checkout was pointed at', () => {
    const paths = seed();
    useProfile(paths, 'user: RS-1\nscope:\n  types: [user_story]\n  exclude: [LP-4]\n');

    const board = reload(paths);
    const current = currentProfile(board.paths)!;
    expect(current.source).toBe('local');
    expect(current.profile?.user).toBe('RS-1');
    expect(scopedIssues(board, currentScope(board)).map((issue) => issue.id)).toEqual(['LP-6', 'LP-7']);
  });

  it('lets the environment point somewhere else for one shell', () => {
    const paths = seed();
    useProfile(paths, 'scope:\n  under: [LP-2]\n');

    const other = path.join(paths.root, 'other.yml');
    writeFileSync(other, 'scope:\n  under: [LP-4]\n', 'utf8');
    process.env[PROFILE_ENV_VAR] = other;

    const board = reload(paths);
    expect(currentProfile(board.paths)?.source).toBe('env');
    expect(scopedIssues(board, currentScope(board)).map((issue) => issue.id)).toEqual([
      'LP-4',
      'LP-5',
      'LP-8',
    ]);
  });

  it('carries on unscoped when the file does not load, and says why', () => {
    const paths = seed();
    const file = path.join(paths.root, 'broken.yml');
    writeFileSync(file, 'scope:\n  excludes: [LP-2]\n', 'utf8');
    process.env[PROFILE_ENV_VAR] = file;

    const board = reload(paths);
    const current = currentProfile(board.paths)!;
    expect(current.profile).toBeNull();
    expect(current.errors.length).toBeGreaterThan(0);
    expect(currentScope(board).active).toBe(false);
  });
});

describe('who the profile says you are', () => {
  it('beats .lpm/local.json and loses to the environment', () => {
    const paths = seed();
    setCurrentUser(reload(paths), 'RS-1');
    createResource(reload(paths), { type: 'person', title: 'Bob Jones' });

    expect(currentUser(reload(paths))).toMatchObject({ ref: 'RS-1', source: 'local' });

    useProfile(paths, 'user: Bob Jones\n');
    expect(currentUser(reload(paths))).toMatchObject({ ref: 'Bob Jones', source: 'profile' });
    expect(currentUser(reload(paths))?.resource?.id).toBe('RS-3');

    process.env[USER_ENV_VAR] = 'RS-1';
    expect(currentUser(reload(paths))).toMatchObject({ ref: 'RS-1', source: 'env' });
  });

  it('leaves the stored user alone when the profile says nothing about it', () => {
    const paths = seed();
    setCurrentUser(reload(paths), 'RS-1');
    useProfile(paths, 'scope:\n  under: [LP-2]\n');

    expect(currentUser(reload(paths))).toMatchObject({ ref: 'RS-1', source: 'local' });
  });
});

describe('recording which profile a checkout uses', () => {
  it('stores the path as given, beside the current user', () => {
    const paths = seed();
    setCurrentUser(reload(paths), 'RS-1');
    useProfile(paths, 'user: RS-1\n');

    const local = JSON.parse(readFileSync(paths.localPath, 'utf8')) as Record<string, unknown>;
    expect(local).toEqual({ user: 'RS-1', profile: 'profile.yml' });

    clearProfileFile(reload(paths));
    expect(currentProfile(paths)).toBeNull();
    // Clearing the profile must not forget who you are.
    expect(currentUser(reload(paths))?.ref).toBe('RS-1');
  });

  it('refuses a file that is missing or does not parse', () => {
    const paths = seed();
    expect(() => setProfileFile(reload(paths), 'nope.yml')).toThrow(/No profile file/);

    const broken = path.join(paths.root, 'broken.yml');
    writeFileSync(broken, 'scope:\n  excludes: [LP-2]\n', 'utf8');
    expect(() => setProfileFile(reload(paths), 'broken.yml')).toThrow(/not a valid profile/);
  });
});
