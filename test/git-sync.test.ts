import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BoardPaths } from '../src/core/index.js';
import {
  BoardError,
  ConflictError,
  GIT_OFFLINE_ENV,
  PROJECT_BOARD_BRANCH,
  claimIssue,
  createIssue,
  createPeriod,
  createResource,
  disableGitSync,
  findIssue,
  gitSyncStatus,
  initBoard,
  joinGitSync,
  loadBoard,
  loadConfig,
  parseConfigText,
  pullBoard,
  setupGitSync,
  syncBoard,
  turnRemoteOn,
  turnRemotesOff,
  updateNode,
} from '../src/core/index.js';
import { removeRemote } from '../src/remote/config-file.js';

/**
 * Sharing a board through git, end to end: a bare repository in the temp
 * folder stands for GitHub, and two clones of it stand for two people.
 *
 * Every test here runs real git. Nothing is faked, because the failures this
 * layer exists to prevent — two claims both landing, an edit overwriting
 * somebody else's — only happen between real processes on a real remote.
 */

const roots: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function bareRepo(): string {
  const dir = tempDir('lpm-bare-');
  git(dir, 'init', '--bare', '-q');
  return dir;
}

/** A project folder with a board in it, `.lpm` its own repository. */
function newBoard(): BoardPaths {
  const root = tempDir('lpm-gitsync-');
  return initBoard({ root, template: 'scrum', prefix: 'LP', git: true }).paths;
}

/** Ada sets the board up on `remote`; Bob joins it from a second project. */
function team(): { remote: string; ada: BoardPaths; bob: BoardPaths } {
  const remote = bareRepo();
  const ada = newBoard();
  const board = loadBoard(ada);
  createResource(board, { type: 'person', title: 'Ada' });
  createResource(loadBoard(ada), { type: 'person', title: 'Bob' });
  createIssue(loadBoard(ada), { type: 'program', title: 'Ship it' });
  setupGitSync(ada, { url: remote, branch: 'main' });
  const bob = joinGitSync(tempDir('lpm-gitsync-bob-'), { url: remote, branch: 'main' }).paths;
  return { remote, ada, bob };
}

function remoteHead(remote: string, branch = 'main'): string {
  return git(remote, 'rev-parse', `refs/heads/${branch}`);
}

function fileAtRemote(remote: string, file: string, branch = 'main'): string {
  return git(remote, 'show', `${branch}:${file}`);
}

beforeEach(() => {
  delete process.env[GIT_OFFLINE_ENV];
});

afterEach(() => {
  delete process.env[GIT_OFFLINE_ENV];
});

afterAll(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('setting up', () => {
  it('pushes the board and records git_sync, so every clone follows', () => {
    const { remote, bob } = team();
    const config = parseConfigText(fileAtRemote(remote, 'config.yml')).config!;
    expect(config.git_sync).toEqual({ remote: 'origin', branch: 'main' });
    // Bob's clone is a working board with the same documents.
    expect(loadBoard(bob).issues.map((issue) => issue.title)).toEqual(['Ship it']);
  });

  it('defaults to the project repository, on its own branch', () => {
    const remote = bareRepo();
    const ada = newBoard();
    // The project itself is a repository that pushes its code to `remote`.
    git(ada.root, 'init', '-q');
    git(ada.root, 'remote', 'add', 'origin', remote);

    const result = setupGitSync(ada);
    expect(result.usesProjectRepository).toBe(true);
    expect(result.branch).toBe(PROJECT_BOARD_BRANCH);
    expect(fileAtRemote(remote, 'config.yml', PROJECT_BOARD_BRANCH)).toContain(PROJECT_BOARD_BRANCH);
    // The code's branches are untouched: the board branch is the only one.
    expect(git(remote, 'branch', '--list').replace(/^[*\s]+/, '')).toBe(PROJECT_BOARD_BRANCH);

    // A teammate with a clone of the project joins with no arguments at all.
    const teammate = tempDir('lpm-gitsync-teammate-');
    git(teammate, 'init', '-q');
    git(teammate, 'remote', 'add', 'origin', remote);
    const joined = joinGitSync(teammate);
    expect(joined.branch).toBe(PROJECT_BOARD_BRANCH);
    expect(joined.gitignoreUpdated).toBe(true);
    expect(readFileSync(path.join(teammate, '.gitignore'), 'utf8')).toContain('.lpm/');
    expect(loadConfig(joined.paths).config!.git_sync?.branch).toBe(PROJECT_BOARD_BRANCH);
  });

  it('refuses while the board mirrors onto a tracker', () => {
    const ada = newBoard();
    const text = readFileSync(ada.configPath, 'utf8');
    writeFileSync(
      ada.configPath,
      `${text}\nremotes:\n  tracker:\n    provider: jsonfile\n    direction: both\n    on_delete: unlink\n    conflict: manual\n`,
    );
    expect(() => setupGitSync(ada, { url: bareRepo() })).toThrow(/cannot also be shared through git/);
  });

  it('refuses a branch that holds a different board', () => {
    const { remote } = team();
    const stranger = newBoard();
    expect(() => setupGitSync(stranger, { url: remote, branch: 'main' })).toThrow(/different board/);
  });

  it('refuses an unreachable URL without changing the board', () => {
    const ada = newBoard();
    const missing = path.join(os.tmpdir(), 'lpm-no-such-repo', 'board.git');
    expect(() => setupGitSync(ada, { url: missing })).toThrow(BoardError);
    expect(loadConfig(ada).config!.git_sync).toBeNull();
  });
});

describe('config', () => {
  it('will not hold git_sync and tracker remotes together', () => {
    const base = readFileSync(path.join('templates', 'blank.yml'), 'utf8');
    const result = parseConfigText(
      `${base}\ngit_sync:\n  remote: origin\n  branch: main\nremotes:\n  jira:\n    provider: jira\n    direction: both\n    on_delete: unlink\n    conflict: manual\n`,
    );
    expect(result.config).toBeNull();
    expect(result.errors.join('\n')).toMatch(/git_sync and remotes/);
  });

  it('reserves "git" as a tracker remote name', () => {
    const base = readFileSync(path.join('templates', 'blank.yml'), 'utf8');
    const result = parseConfigText(
      `${base}\nremotes:\n  git:\n    provider: jsonfile\n    direction: both\n    on_delete: unlink\n    conflict: manual\n`,
    );
    expect(result.errors.join('\n')).toMatch(/"git" is reserved/);
  });
});

describe('every write is committed and pushed', () => {
  it('lands on the remote with the operation as its message', () => {
    const { remote, ada } = team();
    const issue = findIssue(loadBoard(ada), 'LP-1')!;
    updateNode(loadBoard(ada), issue, { title: 'Ship it now' });
    expect(git(remote, 'log', '-1', '--format=%s', 'main')).toBe('lpm: update LP-1');
    expect(fileAtRemote(remote, 'board/LP-1/_issue.md')).toContain('Ship it now');
  });

  it('commits only what the operation wrote, leaving other edits alone', () => {
    const { remote, ada } = team();
    const scratch = path.join(ada.lpmDir, 'views', 'scratch.json');
    mkdirSync(path.dirname(scratch), { recursive: true });
    writeFileSync(scratch, '{"draft":true}\n');
    createIssue(loadBoard(ada), { type: 'program', title: 'Second' });
    expect(git(remote, 'show', '--name-only', '--format=', 'main')).not.toContain('views/scratch.json');
    expect(readFileSync(scratch, 'utf8')).toBe('{"draft":true}\n');
  });
});

describe('two people at once', () => {
  it('refuses the second claim on one issue, and leaves the first standing', () => {
    const { remote, ada, bob } = team();
    createIssue(loadBoard(ada), { type: 'program', title: 'Contested' });
    pullBoard(bob);

    // Both look at the board while LP-2 is free.
    const adaBoard = loadBoard(ada);
    const bobBoard = loadBoard(bob);

    claimIssue(adaBoard, findIssue(adaBoard, 'LP-2')!, { assignee: 'RS-1' });
    const before = remoteHead(remote);

    expect(() => claimIssue(bobBoard, findIssue(bobBoard, 'LP-2')!, { assignee: 'RS-2' })).toThrow(
      ConflictError,
    );
    // Nothing of Bob's reached the remote, and his board now shows Ada's claim.
    expect(remoteHead(remote)).toBe(before);
    expect(findIssue(loadBoard(bob), 'LP-2')!.assignee).toBe('RS-1');
    expect(git(bob.lpmDir, 'status', '--porcelain')).toBe('');

    // Asking again is answered by the claim itself: somebody holds it.
    const fresh = loadBoard(bob);
    expect(() => claimIssue(fresh, findIssue(fresh, 'LP-2')!, { assignee: 'RS-2' })).toThrow(/Ada/);
  });

  it('lets edits to different documents both land', () => {
    const { remote, ada, bob } = team();
    createIssue(loadBoard(ada), { type: 'program', title: 'Two' });
    pullBoard(bob);

    const adaBoard = loadBoard(ada);
    const bobBoard = loadBoard(bob);
    updateNode(adaBoard, findIssue(adaBoard, 'LP-1')!, { title: 'One, by Ada' });
    updateNode(bobBoard, findIssue(bobBoard, 'LP-2')!, { title: 'Two, by Bob' });

    expect(fileAtRemote(remote, 'board/LP-1/_issue.md')).toContain('One, by Ada');
    expect(fileAtRemote(remote, 'board/LP-2/_issue.md')).toContain('Two, by Bob');
    // History stays a line: Bob's change was laid on top of Ada's.
    expect(git(remote, 'rev-list', '--merges', '--count', 'main')).toBe('0');
    pullBoard(ada);
    expect(findIssue(loadBoard(ada), 'LP-2')!.title).toBe('Two, by Bob');
  });

  it('merges the id counters when both create different kinds of document', () => {
    const { remote, ada, bob } = team();
    const adaBoard = loadBoard(ada);
    const bobBoard = loadBoard(bob);
    createIssue(adaBoard, { type: 'program', title: 'From Ada' });
    createPeriod(bobBoard, { type: 'increment', title: 'PI 1', starts: '2026-10-01', ends: '2026-12-31' });

    const state = JSON.parse(fileAtRemote(remote, 'state.json')) as Record<string, number>;
    expect(state.counter).toBe(2);
    expect(state.period_counter).toBe(1);
    const index = fileAtRemote(remote, 'INDEX.md');
    expect(index).toContain('From Ada');
    expect(index).toContain('PI 1');
  });

  it('refuses two creates that allocated the same id', () => {
    const { ada, bob } = team();
    const adaBoard = loadBoard(ada);
    const bobBoard = loadBoard(bob);
    createIssue(adaBoard, { type: 'program', title: 'From Ada' });
    expect(() => createIssue(bobBoard, { type: 'program', title: 'From Bob' })).toThrow(/LP-2/);
    expect(findIssue(loadBoard(bob), 'LP-2')!.title).toBe('From Ada');
  });
});

describe('without the remote', () => {
  it('refuses a write it cannot share, and changes nothing', () => {
    const { remote, ada } = team();
    const moved = `${remote}-away`;
    renameSync(remote, moved);
    try {
      const board = loadBoard(ada);
      const head = git(ada.lpmDir, 'rev-parse', 'HEAD');
      expect(() => updateNode(board, findIssue(board, 'LP-1')!, { title: 'Lost' })).toThrow(/Nothing was changed/);
      expect(git(ada.lpmDir, 'rev-parse', 'HEAD')).toBe(head);
      expect(findIssue(loadBoard(ada), 'LP-1')!.title).toBe('Ship it');
      expect(git(ada.lpmDir, 'status', '--porcelain')).toBe('');
    } finally {
      renameSync(moved, remote);
    }
  });

  it('commits locally under LPM_GIT_OFFLINE, and the next sync pushes', () => {
    const { remote, ada } = team();
    const before = remoteHead(remote);
    process.env[GIT_OFFLINE_ENV] = '1';
    const board = loadBoard(ada);
    updateNode(board, findIssue(board, 'LP-1')!, { title: 'Offline edit' });
    expect(remoteHead(remote)).toBe(before);
    expect(gitSyncStatus(ada, loadConfig(ada).config!).ahead).toBe(1);

    delete process.env[GIT_OFFLINE_ENV];
    const result = syncBoard(ada);
    expect(result.pushed).toBe(true);
    expect(fileAtRemote(remote, 'board/LP-1/_issue.md')).toContain('Offline edit');
  });
});

describe('conflicts are settled like in any repository', () => {
  function diverged(): { remote: string; ada: BoardPaths; bob: BoardPaths } {
    const shared = team();
    // Bob edits LP-1 offline; Ada edits it online.
    process.env[GIT_OFFLINE_ENV] = '1';
    const bobBoard = loadBoard(shared.bob);
    updateNode(bobBoard, findIssue(bobBoard, 'LP-1')!, { title: 'Bob says' });
    delete process.env[GIT_OFFLINE_ENV];
    const adaBoard = loadBoard(shared.ada);
    updateNode(adaBoard, findIssue(adaBoard, 'LP-1')!, { title: 'Ada says' });
    return shared;
  }

  it('reports the contested documents and moves nothing', () => {
    const { bob } = diverged();
    const outcome = pullBoard(bob);
    expect(outcome).toMatchObject({ kind: 'conflict', reason: 'diverged' });
    expect(findIssue(loadBoard(bob), 'LP-1')!.title).toBe('Bob says');
    const status = gitSyncStatus(bob, loadConfig(bob).config!);
    expect(status.conflict?.paths).toEqual(['board/LP-1/_issue.md']);
  });

  it('keeps ours with --ours', () => {
    const { remote, bob } = diverged();
    const result = syncBoard(bob, { resolve: 'ours' });
    expect(result.pushed).toBe(true);
    expect(fileAtRemote(remote, 'board/LP-1/_issue.md')).toContain('Bob says');
  });

  it('takes theirs with --theirs', () => {
    const { remote, bob } = diverged();
    syncBoard(bob, { resolve: 'theirs' });
    expect(findIssue(loadBoard(bob), 'LP-1')!.title).toBe('Ada says');
    expect(fileAtRemote(remote, 'board/LP-1/_issue.md')).toContain('Ada says');
  });

  it('reports uncommitted edits in the way of a pull, and sync commits them', () => {
    const { ada, bob } = team();
    const file = path.join(bob.lpmDir, 'board', 'LP-1', '_issue.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace('Ship it', 'Hand edit'));
    const adaBoard = loadBoard(ada);
    updateNode(adaBoard, findIssue(adaBoard, 'LP-1')!, { title: 'Ada again' });

    expect(pullBoard(bob)).toMatchObject({ kind: 'conflict', reason: 'uncommitted' });
    const result = syncBoard(bob);
    expect(result.saved).toEqual(['board/LP-1/_issue.md']);
    expect(result.pulled).toMatchObject({ kind: 'conflict', reason: 'diverged' });
  });
});

describe('turning it off', () => {
  it('removes git_sync for everybody', () => {
    const { remote, ada, bob } = team();
    disableGitSync(ada);
    expect(fileAtRemote(remote, 'config.yml')).not.toContain('git_sync');
    pullBoard(bob);
    expect(loadConfig(bob).config!.git_sync).toBeNull();
    expect(existsSync(path.join(bob.lpmDir, '.git'))).toBe(true);
  });
});

describe('swapping a tracker for git, and back', () => {
  const DECLARATION =
    '\nremotes:\n  # the team tracker\n  tracker:\n    provider: jsonfile\n    direction: both\n' +
    '    on_delete: unlink\n    conflict: manual\n    connection:\n      file: remotes/tracker/tracker.json\n';
  const LINKS = '{"version":1,"links":{"LP-1":{"remoteId":"7","syncedAt":"2026-10-01T00:00:00.000Z"}}}\n';

  /** A board mirroring onto a tracker, with the state a few syncs leave behind. */
  function mirrored(): BoardPaths {
    const paths = newBoard();
    writeFileSync(paths.configPath, `${readFileSync(paths.configPath, 'utf8')}${DECLARATION}`);
    mkdirSync(path.join(paths.remotesDir, 'tracker'), { recursive: true });
    writeFileSync(path.join(paths.remotesDir, 'tracker', 'links.json'), LINKS);
    writeFileSync(path.join(paths.remotesDir, 'tracker', 'credentials.json'), '{"token":"secret"}\n');
    return paths;
  }

  const links = (paths: BoardPaths): string =>
    readFileSync(path.join(paths.remotesDir, 'tracker', 'links.json'), 'utf8');

  it('refuses without being asked, names the way through, and changes nothing', () => {
    const ada = mirrored();
    const before = readFileSync(ada.configPath, 'utf8');
    let error: BoardError | null = null;
    try {
      setupGitSync(ada, { url: bareRepo() });
    } catch (caught) {
      error = caught as BoardError;
    }
    expect(error?.details.join('\n')).toMatch(/--turn-off-remotes/);
    expect(readFileSync(ada.configPath, 'utf8')).toBe(before);
  });

  it('turns the tracker off whole and shares through git, for everybody', () => {
    const ada = mirrored();
    const declared = loadConfig(ada).config!.remotes.tracker;
    const remote = bareRepo();

    const result = setupGitSync(ada, { url: remote, branch: 'main', turnOffRemotes: true });

    expect(result.turnedOff).toEqual(['tracker']);
    const config = loadConfig(ada).config!;
    expect(config.git_sync).toEqual({ remote: 'origin', branch: 'main' });
    expect(config.remotes).toEqual({});
    expect(config.remotes_off.tracker).toEqual(declared);
    // The comment travels with the declaration; the state is not touched.
    expect(readFileSync(ada.configPath, 'utf8')).toMatch(/remotes_off:\n {2}# the team tracker\n {2}tracker:/);
    expect(links(ada)).toBe(LINKS);
    expect(gitSyncStatus(ada, config).remotesOff).toEqual(['tracker']);
    // Pushed, so a teammate who joins sees it off too.
    expect(fileAtRemote(remote, 'config.yml')).toContain('remotes_off:');
    const bob = joinGitSync(tempDir('lpm-swap-bob-'), { url: remote, branch: 'main' }).paths;
    expect(loadConfig(bob).config!.remotes_off.tracker).toEqual(declared);
  });

  it('will not turn a tracker on while git sync is on, and says how to swap back', () => {
    const ada = mirrored();
    setupGitSync(ada, { url: bareRepo(), branch: 'main', turnOffRemotes: true });
    expect(() => turnRemoteOn(ada, 'tracker')).toThrow(/shared through git/);
    expect(loadConfig(ada).config!.remotes_off.tracker).toBeDefined();
  });

  it('swaps back in one step: git off, the tracker on exactly as it was', () => {
    const ada = mirrored();
    const declared = loadConfig(ada).config!.remotes.tracker;
    const remote = bareRepo();
    setupGitSync(ada, { url: remote, branch: 'main', turnOffRemotes: true });

    const result = disableGitSync(ada, { turnOnRemotes: true });

    expect(result).toEqual({ turnedOn: ['tracker'], stillOff: [] });
    const config = loadConfig(ada).config!;
    expect(config.git_sync).toBeNull();
    expect(config.remotes.tracker).toEqual(declared);
    expect(config.remotes_off).toEqual({});
    expect(readFileSync(ada.configPath, 'utf8')).not.toContain('remotes_off');
    expect(readFileSync(ada.configPath, 'utf8')).toContain('# the team tracker');
    expect(links(ada)).toBe(LINKS);
    // The one commit carried both halves of the swap to everybody.
    expect(fileAtRemote(remote, 'config.yml')).not.toContain('git_sync');
    expect(fileAtRemote(remote, 'config.yml')).toMatch(/remotes:\n {2}# the team tracker/);
  });

  it('leaves the tracker off when git is turned off without asking for it', () => {
    const ada = mirrored();
    setupGitSync(ada, { url: bareRepo(), branch: 'main', turnOffRemotes: true });
    expect(disableGitSync(ada)).toEqual({ turnedOn: [], stillOff: ['tracker'] });
    expect(loadConfig(ada).config!.remotes_off.tracker).toBeDefined();
    turnRemoteOn(ada, 'tracker');
    expect(loadConfig(ada).config!.remotes.tracker).toBeDefined();
  });

  it('turns a tracker off and on without git at all', () => {
    const ada = mirrored();
    const declared = loadConfig(ada).config!.remotes.tracker;
    expect(turnRemotesOff(ada)).toEqual(['tracker']);
    expect(() => turnRemotesOff(ada, ['tracker'])).toThrow(/already off/);
    expect(() => turnRemoteOn(ada, 'nope')).toThrow(/No turned-off remote named "nope"/);
    turnRemoteOn(ada, 'tracker');
    expect(() => turnRemoteOn(ada, 'tracker')).toThrow(/already on/);
    expect(loadConfig(ada).config!.remotes.tracker).toEqual(declared);
    expect(links(ada)).toBe(LINKS);
  });

  it('removes a turned-off tracker for good only when asked to', () => {
    const ada = mirrored();
    turnRemotesOff(ada, ['tracker']);
    removeRemote(ada, { name: 'tracker' });
    expect(loadConfig(ada).config!.remotes_off).toEqual({});
    expect(readFileSync(ada.configPath, 'utf8')).not.toContain('remotes_off');
    expect(links(ada)).toBe(LINKS);
  });

  it('is a config git sync may hold, and one name may not be both on and off', () => {
    const base = readFileSync(path.join('templates', 'blank.yml'), 'utf8');
    const block = '    provider: jsonfile\n    direction: both\n    on_delete: unlink\n    conflict: manual\n';
    const withGit = parseConfigText(
      `${base}\ngit_sync:\n  remote: origin\n  branch: main\nremotes_off:\n  jira:\n${block}`,
    );
    expect(withGit.errors).toEqual([]);
    const both = parseConfigText(`${base}\nremotes:\n  jira:\n${block}remotes_off:\n  jira:\n${block}`);
    expect(both.errors.join('\n')).toMatch(/also declared under remotes_off/);
  });
});
