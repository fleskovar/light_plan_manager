import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBoard } from '../board/load.js';
import { parseConfigText } from '../config/schema.js';
import { BoardError } from '../errors.js';
import { installContextTemplates } from '../instructions/instructions.js';
import { hasPeriods, hasResources } from '../model/types.js';
import { gitInit, isGitRepo } from '../storage/git.js';
import { ensureLocalIgnored } from '../storage/local.js';
import type { BoardPaths } from '../storage/paths.js';
import { LPM_DIR, boardPathsFor } from '../storage/paths.js';
import { writeState } from '../storage/state.js';
import { writeBoardIndex } from './board-index.js';

export const BUILTIN_TEMPLATES = ['scrum', 'kanban', 'blank'] as const;
export type BuiltinTemplate = (typeof BUILTIN_TEMPLATES)[number];

// Three levels up from src/core/operations (and dist/core/operations) is the
// package root, where `templates/` is shipped. Keep in step with this file's depth.
const TEMPLATE_DIR = fileURLToPath(new URL('../../../templates/', import.meta.url));

export function builtinTemplatePath(name: string): string {
  return path.join(TEMPLATE_DIR, `${name}.yml`);
}

function readTemplate(template: string): { text: string; name: string } {
  const isBuiltin = (BUILTIN_TEMPLATES as readonly string[]).includes(template);
  const file = isBuiltin ? builtinTemplatePath(template) : path.resolve(template);
  try {
    return { text: readFileSync(file, 'utf8'), name: isBuiltin ? template : file };
  } catch {
    throw new BoardError(`Cannot read template "${template}"`, [
      `Built-in templates: ${BUILTIN_TEMPLATES.join(', ')}`,
      'Or pass a path to your own config YAML.',
    ]);
  }
}

/** `light_plan` -> `LP`, `myapp` -> `MY`. Falls back to `LP`. */
export function derivePrefix(dirName: string): string {
  const words = dirName.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const candidate =
    words.length > 1
      ? words.map((word) => word[0]!).join('')
      : (words[0] ?? '').slice(0, 2);
  const prefix = candidate.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  return /^[A-Z][A-Z0-9]{0,9}$/.test(prefix) ? prefix : 'LP';
}

function withPrefix(text: string, prefix: string): string {
  if (/^key_prefix:.*$/m.test(text)) {
    return text.replace(/^key_prefix:.*$/m, `key_prefix: ${prefix}`);
  }
  return `key_prefix: ${prefix}\n${text}`;
}

/** Add `.lpm/` to the surrounding repo's .gitignore. Returns true if it changed. */
export function ensureGitignoreEntry(root: string): boolean {
  const file = path.join(root, '.gitignore');
  const entry = `${LPM_DIR}/`;
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    // No .gitignore yet; we create it below.
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(entry) || lines.includes(LPM_DIR)) return false;

  const separator = text === '' ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  appendFileSync(
    file,
    `${separator}# light-plan board (tracked as its own git repo)\n${entry}\n`,
    'utf8',
  );
  return true;
}

export interface InitOptions {
  root: string;
  template?: string;
  prefix?: string;
  /** Make `.lpm` its own git repo and ignore it in the surrounding repo. */
  git?: boolean;
}

export interface InitResult {
  paths: BoardPaths;
  template: string;
  prefix: string;
  gitInitialized: boolean;
  gitignoreUpdated: boolean;
  /** Context templates written into `.lpm/templates/context`, by name. */
  contextTemplates: string[];
}

export function initBoard(options: InitOptions): InitResult {
  const root = path.resolve(options.root);
  const paths = boardPathsFor(root);

  if (existsSync(paths.configPath)) {
    throw new BoardError(`A board already exists at ${paths.lpmDir}`);
  }

  const { text, name } = readTemplate(options.template ?? 'scrum');
  const prefix = options.prefix ?? derivePrefix(path.basename(root));
  if (!/^[A-Z][A-Z0-9]{0,9}$/.test(prefix)) {
    throw new BoardError(
      `Invalid key prefix "${prefix}"`,
      ['Use 1-10 uppercase letters or digits, starting with a letter (e.g. LP, ACME2).'],
    );
  }

  const configText = withPrefix(text, prefix);
  const { config, errors } = parseConfigText(configText);
  if (!config) {
    throw new BoardError(`Template "${name}" is not a valid board config`, errors);
  }

  mkdirSync(paths.boardDir, { recursive: true });
  writeFileSync(paths.configPath, configText, 'utf8');
  writeState(paths, {
    counter: 0,
    period_counter: 0,
    resource_counter: 0,
    squad_counter: 0,
    template_counter: 0,
  });
  writeFileSync(path.join(paths.boardDir, '.gitkeep'), '', 'utf8');
  ensureLocalIgnored(paths);

  // Starter layouts for `lpm instructions`, chosen by the types this config
  // actually declares — a board is handed the briefs its own hierarchy can
  // fill in, and falls back to `default.md` for the rest.
  const contextTemplates = installContextTemplates(paths, config).written;

  // Only boards that declare a time hierarchy get a timeline folder.
  if (hasPeriods(config)) {
    mkdirSync(paths.timelineDir, { recursive: true });
    writeFileSync(path.join(paths.timelineDir, '.gitkeep'), '', 'utf8');
  }
  // ...and only boards with a roster get a team folder.
  if (hasResources(config)) {
    mkdirSync(paths.teamDir, { recursive: true });
    writeFileSync(path.join(paths.teamDir, '.gitkeep'), '', 'utf8');
  }

  // An empty index, so the file every operation rewrites exists from the start
  // and a reader is never left guessing whether the board has one.
  writeBoardIndex(buildBoard(paths, config));

  let gitInitialized = false;
  let gitignoreUpdated = false;
  if (options.git !== false) {
    if (!existsSync(path.join(paths.lpmDir, '.git'))) {
      gitInitialized = gitInit(paths.lpmDir);
    }
    if (isGitRepo(root)) gitignoreUpdated = ensureGitignoreEntry(root);
  }

  return { paths, template: name, prefix, gitInitialized, gitignoreUpdated, contextTemplates };
}
