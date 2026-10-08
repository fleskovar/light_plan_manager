import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LoadedBoard } from '../board/load.js';
import { findIssue } from '../board/query.js';
import { BoardError } from '../errors.js';
import type { BoardConfig, Issue } from '../model/types.js';
import type { BoardPaths } from '../storage/paths.js';
import { displayPath } from '../storage/paths.js';
import {
  DEFAULT_TEMPLATE,
  contextTemplatePath,
  listContextTemplates,
  readContextTemplate,
  writeContextTemplate,
} from '../storage/templates.js';
import type { TemplateFinding } from './analyze.js';
import { analyzeTemplate } from './analyze.js';
import { BUILTIN_CONTEXT_TEMPLATE } from './builtin.js';
import type { ContextOptions } from './context.js';
import { buildContext } from './context.js';
import { renderTemplate } from './template.js';

/**
 * A working brief: everything an agent or a developer needs to pick one issue
 * up, as one piece of markdown they can paste into a prompt.
 *
 * Read-only, and derived entirely from the board plus the config — assembling
 * context is reporting, like `board/tasks.ts`, not planning. The CLI and the
 * MCP server are thin printers over `buildInstructions`, so `lpm instructions
 * LP-12` and `get_instructions { id: "LP-12" }` hand out the same text.
 */

/** Where the layout that produced a brief came from. */
export interface TemplateSource {
  kind: 'builtin' | 'board' | 'file';
  /** `built-in`, a template name, or a path. */
  name: string;
  /** The file it was read from, relative to the board root. Null for built-in. */
  path: string | null;
  text: string;
}

export interface InstructionsOptions extends ContextOptions {
  /**
   * Override the layout: a template name in `.lpm/templates/context`, or a path
   * to a markdown file anywhere.
   */
  template?: string;
  /**
   * Render a template the safety check refused. Only ever set this from a flag
   * the person at the keyboard typed — never for an agent, and never for input
   * that arrived with somebody else's board.
   */
  allowUnsafe?: boolean;
}

export interface Instructions {
  issue: Issue;
  source: TemplateSource;
  text: string;
  /** Everything the template asked for that the board could not answer. */
  warnings: string[];
  /** What the safety check saw in the layout that produced this. */
  findings: TemplateFinding[];
}

// Three levels up from src/core/instructions (and dist/core/instructions) is
// the package root, where the starter templates ship. Keep in step with this
// file's depth, exactly like `operations/init.ts` and `agent/assets.ts`.
const STARTER_DIR = fileURLToPath(new URL('../../../templates/context/', import.meta.url));

/** Starter templates the package ships, by name. */
export function starterTemplateNames(): string[] {
  try {
    return readdirSync(STARTER_DIR)
      .filter((name) => name.endsWith('.md'))
      .map((name) => name.slice(0, -'.md'.length))
      .sort();
  } catch {
    return [];
  }
}

export function readStarterTemplate(name: string): string | null {
  try {
    return readFileSync(path.join(STARTER_DIR, `${name}.md`), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Write the starter templates a board's config can actually use: one per
 * declared issue type that has a starter, plus `default.md` for the rest.
 *
 * Nothing is overwritten without `force` — a layout somebody has edited is
 * worth more than the starter it grew from. Returns what it wrote and what it
 * left alone.
 */
export function installContextTemplates(
  paths: BoardPaths,
  config: BoardConfig,
  options: { force?: boolean } = {},
): { written: string[]; skipped: string[] } {
  const available = new Set(starterTemplateNames());
  const wanted = [
    DEFAULT_TEMPLATE,
    ...Object.keys(config.issue_types).filter((type) => available.has(type)),
  ].filter((name) => available.has(name));

  const written: string[] = [];
  const skipped: string[] = [];
  for (const name of wanted) {
    const text = readStarterTemplate(name);
    if (text === null) continue;
    if (writeContextTemplate(paths, name, text, options.force)) written.push(name);
    else skipped.push(name);
  }
  return { written, skipped };
}

function fromBoard(paths: BoardPaths, name: string): TemplateSource | null {
  const text = readContextTemplate(paths, name);
  if (text === null) return null;
  return {
    kind: 'board',
    name,
    path: displayPath(paths, contextTemplatePath(paths, name)),
    text,
  };
}

function fromFile(file: string): TemplateSource | null {
  const resolved = path.resolve(file);
  if (!existsSync(resolved)) return null;
  try {
    return { kind: 'file', name: resolved, path: resolved, text: readFileSync(resolved, 'utf8') };
  } catch {
    return null;
  }
}

/**
 * Which layout an issue of this type gets: the board's template for the type,
 * then the board's `default`, then the built-in one. An override is taken as a
 * template name first and as a path second, so `--template user_story` means
 * the board's, not a file that happens to be called that.
 */
export function resolveContextTemplate(
  paths: BoardPaths,
  type: string,
  override?: string,
): TemplateSource {
  if (override) {
    const named = fromBoard(paths, override.replace(/\.md$/, ''));
    if (named) return named;
    const file = fromFile(override);
    if (file) return file;

    const available = listContextTemplates(paths);
    throw new BoardError(`No context template "${override}"`, [
      available.length
        ? `This board has: ${available.join(', ')}.`
        : `This board has none yet — run \`lpm instructions --init\` to write the starters.`,
      'A --template is a name in .lpm/templates/context, or a path to a markdown file.',
    ]);
  }

  return (
    (type ? fromBoard(paths, type) : null) ??
    fromBoard(paths, DEFAULT_TEMPLATE) ?? {
      kind: 'builtin',
      name: 'built-in',
      path: null,
      text: BUILTIN_CONTEXT_TEMPLATE,
    }
  );
}

/** Resolve an issue by id, case-insensitively, or say so usefully. */
export function requireIssueFor(board: LoadedBoard, id: string): Issue {
  const issue = findIssue(board, id);
  if (!issue) {
    throw new BoardError(`No issue with id "${id}"`, [
      `Ids on this board look like ${board.config.key_prefix}-1.`,
    ]);
  }
  return issue;
}

/** The brief for one issue. */
export function buildInstructions(
  board: LoadedBoard,
  issue: Issue,
  options: InstructionsOptions = {},
): Instructions {
  const source = resolveContextTemplate(board.paths, issue.type, options.template);
  const context = buildContext(board, issue, options);
  const { text, warnings, findings } = renderTemplate(source.text, context, {
    name: source.path ?? 'the built-in template',
    allowUnsafe: options.allowUnsafe,
  });
  return { issue, source, text, warnings, findings };
}

/** One template's safety report, without rendering anything. */
export interface TemplateAudit {
  source: TemplateSource;
  findings: TemplateFinding[];
  /** Set when the template will not even parse. */
  error: string | null;
}

/**
 * Read every layout this board would use and report what is in them.
 *
 * The point of doing this per *type* rather than per file is that it answers
 * the question that matters — "what will actually run when somebody asks for a
 * brief?" — and it covers the built-in layout, which is not a file at all.
 */
export function auditContextTemplates(board: LoadedBoard): TemplateAudit[] {
  const types = Object.keys(board.config.issue_types);
  const audits: TemplateAudit[] = [];
  const seen = new Set<string>();

  for (const type of types) {
    const source = resolveContextTemplate(board.paths, type);
    const key = source.path ?? 'builtin';
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      audits.push({ source, findings: analyzeTemplate(source.text).findings, error: null });
    } catch (error) {
      audits.push({ source, findings: [], error: (error as Error).message });
    }
  }

  // Templates no type resolves to are still on disk and still reachable with
  // --template, so a report that skipped them would be telling half the story.
  for (const name of listContextTemplates(board.paths)) {
    const source = resolveContextTemplate(board.paths, '', name);
    if (seen.has(source.path ?? name)) continue;
    seen.add(source.path ?? name);
    try {
      audits.push({ source, findings: analyzeTemplate(source.text).findings, error: null });
    } catch (error) {
      audits.push({ source, findings: [], error: (error as Error).message });
    }
  }

  return audits;
}

/** The same, from an id — what both front ends actually call. */
export function instructionsFor(
  board: LoadedBoard,
  id: string,
  options: InstructionsOptions = {},
): Instructions {
  return buildInstructions(board, requireIssueFor(board, id), options);
}
