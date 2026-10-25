import type { BackupListDto, BoardBackupDto, ProjectEntryDto, StoreJobDto, ViewSummary } from '$shared';
import type { Confirmation } from '$lib/app/shell.svelte.js';
import { StoreJobWatcher, type Schedule } from './jobs.svelte.js';
import {
  ageInDays,
  ageText,
  backupConfirmation,
  backupDateText,
  jobPercent,
  jobText,
  moveConfirmation,
  moveLabel,
  projectName,
  restoreConfirmation,
  sizeText,
} from './maintenance.js';

/**
 * The "All projects" page: every project of the project index (`lpm projects`),
 * local and central, and the backups in the central store.
 *
 * The tab Projects lists the projects. Open asks the server for a board server
 * and goes to it. Reveal asks the server to show `<project>/.lpm` in the file
 * manager. Move moves the board between its project and the central store, and
 * Back up copies the board to its backup. The tab Backups lists the backups,
 * with the date and the age in days of each, and Restore overwrites a board
 * with its backup.
 *
 * Move, Back up and Restore ask for a confirmation first. Then the server runs
 * the operation in the background, and the row shows its progress
 * (`StoreJobWatcher`). Replacing a backup needs the typed word `backup`, and a
 * restore needs the typed word `restore`.
 *
 * Each row of the tab Projects has a collapsible section with the views of the
 * board. The first expand asks the server for the view list of that board
 * (`views`), and the page keeps the answer until it loads again. A click on a
 * view opens the board on that view.
 *
 * The logic is here and `ProjectsPage.svelte` only draws it, so the tests in
 * `web/test/projects-page.test.ts` need no browser.
 */

/** The project routes. `api` in `$lib/api/client.ts` provides them. */
export interface ProjectsApi {
  list(): Promise<ProjectEntryDto[]>;
  open(lpmDir: string): Promise<{ url: string }>;
  /** The views of the board in `lpmDir`, newest save first. */
  views(lpmDir: string): Promise<ViewSummary[]>;
  reveal(lpmDir: string): Promise<void>;
  backups(): Promise<BackupListDto>;
  jobs(): Promise<StoreJobDto[]>;
  move(lpmDir: string, to: 'local' | 'central'): Promise<StoreJobDto>;
  backup(lpmDir: string, confirm?: string): Promise<StoreJobDto>;
  restore(name: string, confirm: string): Promise<StoreJobDto>;
}

export type ProjectsTab = 'projects' | 'backups';

/** One row of the tab Projects. */
export interface ProjectRow extends ProjectEntryDto {
  /** The project folder, or the board folder when the project is not known. */
  folder: string;
  /** The day of the last use (`YYYY-MM-DD`), or "never". */
  lastUsedText: string;
  /** The state to show beside the name, or null for `ok`. */
  label: string | null;
  canOpen: boolean;
  canReveal: boolean;
  /** The text of the move button: "Move to central" or "Move to project". */
  moveLabel: string;
  canMove: boolean;
  /** Why the move button is off, or the target of the move. */
  moveTitle: string;
  canBackup: boolean;
  /** The backup of the project, or null. */
  backup: BoardBackupDto | null;
  /** The job of the project that runs or ended last, or null. */
  job: StoreJobDto | null;
  /** False for a board that is not at its recorded place. Its views cannot be read. */
  canListViews: boolean;
  /** True while the section with the views of the board is open. */
  expanded: boolean;
  /** The views of the board, as far as the page read them. */
  views: ProjectViews;
}

/** The views of one board, as the collapsible section of its row shows them. */
export interface ProjectViews {
  /** True while the request for the list runs. */
  loading: boolean;
  /** The message of a failed request, or null. */
  error: string | null;
  /** Null until the first request answered. */
  list: ViewSummary[] | null;
}

const NO_VIEWS: ProjectViews = { loading: false, error: null, list: null };

/** The address that shows the view `viewId` on the board server at `url`. */
export function viewUrl(url: string, viewId: string): string {
  return `${url.replace(/[/#]+$/, '')}/#/view/${encodeURIComponent(viewId)}`;
}

/** One row of the tab Backups. */
export interface BackupRow extends BoardBackupDto {
  /** The project folder name. */
  projectName: string;
  /** `YYYY-MM-DD HH:MM` in the local time zone. */
  dateText: string;
  ageDays: number;
  /** "0 days", "1 day", "12 days". */
  ageText: string;
  sizeText: string;
  canRestore: boolean;
  job: StoreJobDto | null;
}

/** The message of the last job that ended, for the page to show. */
export interface JobNotice {
  kind: 'done' | 'failed';
  message: string;
  notes: string[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ProjectsPageOptions {
  /** The time for the age of a backup. Tests pass one. */
  now?: () => Date;
  /** The timer of the job polling. Tests pass one that they run by hand. */
  schedule?: Schedule;
}

export class ProjectsPage {
  /** Replaced as a whole on each load, so it is not a deep proxy. */
  entries = $state.raw<ProjectEntryDto[]>([]);
  backupList = $state.raw<BackupListDto>({ store: null, backupsDir: null, backups: [] });
  loading = $state(true);
  /** The last failure, for the page to show. Cleared by the next action. */
  error = $state<string | null>(null);
  /** The board folder that Open or Reveal runs for, or null. */
  busy = $state<string | null>(null);
  tab = $state<ProjectsTab>('projects');
  /** The confirmation that the page shows, or null. */
  confirmation = $state<Confirmation | null>(null);
  notice = $state<JobNotice | null>(null);
  /** The board folders whose section of views is open. */
  expanded = $state.raw<ReadonlySet<string>>(new Set());
  /** The view lists that the page read, by board folder. */
  viewLists = $state.raw<Readonly<Record<string, ProjectViews>>>({});

  readonly watcher: StoreJobWatcher;
  readonly #api: ProjectsApi;
  readonly #navigate: (url: string) => void;
  readonly #now: () => Date;

  constructor(api: ProjectsApi, navigate: (url: string) => void, options: ProjectsPageOptions = {}) {
    this.#api = api;
    this.#navigate = navigate;
    this.#now = options.now ?? (() => new Date());
    this.watcher = new StoreJobWatcher({ jobs: () => api.jobs() }, (job) => void this.#finished(job), {
      schedule: options.schedule,
    });
  }

  rows = $derived.by<ProjectRow[]>(() => this.entries.map((entry) => this.#toRow(entry)));

  backupRows = $derived.by<BackupRow[]>(() =>
    this.backupList.backups.map((backup) => {
      const days = ageInDays(backup.createdAt, this.#now());
      const job = this.watcher.jobFor(backup.projectPath) ?? null;
      return {
        ...backup,
        projectName: projectName(backup.projectPath),
        dateText: backupDateText(backup.createdAt),
        ageDays: days,
        ageText: ageText(days),
        sizeText: sizeText(backup.bytes),
        canRestore: job?.state !== 'running',
        job,
      };
    }),
  );

  /** The text for an empty list, or null while loading or when projects exist. */
  get emptyText(): string | null {
    if (this.loading || this.entries.length) return null;
    return 'No projects yet. Each lpm command in a project adds it to this list.';
  }

  /** The text for an empty Backups tab, or null. */
  get backupsEmptyText(): string | null {
    if (this.loading || this.backupList.backups.length) return null;
    if (this.backupList.store === null) return 'No central store is set, so there are no backups. `lpm set central_store` names one.';
    return 'No backups yet. Back up a board on the tab Projects, or move a board: each move backs the board up first.';
  }

  #toRow(entry: ProjectEntryDto): ProjectRow {
    const ok = entry.state === 'ok' && entry.root !== null;
    const job = this.watcher.jobFor(entry.root) ?? null;
    const running = job?.state === 'running';
    const hasStore = this.backupList.store !== null;
    const backup = entry.root === null ? null : (this.backupList.backups.find((candidate) => candidate.projectPath === entry.root) ?? null);
    const toCentral = entry.store === 'local';
    const moveTitle = !ok
      ? 'The board is not at its recorded place, or its project folder is not known'
      : toCentral && !hasStore
        ? 'No central store is set. `lpm set central_store` names one.'
        : toCentral
          ? `Move the board to ${this.backupList.store}/.lpm_central`
          : `Move the board into ${entry.root}/.lpm`;
    return {
      ...entry,
      folder: entry.root ?? entry.lpmDir,
      lastUsedText: entry.lastUsed ? entry.lastUsed.slice(0, 10) : 'never',
      label: entry.state === 'ok' ? null : entry.state,
      canOpen: entry.state !== 'missing' && !running,
      canReveal: entry.state === 'ok' && entry.root !== null,
      moveLabel: moveLabel(entry.store),
      canMove: ok && !running && (!toCentral || hasStore),
      moveTitle,
      // A central board finds its store from its own folder, so only a local board needs the key.
      canBackup: ok && !running && (hasStore || entry.store === 'central'),
      backup,
      job,
      canListViews: entry.state !== 'missing',
      expanded: this.expanded.has(entry.lpmDir),
      views: this.viewLists[entry.lpmDir] ?? NO_VIEWS,
    };
  }

  async load(): Promise<void> {
    this.loading = true;
    this.error = null;
    // A new load reads each view list again when its section opens.
    this.viewLists = {};
    this.expanded = new Set();
    try {
      const [entries, backups] = await Promise.all([this.#api.list(), this.#api.backups()]);
      this.entries = entries;
      this.backupList = backups;
    } catch (error) {
      this.error = messageOf(error);
    } finally {
      this.loading = false;
    }
    await this.watcher.poll();
  }

  selectTab(tab: ProjectsTab): void {
    this.tab = tab;
  }

  #row(lpmDir: string): ProjectRow | undefined {
    return this.rows.find((row) => row.lpmDir === lpmDir);
  }

  async open(lpmDir: string): Promise<void> {
    if (!this.#row(lpmDir)?.canOpen) return;
    await this.#run(lpmDir, async () => this.#navigate((await this.#api.open(lpmDir)).url));
  }

  /** Open or close the section with the views of a board. The first open reads the list. */
  async toggleViews(lpmDir: string): Promise<void> {
    const row = this.#row(lpmDir);
    if (!row?.canListViews) return;
    const next = new Set(this.expanded);
    if (next.has(lpmDir)) {
      next.delete(lpmDir);
      this.expanded = next;
      return;
    }
    next.add(lpmDir);
    this.expanded = next;
    if (row.views.list !== null || row.views.loading) return;
    await this.reloadViews(lpmDir);
  }

  /** Read the view list of a board again. */
  async reloadViews(lpmDir: string): Promise<void> {
    this.#setViews(lpmDir, { ...(this.viewLists[lpmDir] ?? NO_VIEWS), loading: true, error: null });
    try {
      const list = await this.#api.views(lpmDir);
      this.#setViews(lpmDir, { loading: false, error: null, list });
    } catch (error) {
      this.#setViews(lpmDir, { loading: false, error: messageOf(error), list: null });
    }
  }

  /** Open the board of `lpmDir` on the view `viewId`. */
  async openView(lpmDir: string, viewId: string): Promise<void> {
    if (!this.#row(lpmDir)?.canOpen) return;
    await this.#run(lpmDir, async () => this.#navigate(viewUrl((await this.#api.open(lpmDir)).url, viewId)));
  }

  #setViews(lpmDir: string, views: ProjectViews): void {
    this.viewLists = { ...this.viewLists, [lpmDir]: views };
  }

  async reveal(lpmDir: string): Promise<void> {
    if (!this.#row(lpmDir)?.canReveal) return;
    await this.#run(lpmDir, () => this.#api.reveal(lpmDir));
  }

  /** Ask to move the board of `lpmDir` to the other store. The move starts when the reader confirms. */
  requestMove(lpmDir: string): void {
    const row = this.#row(lpmDir);
    if (!row?.canMove || row.root === null) return;
    const to = row.store === 'local' ? 'central' : 'local';
    this.confirmation = moveConfirmation({
      name: row.name,
      store: row.store,
      root: row.root,
      centralStore: this.backupList.store,
      backup: row.backup,
      now: this.#now(),
      onConfirm: () => void this.#start(() => this.#api.move(lpmDir, to)),
    });
  }

  /** Ask to back the board of `lpmDir` up. Replacing a backup needs the typed word `backup`. */
  requestBackup(lpmDir: string): void {
    const row = this.#row(lpmDir);
    if (!row?.canBackup) return;
    this.confirmation = backupConfirmation({
      name: row.name,
      backup: row.backup,
      now: this.#now(),
      onConfirm: (confirm) => void this.#start(() => this.#api.backup(lpmDir, confirm)),
    });
  }

  /** Ask to restore the board of a backup. The restore needs the typed word `restore`. */
  requestRestore(name: string): void {
    const row = this.backupRows.find((candidate) => candidate.name === name);
    if (!row?.canRestore) return;
    this.confirmation = restoreConfirmation({
      backup: row,
      now: this.#now(),
      onConfirm: (confirm) => void this.#start(() => this.#api.restore(name, confirm)),
    });
  }

  /** Close the confirmation. `accepted` runs its action. */
  resolveConfirmation(accepted: boolean): void {
    const pending = this.confirmation;
    this.confirmation = null;
    if (accepted) pending?.onConfirm(false);
  }

  /** The progress of a job, from 0 to 100, and its line of text. */
  progressOf(job: StoreJobDto): { percent: number; text: string } {
    return { percent: jobPercent(job), text: jobText(job) };
  }

  /** Stop the job polling. */
  dispose(): void {
    this.watcher.stop();
  }

  async #start(begin: () => Promise<StoreJobDto>): Promise<void> {
    this.error = null;
    this.notice = null;
    try {
      this.watcher.track(await begin());
    } catch (error) {
      this.error = messageOf(error);
    }
  }

  async #finished(job: StoreJobDto): Promise<void> {
    this.notice = { kind: job.state === 'failed' ? 'failed' : 'done', message: job.message ?? '', notes: job.notes };
    try {
      const [entries, backups] = await Promise.all([this.#api.list(), this.#api.backups()]);
      this.entries = entries;
      this.backupList = backups;
    } catch (error) {
      this.error = messageOf(error);
    }
  }

  async #run(lpmDir: string, action: () => Promise<void>): Promise<void> {
    this.error = null;
    this.busy = lpmDir;
    try {
      await action();
    } catch (error) {
      this.error = messageOf(error);
    } finally {
      this.busy = null;
    }
  }
}
