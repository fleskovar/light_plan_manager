import { getContext, setContext } from 'svelte';
import type {
  BoardSnapshot,
  Change,
  ConfigDto,
  NodeDto,
  NodeKind,
  NodeLayout,
  Planning,
  PushFailure,
  SyncBadge,
  TypeDisplay,
  ViewDocument,
  ViewMode,
} from '$shared';
import { appendChange, isTempId, summarizePushFailures, tempId } from '$shared';
import { ApiError, api } from '$lib/api/client.js';
import type { WorkingNodes } from '$lib/board/working.js';
import { applyChange, replay } from '$lib/board/working.js';
import { buildIndex, type NodeIndexImpl } from '$lib/board/index.js';
import { Selection } from './selection.svelte.js';

/**
 * The open board: one snapshot, one view, one working copy, one queue.
 *
 * Everything the app does to the board goes through `record`, which applies the
 * change to the working copy and appends it to the view's queue in the same
 * breath — so the screen and the pending list can never disagree. Nothing here
 * knows about the canvas, the table or the panel; those read the working copy
 * and call the mutations in `mutations.ts`.
 *
 * There is no manual Push or Pull anywhere in the app: `record` debounces a
 * push the same way it debounces the view save, so an edit reaches `.lpm`
 * moments after it is made rather than waiting for somebody to press a
 * button, and `open` starts a poll that quietly re-reads the board on an
 * interval, so a file changed by another process — a second window, `lpm`,
 * an agent — arrives here without anybody asking. There is no filesystem
 * watcher underneath that poll (the engine's four runtime dependencies do not
 * include one), so "constantly" means every `AUTO_PULL_INTERVAL`, not the
 * instant a byte changes on disk.
 */
const AUTOSAVE_DELAY = 1500;
const AUTO_PULL_INTERVAL = 5000;

export type WorkspaceStatus = 'idle' | 'loading' | 'saving' | 'pushing';

export interface Notice {
  id: number;
  level: 'info' | 'error';
  message: string;
  details?: string[];
}

export class Workspace {
  // Raw, not deep state: the snapshot is replaced wholesale by open/pull/push and
  // never edited in place, and a deeply proxied one cannot be `structuredClone`d
  // into the working copy — `baseline` needs the plain DTOs the wire delivered.
  snapshot = $state.raw<BoardSnapshot | null>(null);
  view = $state<ViewDocument | null>(null);
  nodes = $state<WorkingNodes>({});
  /** The board's NodeIndex, maintained incrementally through `record`. */
  index = $state.raw<NodeIndexImpl>(buildIndex({}));
  status = $state<WorkspaceStatus>('idle');
  notices = $state<Notice[]>([]);

  /** Ids copied with Ctrl-C, waiting to be duplicated by Ctrl-V. */
  clipboard = $state<string[]>([]);

  /**
   * Per-node sync badge, written by the remote panel's state machine whenever
   * it re-reads a drift report. The canvas reads it through the `GraphSource`,
   * so a sync badge change redraws the graph the same way a status change does.
   * Only the four drift states are ever stored — in-sync is the absence of a
   * mark.
   */
  syncBadges = $state<Record<string, SyncBadge>>({});

  readonly selection = new Selection();

  /**
   * Called after every push that actually wrote something, manual or
   * automatic. `IssueView.svelte` uses it to tell the window that opened it
   * to pull, the way the old manual Push button did — the hook exists so
   * that notification still fires now that most pushes happen on a debounce
   * nobody clicked.
   */
  onPushed: (() => void) | null = null;

  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  #pushTimer: ReturnType<typeof setTimeout> | null = null;
  #pullTimer: ReturnType<typeof setInterval> | null = null;
  #noticeId = 0;
  #tempSequence = 0;

  get ready(): boolean {
    return this.snapshot !== null && this.view !== null;
  }

  get config(): ConfigDto {
    const config = this.snapshot?.config;
    if (!config) throw new Error('The workspace has no board loaded');
    return config;
  }

  get doc(): ViewDocument {
    const view = this.view;
    if (!view) throw new Error('The workspace has no view open');
    return view;
  }

  get pending(): Change[] {
    return this.view?.changes ?? [];
  }

  // The canvas reads these two rather than reaching into `doc`, which is what
  // lets the read-only viewer hand it a different board holder entirely.

  get members(): string[] {
    return this.view?.members ?? [];
  }

  get layout(): Record<string, NodeLayout> {
    return this.view?.layout ?? {};
  }

  /** How the canvas draws each level of the hierarchy. */
  get display(): Record<string, TypeDisplay> {
    return this.view?.display ?? {};
  }

  /**
   * Which collection this view is a canvas over.
   *
   * The one question every mode-aware surface asks, so nothing has to reach
   * into the view document for it. A template's `type` is an issue type name,
   * so it cannot say which collection is being edited — this can.
   */
  get mode(): ViewMode {
    return this.view?.mode ?? 'board';
  }

  /** The collection this view creates documents in. */
  get nodeKind(): NodeKind {
    return this.mode === 'templates' ? 'template' : 'issue';
  }

  /**
   * Whether this view plans with periods or works off the queue. A board with
   * no period types has no choice to make, so it is always the queue.
   *
   * A registry view is always on the queue: a template has no dates and never
   * will, since scheduling is decided when it is instantiated, not written.
   */
  get planning(): Planning {
    if (this.mode === 'templates') return 'queue';
    if (!this.snapshot?.config.hasPeriods) return 'queue';
    return this.view?.planning ?? 'periods';
  }

  setPlanning(planning: Planning): void {
    const view = this.doc;
    view.planning = planning;
    // The drawer remembers a tab that the other mode does not offer; sending it
    // somewhere that exists is friendlier than opening on an empty pane. And
    // choosing the queue is asking to see it, so its panel opens.
    if (planning === 'queue') {
      if (view.drawer.tab === 'periods' || view.drawer.tab === 'gantt') view.drawer.tab = 'table';
      view.queue.open = true;
    }
    this.scheduleSave();
  }

  /**
   * Draw a level as nodes, or as a badge on its children.
   *
   * A level covers several types on some boards (a story and a bug sit at the
   * same depth), and they are always set together: a level half drawn and half
   * badged is a picture nobody asked for.
   */
  setDisplay(types: string[], mode: TypeDisplay): void {
    const view = this.doc;
    const next = { ...view.display };
    for (const type of types) {
      if (mode === 'node') delete next[type];
      else next[type] = mode;
    }
    view.display = next;
    this.scheduleSave();
  }

  get dirty(): boolean {
    return this.pending.length > 0;
  }

  node(id: string): NodeDto | undefined {
    return this.nodes[id];
  }

  // -- loading -------------------------------------------------------------

  async open(viewId: string): Promise<void> {
    this.status = 'loading';
    try {
      const [snapshot, view] = await Promise.all([api.board(), api.loadView(viewId)]);
      this.snapshot = snapshot;
      this.view = view;
      this.#rebuild();
      this.#reportBoardProblems(snapshot);
    } catch (error) {
      this.report(error);
      throw error;
    } finally {
      this.status = 'idle';
    }
    // There is no manual Pull button to press instead, so the poll starts on
    // its own the moment the board is open — see the class comment.
    this.#startAutoPull();
  }

  /** Re-read the board, keeping unpushed work laid over the new snapshot. */
  async pull(silent = false): Promise<void> {
    if (!this.view) return;
    this.status = 'loading';
    try {
      this.snapshot = await api.board();
      this.#rebuild();
      if (!silent) this.notify('info', 'Pulled the latest board');
    } catch (error) {
      this.report(error);
    } finally {
      this.status = 'idle';
    }
  }

  #startAutoPull(): void {
    if (this.#pullTimer) return;
    this.#pullTimer = setInterval(() => {
      if (this.status !== 'idle') return;
      void this.#backgroundPull();
    }, AUTO_PULL_INTERVAL);
  }

  #stopAutoPull(): void {
    if (this.#pullTimer) {
      clearInterval(this.#pullTimer);
      this.#pullTimer = null;
    }
  }

  /**
   * The quiet half of the poll: re-read the board with no status flicker and
   * no notice. Nobody asked for this one — every `AUTO_PULL_INTERVAL` did —
   * so it must not read as an action the way `pull()` does when a person
   * presses something.
   */
  async #backgroundPull(): Promise<void> {
    if (!this.view) return;
    try {
      this.snapshot = await api.board();
      this.#rebuild();
    } catch {
      // A quiet poll failing is not worth interrupting anybody for; the next
      // tick tries again.
    }
  }

  /** Tear down the timers so neither outlives the view it belongs to. */
  dispose(): void {
    this.#stopAutoPull();
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    if (this.#pushTimer) clearTimeout(this.#pushTimer);
  }

  #rebuild(): void {
    const snapshot = this.snapshot;
    const view = this.view;
    if (!snapshot || !view) return;
    this.nodes = replay(
      [
        ...snapshot.issues,
        ...snapshot.periods,
        ...snapshot.resources,
        ...snapshot.squads,
        ...snapshot.templates,
      ],
      view.changes,
      snapshot.config,
    );
    this.index = buildIndex(this.nodes);
    view.members = view.members.filter((id) => this.nodes[id]);
    this.selection.retain((id) => Boolean(this.nodes[id]));
    this.#seedTempIds();
  }

  #reportBoardProblems(snapshot: BoardSnapshot): void {
    const errors = snapshot.problems.filter((problem) => problem.level === 'error');
    if (!errors.length) return;
    this.notify(
      'error',
      `The board has ${errors.length} problem${errors.length === 1 ? '' : 's'}`,
      errors.slice(0, 5).map((problem) => `${problem.path}: ${problem.message}`),
    );
  }

  // -- editing -------------------------------------------------------------

  /**
   * Apply a change to the working copy and queue it for the next push.
   *
   * There is no button left to send it: `schedulePush` debounces the actual
   * write to `.lpm` the same way `scheduleSave` debounces the view, so a run
   * of edits — a dragged slider, several fields typed in a row — collapses
   * into one push instead of one per keystroke, and lands moments later with
   * nobody having asked for it.
   */
  record(change: Change): void {
    const view = this.doc;
    applyChange(this.nodes, change, this.config, this.index);
    view.changes = appendChange(view.changes, change);
    this.schedulePush();
  }

  /**
   * Raise or clear a flag, straight to disk.
   *
   * Deliberately not a `record`: everything that goes through the queue is a
   * change to the *plan*, staged so a person can read it before it lands. A
   * flag is a report that work has stopped, addressed to whoever is looking at
   * the board — holding it in an unpushed view would defeat the whole point of
   * it, exactly as it would for a comment.
   *
   * The working copy is patched rather than reloaded so the canvas turns red
   * immediately; the next pull or push re-reads the truth from disk anyway.
   */
  async setFlag(id: string, reason: string | null, comment: string): Promise<boolean> {
    const node = this.node(id);
    if (node?.kind !== 'issue') return false;
    if (isTempId(id)) {
      this.notify('error', 'Push this issue before flagging it', [
        'It is not on the board yet.',
      ]);
      return false;
    }
    try {
      const result = await api.setFlag(id, reason, comment);
      node.flag = result.flag;
      this.notify('info', reason === null ? `Cleared the flag on ${id}` : `Flagged ${id}`);
      return true;
    } catch (error) {
      this.report(error);
      return false;
    }
  }

  /**
   * The id a new document takes until a push allocates a real one.
   *
   * A plain counter, not something derived from the pending queue: a planner
   * asks for several ids before any of them is recorded, and a derived number
   * would hand out the same one every time.
   */
  nextTempId(): string {
    do {
      this.#tempSequence += 1;
    } while (this.nodes[tempId(this.#tempSequence)]);
    return tempId(this.#tempSequence);
  }

  /** Restart the counter above anything a reopened view already holds. */
  #seedTempIds(): void {
    const numberOf = (id: string): number =>
      isTempId(id) ? Number.parseInt(id.slice('new:'.length), 10) || 0 : 0;
    const used = [
      ...Object.keys(this.nodes).map(numberOf),
      ...this.pending.map((change) => numberOf(change.id)),
    ];
    this.#tempSequence = Math.max(0, ...used);
  }

  // -- the view ------------------------------------------------------------

  setLayout(id: string, layout: Partial<NodeLayout>): void {
    const view = this.doc;
    const current = view.layout[id] ?? { x: 0, y: 0 };
    view.layout[id] = { ...current, ...layout };
    this.scheduleSave();
  }

  toggleCollapsed(id: string): void {
    this.setLayout(id, { collapsed: !this.doc.layout[id]?.collapsed });
  }

  isCollapsed(id: string): boolean {
    return this.view?.layout[id]?.collapsed === true;
  }

  /** Node, if any, whose detail dialog is open. Set by double-click. */
  dialogNodeId = $state<string | null>(null);

  onDoubleClickNode(id: string): void {
    this.dialogNodeId = id;
  }

  addMembers(ids: string[]): void {
    const view = this.doc;
    const added = ids.filter((id) => !view.members.includes(id) && this.nodes[id]);
    if (!added.length) return;
    view.members = [...view.members, ...added];
    this.scheduleSave();
  }

  removeMembers(ids: string[]): void {
    const view = this.doc;
    view.members = view.members.filter((id) => !ids.includes(id));
    this.scheduleSave();
  }

  isMember(id: string): boolean {
    return this.view?.members.includes(id) ?? false;
  }

  // -- persistence ---------------------------------------------------------

  scheduleSave(): void {
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => void this.save(), AUTOSAVE_DELAY);
  }

  /**
   * Debounce the actual write to `.lpm`, the way `scheduleSave` debounces the
   * view. Also saves the view immediately, so a push that fails — or a
   * browser closed before the debounce fires — still leaves the queue on
   * disk rather than only in memory.
   */
  schedulePush(): void {
    this.scheduleSave();
    if (this.#pushTimer) clearTimeout(this.#pushTimer);
    this.#pushTimer = setTimeout(() => void this.push(true), AUTOSAVE_DELAY);
  }

  /** Write the view file. Never touches board documents — that is `push`. */
  async save(): Promise<void> {
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = null;
    }
    const view = this.view;
    if (!view) return;
    this.status = 'saving';
    try {
      const saved = await api.saveView($state.snapshot(view) as ViewDocument);
      view.updated = saved.updated;
    } catch (error) {
      this.report(error);
    } finally {
      this.status = 'idle';
    }
  }

  /**
   * Write every pending change to the board.
   *
   * Anything the board rejects stays pending and is reported, so a push is never
   * all-or-nothing and a single bad edit cannot hold the rest hostage.
   *
   * `silent` is for `schedulePush`'s debounce: an edit that pushed itself
   * with nobody watching for it must not announce "pushed to the board"
   * every couple of seconds, but a failure is reported regardless — that is
   * exactly the moment automatic and invisible stops being the right amount
   * of quiet.
   */
  async push(silent = false): Promise<PushFailure[]> {
    if (this.#pushTimer) {
      clearTimeout(this.#pushTimer);
      this.#pushTimer = null;
    }
    const view = this.view;
    if (!view) return [];
    if (!view.changes.length) {
      if (!silent) this.notify('info', 'Nothing to push');
      return [];
    }

    this.status = 'pushing';
    try {
      const result = await api.push($state.snapshot(view) as ViewDocument);
      this.snapshot = result.board;
      this.view = { ...result.view, members: this.#remap(view.members, result.idMap) };
      this.doc.layout = Object.fromEntries(
        Object.entries(view.layout).map(([id, layout]) => [result.idMap[id] ?? id, layout]),
      );
      this.selection.set(this.#remap(this.selection.ids, result.idMap));
      this.#rebuild();

      if (result.failures.length) {
        this.notify(
          'error',
          `${result.failures.length} change${result.failures.length === 1 ? '' : 's'} could not be pushed`,
          summarizePushFailures(result.failures),
        );
      } else if (!silent) {
        this.notify('info', 'Pushed to the board');
      }
      void this.save();
      this.onPushed?.();
      return result.failures;
    } catch (error) {
      this.report(error);
      return [];
    } finally {
      this.status = 'idle';
    }
  }

  /** Swap temporary ids for the ones the push allocated. */
  #remap(ids: string[], idMap: Record<string, string>): string[] {
    return ids.map((id) => idMap[id] ?? id).filter((id) => !isTempId(id) || this.nodes[id]);
  }

  // -- notices -------------------------------------------------------------

  notify(level: Notice['level'], message: string, details?: string[]): void {
    this.#noticeId += 1;
    const notice: Notice = { id: this.#noticeId, level, message, details };
    this.notices = [...this.notices, notice];
    if (level === 'info') setTimeout(() => this.dismiss(notice.id), 4000);
  }

  report(error: unknown): void {
    if (error instanceof ApiError) this.notify('error', error.message, error.details);
    else this.notify('error', error instanceof Error ? error.message : String(error));
  }

  dismiss(id: number): void {
    this.notices = this.notices.filter((notice) => notice.id !== id);
  }
}

const KEY = Symbol('workspace');

export function provideWorkspace(workspace: Workspace): Workspace {
  return setContext(KEY, workspace);
}

export function useWorkspace(): Workspace {
  return getContext<Workspace>(KEY);
}
