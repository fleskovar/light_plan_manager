import { describe, expect, it } from 'vitest';
import type { BoardView, IssueDto, PeriodDto } from '$shared';
import { planStartNow, startNowDates } from '$shared';
import {
  buildPeriodBoard,
  columnKeys,
  needsFreshDates,
  nextPeriodDates,
  planResequence,
  type PeriodColumn,
} from '$features/drawer/periods/periods.js';
import type { WorkingNodes } from '$lib/board/working.js';
import { board, config, issue, period } from './fixtures.js';

/** The shared planners take a whole board view, not just the documents. */
const view = (nodes: WorkingNodes): BoardView => ({ config, nodes });

/**
 * An increment with two sprints, and work spread over them:
 *
 *   PI-1                E (epic)
 *     Sprint 1          F1, S1
 *     Sprint 2          S2
 *   nowhere             F2, S3
 */
const sample = () =>
  board(
    period('PI', '2026-01-01', '2026-03-31', null, 'increment'),
    period('SP2', '2026-01-15', '2026-01-28', 'PI'),
    period('SP1', '2026-01-01', '2026-01-14', 'PI'),
    issue('P', 'program', null),
    issue('E', 'epic', 'P', { period: 'PI' }),
    issue('F1', 'feature', 'E', { period: 'SP1' }),
    issue('S1', 'user_story', 'F1', { period: 'SP1', attributes: { story_points: 3 } }),
    issue('S2', 'user_story', 'F1', { period: 'SP2', attributes: { story_points: 5 } }),
    issue('F2', 'feature', 'E'),
    issue('S3', 'user_story', 'F2', { attributes: { story_points: 2 } }),
  );

const built = (options = {}) => buildPeriodBoard(sample(), config, options);

/** The tree as `key(children)`, which is the thing the view is drawn from. */
const shape = (column: PeriodColumn): string =>
  column.children.length
    ? `${column.key}(${column.children.map(shape).join(' ')})`
    : column.key;

const find = (column: PeriodColumn, key: string): PeriodColumn =>
  column.key === key
    ? column
    : column.children.map((child) => find(child, key)).find(Boolean)!;

describe('buildPeriodBoard', () => {
  it('nests the sprints inside the increment they belong to', () => {
    const result = built();
    expect(result.roots.map(shape)).toEqual(['PI(SP2 SP1)']);
    // The backlog is beside the tree, not a period in it.
    expect(result.backlog.key).toBe('_none');
    expect(result.backlog.children).toEqual([]);
  });

  it('puts the children in date order rather than by name', () => {
    // SP2 is declared before SP1 in the sample, and starts after it.
    // Default newest-first: SP2 (later start) comes before SP1.
    expect(built().roots[0]!.children.map((child) => child.key)).toEqual(['SP2', 'SP1']);
  });

  it('gives every level its own cards, at every level', () => {
    const pi = built().roots[0]!;
    expect(pi.issues.map((entry) => entry.id)).toEqual(['E']);
    expect(find(pi, 'SP1').issues.map((entry) => entry.id)).toEqual(['F1', 'S1']);
    expect(built().backlog.issues.map((entry) => entry.id)).toEqual(['P', 'F2', 'S3']);
  });

  it('orders cards parents first, so a feature sits above its stories', () => {
    expect(find(built().roots[0]!, 'SP1').issues.map((entry) => entry.depth)).toEqual([2, 3]);
  });

  it('counts effort over leaves, and rolls the sprints up into the increment', () => {
    const pi = built().roots[0]!;
    // F1 has children, so its own points are not counted twice.
    expect(find(pi, 'SP1').effort).toBe(3);
    expect(find(pi, 'SP2').effort).toBe(5);
    // The epic scheduled in the increment is a parent, so the increment's own
    // effort is nothing, and everything it shows comes from its sprints.
    expect(pi.effort).toBe(0);
    expect(pi.rolledEffort).toBe(8);
  });

  it('names the type a child box would be, and stops at the deepest level', () => {
    const pi = built().roots[0]!;
    expect(pi.childType).toBe('sprint');
    expect(find(pi, 'SP1').childType).toBeNull();
  });

  it('filters the cards without dropping the boxes they were in', () => {
    const result = built({ search: 's1' });
    expect(result.roots.map(shape)).toEqual(['PI(SP2 SP1)']);
    expect(find(result.roots[0]!, 'SP1').issues.map((entry) => entry.id)).toEqual(['S1']);
    expect(find(result.roots[0]!, 'SP2').issues).toEqual([]);
    expect(result.backlog.issues).toEqual([]);
  });

  it('treats an issue pointing at a period that is gone as unscheduled', () => {
    const result = buildPeriodBoard(board(issue('X', 'program', null, { period: 'GONE' })), config);
    expect(result.backlog.issues.map((entry) => entry.id)).toEqual(['X']);
    expect(result.unscheduled).toBe(1);
  });

  it('reports the backlog size from the board, not from the filter', () => {
    expect(built({ search: 'nothing' }).unscheduled).toBe(3);
  });

  it('does not loop on a period that is its own ancestor', () => {
    const nodes = board(
      period('A', '2026-01-01', '2026-01-31', 'B', 'increment'),
      period('B', '2026-02-01', '2026-02-28', 'A', 'increment'),
    );
    // Neither is a root, so nothing is drawn — but the walk still terminates.
    expect(buildPeriodBoard(nodes, config).roots).toEqual([]);
  });

  it('defaults to newest-first so the most recent increment appears first', () => {
    // SP2 starts 2026-01-15, SP1 starts 2026-01-01 — SP2 is newer
    expect(built().roots.map(shape)).toEqual(['PI(SP2 SP1)']);
  });

  it('reverts to oldest-first when newestFirst is false', () => {
    const result = built({ newestFirst: false });
    expect(result.roots.map(shape)).toEqual(['PI(SP1 SP2)']);
  });

  it('oldest-first does not affect planResequence which reads time internally', () => {
    // planResequence always reads in time order regardless of drawer preference
    const nodes = sample();
    const edits = planResequence(nodes, 'SP2', 'SP1');
    // SP2 moved before SP1 — both should get new dates, earliest-first
    expect(edits.length).toBeGreaterThanOrEqual(2);
    expect(edits[0]!.id).toBe('SP2'); // first in the new order
  });
});

/**
 * The same board, read on a day inside Sprint 1. The flags below are what the
 * view lights up, and the dates are what its two buttons write.
 */
describe('what is running now', () => {
  const TODAY = '2026-01-08';

  it('marks the sprint that holds today, and the increment around it', () => {
    const result = buildPeriodBoard(sample(), config, { today: TODAY });
    const pi = result.roots[0]!;
    expect(pi.current).toBe(false);
    expect(pi.holdsCurrent).toBe(true);
    expect(find(pi, 'SP1').current).toBe(true);
    expect(find(pi, 'SP2').current).toBe(false);
    expect(find(pi, 'SP2').holdsCurrent).toBe(false);
  });

  it('marks nothing when today falls outside every period', () => {
    const result = buildPeriodBoard(sample(), config, { today: '2030-06-01' });
    expect(result.roots[0]!.holdsCurrent).toBe(false);
    expect(find(result.roots[0]!, 'SP1').current).toBe(false);
  });

  it('never marks the backlog, which has no dates at all', () => {
    const result = buildPeriodBoard(sample(), config, { today: TODAY });
    expect(result.backlog.current).toBe(false);
    expect(result.backlog.holdsCurrent).toBe(false);
  });
});

/**
 * The two states a box can be in beyond "running": parked by the switch, and
 * late — ended with work still in it. They are what the view draws in grey and
 * in red, and what the "Fix…" button acts on.
 */
describe('the switch and the overrun, as the view reads them', () => {
  /** Sprint 1 ran 01-01..01-14 and holds one open story and one finished one. */
  const late = () =>
    board(
      period('PI', '2026-01-01', '2026-03-31', null, 'increment'),
      period('SP1', '2026-01-01', '2026-01-14', 'PI'),
      period('SP2', '2026-01-15', '2026-01-28', 'PI'),
      issue('DONE', 'user_story', null, { period: 'SP1', status: 'done' }),
      issue('OPEN', 'user_story', null, { period: 'SP1' }),
    );

  const columnFor = (nodes: WorkingNodes, key: string, today: string): PeriodColumn =>
    find(buildPeriodBoard(nodes, config, { today, hideArchived: false }).roots[0]!, key);

  it('is late once the end date is past and something is still open', () => {
    const column = columnFor(late(), 'SP1', '2026-01-20');
    expect(column.overdue).toBe(true);
    expect(column.open.map((entry) => entry.id)).toEqual(['OPEN']);
    // Where the "carry it over" button would send the work.
    expect(column.nextId).toBe('SP2');
  });

  it('is not late before its end date, nor when everything in it is finished', () => {
    expect(columnFor(late(), 'SP1', '2026-01-10').overdue).toBe(false);

    const finished = late();
    finished.OPEN = { ...(finished.OPEN as IssueDto), status: 'done' };
    expect(columnFor(finished, 'SP1', '2026-01-20').overdue).toBe(false);
  });

  it('counts open work off the board, so a filter cannot hide an overrun', () => {
    const filtered = buildPeriodBoard(late(), config, {
      today: '2026-01-20',
      search: 'nothing matches this',
      hideArchived: false,
    });
    const sprint = find(filtered.roots[0]!, 'SP1');
    expect(sprint.issues).toEqual([]);
    expect(sprint.overdue).toBe(true);
  });

  it('has nowhere to carry work when it is the last period beside it', () => {
    expect(columnFor(late(), 'SP2', '2026-02-01').nextId).toBeNull();
  });

  it('reports the stance, and where an inherited off came from', () => {
    const nodes = late();
    nodes.PI = { ...(nodes.PI as PeriodDto), active: false };

    const pi = buildPeriodBoard(nodes, config, { today: '2026-01-10', hideArchived: false }).roots[0]!;
    expect(pi.stance).toBe('off');
    expect(pi.switchedOff).toBe(true);
    // The sprint is off too, but its own document says nothing — so the view
    // can explain that the toggle here is not what turned it off.
    expect(find(pi, 'SP1').stance).toBe('off');
    expect(find(pi, 'SP1').switchedOff).toBe(false);
  });

  it('stops calling a switched-off sprint the current one', () => {
    const nodes = late();
    nodes.SP2 = { ...(nodes.SP2 as PeriodDto), active: false };
    const pi = buildPeriodBoard(nodes, config, { today: '2026-01-20', hideArchived: false }).roots[0]!;
    expect(find(pi, 'SP2').current).toBe(false);
    // The quarter is the deepest thing still running, so it takes the badge.
    expect(pi.current).toBe(true);
  });
});

describe('needsFreshDates', () => {
  it('is true when today has fallen outside the period being switched on', () => {
    const sprint = sample().SP1 as PeriodDto;
    expect(needsFreshDates(sprint, '2026-06-01')).toBe(true);
    expect(needsFreshDates(sprint, '2026-01-08')).toBe(false);
  });
});

describe('startNowDates', () => {
  it('moves a period to today and keeps how long it runs', () => {
    // SP1 runs 2026-01-01 .. 2026-01-14: a fortnight.
    expect(startNowDates(sample().SP1 as PeriodDto, '2026-03-02')).toEqual({
      starts: '2026-03-02',
      ends: '2026-03-15',
    });
  });

  it('gives a period with no dates the default length', () => {
    const blank = { ...(sample().SP1 as PeriodDto), starts: undefined, ends: undefined };
    const patch = startNowDates(blank, '2026-03-02');
    expect(patch.starts).toBe('2026-03-02');
    expect(patch.ends).toBe('2026-03-15');
  });
});

describe('nextPeriodDates', () => {
  it('picks up where the last one leaves off, for as long as that one ran', () => {
    const nodes = sample();
    const sprints = [nodes.SP1 as PeriodDto, nodes.SP2 as PeriodDto];
    // SP2 ends 2026-01-28, so the next fortnight starts the day after.
    expect(nextPeriodDates(sprints, '2026-01-20')).toEqual({
      starts: '2026-01-29',
      ends: '2026-02-11',
    });
  });

  it('starts today when there is nothing to follow', () => {
    expect(nextPeriodDates([], '2026-01-20')).toEqual({
      starts: '2026-01-20',
      ends: '2026-02-02',
    });
  });

  it('starts today when the last one is already over', () => {
    const nodes = sample();
    expect(nextPeriodDates([nodes.SP1 as PeriodDto], '2026-05-04').starts).toBe('2026-05-04');
  });

  // The engine refuses a child period that does not fit its parent, so a first
  // sprint that took today would be undrawable-until-pushed and then rejected.
  it('starts on the parent day one when today is not in the parent at all', () => {
    const parent = period('PI5', '2027-01-30', '2027-06-30', null, 'increment');
    expect(nextPeriodDates([], '2026-08-12', parent)).toEqual({
      starts: '2027-01-30',
      ends: '2027-02-12',
    });
  });

  it('clamps the end to the parent rather than running past it', () => {
    const parent = period('PI', '2026-01-01', '2026-01-10', null, 'increment');
    expect(nextPeriodDates([], '2026-01-05', parent)).toEqual({
      starts: '2026-01-05',
      ends: '2026-01-10',
    });
  });

  it('squeezes against the last day when the run has filled the parent', () => {
    const parent = period('PI', '2026-01-01', '2026-01-31', null, 'increment');
    const full = period('SP', '2026-01-18', '2026-01-31', 'PI');
    expect(nextPeriodDates([full], '2026-01-20', parent)).toEqual({
      starts: '2026-01-31',
      ends: '2026-01-31',
    });
  });

  it('follows the siblings when they already sit inside the parent', () => {
    const nodes = sample();
    expect(
      nextPeriodDates(
        [nodes.SP1 as PeriodDto, nodes.SP2 as PeriodDto],
        '2026-01-20',
        nodes.PI as PeriodDto,
      ),
    ).toEqual({ starts: '2026-01-29', ends: '2026-02-11' });
  });

  // A half-dated parent is not a fence: it is exactly what `createPeriod`
  // declines to check, so the two must agree there is no rule to obey.
  it('ignores a parent that has no window of its own', () => {
    const parent = { ...(sample().PI as PeriodDto), starts: undefined, ends: undefined };
    expect(nextPeriodDates([], '2026-01-20', parent)).toEqual({
      starts: '2026-01-20',
      ends: '2026-02-02',
    });
  });
});

describe('planStartNow', () => {
  const nodes = () =>
    board(
      period('PI', '2026-01-01', '2026-01-31', null, 'increment'),
      period('SP1', '2026-01-01', '2026-01-14', 'PI'),
      period('SP2', '2026-01-15', '2026-01-28', 'PI'),
    );

  /** The plan read as `id -> starts..ends`, which is what it is really about. */
  const dated = (nodes: WorkingNodes, id: string, today: string) => {
    const plan = planStartNow(view(nodes), id, today);
    if (!plan.ok) throw new Error(plan.error);
    return {
      plan,
      edits: Object.fromEntries(
        plan.changes.map((change) => [
          change.id,
          change.kind === 'delete'
            ? 'deleted'
            : `${change.patch.starts ?? ''}..${change.patch.ends ?? ''}`,
        ]),
      ),
    };
  };

  it('moves the sprint onto today and closes the one that was running', () => {
    // Today is inside SP1; starting SP2 has to end SP1.
    const { plan, edits } = dated(nodes(), 'SP2', '2026-01-08');
    expect(plan.starts).toBe('2026-01-08');
    expect(plan.ends).toBe('2026-01-21');
    expect(edits.SP2).toBe('2026-01-08..2026-01-21');
    expect(plan.closing.map((entry) => entry.id)).toEqual(['SP1']);
    expect(edits.SP1).toBe('..2026-01-07');
  });

  it('stretches the increment around the new dates', () => {
    // SP2 would now run to 2026-02-07, past the increment's end.
    expect(dated(nodes(), 'SP2', '2026-01-25').edits.PI).toBe('2026-01-01..2026-02-07');
  });

  it('closes nothing when no other period covers today', () => {
    const { plan, edits } = dated(nodes(), 'SP1', '2026-03-02');
    expect(plan.closing).toEqual([]);
    expect(Object.keys(edits).sort()).toEqual(['PI', 'SP1']);
  });

  it('leaves a period that has not started yet alone', () => {
    // SP2 starts after today, so it is not in the way of starting SP1.
    expect(dated(nodes(), 'SP1', '2026-01-10').plan.closing).toEqual([]);
  });

  /**
   * Restarting an increment has to take its sprints with it, or the run is
   * left behind in last quarter — outside the parent that `check` warns about.
   */
  it('shifts the periods inside it by the same number of days', () => {
    const { plan, edits } = dated(nodes(), 'PI', '2026-02-01');
    // The increment moves 31 days, so both sprints move 31 days.
    expect(edits.PI).toBe('2026-02-01..2026-03-03');
    expect(edits.SP1).toBe('2026-02-01..2026-02-14');
    expect(edits.SP2).toBe('2026-02-15..2026-02-28');
    expect(plan.carried.map((entry) => entry.id).sort()).toEqual(['SP1', 'SP2']);
  });

  it('refuses an id that is not a period', () => {
    const plan = planStartNow(view(board(issue('S', 'user_story', null))), 'S', '2026-01-08');
    expect(plan.ok).toBe(false);
  });
});

describe('planResequence', () => {
  /** Three contiguous sprints of different lengths inside one increment. */
  const run = () =>
    board(
      period('PI', '2026-01-01', '2026-03-31', null, 'increment'),
      period('A', '2026-01-01', '2026-01-14', 'PI'),
      period('B', '2026-01-15', '2026-01-21', 'PI'),
      period('C', '2026-01-22', '2026-02-04', 'PI'),
    );

  const dates = (edits: { id: string; patch: { starts?: string; ends?: string } }[]) =>
    Object.fromEntries(edits.map((edit) => [edit.id, `${edit.patch.starts}..${edit.patch.ends}`]));

  it('moves a period into another one’s place, keeping each length', () => {
    // C (a fortnight) goes first; A and B follow, still 14 and 7 days.
    expect(dates(planResequence(run(), 'C', 'A'))).toEqual({
      C: '2026-01-01..2026-01-14',
      A: '2026-01-15..2026-01-28',
      B: '2026-01-29..2026-02-04',
    });
  });

  it('leaves the periods it did not move alone', () => {
    // Swapping the last two only rewrites those two, in their new order.
    expect(Object.keys(dates(planResequence(run(), 'C', 'B')))).toEqual(['C', 'B']);
  });

  it('keeps a gap where the calendar had one', () => {
    const withBreak = board(
      period('PI', '2026-01-01', '2026-03-31', null, 'increment'),
      period('A', '2026-01-01', '2026-01-14', 'PI'),
      // A week off between the sprints.
      period('B', '2026-01-22', '2026-02-04', 'PI'),
    );
    expect(dates(planResequence(withBreak, 'B', 'A'))).toEqual({
      A: '2026-01-22..2026-02-04',
      B: '2026-01-01..2026-01-14',
    });
  });

  it('refuses to reorder across parents, or onto itself', () => {
    const two = board(
      period('P1', '2026-01-01', '2026-01-31', null, 'increment'),
      period('P2', '2026-02-01', '2026-02-28', null, 'increment'),
      period('A', '2026-01-01', '2026-01-14', 'P1'),
      period('B', '2026-02-01', '2026-02-14', 'P2'),
    );
    expect(planResequence(two, 'A', 'B')).toEqual([]);
    expect(planResequence(run(), 'A', 'A')).toEqual([]);
  });

  it('reorders increments too — the top level is a running order as well', () => {
    const two = board(
      period('P1', '2026-01-01', '2026-01-31', null, 'increment'),
      period('P2', '2026-02-01', '2026-03-02', null, 'increment'),
    );
    expect(dates(planResequence(two, 'P2', 'P1'))).toEqual({
      P2: '2026-01-01..2026-01-30',
      P1: '2026-01-31..2026-03-02',
    });
  });
});

describe('columnKeys', () => {
  it('reaches every box, including the ones inside and the backlog', () => {
    const result = buildPeriodBoard(sample(), config);
    expect(columnKeys(result).sort()).toEqual(['PI', 'SP1', 'SP2', '_none']);
  });
});
