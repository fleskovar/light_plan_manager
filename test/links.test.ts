import { describe, expect, it } from 'vitest';
import type { Issue } from '../src/core/index.js';
import { findDependencyCycles, formatCycle, wouldCycle } from '../src/core/index.js';

/** The graph functions read `id` and the one gating edge. */
function issue(id: string, dependsOn: string[] = []): Issue {
  return { id, depends_on: dependsOn } as Issue;
}

const keys = (cycles: string[][]): string[] => cycles.map(formatCycle).sort();

describe('findDependencyCycles', () => {
  it('finds nothing in a DAG', () => {
    const issues = [
      issue('A', ['B', 'C']),
      issue('B', ['D']),
      issue('C', ['D']),
      issue('D'),
    ];
    expect(findDependencyCycles(issues)).toEqual([]);
  });

  it('finds a two-node cycle', () => {
    const cycles = findDependencyCycles([issue('A', ['B']), issue('B', ['A'])]);
    expect(cycles).toHaveLength(1);
    expect(formatCycle(cycles[0]!)).toBe('A -> B -> A');
  });

  it('finds a longer cycle', () => {
    const cycles = findDependencyCycles([
      issue('A', ['B']),
      issue('B', ['C']),
      issue('C', ['A']),
    ]);
    expect(keys(cycles)).toEqual(['A -> B -> C -> A']);
  });

  it('reports each cycle once, not once per entry point', () => {
    // Both E and F lead into the same A->B->A cycle.
    const cycles = findDependencyCycles([
      issue('E', ['A']),
      issue('F', ['B']),
      issue('A', ['B']),
      issue('B', ['A']),
    ]);
    expect(cycles).toHaveLength(1);
  });

  it('finds two independent cycles', () => {
    const cycles = findDependencyCycles([
      issue('A', ['B']),
      issue('B', ['A']),
      issue('C', ['D']),
      issue('D', ['C']),
    ]);
    expect(keys(cycles)).toEqual(['A -> B -> A', 'C -> D -> C']);
  });

  it('ignores references to ids that do not exist', () => {
    expect(findDependencyCycles([issue('A', ['GHOST'])])).toEqual([]);
  });

  it('does not treat a self-reference as a cycle (checkBoard reports it directly)', () => {
    expect(findDependencyCycles([issue('A', ['A'])])).toEqual([]);
  });

  it('handles a diamond without reporting a cycle', () => {
    const issues = [issue('A', ['B', 'C']), issue('B', ['D']), issue('C', ['D']), issue('D')];
    expect(findDependencyCycles(issues)).toEqual([]);
  });
});

describe('wouldCycle', () => {
  const issues = [issue('A', ['B']), issue('B', ['C']), issue('C'), issue('D')];

  it('allows an edge that keeps the graph acyclic', () => {
    expect(wouldCycle(issues, 'D', 'A')).toBeNull();
    expect(wouldCycle(issues, 'A', 'D')).toBeNull();
  });

  it('rejects an edge that closes a cycle', () => {
    const cycle = wouldCycle(issues, 'C', 'A');
    expect(cycle).not.toBeNull();
    expect(formatCycle(cycle!)).toBe('C -> A -> B -> C');
  });

  it('rejects a self edge', () => {
    expect(wouldCycle(issues, 'A', 'A')).toEqual(['A']);
  });
});
