/**
 * Turning the working board into a graph — composing entry.
 *
 * Four stages, each in `./model/`:
 *
 * - `constants.ts`     node sizing defaults shared with `layout.ts`
 * - `visibleTree.ts`   collapse, badge, and representative resolution
 * - `nodes.ts`         node data payloads and geometry defaults
 * - `edges.ts`         dependency edges with aggregation
 *
 * `buildGraph` composes them.  Types and constants are re-exported so no
 * consumer needs to reach into the folder — `import { buildGraph } from
 * './model.js'` still delivers everything it did before the split.
 */

export { GROUP_HEADER, GROUP_PADDING, NODE_HEIGHT, NODE_WIDTH } from './model/constants.js';
export type {
  LineageBadge,
  VisibleTree,
  GraphInput,
} from './model/visibleTree.js';
export { ancestorIds, memberAncestors, visibleTree } from './model/visibleTree.js';
export type { CanvasNodeData, CanvasNode } from './model/nodes.js';
export { buildNodes } from './model/nodes.js';
export type { CanvasEdge } from './model/edges.js';
export { buildEdges } from './model/edges.js';

import type { CanvasEdge } from './model/edges.js';
import type { CanvasNode } from './model/nodes.js';
import { buildEdges } from './model/edges.js';
import { buildNodes } from './model/nodes.js';
import { visibleTree, type GraphInput } from './model/visibleTree.js';

export interface Graph {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export function buildGraph(input: GraphInput): Graph {
  const tree = visibleTree(input);
  return { nodes: buildNodes(input, tree), edges: buildEdges(input, tree) };
}
