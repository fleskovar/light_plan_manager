import { isDerivedFlag } from '$shared';
import type { SyncBadge } from '$shared';
import type { CanvasGraph } from '../graph.svelte.js';
import type { CanvasNodeData } from '../model.js';
import { MIN_LEAF_HEIGHT, MIN_LEAF_WIDTH } from '../layout.js';
import type { GraphSource } from '../source.js';

/**
 * Derivations extracted from NodeShell.svelte.
 *
 * The component is deliberately kept as markup, CSS and callback wiring.
 * What lives here is the narrow strip of logic it needs: the floor a node may
 * not be dragged below, the resize callbacks, and the display text for the
 * schedule badge.
 */

/** A box as the resizer of SvelteFlow reports it: position relative to the parent. */
export interface ResizeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The three events of a resize, for one node. */
export interface ResizeHandlers {
  start(id: string): void;
  resize(id: string, box: ResizeBox): void;
  end(id: string, box: ResizeBox): void;
}

/**
 * The resize callbacks of a node component.
 *
 * With a `CanvasGraph`, a resize pushes the nodes that it meets and grows the
 * frames around it, as a plain drag does. The resizer of SvelteFlow calls
 * `onResize` before it writes its own change to the node. So the push runs in
 * a microtask, after that write. Without a graph, the end of a resize only
 * stores the box.
 */
export function resizeHandlers(
  graph: CanvasGraph | undefined,
  source: Pick<GraphSource, 'setLayout'>,
): ResizeHandlers {
  if (!graph) {
    return { start: () => {}, resize: () => {}, end: (id, box) => source.setLayout(id, box) };
  }
  return {
    start: () => graph.beginReshape(),
    resize: (id, box) => queueMicrotask(() => graph.reshapeResize(id, box)),
    end: (id, box) => graph.endResize(id, { width: box.width, height: box.height }),
  };
}

/**
 * The smallest size a node may be dragged to.
 *
 * A subflow may not be dragged smaller than the issues inside it (its own
 * `minWidth`/`minHeight`, filled in by `fitGroups`), and a leaf may not be
 * dragged smaller than a readable card. The component's `NodeResizer` reads
 * these back and enforces them as a floor.
 */
export function nodeMinSize(
  data: CanvasNodeData,
  leafMinWidth = MIN_LEAF_WIDTH,
  leafMinHeight = MIN_LEAF_HEIGHT,
): { minWidth: number; minHeight: number } {
  return {
    minWidth: Math.max(data.minWidth ?? leafMinWidth, leafMinWidth),
    minHeight: Math.max(data.minHeight ?? leafMinHeight, leafMinHeight),
  };
}

/**
 * Whether a node's styling says "something inside me is flagged."
 *
 * Two ways that happens, and they are the same fact reaching the node by
 * different routes. The engine rolls a flag up the parent chain, so a
 * container holding stopped work carries `DERIVED_FLAG` on the document
 * itself — that is what makes an *expanded* epic say something about a story
 * four levels down. And `flaggedInside` counts flags this node is standing in
 * for because they are folded away inside it, which is the same claim about
 * detail that is not on screen at all.
 *
 * @see src/shared/flag-rollup.ts
 */
export function hasFlagInside(data: CanvasNodeData): boolean {
  return isDerivedFlag(data.flag) || (!data.flag && data.flaggedInside > 0);
}

/** A flag somebody raised on this node, as opposed to one rolled up into it. */
export function isRaisedFlag(data: CanvasNodeData): boolean {
  return Boolean(data.flag) && !isDerivedFlag(data.flag);
}

/**
 * Whether a sync badge should be drawn as a corner mark.
 *
 * `in-sync` is deliberately absent: it is the default state and the canvas
 * draws no mark for it — the mark exists to surface drift, not to certify
 * every node that is fine. The four drift states are the whole of it.
 */
export function isDriftSync(sync: SyncBadge | undefined): boolean {
  return sync === 'ahead' || sync === 'behind' || sync === 'conflicted' || sync === 'unlinked';
}
