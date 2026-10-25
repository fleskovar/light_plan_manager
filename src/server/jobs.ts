import { randomBytes } from 'node:crypto';
import type { BoardPaths, OperationProgress } from '../core/index.js';
import { BoardError, samePath } from '../core/index.js';
import type { StoreJobDto, StoreJobKind } from '../shared/index.js';

/**
 * The background operations of `lpm ui`: moving a board between its project
 * and the central store, backing a board up, and restoring a board from its
 * backup.
 *
 * A route starts a job and answers at once with the job (202). The job runs
 * the async version of the core operation, which copies file by file, so the
 * server keeps answering requests. Each progress report of the operation
 * updates the job. The web app reads the jobs with `GET /api/projects/jobs`
 * about twice a second while one runs, and draws a progress bar in the row of
 * the board.
 *
 * One process has one list of jobs, as it has one `BoardLauncher`: the hub
 * and every board server that it starts share it. A finished job stays in the
 * list for 10 minutes, so a page that polls late still sees the result.
 *
 * `servedBoards` holds the `BoardPaths` of each board server of the process.
 * The routes of a board server read their paths from that object on each
 * request. After a move, `followMovedBoard` writes the new paths into the
 * object, so the server serves the board from its new folder without a
 * restart.
 */

/** How long a finished job stays in the list. */
const KEEP_FINISHED_MS = 10 * 60_000;

/** What a job returns when it succeeds. */
export interface JobOutcome {
  message: string;
  notes: string[];
}

/** The work of a job. It calls `report` with each progress report of the core operation. */
export type JobWork = (report: (progress: OperationProgress) => void) => Promise<JobOutcome>;

export class StoreJobs {
  readonly #jobs: StoreJobDto[] = [];
  readonly #settled = new Map<string, Promise<StoreJobDto>>();

  /** Every job that runs, and every job that ended in the last 10 minutes, the oldest first. */
  list(now: number = Date.now()): StoreJobDto[] {
    this.#prune(now);
    return this.#jobs.map((job) => ({ ...job, notes: [...job.notes] }));
  }

  /** The job that runs for the project folder `root`, or undefined. */
  running(root: string): StoreJobDto | undefined {
    return this.#jobs.find((job) => job.state === 'running' && samePath(job.root, root));
  }

  /** The newest job of the project folder `root`, or undefined. */
  latest(root: string): StoreJobDto | undefined {
    return [...this.#jobs].reverse().find((job) => samePath(job.root, root));
  }

  /**
   * Start `work` for the board of the project folder `root`, and return the
   * job at once. A second job for a project that has a job running throws a
   * `BoardError`, because the two jobs would wait for one board lock.
   */
  start(kind: StoreJobKind, root: string, to: 'local' | 'central' | null, work: JobWork): StoreJobDto {
    const busy = this.running(root);
    if (busy) {
      throw new BoardError(`The board of ${root} is busy with a ${busy.kind} that started at ${busy.startedAt}`, [
        'Wait until it is done, then try again.',
      ]);
    }
    const job: StoreJobDto = {
      id: randomBytes(6).toString('hex'),
      kind,
      root,
      to,
      state: 'running',
      step: null,
      phase: null,
      stepIndex: 0,
      stepCount: 0,
      done: 0,
      total: 0,
      message: null,
      notes: [],
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.#jobs.push(job);
    const report = (progress: OperationProgress): void => {
      job.step = progress.step;
      job.phase = progress.phase;
      job.stepIndex = progress.stepIndex;
      job.stepCount = progress.stepCount;
      job.done = progress.done;
      job.total = progress.total;
    };
    const settled = (async () => {
      try {
        const outcome = await work(report);
        job.state = 'done';
        job.message = outcome.message;
        job.notes = outcome.notes;
      } catch (error) {
        job.state = 'failed';
        job.message = error instanceof Error ? error.message : String(error);
        job.notes = error instanceof BoardError ? [...error.details] : [];
      }
      job.finishedAt = new Date().toISOString();
      return { ...job };
    })();
    this.#settled.set(job.id, settled);
    return { ...job };
  }

  /** Resolves when the job `id` ends. For tests, and for a caller that waits. */
  settled(id: string): Promise<StoreJobDto> | undefined {
    return this.#settled.get(id);
  }

  #prune(now: number): void {
    for (let index = this.#jobs.length - 1; index >= 0; index--) {
      const job = this.#jobs[index]!;
      if (job.finishedAt !== null && now - Date.parse(job.finishedAt) > KEEP_FINISHED_MS) {
        this.#jobs.splice(index, 1);
        this.#settled.delete(job.id);
      }
    }
  }
}

/** The jobs of this process. */
export const storeJobs = new StoreJobs();

const servedBoards = new Set<BoardPaths>();

/** Register the paths of a board server. Returns the function that removes them again. */
export function registerServedBoard(paths: BoardPaths): () => void {
  servedBoards.add(paths);
  return () => {
    servedBoards.delete(paths);
  };
}

/**
 * Write the paths of the moved board into the paths of each board server that
 * served the board from `previousDir`. Returns the number of servers that
 * follow the board.
 */
export function followMovedBoard(previousDir: string, moved: BoardPaths): number {
  let count = 0;
  for (const paths of servedBoards) {
    if (!samePath(paths.lpmDir, previousDir)) continue;
    Object.assign(paths, moved);
    count++;
  }
  return count;
}
