import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMap, isScalar, parseDocument } from 'yaml';
import type { Document } from 'yaml';
import { parseConfigText } from '../config/schema.js';
import { BoardError } from '../errors.js';
import type { BoardPaths } from '../storage/paths.js';
import {
  listUserTemplates,
  readUserSettings,
  userTemplatePath,
  writeUserSettings,
  writeUserTemplate,
} from '../storage/user.js';
import { configWithExperimental } from './experimental.js';
import { configWithPlanning } from './planning.js';

/**
 * Board templates: the config files that `lpm init` copies into a new board.
 *
 * A board template is one YAML file that `parseConfigText` accepts. There are
 * two sources. A built-in template ships in the folder `templates/` of the
 * package. A user template is a file `templates/<name>.yml` in the user folder
 * (`storage/user.ts`), and `saveBoardTemplate` writes it from the config of a
 * board.
 *
 * The key `default_template` in `settings.json` of the user folder holds the
 * name of the template that `lpm init` uses when no `--template` is given.
 * `setDefaultBoardTemplate` writes the key. When the key is absent, or names a
 * template that no longer exists, `lpm init` uses `scrum`.
 *
 * A board does not record the template that it started from. After `lpm init`,
 * `.lpm/config.yml` is the only copy, and the board never reads the template
 * again.
 */

export const BUILTIN_TEMPLATES = ['scrum', 'kanban', 'blank'] as const;
export type BuiltinTemplate = (typeof BUILTIN_TEMPLATES)[number];

/** The template that `lpm init` uses when the user chose no default. */
export const FALLBACK_TEMPLATE: BuiltinTemplate = 'scrum';

// Three levels up from src/core/operations (and dist/core/operations) is the
// package root, where `templates/` is shipped. Keep in step with this file's depth.
const TEMPLATE_DIR = fileURLToPath(new URL('../../../templates/', import.meta.url));

export function builtinTemplatePath(name: string): string {
  return path.join(TEMPLATE_DIR, `${name}.yml`);
}

function isBuiltin(name: string): boolean {
  return (BUILTIN_TEMPLATES as readonly string[]).includes(name);
}

/** A name that is safe as a file name on every platform. */
const TEMPLATE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/**
 * The keys of `.lpm/config.yml` that describe one board and no other. A
 * template leaves them out: a new board has no tracker, no git remote and no
 * period documents, and `lpm init --planning` decides its planning mode.
 *
 * `keepComment` says what happens to the comment above the key. The shipped
 * configs end with a guide to remotes, and `yaml` attaches that guide to the
 * key that follows it. The guide stays in the template. The comment above
 * `default_period` or `git_sync` describes that key only, and goes with it.
 */
const BOARD_ONLY_KEYS = [
  { key: 'remotes', keepComment: true },
  { key: 'remotes_off', keepComment: true },
  { key: 'git_sync', keepComment: false },
  { key: 'default_period', keepComment: false },
];

/** Remove a top-level key. With `keepComment`, the comment above it moves to the next key, or to the end of the file. */
function deleteKey(doc: Document, key: string, keepComment: boolean): void {
  const root = doc.contents;
  if (!isMap(root)) return;
  const index = root.items.findIndex((pair) => (isScalar(pair.key) ? pair.key.value : pair.key) === key);
  if (index === -1) return;
  const removed = root.items[index]!.key;
  const comment = isScalar(removed) ? removed.commentBefore : undefined;
  root.items.splice(index, 1);
  if (!keepComment || !comment) return;

  const join = (...parts: Array<string | null | undefined>): string => parts.filter(Boolean).join('\n');
  const next = root.items[index]?.key;
  if (isScalar(next)) next.commentBefore = join(comment, next.commentBefore);
  else doc.comment = join(doc.comment, comment);
}

export interface BoardTemplateInfo {
  name: string;
  source: 'builtin' | 'user';
  file: string;
}

/** Every template that `lpm init --template <name>` accepts by name: the built-in ones, then the user's. */
export function listBoardTemplates(): BoardTemplateInfo[] {
  return [
    ...BUILTIN_TEMPLATES.map((name) => ({
      name,
      source: 'builtin' as const,
      file: builtinTemplatePath(name),
    })),
    ...listUserTemplates()
      .filter((name) => !isBuiltin(name))
      .map((name) => ({ name, source: 'user' as const, file: userTemplatePath(name) })),
  ];
}

/** The template that `lpm init` uses when no `--template` is given. */
export function defaultBoardTemplate(): string {
  const chosen = readUserSettings().default_template;
  if (chosen && listBoardTemplates().some((template) => template.name === chosen)) return chosen;
  return FALLBACK_TEMPLATE;
}

/** Write the key `default_template` in `settings.json` of the user folder. */
export function setDefaultBoardTemplate(name: string): void {
  if (!listBoardTemplates().some((template) => template.name === name)) {
    throw new BoardError(`No board template called "${name}"`, [
      `Available templates: ${listBoardTemplates().map((template) => template.name).join(', ')}`,
    ]);
  }
  writeUserSettings({ ...readUserSettings(), default_template: name });
}

/**
 * The text of a template and the name to report for it. `template` is the name
 * of a built-in template, the name of a user template, or a path to a config
 * file. The three are tried in that order.
 */
export function readBoardTemplate(template: string): { text: string; name: string } {
  const named = listBoardTemplates().find((entry) => entry.name === template);
  const file = named ? named.file : path.resolve(template);
  try {
    return { text: readFileSync(file, 'utf8'), name: named ? named.name : file };
  } catch {
    const user = listUserTemplates().filter((name) => !isBuiltin(name));
    throw new BoardError(`Cannot read template "${template}"`, [
      `Built-in templates: ${BUILTIN_TEMPLATES.join(', ')}`,
      ...(user.length ? [`Your templates: ${user.join(', ')}`] : []),
      'Or pass a path to your own config YAML.',
    ]);
  }
}

/**
 * The text of a board config without the keys `planning` and `experimental`
 * and without the keys of `BOARD_ONLY_KEYS`. Every other key stays as the
 * board wrote it.
 *
 * `configWithPlanning` and `configWithExperimental` remove their key from the
 * text, with the comment that the command wrote above it. The other keys are
 * removed from the `yaml` document. A template does not hold `experimental`,
 * because a new board must not show features whose packages nobody installed.
 */
export function boardTemplateText(configText: string): string {
  const doc = parseDocument(configWithExperimental(configWithPlanning(configText, 'periods'), false));
  for (const { key, keepComment } of BOARD_ONLY_KEYS) deleteKey(doc, key, keepComment);
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}

export interface SaveBoardTemplateResult {
  name: string;
  file: string;
  /** True when the call replaced a user template of the same name. */
  replaced: boolean;
}

/**
 * Save the config of a board as a user template, so that `lpm init --template
 * <name>` starts a new board with the same statuses, types, hierarchy and
 * attributes. The documents, the template registry and the context templates
 * of the board are not part of the template.
 */
export function saveBoardTemplate(
  paths: BoardPaths,
  name: string,
  options: { overwrite?: boolean } = {},
): SaveBoardTemplateResult {
  if (!TEMPLATE_NAME_RE.test(name)) {
    throw new BoardError(`Invalid template name "${name}"`, [
      'Use 1 to 40 lower-case letters, digits, "-" or "_", starting with a letter or a digit.',
    ]);
  }
  if (isBuiltin(name)) {
    throw new BoardError(`"${name}" is a built-in template`, ['Choose another name.']);
  }
  const file = userTemplatePath(name);
  const replaced = existsSync(file);
  if (replaced && !options.overwrite) {
    throw new BoardError(`A template called "${name}" already exists`, [
      `It is the file ${file}.`,
      'Choose another name, or replace the template.',
    ]);
  }

  const text = boardTemplateText(readFileSync(paths.configPath, 'utf8'));
  const parsed = parseConfigText(text);
  if (!parsed.config) {
    throw new BoardError('The board config does not validate, so it cannot become a template', parsed.errors);
  }
  writeUserTemplate(name, text);
  return { name, file, replaced };
}

/** Delete a user template. When it was the default, the key `default_template` is removed with it. */
export function removeBoardTemplate(name: string): void {
  if (isBuiltin(name)) throw new BoardError(`"${name}" is a built-in template and cannot be deleted`);
  const file = userTemplatePath(name);
  if (!TEMPLATE_NAME_RE.test(name) || !existsSync(file)) {
    throw new BoardError(`No template called "${name}"`);
  }
  rmSync(file);
  const settings = readUserSettings();
  if (settings.default_template === name) {
    const { default_template: _removed, ...rest } = settings;
    writeUserSettings(rest);
  }
}
