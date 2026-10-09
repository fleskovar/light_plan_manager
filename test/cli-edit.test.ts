import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Issue } from '../src/core/index.js';
import { boardPathsFor, listComments, loadBoard } from '../src/core/index.js';

/**
 * The editing commands, end to end against the built CLI: `npm test` runs
 * `pretest` (tsc) first, so this covers the bin wiring as well as the plans.
 */
const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));

const dirs: string[] = [];
let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(path.join(os.tmpdir(), 'lpm-edit-'));
  dirs.push(cwd);
  seed();
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function lpm(...args: string[]): { status: number; all: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { status: result.status ?? 0, all: (result.stdout ?? '') + (result.stderr ?? '') };
}

/** program > epic > feature > two stories, LP-5 blocked by LP-4. */
function seed(): void {
  lpm('init', '--no-git', '--no-omni', '--template', 'scrum', '--prefix', 'LP');
  lpm('new', 'program', '-t', 'Platform');
  lpm('new', 'epic', '-t', 'Checkout', '-p', 'LP-1');
  lpm('new', 'feature', '-t', 'Guest flow', '-p', 'LP-2');
  lpm('new', 'user_story', '-t', 'Big story', '-p', 'LP-3', '--set', 'story_points=12');
  lpm('new', 'user_story', '-t', 'Follow up', '-p', 'LP-3');
  lpm('link', 'LP-5', '--depends-on', 'LP-4');
}

const board = () => loadBoard(boardPathsFor(cwd));
const issues = (): Issue[] => board().issues;
const byTitle = (title: string): Issue =>
  issues().find((issue) => issue.title === title) ?? (undefined as unknown as Issue);
const byId = (id: string): Issue =>
  issues().find((issue) => issue.id === id) ?? (undefined as unknown as Issue);

describe('lpm set', () => {
  it('renames, retitles the folder, and sets attributes', () => {
    const result = lpm('set', 'LP-4', '--title', 'Checkout form', '--set', 'story_points=5');
    expect(result.status).toBe(0);

    const issue = issues().find((entry) => entry.id === 'LP-4')!;
    expect(issue.title).toBe('Checkout form');
    expect(issue.attributes.story_points).toBe(5);
    expect(issue.dir).toContain('LP-4');
  });

  it('replaces the body from a file, and from stdin', () => {
    expect(lpm('set', 'LP-4', '--body', '# Rewritten').status).toBe(0);
    expect(issues().find((entry) => entry.id === 'LP-4')!.body.trim()).toBe('# Rewritten');
  });

  it('rejects an attribute the type does not declare', () => {
    const result = lpm('set', 'LP-4', '--set', 'nonsense=1');
    expect(result.status).toBe(1);
    expect(result.all).toMatch(/not an attribute/);
  });

  it('says so when there is nothing to do', () => {
    expect(lpm('set', 'LP-4').status).toBe(1);
  });

  it('attaches and detaches related files without retyping the list', () => {
    expect(
      lpm('set', 'LP-4', '--related', 'docs/prd.md#L10-L42', '--related', 'src/a.ts').status,
    ).toBe(0);
    expect(byId('LP-4').related_files).toEqual(['docs/prd.md#L10-L42', 'src/a.ts']);

    // Adding one keeps what was there; that is the point of add/remove over replace.
    expect(lpm('set', 'LP-4', '--related', 'src/b.ts', '--unrelated', 'src/a.ts').status).toBe(0);
    expect(byId('LP-4').related_files).toEqual(['docs/prd.md#L10-L42', 'src/b.ts']);
  });

  it('refuses related files on a period', () => {
    lpm('new', 'increment', '-t', 'PI-1', '--starts', '2026-08-01', '--ends', '2026-10-31');
    const result = lpm('set', 'TL-1', '--related', 'src/a.ts');
    expect(result.status).toBe(1);
    expect(result.all).toMatch(/issues only/);
  });
});

describe('lpm flag', () => {
  const flag = (...args: string[]) => lpm('flag', ...args);

  it('raises a flag with a comment, and leaves the status alone', () => {
    lpm('move', 'LP-4', '-s', 'in_progress');
    const result = flag('LP-4', '--reason', 'help', '--comment', 'Need a retry budget');

    expect(result.status).toBe(0);
    expect(result.all).toContain('Needs help');
    expect(byId('LP-4').flag).toBe('help');
    expect(byId('LP-4').status).toBe('in_progress');
    expect(listComments(board(), 'LP-4')[0]!.body).toContain('Need a retry budget');
  });

  it('refuses without a comment — a red box nobody can read helps nobody', () => {
    const result = flag('LP-4');
    expect(result.status).toBe(1);
    expect(result.all).toMatch(/Say why/);
    expect(byId('LP-4').flag).toBeNull();
  });

  it('names the reasons it accepts', () => {
    const result = flag('LP-4', '--reason', 'sleepy', '--comment', 'zzz');
    expect(result.status).toBe(1);
    expect(result.all).toMatch(/blocked, paused, help/);
  });

  it('lists what has stopped', () => {
    flag('LP-4', '--comment', 'ops have not replied');
    const result = flag('list');
    expect(result.status).toBe(0);
    expect(result.all).toContain('LP-4');
    expect(result.all).toContain('Blocked');
  });

  it('clears one, with a comment, and says what it was', () => {
    flag('LP-4', '--reason', 'paused', '--comment', 'set down');
    const result = flag('clear', 'LP-4', '--comment', 'carry on');

    expect(result.status).toBe(0);
    expect(result.all).toContain('Paused');
    expect(byId('LP-4').flag).toBeNull();
    expect(listComments(board(), 'LP-4')).toHaveLength(2);
  });

  it('needs an id to clear, because clearing is deliberate', () => {
    flag('LP-4', '--comment', 'stuck');
    const result = flag('clear', '--comment', 'carry on');
    expect(result.status).toBe(1);
    expect(result.all).toMatch(/Missing id/);
  });

  it('is cleared by finishing the work', () => {
    lpm('move', 'LP-4', '-s', 'in_progress');
    flag('LP-4', '--comment', 'stuck');
    // Finishing answers the flag; the comment trail keeps the history.
    expect(lpm('move', 'LP-4', '-s', 'done').status).toBe(0);
    expect(byId('LP-4').flag).toBeNull();
    expect(listComments(board(), 'LP-4')).toHaveLength(1);
  });
});

describe('lpm convert', () => {
  it('swaps a type at the same level', () => {
    expect(lpm('convert', 'LP-4', 'bug').status).toBe(0);
    expect(issues().find((entry) => entry.id === 'LP-4')!.type).toBe('bug');
  });

  it('promotes a story to a feature and moves it to the epic', () => {
    expect(lpm('convert', 'LP-4', 'feature').status).toBe(0);
    const issue = issues().find((entry) => entry.id === 'LP-4')!;
    expect(issue.type).toBe('feature');
    expect(issue.parentId).toBe('LP-2');
  });

  it('demotes with --under, the way dropping a node on another does', () => {
    lpm('new', 'feature', '-t', 'Returning', '-p', 'LP-2');
    expect(lpm('convert', 'LP-6', '--under', 'LP-3').status).toBe(0);
    const issue = issues().find((entry) => entry.id === 'LP-6')!;
    expect(issue.type).toBe('user_story');
    expect(issue.parentId).toBe('LP-3');
  });

  it('changes nothing on --dry-run', () => {
    const result = lpm('convert', 'LP-4', 'feature', '--dry-run');
    expect(result.all).toMatch(/Would convert/);
    expect(issues().find((entry) => entry.id === 'LP-4')!.type).toBe('user_story');
  });

  it('refuses a demotion with no parent to demote into', () => {
    const result = lpm('convert', 'LP-3', 'user_story');
    expect(result.status).toBe(1);
    expect(result.all).toMatch(/sits below/);
  });
});

describe('lpm split', () => {
  it('nests the pieces and chains them', () => {
    const result = lpm('split', 'LP-4', '--into', '3');
    expect(result.status).toBe(0);

    const pieces = issues().filter((issue) => issue.parentId === 'LP-4');
    expect(pieces).toHaveLength(3);
    expect(pieces.every((piece) => piece.type === 'sub_task')).toBe(true);
    expect(pieces[1]!.depends_on).toEqual([pieces[0]!.id]);
  });

  it('replaces the original and moves its downstream edge to the last piece', () => {
    const result = lpm('split', 'LP-4', '--into', '3', '--replace', '--split-effort');
    expect(result.status).toBe(0);

    const remaining = issues();
    expect(remaining.find((issue) => issue.id === 'LP-4')).toBeUndefined();

    const pieces = remaining.filter((issue) => issue.title.startsWith('Big story ('));
    expect(pieces.map((piece) => piece.attributes.story_points)).toEqual([4, 4, 4]);
    // LP-5 waited on the original; it now waits on the last piece.
    expect(remaining.find((issue) => issue.id === 'LP-5')!.depends_on).toEqual([pieces[2]!.id]);
  });

  it('takes explicit titles', () => {
    lpm('split', 'LP-4', '--titles', 'Schema,API,UI', '--replace');
    const titles = issues()
      .filter((issue) => issue.parentId === 'LP-3')
      .map((issue) => issue.title);
    expect(titles).toEqual(expect.arrayContaining(['Schema', 'API', 'UI']));
  });

  it('reports the plan and writes nothing on --dry-run', () => {
    const result = lpm('split', 'LP-4', '--into', '2', '--dry-run');
    expect(result.all).toMatch(/Would split/);
    expect(issues()).toHaveLength(5);
  });
});

describe('lpm insert', () => {
  it('creates an issue inside a dependency and replaces the edge', () => {
    const result = lpm('insert', '--between', 'LP-4..LP-5', '-t', 'Validate');
    expect(result.status).toBe(0);

    const middle = byTitle('Validate');
    expect(middle.parentId).toBe('LP-3');
    expect(middle.depends_on).toEqual(['LP-4']);
    expect(issues().find((issue) => issue.id === 'LP-5')!.depends_on).toEqual([middle.id]);
  });

  it('moves an existing issue into the dependency', () => {
    lpm('new', 'user_story', '-t', 'Middle', '-p', 'LP-3');
    expect(lpm('insert', '--between', 'LP-4..LP-5', '--issue', 'LP-6').status).toBe(0);
    expect(issues().find((issue) => issue.id === 'LP-6')!.depends_on).toEqual(['LP-4']);
    expect(issues().find((issue) => issue.id === 'LP-5')!.depends_on).toEqual(['LP-6']);
  });

  it('refuses when the two are not connected', () => {
    const result = lpm('insert', '--between', 'LP-5..LP-4', '-t', 'x');
    expect(result.status).toBe(1);
    expect(result.all).toMatch(/does not depend on/);
  });
});

describe('lpm copy', () => {
  it('duplicates a subtree and keeps its internal edges', () => {
    expect(lpm('copy', 'LP-3').status).toBe(0);

    const copied = byTitle('Guest flow (copy)');
    expect(copied.parentId).toBe('LP-2');
    const children = issues().filter((issue) => issue.parentId === copied.id);
    expect(children).toHaveLength(2);

    const follow = children.find((child) => child.title.startsWith('Follow up'))!;
    const big = children.find((child) => child.title.startsWith('Big story'))!;
    expect(follow.depends_on).toEqual([big.id]);
    // The original is untouched.
    expect(issues().find((issue) => issue.id === 'LP-5')!.depends_on).toEqual(['LP-4']);
  });

  it('puts the copies somewhere else with --under', () => {
    lpm('new', 'epic', '-t', 'Other', '-p', 'LP-1');
    expect(lpm('copy', 'LP-3', '--under', 'LP-6').status).toBe(0);
    expect(byTitle('Guest flow (copy)').parentId).toBe('LP-6');
  });
});

describe('lpm rm', () => {
  it('refuses a subtree without --recursive, then deletes it with one', () => {
    const guarded = lpm('rm', 'LP-3');
    expect(guarded.status).toBe(1);
    expect(guarded.all).toMatch(/--recursive/);
    expect(issues()).toHaveLength(5);

    expect(lpm('rm', 'LP-3', '--recursive').status).toBe(0);
    expect(issues().map((issue) => issue.id)).toEqual(['LP-1', 'LP-2']);
  });

  it('deletes a leaf and detaches what pointed at it', () => {
    expect(lpm('rm', 'LP-4').status).toBe(0);
    expect(issues().find((issue) => issue.id === 'LP-5')!.depends_on).toEqual([]);
  });

  it('lists without deleting on --dry-run', () => {
    expect(lpm('rm', 'LP-3', '--dry-run').all).toMatch(/Would delete/);
    expect(issues()).toHaveLength(5);
  });
});

describe('lpm comment', () => {
  it('adds, lists and removes', () => {
    expect(lpm('comment', 'LP-4', 'Started on the schema').status).toBe(0);
    expect(lpm('comment', 'LP-4', '-m', 'Blocked on credentials').status).toBe(0);

    const listed = lpm('comment', 'LP-4', '--list');
    expect(listed.all).toMatch(/Started on the schema/);
    expect(listed.all).toMatch(/Blocked on credentials/);
    expect(listed.all).toMatch(/2 comments/);

    expect(listComments(board(), 'LP-4')).toHaveLength(2);
    expect(lpm('comment', 'LP-4', '--remove', '1').status).toBe(0);
    expect(listComments(board(), 'LP-4').map((c) => c.body)).toEqual(['Blocked on credentials']);
  });

  it('attributes the comment to the current user when one is set', () => {
    lpm('new', 'person', '-t', 'Ada Lovelace');
    lpm('me', 'Ada Lovelace');
    lpm('comment', 'LP-4', 'note');
    expect(listComments(board(), 'LP-4')[0]!.author).toContain('Ada Lovelace');
  });

  it('says so when there is no comment and when the id is unknown', () => {
    expect(lpm('comment', 'LP-4').status).toBe(1);
    expect(lpm('comment', 'LP-99', 'x').status).toBe(1);
    expect(lpm('comment', 'LP-4', '--list').all).toMatch(/no comments yet/);
  });
});

describe('lpm period', () => {
  /** Two sprints in a quarter, with one story open in the first. */
  function timeline(): void {
    lpm('new', 'increment', '-t', 'H2', '--starts', '2026-07-01', '--ends', '2026-08-31');
    lpm('new', 'sprint', '-t', 'Sprint 1', '-p', 'TL-1', '--starts', '2026-07-01', '--ends', '2026-07-14');
    lpm('new', 'sprint', '-t', 'Sprint 2', '-p', 'TL-1', '--starts', '2026-07-15', '--ends', '2026-07-28');
    lpm('move', 'LP-4', '--period', 'TL-2');
    lpm('move', 'LP-5', '--period', 'TL-2');
    lpm('move', 'LP-4', '--status', 'done');
  }

  const period = (id: string) => board().periods.find((entry) => entry.id === id)!;

  it('reports how a period stands without changing it', () => {
    timeline();
    const result = lpm('period', 'TL-2');
    expect(result.status).toBe(0);
    expect(result.all).toMatch(/TL-2\s+Sprint 1/);
    expect(period('TL-2').active).toBeUndefined();
  });

  it('switches a period on, off and back onto its dates', () => {
    timeline();
    lpm('period', 'TL-2', '--off');
    expect(period('TL-2').active).toBe(false);
    lpm('period', 'TL-2', '--on');
    expect(period('TL-2').active).toBe(true);
    lpm('period', 'TL-2', '--dates');
    expect(period('TL-2').active).toBeUndefined();
  });

  it('refuses two switches at once', () => {
    timeline();
    const result = lpm('period', 'TL-2', '--on', '--off');
    expect(result.status).toBe(1);
    expect(result.all).toMatch(/only one of --on, --off and --dates/);
  });

  it('moves a period onto today and takes its sprints with it', () => {
    timeline();
    const today = new Date().toISOString().slice(0, 10);
    expect(lpm('period', 'TL-1', '--start-now').status).toBe(0);
    expect(period('TL-1').starts).toBe(today);
    // The sprints moved by the same number of days, so the run still fits.
    expect(period('TL-2').starts).toBe(today);
    expect(lpm('check').status).toBe(0);
  });

  it('changes nothing on a dry run', () => {
    timeline();
    const before = period('TL-2').starts;
    const result = lpm('period', 'TL-2', '--start-now', '--dry-run');
    expect(result.all).toMatch(/Would start/);
    expect(period('TL-2').starts).toBe(before);
  });

  it('completes the open work in a period', () => {
    timeline();
    expect(lpm('period', 'TL-2', '--complete').status).toBe(0);
    expect(byTitle('Follow up').status).toBe('done');
  });

  it('carries the open work into the next period, leaving the finished behind', () => {
    timeline();
    expect(lpm('period', 'TL-2', '--carry-over').status).toBe(0);
    expect(byTitle('Follow up').period).toBe('TL-3');
    expect(byTitle('Big story').period).toBe('TL-2');
  });

  it('refuses to carry work out of the last period beside it', () => {
    timeline();
    lpm('period', 'TL-2', '--carry-over');
    const result = lpm('period', 'TL-3', '--carry-over');
    expect(result.status).toBe(1);
    expect(result.all).toMatch(/no period after/i);
    // Nothing was unscheduled on the way out.
    expect(byTitle('Follow up').period).toBe('TL-3');
  });

  it('flags an overrun and says how to fix it', () => {
    timeline();
    // Sprint 1 ended in July with "Follow up" still open.
    const result = lpm('period', 'TL-2');
    expect(result.all).toMatch(/overdue: ended 2026-07-14 with 1 issue still open/);
    expect(result.all).toMatch(/lpm period TL-2 --complete/);
  });
});
