import type { Change } from './changes.js';

/**
 * A saved view: which slice of the board someone is looking at, where they put
 * it, and what they have changed but not yet pushed.
 *
 * Views live in `.lpm/views/*.json` and are committed with the board, but they
 * are not board truth — nothing in the engine reads them. A view referencing a
 * document that no longer exists simply drops it when it loads.
 */
export const VIEW_VERSION = 1;

export interface NodeLayout {
  x: number;
  y: number;
  /** Hide this node's children and reroute their edges onto it. */
  collapsed?: boolean;
  /**
   * The size the reader dragged this node to. Absent means "whatever the canvas
   * works out", which is the usual case: only a node someone resized by hand
   * carries one. On a subflow it is a floor, not a size — a group still grows to
   * hold its children, or it would clip them.
   */
  width?: number;
  height?: number;
}

/**
 * The drawer's tabs. The queue used to be one of them and is now a panel of its
 * own (`QueuePanelState`); a view file saved on that tab is read as `table`.
 */
export type DrawerTab = 'table' | 'gantt' | 'team' | 'periods' | 'sync';

export interface DrawerState {
  open: boolean;
  tab: DrawerTab;
  /** Height in pixels, set by dragging the splitter. */
  height: number;
}

export interface PanelState {
  open: boolean;
  pinned: boolean;
  /** Width in pixels, set by dragging the splitter beside it. */
  width: number;
}

/**
 * The queue down the left edge, offered while a view works off the queue. It
 * is a column rather than a tab because a queue is read top to bottom: what is
 * being worked on, then what comes next, in order.
 */
export interface QueuePanelState {
  open: boolean;
  /** Width in pixels, set by dragging the splitter beside it. */
  width: number;
}

/**
 * The sizes a new view opens its panes at. Exported because they are also the
 * baseline the app scales a pane's contents from: a drawer at this height is
 * "normal size", and everything above it grows.
 */
export const DEFAULT_DRAWER_HEIGHT = 320;
export const DEFAULT_PANEL_WIDTH = 352;
export const DEFAULT_QUEUE_WIDTH = 300;

/**
 * How the canvas draws one level of the hierarchy.
 *
 * `node` is the default: the issue is a node of its own, and a node with
 * children is a subflow containing them. `badge` takes the issue off the canvas
 * and writes its id onto the children instead, which is what turns a
 * four-deep board into a graph of the stories that actually depend on each
 * other, still labelled with the feature each one belongs to.
 */
export type TypeDisplay = 'node' | 'badge';

/**
 * How this board decides what happens next.
 *
 * `periods` plans with the calendar: increments, sprints, and the drawer's
 * Periods and Gantt tabs. `queue` does not plan at all — work is taken off a
 * queue as the graph unblocks it, and the drawer offers that queue instead.
 * Both read the same documents; the difference is which question the app puts
 * in front of you, and a board with no period types only ever has the second.
 */
export type Planning = 'periods' | 'queue';

/**
 * Which collection this view is a canvas over.
 *
 * `board` is the ordinary one: issues, arranged and scheduled. `templates`
 * points exactly the same canvas, panel and table at the registry, so building
 * a reusable feature-with-three-stories is the gesture that builds a real one.
 * A view never mixes the two — a template and the issue it produces are at
 * different levels of the same idea, and a graph containing both would be
 * saying something nobody means.
 */
export type ViewMode = 'board' | 'templates';

export interface ViewDocument {
  version: number;
  id: string;
  name: string;
  created: string;
  updated: string;
  /** Issue ids imported into this view. Everything else stays off the canvas. */
  members: string[];
  layout: Record<string, NodeLayout>;
  changes: Change[];
  drawer: DrawerState;
  panel: PanelState;
  queue: QueuePanelState;
  /** Issue type -> how the canvas draws it. A type that is absent is a node. */
  display: Record<string, TypeDisplay>;
  /** Whether this view plans with periods or works straight from the queue. */
  planning: Planning;
  /** Whether this view is a canvas over the board or over the registry. */
  mode: ViewMode;
}

/** Listing entry for the welcome screen. */
export interface ViewSummary {
  id: string;
  name: string;
  updated: string;
  members: number;
  pendingChanges: number;
  mode: ViewMode;
}

export function emptyView(id: string, name: string, now = new Date().toISOString()): ViewDocument {
  return {
    version: VIEW_VERSION,
    id,
    name,
    created: now,
    updated: now,
    members: [],
    layout: {},
    changes: [],
    drawer: { open: true, tab: 'table', height: DEFAULT_DRAWER_HEIGHT },
    panel: { open: false, pinned: false, width: DEFAULT_PANEL_WIDTH },
    queue: { open: true, width: DEFAULT_QUEUE_WIDTH },
    display: {},
    planning: 'periods',
    mode: 'board',
  };
}

export function summarize(view: ViewDocument): ViewSummary {
  return {
    id: view.id,
    name: view.name,
    updated: view.updated,
    members: view.members.length,
    pendingChanges: view.changes.length,
    mode: view.mode,
  };
}
