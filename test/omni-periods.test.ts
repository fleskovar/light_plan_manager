import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { Change } from '../src/shared/changes.js';
import {
  checkBoard,
  createIssue,
  createPeriod,
  defaultPeriodFor,
  findIssue,
  findPeriod,
  parseConfigText,
  removeNode,
} from '../src/core/index.js';
import { applyChanges } from '../src/sync/apply.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterAll(cleanupBoards);

const omniBoard = (template = 'scrum') => makeBoard(template, 'LP', { omni: true });

describe('lpm init seeds the omni periods', () => {
  it('builds one period per level, nested, and points default_period at the innermost', () => {
    const paths = omniBoard();
    const board = reload(paths);

    expect(board.periods.map((period) => [period.id, period.type, period.title, period.parentId])).toEqual([
      ['TL-1', 'increment', 'Omni Product Increment', null],
      ['TL-2', 'sprint', 'Omni Sprint', 'TL-1'],
    ]);
    // A year from the day the board was made, so a plain board shows it as now.
    expect(findPeriod(board, 'TL-2')).toMatchObject({ starts: '2026-08-10', ends: '2027-08-09' });
    expect(board.config.default_period).toBe('TL-2');
    // Beside the other timeline settings, not dumped at the end of the file.
    expect(readFileSync(paths.configPath, 'utf8')).toMatch(/^period_prefix: TL\n\n#[^\n]*\n#[^\n]*\ndefault_period: TL-2$/m);
    expect(checkBoard(board)).toEqual([]);
  });

  it('seeds a single level on kanban and nothing on a board with no timeline', () => {
    const kanban = reload(omniBoard('kanban'));
    expect(kanban.periods.map((period) => period.title)).toEqual(['Omni Delivery Cycle']);
    expect(kanban.config.default_period).toBe('CY-1');

    const blank = reload(omniBoard('blank'));
    expect(blank.periods).toEqual([]);
    expect(blank.config.default_period).toBe('');
  });

  it('can be skipped', () => {
    const board = reload(makeBoard('scrum', 'LP', { omni: false }));
    expect(board.periods).toEqual([]);
    expect(board.config.default_period).toBe('');
  });
});

describe('the catch-all period', () => {
  it('schedules every new issue nobody scheduled, at any level', () => {
    const paths = omniBoard();
    const program = createIssue(reload(paths), { type: 'program', title: 'Platform' });
    const epic = createIssue(reload(paths), { type: 'epic', title: 'Checkout', parentId: program.id });
    const feature = createIssue(reload(paths), { type: 'feature', title: 'Guest', parentId: epic.id });
    const story = createIssue(reload(paths), { type: 'user_story', title: 'Pay', parentId: feature.id });
    expect([program, epic, feature, story].map((issue) => issue.period)).toEqual(['TL-2', 'TL-2', 'TL-2', 'TL-2']);
  });

  it('honours a period somebody named, and null as "leave it unscheduled"', () => {
    const paths = omniBoard();
    expect(createIssue(reload(paths), { type: 'program', title: 'Named', period: 'TL-1' }).period).toBe('TL-1');
    expect(createIssue(reload(paths), { type: 'program', title: 'Unscheduled', period: null }).period).toBeNull();
  });

  it('stops catching the moment somebody builds a period of their own', () => {
    const paths = omniBoard();
    const before = createIssue(reload(paths), { type: 'program', title: 'Before' });
    createPeriod(reload(paths), { type: 'increment', title: 'PI-1', starts: '2026-09-01', ends: '2026-11-30' });

    const board = reload(paths);
    expect(defaultPeriodFor(board)).toBeNull();
    expect(createIssue(board, { type: 'program', title: 'After' }).period).toBeNull();
    // What it already caught stays where it is — moving work is the planner's call.
    expect(findIssue(reload(paths), before.id)!.period).toBe('TL-2');
  });

  it('reaches every front end through the push, and a pushed null opts out', () => {
    const paths = omniBoard();
    const result = applyChanges(paths, [
      { kind: 'create', id: 'new:1', nodeKind: 'issue', patch: { type: 'program', title: 'Defaulted' } },
      { kind: 'create', id: 'new:2', nodeKind: 'issue', patch: { type: 'program', title: 'Pulled', period: null } },
    ] satisfies Change[]);
    expect(result.failures).toEqual([]);

    const board = reload(paths);
    const byTitle = (title: string) => board.issues.find((issue) => issue.title === title)!;
    expect(byTitle('Defaulted').period).toBe('TL-2');
    expect(byTitle('Pulled').period).toBeNull();
  });

  it('is reported, and ignored, once the chain is deleted', () => {
    const paths = omniBoard();
    const issue = createIssue(reload(paths), { type: 'program', title: 'Caught' });
    removeNode(reload(paths), findPeriod(reload(paths), 'TL-1')!);

    const board = reload(paths);
    expect(findIssue(board, issue.id)!.period).toBeNull();
    expect(createIssue(board, { type: 'program', title: 'Later' }).period).toBeNull();
    expect(checkBoard(reload(paths))).toEqual([
      expect.objectContaining({ level: 'warn', message: expect.stringMatching(/default_period "TL-2" is not in the timeline/) }),
    ]);
  });
});

describe('default_period in the config', () => {
  const scrum = readFileSync(new URL('../templates/scrum.yml', import.meta.url), 'utf8');
  const blank = readFileSync(new URL('../templates/blank.yml', import.meta.url), 'utf8');

  it('must name a period id on a board that has a timeline', () => {
    expect(parseConfigText(`${scrum}\ndefault_period: TL-4\n`).errors).toEqual([]);
    expect(parseConfigText(`${scrum}\ndefault_period: LP-4\n`).errors.join()).toMatch(/not a period id \(TL-<n>\)/);
    expect(parseConfigText(`${blank}\ndefault_period: TL-1\n`).errors.join()).toMatch(/declares no period_types/);
  });
});
