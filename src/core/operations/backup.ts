import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { BoardError } from '../errors.js';
import { writeFileAtomic } from '../storage/atomic.js';
import { isCentralBoard, samePath, writeProjectFile } from '../storage/central.js';
import { ensureLocalIgnored, excludeLocally } from '../storage/local.js';
import { isLockFileName, withBoardLock, withBoardLockAsync } from '../storage/lock.js';
import type { BoardPaths } from '../storage/paths.js';
import {
  BACKUPS_DIR,
  CENTRAL_DIR,
  CONFIG_FILE,
  LPM_DIR,
  PROJECT_FILE,
  boardPathsAt,
  boardPathsFor,
  readStorePointer,
  resolveBoardDir,
} from '../storage/paths.js';
import type { CheckedCopyProgress, TreeSkip } from '../storage/tree.js';
import { copyCheckedAsync, copyCheckedSync, freeSibling, listTree, removeTreeOrWarn, treeBytes } from '../storage/tree.js';
import { allocateCentralName, centralStorePath } from './central-store.js';
import type { BoardStore } from './init.js';

/**
 * Backups of boards, in the central store.
 *
 * A backup is a full copy of one board folder. It is in
 * `<central_store>/.lpm_backups/<name>_backup/`, which holds two items:
 *
 * - `board/`: the copy of the board folder, without the lock file.
 * - `backup.json`: the project folder, the time of the backup, the store of
 *   the board at that time, its key prefix, and the number and bytes of files.
 *
 * Each project has one backup at most. The project folder (`paths.root`)
 * identifies the board, so a board keeps its backup when it moves between its
 * project and the central store. A new backup replaces the old one only when
 * the caller passes `replace`. `relocateBoard` always backs a board up before
 * it moves it.
 *
 * Both writes copy first and switch second:
 *
 * - A backup copies the board into a staging folder beside the backup folder,
 *   compares the copy, writes `backup.json`, and then renames the staging
 *   folder into place. The old backup is deleted only after that rename.
 * - A restore copies `board/` into a staging folder beside the board folder,
 *   compares the copy, and then switches the folders with two renames. The
 *   board folder that the restore replaced is deleted only after the switch.
 *
 * Each operation has a sync version for the CLI and an async version for the
 * server, which reports its progress and keeps answering other requests.
 */

/** The end of the folder name of each backup. */
export const BACKUP_SUFFIX = '_backup';
/** The file in a backup folder that describes the backup. */
export const BACKUP_FILE = 'backup.json';
/** The folder in a backup folder that holds the copy of the board folder. */
export const BACKUP_BOARD_DIR = 'board';

/** One backup, as `lpm store backups` and the Backups tab of the "All projects" page show it. */
export interface BoardBackup {
  /** The folder name in `.lpm_backups`, for example `shop_backup`. */
  name: string;
  /** The backup folder. */
  dir: string;
  /** The project folder of the board. One backup exists for each project folder. */
  projectPath: string;
  /** The ISO time of the backup. */
  createdAt: string;
  /** Where the board was at the time of the backup. */
  source: BoardStore;
  /** The board folder at the time of the backup. */
  sourceDir: string;
  /** The key `key_prefix` of the board config, or null. */
  keyPrefix: string | null;
  /** The number of files in the copy. */
  files: number;
  /** The bytes of the files in the copy. */
  bytes: number;
}

/** The steps of the operations of this module and of `relocateBoard`, in the order that they run. */
export type OperationStep = 'backup' | 'copy' | 'restore';

/** What an async operation reports while it runs. */
export interface OperationProgress {
  step: OperationStep;
  /** `copy` while the files are copied, then `compare` while the copy is checked. */
  phase: CheckedCopyProgress['phase'];
  /** The position of the step, from 1. */
  stepIndex: number;
  /** The number of steps of the operation. */
  stepCount: number;
  /** The bytes of the phase that are done. */
  done: number;
  /** The bytes of the phase. */
  total: number;
}

export type ProgressListener = (progress: OperationProgress) => void;

/** The listener of one step: it adds the step and its position to each report of `copyCheckedAsync`. */
export function stepReporter(
  listener: ProgressListener | undefined,
  step: OperationStep,
  stepIndex: number,
  stepCount: number,
): ((progress: CheckedCopyProgress) => void) | undefined {
  if (!listener) return undefined;
  return (progress) => listener({ step, stepIndex, stepCount, ...progress });
}

/** The folder of the backups, `<central_store>/.lpm_backups`, or null when no central store is set. */
export function backupsDir(): string | null {
  const store = centralStorePath();
  return store === null ? null : path.join(store, BACKUPS_DIR);
}

/**
 * The folder of the backups for the board of `paths`. Without the key
 * `central_store`, a central board uses the store that holds it. A local board
 * without the key has no place for a backup, and the call throws.
 */
function backupsDirFor(paths: BoardPaths): string {
  const configured = backupsDir();
  if (configured !== null) return configured;
  const parent = path.dirname(paths.lpmDir);
  if (isCentralBoard(paths) && path.basename(parent) === CENTRAL_DIR) {
    return path.join(path.dirname(parent), BACKUPS_DIR);
  }
  throw new BoardError('No central store is set, so the board has no place for a backup', [
    'Name one with `lpm set central_store`. The backups are in <central_store>/.lpm_backups.',
  ]);
}

function readBackup(dir: string): BoardBackup | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(dir, BACKUP_FILE), 'utf8')) as Partial<Record<keyof BoardBackup, unknown>>;
    if (typeof raw.projectPath !== 'string' || typeof raw.createdAt !== 'string') return null;
    if (!existsSync(path.join(dir, BACKUP_BOARD_DIR))) return null;
    return {
      name: path.basename(dir),
      dir,
      projectPath: raw.projectPath,
      createdAt: raw.createdAt,
      source: raw.source === 'central' ? 'central' : 'local',
      sourceDir: typeof raw.sourceDir === 'string' ? raw.sourceDir : '',
      keyPrefix: typeof raw.keyPrefix === 'string' ? raw.keyPrefix : null,
      files: typeof raw.files === 'number' ? raw.files : 0,
      bytes: typeof raw.bytes === 'number' ? raw.bytes : 0,
    };
  } catch {
    return null;
  }
}

function backupFolderNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.endsWith(BACKUP_SUFFIX))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Every backup in `dir` (default: `<central_store>/.lpm_backups`), sorted by
 * folder name. A folder without a readable `backup.json` or without `board/`
 * is left out. So is a staging folder, whose name does not end with `_backup`.
 */
export function listBackups(dir: string | null = backupsDir()): BoardBackup[] {
  if (dir === null) return [];
  return backupFolderNames(dir)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => readBackup(path.join(dir, name)))
    .filter((backup): backup is BoardBackup => backup !== null);
}

/** The backup of the project folder `root`, or null. */
export function findBackup(root: string, dir: string | null = backupsDir()): BoardBackup | null {
  return listBackups(dir).find((backup) => samePath(backup.projectPath, root)) ?? null;
}

/** The backup called `name` in `dir`, or null. The name never resolves outside `dir`. */
export function backupNamed(name: string, dir: string | null = backupsDir()): BoardBackup | null {
  return listBackups(dir).find((backup) => backup.name === name) ?? null;
}

/** The whole days from `createdAt` to `now`. A backup from less than 24 hours ago is 0 days old. */
export function backupAgeDays(createdAt: string, now: Date = new Date()): number {
  const at = Date.parse(createdAt);
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, Math.floor((now.getTime() - at) / 86_400_000));
}

/**
 * The folder name for a new backup: the name of the central board folder, or
 * the project folder name for a local board, cleaned as `allocateCentralName`
 * cleans it, with `_backup` at the end. A taken name gets `-2`, `-3` and so
 * on before the suffix.
 */
export function allocateBackupName(baseName: string, existing: readonly string[]): string {
  const bases = existing.filter((name) => name.endsWith(BACKUP_SUFFIX)).map((name) => name.slice(0, -BACKUP_SUFFIX.length));
  return `${allocateCentralName(baseName, bases)}${BACKUP_SUFFIX}`;
}

function keyPrefixOf(lpmDir: string): string | null {
  try {
    const parsed = parseYaml(readFileSync(path.join(lpmDir, CONFIG_FILE), 'utf8')) as { key_prefix?: unknown } | null;
    return typeof parsed?.key_prefix === 'string' ? parsed.key_prefix : null;
  } catch {
    return null;
  }
}

const skipLockFiles: TreeSkip = (relative) => isLockFileName(relative);

function requireProject(paths: BoardPaths): void {
  if (samePath(paths.root, paths.lpmDir)) {
    throw new BoardError(`No project is known for the board in ${paths.lpmDir}`, [
      `A backup belongs to a project. Run \`lpm check --fix\` in the project folder to write ${PROJECT_FILE}.`,
    ]);
  }
}

export interface BackupOptions {
  /** Replace the backup of the project when one exists. Without it, an existing backup stops the call. */
  replace?: boolean;
  /** The time to record. Tests pass one. */
  now?: Date;
  onProgress?: ProgressListener;
}

/** A backup that is copied but not yet in place. */
interface BackupPlan {
  source: string;
  /** The staging folder. The copy goes to `<staging>/board`. */
  staging: string;
  commit(): BoardBackup;
}

/** The existing backup that stops a backup without `replace`. */
function backupExists(existing: BoardBackup): BoardError {
  return new BoardError(`The board already has a backup, from ${existing.createdAt.slice(0, 10)}: ${existing.dir}`, [
    'Each board has one backup. Replace it with `lpm store backup --replace`.',
  ]);
}

function planBackup(paths: BoardPaths, options: BackupOptions): BackupPlan {
  requireProject(paths);
  const dir = backupsDirFor(paths);
  mkdirSync(dir, { recursive: true });
  const existing = findBackup(paths.root, dir);
  if (existing && options.replace !== true) throw backupExists(existing);
  const base = isCentralBoard(paths) ? path.basename(paths.lpmDir) : path.basename(path.resolve(paths.root));
  const name = existing?.name ?? allocateBackupName(base, backupFolderNames(dir));
  const final = path.join(dir, name);
  const staging = freeSibling(final, 'incoming');
  const source = paths.lpmDir;

  return {
    source,
    staging,
    commit: () => {
      const entries = listTree(path.join(staging, BACKUP_BOARD_DIR));
      const record = {
        projectPath: path.resolve(paths.root),
        createdAt: (options.now ?? new Date()).toISOString(),
        source: isCentralBoard(paths) ? 'central' : 'local',
        sourceDir: path.resolve(source),
        keyPrefix: keyPrefixOf(source),
        files: entries.filter((entry) => entry.kind === 'file').length,
        bytes: treeBytes(entries),
      };
      writeFileAtomic(path.join(staging, BACKUP_FILE), `${JSON.stringify(record, null, 2)}\n`);
      const aside = existsSync(final) ? freeSibling(final, 'old') : null;
      try {
        if (aside) renameSync(final, aside);
        renameSync(staging, final);
      } catch (error) {
        if (aside && !existsSync(final)) renameSync(aside, final);
        rmSync(staging, { recursive: true, force: true });
        throw new BoardError(`Could not put the backup in ${final}: ${(error as Error).message}`, [
          'Another program can have a file in it open. Close it and try again. The old backup was kept.',
        ]);
      }
      const warnings: string[] = [];
      if (aside) removeTreeOrWarn(aside, warnings);
      return readBackup(final)!;
    },
  };
}

const BACKUP_FAILED = 'No backup was written. The board was not changed.';

/** Back up the board of `paths` while the caller holds its lock. */
export function backupLocked(paths: BoardPaths, options: BackupOptions = {}): BoardBackup {
  const plan = planBackup(paths, options);
  try {
    copyCheckedSync(plan.source, path.join(plan.staging, BACKUP_BOARD_DIR), skipLockFiles, BACKUP_FAILED);
  } catch (error) {
    rmSync(plan.staging, { recursive: true, force: true });
    throw error;
  }
  return plan.commit();
}

/** `backupLocked` with async file calls. `stepIndex` and `stepCount` place the step in a longer operation. */
export async function backupLockedAsync(
  paths: BoardPaths,
  options: BackupOptions = {},
  stepIndex = 1,
  stepCount = 1,
): Promise<BoardBackup> {
  const plan = planBackup(paths, options);
  try {
    await copyCheckedAsync(
      plan.source,
      path.join(plan.staging, BACKUP_BOARD_DIR),
      skipLockFiles,
      BACKUP_FAILED,
      stepReporter(options.onProgress, 'backup', stepIndex, stepCount),
    );
  } catch (error) {
    rmSync(plan.staging, { recursive: true, force: true });
    throw error;
  }
  return plan.commit();
}

/** Copy the board of `paths` into its backup folder, under the board lock. */
export function backupBoard(paths: BoardPaths, options: BackupOptions = {}): BoardBackup {
  return withBoardLock(paths, 'back up the board', () => backupLocked(paths, options));
}

/** `backupBoard` with async file calls and progress reports. */
export function backupBoardAsync(paths: BoardPaths, options: BackupOptions = {}): Promise<BoardBackup> {
  return withBoardLockAsync(paths, 'back up the board', () => backupLockedAsync(paths, options));
}

/**
 * The board that a restore of `backup` overwrites: the board of the project
 * folder now, local or central. When the project folder holds no board, the
 * restore creates `<project>/.lpm`. When its pointer names a central board
 * folder that is gone, the restore creates that folder again.
 */
export function restoreTarget(backup: BoardBackup): BoardPaths {
  const root = backup.projectPath;
  if (!existsSync(root)) {
    throw new BoardError(`The project folder of the backup is gone: ${root}`, [
      'Create the folder again, or move the project back, and then restore.',
    ]);
  }
  const lpm = path.join(root, LPM_DIR);
  const pointer = readStorePointer(path.join(lpm, CONFIG_FILE));
  if (pointer !== null) {
    return existsSync(path.join(pointer, CONFIG_FILE)) ? resolveBoardDir(lpm, root) : boardPathsAt(pointer, { root });
  }
  return boardPathsFor(root);
}

export interface RestoreResult {
  backup: BoardBackup;
  /** The board that the restore wrote. */
  paths: BoardPaths;
  store: BoardStore;
  warnings: string[];
}

export interface RestoreOptions {
  onProgress?: ProgressListener;
}

interface RestorePlan {
  source: string;
  staging: string;
  skip: TreeSkip;
  commit(): RestoreResult;
}

function planRestore(backup: BoardBackup, target: BoardPaths): RestorePlan {
  const central = isCentralBoard(target);
  const staging = freeSibling(target.lpmDir, 'restoring');
  return {
    source: path.join(backup.dir, BACKUP_BOARD_DIR),
    staging,
    // A local board has no project.json. A central board gets one for its project below.
    skip: (relative) => isLockFileName(relative) || relative === PROJECT_FILE,
    commit: () => {
      if (central) {
        writeProjectFile(staging, target.root);
        const staged = boardPathsAt(staging, { root: target.root });
        if (existsSync(path.join(staging, '.git'))) excludeLocally(staged, [PROJECT_FILE]);
        else ensureLocalIgnored(staged);
      }
      // The lock of this restore moves with the folder, so the release finds it.
      if (existsSync(target.lockPath)) copyFileSync(target.lockPath, path.join(staging, path.basename(target.lockPath)));
      mkdirSync(path.dirname(target.lpmDir), { recursive: true });
      const aside = existsSync(target.lpmDir) ? freeSibling(target.lpmDir, 'replaced') : null;
      try {
        if (aside) renameSync(target.lpmDir, aside);
        renameSync(staging, target.lpmDir);
      } catch (error) {
        if (aside && !existsSync(target.lpmDir)) renameSync(aside, target.lpmDir);
        rmSync(staging, { recursive: true, force: true });
        throw new BoardError(`Could not put the restored board in ${target.lpmDir}: ${(error as Error).message}`, [
          'Another program can have a file in it open. Close it and try again. The board was not changed.',
        ]);
      }
      const warnings: string[] = [];
      if (aside) removeTreeOrWarn(aside, warnings);
      return { backup, paths: target, store: central ? 'central' : 'local', warnings };
    },
  };
}

const RESTORE_FAILED = 'Nothing was restored. The board was not changed.';

/** Overwrite the board of the project of `backup` with the copy in the backup, under the board lock. */
export function restoreBackup(backup: BoardBackup): RestoreResult {
  const target = restoreTarget(backup);
  return withBoardLock(target, 'restore the board from its backup', () => {
    const plan = planRestore(backup, target);
    copyCheckedSync(plan.source, plan.staging, plan.skip, RESTORE_FAILED);
    return plan.commit();
  });
}

/** `restoreBackup` with async file calls and progress reports. */
export function restoreBackupAsync(backup: BoardBackup, options: RestoreOptions = {}): Promise<RestoreResult> {
  const target = restoreTarget(backup);
  return withBoardLockAsync(target, 'restore the board from its backup', async () => {
    const plan = planRestore(backup, target);
    await copyCheckedAsync(plan.source, plan.staging, plan.skip, RESTORE_FAILED, stepReporter(options.onProgress, 'restore', 1, 1));
    return plan.commit();
  });
}
