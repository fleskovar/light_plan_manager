import { MarkerType, type Edge, type Node } from '@xyflow/svelte';
import type { PeriodDto } from '$shared';
import { relatedTo } from './highlight.js';
import { applyLayout, fitGroups, layoutGraph, placeNewNodes } from './layout.js';
import type { CanvasEdge, CanvasNode, CanvasNodeData } from './model.js';
import { buildGraph } from './model.js';
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
export class CanvasGraph {
  nodes = $state.raw<Node[]>([]);
  edges = $state.raw<Edge[]>([]);

  /** The display the last sync drew, so a change to it can be noticed. */
  #display: string | null = null;

  constructor(private readonly source: GraphSource) {}

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

    return `${members}|${periods}|${this.#displayDigest()}`;
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
    );
    for (const node of placed) {
      if (!saved[node.id]) source.setLayout(node.id, node.position);
    }

    this.#publish(fitGroups(placed), graph.edges);
  }

  /** Lay the whole canvas out again and remember where everything landed. */
  arrange(): void {
    const graph = this.#build();
    // Positions are what arranging replaces. A size someone dragged is not a
    // position, so it survives and the layout works around it.
    const sized = graph.nodes.map((node) => {
      const saved = this.source.layout[node.id];
      return { ...node, width: saved?.width ?? node.width, height: saved?.height ?? node.height };
    });
    const laid = fitGroups(applyLayout(sized, layoutGraph(sized, graph.edges)));
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
    // Children are clipped to their subflow, which is what makes a group read
    // as a container rather than as a node that happens to sit behind others.
    ...(node.parentId ? { parentId: node.parentId, extent: 'parent' as const } : {}),
    zIndex: node.level,
  };
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
