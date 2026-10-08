import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { BoardPaths, Problem } from '../src/core/index.js';
import {
  BoardError,
  PERIOD_FILE,
  applyFixes,
  checkBoard,
  createIssue,
  createPeriod,
  findIssue,
  findPeriod,
  hasPeriods,
  isPeriodOverdue,
  issuesInPeriod,
  moveNode,
  nextPeriodAfter,
  openIssuesInPeriod,
  parseFrontmatter,
  periodChain,
  periodOf,
  periodStance,
  readState,
  updateNode,
} from '../src/core/index.js';
import { cleanupBoards, makeBoard, reload, writeRawIssue } from './helpers.js';

afterAll(cleanupBoards);

const messages = (problems: Problem[]): string => problems.map((p) => p.message).join('\n');

/** A scrum board with an increment, two sprints, and a feature to hang stories off. */
function seed(): BoardPaths {
  const paths = makeBoard('scrum', 'LP');
  createPeriod(reload(paths), {
    type: 'increment',
    title: '2026 H2',
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
  createIssue(reload(paths), { type: 'program', title: 'Payments' });
  createIssue(reload(paths), { type: 'epic', title: 'Checkout', parentId: 'LP-1' });
  createIssue(reload(paths), { type: 'feature', title: 'Guest flow', parentId: 'LP-2' });
  return paths;
}

describe('period configuration', () => {
  it('scrum and kanban declare a time hierarchy, blank does not', () => {
    expect(hasPeriods(reload(makeBoard('scrum')).config)).toBe(true);
    expect(hasPeriods(reload(makeBoard('kanban')).config)).toBe(true);
    expect(hasPeriods(reload(makeBoard('blank')).config)).toBe(false);
  });

  it('only creates the timeline folder for boards that use periods', () => {
    expect(existsSync(makeBoard('scrum').timelineDir)).toBe(true);
    expect(existsSync(makeBoard('blank').timelineDir)).toBe(false);
  });

  it('refuses to create a period on a board with no time hierarchy', () => {
    const paths = makeBoard('blank', 'LP');
    expect(() =>
      createPeriod(reload(paths), {
        type: 'sprint',
        title: 'x',
        starts: '2026-01-01',
        ends: '2026-01-14',
      }),
    ).toThrow(/no time hierarchy/);
  });
});

describe('createPeriod', () => {
  it('nests periods under the timeline, mirroring period_hierarchy', () => {
    const paths = seed();
    const board = reload(paths);
    const sprint = findPeriod(board, 'TL-2')!;
    expect(path.relative(paths.timelineDir, sprint.dir).split(path.sep)).toEqual([
      'TL-1',
      'TL-2',
    ]);
    expect(sprint.parentId).toBe('TL-1');
    expect(sprint.depth).toBe(1);
    expect(sprint.kind).toBe('period');
  });

  it('uses its own prefix and counter, independent of issue ids', () => {
    const paths = seed();
    const state = readState(paths);
    expect(state.period_counter).toBe(3);
    expect(state.counter).toBe(3);
    expect(findPeriod(reload(paths), 'TL-1')).not.toBeNull();
    expect(findIssue(reload(paths), 'LP-1')).not.toBeNull();
    // The namespaces never collide.
    expect(findIssue(reload(paths), 'TL-1')).toBeNull();
    expect(findPeriod(reload(paths), 'LP-1')).toBeNull();
  });

  it('writes dates and the type body template', () => {
    const paths = seed();
    const sprint = findPeriod(reload(paths), 'TL-2')!;
    const { data, body } = parseFrontmatter(readFileSync(sprint.file, 'utf8'));
    expect(data.starts).toBe('2026-08-03');
    expect(data.ends).toBe('2026-08-14');
    expect(data.capacity).toBeNull();
    expect(body).toContain('## Sprint Goal');
    expect(path.basename(sprint.file)).toBe(PERIOD_FILE);
  });

  it('rejects malformed and inverted dates', () => {
    const paths = seed();
    const base = { type: 'increment', title: 'x' } as const;
    expect(() =>
      createPeriod(reload(paths), { ...base, starts: '01-01-2026', ends: '2026-02-01' }),
    ).toThrow(/Invalid start date/);
    expect(() =>
      createPeriod(reload(paths), { ...base, starts: '2026-02-30', ends: '2026-03-01' }),
    ).toThrow(/Invalid start date/);
    expect(() =>
      createPeriod(reload(paths), { ...base, starts: '2026-03-01', ends: '2026-02-01' }),
    ).toThrow(/ends .* before it starts/);
  });

  it('rejects a period that does not fit inside its parent', () => {
    const paths = seed();
    expect(() =>
      createPeriod(reload(paths), {
        type: 'sprint',
        title: 'Next year',
        starts: '2027-01-04',
        ends: '2027-01-15',
        parentId: 'TL-1',
      }),
    ).toThrow(/falls outside TL-1/);
  });

  it('enforces the period hierarchy', () => {
    const paths = seed();
    expect(() =>
      createPeriod(reload(paths), {
        type: 'sprint',
        title: 'Orphan',
        starts: '2026-08-03',
        ends: '2026-08-14',
      }),
    ).toThrow(/needs a parent period/);
    expect(() =>
      createPeriod(reload(paths), {
        type: 'increment',
        title: 'Nested',
        starts: '2026-08-03',
        ends: '2026-08-14',
        parentId: 'TL-1',
      }),
    ).toThrow(/cannot be nested under/);
  });
});

describe('scheduling issues into periods', () => {
  it('records the period on the issue and resolves it back', () => {
    const paths = seed();
    createIssue(reload(paths), {
      type: 'user_story',
      title: 'Gateway',
      parentId: 'LP-3',
      period: 'TL-2',
    });
    const board = reload(paths);
    const story = findIssue(board, 'LP-4')!;
    expect(story.period).toBe('TL-2');
    expect(periodOf(board, story)?.title).toBe('Sprint 1');
    expect(checkBoard(board)).toEqual([]);
  });

  it('moves an issue between periods and unschedules it', () => {
    const paths = seed();
    createIssue(reload(paths), { type: 'user_story', title: 'Gateway', parentId: 'LP-3' });

    let board = reload(paths);
    const scheduled = moveNode(board, findIssue(board, 'LP-4')!, { period: 'TL-2' });
    expect(scheduled.periodChanged).toBe(true);
    expect(findIssue(reload(paths), 'LP-4')!.period).toBe('TL-2');

    board = reload(paths);
    const cleared = moveNode(board, findIssue(board, 'LP-4')!, { period: null });
    expect(cleared.periodChanged).toBe(true);
    expect(findIssue(reload(paths), 'LP-4')!.period).toBeNull();
  });

  it('rejects an unknown period', () => {
    const paths = seed();
    const board = reload(paths);
    expect(() =>
      createIssue(board, { type: 'user_story', title: 'x', parentId: 'LP-3', period: 'TL-99' }),
    ).toThrow(/No period with id/);
  });

  it('refuses --status and --period on a period', () => {
    const paths = seed();
    const board = reload(paths);
    const sprint = findPeriod(board, 'TL-2')!;
    expect(() => moveNode(board, sprint, { status: 'done' })).toThrow(/applies to issues only/);
    expect(() => moveNode(board, sprint, { period: 'TL-3' })).toThrow(/applies to issues only/);
  });

  it('re-parents a period like any other document', () => {
    const paths = seed();
    createPeriod(reload(paths), {
      type: 'increment',
      title: '2027 H1',
      starts: '2027-01-01',
      ends: '2027-06-30',
    });
    const board = reload(paths);
    moveNode(board, findPeriod(board, 'TL-3')!, { parentId: 'TL-4' });
    const after = reload(paths);
    expect(findPeriod(after, 'TL-3')!.parentId).toBe('TL-4');
    expect(existsSync(path.join(after.paths.timelineDir, 'TL-4', 'TL-3'))).toBe(
      true,
    );
  });
});

/**
 * The switch held over the dates. Absent is the ordinary state and means the
 * calendar decides, which is why almost every assertion here is about what
 * *stays* absent.
 */
describe('the on/off switch', () => {
  const frontmatter = (paths: BoardPaths, id: string): Record<string, unknown> =>
    parseFrontmatter(readFileSync(findPeriod(reload(paths), id)!.file, 'utf8')).data;

  it('is absent until somebody holds it, and is not written when it is', () => {
    const paths = seed();
    expect(findPeriod(reload(paths), 'TL-2')!.active).toBeUndefined();
    expect('active' in frontmatter(paths, 'TL-2')).toBe(false);
  });

  it('writes true and false, and removes the key again for null', () => {
    const paths = seed();
    updateNode(reload(paths), findPeriod(reload(paths), 'TL-2')!, { active: false });
    expect(frontmatter(paths, 'TL-2').active).toBe(false);
    expect(findPeriod(reload(paths), 'TL-2')!.active).toBe(false);

    updateNode(reload(paths), findPeriod(reload(paths), 'TL-2')!, { active: true });
    expect(frontmatter(paths, 'TL-2').active).toBe(true);

    // null is "back on the dates", which is the absent key rather than false.
    updateNode(reload(paths), findPeriod(reload(paths), 'TL-2')!, { active: null });
    expect('active' in frontmatter(paths, 'TL-2')).toBe(false);
    expect(findPeriod(reload(paths), 'TL-2')!.active).toBeUndefined();
  });

  it('applies to periods only', () => {
    const paths = seed();
    const board = reload(paths);
    expect(() => updateNode(board, findIssue(board, 'LP-1')!, { active: true })).toThrow(
      /applies to periods only/,
    );
  });

  it('reads a hand-written yes/no, and reports anything else', () => {
    const paths = seed();
    writeRawIssue(
      path.join(paths.timelineDir, 'TL-9-yes'),
      '---\nid: TL-9\ntype: increment\ntitle: Yes\nstarts: 2027-01-01\nends: 2027-01-31\nactive: no\n---\n',
      PERIOD_FILE,
    );
    writeRawIssue(
      path.join(paths.timelineDir, 'TL-10-junk'),
      '---\nid: TL-10\ntype: increment\ntitle: Junk\nstarts: 2027-02-01\nends: 2027-02-28\nactive: maybe\n---\n',
      PERIOD_FILE,
    );
    const board = reload(paths);
    expect(findPeriod(board, 'TL-9')!.active).toBe(false);
    // Unreadable is absent, never off — the board must not park work on a typo.
    expect(findPeriod(board, 'TL-10')!.active).toBeUndefined();
    expect(messages(checkBoard(board))).toMatch(/active must be true or false, not "maybe"/);
  });
});

describe('periodStance', () => {
  const stanceOf = (paths: BoardPaths, id: string) => {
    const board = reload(paths);
    return periodStance(board, findPeriod(board, id)!);
  };

  it('is auto until somebody holds the switch', () => {
    expect(stanceOf(seed(), 'TL-2')).toBe('auto');
  });

  it('reads on and off from the document itself', () => {
    const paths = seed();
    updateNode(reload(paths), findPeriod(reload(paths), 'TL-2')!, { active: true });
    updateNode(reload(paths), findPeriod(reload(paths), 'TL-3')!, { active: false });
    expect(stanceOf(paths, 'TL-2')).toBe('on');
    expect(stanceOf(paths, 'TL-3')).toBe('off');
  });

  /**
   * The two directions are deliberately not symmetric: parking an increment
   * parks the sprints in it, but a live quarter does not make all its sprints
   * this week.
   */
  it('carries off downwards, and on nowhere', () => {
    const paths = seed();
    updateNode(reload(paths), findPeriod(reload(paths), 'TL-1')!, { active: false });
    expect(stanceOf(paths, 'TL-2')).toBe('off');

    updateNode(reload(paths), findPeriod(reload(paths), 'TL-1')!, { active: true });
    expect(stanceOf(paths, 'TL-1')).toBe('on');
    expect(stanceOf(paths, 'TL-2')).toBe('auto');
  });

  it('lets an increment that is off win over a sprint that is on', () => {
    const paths = seed();
    updateNode(reload(paths), findPeriod(reload(paths), 'TL-1')!, { active: false });
    updateNode(reload(paths), findPeriod(reload(paths), 'TL-2')!, { active: true });
    expect(stanceOf(paths, 'TL-2')).toBe('off');
  });
});

describe('a period that overran', () => {
  /** Sprint 1 (ends 2026-08-14) with one story done and one still open. */
  function overrun(): BoardPaths {
    const paths = seed();
    createIssue(reload(paths), {
      type: 'user_story',
      title: 'Shipped',
      parentId: 'LP-3',
      period: 'TL-2',
    });
    createIssue(reload(paths), {
      type: 'user_story',
      title: 'Not shipped',
      parentId: 'LP-3',
      period: 'TL-2',
    });
    moveNode(reload(paths), findIssue(reload(paths), 'LP-4')!, { status: 'done' });
    return paths;
  }

  it('is late once its end date is past and work is still open', () => {
    const board = reload(overrun());
    const sprint = findPeriod(board, 'TL-2')!;
    expect(isPeriodOverdue(board, sprint, '2026-08-20')).toBe(true);
    // Not yet over, and over but empty of open work, are both fine.
    expect(isPeriodOverdue(board, sprint, '2026-08-10')).toBe(false);
    expect(isPeriodOverdue(board, findPeriod(board, 'TL-3')!, '2026-08-20')).toBe(false);
  });

  it('counts only what is unfinished, and only what sits in it directly', () => {
    const board = reload(overrun());
    expect(openIssuesInPeriod(board, 'TL-2').map((issue) => issue.title)).toEqual(['Not shipped']);
    // The increment's own list is empty: its sprints answer for their stories.
    expect(openIssuesInPeriod(board, 'TL-1')).toEqual([]);
  });

  it('knows which period the work would move into, and when there is none', () => {
    const board = reload(overrun());
    expect(nextPeriodAfter(board, 'TL-2')?.id).toBe('TL-3');
    // TL-3 is the last sprint, so there is nowhere further to push.
    expect(nextPeriodAfter(board, 'TL-3')).toBeNull();
  });
});

describe('period helpers', () => {
  it('walks the period chain outermost first', () => {
    const paths = seed();
    expect(periodChain(reload(paths), 'TL-2').map((period) => period.id)).toEqual(['TL-1', 'TL-2']);
  });

  it('lists issues in a period, including child periods', () => {
    const paths = seed();
    createIssue(reload(paths), {
      type: 'user_story',
      title: 'A',
      parentId: 'LP-3',
      period: 'TL-2',
    });
    createIssue(reload(paths), {
      type: 'user_story',
      title: 'B',
      parentId: 'LP-3',
      period: 'TL-3',
    });
    const board = reload(paths);
    expect(issuesInPeriod(board, 'TL-2').map((issue) => issue.title)).toEqual(['A']);
    expect(issuesInPeriod(board, 'TL-1').map((issue) => issue.title).sort()).toEqual(['A', 'B']);
    expect(issuesInPeriod(board, 'TL-1', false)).toEqual([]);
  });
});

describe('period validation', () => {
  it('passes on a board built through the API', () => {
    expect(checkBoard(reload(seed()))).toEqual([]);
  });

  it('flags missing and invalid dates', () => {
    const paths = seed();
    writeRawIssue(
      path.join(paths.timelineDir, 'TL-9-nodates'),
      '---\nid: TL-9\ntype: increment\ntitle: No dates\n---\n',
      PERIOD_FILE,
    );
    writeRawIssue(
      path.join(paths.timelineDir, 'TL-10-bad'),
      '---\nid: TL-10\ntype: increment\ntitle: Bad\nstarts: 2026-13-01\nends: 2026-12-31\n---\n',
      PERIOD_FILE,
    );
    const text = messages(checkBoard(reload(paths)));
    expect(text).toMatch(/missing starts date/);
    expect(text).toMatch(/missing ends date/);
    expect(text).toMatch(/starts "2026-13-01" is not a valid YYYY-MM-DD date/);
  });

  it('flags an inverted range as an error', () => {
    const paths = seed();
    writeRawIssue(
      path.join(paths.timelineDir, 'TL-9-inverted'),
      '---\nid: TL-9\ntype: increment\ntitle: Inverted\nstarts: 2026-05-01\nends: 2026-04-01\n---\n',
      PERIOD_FILE,
    );
    const problem = checkBoard(reload(paths)).find((p) => /is before starts/.test(p.message));
    expect(problem?.level).toBe('error');
  });

  it('warns when a child period escapes its parent range', () => {
    const paths = seed();
    writeRawIssue(
      path.join(paths.timelineDir, 'TL-1', 'TL-9'),
      '---\nid: TL-9\ntype: sprint\ntitle: Outside\nstarts: 2027-02-01\nends: 2027-02-12\n---\n',
      PERIOD_FILE,
    );
    const problem = checkBoard(reload(paths)).find((p) => /falls outside TL-1/.test(p.message));
    expect(problem?.level).toBe('warn');
  });

  it('warns when sibling periods overlap', () => {
    const paths = seed();
    writeRawIssue(
      path.join(paths.timelineDir, 'TL-1', 'TL-9'),
      '---\nid: TL-9\ntype: sprint\ntitle: Overlap\nstarts: 2026-08-10\nends: 2026-08-20\n---\n',
      PERIOD_FILE,
    );
    expect(messages(checkBoard(reload(paths)))).toMatch(/overlaps TL-2/);
  });

  it('flags an issue pointing at a period that does not exist', () => {
    const paths = seed();
    createIssue(reload(paths), { type: 'user_story', title: 'x', parentId: 'LP-3' });
    const story = findIssue(reload(paths), 'LP-4')!;
    writeRawIssue(
      story.dir,
      readFileSync(story.file, 'utf8').replace('period: null', 'period: TL-404'),
    );
    expect(messages(checkBoard(reload(paths)))).toMatch(/period "TL-404" does not exist/);
  });

  it('flags timeline documents on a board with no period types', () => {
    const paths = makeBoard('blank', 'LP');
    writeRawIssue(
      path.join(paths.timelineDir, 'stray'),
      '---\ntitle: Stray\n---\n',
      PERIOD_FILE,
    );
    expect(messages(checkBoard(reload(paths)))).toMatch(/declares no period_types/);
  });

  it('adopts a hand-written period and resyncs the period counter', () => {
    const paths = seed();
    writeRawIssue(
      path.join(paths.timelineDir, 'TL-40-hand-made'),
      '---\nstarts: 2027-01-04\nends: 2027-06-30\n---\n\n# Hand made\n',
      PERIOD_FILE,
    );

    applyFixes(reload(paths));
    const board = reload(paths);
    const adopted = findPeriod(board, 'TL-40')!;
    expect(adopted.type).toBe('increment');
    expect(adopted.title).toBe('Hand made');
    expect(adopted.created).toEqual(expect.any(String));
    expect(adopted.author).toEqual(expect.any(String));
    expect(path.basename(adopted.dir)).toBe('TL-40');
    expect(readState(paths).period_counter).toBe(40);
    expect(checkBoard(board)).toEqual([]);
  });

  it('keeps issue and period counters separate when fixing', () => {
    const paths = seed();
    writeRawIssue(path.join(paths.timelineDir, 'adopt'), '# Adopted\nstub\n', PERIOD_FILE);
    applyFixes(reload(paths));
    const state = readState(paths);
    expect(state.period_counter).toBe(4);
    expect(state.counter).toBe(3);
  });

  it('rejects a period id used by an issue', () => {
    const paths = seed();
    expect(() =>
      createPeriod(reload(paths), {
        type: 'increment',
        title: 'x',
        starts: '2026-01-01',
        ends: '2026-01-02',
        parentId: 'LP-1',
      }),
    ).toThrow(BoardError);
  });
});
