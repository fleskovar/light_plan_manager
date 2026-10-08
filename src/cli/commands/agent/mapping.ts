import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { BoardError } from '../../../core/index.js';
import type { ServerKey } from '../mcp/config.js';
import type { AssetFile, Role } from './assets.js';
import { ROLES, assetsDir, inRoles } from './assets.js';
import { matcher } from './glob.js';

/**
 * Harness mappings: which files go where, declared rather than coded.
 *
 * A mapping is a list of copy rules. Each selects source files from `assets/`
 * with `.gitignore`-style patterns and says where they land, so **any file can
 * go to any place** — markdown whose frontmatter is rewritten for the host, or a
 * script copied byte for byte. Adding a harness is a YAML file; adding an asset
 * is a file in `assets/`. Nothing in `src/` should ever learn a harness's name.
 *
 * The template language is deliberately tiny, because a configuration format
 * that grows a language is a program in a bad language:
 *
 *   {project} {home}      where the install is going
 *   {root}                this harness's root for the chosen scope
 *   {path} {dir}          the source path / its directory, relative to assets/
 *   {name} {basename}     the file name, without and with its extension
 *   {ext}                 the extension, no dot
 *   {description}         from the file's frontmatter, when it has any
 *   {tools} {tools|join}  ditto; as a list when it is the whole value
 *   {roles} {roles|join}  ditto
 *
 * A frontmatter value that resolves to nothing is dropped, so a rule can ask
 * for `tools` without every file having some.
 */

export type Scope = 'project' | 'user';

const rootSchema = z.union([
  z.string(),
  z
    .object({
      /** An environment variable that may move this root (COPILOT_HOME). */
      env: z.string(),
      default: z.string(),
    })
    .strict(),
]);

/** One or more `.gitignore`-style patterns; later ones win, `!` excludes. */
const patternsSchema = z
  .union([z.string(), z.array(z.string()).min(1)])
  .transform((value) => (typeof value === 'string' ? [value] : value));

export const ruleSchema = z
  .object({
    from: patternsSchema,
    to: z.string().min(1),
    /**
     * Present: parse the source as markdown-with-frontmatter and replace the
     * frontmatter with this. Absent: copy the file byte for byte.
     */
    frontmatter: z.record(z.string(), z.unknown()).optional(),
    /** Narrow this rule to some roles, for files that declare none themselves. */
    roles: z.array(z.enum(ROLES as [Role, ...Role[]])).optional(),
    /** Only apply for one scope. Omit for both. */
    scope: z.enum(['project', 'user']).optional(),
  })
  .strict();

const mcpRuleSchema = z
  .object({
    file: z.string().optional(),
    key: z.enum(['mcpServers', 'servers']).default('mcpServers'),
    /** Printed when there is no file we can safely write. */
    advice: z.string().optional(),
  })
  .strict();

const harnessSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/, 'must be lower-kebab-case'),
    label: z.string().min(1),
    docs: z.string().optional(),
    verified: z.string().optional(),
    aliases: z.array(z.string()).default([]),
    roots: z.object({ project: rootSchema, user: rootSchema }).strict(),
    files: z.array(ruleSchema).min(1),
    mcp: z.object({ project: mcpRuleSchema, user: mcpRuleSchema }).partial().default({}),
    pointer: z.object({ project: z.string(), user: z.string() }).partial().optional(),
    note: z.string().optional(),
  })
  .strict();

export type Harness = z.infer<typeof harnessSchema>;
export type CopyRule = z.infer<typeof ruleSchema>;
export type McpRule = z.infer<typeof mcpRuleSchema>;

function harnessesDir(): string {
  return path.join(assetsDir(), 'harnesses');
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const where = issue.path.length ? issue.path.join('.') : '(root)';
    return `${where}: ${issue.message}`;
  });
}

/**
 * Parse one mapping. `expected` is the file's basename, which the declared name
 * has to match — a mapping that answers to a different name than its file is a
 * rename half-done, and `--target` would silently miss it.
 *
 * The schema is `.strict()` throughout, so a mistyped key is an error rather
 * than a rule that quietly does nothing.
 */
export function parseHarnessText(text: string, expected: string, where = expected): Harness {
  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch (error) {
    throw new BoardError(`${where} is not valid YAML`, [(error as Error).message]);
  }
  const parsed = harnessSchema.safeParse(doc);
  if (!parsed.success) {
    throw new BoardError(`${where} is not a valid harness mapping`, formatIssues(parsed.error));
  }
  if (parsed.data.name !== expected) {
    throw new BoardError(`${where} declares name "${parsed.data.name}"`, [
      "A mapping's name has to match its file name.",
    ]);
  }
  return parsed.data;
}

function parseHarness(file: string): Harness {
  return parseHarnessText(readFileSync(file, 'utf8'), path.basename(file, '.yml'), file);
}

let cache: Harness[] | null = null;

/** Every mapping this package ships, in file order. */
export function loadHarnesses(): Harness[] {
  if (cache) return cache;
  const dir = harnessesDir();
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.yml')).sort();
  } catch (error) {
    throw new BoardError(`Cannot read the harness mappings in ${dir}`, [
      (error as Error).message,
      'This package looks incomplete; reinstall light-plan.',
    ]);
  }
  cache = names.map((name) => parseHarness(path.join(dir, name)));
  return cache;
}

export function harnessNames(): string[] {
  return loadHarnesses().map((harness) => harness.name);
}

/** Resolve what a person typed, against names and aliases, ignoring punctuation. */
export function findHarness(value: string): Harness | null {
  const flatten = (text: string): string => text.toLowerCase().replace(/[\s_-]+/g, '');
  const wanted = flatten(value.trim());
  return (
    loadHarnesses().find(
      (harness) =>
        flatten(harness.name) === wanted || harness.aliases.some((alias) => flatten(alias) === wanted),
    ) ?? null
  );
}

/** The values a template may refer to. */
export interface Vars {
  project: string;
  home: string;
  root?: string;
  path?: string;
  dir?: string;
  name?: string;
  basename?: string;
  ext?: string;
  description?: string;
  tools?: string[];
  roles?: string[];
}

/** The placeholders that hold a list: joined inline, kept a list when whole. */
const LISTS = ['tools', 'roles'] as const;
type ListKey = (typeof LISTS)[number];

const PLACEHOLDERS = [
  'project',
  'home',
  'root',
  'path',
  'dir',
  'name',
  'basename',
  'ext',
  'description',
  'tools',
  'roles',
] as const;

function expand(template: string, vars: Vars): string {
  return template.replace(/\{([a-z]+)(?:\|(join))?\}/g, (whole, key: string) => {
    if ((LISTS as readonly string[]).includes(key)) return (vars[key as ListKey] ?? []).join(', ');
    const value = vars[key as keyof Vars];
    if (typeof value !== 'string') {
      throw new BoardError(`Unknown or unavailable placeholder "${whole}"`, [
        `Known: ${PLACEHOLDERS.join(', ')}.`,
        'A file with no frontmatter has no {description} or {tools}.',
      ]);
    }
    return value;
  });
}

/** A path template, expanded and made absolute with native separators. */
function expandPath(template: string, vars: Vars): string {
  return path.normalize(expand(template, vars));
}

function resolveRoot(root: z.infer<typeof rootSchema>, vars: Vars): string {
  if (typeof root === 'string') return expandPath(root, vars);
  const fromEnv = process.env[root.env]?.trim();
  return fromEnv ? path.resolve(fromEnv) : expandPath(root.default, vars);
}

/** A harness mapping, resolved for one scope and one project directory. */
export interface Resolved {
  harness: Harness;
  scope: Scope;
  root: string;
  vars: Vars;
}

export function resolve(harness: Harness, scope: Scope, project: string): Resolved {
  const base: Vars = { project: path.resolve(project), home: homedir() };
  const root = resolveRoot(harness.roots[scope], base);
  return { harness, scope, root, vars: { ...base, root } };
}

/**
 * What placing files needs from a mapping: its rules and where they resolve.
 * Narrower than `Resolved`, so an hcm bundle (`../hcm/bundle.ts`) — a list of
 * copy rules with no roots and no MCP — can be placed by the same code.
 */
export type Placing = Pick<Resolved, 'scope' | 'vars'> & {
  harness: Pick<Harness, 'name' | 'files'>;
};

/** One source file, and where this harness wants it. */
export interface Placement {
  asset: AssetFile;
  file: string;
  /** The frontmatter to write, or null to copy the source byte for byte. */
  frontmatter: Record<string, unknown> | null;
}

function varsFor(resolved: Placing, asset: AssetFile): Vars {
  const dir = path.posix.dirname(asset.relativePath);
  return {
    ...resolved.vars,
    path: asset.relativePath,
    dir: dir === '.' ? '' : dir,
    name: asset.name,
    basename: asset.basename,
    ext: asset.ext,
    ...(asset.front?.description === undefined ? {} : { description: asset.front.description }),
    tools: asset.front?.tools ?? [],
    roles: asset.front?.roles ?? [],
  };
}

/**
 * Everything this harness wants copied, in rule order.
 *
 * A file matched by several rules is placed by each of them — that is how one
 * source can land in two places — but a rule that matches nothing is reported
 * by the caller, because a pattern that selects no files is nearly always a
 * typo rather than an intention.
 */
export function placementsFor(
  resolved: Placing,
  assets: AssetFile[],
  roles: Role[],
): { placements: Placement[]; empty: CopyRule[] } {
  const placements: Placement[] = [];
  const empty: CopyRule[] = [];

  for (const rule of resolved.harness.files) {
    if (rule.scope && rule.scope !== resolved.scope) continue;

    const matches = matcher(rule.from);
    let used = 0;

    for (const asset of assets) {
      if (!matches(asset.relativePath)) continue;
      // A rule may narrow to a role; a file may declare its own.
      if (rule.roles && !rule.roles.some((role) => roles.includes(role))) continue;
      if (!inRoles(asset, roles)) continue;

      used += 1;
      const vars = varsFor(resolved, asset);

      let frontmatter: Record<string, unknown> | null = null;
      if (rule.frontmatter) {
        if (!asset.front) {
          throw new BoardError(
            `${asset.relativePath} has no frontmatter, but ${resolved.harness.name} asks to rewrite it`,
            [`Drop \`frontmatter:\` from the rule matching "${rule.from.join(', ')}", or add some.`],
          );
        }
        frontmatter = {};
        for (const [key, value] of Object.entries(rule.frontmatter)) {
          // Only strings are templates; anything else is a literal the host wants.
          if (typeof value !== 'string') {
            frontmatter[key] = value;
            continue;
          }
          // A whole-value list keeps its shape, for a host that wants one.
          const list = LISTS.find((name) => value === `{${name}}`);
          if (list) {
            if (vars[list]?.length) frontmatter[key] = vars[list];
            continue;
          }
          const expanded = expand(value, vars);
          if (expanded !== '') frontmatter[key] = expanded;
        }
      }

      placements.push({ asset, file: expandPath(rule.to, vars), frontmatter });
    }

    if (!used) empty.push(rule);
  }

  return { placements, empty };
}

export function mcpFor(resolved: Resolved): { file: string | null; key: ServerKey; advice?: string } {
  const rule = resolved.harness.mcp[resolved.scope];
  if (!rule) return { file: null, key: 'mcpServers' };
  return {
    file: rule.file ? expandPath(rule.file, resolved.vars) : null,
    key: rule.key,
    advice: rule.advice,
  };
}

export function pointerFor(resolved: Resolved): string | null {
  const template = resolved.harness.pointer?.[resolved.scope];
  return template ? expandPath(template, resolved.vars) : null;
}
