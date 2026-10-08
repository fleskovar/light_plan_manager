import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { BoardError } from '../errors.js';
import type { NodeKind } from '../model/types.js';

export const LPM_DIR = '.lpm';
export const CONFIG_FILE = 'config.yml';
export const STATE_FILE = 'state.json';
/** Per-checkout settings (current user). Never committed. */
export const LOCAL_FILE = 'local.json';
/** Remote credentials, keyed by remote name. Never committed. */
export const CREDENTIALS_FILE = 'credentials.json';
/**
 * The one-writer-at-a-time lock. Exists only while somebody is mid-change, and
 * never committed — which process is writing is not a property of the plan.
 * @see src/core/storage/lock.ts
 */
export const LOCK_FILE = 'lock';
export const BOARD_DIR = 'board';
export const TIMELINE_DIR = 'timeline';
export const TEAM_DIR = 'team';
/** Where squads (named sub-teams of resources) live. */
export const SQUADS_DIR = 'squads';
/**
 * Where the template registry lives: reusable pieces of plan, written as
 * documents so the same engine reads them.
 *
 * Deliberately not under `templates/`, which holds the prompts a board is
 * written *with* (the context layouts). These are documents the board is
 * written *from*, and `load.ts` walks them like any other collection.
 */
export const REGISTRY_DIR = 'registry';
/** Where a board keeps the templates it writes with, rather than reads from. */
export const TEMPLATES_DIR = 'templates';
/** Where per-remote sync state lives: link stores, caches, audit logs. */
export const REMOTES_DIR = 'remotes';
/** The generated table of contents: every id, title and document, nested. */
export const INDEX_FILE = 'INDEX.md';
export const ISSUE_FILE = '_issue.md';
export const PERIOD_FILE = '_period.md';
export const RESOURCE_FILE = '_resource.md';
export const SQUAD_FILE = '_squad.md';
export const TEMPLATE_FILE = '_template.md';

export function documentFileName(kind: NodeKind): string {
  if (kind === 'issue') return ISSUE_FILE;
  if (kind === 'period') return PERIOD_FILE;
  if (kind === 'resource') return RESOURCE_FILE;
  return kind === 'template' ? TEMPLATE_FILE : SQUAD_FILE;
}

export interface BoardPaths {
  /** Directory that contains the `.lpm` folder. */
  root: string;
  lpmDir: string;
  boardDir: string;
  /** Where periods (sprints, increments, ...) live. */
  timelineDir: string;
  /** Where resources (people and generic pools) live. */
  teamDir: string;
  /** Where squads (named sub-teams of resources) live. */
  squadsDir: string;
  /** The template registry: reusable pieces of plan, as documents. */
  registryDir: string;
  /** Templates the board is written *with*: prompts, not documents. */
  templatesDir: string;
  /** Where per-remote sync state lives: link stores, caches, audit logs. */
  remotesDir: string;
  configPath: string;
  statePath: string;
  localPath: string;
  /** Where remote credentials live (`.lpm/credentials.json`). Never committed. */
  credentialsPath: string;
  /** Where the board's write lock lives while somebody holds it. */
  lockPath: string;
  /** The generated index of every document, at the top of the board folder. */
  indexPath: string;
}

/**
 * Points every command at one board from any working directory: set it to a
 * `.lpm` folder (or to the folder holding one) and nothing has to be run from
 * inside the checkout. An explicit path — `lpm mcp --root`, `lpm agent
 * --project` — is more specific and wins; `lpm init` ignores it, because
 * creating a board somewhere is not the same as reading the one you work on.
 */
export const BOARD_ENV_VAR = 'LPM_BOARD_PATH';

/**
 * A leading `~` means the home directory. Shells expand it themselves, but a
 * path out of a config file or an env var written by a tool has not been
 * through one.
 */
export function expandHome(ref: string): string {
  if (ref === '~' || ref.startsWith('~/') || ref.startsWith('~\\')) {
    return path.join(homedir(), ref.slice(1));
  }
  return ref;
}

/** The layout around a `.lpm` folder, wherever it sits. */
export function boardPathsAt(dir: string): BoardPaths {
  const lpmDir = path.resolve(dir);

  return {
    // The folder the board describes. Everything that reports a path relative
    // to it — `displayPath`, the board's name — needs the two to agree, so it
    // is derived from the board folder rather than carried alongside it.
    root: path.dirname(lpmDir),
    lpmDir,
    boardDir: path.join(lpmDir, BOARD_DIR),
    timelineDir: path.join(lpmDir, TIMELINE_DIR),
    teamDir: path.join(lpmDir, TEAM_DIR),
    squadsDir: path.join(lpmDir, SQUADS_DIR),
    registryDir: path.join(lpmDir, REGISTRY_DIR),
    templatesDir: path.join(lpmDir, TEMPLATES_DIR),
    remotesDir: path.join(lpmDir, REMOTES_DIR),
    configPath: path.join(lpmDir, CONFIG_FILE),
    statePath: path.join(lpmDir, STATE_FILE),
    localPath: path.join(lpmDir, LOCAL_FILE),
    credentialsPath: path.join(lpmDir, CREDENTIALS_FILE),
    lockPath: path.join(lpmDir, LOCK_FILE),
    indexPath: path.join(lpmDir, INDEX_FILE),
  };
}

/** The layout for the board a project keeps in its own `.lpm` folder. */
export function boardPathsFor(root: string): BoardPaths {
  return boardPathsAt(path.join(root, LPM_DIR));
}

export function collectionDir(paths: BoardPaths, kind: NodeKind): string {
  if (kind === 'issue') return paths.boardDir;
  if (kind === 'period') return paths.timelineDir;
  if (kind === 'resource') return paths.teamDir;
  return kind === 'template' ? paths.registryDir : paths.squadsDir;
}

/**
 * The board `LPM_BOARD_PATH` names, or null when it is not set. Either the
 * `.lpm` folder or the folder containing one will do, since both are the
 * obvious thing to write. A value that names no board **throws** rather than
 * falling back to the search: a typo that quietly worked on whichever board the
 * cwd happened to sit in is the failure nobody would notice.
 */
export function boardPathsFromEnv(): BoardPaths | null {
  const ref = process.env[BOARD_ENV_VAR]?.trim();
  if (!ref) return null;

  const target = path.resolve(expandHome(ref));
  for (const dir of [target, path.join(target, LPM_DIR)]) {
    if (existsSync(path.join(dir, CONFIG_FILE))) return boardPathsAt(dir);
  }
  throw new BoardError(`${BOARD_ENV_VAR} does not point at a board: ${ref}`, [
    `No ${CONFIG_FILE} in ${target} or ${path.join(target, LPM_DIR)}.`,
    `Point it at a ${LPM_DIR} folder, or unset it to search from the current folder.`,
  ]);
}

/**
 * The board to work on: `LPM_BOARD_PATH`, else the nearest `.lpm/config.yml`
 * at or above the current folder. Passing `from` asks about that folder in
 * particular — an explicit path is the more specific answer, so the
 * environment does not override it.
 */
export function findBoardPaths(from?: string): BoardPaths | null {
  if (from === undefined) {
    const fromEnv = boardPathsFromEnv();
    if (fromEnv) return fromEnv;
  }
  let dir = path.resolve(from ?? process.cwd());
  for (;;) {
    if (existsSync(path.join(dir, LPM_DIR, CONFIG_FILE))) return boardPathsFor(dir);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function slugify(text: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'untitled';
}

/**
 * The folder a document lives in: its id, and nothing else.
 *
 * The title used to be slugged onto the end, which reads well in a file tree
 * until nesting turns it into a path long enough to break tools (and, on
 * Windows, the filesystem). An id is short and never changes, so a folder is
 * never renamed because somebody edited a title, and a path stays quotable in a
 * commit message. `INDEX.md` is where the titles went — see `board-index.ts`.
 *
 * Folders written by an older version keep their slug until `check --fix`
 * renames them; `idFromDirName` reads both.
 */
export function nodeDirName(id: string): string {
  return id;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Pull `LP-12` out of a folder name — `LP-12`, or the older `LP-12-user-login`. */
export function idFromDirName(name: string, prefix: string): string | null {
  const match = new RegExp(`^(${escapeRegExp(prefix)}-\\d+)(?:-|$)`).exec(name);
  return match ? match[1]! : null;
}

/**
 * Turn `LP-12-user-login` back into `User login`, for deriving a missing title.
 * Folders named after the id alone carry no title to recover, so the name is
 * all there is to give back — `check` reports the derived title either way.
 */
export function titleFromDirName(name: string, prefix: string): string {
  const id = idFromDirName(name, prefix);
  const rest = id ? name.slice(id.length).replace(/^-/, '') : name;
  const words = rest.replace(/[-_]+/g, ' ').trim();
  if (!words) return name;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Path relative to the board root, using forward slashes for stable output. */
export function displayPath(paths: BoardPaths, target: string): string {
  return path.relative(paths.root, target).split(path.sep).join('/');
}
