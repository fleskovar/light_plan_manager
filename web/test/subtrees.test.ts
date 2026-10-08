import { describe, expect, it } from 'vitest';
import type { IssueDto } from '$shared';
import { buildIndex } from '$lib/board/index.js';
import type { WorkingNodes } from '$lib/board/working.js';
import { computeSubtreeMembership } from '$features/drawer/table/subtrees.js';

/** A minimal issue for test trees. */
function issue(
  id: string,
  parentId: string | null,
  depth: number,
  overrides: Partial<IssueDto> = {},
): IssueDto {
  return {
    id,
    kind: 'issue' as const,
    type: 'task',
    title: id,
    body: '',
    parentId,
    depth,
    attributes: {},
    status: 'backlog',
    assignee: null,
    period: null,
    flag: null,
    dependsOn: [],
    relatesTo: [],
    relatedFiles: [],
    ...overrides,
  };
}

describe('computeSubtreeMembership', () => {
  it('returns empty for a tree with no parents', () => {
    const nodes: WorkingNodes = {
      'LP-1': issue('LP-1', null, 0),
      'LP-2': issue('LP-2', null, 0),
      'LP-3': issue('LP-3', null, 0),
    };
    const index = buildIndex(nodes);
    const members = new Set<string>();
    expect(computeSubtreeMembership(nodes, members, index)).toEqual(new Map());
  });

  it('returns all-none when no members are set', () => {
    const nodes: WorkingNodes = {
      'A': issue('A', null, 0),
      'B': issue('B', 'A', 1),
      'C': issue('C', 'A', 1),
    };
    const index = buildIndex(nodes);
    const members = new Set<string>();
    const result = computeSubtreeMembership(nodes, members, index);
    expect(result.get('A')).toBe('none');
    expect(result.has('B')).toBe(false); // leaf
    expect(result.has('C')).toBe(false); // leaf
  });

  it('returns all-all when every descendant is a member', () => {
    const nodes: WorkingNodes = {
      'A': issue('A', null, 0),
      'B': issue('B', 'A', 1),
      'C': issue('C', 'A', 1),
    };
    const index = buildIndex(nodes);
    const members = new Set(['A', 'B', 'C']);
    const result = computeSubtreeMembership(nodes, members, index);
    expect(result.get('A')).toBe('all');
  });

  it('returns some when only a subset are members', () => {
    const nodes: WorkingNodes = {
      'A': issue('A', null, 0),
      'B': issue('B', 'A', 1),
      'C': issue('C', 'A', 1),
    };
    const index = buildIndex(nodes);
    const members = new Set(['A', 'B']); // C missing
    const result = computeSubtreeMembership(nodes, members, index);
    expect(result.get('A')).toBe('some');
  });

  it('handles nested depth-3 trees', () => {
    const nodes: WorkingNodes = {
      'R': issue('R', null, 0),
      'P': issue('P', 'R', 1),
      'L1': issue('L1', 'P', 2),
      'L2': issue('L2', 'P', 2),
      'L3': issue('L3', 'P', 2),
    };
    const index = buildIndex(nodes);
    // R is not a member, P and L1+L2 are, L3 is not
    const members = new Set(['P', 'L1', 'L2']);
    const result = computeSubtreeMembership(nodes, members, index);

    // P: 3 children, 2 are members = some
    expect(result.get('P')).toBe('some');
    // R: P(3/4 some) + self(0) = some
    expect(result.get('R')).toBe('some');
  });

  it('omits leaves from the result', () => {
    const nodes: WorkingNodes = {
      'A': issue('A', null, 0),
      'B': issue('B', 'A', 1),
    };
    const index = buildIndex(nodes);
    const members = new Set(['A', 'B']);
    const result = computeSubtreeMembership(nodes, members, index);
    expect(result.has('A')).toBe(true); // parent
    expect(result.has('B')).toBe(false); // leaf
    expect(result.size).toBe(1);
  });

  it('handles a deep chain where only the leaf is a member', () => {
    const nodes: WorkingNodes = {
      'G': issue('G', null, 0),
      'E': issue('E', 'G', 1),
      'F': issue('F', 'E', 2),
      'S': issue('S', 'F', 3),
    };
    const index = buildIndex(nodes);
    const members = new Set(['S']); // only deepest leaf
    const result = computeSubtreeMembership(nodes, members, index);

    expect(result.get('S')).toBe(undefined); // leaf
    expect(result.get('F')).toBe('some'); // 1 of 1 = all… wait, F has child S which IS a member
    // Actually: F has 1 child S, S is member. F self is not. So member=1, total=2 → some
    // E has 1 child F, F's subtree has member=1, total=2. E self not member. member=1, total=3 → some
    // G has 1 child E, E's subtree member=1, total=3. G self not member. member=1, total=4 → some

    // Let me fix: F's branch: S(member=1,total=1) → F(self=0, child member=1, child total=1) → member=1, total=2 → some ✓
    // E: F(member=1,total=2) → E(self=0) → member=1, total=3 → some ✓
    // G: E(member=1,total=3) → G(self=0) → member=1, total=4 → some ✓
    expect(result.get('G')).toBe('some');
    expect(result.get('E')).toBe('some');
    expect(result.get('F')).toBe('some');
  });

  it('handles multiple independent branches', () => {
    const nodes: WorkingNodes = {
      'R1': issue('R1', null, 0),
      'C1': issue('C1', 'R1', 1),
      'C2': issue('C2', 'R1', 1),
      'R2': issue('R2', null, 0),
      'D1': issue('D1', 'R2', 1),
    };
    const index = buildIndex(nodes);
    // R1 branch: fully in. R2 branch: none in.
    const members = new Set(['R1', 'C1', 'C2']);
    const result = computeSubtreeMembership(nodes, members, index);

    expect(result.get('R1')).toBe('all');
    expect(result.get('R2')).toBe('none');
  });
});
