import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildBoard } from '../board/load.js';
import { parseConfigText } from '../config/schema.js';
import { BoardError } from '../errors.js';
import { installContextTemplates } from '../instructions/instructions.js';
import { planningOf } from '../config/lookup.js';
import type { BoardConfig, PlanningMode } from '../model/types.js';
import { hasPeriods, hasResources } from '../model/types.js';
import { gitInit, isGitRepo } from '../storage/git.js';
import { ensureLocalIgnored } from '../storage/local.js';
import type { BoardPaths } from '../storage/paths.js';
import { LPM_DIR, boardPathsFor } from '../storage/paths.js';
import { writeState } from '../storage/state.js';
import { writeBoardIndex } from './board-index.js';
import { defaultBoardTemplate, readBoardTemplate } from './board-template.js';
import { createPeriod } from './create.js';
import { configWithPlanning } from './planning.js';

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
  /**
   * The name of a built-in template, the name of a user template, or a path to
   * a config file. When omitted, `defaultBoardTemplate` decides.
   */
  template?: string;
  prefix?: string;
  /** Make `.lpm` its own git repo and ignore it in the surrounding repo. */
  git?: boolean;
  /**
   * Seed the standing omni periods on a board with a timeline (default true).
   * Pass false for a board that will be planned period by period from day one.
   */
  omni?: boolean;
  /** `YYYY-MM-DD` the omni periods start on; today when omitted. */
  today?: string;
  /**
   * The planning mode the board starts in (default `queue`). On a template
   * with period types, `queue` writes the key `planning` with the value `queue`
   * into the new config, and `periods` leaves the key out. A template with no
   * period types is in queue mode whatever is passed, and gets no key.
   */
  planning?: PlanningMode;
}

export interface InitResult {
  paths: BoardPaths;
  template: string;
  prefix: string;
  gitInitialized: boolean;
  gitignoreUpdated: boolean;
  /** Context templates written into `.lpm/templates/context`, by name. */
  contextTemplates: string[];
  /** The omni periods seeded, outermost first; empty when none were. */
  omniPeriods: { id: string; title: string }[];
  /** The planning mode the new board is in. */
  planning: PlanningMode;
  /** True when the template declares period types, so the mode can be switched. */
  hasPeriods: boolean;
}

export function initBoard(options: InitOptions): InitResult {
  const root = path.resolve(options.root);
  const paths = boardPathsFor(root);

  if (existsSync(paths.configPath)) {
    throw new BoardError(`A board already exists at ${paths.lpmDir}`);
  }

  const { text, name } = readBoardTemplate(options.template ?? defaultBoardTemplate());
  const prefix = options.prefix ?? derivePrefix(path.basename(root));
  if (!/^[A-Z][A-Z0-9]{0,9}$/.test(prefix)) {
    throw new BoardError(
      `Invalid key prefix "${prefix}"`,
      ['Use 1-10 uppercase letters or digits, starting with a letter (e.g. LP, ACME2).'],
    );
  }

  const prefixed = withPrefix(text, prefix);
  const template = parseConfigText(prefixed);
  if (!template.config) {
    throw new BoardError(`Template "${name}" is not a valid board config`, template.errors);
  }

  // A new board starts in queue mode: most projects begin without a sprint
  // plan, and `lpm planning periods` is one command when a team wants one. A
  // template that already states `planning:` keeps its own value, and a
  // template with no period types needs no key at all.
  const startsInQueue =
    (options.planning ?? 'queue') === 'queue' &&
    hasPeriods(template.config) &&
    !/^planning:/m.test(prefixed);
  const configText = startsInQueue ? configWithPlanning(prefixed, 'queue') : prefixed;
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

  const omniPeriods =
    hasPeriods(config) && options.omni !== false ? seedOmniPeriods(paths, config, options.today) : [];

  let gitInitialized = false;
  let gitignoreUpdated = false;
  if (options.git !== false) {
    if (!existsSync(path.join(paths.lpmDir, '.git'))) {
      gitInitialized = gitInit(paths.lpmDir);
    }
    if (isGitRepo(root)) gitignoreUpdated = ensureGitignoreEntry(root);
  }

  return {
    paths,
    template: name,
    prefix,
    gitInitialized,
    gitignoreUpdated,
    contextTemplates,
    omniPeriods,
    planning: planningOf(config),
    hasPeriods: hasPeriods(config),
  };
}

/** How long the omni chain runs. A year on, `lpm period <id> --start-now` renews it. */
const OMNI_SPAN_DAYS = 365;

const OMNI_BODY = `## What this is

A standing period \`lpm init\` created so a board that does not plan by the
calendar still has a running timebox. While this chain is the board's whole
timeline, every new issue nobody scheduled lands here (\`default_period\` in
\`.lpm/config.yml\`), so nothing is left unscheduled.

## Planning for real

Create your own increments and sprints whenever you want them. From the first
one on, new issues arrive unscheduled for you to place, and this chain stops
catching them. Move the work you want into your periods, then delete the chain
(\`lpm rm <outermost id>\` unschedules whatever is still in it) and remove
\`default_period\` from the config.
`;

function addDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

/**
 * One period per level of `period_hierarchy`, each inside the one above, and
 * `default_period` pointed at the innermost — so on a simple project the
 * timeline is set up and nobody has to think about it. The config line goes in
 * beside `period_prefix` rather than at the end, so it sits with the timeline
 * settings a reader would look for it under.
 */
function seedOmniPeriods(
  paths: BoardPaths,
  config: BoardConfig,
  today = new Date().toISOString().slice(0, 10),
): { id: string; title: string }[] {
  const ends = addDays(today, OMNI_SPAN_DAYS - 1);
  const seeded: { id: string; title: string }[] = [];
  for (const level of config.period_hierarchy) {
    const type = level[0]!;
    const label = config.period_types[type]?.label ?? type;
    // A fresh handle each time: the second level's parent is the document the
    // first create has just written, and a handle is a photograph of a moment.
    const period = createPeriod(buildBoard(paths, config), {
      type,
      title: `Omni ${label}`,
      starts: today,
      ends,
      parentId: seeded.at(-1)?.id,
      body: OMNI_BODY,
    });
    seeded.push({ id: period.id, title: period.title });
  }

  const innermost = seeded.at(-1)!.id;
  const line =
    '# The catch-all every new issue is scheduled in while the omni periods are\n' +
    '# the whole timeline. Delete it once you plan in periods of your own.\n' +
    `default_period: ${innermost}`;
  const text = readFileSync(paths.configPath, 'utf8');
  const updated = /^period_prefix:.*$/m.test(text)
    ? text.replace(/^period_prefix:.*$/m, (match) => `${match}\n\n${line}`)
    : `${text}\n${line}\n`;
  writeFileSync(paths.configPath, updated, 'utf8');
  return seeded;
}
