import type { StatusTone } from '$lib/board/selectors.js';
import { statusTone } from '$lib/board/selectors.js';
import type { GraphInput, VisibleTree } from './visibleTree.js';

/**
 * Turning the visible tree into dependency edges.
 *
 * Every `depends_on` edge that survives collapsing is drawn once between the
 * two visible nodes that stand for the two ends.  Multiple edges between the
 * same pair are collapsed into one `aggregated` edge so the graph stays
 * readable even when a feature has a dozen stories all blocking the same next
 * step.
 */

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  /** True when either end is in progress: the edge animates. */
  animated: boolean;
  tone: StatusTone;
  /** The dependency this edge stands for, before any collapsing. */
  from: string;
  to: string;
  /** The edge is a stand-in for one or more edges hidden inside a subflow. */
  aggregated: boolean;
  /**
   * The work at the *blocker* end has stopped: somebody flagged it.
   *
   * Drawn red whatever is selected, because "which part of this graph is stuck
   * behind a flag?" is the question a plan owner arrives with, and answering it
   * only after they have clicked the right node answers it too late. The flag
   * itself is already red on the node; this carries the same fact along every
   * edge leaving it, so the reach of one stalled issue is visible at a glance.
   *
   * It follows the dependency rather than the drawn node, so an edge is stalled
   * when *any* of the dependencies it stands for comes from a flagged issue —
   * an aggregated edge out of a collapsed feature included. Folding a level may
   * hide detail; it may never hide that work inside has stopped.
   */
  stalled: boolean;
}

export function buildEdges(input: GraphInput, tree: VisibleTree): CanvasEdge[] {
  const byId = new Map<string, CanvasEdge>();

  for (const node of Object.values(input.nodes)) {
    if (node.kind !== 'issue') continue;
    for (const blockerId of node.dependsOn) {
      const target = tree.representative.get(node.id);
      const source = tree.representative.get(blockerId);
      if (!target || !source || source === target) continue;

      const id = `${source}->${target}`;
      const aggregated = source !== blockerId || target !== node.id;
      const blocker = input.nodes[blockerId];
      const stalled = blocker?.kind === 'issue' && Boolean(blocker.flag);

      const existing = byId.get(id);
      if (existing) {
        existing.aggregated = true;
        // One flagged blocker among several is still a flagged blocker: the
        // work behind this line has stopped, whichever dependency stopped it.
        existing.stalled ||= stalled;
        continue;
      }

      const tone = statusTone(input.config, node.status);
      byId.set(id, {
        id,
        source,
        target,
        from: blockerId,
        to: node.id,
        aggregated,
        stalled,
        tone,
        animated:
          tone === 'active' ||
          (blocker?.kind === 'issue' && statusTone(input.config, blocker.status) === 'active'),
      });
    }
  }

  return [...byId.values()];
}
