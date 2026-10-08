import type { IssueDto } from '$shared';
import { nodesOfKind } from '$lib/board/selectors.js';
import type { WorkingNodes } from '$lib/board/working.js';
import type { NodeIndex } from '$lib/board/index.js';

/**
 * The subtree-membership state for every node with children, computed in one
 * bottom-up pass over the issue tree — O(n) where n is the number of issues.
 *
 * The previous per-row `subtreeIds(id).filter(members.has)` was ~O(n·depth):
 * every parent row walked its whole subtree again, and the walk happened on
 * every `rows` or `members` change. Now each child reports its counts to its
 * parent exactly once.
 *
 * Returns a map from issue id to `'none' | 'some' | 'all'`, only for issues
 * that actually have children (totalCount > 1). Leaves are omitted — the table
 * already hides the checkbox for them.
 */
export function computeSubtreeMembership(
  nodes: WorkingNodes,
  members: ReadonlySet<string>,
  index: NodeIndex,
): Map<string, 'none' | 'some' | 'all'> {
  const issues = nodesOfKind(nodes, 'issue');

  // Post-order: deepest first, so by the time a parent is reached all its
  // children have already been counted.
  const sorted = [...issues].sort((a, b) => b.depth - a.depth);

  // Accumulator: memberCount and totalCount for every issue id.
  const counts = new Map<string, { member: number; total: number }>();

  for (const issue of sorted) {
    const self = members.has(issue.id) ? 1 : 0;
    let member = self;
    let total = 1;

    for (const child of index.childrenOf(issue.id)) {
      const childCounts = counts.get(child.id);
      if (!childCounts) continue;
      member += childCounts.member;
      total += childCounts.total;
    }

    counts.set(issue.id, { member, total });
  }

  // Only return entries that matter: those with children.
  const result = new Map<string, 'none' | 'some' | 'all'>();
  for (const [id, count] of counts) {
    if (count.total > 1) {
      result.set(
        id,
        count.member === 0 ? 'none' : count.member === count.total ? 'all' : 'some',
      );
    }
  }

  return result;
}
