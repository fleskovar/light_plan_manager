import type { BoardConfig } from '../model/types.js';
import { remoteNames, remotesOffNames, gitSyncOf } from '../config/lookup.js';
import type { BoardPaths } from '../storage/paths.js';
import type { GitHost } from './hosts.js';
import { recognizeHost, sameRepositoryUrl } from './hosts.js';
import { integrate } from './integrate.js';
import { countBetween, dirtyPaths, headOf, isOwnRepo, remoteUrl, resolveRef, trackingRef } from './repo.js';
import { fetchBoard, isOffline, lastFetchOf, syncProblem } from './sync.js';
import { git } from './run.js';

/**
 * Where the board's git remote stands — one report, read by `lpm git status`,
 * `GET /api/git` and the web panel, so the three cannot describe the same
 * repository differently.
 */

/** The branch a board takes inside the project's own repository. */
export const PROJECT_BOARD_BRANCH = '_lpm_board_remote';

export interface ProjectRepository {
  /** The project repository's remote name (`origin`). */
  remote: string;
  url: string;
  host: GitHost;
}

export interface GitSyncStatus {
  enabled: boolean;
  /** Why sync cannot run here, when it is enabled but broken. */
  problem: string | null;
  /** Tracker remotes the board declares — while any exist, git sync cannot be turned on. */
  trackers: string[];
  /** Tracker remotes that are turned off (kept, and able to be turned back on). */
  remotesOff: string[];
  remote: string | null;
  branch: string | null;
  url: string | null;
  host: GitHost | null;
  /** The URL is the project's own repository: the board rides a branch of it. */
  usesProjectRepository: boolean;
  /** The project's own repository and its remote, for setup to offer. */
  project: ProjectRepository | null;
  /** Whether `.lpm` is a git repository of its own, and has a commit. */
  repository: boolean;
  committed: boolean;
  /** Whether the branch exists on the remote, as of the last fetch. */
  published: boolean;
  /** Local commits not pushed yet, and upstream commits not brought in yet. */
  ahead: number;
  behind: number;
  /** Paths with uncommitted changes. */
  uncommitted: string[];
  /** What bringing upstream in would run into, if anything. */
  conflict: { reason: 'diverged' | 'uncommitted'; paths: string[] } | null;
  offline: boolean;
  /** What this process last heard from the remote. */
  lastFetch: { at: string; error: string | null } | null;
}

/** The project repository around a board, and the remote it pushes code to. */
export function projectRepository(paths: BoardPaths): ProjectRepository | null {
  const root = paths.root;
  if (root === paths.lpmDir || !isOwnRepo(root)) return null;
  const names = git(root, ['remote']).stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const remote = names.includes('origin') ? 'origin' : names[0];
  if (!remote) return null;
  const url = remoteUrl(root, remote);
  return url ? { remote, url, host: recognizeHost(url) } : null;
}

export function gitSyncStatus(
  paths: BoardPaths,
  config: BoardConfig,
  options: { fetch?: boolean } = {},
): GitSyncStatus {
  const dir = paths.lpmDir;
  const sync = gitSyncOf(config);
  const project = projectRepository(paths);
  const repository = isOwnRepo(dir);
  const remote = sync?.remote ?? 'origin';
  const url = repository ? remoteUrl(dir, remote) : null;

  const status: GitSyncStatus = {
    enabled: sync !== null,
    problem: sync ? syncProblem(dir, sync) : null,
    trackers: remoteNames(config),
    remotesOff: remotesOffNames(config),
    remote: url || sync ? remote : null,
    branch: sync?.branch ?? null,
    url,
    host: url ? recognizeHost(url) : null,
    usesProjectRepository: Boolean(url && project && sameRepositoryUrl(url, project.url)),
    project,
    repository,
    committed: repository && headOf(dir) !== null,
    published: false,
    ahead: 0,
    behind: 0,
    uncommitted: repository ? dirtyPaths(dir) : [],
    conflict: null,
    offline: isOffline(),
    lastFetch: null,
  };
  if (!sync || status.problem) return status;

  if (options.fetch && !status.offline) fetchBoard(dir, sync);
  const memory = lastFetchOf(dir);
  status.lastFetch = memory ? { at: new Date(memory.at).toISOString(), error: memory.error } : null;

  const head = headOf(dir)!;
  const upstream = resolveRef(dir, trackingRef(sync.remote, sync.branch));
  status.published = upstream !== null;
  if (upstream) {
    status.ahead = countBetween(dir, upstream, head);
    status.behind = countBetween(dir, head, upstream);
    try {
      const preview = integrate(dir, sync, { dryRun: true });
      if (preview.kind === 'conflict') status.conflict = { reason: preview.reason, paths: preview.paths };
    } catch {
      // Unrelated histories and the like are already in `problem`-shaped
      // messages from the commands that act; the report stays readable.
    }
  } else {
    status.ahead = Number(git(dir, ['rev-list', '--count', head]).stdout.trim()) || 0;
  }
  return status;
}
