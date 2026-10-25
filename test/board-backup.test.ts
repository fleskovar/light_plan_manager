import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BoardPaths, OperationProgress } from '../src/core/index.js';
import {
  BACKUP_FILE,
  BoardError,
  USER_HOME_ENV_VAR,
  allocateBackupName,
  backupAgeDays,
  backupBoard,
  backupBoardAsync,
  createIssue,
  findBackup,
  findBoardPaths,
  initBoard,
  listBackups,
  loadBoard,
  relocateBoard,
  relocateBoardAsync,
  restoreBackup,
  restoreBackupAsync,
  withBoardLock,
  withBoardLockAsync,
} from '../src/core/index.js';

// Backups of boards in <central_store>/.lpm_backups, the restore from a
// backup, the async move that the server runs, and the async board lock.

const scratch: string[] = [];
let home: string;
let store: string;
const savedHome = process.env[USER_HOME_ENV_VAR];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function board(name: string, where: 'local' | 'central' = 'local'): BoardPaths {
  const root = path.join(tempDir('lpm-parent-'), name);
  mkdirSync(root);
  const paths = initBoard({ root, template: 'scrum', prefix: 'SH', git: false, omni: false, store: where }).paths;
  createIssue(loadBoard(paths), { type: ROOT_TYPE, title: 'First' });
  return paths;
}

/** The top type of the template scrum. */
const ROOT_TYPE = 'program';

/** Every file below `dir`, relative and sorted. */
function files(dir: string): string[] {
  return (readdirSync(dir, { recursive: true, withFileTypes: true }) as Dirent[])
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort();
}

function titles(paths: BoardPaths): string[] {
  return loadBoard(paths).issues.map((issue) => issue.title).sort();
}

beforeEach(() => {
  home = tempDir('lpm-home-');
  store = tempDir('lpm-store-');
  process.env[USER_HOME_ENV_VAR] = home;
  writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ central_store: store }));
});

afterEach(() => {
  if (savedHome === undefined) delete process.env[USER_HOME_ENV_VAR];
  else process.env[USER_HOME_ENV_VAR] = savedHome;
});

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe('a backup', () => {
  it('copies every file of the board, without the lock, and records the project and the time', () => {
    const shop = board('shop');
    const now = new Date('2026-10-20T08:00:00.000Z');

    const backup = backupBoard(shop, { now });

    expect(backup.dir).toBe(path.join(store, '.lpm_backups', 'shop_backup'));
    expect(files(path.join(backup.dir, 'board'))).toEqual(files(shop.lpmDir).filter((file) => file !== 'lock'));
    expect(backup).toMatchObject({ projectPath: shop.root, createdAt: now.toISOString(), source: 'local', keyPrefix: 'SH' });
    expect(backup.files).toBe(files(shop.lpmDir).length);
    expect(JSON.parse(readFileSync(path.join(backup.dir, BACKUP_FILE), 'utf8')).projectPath).toBe(shop.root);
    expect(listBackups().map((entry) => entry.name)).toEqual(['shop_backup']);
  });

  it('keeps one backup for each board, and replaces it only with replace', () => {
    const shop = board('shop');
    backupBoard(shop, { now: new Date('2026-10-01T00:00:00.000Z') });
    createIssue(loadBoard(shop), { type: ROOT_TYPE, title: 'Second' });

    expect(() => backupBoard(shop)).toThrow(BoardError);
    expect(() => backupBoard(shop)).toThrow(/already has a backup, from 2026-10-01/);

    const replaced = backupBoard(shop, { replace: true, now: new Date('2026-10-25T00:00:00.000Z') });
    expect(replaced.name).toBe('shop_backup');
    expect(replaced.createdAt).toBe('2026-10-25T00:00:00.000Z');
    expect(readdirSync(path.join(store, '.lpm_backups'))).toEqual(['shop_backup']);
    expect(titles({ ...shop, ...findBoardPaths(shop.root)!, lpmDir: path.join(replaced.dir, 'board') } as BoardPaths)).toEqual([
      'First',
      'Second',
    ]);
  });

  it('gives a second project with the same folder name the next free name', () => {
    backupBoard(board('shop'));
    const other = backupBoard(board('shop'));
    expect(other.name).toBe('shop-2_backup');
    expect(allocateBackupName('shop', ['shop_backup', 'shop-2_backup'])).toBe('shop-3_backup');
  });

  it('counts the age in whole days', () => {
    expect(backupAgeDays('2026-10-13T09:30:00.000Z', new Date('2026-10-25T12:00:00.000Z'))).toBe(12);
    expect(backupAgeDays('2026-10-25T11:00:00.000Z', new Date('2026-10-25T12:00:00.000Z'))).toBe(0);
  });

  it('reports its progress when it runs async', async () => {
    const shop = board('shop');
    const reports: OperationProgress[] = [];

    await backupBoardAsync(shop, { onProgress: (progress) => reports.push(progress) });

    expect(reports.length).toBeGreaterThan(0);
    expect(new Set(reports.map((report) => report.phase))).toEqual(new Set(['copy', 'compare']));
    const last = reports.at(-1)!;
    expect(last).toMatchObject({ step: 'backup', phase: 'compare', stepIndex: 1, stepCount: 1 });
    expect(last.done).toBe(last.total);
    expect(findBackup(shop.root)).not.toBeNull();
  });
});

describe('a move', () => {
  it('backs the board up before it moves it, and keeps the backup in the central store', () => {
    const shop = board('shop');
    const before = files(shop.lpmDir);

    const result = relocateBoard(shop, 'central');

    expect(result.backup?.dir).toBe(path.join(store, '.lpm_backups', 'shop_backup'));
    expect(files(path.join(result.backup!.dir, 'board'))).toEqual(before);
    expect(result.backup?.source).toBe('local');
  });

  it('replaces the backup on the way back, and the backup keeps the same project', () => {
    const shop = board('shop');
    const there = relocateBoard(shop, 'central');
    const back = relocateBoard(there.paths, 'local');
    expect(back.backup?.name).toBe('shop_backup');
    expect(back.backup?.source).toBe('central');
    expect(listBackups()).toHaveLength(1);
  });

  it('runs async with two steps, backup and copy, and leaves the board readable in its new place', async () => {
    const shop = board('shop');
    const steps = new Set<string>();

    const result = await relocateBoardAsync(shop, 'central', {
      onProgress: (progress) => steps.add(`${progress.stepIndex}/${progress.stepCount} ${progress.step}`),
    });

    expect([...steps]).toEqual(['1/2 backup', '2/2 copy']);
    expect(findBoardPaths(shop.root)!.lpmDir).toBe(result.paths.lpmDir);
    expect(titles(result.paths)).toEqual(['First']);
    expect(existsSync(path.join(shop.root, '.lpm', 'board'))).toBe(false);
  });
});

describe('a restore', () => {
  it('overwrites a local board with the copy in its backup', () => {
    const shop = board('shop');
    const backup = backupBoard(shop);
    createIssue(loadBoard(shop), { type: ROOT_TYPE, title: 'Later' });
    expect(titles(shop)).toEqual(['First', 'Later']);

    const result = restoreBackup(backup);

    expect(result.store).toBe('local');
    expect(titles(shop)).toEqual(['First']);
    expect(existsSync(shop.lockPath)).toBe(false);
    expect(readdirSync(path.dirname(shop.lpmDir)).filter((name) => name.startsWith('.lpm.'))).toEqual([]);
  });

  it('restores into the central board when the board moved there after the backup, and writes project.json', async () => {
    const shop = board('shop');
    const backup = backupBoard(shop);
    const moved = relocateBoard(shop, 'central', { backup: false });
    createIssue(loadBoard(moved.paths), { type: ROOT_TYPE, title: 'Later' });

    const result = await restoreBackupAsync(findBackup(shop.root)!);

    expect(backup.source).toBe('local');
    expect(result.store).toBe('central');
    expect(result.paths.lpmDir).toBe(moved.paths.lpmDir);
    expect(titles(findBoardPaths(shop.root)!)).toEqual(['First']);
    const project = JSON.parse(readFileSync(path.join(moved.paths.lpmDir, 'project.json'), 'utf8'));
    expect(project.project_path).toBe(shop.root);
  });

  it('creates <project>/.lpm when the project has no board any more', () => {
    const shop = board('shop');
    const backup = backupBoard(shop);
    rmSync(shop.lpmDir, { recursive: true, force: true });

    restoreBackup(backup);

    expect(titles(findBoardPaths(shop.root)!)).toEqual(['First']);
  });

  it('refuses when the project folder is gone', () => {
    const shop = board('shop');
    const backup = backupBoard(shop);
    rmSync(shop.root, { recursive: true, force: true });
    expect(() => restoreBackup(backup)).toThrow(/project folder of the backup is gone/);
  });
});

describe('the async board lock', () => {
  it('makes a sync write of the same process fail at once while a job holds the lock', async () => {
    const shop = board('shop');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const job = withBoardLockAsync(shop, 'a long copy', async () => {
      await gate;
      // Inside the job, the sync lock re-enters.
      return withBoardLock(shop, 'a nested write', () => 'nested');
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const started = Date.now();
    expect(() => withBoardLock(shop, 'write from a request', () => 'outside')).toThrow(/this server is doing "a long copy"/);
    expect(Date.now() - started).toBeLessThan(1000);
    await expect(withBoardLockAsync(shop, 'a second job', async () => 'second')).rejects.toThrow(/a long copy/);

    release();
    await expect(job).resolves.toBe('nested');
    expect(existsSync(shop.lockPath)).toBe(false);
    expect(withBoardLock(shop, 'write after the job', () => 'after')).toBe('after');
  });
});
