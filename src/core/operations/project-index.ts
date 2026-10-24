import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { isCentralBoard, samePath } from '../storage/central.js';
import type { BoardPaths } from '../storage/paths.js';
import { CONFIG_FILE, LPM_DIR, resolveBoardDir } from '../storage/paths.js';
import type { StoredProject } from '../storage/project-index.js';
import { readProjectIndex, writeProjectIndex } from '../storage/project-index.js';
import { listCentralBoards } from './central-store.js';

/**
 * The rules of the project index (`projects.json` in the user folder).
 *
 * The CLI records the board of each command (`recordProject`). `listProjects`
 * joins the index with the boards in the central store, so a central board
 * that no command used yet is listed too. The list never trusts the index for
 * where a board is: it resolves each project again, so a board that moved
 * between the project and the central store is listed where it is now.
 */

/** Whether a listed project can be opened. */
export type ProjectState = 'ok' | 'project missing' | 'missing';

/** One project as `lpm projects` and the "All projects" page show it. */
export interface ProjectEntry {
  /** The project folder name, or the board folder name when the project is not known. */
  name: string;
  /** The project folder, or null for a central board without `project.json`. */
  root: string | null;
  /** The board folder: `<root>/.lpm`, or a folder in `.lpm_central`. */
  lpmDir: string;
  store: 'local' | 'central';
  /** The key `key_prefix` of the board config, or null when it cannot be read. */
  keyPrefix: string | null;
  /** The last command that recorded the project, or null for a board that no command recorded. */
  lastUsed: string | null;
  /**
   * `ok`: the board is where the list says. `project missing`: a central board
   * whose project folder is gone or points elsewhere. `missing`: no board at
   * the recorded place.
   */
  state: ProjectState;
}

/**
 * Set to `off` to stop the CLI from recording projects, for example in CI or
 * in a test suite. Any other value, or no value, records.
 */
export const PROJECT_INDEX_ENV = 'LPM_PROJECT_INDEX';

/**
 * `recordProject` for the CLI: honours `LPM_PROJECT_INDEX=off`, and never
 * throws. A command must not fail because the index could not be written.
 */
export function recordProjectQuietly(paths: BoardPaths): void {
  if (process.env[PROJECT_INDEX_ENV]?.trim().toLowerCase() === 'off') return;
  try {
    recordProject(paths);
  } catch {
    // The index is a convenience. The next command records the project again.
  }
}

/** Add or update the entry of the project of `paths`. */
export function recordProject(paths: BoardPaths, now: Date = new Date()): void {
  const entry: StoredProject = {
    root: path.resolve(paths.root),
    lpmDir: path.resolve(paths.lpmDir),
    store: isCentralBoard(paths) ? 'central' : 'local',
    lastUsed: now.toISOString(),
  };
  const others = readProjectIndex().filter((stored) => !samePath(stored.root, entry.root));
  writeProjectIndex([...others, entry]);
}

/** The key prefix of the board in `lpmDir`, or null. Reads one small file, not the board. */
function keyPrefixOf(lpmDir: string): string | null {
  try {
    const parsed = parseYaml(readFileSync(path.join(lpmDir, CONFIG_FILE), 'utf8')) as { key_prefix?: unknown } | null;
    return typeof parsed?.key_prefix === 'string' ? parsed.key_prefix : null;
  } catch {
    return null;
  }
}

/** Where the board of a stored project is now, and its state. */
function resolveStored(stored: StoredProject): Omit<ProjectEntry, 'name' | 'lastUsed'> {
  const pointerOrConfig = path.join(stored.root, LPM_DIR, CONFIG_FILE);
  if (existsSync(pointerOrConfig)) {
    try {
      const paths = resolveBoardDir(path.join(stored.root, LPM_DIR), stored.root);
      return {
        root: stored.root,
        lpmDir: paths.lpmDir,
        store: isCentralBoard(paths) ? 'central' : 'local',
        keyPrefix: keyPrefixOf(paths.lpmDir),
        state: 'ok',
      };
    } catch {
      // A pointer to a board that is gone: the board is missing.
      return { root: stored.root, lpmDir: stored.lpmDir, store: stored.store, keyPrefix: null, state: 'missing' };
    }
  }
  if (stored.store === 'central' && existsSync(path.join(stored.lpmDir, CONFIG_FILE))) {
    return {
      root: stored.root,
      lpmDir: stored.lpmDir,
      store: 'central',
      keyPrefix: keyPrefixOf(stored.lpmDir),
      state: 'project missing',
    };
  }
  return { root: stored.root, lpmDir: stored.lpmDir, store: stored.store, keyPrefix: null, state: 'missing' };
}

/** Every project of the index and of the central store, sorted by name. */
export function listProjects(): ProjectEntry[] {
  const entries: ProjectEntry[] = readProjectIndex().map((stored) => ({
    name: path.basename(stored.root),
    lastUsed: stored.lastUsed,
    ...resolveStored(stored),
  }));
  for (const board of listCentralBoards()) {
    if (entries.some((entry) => samePath(entry.lpmDir, board.lpmDir))) continue;
    entries.push({
      name: path.basename(board.projectPath ?? board.lpmDir),
      root: board.projectPath,
      lpmDir: board.lpmDir,
      store: 'central',
      keyPrefix: board.keyPrefix,
      lastUsed: null,
      state: board.pointerOk ? 'ok' : 'project missing',
    });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/**
 * Point the entries of the board folder `from` at `to`, after a board moved.
 * The index is a convenience, so a failure to write it is ignored.
 */
export function renameIndexedBoard(from: string, to: string): void {
  try {
    const stored = readProjectIndex();
    if (!stored.some((entry) => samePath(entry.lpmDir, from))) return;
    writeProjectIndex(
      stored.map((entry) => (samePath(entry.lpmDir, from) ? { ...entry, lpmDir: path.resolve(to) } : entry)),
    );
  } catch {
    // The next command in the project records the new folder.
  }
}

/** Remove the entry of the project folder `root`. Returns false when no entry had it. */
export function forgetProject(root: string): boolean {
  const stored = readProjectIndex();
  const kept = stored.filter((entry) => !samePath(entry.root, root));
  if (kept.length === stored.length) return false;
  writeProjectIndex(kept);
  return true;
}

/** Remove each entry in the state `missing`. Returns their project folders. */
export function pruneProjects(): string[] {
  const missing = listProjects()
    .filter((entry) => entry.state === 'missing' && entry.root !== null)
    .map((entry) => entry.root!);
  if (!missing.length) return [];
  writeProjectIndex(readProjectIndex().filter((entry) => !missing.some((root) => samePath(root, entry.root))));
  return missing;
}
