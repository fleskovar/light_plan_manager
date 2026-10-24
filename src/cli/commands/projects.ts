import path from 'node:path';
import { parseArgs } from 'node:util';
import type { ProjectEntry } from '../../core/index.js';
import {
  BoardError,
  PROJECT_INDEX_ENV,
  forgetProject,
  listProjects,
  projectIndexPath,
  pruneProjects,
} from '../../core/index.js';
import { dim, green, out, pad, red, yellow } from '../ui.js';

/**
 * The project index: every project that an `lpm` command worked on, joined
 * with the boards of the central store. A thin printer over
 * `operations/project-index.ts`.
 */

export const help = `List every project that lpm worked on, on this computer.

Usage
  lpm projects [--json]        List the projects, local and central
  lpm projects forget <path>   Remove one project folder from the list
  lpm projects prune           Remove each project whose board is gone

Each lpm command that finds a board records its project in projects.json in the
user folder (~/.light-plan, or the folder that LPM_HOME names): the project
folder, the board folder and the time. lpm init, lpm git join and lpm store
move record the new board folder. The list also holds every board in the
central store, even one that no command used yet.

Each project has a state:
  ok               The board is where the list says.
  project missing  A central board whose project folder is gone, or points at
                   another board.
  missing          No board at the recorded place. prune removes these.

${PROJECT_INDEX_ENV}=off stops the recording, for example in CI. forget and prune
change only the list: no board and no project folder is deleted.

The web app shows the same list: File > All projects.

Examples
  lpm projects
  lpm projects --json
  lpm projects forget ../old-shop
  lpm projects prune`;

function stateText(entry: ProjectEntry): string {
  if (entry.state === 'ok') return '';
  return entry.state === 'missing' ? red(entry.state) : yellow(entry.state);
}

function list(args: string[]): number {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean' } }, allowPositionals: false });
  const entries = listProjects();
  if (values.json) {
    out(JSON.stringify(entries, null, 2));
    return 0;
  }
  if (!entries.length) {
    out(dim('No projects yet. Each lpm command in a project records it here.'));
    return 0;
  }
  const nameWidth = Math.max(...entries.map((entry) => entry.name.length)) + 2;
  const prefixWidth = Math.max(...entries.map((entry) => (entry.keyPrefix ?? '?').length)) + 2;
  for (const entry of entries) {
    const used = entry.lastUsed ? entry.lastUsed.slice(0, 10) : 'never';
    const folder = entry.root ?? entry.lpmDir;
    const state = stateText(entry);
    out(
      `${pad(entry.name, nameWidth)}${pad(entry.store, 9)}${pad(entry.keyPrefix ?? '?', prefixWidth)}${pad(used, 12)}${folder}${state ? `  ${state}` : ''}`,
    );
  }
  out(dim(`in ${projectIndexPath()}`));
  return 0;
}

function forget(args: string[]): number {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const target = positionals[0];
  if (!target) throw new BoardError('Missing path', ['Usage: lpm projects forget <path>']);
  const root = path.resolve(target);
  if (!forgetProject(root)) {
    throw new BoardError(`${root} is not in the project list`, ['`lpm projects` lists the recorded folders.']);
  }
  out(`${green('Forgot')} ${root}`);
  return 0;
}

function prune(): number {
  const removed = pruneProjects();
  if (!removed.length) {
    out(dim('Every project in the list has a board.'));
    return 0;
  }
  for (const root of removed) out(`${green('Removed')} ${root}`);
  return 0;
}

export function run(args: string[]): number {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined || subcommand.startsWith('-')) return list(args);
  if (subcommand === 'forget') return forget(rest);
  if (subcommand === 'prune') return prune();
  throw new BoardError(`Unknown subcommand "${subcommand}"`, ['Use `lpm projects`, `lpm projects forget <path>` or `lpm projects prune`.']);
}
