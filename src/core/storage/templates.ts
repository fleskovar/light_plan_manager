import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BoardPaths } from './paths.js';

/**
 * Context templates: `.lpm/templates/context/<name>.md`.
 *
 * These are the layouts `lpm instructions` renders a working brief with. They
 * are markdown with a little `{{ }}` in it, they live in the board so the team
 * shares them, and they are the one thing under `.lpm` that is not a document:
 * `load.ts` never opens this folder, `check` does not know it exists, and no
 * template can make a board invalid. A missing one is not an error — there is
 * always a built-in layout behind it.
 *
 * A template is named after the issue type it serves (`user_story.md`), with
 * `default.md` for every type that has none of its own. Nothing here knows
 * that; it is filing, not policy.
 */
export const CONTEXT_DIR = 'context';
export const DEFAULT_TEMPLATE = 'default';

export function contextTemplatesDir(paths: BoardPaths): string {
  return path.join(paths.templatesDir, CONTEXT_DIR);
}

export function contextTemplatePath(paths: BoardPaths, name: string): string {
  return path.join(contextTemplatesDir(paths), `${name}.md`);
}

/** The template names a board holds, sorted. Missing folder means none. */
export function listContextTemplates(paths: BoardPaths): string[] {
  const dir = contextTemplatesDir(paths);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name.slice(0, -'.md'.length))
      .sort();
  } catch {
    return [];
  }
}

/** One template's text, or null when the board does not have it. */
export function readContextTemplate(paths: BoardPaths, name: string): string | null {
  try {
    return readFileSync(contextTemplatePath(paths, name), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Write a template, never over one that is already there.
 * Returns false when a file of that name exists and `force` was not asked for —
 * somebody's edited layout is worth more than the starter it came from.
 */
export function writeContextTemplate(
  paths: BoardPaths,
  name: string,
  text: string,
  force = false,
): boolean {
  const file = contextTemplatePath(paths, name);
  if (!force && existsSync(file)) return false;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
  return true;
}
