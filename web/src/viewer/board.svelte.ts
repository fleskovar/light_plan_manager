import type {
  ConfigDto,
  NodeDto,
  NodeLayout,
  StaticBoard,
  StaticView,
  TypeDisplay,
} from '$shared';
import { baseline, type WorkingNodes } from '$lib/board/working.js';
import { buildIndex, type NodeIndexImpl } from '$lib/board/index.js';
import { Selection } from '$lib/workspace/selection.svelte.js';

/**
 * The board, read-only.
 *
 * The editor's `Workspace` is a snapshot, a view, a working copy and a queue.
 * Take the queue away and almost nothing is left, which is the point: this
 * holds a `StaticBoard` and answers the same questions the canvas asks, so the
 * two share `CanvasGraph` and draw identical graphs.
 *
 * Positions and collapsed state are the only things a reader can change, and
 * they live here for as long as the tab is open. Nothing is ever written back —
 * there is nowhere to write to.
 */

/**
 * The view offered when the board has none of its own, and always as a
 * fallback. `slugify` turns every other character into a dash, so a leading
 * underscore is an id no saved view can ever take — and it still reads cleanly
 * in a URL.
 */
export const ALL_ISSUES = '_all';

export class ViewerBoard {
  data = $state.raw<StaticBoard | null>(null);
  nodes = $state.raw<WorkingNodes>({});
  /** Index over `nodes`, rebuilt on load / view switch. */
  index = $state.raw<NodeIndexImpl>(buildIndex({}));
  error = $state<string | null>(null);
  loading = $state(true);

  viewId = $state(ALL_ISSUES);
  members = $state.raw<string[]>([]);
  layout = $state<Record<string, NodeLayout>>({});
  /** How the published view draws each level: as nodes, or as badges. */
  display = $state.raw<Record<string, TypeDisplay>>({});
  /**
   * Kept apart from `layout` because a node can be collapsed without having a
   * position yet: "All issues" starts folded up, and seeding coordinates to
   * express that would rob it of the automatic layout it needs.
   */
  #collapsed = $state<Record<string, boolean>>({});

  readonly selection = new Selection();

  get ready(): boolean {
    return this.data !== null;
  }

  get config(): ConfigDto {
    const config = this.data?.board.config;
    if (!config) throw new Error('The viewer has no board loaded');
    return config;
  }

  node(id: string): NodeDto | undefined {
    return this.nodes[id];
  }

  /** Every view on offer: the board's own, plus the synthetic whole board. */
  get views(): StaticView[] {
    const board = this.data;
    if (!board) return [];
    return [...board.views, allIssues(board)];
  }

  get view(): StaticView | undefined {
    return this.views.find((view) => view.id === this.viewId);
  }

  // -- loading ---------------------------------------------------------------

  load(board: StaticBoard, viewId?: string): void {
    this.data = board;
    // Templates travel with the export because a published registry view names
    // them; "All issues" below is still only the issues, which is what a reader
    // opening a board with no saved view is looking for.
    this.nodes = baseline([
      ...board.board.issues,
      ...board.board.periods,
      ...board.board.resources,
      ...board.board.templates,
    ]);
    this.index = buildIndex(this.nodes);
    this.loading = false;
    this.error = null;
    // A view named in the URL wins; otherwise the first saved one, and the
    // whole board when there are none.
    this.open(viewId ?? board.views[0]?.id ?? ALL_ISSUES);
  }

  fail(message: string): void {
    this.error = message;
    this.loading = false;
  }

  /** Switch views. Each carries its own membership, positions and folding. */
  open(viewId: string): void {
    const view = this.views.find((entry) => entry.id === viewId) ?? this.views.at(-1);
    if (!view) return;
    this.viewId = view.id;
    this.members = view.members.filter((id) => this.nodes[id]);
    // Positions and sizes travel; folding does not, because it is held apart
    // from them below.
    // Which levels are badges is part of the published picture, not of editing.
    this.display = view.display ?? {};
    this.layout = Object.fromEntries(
      Object.entries(view.layout).map(([id, entry]) => [
        id,
        { x: entry.x, y: entry.y, width: entry.width, height: entry.height },
      ]),
    );
    // A saved view says what its author folded up. The whole board has no
    // author, so it folds every parent and opens at its top level.
    this.#collapsed =
      view.id === ALL_ISSUES
        ? foldParents(this.nodes, this.members)
        : Object.fromEntries(
            Object.entries(view.layout)
              .filter(([, entry]) => entry.collapsed)
              .map(([id]) => [id, true]),
          );
    this.selection.clear();
  }

  // -- what the canvas asks for ----------------------------------------------

  isCollapsed(id: string): boolean {
    return this.#collapsed[id] === true;
  }

  toggleCollapsed(id: string): void {
    this.#collapsed = { ...this.#collapsed, [id]: !this.#collapsed[id] };
  }

  setLayout(id: string, layout: Partial<NodeLayout>): void {
    if (layout.collapsed !== undefined) {
      this.#collapsed = { ...this.#collapsed, [id]: layout.collapsed };
    }
    const { x, y, width, height } = layout;
    if (x === undefined && y === undefined && width === undefined && height === undefined) return;
    const current = this.layout[id] ?? { x: 0, y: 0 };
    this.layout = {
      ...this.layout,
      [id]: {
        ...current,
        x: x ?? current.x,
        y: y ?? current.y,
        width: width ?? current.width,
        height: height ?? current.height,
      },
    };
  }

  /** Forget every position so the canvas lays the graph out from scratch. */
  resetLayout(): void {
    this.layout = {};
  }
}

/**
 * The whole board as a view: every issue a member, and no saved positions, so
 * the canvas lays it out itself. It carries no layout because a `NodeLayout`
 * cannot say "folded, but put it wherever you like" — `foldParents` says that.
 */
export function allIssues(board: StaticBoard): StaticView {
  return {
    id: ALL_ISSUES,
    name: 'All issues',
    updated: board.generated,
    members: board.board.issues.map((issue) => issue.id),
    layout: {},
  };
}

/**
 * Collapse everything that has a child among `members`, so a board of hundreds
 * of sub-tasks opens as its handful of top-level items and unfolds where the
 * reader is interested.
 */
export function foldParents(nodes: WorkingNodes, members: string[]): Record<string, boolean> {
  const shown = new Set(members);
  const folded: Record<string, boolean> = {};
  for (const id of members) {
    const parentId = nodes[id]?.parentId;
    if (parentId && shown.has(parentId)) folded[parentId] = true;
  }
  return folded;
}
