import { describe, expect, it } from 'vitest';
import type { PeriodDto } from '$shared';
import { currentPeriodIds, holdsDate, periodChain, placementOf } from '$lib/board/periods.js';
import { buildGraph } from '$features/canvas/model.js';
import { board, config, issue, period } from './fixtures.js';

/**
 * A quarter with three sprints, the middle one running today.
 *
 *   PI            2026-01-01 .. 2026-03-31
 *     Sprint 1    2026-01-01 .. 2026-01-14
 *     Sprint 2    2026-01-15 .. 2026-01-28   <- today is 2026-01-20
 *     Sprint 3    2026-01-29 .. 2026-02-11
 */
const TODAY = '2026-01-20';

const sample = () =>
  board(
    period('PI', '2026-01-01', '2026-03-31', null, 'increment'),
    period('SP1', '2026-01-01', '2026-01-14', 'PI'),
    period('SP2', '2026-01-15', '2026-01-28', 'PI'),
    period('SP3', '2026-01-29', '2026-02-11', 'PI'),
    issue('P', 'program', null),
    issue('E', 'epic', 'P', { period: 'PI' }),
    issue('NOW', 'user_story', 'E', { period: 'SP2' }),
    issue('NEXT', 'user_story', 'E', { period: 'SP3' }),
    issue('LOOSE', 'user_story', 'E'),
  );

describe('periodChain', () => {
  it('reads outermost first, so a badge says which increment a sprint is in', () => {
    expect(periodChain(sample(), 'SP2').map((entry) => entry.id)).toEqual(['PI', 'SP2']);
  });

  it('is empty for an issue that names no period, or names one that is gone', () => {
    expect(periodChain(sample(), null)).toEqual([]);
    expect(periodChain(sample(), 'TL-404')).toEqual([]);
  });

  it('does not loop on a period that is its own ancestor', () => {
    const tangled = board(
      period('A', '2026-01-01', '2026-01-31', 'B', 'increment'),
      period('B', '2026-02-01', '2026-02-28', 'A', 'increment'),
    );
    expect(periodChain(tangled, 'A').map((entry) => entry.id)).toEqual(['B', 'A']);
  });
});

describe('holdsDate', () => {
  const sprint = period('SP', '2026-01-15', '2026-01-28');

  it('covers both ends of the range', () => {
    expect(holdsDate(sprint, '2026-01-15')).toBe(true);
    expect(holdsDate(sprint, '2026-01-28')).toBe(true);
    expect(holdsDate(sprint, '2026-01-14')).toBe(false);
    expect(holdsDate(sprint, '2026-01-29')).toBe(false);
  });

  it('treats a period with no end as still running', () => {
    expect(holdsDate({ ...sprint, ends: undefined }, '2027-01-01')).toBe(true);
  });

  it('is never running without a start date', () => {
    expect(holdsDate({ ...sprint, starts: undefined }, '2026-01-20')).toBe(false);
  });
});

describe('currentPeriodIds', () => {
  it('is the innermost period running today, not the quarter around it', () => {
    expect([...currentPeriodIds(sample(), TODAY)]).toEqual(['SP2']);
  });

  it('falls back to the increment when no sprint covers today', () => {
    // Between sprints: the quarter is the deepest thing still running.
    const gapped = board(
      period('PI', '2026-01-01', '2026-03-31', null, 'increment'),
      period('SP1', '2026-01-01', '2026-01-14', 'PI'),
    );
    expect([...currentPeriodIds(gapped, '2026-02-20')]).toEqual(['PI']);
  });

  it('takes both when two sprints overlap today', () => {
    const overlapping = board(
      period('A', '2026-01-15', '2026-01-28'),
      period('B', '2026-01-19', '2026-02-01'),
    );
    expect([...currentPeriodIds(overlapping, TODAY)].sort()).toEqual(['A', 'B']);
  });

  it('is empty when nothing is scheduled around today', () => {
    expect(currentPeriodIds(sample(), '2030-01-01').size).toBe(0);
  });

  /**
   * The switch, mirrored from the engine. The canvas and `lpm task next` must
   * not disagree about what is now, so these are the same cases as
   * `periodStance` in `test/periods.test.ts`.
   */
  describe('when a period is switched on or off', () => {
    const withSwitch = (id: string, active: boolean) => {
      const nodes = sample();
      nodes[id] = { ...(nodes[id] as PeriodDto), active };
      return nodes;
    };

    it('runs a sprint switched on, whatever the calendar says', () => {
      expect([...currentPeriodIds(withSwitch('SP3', true), TODAY)].sort()).toEqual(['SP2', 'SP3']);
    });

    it('stops running one that is switched off', () => {
      // SP2 is off, so nothing inside the quarter is running and the quarter
      // itself steps forward.
      expect([...currentPeriodIds(withSwitch('SP2', false), TODAY)]).toEqual(['PI']);
    });

    it('parks every sprint inside an increment that is switched off', () => {
      expect(currentPeriodIds(withSwitch('PI', false), TODAY).size).toBe(0);
    });

    /**
     * "Innermost wins" is about one chain, not about the deepest period on the
     * board: a sprint running in one increment says nothing about another
     * increment somebody switched on by hand.
     */
    it('keeps an increment switched on even while a sprint runs elsewhere', () => {
      const nodes = sample();
      nodes.PI2 = { ...period('PI2', '2026-04-01', '2026-06-30', null, 'increment'), active: true };
      expect([...currentPeriodIds(nodes, TODAY)].sort()).toEqual(['PI2', 'SP2']);
    });
  });
});

describe('placementOf', () => {
  const nodes = sample();
  const current = currentPeriodIds(nodes, TODAY);

  it('gives the chain of titles and marks the running sprint', () => {
    expect(placementOf(nodes, nodes.NOW!, current)).toEqual({ chain: ['PI', 'SP2'], current: true });
  });

  it('marks the next sprint as scheduled but not running', () => {
    expect(placementOf(nodes, nodes.NEXT!, current)).toEqual({
      chain: ['PI', 'SP3'],
      current: false,
    });
  });

  it('does not call an issue on the increment current while a sprint is running', () => {
    expect(placementOf(nodes, nodes.E!, current)).toEqual({ chain: ['PI'], current: false });
  });

  it('is nothing at all for an unscheduled issue', () => {
    expect(placementOf(nodes, nodes.LOOSE!, current)).toBeNull();
  });
});

describe('the schedule a canvas node carries', () => {
  const scheduleOf = (today: string): Map<string, unknown> =>
    new Map(
      buildGraph({
        nodes: sample(),
        config,
        members: ['E', 'NOW', 'NEXT', 'LOOSE'],
        isCollapsed: () => false,
        today,
      }).nodes.map((node) => [node.id, node.data.schedule]),
    );

  it('is on every node the graph draws', () => {
    const schedules = scheduleOf(TODAY);
    expect(schedules.get('NOW')).toEqual({ chain: ['PI', 'SP2'], current: true });
    expect(schedules.get('NEXT')).toEqual({ chain: ['PI', 'SP3'], current: false });
    expect(schedules.get('LOOSE')).toBeNull();
  });

  it('follows the calendar: the same board reads differently a fortnight on', () => {
    const later = scheduleOf('2026-02-02');
    expect(later.get('NOW')).toMatchObject({ current: false });
    expect(later.get('NEXT')).toMatchObject({ current: true });
  });
});
