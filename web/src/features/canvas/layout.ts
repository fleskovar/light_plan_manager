import dagre from '@dagrejs/dagre';
import type { CanvasEdge, CanvasNode } from './model.js';
import { GROUP_HEADER, GROUP_PADDING, NODE_HEIGHT, NODE_WIDTH } from './model.js';

/**
 * Arranging the DAG left to right.
 *
 * Dagre lays out a flat graph, but a subflow's children live in their parent's
 * coordinate space, so the layout runs once per level: the deepest groups are
 * measured first, their size is fed to the level above as if they were an
 * ordinary node, and each level's positions come out relative to its container.
 * That is the whole recursion, and it is why an expanded feature pushes its
 * neighbours aside instead of overlapping them.
 *
 * Two rules hold everywhere in here:
 *
 *   - **A group is as big as its contents.** `fitGroups` measures that from the
 *     children's own positions, so a subflow stretches in both directions to
 *     hold whatever is put inside it. A hand-dragged size is a floor, never a
 *     ceiling — nothing may clip a child out of sight.
 *   - **Nothing that already has a place is moved.** Fresh nodes are laid out
 *     among themselves and the block is set down to the right of what is
 *     already there, so importing a story never shuffles the graph someone
 *     spent ten minutes arranging.
 */
/**
 * Room between ranks, between siblings, and between the edges themselves.
 *
 * Generous on purpose: edges are routed orthogonally, so the space between two
 * ranks is where every turn happens. Too little of it and the horizontal runs
 * of a dozen dependencies land on top of each other and on the nodes they pass.
 */
export const RANK_SEPARATION = 150;
export const NODE_SEPARATION = 56;
export const EDGE_SEPARATION = 24;

/** The smallest a node may be dragged to and still say what it is. */
export const MIN_LEAF_WIDTH = 160;
export const MIN_LEAF_HEIGHT = 72;

export interface LayoutResult {
  /** Node id -> position relative to its parent (or the canvas, at the top). */
  positions: Map<string, { x: number; y: number }>;
  /** Group id -> the size it needs to hold its children. */
  sizes: Map<string, { width: number; height: number }>;
}

interface Level {
  parentId: string | null;
  ids: string[];
}

function levelsOf(nodes: CanvasNode[]): Level[] {
  const byParent = new Map<string | null, string[]>();
  for (const node of nodes) {
    const parent = node.parentId ?? null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), node.id]);
  }
  // Deepest first, so a group is measured before the level that contains it.
  return [...byParent.entries()]
    .map(([parentId, ids]) => ({ parentId, ids }))
    .sort((a, b) => depthOf(nodes, b.parentId) - depthOf(nodes, a.parentId));
}

function depthOf(nodes: CanvasNode[], id: string | null): number {
  return id ? (nodes.find((node) => node.id === id)?.level ?? 0) + 1 : 0;
}

/**
 * Edges between siblings. A dependency anywhere inside one sibling's subtree
 * counts as a dependency between the siblings themselves, so the ordering of a
 * collapsed group matches the ordering of its contents.
 */
function siblingEdges(
  ids: string[],
  edges: CanvasEdge[],
  ancestorOf: Map<string, string>,
): [string, string][] {
  const set = new Set(ids);
  const pairs = new Set<string>();
  for (const edge of edges) {
    const source = climbTo(edge.source, set, ancestorOf);
    const target = climbTo(edge.target, set, ancestorOf);
    if (source && target && source !== target) pairs.add(`${source} ${target}`);
  }
  return [...pairs].map((pair) => pair.split(' ') as [string, string]);
}

function climbTo(
  id: string,
  wanted: Set<string>,
  ancestorOf: Map<string, string>,
): string | null {
  let current: string | undefined = id;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    if (wanted.has(current)) return current;
    seen.add(current);
    current = ancestorOf.get(current);
  }
  return null;
}

export function layoutGraph(nodes: CanvasNode[], edges: CanvasEdge[]): LayoutResult {
  const positions = new Map<string, { x: number; y: number }>();
  const sizes = new Map<string, { width: number; height: number }>();
  const ancestorOf = new Map<string, string>();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) if (node.parentId) ancestorOf.set(node.id, node.parentId);

  // A group is measured from its children; anything else brings its own size,
  // which is how a node someone widened keeps its neighbours at arm's length.
  const sizeOf = (id: string): { width: number; height: number } => {
    const measured = sizes.get(id);
    if (measured) return measured;
    const node = byId.get(id);
    return {
      width: node?.width ?? NODE_WIDTH,
      height: node?.height ?? NODE_HEIGHT,
    };
  };

  for (const level of levelsOf(nodes)) {
    const graph = new dagre.graphlib.Graph();
    graph.setGraph({
      rankdir: 'LR',
      ranksep: RANK_SEPARATION,
      nodesep: NODE_SEPARATION,
      edgesep: EDGE_SEPARATION,
    });
    graph.setDefaultEdgeLabel(() => ({}));

    for (const id of level.ids) {
      const { width, height } = sizeOf(id);
      graph.setNode(id, { width, height });
    }
    for (const [source, target] of siblingEdges(level.ids, edges, ancestorOf)) {
      graph.setEdge(source, target);
    }
    dagre.layout(graph);

    // Dagre centres nodes; the canvas positions them by their top-left corner.
    let minX = Infinity;
    let minY = Infinity;
    const raw = new Map<string, { x: number; y: number }>();
    for (const id of level.ids) {
      const laid = graph.node(id) as { x: number; y: number } | undefined;
      const { width, height } = sizeOf(id);
      const x = (laid?.x ?? 0) - width / 2;
      const y = (laid?.y ?? 0) - height / 2;
      raw.set(id, { x, y });
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
    }

    const originX = level.parentId ? GROUP_PADDING : 0;
    const originY = level.parentId ? GROUP_HEADER : 0;
    let maxX = 0;
    let maxY = 0;
    for (const id of level.ids) {
      const { x, y } = raw.get(id)!;
      const { width, height } = sizeOf(id);
      const placed = { x: x - minX + originX, y: y - minY + originY };
      positions.set(id, placed);
      maxX = Math.max(maxX, placed.x + width);
      maxY = Math.max(maxY, placed.y + height);
    }

    if (level.parentId) {
      sizes.set(level.parentId, {
        width: maxX + GROUP_PADDING,
        height: maxY + GROUP_PADDING,
      });
    }
  }

  return { positions, sizes };
}

/** Apply a layout to the graph, returning nodes ready for the canvas. */
export function applyLayout(nodes: CanvasNode[], layout: LayoutResult): CanvasNode[] {
  return nodes.map((node) => {
    const size = layout.sizes.get(node.id);
    return {
      ...node,
      position: layout.positions.get(node.id) ?? node.position,
      width: size?.width ?? node.width,
      height: size?.height ?? node.height,
    };
  });
}

/**
 * Grow every subflow to hold its children, in both directions, and record how
 * small each node may be dragged.
 *
 * `width`/`height` on the way in are what the node would like to be: the size
 * someone dragged it to, or the default. On the way out they are that size or
 * the size its contents demand, whichever is larger — which is what makes a
 * group stretch as issues are added, moved or expanded inside it.
 */
export function fitGroups(nodes: CanvasNode[]): CanvasNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const childrenOf = new Map<string, CanvasNode[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    childrenOf.set(node.parentId, [...(childrenOf.get(node.parentId) ?? []), node]);
  }

  const fitted = new Map<string, { width: number; height: number; minWidth: number; minHeight: number }>();

  const measure = (id: string): { width: number; height: number; minWidth: number; minHeight: number } => {
    const cached = fitted.get(id);
    if (cached) return cached;
    const node = byId.get(id)!;
    const children = childrenOf.get(id) ?? [];

    let size: { width: number; height: number; minWidth: number; minHeight: number };
    if (!children.length) {
      // A leaf may be dragged down to something still readable, no further.
      size = {
        width: node.width,
        height: node.height,
        minWidth: MIN_LEAF_WIDTH,
        minHeight: MIN_LEAF_HEIGHT,
      };
    } else {
      let reachX = 0;
      let reachY = 0;
      for (const child of children) {
        const size = measure(child.id);
        reachX = Math.max(reachX, child.position.x + size.width);
        reachY = Math.max(reachY, child.position.y + size.height);
      }
      const minWidth = reachX + GROUP_PADDING;
      const minHeight = reachY + GROUP_PADDING;
      size = {
        width: Math.max(node.width, minWidth),
        height: Math.max(node.height, minHeight),
        minWidth,
        minHeight,
      };
    }

    fitted.set(id, size);
    return size;
  };

  return nodes.map((node) => ({ ...node, ...measure(node.id) }));
}

/**
 * Give a position to the nodes that have none, leaving every other node exactly
 * where it is.
 *
 * Within each parent, the fresh nodes are arranged among themselves — so a
 * subtree imported in one go arrives already flowing left to right along its
 * dependencies — and the whole block is then set down past the right edge of
 * whatever was already in that parent. Adding to a view is therefore additive
 * on screen too: nothing lands on top of anything, and nothing that was placed
 * by hand moves.
 */
export function placeNewNodes(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  isPlaced: (id: string) => boolean,
): CanvasNode[] {
  const fresh = nodes.filter((node) => !isPlaced(node.id));
  if (!fresh.length) return nodes;

  const arranged = applyLayout(nodes, layoutGraph(nodes, edges));
  const computed = new Map(arranged.map((node) => [node.id, node.position]));

  // How far the settled content reaches, measured with the sizes it really has.
  const settled = fitGroups(nodes.filter((node) => isPlaced(node.id)));
  const reach = new Map<string | null, number>();
  for (const node of settled) {
    const scope = node.parentId ?? null;
    reach.set(scope, Math.max(reach.get(scope) ?? -Infinity, node.position.x + node.width));
  }

  const offsets = new Map<string | null, { dx: number; dy: number }>();
  const scopes = new Set(fresh.map((node) => node.parentId ?? null));
  for (const scope of scopes) {
    const block = fresh.filter((node) => (node.parentId ?? null) === scope);
    const right = reach.get(scope);
    if (right === undefined) {
      // Nothing settled here, so the computed arrangement is the arrangement.
      offsets.set(scope, { dx: 0, dy: 0 });
      continue;
    }
    const minX = Math.min(...block.map((node) => computed.get(node.id)!.x));
    const minY = Math.min(...block.map((node) => computed.get(node.id)!.y));
    offsets.set(scope, {
      dx: right + RANK_SEPARATION - minX,
      dy: (scope ? GROUP_HEADER : 0) - minY,
    });
  }

  return nodes.map((node) => {
    if (isPlaced(node.id)) return node;
    const at = computed.get(node.id) ?? node.position;
    const offset = offsets.get(node.parentId ?? null) ?? { dx: 0, dy: 0 };
    return { ...node, position: { x: at.x + offset.dx, y: at.y + offset.dy } };
  });
}
