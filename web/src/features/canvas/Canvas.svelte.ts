/**
 * Decision logic extracted from Canvas.svelte: hit-testing, drag and drop
 * interpretation, reparent resolution, and roster drop handling.
 *
 * The component keeps the reactive state, the SvelteFlow event wiring, the
 * template, and the CSS. What lives here is the part that decides what an event
 * means — the same family as `pan.ts` and `menus.ts`.
 */

import type { Edge, Node } from '@xyflow/svelte';
import type { Workspace } from '$lib/workspace/workspace.svelte.js';
import type { Shell } from '$lib/app/shell.svelte.js';
import {
  assignSelection,
  createNode,
  editNode,
  removeNodes,
  reparent,
  reparentChoices,
  scheduleSelection,
  spliceOntoEdge,
} from '$lib/workspace/mutations.js';
import { periodDropAt } from '$features/drawer/periods/periods.js';
import type { CanvasGraph } from './graph.svelte.js';
import { NODE_HEIGHT, NODE_WIDTH } from './model.js';

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
// Drag
// ---------------------------------------------------------------------------

/**
 * The two kinds of node drag.
 *
 * - `reshape`, a drag with no key held, moves the node. `CanvasGraph` pushes
 *   the nodes that it meets out of the way and grows the frames around it. A
 *   drop keeps the new positions and never changes the board.
 * - `structure`, a drag with Alt held, keeps the node inside its frame. The
 *   place where the pointer comes up decides the change to the board: a box in
 *   the Periods drawer schedules the work, an edge splices the node into that
 *   dependency, and another node becomes its parent (`dropParent`).
 *
 * The key state at the start of the drag decides the kind for the whole drag.
 * Ctrl and Cmd belong to the camera (`pan.ts`), so they never start a node drag.
 */
export type DragKind = 'reshape' | 'structure';

export function dragKindOf(event: { altKey: boolean }): DragKind {
  return event.altKey ? 'structure' : 'reshape';
}

/** State the drag handlers update in the component. */
export interface DragUI {
  /** True for the length of a structural drag. */
  setStructural(on: boolean): void;
  /** SvelteFlow pans the camera during a drag only while this is true. */
  setAutoPan(on: boolean): void;
}

export interface DragHandlers {
  start(event: MouseEvent | TouchEvent): void;
  drag(nodes: Node[]): void;
  stop(params: { targetNode: Node | null; nodes: Node[]; event: MouseEvent | TouchEvent }): void;
}

/** Connect the three node-drag events of SvelteFlow to the canvas and the board. */
export function createDragHandlers(
  workspace: Workspace,
  shell: Shell,
  ui: DragUI,
  graph: CanvasGraph,
  screenToFlow: ScreenToFlow,
): DragHandlers {
  let kind: DragKind | null = null;
  let follow: ((event: PointerEvent) => void) | null = null;

  function stopFollowing(): void {
    if (follow) window.removeEventListener('pointermove', follow, true);
    follow = null;
  }

  return {
    start(event) {
      kind = dragKindOf(event);
      if (kind === 'reshape') {
        graph.beginReshape();
        return;
      }
      ui.setStructural(true);
      graph.clampToParents(true);
      // SvelteFlow reports no move while the extent holds the node at the edge
      // of its frame, so the canvas follows the pointer itself. Over the
      // drawer, auto-pan stops: the camera holds still while the reader picks
      // a box.
      follow = (moved) => {
        shell.periodDropTarget = periodDropAt(moved.clientX, moved.clientY)?.key ?? null;
        ui.setAutoPan(overCanvas(moved));
      };
      window.addEventListener('pointermove', follow, true);
    },

    drag(nodes) {
      if (kind === 'reshape') graph.reshapeDrag(nodes);
    },

    stop({ targetNode, nodes, event }) {
      const ended = kind;
      kind = null;
      if (ended !== 'structure') {
        // Dropped off the canvas: the node was going nowhere, so everything
        // that it moved goes back.
        if (event instanceof MouseEvent && !overCanvas(event)) graph.cancelReshape();
        else graph.endReshape();
        return;
      }
      stopFollowing();
      ui.setStructural(false);
      ui.setAutoPan(true);
      shell.periodDropTarget = null;
      graph.clampToParents(false);
      dropStructure({ targetNode, nodes, event, graph, workspace, shell, screenToFlow });
    },
  };
}

/**
 * A structural drag ended. Where the pointer is decides what it meant: a box
 * in the Periods drawer (schedule, and the node goes back), an edge (splice
 * onto it), off the canvas (the node goes back), a node (reparent, when
 * `dropParent` allows it), or the canvas (keep the new position).
 */
export function dropStructure(params: {
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
  const ids = nodes.map((node) => node.id);
  const moving = new Set(ids);

  // Being scheduled into a sprint is not a change to the picture, so the
  // node goes back to where the drag started.
  const box = periodDropAt(event.clientX, event.clientY);
  if (box) {
    scheduleSelection(workspace, ids, box.period);
    graph.sync();
    return;
  }

  if (ids.length === 1) {
    const edge = edgeUnder(graph.nodes, graph.edges, screenToFlow, event, moving);
    const data = edge?.data as { from: string; to: string } | undefined;
    if (edge && data && spliceOntoEdge(workspace, dragged.id, data.from, data.to)) {
      return;
    }
  }

  if (!overCanvas(event)) {
    graph.sync();
    return;
  }

  const newParent = dropParent({
    parentId: workspace.node(dragged.id)?.parentId ?? null,
    targetId: nodeUnder(graph.nodes, screenToFlow, event, moving)?.id ?? null,
    drawn: new Set(graph.nodes.map((node) => node.id)),
    scope: graph.scope,
  });
  if (newParent) {
    resolveReparent(workspace, shell, graph, dragged.id, newParent);
    return;
  }
  graph.persistPositions();
}

/**
 * Returns the new parent that a drop asks for, or null when the drop only moves
 * the node on the canvas.
 *
 * - `parentId` is the parent of the dragged node on the board.
 * - `targetId` is the node under the pointer, if any.
 * - `drawn` holds the ids of the nodes on the canvas.
 * - `scope` is the active item of edit mode, or null.
 *
 * A drop changes the parent only when the canvas shows the current parent.
 * The canvas shows it as a node, or as the whole canvas when the parent is the
 * active item. When the view hides the parent, or draws its type as a badge, a
 * drop onto another node only moves the dragged node.
 */
export function dropParent(input: {
  parentId: string | null;
  targetId: string | null;
  drawn: ReadonlySet<string>;
  scope: string | null;
}): string | null {
  const { parentId, targetId, drawn, scope } = input;
  if (!targetId || targetId === parentId) return null;
  const parentShown = parentId === null || parentId === scope || drawn.has(parentId);
  return parentShown ? targetId : null;
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

// ---------------------------------------------------------------------------
// New items in edit mode
// ---------------------------------------------------------------------------

/** The space between a new item and the next one that Enter opens below it. */
export const DRAFT_GAP = 24;

/**
 * A new item that waits for its title. The board receives nothing until the
 * title is submitted, so the id of the item cannot change while it is typed.
 */
export interface Draft {
  /** Counts the drafts, so each one gets a new title field. */
  serial: number;
  /** The parent of the new item: the active item, or null at the top level. */
  parentId: string | null;
  type: string;
  /** Top-left corner of the item, in the coordinates of the canvas. */
  position: { x: number; y: number };
}

/** The top-left corner that puts a new item's centre on `point`. */
export function centredOn(point: { x: number; y: number }): { x: number; y: number } {
  return { x: point.x - NODE_WIDTH / 2, y: point.y - NODE_HEIGHT / 2 };
}

/** The draft that Enter opens after `draft`: the same parent and type, one row lower. */
export function nextDraft(draft: Draft): Draft {
  return {
    ...draft,
    serial: draft.serial + 1,
    position: { x: draft.position.x, y: draft.position.y + NODE_HEIGHT + DRAFT_GAP },
  };
}

/**
 * Create the item that `draft` describes, with `title`, at the draft's
 * position, and select it. Returns the new id, or null when `title` is null.
 *
 * The parent id goes through `workspace.resolve`, because a push can give a
 * real id to a parent that was created in this session while the title was
 * typed. The position is stored before the canvas syncs, so the item appears
 * where the card was.
 */
export function commitDraft(workspace: Workspace, draft: Draft, title: string | null): string | null {
  if (title === null) return null;
  const parentId = draft.parentId ? workspace.resolve(draft.parentId) : null;
  const id = createNode(workspace, { type: draft.type, parentId, title });
  workspace.setLayout(id, draft.position);
  workspace.selection.set([id]);
  return id;
}

/** True when a double-click landed on the empty canvas, not on a node, an edge or a control. */
export function isPaneTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.classList.contains('svelte-flow__pane');
}

/**
 * Close the title field of `id` on the canvas and apply what was typed.
 *
 * A title writes the key `title` of `id`, unless it equals the current title.
 * A null title means Esc or an empty field. It changes nothing, except on an
 * item that **Add new…** created for the field: that item is removed, so the
 * queue holds no change for it.
 */
export function finishRename(workspace: Workspace, id: string, title: string | null): void {
  const remove = workspace.canvasMode.renaming === id && workspace.canvasMode.closeRename();
  const node = workspace.node(id);
  if (!node) return;
  if (title === null) {
    if (remove) removeNodes(workspace, [id]);
    return;
  }
  if (title !== node.title) editNode(workspace, id, { title });
}
