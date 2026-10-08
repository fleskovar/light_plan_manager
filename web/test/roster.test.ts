import { describe, expect, it } from 'vitest';
import type { ResourceDto } from '$shared';
import { buildRoster, coverageOptions } from '$features/drawer/team/roster.js';
import { atomicConfig, board, config, issue, resource } from './fixtures.js';

/**
 * Two people and a pool: Ana covers the pool, Bo does not, and the work parked
 * in the pool is counted against the pool and shown against whoever covers it.
 */
const sample = () =>
  board(
    resource('ANA', 'person', { title: 'Ana', capacity: 8, covers: ['POOL'] }),
    resource('BO', 'person', { title: 'Bo', capacity: 8 }),
    resource('POOL', 'role', { title: 'Backend', capacity: 2 }),
    issue('P', 'program', null),
    issue('S1', 'user_story', 'P', { assignee: 'ANA', attributes: { story_points: 3 } }),
    issue('S2', 'user_story', 'P', { assignee: 'POOL', attributes: { story_points: 5 } }),
  );

const entry = (id: string) => buildRoster(sample(), config).find((one) => one.resource.id === id)!;

describe('buildRoster', () => {
  it('resolves the pools a resource covers, for the card to name them', () => {
    expect(entry('ANA').covers.map((pool) => pool.title)).toEqual(['Backend']);
    expect(entry('BO').covers).toEqual([]);
  });

  it('keeps direct load and pool load apart', () => {
    expect([entry('ANA').load, entry('ANA').poolLoad]).toEqual([3, 5]);
    expect([entry('POOL').load, entry('POOL').poolLoad]).toEqual([5, 0]);
  });

  it('derives who covers a pool from the documents that say so', () => {
    expect(entry('POOL').coveredBy.map((one) => one.id)).toEqual(['ANA']);
  });

  it('counts an atomic story once, and not the sub-tasks inside it', () => {
    const nodes = board(
      resource('ANA', 'person', { title: 'Ana', capacity: 8 }),
      issue('P', 'program', null),
      issue('S1', 'user_story', 'P', { assignee: 'ANA', attributes: { story_points: 5 } }),
      issue('T1', 'sub_task', 'S1', { assignee: 'ANA' }),
      issue('T2', 'sub_task', 'S1', { assignee: 'ANA' }),
    );

    // Leaf-only, the story's 5 points go uncounted and the sub-tasks are two
    // open items; taken whole, the story is one item carrying its own estimate.
    const leafOnly = buildRoster(nodes, config).find((one) => one.resource.id === 'ANA')!;
    expect([leafOnly.assigned, leafOnly.load]).toEqual([2, 0]);

    const whole = buildRoster(nodes, atomicConfig('user_story')).find(
      (one) => one.resource.id === 'ANA',
    )!;
    expect([whole.assigned, whole.load]).toEqual([1, 5]);
  });
});

describe('coverageOptions', () => {
  it('offers a person the pools, and a pool the people', () => {
    const nodes = sample();
    const ana = coverageOptions(nodes, nodes.ANA as ResourceDto);
    expect(ana.pools.map((pool) => pool.id)).toEqual(['POOL']);
    expect(ana.coverers).toEqual([]);

    const pool = coverageOptions(nodes, nodes.POOL as ResourceDto);
    expect(pool.coverers.map((one) => one.id)).toEqual(['ANA', 'BO']);
    expect(pool.pools).toEqual([]);
  });

  it('never offers a resource itself', () => {
    const nodes = board(resource('P1', 'role'), resource('P2', 'role'));
    expect(coverageOptions(nodes, nodes.P1 as ResourceDto).coverers).toEqual([]);
  });
});
