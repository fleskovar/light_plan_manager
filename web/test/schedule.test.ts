import { describe, expect, it } from 'vitest';
import {
  buildTimeline,
  foldToLevel,
  foldableKeys,
  ganttLevels,
  type GanttRow,
} from '$features/drawer/gantt/schedule.js';
import { board, config, issue, period } from './fixtures.js';

/**
 * A quarter with two sprints in it, and a feature whose two stories are spread
 * across them — the shape the chart has to read at more than one level.
 *
 *   PI-1        Jan 1 .. Mar 31   (E is scheduled here)
 *     Sprint 1  Jan 1 .. Jan 14   (F1, S1)
 *     Sprint 2  Jan 15 .. Jan 28  (S2)
 *   P > E > F1 > S1, S2           F2 > S3, scheduled nowhere
 */
const sample = () =>
  board(
    period('PI', '2026-01-01', '2026-03-31', null, 'increment'),
    period('SP1', '2026-01-01', '2026-01-14', 'PI'),
    period('SP2', '2026-01-15', '2026-01-28', 'PI'),
    issue('P', 'program', null),
    issue('E', 'epic', 'P', { period: 'PI' }),
    issue('F1', 'feature', 'E', { period: 'SP1' }),
    issue('S1', 'user_story', 'F1', { period: 'SP1' }),
    issue('S2', 'user_story', 'F1', { period: 'SP2' }),
    issue('F2', 'feature', 'E'),
    issue('S3', 'user_story', 'F2'),
  );

const timeline = (
  folded: string[] = [],
  grouping: 'period' | 'hierarchy' = 'period',
): ReturnType<typeof buildTimeline> =>
  buildTimeline(sample(), config, new Set(), {
    grouping,
    isCollapsed: (key) => folded.includes(key),
  });

const shape = (rows: GanttRow[]): string[] =>
  rows.map((row) => `${'  '.repeat(row.depth)}${row.node.id}`);

const row = (rows: GanttRow[], id: string): GanttRow => rows.find((entry) => entry.node.id === id)!;

describe('the period grouping', () => {
  it('nests the issues of a period under it, by their own hierarchy', () => {
    expect(shape(timeline().rows)).toEqual([
      'PI',
      '  E',
      '  SP1',
      '    F1',
      '      S1',
      '  SP2',
      '    S2',
    ]);
  });

  it('puts the periods in date order rather than by name', () => {
    const rows = buildTimeline(
      board(
        period('LATE', '2026-06-01', '2026-06-30'),
        period('EARLY', '2026-01-01', '2026-01-31'),
      ),
      config,
      new Set(),
    ).rows;
    expect(rows.map((entry) => entry.node.id)).toEqual(['EARLY', 'LATE']);
  });

  it('folds a period away with everything scheduled in it', () => {
    const rows = timeline(['period:SP1']).rows;
    expect(shape(rows)).toEqual(['PI', '  E', '  SP1', '  SP2', '    S2']);
    expect(row(rows, 'SP1').collapsed).toBe(true);
  });

  it('folds an issue away without touching its siblings', () => {
    expect(shape(timeline(['issue:F1']).rows)).toEqual([
      'PI',
      '  E',
      '  SP1',
      '    F1',
      '  SP2',
      '    S2',
    ]);
  });

  it('dates every row from the period it is in, not from its children', () => {
    const rows = timeline().rows;
    expect(row(rows, 'F1').starts).toBe('2026-01-01');
    expect(row(rows, 'F1').ends).toBe('2026-01-14');
    expect(row(rows, 'F1').rolled).toBe(false);
  });
});

describe('the hierarchy grouping', () => {
  it('is the issue tree, and leaves out what nothing dates', () => {
    expect(shape(timeline([], 'hierarchy').rows)).toEqual(['P', '  E', '    F1', '      S1', '      S2']);
  });

  it('covers an unscheduled parent with the work underneath it', () => {
    const p = row(timeline([], 'hierarchy').rows, 'P');
    expect(p.rolled).toBe(true);
    // P is in no period at all, so its bar is E's quarter.
    expect([p.starts, p.ends]).toEqual(['2026-01-01', '2026-03-31']);
  });

  it('widens a scheduled parent to hold children scheduled beyond it', () => {
    const f1 = row(timeline([], 'hierarchy').rows, 'F1');
    // F1 sits in Sprint 1, but S2 runs to the end of Sprint 2.
    expect([f1.starts, f1.ends]).toEqual(['2026-01-01', '2026-01-28']);
    // The dates it does have are its own, so it is not marked as borrowed.
    expect(f1.rolled).toBe(false);
  });

  it('keeps the covering bar when a row is folded', () => {
    const rows = timeline(['issue:F1'], 'hierarchy').rows;
    expect(shape(rows)).toEqual(['P', '  E', '    F1']);
    expect(row(rows, 'F1').bar).not.toBeNull();
  });
});

describe('the scale', () => {
  it('runs from the first day of the plan to the last', () => {
    const chart = timeline();
    const pi = row(chart.rows, 'PI');
    expect(pi.bar!.offset).toBeCloseTo(0, 5);
    expect(pi.bar!.offset + pi.bar!.span).toBeCloseTo(1, 5);
    const sprint = row(chart.rows, 'SP1');
    expect(sprint.bar!.span).toBeLessThan(pi.bar!.span);
  });

  it('counts the leaves nothing dates as unscheduled', () => {
    expect(timeline().unscheduled.map((entry) => entry.id)).toEqual(['S3']);
  });

  it('offers every foldable row, so collapse-all reaches the deep ones', () => {
    expect(foldableKeys(timeline()).sort()).toEqual([
      'issue:F1',
      'period:PI',
      'period:SP1',
      'period:SP2',
    ]);
  });
});

describe('reading the chart at one level', () => {
  it('lays the two hierarchies end to end, periods first', () => {
    expect(ganttLevels(config, 'period').map((level) => [level.label, level.rank])).toEqual([
      ['Increment', 0],
      ['Sprint', 1],
      ['Program', 2],
      ['Epic', 3],
      ['Feature', 4],
      ['User Story / Bug', 5],
      ['Sub-task', 6],
    ]);
  });

  it('drops the periods when the chart is grouped by hierarchy', () => {
    expect(ganttLevels(config, 'hierarchy').map((level) => level.rank)).toEqual([0, 1, 2, 3, 4]);
  });

  it('shows increments only', () => {
    const folded = foldToLevel(config, 'period', timeline(), 0);
    expect(shape(timeline([...folded]).rows)).toEqual(['PI']);
  });

  it('opens the increments down to their sprints', () => {
    const folded = foldToLevel(config, 'period', timeline(), 1);
    // The increment opens; the sprints and the issue scheduled in it fold.
    expect(shape(timeline([...folded]).rows)).toEqual(['PI', '  E', '  SP1', '  SP2']);
  });

  it('opens everything down to the story level', () => {
    const folded = foldToLevel(config, 'period', timeline(), 5);
    expect(shape(timeline([...folded]).rows)).toEqual([
      'PI',
      '  E',
      '  SP1',
      '    F1',
      '      S1',
      '  SP2',
      '    S2',
    ]);
  });

  it('folds from the whole chart, not from what happens to be showing', () => {
    // A feature buried inside a folded sprint still has to be folded, or
    // opening the sprint would spill its stories.
    expect(foldToLevel(config, 'period', timeline(), 1)).toContain('issue:F1');
  });
});
