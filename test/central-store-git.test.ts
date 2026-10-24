import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BoardPaths } from '../src/core/index.js';
import {
  ConflictError,
  GIT_OFFLINE_ENV,
  checkBoard,
  PROJECT_BOARD_BRANCH,
  USER_HOME_ENV_VAR,
  claimIssue,
  createIssue,
  createResource,
  findBoardPaths,
  findIssue,
  initBoard,
  joinGitSync,
  loadBoard,
  pullBoard,
  readStorePointer,
  setupGitSync,
} from '../src/core/index.js';

// Git sync on a central board (LPM-23, LPM-24). The board documents and their
// git repository are in `<central_store>/.lpm_central/<name>`. The project
// folder keeps only the pointer, and it is where `lpm git setup --project`
// looks for the remote of the code. A bare repository stands for the host.

const roots: string[] = [];
let home: string;
let store: string;
const savedHome = process.env[USER_HOME_ENV_VAR];

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

/** A project folder called `name` with a central board. */
function centralBoard(name = 'shop'): BoardPaths {
  const root = path.join(tempDir('lpm-parent-'), name);
  mkdirSync(root);
  return initBoard({ root, template: 'scrum', prefix: 'LP', git: true, omni: false, store: 'central' }).paths;
}

beforeEach(() => {
  delete process.env[GIT_OFFLINE_ENV];
  home = tempDir('lpm-home-');
  store = tempDir('lpm-store-');
  process.env[USER_HOME_ENV_VAR] = home;
  writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ central_store: store }));
});

afterEach(() => {
  delete process.env[GIT_OFFLINE_ENV];
  if (savedHome === undefined) delete process.env[USER_HOME_ENV_VAR];
  else process.env[USER_HOME_ENV_VAR] = savedHome;
});

afterAll(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('lpm git setup on a central board', () => {
  it('adds the remote to the repository in the central board folder', () => {
    const remote = bareRepo();
    const ada = centralBoard();

    setupGitSync(ada, { url: remote, branch: 'main' });

    expect(git(ada.lpmDir, 'remote', 'get-url', 'origin')).toBe(remote);
    expect(git(remote, 'show', 'main:config.yml')).toContain('git_sync');
    expect(existsSync(path.join(ada.root, '.lpm', '.git'))).toBe(false);
    // The pointer is not part of the shared board.
    expect(() => git(remote, 'show', 'main:project.json')).toThrow();
  });

  it('uses the remote of the project folder, on the board branch', () => {
    const remote = bareRepo();
    const ada = centralBoard();
    git(ada.root, 'init', '-q');
    git(ada.root, 'remote', 'add', 'origin', remote);

    const result = setupGitSync(ada);

    expect(result.usesProjectRepository).toBe(true);
    expect(result.branch).toBe(PROJECT_BOARD_BRANCH);
    expect(git(remote, 'branch', '--list').replace(/^[*\s]+/, '')).toBe(PROJECT_BOARD_BRANCH);
    expect(git(ada.lpmDir, 'remote', 'get-url', 'origin')).toBe(remote);
  });
});

describe('a change on a central board with git sync', () => {
  it('commits the claim in the central board folder and pushes it', () => {
    const remote = bareRepo();
    const ada = centralBoard();
    createResource(loadBoard(ada), { type: 'person', title: 'Ada' });
    createIssue(loadBoard(ada), { type: 'program', title: 'Ship it' });
    setupGitSync(ada, { url: remote, branch: 'main' });

    const board = loadBoard(findBoardPaths(ada.root)!);
    claimIssue(board, findIssue(board, 'LP-1')!, { assignee: 'RS-1' });

    expect(git(ada.lpmDir, 'log', '-1', '--format=%s')).toBe('lpm: claim LP-1');
    expect(git(remote, 'log', '-1', '--format=%s', 'main')).toBe('lpm: claim LP-1');
    expect(git(ada.lpmDir, 'status', '--porcelain')).toBe('');
  });
});

describe('two central boards on one remote', () => {
  it('refuses the second claim of one issue with ConflictError', () => {
    const remote = bareRepo();
    const ada = centralBoard('shop');
    createResource(loadBoard(ada), { type: 'person', title: 'Ada' });
    createResource(loadBoard(ada), { type: 'person', title: 'Bob' });
    createIssue(loadBoard(ada), { type: 'program', title: 'Contested' });
    setupGitSync(ada, { url: remote, branch: 'main' });

    const bobRoot = path.join(tempDir('lpm-parent-'), 'shop');
    mkdirSync(bobRoot);
    const bob = joinGitSync(bobRoot, { url: remote, branch: 'main', store: 'central' }).paths;
    pullBoard(bob);

    const adaBoard = loadBoard(ada);
    const bobBoard = loadBoard(bob);
    claimIssue(adaBoard, findIssue(adaBoard, 'LP-1')!, { assignee: 'RS-1' });

    expect(() => claimIssue(bobBoard, findIssue(bobBoard, 'LP-1')!, { assignee: 'RS-2' })).toThrow(
      ConflictError,
    );
    expect(findIssue(loadBoard(bob), 'LP-1')!.assignee).toBe('RS-1');
  });
});

describe('lpm git join into the central store', () => {
  it('clones into .lpm_central/<name> and writes the pointer and project.json', () => {
    const remote = bareRepo();
    const ada = centralBoard('shop');
    createIssue(loadBoard(ada), { type: 'program', title: 'Ship it' });
    setupGitSync(ada, { url: remote, branch: 'main' });

    const bobRoot = path.join(tempDir('lpm-parent-'), 'shop');
    mkdirSync(bobRoot);
    const joined = joinGitSync(bobRoot, { url: remote, branch: 'main', store: 'central' });

    // Ada's board took `shop`, so Bob's clone on the same computer gets `shop-2`.
    const central = path.join(store, '.lpm_central', 'shop-2');
    expect(joined.paths.lpmDir).toBe(central);
    expect(joined.paths.root).toBe(bobRoot);
    expect(readStorePointer(path.join(bobRoot, '.lpm', 'config.yml'))).toBe(central);
    expect(JSON.parse(readFileSync(path.join(central, 'project.json'), 'utf8'))).toEqual({
      project_path: bobRoot,
    });
    expect(readFileSync(path.join(central, '.gitignore'), 'utf8')).toContain('project.json');
    expect(loadBoard(findBoardPaths(bobRoot)!).issues.map((issue) => issue.title)).toEqual(['Ship it']);
    expect(git(central, 'status', '--porcelain')).toBe('');
  });

  it('excludes project.json locally when the shared board came from a local board', () => {
    const remote = bareRepo();
    const adaRoot = tempDir('lpm-local-');
    const ada = initBoard({ root: adaRoot, template: 'scrum', prefix: 'LP', git: true, omni: false }).paths;
    setupGitSync(ada, { url: remote, branch: 'main' });

    const bobRoot = path.join(tempDir('lpm-parent-'), 'shop');
    mkdirSync(bobRoot);
    const joined = joinGitSync(bobRoot, { url: remote, branch: 'main', store: 'central' });

    // The shared .gitignore is unchanged, the clone is clean, and check is quiet.
    expect(readFileSync(path.join(joined.paths.lpmDir, '.gitignore'), 'utf8')).not.toContain('project.json');
    expect(readFileSync(path.join(joined.paths.lpmDir, '.git', 'info', 'exclude'), 'utf8')).toContain('project.json');
    expect(git(joined.paths.lpmDir, 'status', '--porcelain')).toBe('');
    const problems = checkBoard(loadBoard(findBoardPaths(bobRoot)!));
    expect(problems).toEqual([]);
  });

  it('leaves no central folder and no pointer when the clone fails', () => {
    const bobRoot = path.join(tempDir('lpm-parent-'), 'shop');
    mkdirSync(bobRoot);
    const missing = path.join(tempDir('lpm-nothing-'), 'no-such-repo.git');

    expect(() => joinGitSync(bobRoot, { url: missing, branch: 'main', store: 'central' })).toThrow();

    expect(existsSync(path.join(bobRoot, '.lpm'))).toBe(false);
    const boards = path.join(store, '.lpm_central');
    expect(existsSync(boards) ? spawnSync('ls', [boards]).stdout.toString().trim() : '').toBe('');
  });
});
