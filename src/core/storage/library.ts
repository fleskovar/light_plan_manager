import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { BoardError } from '../errors.js';
import { writeFileAtomic } from './atomic.js';
import { firstHeading, parseFrontmatter, stringifyFrontmatter } from './frontmatter.js';
import type { BoardPaths } from './paths.js';
import {
  LIBRARY_REF_PREFIX,
  isLibraryRef,
  libraryRef,
  normalizeLibraryId,
  parseLibraryRef,
} from '../../shared/library-id.js';

export { LIBRARY_REF_PREFIX, isLibraryRef, libraryRef, normalizeLibraryId, parseLibraryRef };

/**
 * The library of a board: markdown documents in `<board folder>/library/`.
 *
 * A library document holds text that belongs beside the plan and is not a
 * piece of the plan: a prompt with instructions, a summary of a development,
 * a product requirements document. It has no type, no status and no place in
 * the hierarchy, so `load.ts` never reads this folder and `check` reads it only
 * to find references that point at nothing.
 *
 * **The id.** A document's id is its path below the library folder, without
 * the `.md` extension, with `/` between folders: the file
 * `library/prompts/code-review.md` has the id `prompts/code-review`. Each part
 * of an id holds lowercase letters, digits, `-`, `_` and `.`, and starts with a
 * letter or a digit. A file whose name breaks this rule stays on disk, and
 * `listLibraryDocs` leaves it out (`check` reports it).
 *
 * **Folders.** A folder below the library folder groups documents. A folder
 * stays when its last document leaves it, and each folder that the library
 * creates holds `FOLDER_KEEP_FILE`, so git keeps an empty folder too.
 * `listLibraryFolders` lists every folder, also the empty ones.
 *
 * **The file.** Optional YAML frontmatter, then the markdown body. Two keys of
 * the frontmatter have a meaning: `title` and `description`. Other keys stay
 * as they are on each write. Without `title`, the title is the first level-1
 * heading of the body, or the last part of the id.
 *
 * **A reference.** An issue or a template names a document with the text
 * `library:<id>` in its `related_files`, or with a markdown link whose target
 * is `library:<id>` in its body. `src/shared/library-id.ts` holds the id rule
 * and the prefix, because the web app reads references too.
 */
export const LIBRARY_DIR = 'library';

export interface LibraryDoc {
  /** The path below the library folder without `.md`, for example `prompts/code-review`. */
  id: string;
  title: string;
  /**
   * True when the frontmatter holds the key `title`. False when the title
   * comes from the first heading or from the id. A save writes the key
   * `title` only when this is true or when the caller passes a title.
   */
  titled: boolean;
  description: string;
  /** The markdown after the frontmatter. */
  body: string;
  /** The frontmatter keys other than `title` and `description`. */
  extra: Record<string, unknown>;
  /** The absolute path of the file. */
  file: string;
  /** The modification time of the file, as an ISO date. */
  updated: string;
  /**
   * The first 16 hex digits of the SHA-256 digest of the file. An update can
   * pass the revision it read, and the write is refused when the file changed.
   */
  revision: string;
}

export interface LibraryDocInput {
  title?: string;
  description?: string;
  body?: string;
  extra?: Record<string, unknown>;
}

export function libraryDir(paths: BoardPaths): string {
  return path.join(paths.lpmDir, LIBRARY_DIR);
}

/** The normal id of `raw`. Throws a `BoardError` that names the rule when `raw` is not valid. */
export function requireLibraryId(raw: string): string {
  const id = normalizeLibraryId(raw);
  if (id === null) {
    throw new BoardError(`"${raw}" is not a valid library id`, [
      'An id is a path below .lpm/library without .md, for example prompts/code-review.',
      'Each part holds lowercase letters, digits, "-", "_" and ".", and starts with a letter or a digit.',
    ]);
  }
  return id;
}

const BODY_LINK_RE = /\]\(\s*<?library:([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/gi;

/**
 * The ids that the markdown links of a body name, in the order of the body,
 * without duplicates: `[the PRD](library:prd/payments)` names `prd/payments`.
 * A link with an invalid id is left out.
 */
export function libraryRefsInBody(body: string): string[] {
  const found: string[] = [];
  for (const match of body.matchAll(BODY_LINK_RE)) {
    const id = normalizeLibraryId(match[1]!);
    if (id !== null && !found.includes(id)) found.push(id);
  }
  return found;
}

/** The ids of library documents that a document references: `related_files` first, then the body links. */
export function libraryRefsOf(node: { related_files?: readonly string[]; body: string }): string[] {
  const ids: string[] = [];
  for (const ref of node.related_files ?? []) {
    const id = parseLibraryRef(ref);
    if (id !== null && !ids.includes(id)) ids.push(id);
  }
  for (const id of libraryRefsInBody(node.body)) if (!ids.includes(id)) ids.push(id);
  return ids;
}

export function libraryDocPath(paths: BoardPaths, id: string): string {
  const normal = requireLibraryId(id);
  return path.join(libraryDir(paths), ...normal.split('/')) + '.md';
}

function revisionOf(raw: string): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function lastPart(id: string): string {
  const name = id.split('/').at(-1) ?? id;
  const words = name.replace(/[-_.]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name;
}

function parseDoc(id: string, file: string, raw: string): LibraryDoc {
  let data: Record<string, unknown> = {};
  let body = raw;
  try {
    const parsed = parseFrontmatter(raw);
    data = parsed.data;
    body = parsed.body;
  } catch {
    // Frontmatter that is not valid YAML stays part of the body, so the reader
    // still sees the text, and a save writes it back unchanged.
  }
  const { title, description, ...extra } = data;
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  let updated = '';
  try {
    updated = statSync(file).mtime.toISOString();
  } catch {
    // The file went away between the read and the stat.
  }
  return {
    id,
    title: text(title) || firstHeading(body)?.trim() || lastPart(id),
    titled: text(title) !== '',
    description: text(description),
    body: body.replace(/^\s*\n/, ''),
    extra,
    file,
    updated,
    revision: revisionOf(raw),
  };
}

/** One document, or null when the library has no document with this id. */
export function readLibraryDoc(paths: BoardPaths, id: string): LibraryDoc | null {
  const normal = normalizeLibraryId(id);
  if (normal === null) return null;
  const file = libraryDocPath(paths, normal);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  return parseDoc(normal, file, raw);
}

/** A markdown file below the library folder, with the id that it would have. */
export interface LibraryFile {
  /** The path below the library folder, with `/`, for example `Prompts/Review.md`. */
  relative: string;
  /** The id of the file, or null when its path breaks the id rule. */
  id: string | null;
}

/** Every markdown file below the library folder, sorted by path. Dot-entries are skipped. */
export function listLibraryFiles(paths: BoardPaths): LibraryFile[] {
  const root = libraryDir(paths);
  const out: LibraryFile[] = [];
  const walk = (dir: string, prefix: string[]): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), [...prefix, entry.name]);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        const relative = [...prefix, entry.name].join('/');
        const id = normalizeLibraryId(relative);
        // A capital letter makes the id differ from the file name, and the
        // file cannot be found by that id on a case-sensitive filesystem.
        out.push({ relative, id: id !== null && `${id}.md` === relative ? id : null });
      }
    }
  };
  walk(root, []);
  return out.sort((a, b) => a.relative.localeCompare(b.relative));
}

/** Every document whose file name is a valid id, sorted by id. */
export function listLibraryDocs(paths: BoardPaths): LibraryDoc[] {
  const docs: LibraryDoc[] = [];
  for (const entry of listLibraryFiles(paths)) {
    if (entry.id === null) continue;
    const doc = readLibraryDoc(paths, entry.id);
    if (doc) docs.push(doc);
  }
  return docs;
}

/** The text of a library file: frontmatter with `title`, `description` and the other keys, then the body. */
export function renderLibraryDoc(input: LibraryDocInput): string {
  const data: Record<string, unknown> = {};
  const title = input.title?.trim();
  const description = input.description?.trim();
  if (title) data.title = title;
  if (description) data.description = description;
  Object.assign(data, input.extra ?? {});
  const body = (input.body ?? '').trimEnd();
  if (!Object.keys(data).length) return body ? `${body}\n` : '';
  return stringifyFrontmatter(data, body);
}

/**
 * The file that keeps a folder in git. Git stores files and no folders, so a
 * folder without a file disappears on the next clone. The library writes this
 * file into each folder that it creates.
 */
export const FOLDER_KEEP_FILE = '.gitkeep';

/** The absolute path of a folder below the library folder. `folder` obeys the id rule. */
export function libraryFolderPath(paths: BoardPaths, folder: string): string {
  return path.join(libraryDir(paths), ...requireLibraryId(folder).split('/'));
}

export function libraryFolderExists(paths: BoardPaths, folder: string): boolean {
  const normal = normalizeLibraryId(folder);
  if (normal === null) return false;
  try {
    return statSync(libraryFolderPath(paths, normal)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every folder below the library folder whose path obeys the id rule, also an
 * empty one, sorted by path. Dot-entries are skipped. A folder whose name
 * breaks the rule is left out, together with everything inside it.
 */
export function listLibraryFolders(paths: BoardPaths): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string[]): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
      const parts = [...prefix, entry.name];
      const relative = parts.join('/');
      if (normalizeLibraryId(relative) !== relative) continue;
      out.push(relative);
      walk(path.join(dir, entry.name), parts);
    }
  };
  walk(libraryDir(paths), []);
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * Create the folder `folder` and each folder above it, and write
 * `FOLDER_KEEP_FILE` into each one that has none. An empty `folder` names the
 * library folder itself, which gets no keep file. The caller holds the board
 * lock.
 */
export function ensureLibraryFolder(paths: BoardPaths, folder: string): void {
  const root = libraryDir(paths);
  mkdirSync(root, { recursive: true });
  if (!folder) return;
  let dir = root;
  for (const part of requireLibraryId(folder).split('/')) {
    dir = path.join(dir, part);
    mkdirSync(dir, { recursive: true });
    const keep = path.join(dir, FOLDER_KEEP_FILE);
    if (!existsSync(keep)) writeFileAtomic(keep, '');
  }
}

/** The folder part of an id: `prompts` for `prompts/review`, and an empty text for `notes`. */
export function libraryParentOf(id: string): string {
  const at = id.lastIndexOf('/');
  return at === -1 ? '' : id.slice(0, at);
}

/** Write a document, and create its folders. The caller holds the board lock. */
export function writeLibraryDoc(paths: BoardPaths, id: string, input: LibraryDocInput): string {
  const file = libraryDocPath(paths, id);
  ensureLibraryFolder(paths, libraryParentOf(requireLibraryId(id)));
  writeFileAtomic(file, renderLibraryDoc(input));
  return file;
}

/**
 * Delete a document. Its folder stays, also when the delete left it empty,
 * because a folder is part of the structure that a person set up. The caller
 * holds the board lock.
 */
export function deleteLibraryDoc(paths: BoardPaths, id: string): void {
  rmSync(libraryDocPath(paths, id), { force: true });
}

/**
 * Rename the file of the document `from` to the file of the id `to`, and
 * create the folders of `to`. The folder of `from` stays. The caller holds the
 * board lock and checked that no document has the id `to`.
 */
export function renameLibraryDocFile(paths: BoardPaths, from: string, to: string): void {
  const target = libraryDocPath(paths, to);
  ensureLibraryFolder(paths, libraryParentOf(requireLibraryId(to)));
  renameSync(libraryDocPath(paths, from), target);
}

/**
 * Rename the folder `from` to `to`, with everything inside it, also the empty
 * folders. The caller holds the board lock and checked that `to` does not
 * exist and is not inside `from`.
 */
export function renameLibraryFolder(paths: BoardPaths, from: string, to: string): void {
  const target = libraryFolderPath(paths, to);
  ensureLibraryFolder(paths, libraryParentOf(requireLibraryId(to)));
  renameSync(libraryFolderPath(paths, from), target);
}

/** Delete a folder with everything inside it. The caller holds the board lock. */
export function deleteLibraryFolder(paths: BoardPaths, folder: string): void {
  rmSync(libraryFolderPath(paths, folder), { recursive: true, force: true });
}

/**
 * The text `ref` with its library id replaced through `moves`, which maps an
 * old id to a new id. A text that is not a `library:` reference, or whose id
 * `moves` does not hold, comes back unchanged.
 */
export function rewriteLibraryRef(ref: string, moves: ReadonlyMap<string, string>): string {
  const id = parseLibraryRef(ref);
  const next = id === null ? undefined : moves.get(id);
  return next === undefined ? ref : libraryRef(next);
}

/**
 * The body with the target of each `[label](library:<id>)` link replaced
 * through `moves`. The label, the title and every other character of the
 * link stay as they are.
 */
export function rewriteLibraryLinks(body: string, moves: ReadonlyMap<string, string>): string {
  return body.replace(BODY_LINK_RE, (whole, raw: string) => {
    const id = normalizeLibraryId(raw);
    const next = id === null ? undefined : moves.get(id);
    if (next === undefined) return whole;
    // The prefix can be written with capitals, so find it without regard to case.
    const target = `${LIBRARY_REF_PREFIX}${raw}`;
    const at = whole.toLowerCase().indexOf(target.toLowerCase());
    return `${whole.slice(0, at)}${libraryRef(next)}${whole.slice(at + target.length)}`;
  });
}

export function libraryDocExists(paths: BoardPaths, id: string): boolean {
  const normal = normalizeLibraryId(id);
  return normal !== null && existsSync(libraryDocPath(paths, normal));
}
