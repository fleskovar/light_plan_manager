import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { BoardError } from '../errors.js';
import { isCentralBoard, samePath, writeProjectFile, writeStorePointer } from '../storage/central.js';
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
  expandHome,
  readStorePointer,
} from '../storage/paths.js';
import type { TreeSkip } from '../storage/tree.js';
import { compareTrees, copyCheckedAsync, freeSibling, removeTreeOrWarn } from '../storage/tree.js';
import type { BoardBackup, ProgressListener } from './backup.js';
import { BACKUP_SUFFIX, allocateBackupName, backupLocked, backupLockedAsync, stepReporter } from './backup.js';
import type { CentralBoardEntry } from './central-store.js';
import {
  allocateCentralName,
  centralBoardNames,
  centralBoardsDir,
  centralStorePath,
  createCentralBoardDir,
  listCentralBoards,
  setCentralStore,
} from './central-store.js';
import { renameIndexedBoard } from './project-index.js';
import type { BoardStore } from './init.js';

/**
 * Moving a board between its project and the central store.
 *
 * `local` to `central`: the files of `<project>/.lpm` go to a new folder in
 * `<central_store>/.lpm_central`, and `<project>/.lpm` keeps only the pointer.
 * `central` to `local`: the files of the central board folder go to
 * `<project>/.lpm`, and the central board folder is removed.
 *
 * The move copies first and switches second, so a failure leaves the board
 * where it was:
 *
 * 0. Back the board up into `<central_store>/.lpm_backups` (`backup.ts`).
 *    This step replaces the earlier backup of the project. The option
 *    `backup: false` skips it.
 * 1. Copy the board folder to the target, without the lock file (and without
 *    `project.json` on the way back). The central store can be on another
 *    drive, where `renameSync` fails with `EXDEV`, so the move never renames
 *    across folders.
 * 2. Compare the two trees: the file lists, the sizes and the SHA-256 digests.
 * 3. Switch. Each step of the switch is a rename inside one parent folder, and
 *    the old folder is deleted only after the new one is in place.
 *
 * The whole move runs under the board lock, so no `lpm` process writes while
 * the files are copied. A process that already holds `BoardPaths` of the old
 * folder (a running `lpm ui` or MCP server) keeps the old paths until it is
 * restarted. The server of `lpm ui` that runs the move itself updates its
 * paths (`src/server/jobs.ts`).
 */

export interface RelocateOptions {
  /** Copies the folder `from` into the new, empty folder `to`. Tests pass one that fails. */
  copy?: (from: string, to: string, filter: (source: string) => boolean) => void;
  /** Back the board up before the move. On by default. */
  backup?: boolean;
}

export interface RelocateAsyncOptions {
  /** Back the board up before the move. On by default. */
  backup?: boolean;
  onProgress?: ProgressListener;
}

export interface RelocateResult {
  from: BoardStore;
  to: BoardStore;
  /** The board after the move. */
  paths: BoardPaths;
  /** The board folder that held the documents before the move. */
  previousDir: string;
  /** Things the move could not finish, such as an old folder that could not be deleted. */
  warnings: string[];
  /** The backup that the move wrote before it moved the board, or null with `backup: false`. */
  backup: BoardBackup | null;
}

const defaultCopy: NonNullable<RelocateOptions['copy']> = (from, to, filter) => {
  cpSync(from, to, { recursive: true, filter, errorOnExist: true, force: false });
};

const NOTHING_MOVED = 'Nothing was moved.';

/**
 * Copy `source` into the new folder `target` with `copy`, and compare the two
 * trees. On a failure, remove `target` and throw: the source is not touched.
 */
function copyChecked(source: string, target: string, skip: TreeSkip, copy: NonNullable<RelocateOptions['copy']>): void {
  try {
    const filter = (file: string): boolean => {
      const relative = path.relative(source, file);
      return relative === '' || !skip(relative);
    };
    copy(source, target, filter);
    const problem = compareTrees(source, target, skip);
    if (problem) throw new BoardError(`The copy of the board is not complete: ${problem}`, [NOTHING_MOVED]);
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

/** One board that `moveCentralStore` moved. */
export interface MovedCentralBoard {
  name: string;
  from: string;
  to: string;
  /** The project folder from `project.json`, or null. */
  root: string | null;
  /** False when the project had no pointer to this board, so no pointer was rewritten. */
  pointerUpdated: boolean;
  warnings: string[];
}

export interface MoveCentralStoreResult {
  /** The store before the call, or null when none was set. */
  previous: string | null;
  /** The store that the key names after the call. */
  store: string;
  moved: MovedCentralBoard[];
  /** The board that stopped the move. The key still names the previous store. */
  failure: { name: string; message: string } | null;
  /** True when the new folder already was the store. Nothing was done. */
  unchanged: boolean;
  /** Folders in the old `.lpm_central` that hold no board and were not moved. */
  leftBehind: string[];
  /** The backup folders that moved to `<newStore>/.lpm_backups`. */
  backupsMoved: string[];
  /** Why a backup folder stayed in the old `.lpm_backups`, one line for each. */
  backupWarnings: string[];
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Make `newStore` the central store and move every board of the current store
 * into `<newStore>/.lpm_central`. Each board moves under its own lock with the
 * copy, compare and switch steps of `relocateBoard`. A board keeps its folder
 * name unless the new store has a folder of that name. The pointer of its
 * project is rewritten when it names the old folder. After the boards, the
 * backups in `.lpm_backups` move too.
 *
 * The move stops at the first board that fails. That board stays where it
 * was, and the key keeps naming the old store. The boards that moved already
 * work from the new store, because each pointer holds the full path. Running
 * the call again moves the boards that are left, and then writes the key.
 */
export function moveCentralStore(newStore: string, options: RelocateOptions = {}): MoveCentralStoreResult {
  const target = path.resolve(expandHome(newStore.trim()));
  const previous = centralStorePath();
  const base = {
    previous,
    moved: [] as MovedCentralBoard[],
    failure: null,
    leftBehind: [] as string[],
    backupsMoved: [] as string[],
    backupWarnings: [] as string[],
  };
  if (previous !== null && samePath(previous, target)) {
    return { ...base, store: previous, unchanged: true };
  }
  const oldBoards = previous === null ? null : path.join(previous, CENTRAL_DIR);
  const newBoards = path.join(target, CENTRAL_DIR);
  if (oldBoards && (isInside(target, oldBoards) || isInside(oldBoards, newBoards))) {
    throw new BoardError(`The new central store ${target} overlaps the boards of the current one, ${oldBoards}`, [
      'Choose a folder outside the current .lpm_central.',
    ]);
  }
  const copy = options.copy ?? defaultCopy;
  const moved: MovedCentralBoard[] = [];
  for (const board of listCentralBoards()) {
    try {
      moved.push(moveOneCentralBoard(board, newBoards, copy));
    } catch (error) {
      return {
        ...base,
        store: previous!,
        moved,
        failure: { name: board.name, message: (error as Error).message },
        unchanged: false,
      };
    }
  }
  const leftBehind = oldBoards ? centralBoardNames(oldBoards).map((name) => path.join(oldBoards, name)) : [];
  if (oldBoards && leftBehind.length === 0) rmSync(oldBoards, { recursive: true, force: true });
  const backups = previous === null ? { moved: [], warnings: [] } : moveBackups(previous, target, copy);
  setCentralStore(target);
  return {
    ...base,
    store: target,
    moved,
    unchanged: false,
    leftBehind,
    backupsMoved: backups.moved,
    backupWarnings: backups.warnings,
  };
}

/**
 * Move each folder of `<from>/.lpm_backups` to `<to>/.lpm_backups`, with the
 * copy and compare steps of a board move. A name that the new folder has
 * already gets the next free suffix. A backup that fails stays where it was,
 * and a line in `warnings` says why. The old folder is removed when it is empty.
 */
function moveBackups(from: string, to: string, copy: NonNullable<RelocateOptions['copy']>): { moved: string[]; warnings: string[] } {
  const oldDir = path.join(from, BACKUPS_DIR);
  const newDir = path.join(to, BACKUPS_DIR);
  const moved: string[] = [];
  const warnings: string[] = [];
  let names: string[];
  try {
    names = readdirSync(oldDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.endsWith(BACKUP_SUFFIX))
      .map((entry) => entry.name);
  } catch {
    return { moved, warnings };
  }
  for (const name of names) {
    const source = path.join(oldDir, name);
    try {
      mkdirSync(newDir, { recursive: true });
      const taken = centralBoardNames(newDir);
      const free = taken.some((other) => other.toLowerCase() === name.toLowerCase())
        ? allocateBackupName(name.slice(0, -BACKUP_SUFFIX.length), taken)
        : name;
      const target = path.join(newDir, free);
      copyChecked(source, target, () => false, copy);
      moved.push(target);
      removeTreeOrWarn(source, warnings);
    } catch (error) {
      warnings.push(`The backup ${source} stayed in the old store: ${(error as Error).message}`);
    }
  }
  try {
    if (readdirSync(oldDir).length === 0) rmSync(oldDir, { recursive: true, force: true });
  } catch {
    // The folder is gone already.
  }
  return { moved, warnings };
}

/** Make `newStore` the central store and move nothing. The old boards stay, and their projects still reach them. */
export function abandonCentralStore(newStore: string): string {
  return setCentralStore(newStore);
}

function moveOneCentralBoard(
  board: CentralBoardEntry,
  newBoards: string,
  copy: NonNullable<RelocateOptions['copy']>,
): MovedCentralBoard {
  const paths = boardPathsAt(board.lpmDir, { root: board.projectPath ?? board.lpmDir });
  return withBoardLock(paths, 'move the board to the new central store', () => {
    mkdirSync(newBoards, { recursive: true });
    const target = path.join(newBoards, allocateCentralName(board.name, centralBoardNames(newBoards)));
    copyChecked(board.lpmDir, target, isLockFileName, copy);

    let pointerUpdated = false;
    if (board.projectPath) {
      const pointed = readStorePointer(path.join(board.projectPath, LPM_DIR, CONFIG_FILE));
      if (pointed !== null && samePath(pointed, board.lpmDir)) {
        try {
          writeStorePointer(board.projectPath, target);
        } catch (error) {
          rmSync(target, { recursive: true, force: true });
          throw error;
        }
        pointerUpdated = true;
      }
    }
    renameIndexedBoard(board.lpmDir, target);
    const warnings: string[] = [];
    removeTreeOrWarn(board.lpmDir, warnings);
    return { name: board.name, from: board.lpmDir, to: target, root: board.projectPath, pointerUpdated, warnings };
  });
}

/** The store of the board of `paths`. Throws when the board is in `to` already. */
function checkTarget(paths: BoardPaths, to: BoardStore): void {
  const from: BoardStore = isCentralBoard(paths) ? 'central' : 'local';
  if (from === to) {
    throw new BoardError(
      to === 'central' ? `The board is already in the central store: ${paths.lpmDir}` : `The board is already in its project: ${paths.lpmDir}`,
    );
  }
}

function lockLabel(to: BoardStore): string {
  return `move the board to the ${to === 'central' ? 'central store' : 'project'}`;
}

/**
 * A move that is ready to copy. The caller copies `source` to `target`
 * without the paths that `skip` names, compares the two trees, and then calls
 * `commit`, which switches the folders. A failed copy removes `target`.
 */
interface MovePlan {
  source: string;
  target: string;
  skip: TreeSkip;
  commit(backup: BoardBackup | null): RelocateResult;
}

function planMove(paths: BoardPaths, to: BoardStore): MovePlan {
  return to === 'central' ? planToCentral(paths) : planToLocal(paths);
}

/** Move the board of `paths` to the central store or into its project. The comment at the top of this file lists the steps. */
export function relocateBoard(paths: BoardPaths, to: BoardStore, options: RelocateOptions = {}): RelocateResult {
  checkTarget(paths, to);
  const copy = options.copy ?? defaultCopy;
  return withBoardLock(paths, lockLabel(to), () => {
    const plan = planMove(paths, to);
    let backup: BoardBackup | null = null;
    try {
      if (options.backup !== false) backup = backupLocked(paths, { replace: true });
    } catch (error) {
      rmSync(plan.target, { recursive: true, force: true });
      throw error;
    }
    copyChecked(plan.source, plan.target, plan.skip, copy);
    return plan.commit(backup);
  });
}

/**
 * `relocateBoard` with async file calls and progress reports, for a server
 * that runs the move in the background. The steps are `backup` and `copy`,
 * or `copy` alone with `backup: false`.
 */
export function relocateBoardAsync(paths: BoardPaths, to: BoardStore, options: RelocateAsyncOptions = {}): Promise<RelocateResult> {
  checkTarget(paths, to);
  const withBackup = options.backup !== false;
  const steps = withBackup ? 2 : 1;
  return withBoardLockAsync(paths, lockLabel(to), async () => {
    const plan = planMove(paths, to);
    let backup: BoardBackup | null = null;
    try {
      if (withBackup) backup = await backupLockedAsync(paths, { replace: true, onProgress: options.onProgress }, 1, steps);
    } catch (error) {
      rmSync(plan.target, { recursive: true, force: true });
      throw error;
    }
    await copyCheckedAsync(plan.source, plan.target, plan.skip, NOTHING_MOVED, stepReporter(options.onProgress, 'copy', steps, steps));
    return plan.commit(backup);
  });
}

function planToCentral(paths: BoardPaths): MovePlan {
  const boardsDir = centralBoardsDir();
  if (boardsDir === null) {
    throw new BoardError('No central store is set. Name one with `lpm config set central_store <dir>`');
  }
  const root = paths.root;
  const source = paths.lpmDir;
  const target = createCentralBoardDir(root, boardsDir);
  // `createCentralBoardDir` made the folder to reserve the name, and the copy creates it again.
  rmSync(target, { recursive: true, force: true });
  return {
    source,
    target,
    skip: isLockFileName,
    commit: (backup) => {
      const moved = boardPathsAt(target, { root });
      const warnings: string[] = [];
      // Switch: the old folder steps aside, the pointer takes its place.
      const aside = freeSibling(source, 'moved');
      try {
        renameSync(source, aside);
      } catch (error) {
        rmSync(target, { recursive: true, force: true });
        throw new BoardError(`Could not move ${source} aside: ${(error as Error).message}`, [
          'Another program can have a file in it open. Close it and try again. Nothing was moved.',
        ]);
      }
      try {
        writeProjectFile(target, root);
        // A committed `.gitignore` must not change, so a git board ignores the file locally.
        if (existsSync(path.join(target, '.git'))) excludeLocally(moved, [PROJECT_FILE]);
        else ensureLocalIgnored(moved);
        writeStorePointer(root, target);
      } catch (error) {
        rmSync(path.join(root, LPM_DIR), { recursive: true, force: true });
        renameSync(aside, source);
        rmSync(target, { recursive: true, force: true });
        throw error;
      }
      removeTreeOrWarn(aside, warnings);
      return { from: 'local', to: 'central', paths: moved, previousDir: source, warnings, backup };
    },
  };
}

function planToLocal(paths: BoardPaths): MovePlan {
  const root = paths.root;
  const source = paths.lpmDir;
  if (path.resolve(root) === path.resolve(source)) {
    throw new BoardError(`No project is known for the board in ${source}`, [
      `Run the command in the project folder, whose ${LPM_DIR}/config.yml points at this board.`,
    ]);
  }
  const local = boardPathsFor(root);
  const staging = freeSibling(local.lpmDir, 'incoming');
  return {
    source,
    target: staging,
    skip: (relative) => isLockFileName(relative) || relative === PROJECT_FILE,
    commit: (backup) => {
      const warnings: string[] = [];
      // Switch: the pointer steps aside, the copy takes its place.
      const pointerAside = existsSync(local.lpmDir) ? freeSibling(local.lpmDir, 'pointer') : null;
      try {
        if (pointerAside) renameSync(local.lpmDir, pointerAside);
        renameSync(staging, local.lpmDir);
      } catch (error) {
        if (pointerAside && !existsSync(local.lpmDir)) renameSync(pointerAside, local.lpmDir);
        rmSync(staging, { recursive: true, force: true });
        throw new BoardError(`Could not put the board in ${local.lpmDir}: ${(error as Error).message}`, [
          'Another program can have a file in it open. Close it and try again. Nothing was moved.',
        ]);
      }
      if (pointerAside) removeTreeOrWarn(pointerAside, warnings);
      removeTreeOrWarn(source, warnings);
      return { from: 'central', to: 'local', paths: local, previousDir: source, warnings, backup };
    },
  };
}
