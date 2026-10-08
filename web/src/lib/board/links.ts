import type { ConfigDto, NodeKind } from '$shared';
import { nodesOfKind, rolledUpNeighbours } from './selectors.js';
import type { WorkingNodes } from './working.js';

/**
 * The two graph questions this app asks that the shared planners do not.
 *
 * `wouldCycle` and `typeAtDepth` used to live here as well; they moved to
 * `$shared/plans` when the CLI and the MCP server started needing the same
 * answers. Import them from there.
 */

/** Types a new child of a document at `parentDepth` may take. */
export function childTypes(config: ConfigDto, kind: NodeKind, parentDepth: number): string[] {
  return config.hierarchy[kind][parentDepth + 1] ?? [];
}

/** Both directions of the dependency graph one hop out from `id`. */
export interface Neighbours {
  /** What it declares it waits on. */
  upstream: string[];
  /** What declares it waits on this. */
  downstream: string[];
  /**
   * Containers this one stands behind because of the work inside them both,
   * and the same read the other way. Reflected off the graph, never written on
   * a document — @see src/shared/dependency-rollup.ts. Always empty for a
   * registry template: the reflection is a reading of the issue tree.
   */
  rolledUpUpstream: string[];
  rolledUpDownstream: string[];
}

/** Issues that must finish before `id` can start, and those waiting on it. */
export function neighbours(nodes: WorkingNodes, id: string): Neighbours {
  const node = nodes[id];
  // Templates carry the same edge as issues, one level removed, so the panel
  // answers "what waits on this?" in the registry too. The two never mix: a
  // template's dependencies name templates and an issue's name issues.
  const gated = node?.kind === 'template' ? 'template' : 'issue';
  const upstream = node && 'dependsOn' in node ? node.dependsOn : [];
  const downstream = nodesOfKind(nodes, gated)
    .filter((other) => 'dependsOn' in other && other.dependsOn.includes(id))
    .map((other) => other.id);
  const rolled =
    gated === 'issue'
      ? rolledUpNeighbours(nodes, id)
      : { blockedBy: [] as string[], blocks: [] as string[] };
  return {
    upstream,
    downstream,
    rolledUpUpstream: rolled.blockedBy,
    rolledUpDownstream: rolled.blocks,
  };
}
