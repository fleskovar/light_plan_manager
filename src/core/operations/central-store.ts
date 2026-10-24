import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { BoardError } from '../errors.js';
import { samePath } from '../storage/central.js';
import {
  CENTRAL_DIR,
  CONFIG_FILE,
  LPM_DIR,
  expandHome,
  readProjectPath,
  readStorePointer,
} from '../storage/paths.js';
import { USER_SETTINGS_FILE, readUserSettings, userDir, writeUserSettings } from '../storage/user.js';

/**
 * The central store: one folder on this computer that holds the documents of
 * many boards, outside their project folders.
 *
 * The key `central_store` in `settings.json` of the user folder holds the
 * absolute path of the folder. When the key is absent, there is no central
 * store, and `lpm init` creates every board in its project. The boards are in
 * `<central_store>/.lpm_central/<name>/`, and each project keeps a pointer to
 * its board in `.lpm/config.yml` (see `resolveBoardDir` in `storage/paths.ts`).
 *
 * This module reads and writes the user folder. It never writes a board, so it
 * takes no board lock.
 */

/** The absolute path of the central store, or null when the key `central_store` is absent. */
export function centralStorePath(): string | null {
  const value = readUserSettings().central_store;
  return typeof value === 'string' && value.trim() ? path.resolve(expandHome(value.trim())) : null;
}

/** The folder that holds the central boards, `<central_store>/.lpm_central`, or null. */
export function centralBoardsDir(): string | null {
  const store = centralStorePath();
  return store === null ? null : path.join(store, CENTRAL_DIR);
}

/**
 * Write the key `central_store`. `dir` can start with `~`, and a relative path
 * resolves from the current folder. A missing folder is created. A path to a
 * file throws. Returns the absolute path that was stored.
 */
export function setCentralStore(dir: string): string {
  if (!dir.trim()) throw new BoardError('The central store path is empty');
  const absolute = path.resolve(expandHome(dir.trim()));
  let isDirectory: boolean | null = null;
  try {
    isDirectory = statSync(absolute).isDirectory();
  } catch {
    isDirectory = null;
  }
  if (isDirectory === false) {
    throw new BoardError(`The central store must be a folder, and ${absolute} is a file`, [
      'Name a folder. light-plan creates the folder when it does not exist.',
    ]);
  }
  if (isDirectory === null) mkdirSync(absolute, { recursive: true });
  writeUserSettings({ ...readUserSettings(), central_store: absolute });
  return absolute;
}

/** Remove the key `central_store`. The boards in the central store are not touched. */
export function unsetCentralStore(): void {
  const settings = readUserSettings();
  if (!('central_store' in settings)) return;
  const { central_store: _removed, ...rest } = settings;
  writeUserSettings(rest);
}

/** The characters that Windows refuses in a folder name, and the control characters. */
const REFUSED_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/g;

/** Names that Windows reserves for devices, with or without an extension. */
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** The name to use when nothing is left of the project name. */
const FALLBACK_NAME = 'board';

/**
 * The folder name for a new central board: the project folder name, with each
 * character that Windows refuses replaced by `-`, and `-board` appended to a
 * name that Windows reserves (`CON`, `NUL`, `COM1`, ...). When a name in `existing` is
 * the same (case not compared, as on Windows and macOS), the name gets the
 * lowest free suffix `-2`, `-3` and so on. Pure: the caller reads `existing`.
 */
export function allocateCentralName(projectName: string, existing: readonly string[]): string {
  const cleaned = projectName.replace(REFUSED_CHARACTERS, '-').replace(/[. ]+$/, '');
  const base = cleaned === '' ? FALLBACK_NAME : RESERVED_NAME.test(cleaned) ? `${cleaned}-${FALLBACK_NAME}` : cleaned;
  const taken = new Set(existing.map((name) => name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** The names of the folders in `.lpm_central`. A missing folder holds none. */
export function centralBoardNames(boardsDir: string): string[] {
  try {
    return readdirSync(boardsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Create a new, empty folder for the board of `project` in `.lpm_central` and
 * return it. `mkdirSync` without `recursive` fails when another process
 * created the same folder a moment before, so the loop takes the next name.
 */
export function createCentralBoardDir(project: string, boardsDir: string): string {
  mkdirSync(boardsDir, { recursive: true });
  const names = centralBoardNames(boardsDir);
  for (;;) {
    const name = allocateCentralName(path.basename(path.resolve(project)), names);
    const dir = path.join(boardsDir, name);
    try {
      mkdirSync(dir);
      return dir;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      names.push(name);
    }
  }
}

/** One board in `.lpm_central`, as `lpm store list` and the landing page of `lpm ui` show it. */
export interface CentralBoardEntry {
  /** The folder name in `.lpm_central`. */
  name: string;
  /** The central board folder. */
  lpmDir: string;
  /** The key `key_prefix` of its `config.yml`, or null when the file does not parse. */
  keyPrefix: string | null;
  /** The project that `project.json` names, or null when the file is missing. */
  projectPath: string | null;
  /**
   * True when the project folder exists and its pointer names this board
   * folder. False means that the project moved, was deleted, or points at
   * another board, so a command run in the project does not reach this board.
   */
  pointerOk: boolean;
  /** Why `config.yml` did not parse, or null. */
  error: string | null;
}

/**
 * The boards in `<central_store>/.lpm_central`, sorted by folder name. A folder
 * without `config.yml` is not a board and is left out. Reads two small files
 * for each board and never loads a whole board, so the list stays fast with
 * many boards.
 */
export function listCentralBoards(): CentralBoardEntry[] {
  const boardsDir = centralBoardsDir();
  if (boardsDir === null) return [];
  return centralBoardNames(boardsDir)
    .filter((name) => existsSync(path.join(boardsDir, name, CONFIG_FILE)))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => centralBoardEntry(path.join(boardsDir, name)));
}

function centralBoardEntry(lpmDir: string): CentralBoardEntry {
  let keyPrefix: string | null = null;
  let error: string | null = null;
  try {
    const parsed = parseYaml(readFileSync(path.join(lpmDir, CONFIG_FILE), 'utf8')) as unknown;
    const value = parsed && typeof parsed === 'object' ? (parsed as { key_prefix?: unknown }).key_prefix : undefined;
    keyPrefix = typeof value === 'string' ? value : null;
  } catch (thrown) {
    error = (thrown as Error).message.split('\n')[0] ?? 'config.yml does not parse';
  }
  const projectPath = readProjectPath(lpmDir);
  const pointer = projectPath === null ? null : readStorePointer(path.join(projectPath, LPM_DIR, CONFIG_FILE));
  return {
    name: path.basename(lpmDir),
    lpmDir,
    keyPrefix,
    projectPath,
    pointerOk: pointer !== null && samePath(pointer, lpmDir),
    error,
  };
}

/** The file that holds the key, for messages. */
export function userSettingsPath(): string {
  return path.join(userDir(), USER_SETTINGS_FILE);
}
