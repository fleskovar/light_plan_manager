import { getContext, setContext } from 'svelte';
import { MarkerType, type Edge, type Node } from '@xyflow/svelte';
import type { PeriodDto } from '$shared';
import { relatedTo } from './highlight.js';
import { reshape, type Box } from './reshape.js';
import {
  FRAME_ORIGIN,
  applyLayout,
  fitGroups,
  keepInsideFrames,
  layoutGraph,
  placeNewNodes,
  shiftTopLevel,
} from './layout.js';
import type { CanvasEdge, CanvasNode, CanvasNodeData } from './model.js';
import { NODE_HEIGHT, NODE_WIDTH, buildGraph } from './model.js';
import type { GraphSource } from './source.js';

/**
 * Keeps SvelteFlow's arrays in step with the board behind it.
 *
 * The canvas owns two things the board does not care about — where a node sits
 * and how big it is — so this is where the two meet. A node with no saved
 * position gets one beside the nodes that do have one, which means importing
 * issues or expanding a subflow never dumps everything at the origin and never
 * lands on top of work someone arranged by hand.
 *
 * It talks to a `GraphSource` rather than to the editor's workspace, so the
 * read-only viewer draws the same graph from the same code. Where a position
 * *goes* is the source's business: queued into a view file, or held in memory
 * until the tab closes.
 */
export interface CanvasGraphOptions {
  /**
   * The active item of edit mode, or null to draw the whole view. With an
   * active item, a saved position of a top-level node is relative to that
   * item, which is the same space that read mode uses inside its frame.
   */
  scope?: () => string | null;
}

export class CanvasGraph {
  nodes = $state.raw<Node[]>([]);
  edges = $state.raw<Edge[]>([]);

  /** The display the last sync drew, so a change to it can be noticed. */
  #display: string | null = null;

  readonly #scope: () => string | null;

  constructor(
    private readonly source: GraphSource,
    options: CanvasGraphOptions = {},
  ) {
    this.#scope = options.scope ?? (() => null);
  }

  /** The active item that the graph draws the inside of, or null for the whole view. */
  get scope(): string | null {
    return this.#scope();
  }

  /** Where a layout puts its top-left node: the inside of the frame when scoped. */
  #topOrigin(): { x: number; y: number } {
    return this.scope ? FRAME_ORIGIN : { x: 0, y: 0 };
  }

  /**
   * A cheap description of the *logical* graph; a change here means a rebuild.
   *
   * Hand-dragged sizes are in it but positions are not: a resize has to be
   * followed by a rebuild, because the subflow around the node has to grow to
   * hold it, while a drag only moves the thing that was dragged.
   */
  signature(): string {
    const source = this.source;
    if (!source.ready) return '';
    const members = source.members
      .map((id) => {
        const node = source.nodes[id];
        if (!node) return `${id}:gone`;
        const status = node.kind === 'issue' ? node.status : '';
        const period = node.kind === 'issue' ? (node.period ?? '') : '';
        const deps = node.kind === 'issue' ? node.dependsOn.join('|') : '';
        // A flag is drawn on the node that carries it *and* on whatever node is
        // standing in for it, so raising one has to redraw the graph.
        const flag = node.kind === 'issue' ? (node.flag ?? '') : '';
        // A sync badge is drawn per node and changes when a drift report is
        // re-read, so it has to redraw the graph too.
        const sync = node.kind === 'issue' ? (source.syncBadges?.[id] ?? '') : '';
        const collapsed = source.isCollapsed(id) ? 'c' : '';
        const layout = source.layout[id];
        const size = layout?.width || layout?.height ? `${layout.width}x${layout.height}` : '';
        return `${id}/${node.type}/${node.parentId}/${node.title}/${status}/${period}/${deps}/${flag}/${sync}/${collapsed}/${size}`;
      })
      .join(';');

    // The periods themselves, because the nodes carry their names and dates:
    // renaming a sprint or moving its dates changes what every issue in it
    // says, and so does switching one on or off — that is what "now" means.
    const periods = Object.values(source.nodes)
      .filter((node): node is PeriodDto => node.kind === 'period')
      .map(
        (period) =>
          `${period.id}/${period.title}/${period.starts}/${period.ends}/${period.active ?? ''}`,
      )
      .join(';');

    // And the planning mode, which decides whether any of that is drawn at all.
    // The active item of edit mode decides which members are drawn.
    return `${members}|${periods}|${source.config.planning}|${this.#displayDigest()}|${this.scope ?? ''}`;
  }

  /** Which levels are drawn as badges, in a form two syncs can compare. */
  #displayDigest(): string {
    return Object.entries(this.source.display)
      .filter(([, mode]) => mode === 'badge')
      .map(([type]) => type)
      .sort()
      .join(',');
  }

  #build(): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
    const source = this.source;
    return buildGraph({
      nodes: source.nodes,
      config: source.config,
      members: source.members,
      isCollapsed: (id) => source.isCollapsed(id),
      display: source.display,
      syncBadges: source.syncBadges,
      scope: this.scope,
    });
  }

  /** The saved geometry of a node: where it was left, and how big. */
  #withSavedGeometry(node: CanvasNode): CanvasNode {
    const saved = this.source.layout[node.id];
    if (!saved) return node;
    return {
      ...node,
      position: { x: saved.x, y: saved.y },
      width: saved.width ?? node.width,
      height: saved.height ?? node.height,
    };
  }

  /**
   * Rebuild from the source: everything that has a place keeps it, everything
   * new is set down beside it, and every subflow is grown to hold what is in it.
   */
  sync(): void {
    const source = this.source;
    if (!source.ready) return;
    this.#gesture = null;

    // Badging a level hoists everything under it to a new parent, and a saved
    // position is relative to that parent — so the arrangement is worked out
    // again rather than reinterpreted. Only on a *change*: opening a view whose
    // display and positions were saved together must keep them.
    const display = this.#displayDigest();
    const settled = this.#display !== null && this.#display !== display;
    this.#display = display;
    if (settled) {
      this.arrange();
      return;
    }

    const graph = this.#build();
    const saved = source.layout;

    const placed = placeNewNodes(
      graph.nodes.map((node) => this.#withSavedGeometry(node)),
      graph.edges,
      (id) => saved[id] !== undefined,
      this.#topOrigin(),
    );
    for (const node of placed) {
      if (!saved[node.id]) source.setLayout(node.id, node.position);
    }

    this.#publish(fitGroups(keepInsideFrames(placed)), graph.edges);
  }

  /** Lay the whole canvas out again and remember where everything landed. */
  arrange(): void {
    this.#gesture = null;
    const graph = this.#build();
    // Positions are what arranging replaces. A size someone dragged is not a
    // position, so it survives and the layout works around it.
    const sized = graph.nodes.map((node) => {
      const saved = this.source.layout[node.id];
      return { ...node, width: saved?.width ?? node.width, height: saved?.height ?? node.height };
    });
    const laid = fitGroups(
      shiftTopLevel(applyLayout(sized, layoutGraph(sized, graph.edges)), this.#topOrigin()),
    );
    for (const node of laid) this.source.setLayout(node.id, node.position);
    this.#publish(laid, graph.edges);
  }

  #publish(nodes: CanvasNode[], edges: CanvasEdge[]): void {
    this.nodes = nodes
      .slice()
      .sort((a, b) => a.level - b.level)
      .map((node) => toFlowNode(node, this.source.selection.has(node.id)));
    this.edges = edges.map(toFlowEdge);
    this.refreshHighlights();
  }

  /** Write back positions after a drag. */
  persistPositions(): void {
    for (const node of this.nodes) {
      const saved = this.source.layout[node.id];
      if (saved?.x === node.position.x && saved?.y === node.position.y) continue;
      this.source.setLayout(node.id, node.position);
    }
  }

  // -- Push and grow --------------------------------------------------------

  /**
   * The boxes of the nodes when the current drag or resize started, or null
   * when no gesture is running. `sync` and `arrange` clear it, because the
   * boxes no longer describe the canvas after a rebuild.
   */
  #gesture: Map<string, Box> | null = null;

  /**
   * The positions that the last `reshape` of the gesture gave to the held
   * nodes. At the end of a drag, SvelteFlow writes back the positions that it
   * measured on its last move. Those are relative to the frames before that
   * move grew them, so `endReshape` writes these positions again.
   */
  #heldPositions = new Map<string, { x: number; y: number }>();

  /** Remember the boxes that a plain drag or a resize starts from. */
  beginReshape(): void {
    this.#gesture = new Map(this.nodes.map((node) => [node.id, boxOf(node)]));
    this.#heldPositions = new Map();
  }

  /**
   * A plain drag moved `dragged`. SvelteFlow gives their positions relative to
   * the parents as the canvas draws them now, and a parent can have moved since
   * the drag started. So each position goes through the screen position into
   * the boxes of the start, and `reshape` runs on those boxes.
   */
  reshapeDrag(dragged: readonly Pick<Node, 'id' | 'position'>[]): void {
    const start = this.#gesture;
    if (!start) return;
    const now = new Map(this.nodes.map((node) => [node.id, boxOf(node)]));
    const held = new Map<string, Box>();
    for (const node of dragged) {
      const before = start.get(node.id);
      const current = now.get(node.id);
      if (!before || !current) continue;
      const screen = absoluteOf({ ...current, position: node.position }, now);
      const parent = before.parentId ? start.get(before.parentId) : undefined;
      const origin = parent ? absoluteOf(parent, start) : { x: 0, y: 0 };
      held.set(node.id, {
        ...before,
        position: { x: screen.x - origin.x, y: screen.y - origin.y },
      });
    }
    this.#applyReshape(held);
  }

  /**
   * A resize changed the box of `id`. The resizer of SvelteFlow measures from
   * the box of the start, so `box` already is in the boxes of the start.
   */
  reshapeResize(id: string, box: { x: number; y: number; width: number; height: number }): void {
    const before = this.#gesture?.get(id);
    if (!before) return;
    this.#applyReshape(
      new Map([
        [id, { ...before, position: { x: box.x, y: box.y }, width: box.width, height: box.height }],
      ]),
    );
  }

  /**
   * Run `reshape` on the boxes of the start with the `held` boxes in place,
   * and write the result onto the flow nodes. The nodes inside a held node
   * belong to SvelteFlow during the gesture, so they are not written. A held
   * node is written when its box differs from the flow node. That happens
   * when a parent grew to the left or up, or moved back.
   */
  #applyReshape(held: Map<string, Box>): void {
    const start = this.#gesture;
    if (!start || !held.size) return;
    const boxes = [...start.values()].map((box) => held.get(box.id) ?? box);
    const result = new Map(reshape(boxes, new Set(held.keys())).map((box) => [box.id, box]));
    for (const id of held.keys()) this.#heldPositions.set(id, result.get(id)!.position);

    const insideHeld = (node: Node): boolean => {
      const seen = new Set<string>();
      let parent = node.parentId;
      while (parent && !seen.has(parent)) {
        if (held.has(parent)) return true;
        seen.add(parent);
        parent = start.get(parent)?.parentId;
      }
      return false;
    };

    let changed = false;
    const nodes = this.nodes.map((node) => {
      const box = result.get(node.id);
      if (!box || insideHeld(node)) return node;
      const current = boxOf(node);
      if (
        samePosition(box.position, current.position) &&
        box.width === current.width &&
        box.height === current.height
      ) {
        return node;
      }
      changed = true;
      return { ...node, position: box.position, width: box.width, height: box.height };
    });
    if (changed) this.nodes = nodes;
  }

  /** The gesture ended on the canvas: keep where everything landed. */
  endReshape(): void {
    if (this.#gesture && this.#heldPositions.size) {
      const held = this.#heldPositions;
      this.nodes = this.nodes.map((node) => {
        const position = held.get(node.id);
        return position && !samePosition(position, node.position) ? { ...node, position } : node;
      });
    }
    this.#gesture = null;
    this.#heldPositions = new Map();
    this.persistPositions();
  }

  /** A resize ended: keep the positions, and the size that `id` was given. */
  endResize(id: string, size: { width: number; height: number }): void {
    this.endReshape();
    this.source.setLayout(id, size);
  }

  /** The gesture ended off the canvas: put everything back. */
  cancelReshape(): void {
    this.#gesture = null;
    this.sync();
  }

  /**
   * Keep the children inside their frames for the rest of an Alt drag, or let
   * them out again. SvelteFlow reads the extent of a node on each move of a
   * drag, so the change applies to a drag that has already started.
   */
  clampToParents(clamp: boolean): void {
    this.nodes = this.nodes.map((node) => {
      if (!node.parentId) return node;
      if (clamp) return { ...node, extent: 'parent' as const };
      const { extent: _extent, ...rest } = node;
      return rest;
    });
  }

  /** Mirror the selection onto the canvas without a full rebuild. */
  syncSelection(): void {
    const selection = this.source.selection;
    let changed = false;
    const next = this.nodes.map((node) => {
      const selected = selection.has(node.id);
      if (selected === Boolean(node.selected)) return node;
      changed = true;
      return { ...node, selected };
    });
    if (changed) this.nodes = next;
    this.refreshHighlights();
  }

  /**
   * Light up everything one hop from the selection.
   *
   * Kept out of `sync` so clicking around does not rebuild the graph, and
   * driven by the flow arrays themselves because an edge's selected state lives
   * there — a click on an edge never touches the board's selection.
   */
  refreshHighlights(): void {
    const related = relatedTo(
      this.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })),
      this.source.selection.ids,
      this.edges.filter((edge) => edge.selected).map((edge) => edge.id),
    );
    const anySelection = this.source.selection.size > 0 || related.edges.size > 0;

    let nodesChanged = false;
    const nodes = this.nodes.map((node) => {
      const on = related.nodes.has(node.id);
      if (on === Boolean((node.data as CanvasNodeData).related)) return node;
      nodesChanged = true;
      return { ...node, data: { ...(node.data as CanvasNodeData), related: on } };
    });
    if (nodesChanged) this.nodes = nodes;

    let edgesChanged = false;
    const edges = this.edges.map((edge) => {
      const data = edge.data as EdgeData;
      const on = related.edges.has(edge.id);
      // Everything else fades back, which is what makes a chain readable in a
      // graph that has hundreds of them.
      const faded = anySelection && !on;
      if (on === Boolean(data.related) && faded === Boolean(data.faded)) return edge;
      edgesChanged = true;
      return { ...edge, data: { ...data, related: on, faded } };
    });
    if (edgesChanged) this.edges = edges;
  }
}

/** What `toFlowEdge` puts on an edge, plus the highlight flags. */
interface EdgeData extends Record<string, unknown> {
  related?: boolean;
  faded?: boolean;
}

function toFlowNode(node: CanvasNode, selected: boolean): Node {
  return {
    id: node.id,
    type: node.type,
    position: node.position,
    // The resize floor rides along on the data, because SvelteFlow constructs
    // the node components itself and they cannot be handed props.
    data: { ...node.data, minWidth: node.minWidth, minHeight: node.minHeight },
    width: node.width,
    height: node.height,
    selected,
    // A plain drag can take a child past the edge of its frame, and `reshape`
    // grows the frame around it. An Alt drag adds the extent `parent` for its
    // length (`clampToParents`).
    ...(node.parentId ? { parentId: node.parentId } : {}),
    zIndex: node.level,
  };
}

/** The box of a flow node, with the size the canvas gave it. */
function boxOf(node: Node): Box {
  return {
    id: node.id,
    parentId: node.parentId,
    position: { ...node.position },
    width: node.width ?? node.measured?.width ?? NODE_WIDTH,
    height: node.height ?? node.measured?.height ?? NODE_HEIGHT,
  };
}

/** The position of `box` on the canvas, through each parent in `boxes`. */
function absoluteOf(box: Box, boxes: ReadonlyMap<string, Box>): { x: number; y: number } {
  let { x, y } = box.position;
  const seen = new Set<string>();
  let parent = box.parentId ? boxes.get(box.parentId) : undefined;
  while (parent && !seen.has(parent.id)) {
    seen.add(parent.id);
    x += parent.position.x;
    y += parent.position.y;
    parent = parent.parentId ? boxes.get(parent.parentId) : undefined;
  }
  return { x, y };
}

function samePosition(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return a.x === b.x && a.y === b.y;
}

const CANVAS_GRAPH = Symbol('canvas-graph');

/**
 * Give the node components the graph that draws them. A resize starts inside
 * a node component, and the push and grow of a resize run in the graph.
 */
export function provideCanvasGraph(graph: CanvasGraph): CanvasGraph {
  return setContext(CANVAS_GRAPH, graph);
}

/** The graph that draws this node, or undefined outside a canvas. */
export function useCanvasGraph(): CanvasGraph | undefined {
  return getContext<CanvasGraph | undefined>(CANVAS_GRAPH);
}

function toFlowEdge(edge: CanvasEdge): Edge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: 'dependency',
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
    data: {
      tone: edge.tone,
      animated: edge.animated,
      aggregated: edge.aggregated,
      stalled: edge.stalled,
      from: edge.from,
      to: edge.to,
    },
  };
}
