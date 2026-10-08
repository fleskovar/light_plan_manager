import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { loadBoard } from '../board/load.js';
import { gitSyncOf, remoteNames, remotesOffNames } from '../config/lookup.js';
import { moveRemoteBlocks } from '../config/remote-blocks.js';
import { loadConfig, parseConfigText } from '../config/schema.js';
import { BoardError, ConflictError } from '../errors.js';
import type { GitHost } from '../gitsync/hosts.js';
import { GIT_HOSTS, recognizeHost, sameRepositoryUrl, urlProblem } from '../gitsync/hosts.js';
import type { IntegrateResult, Resolution } from '../gitsync/integrate.js';
import { integrate } from '../gitsync/integrate.js';
import { commitFiles, currentBranch, dirtyPaths, headOf, isOwnRepo, mergeBase, remoteUrl, resolveRef, trackingRef } from '../gitsync/repo.js';
import { firstLine, git } from '../gitsync/run.js';
import { PROJECT_BOARD_BRANCH, projectRepository } from '../gitsync/status.js';
import type { PullOutcome } from '../gitsync/sync.js';
import { describeFiles, fetchBoard, isOffline, publish, pullBoard as pullShared, sharedWrite } from '../gitsync/sync.js';
import type { BoardConfig, GitSyncConfig } from '../model/types.js';
import { writeFileAtomic } from '../storage/atomic.js';
import { gitInit } from '../storage/git.js';
import { withBoardLock } from '../storage/lock.js';
import type { BoardPaths } from '../storage/paths.js';
import { boardPathsFor, CONFIG_FILE, LPM_DIR } from '../storage/paths.js';
import { renderBoardIndex } from './board-index.js';
import { ensureGitignoreEntry } from './init.js';

/**
 * Sharing a board through git, as operations: the entry points every front end
 * calls, built on the mechanism in `gitsync/`.
 *
 * `withBoardWrite` is the one way the board is written — `boardWrite` in
 * `shared.ts` and the web push replay both go through it — so whether a write
 * is committed and pushed is never a front end's decision. The rest are the
 * commands a person runs on purpose: pull, sync, set up, join, turn off.
 */

/** The board's index as it should read now, for a pull that re-applied work. */
function freshIndex(paths: BoardPaths): () => string | null {
  return () => {
    try {
      return renderBoardIndex(loadBoard(paths));
    } catch {
      return null;
    }
  };
}

function configOf(paths: BoardPaths): BoardConfig | null {
  return loadConfig(paths).config;
}

/**
 * Run `run` as the board's only writer, and — when the board is shared through
 * git — commit what it changed and push it, or undo it and refuse.
 */
export function withBoardWrite<T>(
  paths: BoardPaths,
  what: string,
  run: () => T,
  config: BoardConfig | null = configOf(paths),
): T {
  const sync = config ? gitSyncOf(config) : null;
  return withBoardLock(paths, what, () =>
    sharedWrite(paths, sync, what, run, { renderIndex: freshIndex(paths) }),
  );
}

export interface PullBoardOptions {
  /** Skip the fetch when this process fetched within this many milliseconds. */
  maxAgeMs?: number;
  /** Do not fetch; bring in what an earlier (background) fetch brought down. */
  noFetch?: boolean;
}

/**
 * Bring the latest board in from its git remote, if it has one. Never throws
 * for the network or a conflict: what happened is the outcome, and a reader
 * decides whether to carry on.
 */
export function pullBoard(paths: BoardPaths, options: PullBoardOptions = {}): PullOutcome {
  const config = configOf(paths);
  const sync = config ? gitSyncOf(config) : null;
  return pullShared(paths, sync, { ...options, renderIndex: freshIndex(paths) });
}

/** One line for a pull that a reader should hear about, or null for one they need not. */
export function describePull(outcome: PullOutcome): string | null {
  switch (outcome.kind) {
    case 'unavailable':
      return `git sync is not working here: ${outcome.error}. Run \`lpm git status\`.`;
    case 'unreachable':
      return `could not reach the board's git remote (${outcome.error}); showing the board as it was last pulled`;
    case 'conflict':
      return outcome.reason === 'uncommitted'
        ? `incoming board changes collide with uncommitted edits to ${describeFiles(outcome.paths).join(', ')}; run \`lpm git sync\``
        : `this checkout and the remote both changed ${describeFiles(outcome.paths).join(', ')}; settle it with \`lpm git sync --ours\` or \`--theirs\``;
    default:
      return null;
  }
}

function requireSync(paths: BoardPaths): { config: BoardConfig; sync: GitSyncConfig } {
  const loaded = loadConfig(paths);
  if (!loaded.config) throw new BoardError('The board config does not validate', loaded.errors);
  const sync = gitSyncOf(loaded.config);
  if (!sync) {
    throw new BoardError('This board is not shared through git', ['Run `lpm git setup` to share it.']);
  }
  return { config: loaded.config, sync };
}

export interface SyncBoardResult {
  /** The commit that saved uncommitted edits first, if there were any. */
  saved: string[];
  /** What bringing upstream in did. */
  pulled: IntegrateResult | { kind: 'offline' };
  /** Whether anything was pushed. */
  pushed: boolean;
}

/**
 * Sync now, on purpose: commit every uncommitted edit in the board folder (a
 * view the web app saved, a hand edit), bring upstream in, push. With
 * `resolve`, a conflict is settled in favour of this checkout (`ours`) or the
 * remote (`theirs`) instead of being reported.
 *
 * A conflict without `resolve` is returned, not thrown — it is the state a
 * person asked to see.
 */
export function syncBoard(paths: BoardPaths, options: { resolve?: Resolution } = {}): SyncBoardResult {
  const { sync } = requireSync(paths);
  const dir = paths.lpmDir;
  const renderIndex = freshIndex(paths);

  const saved = withBoardLock(paths, 'save local board edits', () => {
    const dirty = dirtyPaths(dir);
    if (!dirty.length) return [];
    return commitFiles(dir, dirty, 'lpm: save local board edits') ? dirty : [];
  });

  if (isOffline()) return { saved, pulled: { kind: 'offline' }, pushed: false };

  const fetched = fetchBoard(dir, sync);
  if (!fetched.ok) throw new BoardError(`Could not reach ${sync.remote}`, [fetched.error]);

  return withBoardLock(paths, 'sync the board with git', () => {
    const pulled = integrate(dir, sync, { resolve: options.resolve, renderIndex });
    if (pulled.kind === 'conflict') return { saved, pulled, pushed: false };

    const upstream = resolveRef(dir, trackingRef(sync.remote, sync.branch));
    if (upstream === headOf(dir)) return { saved, pulled, pushed: false };

    const outcome = publish(paths, sync, { resolve: options.resolve, renderIndex });
    if (outcome.kind === 'conflict') return { saved, pulled: outcome, pushed: false };
    return { saved, pulled, pushed: true };
  });
}

export interface GitUrlCheck {
  url: string;
  host: GitHost;
  /** git reached the repository with the credentials it has. */
  reachable: boolean;
  /** The branch already exists there. */
  branchExists: boolean;
  /** Why it could not be reached. */
  error: string | null;
}

/**
 * Ask a URL whether it can be pushed to, the way git will: `ls-remote`, with
 * whatever credentials git already has. Never prompts unless `interactive`.
 */
export function checkGitUrl(
  cwd: string,
  url: string,
  branch: string,
  options: { interactive?: boolean } = {},
): GitUrlCheck {
  const host = recognizeHost(url);
  const problem = urlProblem(url);
  if (problem) return { url, host, reachable: false, branchExists: false, error: problem };
  const result = git(cwd, ['ls-remote', '--heads', url.trim(), `refs/heads/${branch}`], {
    network: true,
    interactive: options.interactive,
  });
  return {
    url: url.trim(),
    host,
    reachable: result.ok,
    branchExists: result.ok && result.stdout.trim().length > 0,
    error: result.ok ? null : firstLine(result.stderr),
  };
}

function unreachable(check: GitUrlCheck): BoardError {
  return new BoardError(`Could not reach ${check.url}`, [
    check.error ?? 'git could not read it',
    `${check.host.label}: ${check.host.credentials}`,
    `Does the repository exist? ${check.host.create}`,
    'Try `git ls-remote <url>` in a terminal: whatever makes that work makes this work.',
  ]);
}

/** Edit `.lpm/config.yml` in place, keeping its comments, and refuse a result that does not validate. */
export function editConfig(paths: BoardPaths, edit: (doc: ReturnType<typeof parseDocument>) => void): void {
  const doc = parseDocument(readFileSync(paths.configPath, 'utf8'));
  edit(doc);
  const text = doc.toString();
  const parsed = parseConfigText(text);
  if (!parsed.config) throw new BoardError(`${LPM_DIR}/${CONFIG_FILE} would not validate`, parsed.errors);
  writeFileAtomic(paths.configPath, text);
}

export interface SetupGitSyncOptions {
  /** Where to push; defaults to the board's existing remote, then the project's. */
  url?: string;
  /** The git remote name inside `.lpm`; defaults to `origin`. */
  remote?: string;
  /** Defaults to `_lpm_board_remote` in the project's repository, else `main`. */
  branch?: string;
  /** Use the project's own repository even if the board has a remote already. */
  project?: boolean;
  /** A person is at a terminal and may answer a credential prompt. */
  interactive?: boolean;
  /**
   * Turn off the tracker remotes the board mirrors onto, in the same write
   * that turns git sync on. Without it a board with trackers is refused. They
   * are moved to `remotes_off:`, not removed — see `operations/remotes-off.ts`.
   */
  turnOffRemotes?: boolean;
}

export interface SetupGitSyncResult {
  url: string;
  remote: string;
  branch: string;
  host: GitHost;
  usesProjectRepository: boolean;
  /** `git init` ran. */
  initialized: boolean;
  /** Uncommitted board files were committed before sharing. */
  saved: number;
  remoteAction: 'added' | 'updated' | 'kept';
  /** The branch already held this board's history, and it was brought in. */
  joined: boolean;
  /** Tracker remotes turned off to make way, by `turnOffRemotes`. */
  turnedOff: string[];
}

/**
 * Share a board through git: make `.lpm` a repository if it is not one, point
 * it at the URL, push it, and record `git_sync` so every checkout follows.
 *
 * With no URL, the project's own repository is used, on the branch
 * `_lpm_board_remote` — the board's history rides alongside the code's in one
 * repository without ever mixing with it, because `.lpm` is a repository of its
 * own and that branch shares no commit with the code.
 */
export function setupGitSync(paths: BoardPaths, options: SetupGitSyncOptions = {}): SetupGitSyncResult {
  const loaded = loadConfig(paths);
  if (!loaded.config) throw new BoardError('The board config does not validate', loaded.errors);
  const config = loaded.config;

  // Asked for explicitly, because turning a mirror off is a decision about the
  // whole board: everybody's next sync stops writing to that tracker.
  const trackers = remoteNames(config);
  if (trackers.length && !options.turnOffRemotes) {
    throw new BoardError('This board mirrors onto a tracker, so it cannot also be shared through git', [
      `Declared tracker remotes: ${trackers.join(', ')}.`,
      'A board syncs through git or mirrors onto trackers, never both.',
      '`lpm git setup --turn-off-remotes` turns them off and shares through git instead. Nothing about them is ' +
        'deleted — links, mapping and credentials are kept — and `lpm git off --turn-on-remotes` swaps back.',
    ]);
  }

  const dir = paths.lpmDir;
  const remote = options.remote ?? config.git_sync?.remote ?? 'origin';
  const project = projectRepository(paths);
  if (options.project && !project) {
    throw new BoardError('The project folder has no git remote to share the board through', [
      `Looked for a repository at ${paths.root}. Give a URL instead: \`lpm git setup --url <url>\`.`,
    ]);
  }
  const existing = isOwnRepo(dir) ? remoteUrl(dir, remote) : null;
  const url = (options.url?.trim() || (options.project ? project?.url : undefined) || existing || project?.url) ?? '';
  if (!url) {
    throw new BoardError('Which repository should the board live in?', [
      'Give one with `lpm git setup --url <url>`. For example:',
      ...GIT_HOSTS.map((host) => `  ${host.label}: ${host.examples[0]}`),
    ]);
  }
  const usesProjectRepository = Boolean(project && sameRepositoryUrl(url, project.url));
  const branch =
    options.branch ?? (usesProjectRepository ? PROJECT_BOARD_BRANCH : config.git_sync?.branch ?? 'main');

  const check = checkGitUrl(paths.root, url, branch, { interactive: options.interactive });
  if (!check.reachable) throw unreachable(check);

  const initialized = !isOwnRepo(dir);
  if (initialized && !gitInit(dir)) throw new BoardError(`Could not run \`git init\` in ${dir}`);

  // The board as it stands is what gets shared, so commit it first.
  const saved = withBoardLock(paths, 'save the board before sharing it', () => {
    const dirty = dirtyPaths(dir);
    if (dirty.length) commitFiles(dir, dirty, 'lpm: save the board before sharing it');
    return dirty.length;
  });

  const current = remoteUrl(dir, remote);
  let remoteAction: SetupGitSyncResult['remoteAction'] = 'kept';
  if (!current) {
    const added = git(dir, ['remote', 'add', remote, check.url]);
    if (!added.ok) throw new BoardError(`Could not add the git remote "${remote}"`, [firstLine(added.stderr)]);
    remoteAction = 'added';
  } else if (!sameRepositoryUrl(current, check.url)) {
    git(dir, ['remote', 'set-url', remote, check.url]);
    remoteAction = 'updated';
  }

  const sync: GitSyncConfig = { remote, branch };
  let joined = false;
  if (check.branchExists) {
    const fetched = fetchBoard(dir, sync);
    if (!fetched.ok) throw unreachable({ ...check, reachable: false, error: fetched.error });
    const upstream = resolveRef(dir, trackingRef(remote, branch))!;
    if (!mergeBase(dir, headOf(dir)!, upstream)) {
      throw new BoardError(`${check.url} already has a branch "${branch}" holding a different board`, [
        'This board and that one share no history, so one cannot be pushed over the other.',
        `To work on the shared one, move this .lpm aside and run \`lpm git join${options.url ? ` --url ${check.url}` : ''} --branch ${branch}\`.`,
        'To share this one instead, pick another branch: `--branch <name>`.',
      ]);
    }
    const result = withBoardLock(paths, 'bring in the shared board', () =>
      integrate(dir, sync, { renderIndex: freshIndex(paths) }),
    );
    if (result.kind === 'conflict') {
      throw new ConflictError(
        `This board and ${remote}/${branch} both changed ${describeFiles(result.paths).join(', ')}`,
        ['Settle it in git inside .lpm, then run `lpm git setup` again.'],
      );
    }
    joined = true;
  }

  withBoardWrite(
    paths,
    `share the board through ${remote}/${branch}`,
    () =>
      editConfig(paths, (doc) => {
        if (trackers.length) moveRemoteBlocks(doc, trackers, 'remotes', 'remotes_off');
        doc.set('git_sync', { remote, branch });
      }),
    // The transaction must already push to where the board is going.
    { ...config, remotes: {}, git_sync: sync },
  );

  // So plain `git pull` / `git push` inside .lpm do the same thing light-plan does.
  const local = currentBranch(dir);
  if (local) git(dir, ['branch', `--set-upstream-to=${remote}/${branch}`, local]);

  return {
    url: check.url,
    remote,
    branch,
    host: check.host,
    usesProjectRepository,
    initialized,
    saved,
    remoteAction,
    joined,
    turnedOff: trackers,
  };
}

export interface JoinGitSyncOptions {
  url?: string;
  branch?: string;
  remote?: string;
  interactive?: boolean;
}

export interface JoinGitSyncResult {
  paths: BoardPaths;
  url: string;
  branch: string;
  host: GitHost;
  usesProjectRepository: boolean;
  gitignoreUpdated: boolean;
}

/**
 * Clone a shared board into a project that has none yet — the teammate's half
 * of `setupGitSync`. With no URL, the project's own repository and its
 * `_lpm_board_remote` branch.
 */
export function joinGitSync(root: string, options: JoinGitSyncOptions = {}): JoinGitSyncResult {
  const paths = boardPathsFor(root);
  const target = paths.lpmDir;
  if (existsSync(target) && readdirSync(target).length) {
    throw new BoardError(`${target} already holds a board`, [
      'Joining clones a shared board into a project that has none.',
      'To share this one instead, run `lpm git setup`. To replace it, move it aside first.',
    ]);
  }
  const project = projectRepository(paths);
  const url = options.url?.trim() || project?.url;
  if (!url) {
    throw new BoardError('Which repository holds the board?', [
      'This folder has no git remote to look in. Give one: `lpm git join --url <url>`.',
    ]);
  }
  const usesProjectRepository = Boolean(project && sameRepositoryUrl(url, project.url));
  const branch = options.branch ?? (usesProjectRepository ? PROJECT_BOARD_BRANCH : 'main');
  const remote = options.remote ?? 'origin';

  const check = checkGitUrl(root, url, branch, { interactive: options.interactive });
  if (!check.reachable) throw unreachable(check);
  if (!check.branchExists) {
    throw new BoardError(`${check.url} has no board on the branch "${branch}"`, [
      'Nobody has shared one there yet. To start one: `lpm init`, then `lpm git setup`.',
      'If it lives on another branch, name it: `--branch <name>`.',
    ]);
  }

  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  const cloned = git(
    root,
    ['clone', '--branch', branch, '--single-branch', '--origin', remote, check.url, LPM_DIR],
    { network: true, interactive: options.interactive },
  );
  if (!cloned.ok) throw new BoardError(`Could not clone ${check.url}`, [firstLine(cloned.stderr)]);
  if (!existsSync(paths.configPath)) {
    rmSync(target, { recursive: true, force: true });
    throw new BoardError(`The branch "${branch}" of ${check.url} is not a light-plan board`, [
      `It has no ${CONFIG_FILE} at its root.`,
    ]);
  }
  const gitignoreUpdated = isOwnRepo(root) ? ensureGitignoreEntry(root) : false;
  return { paths, url: check.url, branch, host: check.host, usesProjectRepository, gitignoreUpdated };
}

export interface DisableGitSyncOptions {
  /** Turn every turned-off tracker remote back on, in the same write. */
  turnOnRemotes?: boolean;
}

export interface DisableGitSyncResult {
  /** Tracker remotes turned back on. */
  turnedOn: string[];
  /** Tracker remotes still off afterwards. */
  stillOff: string[];
}

/**
 * Stop sharing the board through git, for everybody: the `git_sync` block is
 * removed and that change pushed, so teammates' next pull turns it off for
 * them too. The repository and its remote are left alone. With
 * `turnOnRemotes`, the trackers `setupGitSync` turned off come back in the
 * same commit — the swap undone in one step.
 */
export function disableGitSync(paths: BoardPaths, options: DisableGitSyncOptions = {}): DisableGitSyncResult {
  const { config } = requireSync(paths);
  const off = remotesOffNames(config);
  const turnedOn = options.turnOnRemotes ? off : [];
  withBoardWrite(
    paths,
    turnedOn.length
      ? `stop sharing the board through git, turn on ${turnedOn.join(', ')}`
      : 'stop sharing the board through git',
    () =>
      editConfig(paths, (doc) => {
        doc.delete('git_sync');
        if (turnedOn.length) moveRemoteBlocks(doc, turnedOn, 'remotes_off', 'remotes');
      }),
    config,
  );
  return { turnedOn, stillOff: off.filter((name) => !turnedOn.includes(name)) };
}
