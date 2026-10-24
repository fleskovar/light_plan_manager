import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { BoardError } from '../errors.js';
import { isCentralBoard, samePath, writeProjectFile, writeStorePointer } from '../storage/central.js';
import { ensureLocalIgnored, excludeLocally } from '../storage/local.js';
import { withBoardLock } from '../storage/lock.js';
import type { BoardPaths } from '../storage/paths.js';
import {
  CENTRAL_DIR,
  CONFIG_FILE,
  LOCK_FILE,
  LPM_DIR,
  PROJECT_FILE,
  boardPathsAt,
  boardPathsFor,
  expandHome,
  readStorePointer,
} from '../storage/paths.js';
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
 * 1. Copy the board folder to the target, without the lock file (and without
 *    `project.json` on the way back). The central store can be on another
 *    drive, where `renameSync` fails with `EXDEV`, so the move never renames
 *    across folders.
 * 2. Compare the two file lists and sizes.
 * 3. Switch. Each step of the switch is a rename inside one parent folder, and
 *    the old folder is deleted only after the new one is in place.
 *
 * The whole move runs under the board lock, so no `lpm` process writes while
 * the files are copied. A process that already holds `BoardPaths` of the old
 * folder (a running `lpm ui` or MCP server) keeps the old paths until it is
 * restarted.
 */

export interface RelocateOptions {
  /** Copies the folder `from` into the new, empty folder `to`. Tests pass one that fails. */
  copy?: (from: string, to: string, filter: (source: string) => boolean) => void;
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
}

const defaultCopy: NonNullable<RelocateOptions['copy']> = (from, to, filter) => {
  cpSync(from, to, { recursive: true, filter, errorOnExist: true, force: false });
};

/** `lock` and `lock.stale.*` belong to one process and never move. */
function isLockFile(name: string): boolean {
  return name === LOCK_FILE || name.startsWith(`${LOCK_FILE}.stale.`);
}

/** Every file below `dir` with its size, relative, for comparing a copy with its source. */
function inventory(dir: string, skip: (relative: string) => boolean): Map<string, number> {
  const result = new Map<string, number>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const relative = path.relative(dir, full);
      if (skip(relative)) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) result.set(relative, statSync(full).size);
    }
  };
  walk(dir);
  return result;
}

function sameInventory(a: Map<string, number>, b: Map<string, number>): string | null {
  for (const [file, size] of a) {
    if (!b.has(file)) return `${file} is missing from the copy`;
    if (b.get(file) !== size) return `${file} has another size in the copy`;
  }
  for (const file of b.keys()) if (!a.has(file)) return `${file} is in the copy only`;
  return null;
}

/** A sibling path of `dir` that does not exist yet, for a rename in the same parent folder. */
function sibling(dir: string, label: string): string {
  for (let attempt = 0; ; attempt++) {
    const candidate = `${dir}.${label}-${process.pid}-${attempt}`;
    if (!existsSync(candidate)) return candidate;
  }
}

/** Remove a folder, or return a warning when the platform refuses. */
function removeOrWarn(dir: string, warnings: string[]): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch (error) {
    warnings.push(`Could not delete ${dir}: ${(error as Error).message}. Delete it by hand.`);
  }
}

/**
 * Copy `source` into the new folder `target` and check the copy. On a failure,
 * remove `target` and throw: the source is not touched.
 */
function copyChecked(source: string, target: string, skip: (relative: string) => boolean, copy: NonNullable<RelocateOptions['copy']>): void {
  try {
    const filter = (file: string): boolean => {
      const relative = path.relative(source, file);
      return relative === '' || !skip(relative);
    };
    copy(source, target, filter);
    const problem = sameInventory(inventory(source, skip), inventory(target, () => false));
    if (problem) throw new BoardError(`The copy of the board is not complete: ${problem}`, ['Nothing was moved.']);
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
 * project is rewritten when it names the old folder.
 *
 * The move stops at the first board that fails. That board stays where it
 * was, and the key keeps naming the old store. The boards that moved already
 * work from the new store, because each pointer holds the full path. Running
 * the call again moves the boards that are left, and then writes the key.
 */
export function moveCentralStore(newStore: string, options: RelocateOptions = {}): MoveCentralStoreResult {
  const target = path.resolve(expandHome(newStore.trim()));
  const previous = centralStorePath();
  const base = { previous, moved: [] as MovedCentralBoard[], failure: null, leftBehind: [] as string[] };
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
  setCentralStore(target);
  return { ...base, store: target, moved, unchanged: false, leftBehind };
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
    copyChecked(board.lpmDir, target, (relative) => isLockFile(relative), copy);

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
    removeOrWarn(board.lpmDir, warnings);
    return { name: board.name, from: board.lpmDir, to: target, root: board.projectPath, pointerUpdated, warnings };
  });
}

export function relocateBoard(paths: BoardPaths, to: BoardStore, options: RelocateOptions = {}): RelocateResult {
  const from: BoardStore = isCentralBoard(paths) ? 'central' : 'local';
  if (from === to) {
    throw new BoardError(
      to === 'central' ? `The board is already in the central store: ${paths.lpmDir}` : `The board is already in its project: ${paths.lpmDir}`,
    );
  }
  const copy = options.copy ?? defaultCopy;
  return withBoardLock(paths, `move the board to the ${to === 'central' ? 'central store' : 'project'}`, () =>
    to === 'central' ? toCentral(paths, copy) : toLocal(paths, copy),
  );
}

function toCentral(paths: BoardPaths, copy: NonNullable<RelocateOptions['copy']>): RelocateResult {
  const boardsDir = centralBoardsDir();
  if (boardsDir === null) {
    throw new BoardError('No central store is set. Name one with `lpm config set central_store <dir>`');
  }
  const root = paths.root;
  const source = paths.lpmDir;
  const target = createCentralBoardDir(root, boardsDir);
  // `createCentralBoardDir` made the folder, and `cpSync` wants to create it.
  rmSync(target, { recursive: true, force: true });
  copyChecked(source, target, (relative) => isLockFile(relative), copy);

  const moved = boardPathsAt(target, { root });
  const warnings: string[] = [];
  // Switch: the old folder steps aside, the pointer takes its place.
  const aside = sibling(source, 'moved');
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
  removeOrWarn(aside, warnings);
  return { from: 'local', to: 'central', paths: moved, previousDir: source, warnings };
}

function toLocal(paths: BoardPaths, copy: NonNullable<RelocateOptions['copy']>): RelocateResult {
  const root = paths.root;
  const source = paths.lpmDir;
  if (path.resolve(root) === path.resolve(source)) {
    throw new BoardError(`No project is known for the board in ${source}`, [
      `Run the command in the project folder, whose ${LPM_DIR}/config.yml points at this board.`,
    ]);
  }
  const local = boardPathsFor(root);
  const staging = sibling(local.lpmDir, 'incoming');
  copyChecked(source, staging, (relative) => isLockFile(relative) || relative === PROJECT_FILE, copy);

  const warnings: string[] = [];
  // Switch: the pointer steps aside, the copy takes its place.
  const pointerAside = existsSync(local.lpmDir) ? sibling(local.lpmDir, 'pointer') : null;
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
  if (pointerAside) removeOrWarn(pointerAside, warnings);
  removeOrWarn(source, warnings);
  return { from: 'central', to: 'local', paths: local, previousDir: source, warnings };
}
