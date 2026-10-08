import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { ServerEntry, ServerKey } from '../mcp/config.js';
import { mergeEntry, readConfig, serialize } from '../mcp/config.js';
import type { AssetFile } from './assets.js';
import type { Placement } from './mapping.js';

/**
 * Writing the assets into somebody else's project.
 *
 * Nothing here knows a harness's name: it is handed a `Placement` — a path and
 * a frontmatter object, both already resolved from a mapping — and writes it.
 * If this file ever needs a `switch` on the target, the mapping schema is the
 * thing to extend instead.
 *
 * The rule it exists to keep: **an install never destroys work that was already
 * there.** A directory that exists is added to, a JSON config is merged into
 * with its other keys untouched, and a markdown file the harness owns gets a
 * delimited block appended — replaced in place on the next run, so
 * re-installing is idempotent rather than cumulative. Only a file we wrote
 * before is overwritten, and only with `--force`.
 */

/** What one install did, so the command can report it and `--dry-run` can print it. */
export type Outcome = 'created' | 'updated' | 'skipped' | 'unchanged';

export interface Action {
  file: string;
  outcome: Outcome;
  /** Why it was skipped, when it was. */
  reason?: string;
}

export interface InstallOptions {
  force: boolean;
  dryRun: boolean;
}

const BEGIN = '<!-- lpm:begin -->';
const END = '<!-- lpm:end -->';

/**
 * Buffers throughout, so a rule may copy anything — a PNG, a zip, a shell
 * script with CRLF that must survive intact. Comparing bytes is also what makes
 * "unchanged" mean unchanged rather than "same after some normalisation".
 */
function write(file: string, contents: Buffer, options: InstallOptions): Action {
  const existed = existsSync(file);
  if (existed) {
    if (readFileSync(file).equals(contents)) return { file, outcome: 'unchanged' };
    if (!options.force) {
      return { file, outcome: 'skipped', reason: 'already exists; pass --force to replace it' };
    }
  }
  if (!options.dryRun) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  return { file, outcome: existed ? 'updated' : 'created' };
}

function document(front: Record<string, unknown>, body: string): string {
  const yaml = YAML.stringify(front, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n${body}`;
}

/**
 * One file, where its harness mapping put it: markdown with the frontmatter the
 * host wants, or the source copied byte for byte when the rule asked for no
 * frontmatter.
 */
export function installFile(placement: Placement, options: InstallOptions): Action {
  const contents =
    placement.frontmatter === null
      ? readFileSync(placement.asset.file)
      : Buffer.from(document(placement.frontmatter, placement.asset.front?.body ?? ''), 'utf8');
  return write(placement.file, contents, options);
}

/**
 * Merge the MCP server entry into whatever config the harness already has.
 * `readConfig` follows the key the file is already using; `preferred` only
 * decides what a *new* file gets, which is where the harnesses disagree.
 *
 * Returns null when the mapping names no file — the command prints that
 * harness's `advice` instead of guessing at somebody's config format.
 */
export function installMcp(
  file: string | null,
  name: string,
  entry: ServerEntry,
  preferred: ServerKey,
  options: InstallOptions,
): Action | null {
  if (!file) return null;
  const existed = existsSync(file);
  const config = readConfig(existed ? file : null, preferred);
  const existing = config.servers[name];

  if (existing && !options.force) {
    if (JSON.stringify(existing) === JSON.stringify(entry)) {
      return { file, outcome: 'unchanged' };
    }
    return {
      file,
      outcome: 'skipped',
      reason: `"${name}" is already configured; pass --force to replace it`,
    };
  }

  const { data } = mergeEntry(config, name, entry, true);
  const contents = serialize(data);
  if (existed && readFileSync(file, 'utf8') === contents) {
    return { file, outcome: 'unchanged' };
  }
  if (!options.dryRun) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents, 'utf8');
  }
  return { file, outcome: existed ? 'updated' : 'created' };
}

/**
 * Append a delimited block to a file the harness already owns — Copilot's
 * `copilot-instructions.md` is somebody's document, and the one thing we may
 * not do is rewrite it. A block that is already there is replaced where it
 * stands, so running this twice leaves one block, not two.
 */
export function installPointer(file: string, block: string, options: InstallOptions): Action {
  const marked = `${BEGIN}\n${block.trim()}\n${END}\n`;

  if (!existsSync(file)) {
    return write(file, Buffer.from(marked, 'utf8'), { ...options, force: true });
  }

  const current = readFileSync(file, 'utf8');
  const start = current.indexOf(BEGIN);
  const end = current.indexOf(END);

  let next: string;
  if (start !== -1 && end > start) {
    next = current.slice(0, start) + marked.trimEnd() + current.slice(end + END.length);
  } else {
    const separator = current.endsWith('\n') ? '\n' : '\n\n';
    next = `${current}${separator}${marked}`;
  }

  if (next === current) return { file, outcome: 'unchanged' };
  if (!options.dryRun) writeFileSync(file, next, 'utf8');
  return { file, outcome: 'updated' };
}

/**
 * The pointer block's text: short, and about this board rather than about us.
 *
 * Grouped by the directory each file came from, so it describes whatever the
 * tree happens to hold rather than a fixed idea of "agents and skills".
 */
export function pointerBlock(assets: AssetFile[]): string {
  const lines = [
    '## Planning with light-plan',
    '',
    'This project tracks work on a **light-plan** board — a `.lpm/` folder of markdown,',
    'driven by the `lpm` CLI and the `light-plan` MCP server. Before changing anything on',
    'the board, read what was installed alongside this file:',
  ];

  const described = assets.filter((asset) => asset.front?.description);
  const kinds = [...new Set(described.map((asset) => asset.kind))].sort();
  const first = (text: string): string => text.split('.')[0] ?? text;

  for (const kind of kinds) {
    lines.push('', `${kind.charAt(0).toUpperCase()}${kind.slice(1)}:`, '');
    for (const asset of described.filter((entry) => entry.kind === kind)) {
      lines.push(`- \`${asset.name}\` — ${first(asset.front!.description!)}.`);
    }
  }

  lines.push(
    '',
    'Never hand-edit files under `.lpm/`: use the tools, which validate the hierarchy,',
    'allocate ids and keep dependency links consistent. Run `lpm check` before committing.',
  );
  return lines.join('\n');
}
