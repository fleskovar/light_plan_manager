import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomic.js';
import type { BoardPaths } from './paths.js';
import { CREDENTIALS_FILE, LOCAL_FILE, LOCK_FILE, expandHome } from './paths.js';

/**
 * Per-checkout settings, kept in `.lpm/local.json` and deliberately not
 * committed: who is sitting at this machine is not a property of the board.
 * `.lpm/.gitignore` excludes the file; `ensureLocalIgnored` adds the entry to
 * boards created before this existed.
 */
export interface LocalSettings {
  /** Id of the resource driving the CLI, or null when nobody is set. */
  user: string | null;
  /**
   * Path to this developer's profile file, or null. Stored as it was given, so
   * a path relative to the board root survives the checkout moving; read
   * through `profileRef`, which is what resolves it.
   */
  profile: string | null;
}

const EMPTY: LocalSettings = { user: null, profile: null };

/** Overrides the stored user; handy for CI and shared machines. */
export const USER_ENV_VAR = 'LPM_USER';
/** Overrides the stored profile path, for a shell that serves one developer. */
export const PROFILE_ENV_VAR = 'LPM_PROFILE';

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function readLocal(paths: BoardPaths): LocalSettings {
  try {
    const parsed = JSON.parse(readFileSync(paths.localPath, 'utf8')) as Partial<LocalSettings>;
    return { user: text(parsed.user), profile: text(parsed.profile) };
  } catch {
    return { ...EMPTY };
  }
}

export function writeLocal(paths: BoardPaths, settings: LocalSettings): void {
  writeFileAtomic(paths.localPath, `${JSON.stringify(settings, null, 2)}\n`);
  ensureLocalIgnored(paths);
}

/**
 * Whoever the CLI should act as, as written (an id or a name — the caller
 * resolves it against the roster). The environment wins over the stored value.
 */
export function currentUserRef(paths: BoardPaths): string | null {
  const fromEnv = process.env[USER_ENV_VAR]?.trim();
  if (fromEnv) return fromEnv;
  return readLocal(paths).user;
}

/** Where a reference to a profile file came from, so the CLI can say. */
export type ProfileSource = 'env' | 'local';

/**
 * The profile file to use, as written, and where that answer came from. The
 * environment wins, so one shell can serve a different developer than the
 * checkout is set up for.
 */
export function profileRef(paths: BoardPaths): { ref: string; source: ProfileSource } | null {
  const fromEnv = process.env[PROFILE_ENV_VAR]?.trim();
  if (fromEnv) return { ref: fromEnv, source: 'env' };
  const stored = readLocal(paths).profile;
  return stored ? { ref: stored, source: 'local' } : null;
}

/**
 * A stored path, made absolute. `~` is expanded because a profile is a file a
 * developer keeps in their home directory as often as in the repository, and
 * anything relative is resolved against the board root rather than the cwd, so
 * `lpm` gives the same answer from any folder in the checkout.
 */
export function resolveProfilePath(paths: BoardPaths, ref: string): string {
  return path.resolve(paths.root, expandHome(ref));
}

/** Pattern for credential files under `.lpm/remotes/` — never commit these. */
const CREDENTIALS_PATTERN = 'remotes/*/credentials*';

/**
 * The entries `.lpm/.gitignore` must carry, each with the comment that
 * precedes it. One source of truth so the heal (`ensureLocalIgnored`) and the
 * check (`checkGitignore`) cannot drift about what belongs in the file.
 */
const IGNORED_ENTRIES: ReadonlyArray<{ comment: string; entries: string[] }> = [
  { comment: '# Per-checkout settings (current user)', entries: [LOCAL_FILE] },
  {
    comment: '# Remote credentials (never commit these)',
    entries: [CREDENTIALS_FILE, CREDENTIALS_PATTERN],
  },
  {
    comment: '# Write lock, held only while a change is in flight',
    entries: [LOCK_FILE, `${LOCK_FILE}.stale.*`],
  },
];

/** The trimmed lines of `.lpm/.gitignore`, or [] when the file is absent. */
function gitignoreLines(paths: BoardPaths): string[] {
  try {
    return readFileSync(path.join(paths.lpmDir, '.gitignore'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim());
  } catch {
    return [];
  }
}

/**
 * The ignore entries this board's `.lpm/.gitignore` is still missing, in the
 * order they should appear. The read-only half of `ensureLocalIgnored`; the
 * check reports from this, and the fix calls the writer.
 */
export function missingIgnoredEntries(paths: BoardPaths): string[] {
  const lines = gitignoreLines(paths);
  const missing: string[] = [];
  for (const group of IGNORED_ENTRIES) {
    for (const entry of group.entries) {
      if (!lines.includes(entry)) missing.push(entry);
    }
  }
  return missing;
}

/**
 * Add `local.json`, the credentials file, the write lock and remote credential
 * patterns to `.lpm/.gitignore`. Returns true if the file changed.
 */
export function ensureLocalIgnored(paths: BoardPaths): boolean {
  const file = path.join(paths.lpmDir, '.gitignore');
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    // No .gitignore in the board yet; we create it below.
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim());

  const additions: string[] = [];

  for (const group of IGNORED_ENTRIES) {
    const missing = group.entries.filter((entry) => !lines.includes(entry));
    if (missing.length === 0) continue;
    // A group written over two versions should not grow a second heading: the
    // comment is only added when it is not already in the file.
    if (!lines.includes(group.comment)) additions.push(group.comment);
    additions.push(...missing, '');
  }

  if (additions.length === 0) return false;

  const separator = text === '' ? '' : text.endsWith('\n') ? '' : '\n';
  appendFileSync(file, `${separator}${additions.join('\n')}`, 'utf8');
  return true;
}
