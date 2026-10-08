import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { BoardPaths, Problem } from '../src/core/index.js';
import {
  applyFixes,
  checkBoard,
  createIssue,
  createPeriod,
  findIssue,
  linkIssue,
  moveNode,
  parseFrontmatter,
} from '../src/core/index.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterAll(cleanupBoards);

const messages = (problems: Problem[]): string => problems.map((p) => p.message).join('\n');

/** A feature (LP-3) with three stories under it: LP-4, LP-5, LP-6. */
function seed(): BoardPaths {
  const paths = makeBoard('scrum', 'LP');
  createIssue(reload(paths), { type: 'program', title: 'Payments' });
  createIssue(reload(paths), { type: 'epic', title: 'Checkout', parentId: 'LP-1' });
  createIssue(reload(paths), { type: 'feature', title: 'Guest flow', parentId: 'LP-2' });
  for (const title of ['Gateway', 'Guest checkout', 'Refunds']) {
    createIssue(reload(paths), { type: 'user_story', title, parentId: 'LP-3' });
  }
  return paths;
}

/** Hand-edit one line of an issue's frontmatter. */
function rewrite(paths: BoardPaths, id: string, from: string, to: string): void {
  const issue = findIssue(reload(paths), id)!;
  writeFileSync(issue.file, readFileSync(issue.file, 'utf8').replace(from, to), 'utf8');
}

describe('dependencies in frontmatter', () => {
  it('writes empty link lists on every new issue so the fields are discoverable', () => {
    const paths = seed();
    const { data } = parseFrontmatter(readFileSync(findIssue(reload(paths), 'LP-4')!.file, 'utf8'));
    expect(data.depends_on).toEqual([]);
    expect(data.relates_to).toEqual([]);
    expect(data.period).toBeNull();
  });

  it('records dependencies given at creation time', () => {
    const paths = seed();
    const issue = createIssue(reload(paths), {
      type: 'user_story',
      title: 'Dependent',
      parentId: 'LP-3',
      dependsOn: ['LP-4', 'LP-5'],
      relatesTo: ['LP-6'],
    });
    expect(issue.depends_on).toEqual(['LP-4', 'LP-5']);
    const { data } = parseFrontmatter(readFileSync(issue.file, 'utf8'));
    expect(data.depends_on).toEqual(['LP-4', 'LP-5']);
    expect(data.relates_to).toEqual(['LP-6']);
  });

  it('derives the inverse edge instead of storing it', () => {
    const paths = seed();
    const board = reload(paths);
    linkIssue(board, findIssue(board, 'LP-5')!, { dependsOn: ['LP-4'] });
    linkIssue(reload(paths), findIssue(reload(paths), 'LP-6')!, { dependsOn: ['LP-4'] });

    const after = reload(paths);
    expect(after.dependents.get('LP-4')?.sort()).toEqual(['LP-5', 'LP-6']);
    // Nothing was written to LP-4 itself.
    const { data } = parseFrontmatter(readFileSync(findIssue(after, 'LP-4')!.file, 'utf8'));
    expect(data.depends_on).toEqual([]);
  });

  it('accepts a bare string as a one-element list', () => {
    const paths = seed();
    rewrite(paths, 'LP-5', 'depends_on: []', 'depends_on: LP-4');
    const board = reload(paths);
    expect(findIssue(board, 'LP-5')!.depends_on).toEqual(['LP-4']);
    expect(checkBoard(board)).toEqual([]);
  });

  it('is case-insensitive when resolving link targets', () => {
    const paths = seed();
    const board = reload(paths);
    const result = linkIssue(board, findIssue(board, 'LP-5')!, { dependsOn: ['lp-4'] });
    expect(result.issue.depends_on).toEqual(['LP-4']);
  });
});

describe('linkIssue', () => {
  it('adds and removes links, ignoring repeats', () => {
    const paths = seed();
    let board = reload(paths);
    const added = linkIssue(board, findIssue(board, 'LP-5')!, { dependsOn: ['LP-4'] });
    expect(added.addedDependsOn).toEqual(['LP-4']);

    board = reload(paths);
    const again = linkIssue(board, findIssue(board, 'LP-5')!, { dependsOn: ['LP-4'] });
    expect(again.addedDependsOn).toEqual([]);

    board = reload(paths);
    const removed = linkIssue(board, findIssue(board, 'LP-5')!, {
      dependsOn: ['LP-4'],
      remove: true,
    });
    expect(removed.removedDependsOn).toEqual(['LP-4']);
    expect(findIssue(reload(paths), 'LP-5')!.depends_on).toEqual([]);
  });

  it('rejects a self dependency', () => {
    const paths = seed();
    const board = reload(paths);
    expect(() => linkIssue(board, findIssue(board, 'LP-4')!, { dependsOn: ['LP-4'] })).toThrow(
      /cannot depend on itself/,
    );
  });

  it('rejects an edge that would close a cycle', () => {
    const paths = seed();
    linkIssue(reload(paths), findIssue(reload(paths), 'LP-5')!, { dependsOn: ['LP-4'] });
    linkIssue(reload(paths), findIssue(reload(paths), 'LP-6')!, { dependsOn: ['LP-5'] });

    const board = reload(paths);
    expect(() => linkIssue(board, findIssue(board, 'LP-4')!, { dependsOn: ['LP-6'] })).toThrow(
      /would create a cycle/,
    );
    // Nothing was written.
    expect(findIssue(reload(paths), 'LP-4')!.depends_on).toEqual([]);
  });

  it('rejects linking to a period or to something that does not exist', () => {
    const paths = seed();
    createPeriod(reload(paths), {
      type: 'increment',
      title: 'H2',
      starts: '2026-07-01',
      ends: '2026-12-31',
    });
    const board = reload(paths);
    expect(() => linkIssue(board, findIssue(board, 'LP-4')!, { dependsOn: ['TL-1'] })).toThrow(
      /only issues can be linked/,
    );
    expect(() => linkIssue(board, findIssue(board, 'LP-4')!, { dependsOn: ['LP-99'] })).toThrow(
      /No issue with id/,
    );
  });

  it('requires something to link', () => {
    const paths = seed();
    const board = reload(paths);
    expect(() => linkIssue(board, findIssue(board, 'LP-4')!, {})).toThrow(/Nothing to link/);
  });
});

describe('dependency validation', () => {
  it('flags a reference to a missing issue', () => {
    const paths = seed();
    rewrite(paths, 'LP-5', 'depends_on: []', 'depends_on: [LP-99]');
    const problem = checkBoard(reload(paths)).find((p) => /does not exist/.test(p.message));
    expect(problem?.level).toBe('error');
  });

  it('flags a reference to a period', () => {
    const paths = seed();
    createPeriod(reload(paths), {
      type: 'increment',
      title: 'H2',
      starts: '2026-07-01',
      ends: '2026-12-31',
    });
    rewrite(paths, 'LP-5', 'depends_on: []', 'depends_on: [TL-1]');
    expect(messages(checkBoard(reload(paths)))).toMatch(/only issues can be linked/);
  });

  it('flags a self reference and fixes it', () => {
    const paths = seed();
    rewrite(paths, 'LP-5', 'depends_on: []', 'depends_on: [LP-5]');
    const problem = checkBoard(reload(paths)).find((p) => /lists itself/.test(p.message));
    expect(problem?.level).toBe('error');
    expect(problem?.fixable).toBe(true);

    applyFixes(reload(paths));
    expect(findIssue(reload(paths), 'LP-5')!.depends_on).toEqual([]);
  });

  it('warns about duplicates and dedupes them', () => {
    const paths = seed();
    rewrite(paths, 'LP-5', 'depends_on: []', 'depends_on: [LP-4, LP-4]');
    expect(messages(checkBoard(reload(paths)))).toMatch(/lists "LP-4" more than once/);

    applyFixes(reload(paths));
    expect(findIssue(reload(paths), 'LP-5')!.depends_on).toEqual(['LP-4']);
    expect(checkBoard(reload(paths))).toEqual([]);
  });

  it('flags a link list that is not a list of ids', () => {
    const paths = seed();
    rewrite(paths, 'LP-5', 'depends_on: []', 'depends_on: 42');
    expect(messages(checkBoard(reload(paths)))).toMatch(/depends_on must be a list of ids/);
  });

  it('reports a cycle written by hand', () => {
    const paths = seed();
    rewrite(paths, 'LP-4', 'depends_on: []', 'depends_on: [LP-5]');
    rewrite(paths, 'LP-5', 'depends_on: []', 'depends_on: [LP-4]');
    const problem = checkBoard(reload(paths)).find((p) => /dependency cycle/.test(p.message));
    expect(problem?.level).toBe('error');
    expect(problem?.message).toMatch(/LP-4 -> LP-5 -> LP-4|LP-5 -> LP-4 -> LP-5/);
  });

  it('warns when a finished issue is blocked by an unfinished one', () => {
    const paths = seed();
    linkIssue(reload(paths), findIssue(reload(paths), 'LP-5')!, { dependsOn: ['LP-4'] });
    const board = reload(paths);
    moveNode(board, findIssue(board, 'LP-5')!, { status: 'done' });

    const problem = checkBoard(reload(paths)).find((p) => /but depends on LP-4/.test(p.message));
    expect(problem?.level).toBe('warn');
  });

  it('warns when a blocker is scheduled in a later period', () => {
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
    createPeriod(reload(paths), {
      type: 'sprint',
      title: 'Sprint 2',
      starts: '2026-08-17',
      ends: '2026-08-28',
      parentId: 'TL-1',
    });

    // LP-5 runs in Sprint 1 but depends on LP-4, which runs in Sprint 2.
    linkIssue(reload(paths), findIssue(reload(paths), 'LP-5')!, { dependsOn: ['LP-4'] });
    moveNode(reload(paths), findIssue(reload(paths), 'LP-5')!, { period: 'TL-2' });
    moveNode(reload(paths), findIssue(reload(paths), 'LP-4')!, { period: 'TL-3' });

    const problem = checkBoard(reload(paths)).find((p) => /scheduled later/.test(p.message));
    expect(problem?.level).toBe('warn');
    expect(problem?.message).toMatch(/TL-2.*depends on LP-4, scheduled later in TL-3/);
  });

  it('stays quiet when the blocker is scheduled first', () => {
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
    createPeriod(reload(paths), {
      type: 'sprint',
      title: 'Sprint 2',
      starts: '2026-08-17',
      ends: '2026-08-28',
      parentId: 'TL-1',
    });

    linkIssue(reload(paths), findIssue(reload(paths), 'LP-5')!, { dependsOn: ['LP-4'] });
    moveNode(reload(paths), findIssue(reload(paths), 'LP-4')!, { period: 'TL-2' });
    moveNode(reload(paths), findIssue(reload(paths), 'LP-5')!, { period: 'TL-3' });

    expect(checkBoard(reload(paths))).toEqual([]);
  });
});
