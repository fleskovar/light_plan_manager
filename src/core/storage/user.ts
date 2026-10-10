import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from './atomic.js';
import { expandHome } from './paths.js';

/**
 * The user folder: the files that belong to one person on one machine, and to
 * no board.
 *
 * The folder is `~/.light-plan`. The environment variable `LPM_HOME` names
 * another folder, which is how the tests keep away from the real one. The
 * folder is not `~/.lpm`: `findBoardPaths` reads a `.lpm` folder as a board,
 * and a board in the home folder would answer for every project below it.
 *
 * The folder holds two things:
 *
 * - `templates/<name>.yml` holds one board template. `lpm init --template
 *   <name>` reads it, and `saveBoardTemplate` writes it.
 * - `settings.json` holds the key `default_template`. The value is the name of
 *   the template that `lpm init` uses when no `--template` is given. When the
 *   key is absent, `lpm init` uses `scrum`.
 *
 * Nothing here knows what a template contains. `operations/board-template.ts`
 * owns the rules.
 */
export const USER_HOME_ENV_VAR = 'LPM_HOME';
export const USER_DIR = '.light-plan';
export const USER_SETTINGS_FILE = 'settings.json';
export const USER_TEMPLATES_DIR = 'templates';

export interface UserSettings {
  /** The board template that `lpm init` uses when no `--template` is given. */
  default_template?: string;
}

export function userDir(): string {
  const ref = process.env[USER_HOME_ENV_VAR]?.trim();
  return ref ? path.resolve(expandHome(ref)) : path.join(homedir(), USER_DIR);
}

export function userTemplatesDir(): string {
  return path.join(userDir(), USER_TEMPLATES_DIR);
}

export function userTemplatePath(name: string): string {
  return path.join(userTemplatesDir(), `${name}.yml`);
}

/** The names of the user templates, sorted. A missing folder holds none. */
export function listUserTemplates(): string[] {
  const dir = userTemplatesDir();
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.yml'))
      .map((entry) => entry.name.slice(0, -'.yml'.length))
      .sort();
  } catch {
    return [];
  }
}

/** The settings of the user. A missing file or a file that does not parse gives no settings. */
export function readUserSettings(): UserSettings {
  try {
    const parsed = JSON.parse(readFileSync(path.join(userDir(), USER_SETTINGS_FILE), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as UserSettings) : {};
  } catch {
    return {};
  }
}

export function writeUserSettings(settings: UserSettings): void {
  mkdirSync(userDir(), { recursive: true });
  writeFileAtomic(path.join(userDir(), USER_SETTINGS_FILE), `${JSON.stringify(settings, null, 2)}\n`);
}

export function writeUserTemplate(name: string, text: string): string {
  const file = userTemplatePath(name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, text);
  return file;
}
