/**
 * Sharing a board through its own git repository: the mechanism.
 *
 * `run` is the only way git is run (never waiting for a person), `repo` asks
 * the repository questions and makes the few writes this layer needs,
 * `integrate` brings fetched work into the board — fast-forward, or local work
 * laid over upstream when the two touched different files, or a conflict when
 * they touched the same one — `sync` is the network half and the write
 * transaction, `status` the report, `hosts` the help a person setting this up
 * is shown.
 *
 * The contract: when `git_sync` is configured, every operation that writes the
 * board runs inside `sharedWrite` (operations/shared.ts makes that structural),
 * so a write is either committed and pushed, or undone and refused. Nothing is
 * ever merged inside a document. Front ends call `pullBoard` before they load,
 * which keeps refusals rare; correctness does not depend on it.
 *
 * Sits between `board/` and `operations/`: it may read config and storage, and
 * the operations that set sharing up (`operations/git-sync.ts`) are built on it.
 */
export * from './hosts.js';
export type { IntegrateResult, Resolution } from './integrate.js';
export { GIT_TIMEOUT_ENV } from './run.js';
export * from './status.js';
export {
  GIT_OFFLINE_ENV,
  describeFiles,
  fetchBoardAsync,
  isOffline,
  lastFetchOf,
  type FetchResult,
  type PullOutcome,
} from './sync.js';
