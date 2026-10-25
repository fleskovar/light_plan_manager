import type { BoardStoreInfoDto, StoreJobDto } from '$shared';
import type { Confirmation } from '$lib/app/shell.svelte.js';
import { StoreJobWatcher, type Schedule } from '$features/projects/jobs.svelte.js';
import {
  ageInDays,
  ageText,
  backupConfirmation,
  backupDateText,
  moveConfirmation,
  moveLabel,
  restoreConfirmation,
} from '$features/projects/maintenance.js';

/**
 * The Storage tab of the board configuration: where the board of this server
 * is, and its backup. The tab moves the board between its project and the
 * central store, backs it up, and restores it from its backup.
 *
 * The actions are the actions of the "All projects" page, for the board of
 * this server only. They use the same routes, the same confirmations
 * (`features/projects/maintenance.ts`) and the same background jobs. After a
 * move, the server serves the board from its new folder, so the editor keeps
 * working without a restart.
 */
export interface StorageApi {
  info(): Promise<BoardStoreInfoDto>;
  jobs(): Promise<StoreJobDto[]>;
  move(lpmDir: string, to: 'local' | 'central'): Promise<StoreJobDto>;
  backup(lpmDir: string, confirm?: string): Promise<StoreJobDto>;
  restore(name: string, confirm: string): Promise<StoreJobDto>;
}

export interface StoragePanelOptions {
  now?: () => Date;
  schedule?: Schedule;
}

export class StoragePanel {
  info = $state.raw<BoardStoreInfoDto | null>(null);
  loading = $state(true);
  error = $state<string | null>(null);

  readonly watcher: StoreJobWatcher;
  readonly #api: StorageApi;
  readonly #confirm: (confirmation: Confirmation) => void;
  readonly #now: () => Date;

  /** `confirm` shows a confirmation: `shell.confirm` in the editor. */
  constructor(api: StorageApi, confirm: (confirmation: Confirmation) => void, options: StoragePanelOptions = {}) {
    this.#api = api;
    this.#confirm = confirm;
    this.#now = options.now ?? (() => new Date());
    this.watcher = new StoreJobWatcher({ jobs: () => api.jobs() }, () => void this.#reload(), { schedule: options.schedule });
  }

  /** The job of this board that runs or ended last. */
  get job(): StoreJobDto | null {
    const info = this.info;
    if (!info) return null;
    return this.watcher.jobFor(info.root) ?? info.job;
  }

  get running(): boolean {
    return this.job?.state === 'running';
  }

  get moveLabel(): string {
    return moveLabel(this.info?.store ?? 'local');
  }

  /** True when the board can move to the other store: a move to the central store needs the key `central_store`. */
  get canMove(): boolean {
    const info = this.info;
    if (!info || this.running) return false;
    return info.store === 'central' || info.centralStore !== null;
  }

  get canBackup(): boolean {
    const info = this.info;
    if (!info || this.running) return false;
    return info.store === 'central' || info.centralStore !== null;
  }

  get canRestore(): boolean {
    return Boolean(this.info?.backup) && !this.running;
  }

  /** "2026-10-25 14:03, 0 days old", or null without a backup. */
  get backupText(): string | null {
    const backup = this.info?.backup;
    if (!backup) return null;
    return `${backupDateText(backup.createdAt)}, ${ageText(ageInDays(backup.createdAt, this.#now()))} old`;
  }

  async load(): Promise<void> {
    this.loading = true;
    await this.#reload();
    this.loading = false;
    await this.watcher.poll();
  }

  requestMove(): void {
    const info = this.info;
    if (!info || !this.canMove) return;
    const to = info.store === 'local' ? 'central' : 'local';
    this.#confirm(
      moveConfirmation({
        name: info.name,
        store: info.store,
        root: info.root,
        centralStore: info.centralStore,
        backup: info.backup,
        now: this.#now(),
        onConfirm: () => void this.#start(() => this.#api.move(info.lpmDir, to)),
      }),
    );
  }

  requestBackup(): void {
    const info = this.info;
    if (!info || !this.canBackup) return;
    this.#confirm(
      backupConfirmation({
        name: info.name,
        backup: info.backup,
        now: this.#now(),
        onConfirm: (confirm) => void this.#start(() => this.#api.backup(info.lpmDir, confirm)),
      }),
    );
  }

  requestRestore(): void {
    const backup = this.info?.backup;
    if (!backup || !this.canRestore) return;
    this.#confirm(
      restoreConfirmation({
        backup,
        now: this.#now(),
        onConfirm: (confirm) => void this.#start(() => this.#api.restore(backup.name, confirm)),
      }),
    );
  }

  dispose(): void {
    this.watcher.stop();
  }

  async #start(begin: () => Promise<StoreJobDto>): Promise<void> {
    this.error = null;
    try {
      this.watcher.track(await begin());
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  async #reload(): Promise<void> {
    try {
      this.info = await this.#api.info();
      this.error = null;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }
}
