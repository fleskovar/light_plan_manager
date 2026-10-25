import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BoardPaths } from '../src/core/index.js';
import {
  BoardError,
  LOCK_TIMEOUT_ENV,
  USER_HOME_ENV_VAR,
  addComment,
  createIssue,
  findBoardPaths,
  findIssue,
  initBoard,
  loadBoard,
  readLockHolder,
  readStorePointer,
  relocateBoard,
} from '../src/core/index.js';
import { toSnapshot } from '../src/sync/index.js';

// `relocateBoard` moves a board from its project to the central store and back
// (LPM-27). The move keeps every file of the board, its git history, and its
// per-checkout files, and a failed move leaves the board where it was.

const scratch: string[] = [];
let home: string;
let store: string;
const savedHome = process.env[USER_HOME_ENV_VAR];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A local board with two issues, a comment, a view, local.json, credentials.json and one commit. */
function localBoard(name = 'shop'): BoardPaths {
  const root = path.join(tempDir('lpm-parent-'), name);
  mkdirSync(root);
  const paths = initBoard({ root, template: 'scrum', prefix: 'LP', git: true, omni: false }).paths;
  fill(paths);
  return paths;
}

function fill(paths: BoardPaths): void {
  createIssue(loadBoard(paths), { type: 'program', title: 'Payments' });
  createIssue(loadBoard(paths), { type: 'epic', title: 'Checkout', parentId: 'LP-1' });
  const board = loadBoard(paths);
  addComment(board, 'LP-1', { body: 'Started.', author: 'Ada' });
  mkdirSync(path.join(paths.lpmDir, 'views'), { recursive: true });
  writeFileSync(path.join(paths.lpmDir, 'views', 'default.json'), '{"nodes":{}}\n');
  writeFileSync(paths.localPath, '{"user":"RS-1"}\n');
  writeFileSync(paths.credentialsPath, '{}\n');
  git(paths.lpmDir, 'add', '-A');
  git(paths.lpmDir, 'commit', '-q', '-m', 'board');
}

/** A central board with the same content. */
function centralBoard(name = 'shop'): BoardPaths {
  const root = path.join(tempDir('lpm-parent-'), name);
  mkdirSync(root);
  const paths = initBoard({ root, template: 'scrum', prefix: 'LP', git: true, omni: false, store: 'central' }).paths;
  fill(paths);
  return paths;
}

/** Every file below `dir`, relative and sorted, without the git internals. */
function files(dir: string): string[] {
  return (readdirSync(dir, { recursive: true, withFileTypes: true }) as import('node:fs').Dirent[])
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .filter((file) => !file.startsWith('.git/'))
    .sort();
}

beforeEach(() => {
  home = tempDir('lpm-home-');
  store = tempDir('lpm-store-');
  process.env[USER_HOME_ENV_VAR] = home;
  writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ central_store: store }));
});

afterEach(() => {
  delete process.env[LOCK_TIMEOUT_ENV];
  if (savedHome === undefined) delete process.env[USER_HOME_ENV_VAR];
  else process.env[USER_HOME_ENV_VAR] = savedHome;
});

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe('moving a local board to the central store', () => {
  it('moves every file and the git repository, and writes the pointer and project.json', () => {
    const local = localBoard('shop');
    const before = files(local.lpmDir);

    const result = relocateBoard(local, 'central');

    const central = path.join(store, '.lpm_central', 'shop');
    expect(result.paths.lpmDir).toBe(central);
    expect(result.paths.root).toBe(local.root);
    for (const file of before) expect(existsSync(path.join(central, file))).toBe(true);
    expect(existsSync(path.join(central, '.git'))).toBe(true);
    expect(existsSync(path.join(central, 'local.json'))).toBe(true);
    expect(existsSync(path.join(central, 'credentials.json'))).toBe(true);
    expect(existsSync(path.join(central, 'views', 'default.json'))).toBe(true);
    expect(readStorePointer(path.join(local.root, '.lpm', 'config.yml'))).toBe(central);
    expect(readdirSync(path.join(local.root, '.lpm'))).toEqual(['config.yml']);
    expect(JSON.parse(readFileSync(path.join(central, 'project.json'), 'utf8'))).toEqual({
      project_path: local.root,
    });
  });

  it('keeps the git HEAD and leaves the repository clean', () => {
    const local = localBoard();
    const head = git(local.lpmDir, 'rev-parse', 'HEAD');

    const result = relocateBoard(local, 'central');

    expect(git(result.paths.lpmDir, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(result.paths.lpmDir, 'status', '--porcelain')).toBe('');
  });

  it('gives a board that every command finds through the pointer', () => {
    const local = localBoard();
    relocateBoard(local, 'central');
    const found = findBoardPaths(local.root)!;
    expect(found.lpmDir).toBe(path.join(store, '.lpm_central', 'shop'));
    expect(loadBoard(found).issues.map((issue) => issue.title)).toEqual(['Payments', 'Checkout']);
  });

  it('does not copy the lock file', () => {
    const local = localBoard();
    const result = relocateBoard(local, 'central');
    expect(existsSync(path.join(result.paths.lpmDir, 'lock'))).toBe(false);
  });
});

describe('moving a central board into its project', () => {
  it('moves every file into <project>/.lpm and removes the central board folder', () => {
    const central = centralBoard('shop');
    const before = files(central.lpmDir).filter((file) => file !== 'project.json');

    const result = relocateBoard(central, 'local');

    const local = path.join(central.root, '.lpm');
    expect(result.paths.lpmDir).toBe(local);
    expect(result.paths.root).toBe(central.root);
    for (const file of before) expect(existsSync(path.join(local, file))).toBe(true);
    expect(existsSync(path.join(local, '.git'))).toBe(true);
    expect(existsSync(path.join(local, 'project.json'))).toBe(false);
    expect(readStorePointer(path.join(local, 'config.yml'))).toBeNull();
    expect(existsSync(central.lpmDir)).toBe(false);
    expect(findBoardPaths(central.root)!.lpmDir).toBe(local);
  });

  it('keeps the git HEAD', () => {
    const central = centralBoard();
    const head = git(central.lpmDir, 'rev-parse', 'HEAD');
    const result = relocateBoard(central, 'local');
    expect(git(result.paths.lpmDir, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(result.paths.lpmDir, 'status', '--porcelain')).toBe('');
  });
});

describe('a round trip', () => {
  it('gives the same snapshot as before the move', () => {
    const local = localBoard();
    // `readAt` is the time of the read, so it is the one field that differs.
    const snapshot = (paths: BoardPaths) => ({ ...toSnapshot(loadBoard(paths)), readAt: null });
    const before = snapshot(local);

    const there = relocateBoard(local, 'central');
    const back = relocateBoard(there.paths, 'local');

    expect(back.paths.lpmDir).toBe(local.lpmDir);
    expect(snapshot(back.paths)).toEqual(before);
    expect(readdirSync(path.join(store, '.lpm_central'))).toEqual([]);
  });
});

describe('refused moves', () => {
  it('refuses --to central without a central store, and changes nothing', () => {
    const local = localBoard();
    rmSync(path.join(home, 'settings.json'));
    const before = files(local.lpmDir);

    expect(() => relocateBoard(local, 'central')).toThrow(BoardError);
    expect(() => relocateBoard(local, 'central')).toThrow(/central_store/);
    expect(files(local.lpmDir)).toEqual(before);
  });

  it('refuses to move a central board to the central store', () => {
    const central = centralBoard();
    expect(() => relocateBoard(central, 'central')).toThrow(/already in the central store/);
  });

  it('refuses to move a local board into its project', () => {
    const local = localBoard();
    expect(() => relocateBoard(local, 'local')).toThrow(/already in its project/);
  });

  it('refuses while another process holds the board lock', () => {
    const local = localBoard();
    writeFileSync(
      local.lockPath,
      JSON.stringify({
        pid: process.pid,
        host: os.hostname(),
        user: 'someone',
        op: 'a long import',
        at: new Date().toISOString(),
        nonce: 'not-ours',
      }),
    );
    process.env[LOCK_TIMEOUT_ENV] = '150';

    expect(() => relocateBoard(local, 'central')).toThrow(/a long import/);
    expect(readLockHolder(local.lockPath)?.nonce).toBe('not-ours');
    expect(existsSync(path.join(store, '.lpm_central', 'shop'))).toBe(false);
    rmSync(local.lockPath);
  });
});

// On Windows, a folder cannot be renamed while any file below it is open, even
// by this process. A move that renamed `<project>/.lpm` failed with EPERM when
// another program had a board file open. The move now copies, then deletes.
describe.runIf(process.platform === 'win32')('a move while a file of the board is open', () => {
  it('moves a local board to the central store', () => {
    const local = localBoard();
    const issue = findIssue(loadBoard(local), 'LP-1')!.file;
    const fd = openSync(issue, 'r');
    try {
      const result = relocateBoard(local, 'central');

      const central = path.join(store, '.lpm_central', 'shop');
      expect(result.paths.lpmDir).toBe(central);
      expect(readStorePointer(path.join(local.root, '.lpm', 'config.yml'))).toBe(central);
      expect(loadBoard(findBoardPaths(local.root)!).issues.map((each) => each.title)).toEqual(['Payments', 'Checkout']);
    } finally {
      closeSync(fd);
    }
    expect(readdirSync(path.join(local.root, '.lpm'))).toEqual(['config.yml']);
  });

  it('moves a central board into its project while a process works in the pointer folder', async () => {
    const central = centralBoard();
    const pointerDir = path.join(central.root, '.lpm');
    // A process holds its working folder open, as a terminal in `<project>/.lpm` does.
    const terminal = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { cwd: pointerDir, stdio: 'ignore' });
    await new Promise((resolve, reject) => terminal.once('spawn', resolve).once('error', reject));
    try {
      const result = relocateBoard(central, 'local');

      expect(result.paths.lpmDir).toBe(pointerDir);
      expect(readStorePointer(path.join(pointerDir, 'config.yml'))).toBeNull();
      expect(loadBoard(findBoardPaths(central.root)!).issues.map((each) => each.title)).toEqual(['Payments', 'Checkout']);
      expect(existsSync(central.lpmDir)).toBe(false);
    } finally {
      terminal.kill();
      await new Promise((resolve) => terminal.once('exit', resolve));
    }
  });
});

describe('a pointer folder that holds more than the pointer', () => {
  it('refuses the move into the project, names the files, and changes nothing', () => {
    const central = centralBoard();
    const pointerDir = path.join(central.root, '.lpm');
    mkdirSync(path.join(pointerDir, 'board'));
    writeFileSync(path.join(pointerDir, 'board', 'old.md'), 'left over\n');
    const before = files(central.lpmDir);

    expect(() => relocateBoard(central, 'local', { backup: false })).toThrow(/holds files other than the pointer: board/);

    expect(files(central.lpmDir)).toEqual(before);
    expect(readdirSync(pointerDir).sort()).toEqual(['board', 'config.yml']);
    expect(findBoardPaths(central.root)!.lpmDir).toBe(central.lpmDir);
  });
});

describe('a move that fails halfway', () => {
  it('leaves a local board where it was and removes the partial copy', () => {
    const local = localBoard();
    const before = files(local.lpmDir);
    const halfCopy = (from: string, to: string) => {
      cpSync(path.join(from, 'board'), path.join(to, 'board'), { recursive: true });
      throw new Error('disk full');
    };

    expect(() => relocateBoard(local, 'central', { copy: halfCopy })).toThrow(/disk full/);

    expect(files(local.lpmDir)).toEqual(before);
    expect(readdirSync(path.join(store, '.lpm_central'))).toEqual([]);
    expect(findBoardPaths(local.root)!.lpmDir).toBe(local.lpmDir);
  });

  it('leaves a central board where it was and keeps the pointer', () => {
    const central = centralBoard();
    const before = files(central.lpmDir);
    const halfCopy = (from: string, to: string) => {
      cpSync(path.join(from, 'board'), path.join(to, 'board'), { recursive: true });
      throw new Error('disk full');
    };

    expect(() => relocateBoard(central, 'local', { copy: halfCopy })).toThrow(/disk full/);

    expect(files(central.lpmDir)).toEqual(before);
    expect(readdirSync(path.join(central.root, '.lpm'))).toEqual(['config.yml']);
    expect(findBoardPaths(central.root)!.lpmDir).toBe(central.lpmDir);
    expect(readdirSync(central.root).filter((name) => name.startsWith('.lpm'))).toEqual(['.lpm']);
  });
});

// After each `git commit`, git starts `git maintenance run --auto --detach`.
// That background process can repack `.git/objects` while a move copies the
// board, and a CI run failed on the temporary pack file that it wrote. The
// `copy` hooks below write into the source the way that repack does.
describe('a board that git changes during the copy', () => {
  it('copies again when the source changed after the first copy, and moves the board', () => {
    const central = centralBoard();
    const pack = path.join(central.lpmDir, '.git', 'objects', 'pack');
    let calls = 0;
    const repackDuringCopy = (from: string, to: string, filter: (source: string) => boolean) => {
      calls++;
      // The second copy finds the finished pack, which replaced the temporary file.
      if (calls === 2) rmSync(path.join(pack, 'tmp_idx_test'));
      if (calls === 2) writeFileSync(path.join(pack, 'pack-test.idx'), 'index\n');
      cpSync(from, to, { recursive: true, filter });
      // The first copy misses the temporary file, which git writes after the copy passed the folder.
      if (calls === 1) writeFileSync(path.join(pack, 'tmp_idx_test'), 'partial\n');
    };

    const result = relocateBoard(central, 'local', { copy: repackDuringCopy, backup: false });

    expect(calls).toBe(2);
    expect(existsSync(path.join(result.paths.lpmDir, '.git', 'objects', 'pack', 'pack-test.idx'))).toBe(true);
    expect(existsSync(path.join(result.paths.lpmDir, '.git', 'objects', 'pack', 'tmp_idx_test'))).toBe(false);
    expect(existsSync(central.lpmDir)).toBe(false);
  });

  it('fails after three copies when the source changes during each copy, and moves nothing', () => {
    const central = centralBoard();
    const pack = path.join(central.lpmDir, '.git', 'objects', 'pack');
    let calls = 0;
    const repackEveryCopy = (from: string, to: string, filter: (source: string) => boolean) => {
      calls++;
      cpSync(from, to, { recursive: true, filter });
      writeFileSync(path.join(pack, `tmp_idx_${calls}`), 'partial\n');
    };

    expect(() => relocateBoard(central, 'local', { copy: repackEveryCopy, backup: false })).toThrow(
      /The copy of the board is not complete: .*tmp_idx_3 is missing from the copy/,
    );

    expect(calls).toBe(3);
    expect(readdirSync(path.join(central.root, '.lpm'))).toEqual(['config.yml']);
    expect(findBoardPaths(central.root)!.lpmDir).toBe(central.lpmDir);
  });
});
