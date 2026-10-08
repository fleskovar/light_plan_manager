import { getContext, setContext } from 'svelte';
import type { ConfigDto, NodeLayout, SyncBadge, TypeDisplay } from '$shared';
import type { WorkingNodes } from '$lib/board/working.js';
import type { Selection } from '$lib/workspace/selection.svelte.js';

/**
 * What the canvas needs from whatever is holding the board.
 *
 * Two things hold one: the editor's `Workspace`, where a position is queued into
 * a view file, and the viewer's read-only store, where it lives for as long as
 * the tab is open. Both satisfy this, which is what lets them share
 * `CanvasGraph` — and with it the single copy of "where does a node sit and how
 * big does a subflow have to be". Positions are the part that would drift most
 * visibly if it were written twice.
 *
 * Neither implementation imports this interface: they satisfy it structurally,
 * so `$lib` never has to depend on `$features`. The provide call is where a
 * mismatch is caught.
 */
export interface GraphSource {
  readonly ready: boolean;
  readonly nodes: WorkingNodes;
  readonly config: ConfigDto;
  /** Ids drawn on the canvas. Everything else on the board stays off it. */
  readonly members: string[];
  readonly layout: Record<string, NodeLayout>;
  /** Issue type -> how it is drawn. Absent types are drawn as nodes. */
  readonly display: Record<string, TypeDisplay>;
  /**
   * Per-node sync badge, when a remote's drift report has been read. Absent —
   * as in the read-only viewer, which has no remote — means no badge anywhere.
   */
  readonly syncBadges?: Readonly<Record<string, SyncBadge>>;
  readonly selection: Selection;
  isCollapsed(id: string): boolean;
  toggleCollapsed(id: string): void;
  setLayout(id: string, layout: Partial<NodeLayout>): void;
  /** Double-click on a node, after selecting it. Editor opens a dialog; viewer shows plain text. */
  onDoubleClickNode?(id: string): void;
}

const KEY = Symbol('graph-source');

export function provideGraphSource<T extends GraphSource>(source: T): T {
  return setContext(KEY, source);
}

export function useGraphSource(): GraphSource {
  return getContext<GraphSource>(KEY);
}
