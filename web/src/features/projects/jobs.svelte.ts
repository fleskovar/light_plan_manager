import type { StoreJobDto } from '$shared';
import { jobFor } from './maintenance.js';

/**
 * The background jobs of the server (moves, backups and restores), as the
 * "All projects" page and the Storage tab of the board configuration show
 * them.
 *
 * `track` adds a job that a route just started and starts the polling. `poll`
 * reads `GET /api/projects/jobs`. While a job runs, the watcher polls again
 * after `intervalMs`. When a job that the watcher saw running has ended, the
 * watcher calls `onFinished` with it, once. The page reloads its lists there.
 */
export interface JobsApi {
  jobs(): Promise<StoreJobDto[]>;
}

export type Schedule = (callback: () => void, ms: number) => { cancel(): void };

const timerSchedule: Schedule = (callback, ms) => {
  const handle = setTimeout(callback, ms);
  return { cancel: () => clearTimeout(handle) };
};

export class StoreJobWatcher {
  /** Replaced as a whole on each poll. */
  jobs = $state.raw<StoreJobDto[]>([]);

  readonly #api: JobsApi;
  readonly #onFinished: (job: StoreJobDto) => void;
  readonly #schedule: Schedule;
  readonly #intervalMs: number;
  /** The ids of the jobs that the watcher saw running and has not reported as ended. */
  readonly #watching = new Set<string>();
  #next: { cancel(): void } | null = null;
  #stopped = false;

  constructor(
    api: JobsApi,
    onFinished: (job: StoreJobDto) => void,
    options: { schedule?: Schedule; intervalMs?: number } = {},
  ) {
    this.#api = api;
    this.#onFinished = onFinished;
    this.#schedule = options.schedule ?? timerSchedule;
    this.#intervalMs = options.intervalMs ?? 500;
  }

  /** True while a job runs. */
  get busy(): boolean {
    return this.jobs.some((job) => job.state === 'running');
  }

  /** The newest job of the project folder `root`. */
  jobFor(root: string | null): StoreJobDto | undefined {
    return jobFor(this.jobs, root);
  }

  /** The job of `root` while it runs, or undefined. */
  runningFor(root: string | null): StoreJobDto | undefined {
    const job = this.jobFor(root);
    return job?.state === 'running' ? job : undefined;
  }

  /** Add a job that was just started, and poll until it ends. */
  track(job: StoreJobDto): void {
    this.jobs = [...this.jobs.filter((other) => other.id !== job.id), job];
    if (job.state === 'running') this.#watching.add(job.id);
    this.#plan();
  }

  async poll(): Promise<void> {
    this.#next = null;
    let jobs: StoreJobDto[];
    try {
      jobs = await this.#api.jobs();
    } catch {
      // The server did not answer. Try again on the next turn.
      this.#plan();
      return;
    }
    this.jobs = jobs;
    for (const job of jobs) {
      if (job.state === 'running') this.#watching.add(job.id);
    }
    for (const id of [...this.#watching]) {
      const job = jobs.find((candidate) => candidate.id === id);
      if (job?.state === 'running') continue;
      this.#watching.delete(id);
      if (job) this.#onFinished(job);
    }
    this.#plan();
  }

  /** Stop the polling, for a page or a dialog that closes. */
  stop(): void {
    this.#stopped = true;
    this.#next?.cancel();
    this.#next = null;
  }

  #plan(): void {
    if (this.#stopped || this.#next || this.#watching.size === 0) return;
    this.#next = this.#schedule(() => void this.poll(), this.#intervalMs);
  }
}
