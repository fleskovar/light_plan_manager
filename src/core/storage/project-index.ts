import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomic.js';
import { userDir } from './user.js';

/**
 * The project index: `projects.json` in the user folder. It lists every
 * project that an `lpm` command worked on, on this computer, for this user.
 *
 * ```json
 * { "projects": [ { "root": "/work/shop", "lpmDir": "/work/shop/.lpm", "store": "local", "lastUsed": "2026-10-24T10:00:00.000Z" } ] }
 * ```
 *
 * This module reads and writes the file. `operations/project-index.ts` owns the
 * rules: which entry a board belongs to, and what state a project is in.
 */
export const PROJECT_INDEX_FILE = 'projects.json';

/** One project as the index stores it. */
export interface StoredProject {
  /** The project folder. */
  root: string;
  /** The board folder when the entry was last written. */
  lpmDir: string;
  store: 'local' | 'central';
  /** ISO time of the last command that recorded the project. */
  lastUsed: string;
}

export function projectIndexPath(): string {
  return path.join(userDir(), PROJECT_INDEX_FILE);
}

function isStoredProject(value: unknown): value is StoredProject {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.root === 'string' &&
    typeof entry.lpmDir === 'string' &&
    (entry.store === 'local' || entry.store === 'central') &&
    typeof entry.lastUsed === 'string'
  );
}

/** The stored projects. A missing file, or a file that does not parse, holds none. */
export function readProjectIndex(): StoredProject[] {
  try {
    const parsed = JSON.parse(readFileSync(projectIndexPath(), 'utf8')) as { projects?: unknown };
    return Array.isArray(parsed.projects) ? parsed.projects.filter(isStoredProject) : [];
  } catch {
    return [];
  }
}

export function writeProjectIndex(projects: StoredProject[]): void {
  mkdirSync(userDir(), { recursive: true });
  writeFileAtomic(projectIndexPath(), `${JSON.stringify({ projects }, null, 2)}\n`);
}
