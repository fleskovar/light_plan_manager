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
import {
  appendChange,
  completeView,
  isTempId,
  plansWithPeriods,
  summarizePushFailures,
  tempId,
} from '$shared';
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

/**
 * The writes that the last disposed workspace still runs. `open` waits for
 * this promise, so a view that closes and opens again loads what the closing
 * tab wrote.
 */
let settling: Promise<void> = Promise.resolve();

export interface WorkspaceOptions {
  /**
   * Reads the preference `autoSave`. With `true`, a change to the layout
   * writes the view file after `AUTOSAVE_DELAY`. With `false`, only `save`
   * writes the layout. The default always returns `true`.
   */
  autoSave?: () => boolean;
}

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
  /** True when `load` could not read the view or the board. */
  failed = $state(false);

  /**
   * True when the open view holds a change to its members, its layout, its
   * panes or its display that no save wrote to the view file. Unpushed board
   * edits do not count: `dirty` reports those.
   */
  viewDirty = $state(false);

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

  /**
   * The roster resource this checkout says is working — `lpm task next`'s
   * "me" — or null when none is set or it names nobody on the roster. Read
   * once when a view opens, best effort: a server too old to answer just
   * means the queue offers no "Me" entry.
   */
  me = $state<string | null>(null);

  /**
   * Every id a push has allocated this session, temporary → real. A dialog
   * opened on an unpushed document holds the temporary id, and the push that
   * follows every edit retires it; `resolve` is how the dialog keeps up.
   */
  #allocated = $state<Record<string, string>>({});

  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  #pushTimer: ReturnType<typeof setTimeout> | null = null;
  #pullTimer: ReturnType<typeof setInterval> | null = null;
  #noticeId = 0;
  #tempSequence = 0;

  readonly #autoSave: () => boolean;
  /** The view as the server stored it last. A write without the layout starts from it. */
  #baseline: ViewDocument | null = null;
  /** Counts the layout changes, so a save can tell that one arrived while it ran. */
  #revision = 0;
  /** False while no screen shows this workspace. The board poll then stops. */
  #watching = true;
  /** True after the view file was deleted. No write may create the file again. */
  #abandoned = false;

  constructor(options: WorkspaceOptions = {}) {
    this.#autoSave = options.autoSave ?? (() => true);
  }

  /** True when the layout waits for a Save that only the reader can give. */
  get unsaved(): boolean {
    return this.viewDirty && !this.#autoSave();
  }

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
   * Whether the board plans with its periods or works as one queue. Board
   * truth — `planning:` in config.yml, which `lpm task next` reads too — so
   * every view and every teammate sees the same mode. A board with no period
   * types has no choice to make, so it is always the queue.
   *
   * A registry view is always on the queue: a template has no dates and never
   * will, since scheduling is decided when it is instantiated, not written.
   */
  get planning(): Planning {
    if (this.mode === 'templates') return 'queue';
    const config = this.snapshot?.config;
    return config && plansWithPeriods(config) ? 'periods' : 'queue';
  }

  /** Whether the board has a choice of mode at all. */
  get canPlanWithPeriods(): boolean {
    return this.mode !== 'templates' && this.snapshot?.config.hasPeriods === true;
  }

  /**
   * Switch the board between its periods and one queue.
   *
   * Written straight through rather than queued, like a flag: it is config,
   * not a change to the plan, and `setPlanning` in core touches no document —
   * every `period:` stays where it is, so switching back is lossless. The board
   * is re-read afterwards because the snapshot's config is what every surface
   * reads the mode from.
   */
  async setPlanning(planning: Planning): Promise<boolean> {
    if (planning === this.planning) return true;
    try {
      await api.setPlanning(planning);
    } catch (error) {
      this.report(error);
      return false;
    }
    // The drawer remembers a tab that the other mode does not offer; sending it
    // somewhere that exists is friendlier than opening on an empty pane. And
    // choosing the queue is asking to see it, so its panel opens.
    const view = this.view;
    if (view && planning === 'queue') {
      if (view.drawer.tab === 'periods' || view.drawer.tab === 'gantt') view.drawer.tab = 'table';
      view.queue.open = true;
      this.scheduleSave();
    }
    await this.pull(true);
    this.notify(
      'info',
      planning === 'queue' ? 'Working the board as one queue' : 'Planning with periods and sprints.',
    );
    return true;
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

  /**
   * Give the keys of `display` the new names of renamed issue types. `renames`
   * maps an old type name to its new name, as `POST /api/config/edits` answers
   * it. The server renames the same keys in every view file, so this method
   * schedules no save. Without it, the next save of this view writes the old
   * key again, and the level turns from badges back into nodes.
   */
  renameTypes(renames: Record<string, string>): void {
    const view = this.view;
    if (!view || !Object.keys(view.display).some((type) => type in renames)) return;
    const renamed = (display: Record<string, TypeDisplay>): Record<string, TypeDisplay> =>
      Object.fromEntries(Object.entries(display).map(([type, mode]) => [renames[type] ?? type, mode]));
    view.display = renamed(view.display);
    if (this.#baseline) this.#baseline = { ...this.#baseline, display: renamed(this.#baseline.display) };
  }

  get dirty(): boolean {
    return this.pending.length > 0;
  }

  node(id: string): NodeDto | undefined {
    return this.nodes[id];
  }

  /** The id a document goes by now: a pushed temporary id becomes its real one. */
  resolve(id: string): string {
    if (this.nodes[id]) return id;
    return this.#allocated[id] ?? id;
  }

  // -- loading -------------------------------------------------------------

  async open(viewId: string): Promise<void> {
    this.status = 'loading';
    try {
      await settling;
      const [snapshot, view] = await Promise.all([api.board(), api.loadView(viewId)]);
      this.snapshot = snapshot;
      this.#baseline = completeView(view);
      this.view = structuredClone(this.#baseline);
      this.viewDirty = false;
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
    if (this.#watching) this.#startAutoPull();
    void api
      .me()
      .then((user) => (this.me = user.id))
      .catch(() => {});
  }

  /** Open the view and record a failure in `failed`, for a caller that cannot await. */
  load(viewId: string): void {
    this.failed = false;
    void this.open(viewId).catch(() => {
      this.failed = true;
    });
  }

  /**
   * A screen shows this workspace again. The workspace reads the board once
   * and restarts the poll that `suspend` stopped.
   */
  resume(): void {
    this.#watching = true;
    if (!this.ready) return;
    void this.#backgroundPull();
    this.#startAutoPull();
  }

  /**
   * No screen shows this workspace, but its tab is still open. The poll stops.
   * A pending save and a pending push still run on their timers.
   */
  suspend(): void {
    this.#watching = false;
    this.#stopAutoPull();
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

  /**
   * Stop the poll and run the pending writes now, so neither timer outlives
   * the tab. With `deleted`, the view file is gone: the pending push still
   * writes the board, and nothing writes the view file again.
   */
  dispose(options: { deleted?: boolean } = {}): void {
    this.#stopAutoPull();
    if (options.deleted) this.#abandoned = true;
    settling = this.flush();
  }

  /** Run the pending push and the pending save now, and wait for both. */
  async flush(): Promise<void> {
    if (this.#pushTimer !== null) await this.push(true);
    if (this.#saveTimer !== null) await this.#write(this.#autoSave());
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

  /**
   * Restart the counter above anything a reopened view already holds.
   *
   * Never below where it was: a temporary id names one document for the whole
   * session, so `resolve` cannot confuse a pushed `new:1` with a later one.
   */
  #seedTempIds(): void {
    const numberOf = (id: string): number =>
      isTempId(id) ? Number.parseInt(id.slice('new:'.length), 10) || 0 : 0;
    const used = [
      ...Object.keys(this.nodes).map(numberOf),
      ...this.pending.map((change) => numberOf(change.id)),
    ];
    this.#tempSequence = Math.max(this.#tempSequence, ...used);
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

  /**
   * Record a change to the layout of the view. When the preference `autoSave`
   * holds `true`, the view file is written `AUTOSAVE_DELAY` later. When it
   * holds `false`, the change waits for `save`.
   */
  scheduleSave(): void {
    this.viewDirty = true;
    this.#revision += 1;
    if (this.#autoSave()) this.#armSave();
  }

  #armSave(): void {
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => void this.#write(this.#autoSave()), AUTOSAVE_DELAY);
  }

  /**
   * Debounce the actual write to `.lpm`, the way `scheduleSave` debounces the
   * view. The queue is also written to the view file on the same delay, so a
   * push that fails still leaves the queue on disk rather than only in
   * memory. That write happens whatever `autoSave` holds: with `false` it
   * carries the queue and leaves the saved layout as it was.
   */
  schedulePush(): void {
    this.#armSave();
    if (this.#pushTimer) clearTimeout(this.#pushTimer);
    this.#pushTimer = setTimeout(() => void this.push(true), AUTOSAVE_DELAY);
  }

  /**
   * Write the whole view to its file, layout included. Never touches board
   * documents — that is `push`. This is the Save of the File menu and Ctrl+S.
   */
  async save(): Promise<boolean> {
    return this.#write(true);
  }

  /**
   * The document that a write sends. With `full`, it is the view as the
   * screen shows it. Without `full`, it is the last stored view with the
   * current queue, so the write does not save a layout that nobody saved.
   */
  #outgoing(full: boolean): ViewDocument {
    const live = $state.snapshot(this.doc) as ViewDocument;
    if (full || !this.#baseline) return live;
    return { ...this.#baseline, changes: live.changes };
  }

  async #write(full: boolean): Promise<boolean> {
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = null;
    }
    const view = this.view;
    if (!view || this.#abandoned) return false;
    const revision = this.#revision;
    this.status = 'saving';
    try {
      const saved = await api.saveView(this.#outgoing(full));
      view.updated = saved.updated;
      this.#baseline = saved;
      // A layout change that arrived during the request is still unsaved.
      if (full && revision === this.#revision) this.viewDirty = false;
      return true;
    } catch (error) {
      this.report(error);
      return false;
    } finally {
      this.status = 'idle';
    }
  }

  /**
   * Give the view another name. The id and the file name stay, so open tabs
   * and saved addresses keep working. The write does not save the layout.
   */
  async rename(name: string): Promise<boolean> {
    const view = this.doc;
    const previous = view.name;
    view.name = name;
    if (this.#baseline) this.#baseline = { ...this.#baseline, name };
    if (await this.#write(this.#autoSave())) return true;
    view.name = previous;
    if (this.#baseline) this.#baseline = { ...this.#baseline, name: previous };
    return false;
  }

  /**
   * Create a view with this name that holds the members, the layout, the
   * panes and the display of the open view. Returns the id of the new view,
   * or null when the server refused. The queue of unpushed changes stays with
   * the open view: two views that hold the same queue push every change twice.
   * The pending push runs first, so the copy holds the ids that the board
   * allocated and no temporary id.
   */
  async saveCopy(name: string): Promise<string | null> {
    try {
      await this.flush();
      const created = await api.createView(name, this.mode);
      const live = $state.snapshot(this.doc) as ViewDocument;
      await api.saveView({
        ...live,
        id: created.id,
        name: created.name,
        created: created.created,
        changes: [],
      });
      return created.id;
    } catch (error) {
      this.report(error);
      return null;
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
      // The server stores the view that it receives. Without auto-save the
      // request carries the saved layout, so a push does not save the layout.
      const autoSave = this.#autoSave();
      const result = await api.push(this.#outgoing(autoSave));
      this.snapshot = result.board;
      this.#baseline = result.view;
      this.view = completeView({
        ...($state.snapshot(view) as ViewDocument),
        changes: result.view.changes,
        updated: result.view.updated,
        members: this.#remap(view.members, result.idMap),
        layout: Object.fromEntries(
          Object.entries(view.layout).map(([id, layout]) => [result.idMap[id] ?? id, layout]),
        ),
      });
      this.selection.set(this.#remap(this.selection.ids, result.idMap));
      if (Object.keys(result.idMap).length) {
        this.#allocated = { ...this.#allocated, ...result.idMap };
      }
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
      this.onPushed?.();
      // The members and the layout now carry the ids that the push allocated.
      if (autoSave) await this.#write(true);
      else if (this.#saveTimer) {
        // The server stored the queue with this push, so the pending write has nothing to add.
        clearTimeout(this.#saveTimer);
        this.#saveTimer = null;
      }
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
