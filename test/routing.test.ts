import { describe, expect, it } from 'vitest';
import { owningSquad, routeWork, type SquadPeriod } from '../src/shared/routing.js';

/**
 * The one definition of "whose queue is this work in?". The engine's
 * `nextTasks` and the web queue panel both adapt to it, so these cases are the
 * rule itself; `test/tasks.test.ts` covers it through the engine.
 */
const alice = { id: 'ALICE', covers: ['QA', 'BOB'] };
const isPool = (id: string): boolean => id === 'QA';

describe('routeWork', () => {
  it('routes work assigned to the resource directly', () => {
    expect(routeWork('ALICE', alice, isPool)).toBe('direct');
  });

  it('routes work parked in a pool the resource covers', () => {
    expect(routeWork('QA', alice, isPool)).toBe('pool');
  });

  it('never routes another person\'s work, even one the resource "covers"', () => {
    expect(routeWork('BOB', alice, isPool)).toBeNull();
  });

  it('routes nothing from a pool the resource does not cover', () => {
    expect(routeWork('QA', { id: 'CAROL', covers: [] }, isPool)).toBeNull();
  });

  it('routes unassigned work only when asked to', () => {
    expect(routeWork(null, alice, isPool)).toBeNull();
    expect(routeWork(null, alice, isPool, true)).toBe('unassigned');
  });
});

describe('owningSquad', () => {
  const periods: Record<string, SquadPeriod> = {
    INC: { id: 'INC', parentId: null, squad: 'SQ' },
    SPRINT: { id: 'SPRINT', parentId: 'INC', squad: null },
    OWN: { id: 'OWN', parentId: 'INC', squad: 'OTHER' },
    FREE: { id: 'FREE', parentId: null, squad: null },
  };
  const get = (id: string): SquadPeriod | undefined => periods[id];

  it('is the squad written on the period, or the nearest one above it', () => {
    expect(owningSquad('INC', get)).toBe('SQ');
    expect(owningSquad('SPRINT', get)).toBe('SQ');
    expect(owningSquad('OWN', get)).toBe('OTHER');
  });

  it('is nobody for a period with no squad anywhere above it, or one that is gone', () => {
    expect(owningSquad('FREE', get)).toBeNull();
    expect(owningSquad('MISSING', get)).toBeNull();
  });

  it('stops on a loop rather than hanging', () => {
    const loop: Record<string, SquadPeriod> = {
      A: { id: 'A', parentId: 'B', squad: null },
      B: { id: 'B', parentId: 'A', squad: null },
    };
    expect(owningSquad('A', (id) => loop[id])).toBeNull();
  });
});
