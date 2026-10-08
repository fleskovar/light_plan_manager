import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { BoardError } from '../errors.js';
import { writeFileAtomic } from './atomic.js';
import type { BoardPaths } from './paths.js';
import { slugify } from './paths.js';

/**
 * Saved views: JSON artifacts in `.lpm/views/`, committed alongside the board.
 *
 * Storage deliberately treats a view's contents as opaque. A view describes how
 * some tool chose to look at the board — which documents it shows and where it
 * put them — and none of that is board truth, so nothing in `board/` or
 * `validation/` may read it. The tool that writes a view owns its schema.
 */
export const VIEWS_DIR = 'views';

export function viewsDir(paths: BoardPaths): string {
  return path.join(paths.lpmDir, VIEWS_DIR);
}

/** Turn a display name into the id that names its file. */
export function viewIdFor(name: string): string {
  return slugify(name);
}

function viewPath(paths: BoardPaths, id: string): string {
  if (id !== slugify(id)) throw new BoardError(`Invalid view id "${id}"`);
  return path.join(viewsDir(paths), `${id}.json`);
}

export function listViewIds(paths: BoardPaths): string[] {
  const dir = viewsDir(paths);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();
}

export function viewExists(paths: BoardPaths, id: string): boolean {
  return existsSync(viewPath(paths, id));
}

export function readView(paths: BoardPaths, id: string): unknown {
  const file = viewPath(paths, id);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new BoardError(`No view "${id}"`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new BoardError(`View "${id}" is not valid JSON`, [(error as Error).message]);
  }
}

export function writeView(paths: BoardPaths, id: string, data: unknown): void {
  mkdirSync(viewsDir(paths), { recursive: true });
  writeFileAtomic(viewPath(paths, id), `${JSON.stringify(data, null, 2)}\n`);
}

export function deleteView(paths: BoardPaths, id: string): void {
  rmSync(viewPath(paths, id), { force: true });
}
