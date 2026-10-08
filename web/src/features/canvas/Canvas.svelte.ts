/**
 * Decision logic extracted from Canvas.svelte: hit-testing, drag/carry/drop
 * interpretation, reparent resolution, and roster drop handling.
 *
 * The component keeps the reactive state, the SvelteFlow event wiring, the
 * template, and the CSS. What lives here is the part that decides what an event
 * means — the same family as `carry.ts`, `pan.ts` and `menus.ts`.
 */

import type { Edge, Node } from '@xyflow/svelte';
import type { Workspace } from '$lib/workspace/workspace.svelte.js';
import type { Shell } from '$lib/app/shell.svelte.js';
import {
  assignSelection,
  reparent,
  reparentChoices,
  scheduleSelection,
  spliceOntoEdge,
} from '$lib/workspace/mutations.js';
import { periodDropAt } from '$features/drawer/periods/periods.js';
import { carriedIds, type CarryHandlers } from './carry.js';
import type { CanvasGraph } from './graph.svelte.js';

// ---------------------------------------------------------------------------
// Hit-testing
// ---------------------------------------------------------------------------

/** The coordinate transform the canvas uses for pointer → graph positions. */
type ScreenToFlow = (screen: { x: number; y: number }) => { x: number; y: number };

/**
 * Resolve a node's absolute position by walking up through its parent subflows.
 * A node inside a group reports coordinates relative to that group, but the
 * pointer is in screen space — this bridges the two.
 */
export function absolutePosition(
  node: { position: { x: number; y: number }; parentId?: string },
  graphNodes: { id: string; position: { x: number; y: number }; parentId?: string }[],
): { x: number; y: number } {
  let { x, y } = node.position;
  let parentId = node.parentId;
  const seen = new Set<string>();
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = graphNodes.find((entry) => entry.id === parentId);
    if (!parent) break;
    x += parent.position.x;
    y += parent.position.y;
    parentId = parent.parentId;
  }
  return { x, y };
}

/**
 * The topmost node under the pointer, ignoring the ones being dragged.
 * `screenToFlow` is `flow.screenToFlowPosition` — passed rather than importing
 * the flow instance so this stays a pure function.
 */
export function nodeUnder(
  graphNodes: Node[],
  screenToFlow: ScreenToFlow,
  event: MouseEvent,
  exclude: Set<string>,
): Node | null {
  const point = screenToFlow({ x: event.clientX, y: event.clientY });
  const hits = graphNodes.filter((node) => {
    if (exclude.has(node.id)) return false;
    const origin = absolutePosition(node, graphNodes);
    return (
      point.x >= origin.x &&
      point.x <= origin.x + (node.width ?? 0) &&
      point.y >= origin.y &&
      point.y <= origin.y + (node.height ?? 0)
    );
  });
  return hits.at(-1) ?? null;
}

/**
 * The edge whose midpoint is nearest the pointer, within a small radius.
 * Only the closest one is returned — a pointer can only mean one edge.
 */
export function edgeUnder(
  graphNodes: Node[],
  graphEdges: Edge[],
  screenToFlow: ScreenToFlow,
  event: MouseEvent,
  exclude: Set<string>,
): Edge | null {
  const point = screenToFlow({ x: event.clientX, y: event.clientY });
  let best: { edge: Edge; distance: number } | null = null;
  for (const edge of graphEdges) {
    if (exclude.has(edge.source) || exclude.has(edge.target)) continue;
    const source = graphNodes.find((node) => node.id === edge.source);
    const target = graphNodes.find((node) => node.id === edge.target);
    if (!source || !target) continue;
    const a = absolutePosition(source, graphNodes);
    const b = absolutePosition(target, graphNodes);
    const midpoint = {
      x: (a.x + (source.width ?? 0) + b.x) / 2,
      y: (a.y + (source.height ?? 0) / 2 + b.y + (target.height ?? 0) / 2) / 2,
    };
    const distance = Math.hypot(midpoint.x - point.x, midpoint.y - point.y);
    if (distance < 90 && (!best || distance < best.distance)) best = { edge, distance };
  }
  return best?.edge ?? null;
}

/** Is the pointer still over the graph, rather than over the drawer or a panel? */
export function overCanvas(event: MouseEvent): boolean {
  const element = document.elementFromPoint(event.clientX, event.clientY);
  return Boolean(element?.closest('.canvas'));
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** Update a selection from a mouse event: toggle with Shift/Ctrl/Cmd, set otherwise. */
export function selectFromEvent(
  selection: { set(ids: string[]): void; toggle(id: string): void },
  id: string,
  event: MouseEvent,
): void {
  if (event.shiftKey || event.ctrlKey || event.metaKey) selection.toggle(id);
  else selection.set([id]);
}

// ---------------------------------------------------------------------------
// Double-click
// ---------------------------------------------------------------------------

/**
 * Tiny state machine for double-click detection.
 *
 * Two clicks on the same node within 300 ms → double-click; anything else is
 * a single click. The 300 ms window is long enough for a deliberate double-click
 * and short enough to not feel laggy.
 */
export function createDoubleClickHandler(): {
  handle(id: string, onDouble: () => void): void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let target: string | null = null;

  function handle(id: string, onDouble: () => void): void {
    if (timer && target === id) {
      clearTimeout(timer);
      timer = null;
      target = null;
      onDouble();
      return;
    }
    target = id;
    timer = setTimeout(() => {
      timer = null;
      target = null;
    }, 300);
  }

  return { handle };
}

// ---------------------------------------------------------------------------
// Carry
// ---------------------------------------------------------------------------

/** State the carry handlers need to update in the component. */
export interface CarryUI {
  setCarrying(v: boolean): void;
  setPeriodDropTarget(key: string | null): void;
}

/**
 * Build the carry handlers that connect the capture-phase `carry.ts` gesture
 * to the board. `carry.ts` owns the pointer tracking; these own what the three
 * events (pick, move, drop) *mean*.
 */
export function createCarryHandlers(
  workspace: Workspace,
  shell: Shell,
  ui: CarryUI,
  graph: CanvasGraph,
  screenToFlow: ScreenToFlow,
): CarryHandlers {
  return {
    pick: (nodeId) => {
      if (workspace.node(nodeId)?.kind !== 'issue') return null;
      ui.setCarrying(true);
      return carriedIds(nodeId, workspace.selection.ids);
    },

    move: (_ids, event) => {
      shell.periodDropTarget = periodDropAt(event.clientX, event.clientY)?.key ?? null;
    },

    drop: (ids, event) => {
      ui.setCarrying(false);
      shell.periodDropTarget = null;
      const box = periodDropAt(event.clientX, event.clientY);
      if (box) {
        scheduleSelection(workspace, ids, box.period);
        return;
      }

      const edge = edgeUnder(
        graph.nodes,
        graph.edges,
        screenToFlow,
        event,
        new Set(ids),
      );
      const data = edge?.data as { from: string; to: string } | undefined;
      if (edge && data && ids.length === 1) {
        spliceOntoEdge(workspace, ids[0]!, data.from, data.to);
      }
    },

    cancel: () => {
      ui.setCarrying(false);
      shell.periodDropTarget = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Drag interpretation
// ---------------------------------------------------------------------------

/**
 * A SvelteFlow drag stopped. What it meant depends on where the pointer is:
 * an edge (splice onto it), the drawer (snap back), a node (reparent), or the
 * canvas (just remember where it landed).
 */
export function handleDragStop(params: {
  targetNode: Node | null;
  nodes: Node[];
  event: MouseEvent | TouchEvent;
  graph: CanvasGraph;
  workspace: Workspace;
  shell: Shell;
  screenToFlow: ScreenToFlow;
}): void {
  const { targetNode, nodes, event, graph, workspace, shell, screenToFlow } = params;
  const dragged = targetNode ?? nodes[0];
  if (!dragged || !(event instanceof MouseEvent)) {
    graph.persistPositions();
    return;
  }
  const moving = new Set(nodes.map((node) => node.id));

  // Alt pressed *after* a drag began, which `carry.ts` never saw. The node
  // has already moved, so the only thing still on offer is the edge splice.
  if (event.altKey) {
    const edge = edgeUnder(graph.nodes, graph.edges, screenToFlow, event, moving);
    const data = edge?.data as { from: string; to: string } | undefined;
    if (edge && data && spliceOntoEdge(workspace, dragged.id, data.from, data.to)) {
      return;
    }
  }

  // Dropped clean off the canvas and onto nothing that wanted it. The node was
  // never going there, so it goes back rather than keeping a position halfway
  // into the drawer.
  if (!overCanvas(event)) {
    graph.sync();
    return;
  }

  const dropTarget = nodeUnder(graph.nodes, screenToFlow, event, moving);
  if (dropTarget && dropTarget.id !== workspace.node(dragged.id)?.parentId) {
    resolveReparent(workspace, shell, graph, dragged.id, dropTarget.id);
    return;
  }
  graph.persistPositions();
}

/**
 * Dropping a node onto a node reparents it. When the hierarchy will not have
 * it at that depth there are two ways to make the drop mean something — the
 * dragged node changes type, or the levels it is missing get built — and
 * choosing between them is the reader's call, not ours.
 */
export function resolveReparent(
  workspace: Workspace,
  shell: Shell,
  graph: CanvasGraph,
  id: string,
  parentId: string,
): void {
  const node = workspace.node(id);
  const parent = workspace.node(parentId);
  if (!node || !parent) return;

  const choices = reparentChoices(workspace, id, parentId);
  if (choices.convert.allowed && choices.convert.type === node.type) {
    reparent(workspace, id, parentId);
    return;
  }

  const canConvert = choices.convert.allowed;
  if (!canConvert && !choices.bridge.length) {
    if (choices.convert.reason) workspace.notify('error', choices.convert.reason);
    graph.sync();
    return;
  }

  shell.askReparent({ id, parentId, onDone: () => graph.sync() });
}

// ---------------------------------------------------------------------------
// Roster drop
// ---------------------------------------------------------------------------

/**
 * A team member dropped from the roster onto a node. Dropping onto one of
 * several selected nodes hands the work to all of them — the same rule the
 * context menu follows, so the two ways of assigning agree.
 */
export function handleRosterDrop(
  workspace: Workspace,
  graphNodes: Node[],
  screenToFlow: ScreenToFlow,
  event: DragEvent,
): void {
  const resourceId = event.dataTransfer?.getData('application/x-lpm-resource');
  if (!resourceId) return;
  event.preventDefault();
  const target = nodeUnder(graphNodes, screenToFlow, event, new Set());
  if (!target) return;
  const ids = workspace.selection.has(target.id) ? [...workspace.selection.ids] : [target.id];
  assignSelection(workspace, ids, resourceId);
}
