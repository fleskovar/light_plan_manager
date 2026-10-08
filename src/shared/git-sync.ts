/**
 * Sharing the board through its own git repository, as the web app sees it.
 *
 * The shapes mirror `GitSyncStatus` and friends in `src/core/gitsync`; they
 * are restated here because this folder imports nothing, and the server maps
 * one onto the other in `server/routes/git.ts`.
 */

export type GitHostIdDto = 'github' | 'gitlab' | 'bitbucket' | 'azure' | 'other';

export interface GitHostDto {
  id: GitHostIdDto;
  label: string;
  examples: string[];
  create: string;
  credentials: string;
}

export interface GitConflictDto {
  /** `diverged`: both sides committed changes to these files. `uncommitted`: local edits are in the way. */
  reason: 'diverged' | 'uncommitted';
  paths: string[];
  /** The same, as document ids where a file belongs to one. */
  documents: string[];
}

export interface GitSyncStatusDto {
  enabled: boolean;
  problem: string | null;
  /**
   * Tracker remotes the board mirrors onto. While any are on, sharing through
   * git turns them off first (`GitSetupRequest.turnOffRemotes`), so the setup
   * form asks before it sends.
   */
  trackers: string[];
  /** Tracker remotes that are turned off — kept whole, and able to be turned back on. */
  remotesOff: string[];
  remote: string | null;
  branch: string | null;
  url: string | null;
  host: GitHostDto | null;
  usesProjectRepository: boolean;
  /** The project's own repository, which setup offers first. */
  project: { remote: string; url: string; host: GitHostDto } | null;
  repository: boolean;
  committed: boolean;
  published: boolean;
  ahead: number;
  behind: number;
  uncommitted: string[];
  conflict: GitConflictDto | null;
  offline: boolean;
  lastFetch: { at: string; error: string | null } | null;
  /** Every host setup knows how to help with, for the form's examples. */
  hosts: GitHostDto[];
  /** The branch a board takes in the project's own repository. */
  projectBranch: string;
}

export interface GitUrlCheckDto {
  url: string;
  host: GitHostDto;
  reachable: boolean;
  branchExists: boolean;
  error: string | null;
}

export interface GitSetupRequest {
  /** Omit to use the project's own repository. */
  url?: string;
  branch?: string;
  project?: boolean;
  /** Turn off the trackers the board mirrors onto. Without it, a board with trackers is refused. */
  turnOffRemotes?: boolean;
}

/** `DELETE /api/git`'s options, sent as query parameters. */
export interface GitDisableRequest {
  /** Turn the turned-off trackers back on in the same commit. */
  turnOnRemotes?: boolean;
}

export interface GitSyncRequest {
  resolve?: 'ours' | 'theirs';
}

export interface GitSyncResponse {
  saved: number;
  pulled: string;
  pushed: boolean;
  status: GitSyncStatusDto;
}
