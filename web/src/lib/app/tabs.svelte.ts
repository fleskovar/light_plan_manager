import { getContext, setContext } from 'svelte';
import type { ViewDocument, ViewMode, ViewSummary } from '$shared';
import { api } from '$lib/api/client.js';
import { goToView, viewHash } from './router.svelte.js';

/**
 * The tabs of one browser window: the views that the window holds open, and
 * the view that it shows.
 *
 * The tabs belong to the reader and not to the board, so no file under `.lpm`
 * stores them. The store writes one `localStorage` entry for each board. The
 * key of the entry is `lpm:tabs:<root folder of the board>`. The value is a
 * JSON object with two keys: `open` holds the ids of the open views in tab
 * order, and `active` holds the id of the view that the window showed last.
 * The next start of the app reads this entry and opens the same tabs.
 *
 * A window that "Open in new window" created has no storage. Its tabs last
 * until the window closes, so the tabs of the main window stay as they are.
 */
export const TABS_KEY = 'lpm:tabs';

/** The name of the view that the app creates on a board with no view. */
export const DEFAULT_VIEW_NAME = 'Default';

/** `window.name` of a window that "Open in new window" created starts with this text. */
export const WINDOW_PREFIX = 'lpm-window-';

export interface StoredTabs {
  open: string[];
  active: string | null;
}

/** Read a stored entry. An entry that does not parse gives no tabs. */
export function parseTabs(raw: string | null): StoredTabs {
  const empty: StoredTabs = { open: [], active: null };
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return empty;
    const stored = parsed as Record<string, unknown>;
    const open = Array.isArray(stored.open)
      ? stored.open.filter((id): id is string => typeof id === 'string')
      : [];
    return {
      open: [...new Set(open)],
      active: typeof stored.active === 'string' ? stored.active : null,
    };
  } catch {
    return empty;
  }
}

/**
 * The view that the app shows when the address names none.
 *
 * The order is: the view that the window showed last, then the first open tab,
 * then the view with the newest save. `views` arrives sorted by save time,
 * newest first. The result is null when the board has no view.
 */
export function landingView(stored: StoredTabs, views: ViewSummary[]): string | null {
  const known = new Set(views.map((view) => view.id));
  if (stored.active !== null && known.has(stored.active)) return stored.active;
  return stored.open.find((id) => known.has(id)) ?? views[0]?.id ?? null;
}

/** The tab that takes over when the tab `id` closes: the next tab, or the previous one. */
export function neighbour(open: string[], id: string): string | null {
  const index = open.indexOf(id);
  if (index === -1) return null;
  return open[index + 1] ?? open[index - 1] ?? null;
}

/** What the store needs from the server and the browser, so a test can pass fakes. */
export interface TabsHost {
  listViews(): Promise<ViewSummary[]>;
  createView(name: string, mode?: ViewMode): Promise<ViewDocument>;
  deleteView(id: string): Promise<void>;
  /** The root folder of the board. It names the storage entry. */
  boardRoot(): Promise<string>;
  /** Null in a window that keeps no tabs between sessions. */
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** Put the view in the address of this window. */
  go(id: string, options?: { replace?: boolean }): void;
  /** Open the view in a new browser window. False when the browser blocked the window. */
  openWindow(id: string): boolean;
  /** Called when a tab leaves this window. `deleted` is true when its view file is gone. */
  closed?(id: string, deleted: boolean): void;
}

export class Tabs {
  /** Every view of the board, newest save first. */
  views = $state<ViewSummary[]>([]);
  /** The ids of the open views, in tab order. */
  open = $state<string[]>([]);
  active = $state<string | null>(null);
  /** True after `start` read the view list and the stored tabs. */
  ready = $state(false);
  failure = $state<{ message: string; details: string[] } | null>(null);

  readonly #host: TabsHost;
  #key = TABS_KEY;
  /** The stored active view, kept until the first view is shown. */
  #remembered: string | null = null;
  #landing: Promise<void> | null = null;

  constructor(host: TabsHost) {
    this.#host = host;
  }

  /**
   * Read the views and the stored tabs, then show a view.
   *
   * `routeId` is the view that the address names, or null. With null the store
   * picks the landing view, and creates the default view on a board with none.
   */
  async start(routeId: string | null): Promise<void> {
    this.failure = null;
    try {
      const [views, root] = await Promise.all([
        this.#host.listViews(),
        this.#host.boardRoot().catch(() => ''),
      ]);
      this.views = views;
      this.#key = `${TABS_KEY}:${root}`;
      const stored = parseTabs(this.#read());
      const known = new Set(views.map((view) => view.id));
      this.open = stored.open.filter((id) => known.has(id));
      this.#remembered = stored.active;
      this.ready = true;
      if (routeId !== null) this.show(routeId);
      else await this.land();
    } catch (error) {
      this.failure = describe(error);
    }
  }

  /**
   * Go to the landing view. A board with no view gets the default view first.
   * A second call during the first one returns the same promise, so two
   * callers do not both create the default view.
   */
  land(): Promise<void> {
    this.#landing ??= this.#land().finally(() => {
      this.#landing = null;
    });
    return this.#landing;
  }

  async #land(): Promise<void> {
    try {
      const stored = { open: this.open, active: this.active ?? this.#remembered };
      const id = landingView(stored, this.views) ?? (await this.#createDefault());
      this.#go(id, { replace: true });
    } catch (error) {
      this.failure = describe(error);
    }
  }

  /** Record that the window shows the view `id`. The view gets a tab when it has none. */
  show(id: string): void {
    if (!this.open.includes(id)) this.open = [...this.open, id];
    this.active = id;
    this.#persist();
    // Another window can create a view after this window read the list.
    if (!this.views.some((view) => view.id === id)) void this.refresh();
  }

  activate(id: string): void {
    this.#go(id);
  }

  /** Close a tab. The last tab stays, because the window always shows a view. */
  close(id: string): void {
    if (this.open.length < 2 || !this.open.includes(id)) return;
    const next = neighbour(this.open, id)!;
    this.open = this.open.filter((entry) => entry !== id);
    this.#host.closed?.(id, false);
    if (this.active === id) this.#go(next);
    else this.#persist();
  }

  closeOthers(id: string): void {
    const dropped = this.open.filter((entry) => entry !== id);
    if (!dropped.length) return;
    this.open = [id];
    for (const entry of dropped) this.#host.closed?.(entry, false);
    if (this.active === id) this.#persist();
    else this.#go(id);
  }

  /** Create a view on the board and show it in a new tab. Throws what the server refuses. */
  async create(name: string, mode: ViewMode = 'board'): Promise<string> {
    const view = await this.#host.createView(name, mode);
    await this.refresh();
    this.#go(view.id);
    return view.id;
  }

  /** Delete the view file. When the window showed that view, it shows another one. */
  async remove(id: string): Promise<void> {
    await this.#host.deleteView(id);
    const next = neighbour(this.open, id);
    this.views = this.views.filter((view) => view.id !== id);
    this.open = this.open.filter((entry) => entry !== id);
    this.#host.closed?.(id, true);
    if (this.active !== id) {
      this.#persist();
      return;
    }
    this.active = null;
    if (next !== null) this.#go(next, { replace: true });
    else await this.land();
  }

  /** Put the view `next` in the tab that held the view `id`. */
  replace(id: string, next: string): void {
    const wasActive = this.active === id;
    this.open = [...new Set(this.open.map((entry) => (entry === id ? next : entry)))];
    this.#host.closed?.(id, false);
    if (wasActive) this.#go(next, { replace: true });
    else this.#persist();
  }

  /**
   * Open the view in a new browser window, and close its tab here when the
   * window holds other tabs. Returns false when the browser blocked the window.
   */
  detach(id: string): boolean {
    if (!this.#host.openWindow(id)) return false;
    this.close(id);
    return true;
  }

  /** Read the view list again. A failed read keeps the list that the store holds. */
  async refresh(): Promise<void> {
    try {
      this.views = await this.#host.listViews();
    } catch {
      // The list is only labels and menu entries. The next refresh reads it again.
    }
  }

  /** The name of a view, or its id until the list holds the view. */
  name(id: string): string {
    return this.views.find((view) => view.id === id)?.name ?? id;
  }

  /** True when another view already has this name. Capitals do not count. */
  nameTaken(name: string, except: string | null = null): boolean {
    const wanted = name.trim().toLowerCase();
    return this.views.some((view) => view.id !== except && view.name.trim().toLowerCase() === wanted);
  }

  async #createDefault(): Promise<string> {
    try {
      const view = await this.#host.createView(DEFAULT_VIEW_NAME, 'board');
      await this.refresh();
      return view.id;
    } catch (error) {
      // A second window can create the default view between the list and this call.
      await this.refresh();
      const existing = this.views[0]?.id;
      if (existing === undefined) throw error;
      return existing;
    }
  }

  #go(id: string, options?: { replace?: boolean }): void {
    this.show(id);
    this.#host.go(id, options);
  }

  #read(): string | null {
    try {
      return this.#host.storage?.getItem(this.#key) ?? null;
    } catch {
      return null;
    }
  }

  #persist(): void {
    const stored: StoredTabs = { open: [...this.open], active: this.active };
    try {
      this.#host.storage?.setItem(this.#key, JSON.stringify(stored));
    } catch {
      // Storage refused the write. The tabs still work until the window closes.
    }
  }
}

function describe(error: unknown): { message: string; details: string[] } {
  const details = (error as { details?: unknown }).details;
  return {
    message: error instanceof Error ? error.message : String(error),
    details: Array.isArray(details) ? details.map(String) : [],
  };
}

/** True in a window that "Open in new window" created. */
export function isDetachedWindow(): boolean {
  return typeof window !== 'undefined' && window.name.startsWith(WINDOW_PREFIX);
}

/** The store over the real server and the real browser. */
export function browserTabs(closed: (id: string, deleted: boolean) => void): Tabs {
  let storage: Storage | null = null;
  try {
    storage = isDetachedWindow() ? null : window.localStorage;
  } catch {
    // Some browsers throw on the getter itself when site data is blocked.
  }
  return new Tabs({
    listViews: api.listViews,
    createView: api.createView,
    deleteView: api.deleteView,
    boardRoot: async () => (await api.serverInfo()).root,
    storage,
    go: goToView,
    openWindow: (id) => {
      const base = window.location.href.replace(/#.*$/, '');
      const name = `${WINDOW_PREFIX}${Date.now().toString(36)}`;
      return window.open(`${base}${viewHash(id)}`, name, 'popup,width=1360,height=860') !== null;
    },
    closed,
  });
}

const KEY = Symbol('tabs');

export function provideTabs(tabs: Tabs): Tabs {
  return setContext(KEY, tabs);
}

export function useTabs(): Tabs {
  return getContext<Tabs>(KEY);
}
