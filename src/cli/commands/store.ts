import path from 'node:path';
import { parseArgs } from 'node:util';
import type { BoardPaths, BoardStore } from '../../core/index.js';
import {
  BoardError,
  centralBoardsDir,
  centralStorePath,
  findBoardPaths,
  isCentralBoard,
  listCentralBoards,
  recordProjectQuietly,
  relocateBoard,
} from '../../core/index.js';
import { noBoardFound } from '../context.js';
import { bold, cyan, dim, green, out, pad, red, yellow } from '../ui.js';

/**
 * Where a board keeps its documents: in its project (`<project>/.lpm`), or in
 * the central store (`<central_store>/.lpm_central/<name>`). A thin printer
 * over `relocateBoard`.
 */

export const help = `Show where the board is stored, and move it between the project and the central store.

Usage
  lpm store                        Say where the board of this folder is
  lpm store move --to central      Move the board to the central store
  lpm store move --to local        Move the board back into this project, in .lpm
  lpm store list [--json]          List the boards in the central store, from any folder

\`lpm store list\` prints one line for each board in <central_store>/.lpm_central:
the folder name, the key prefix and the project folder. "project missing" means
that the project folder is gone, or that its pointer names another board.

A local board keeps its documents in <project>/.lpm. A central board keeps them
in <central_store>/.lpm_central/<name>, and <project>/.lpm/config.yml holds
only the key \`store\`, whose value is the path of that folder. The key
\`central_store\` in settings.json of the user folder names the central store:
\`lpm config set central_store <dir>\` writes it.

\`lpm store move\` keeps every document, the git history, local.json and the
remote credentials. It copies the board first, compares the copy, and then
switches. A move that fails leaves the board where it was. Stop a running
\`lpm ui\` or \`lpm mcp\` on the board before the move, and start it again after.

\`lpm move\` is a different command: it changes the status, parent, period or
assignee of an issue.

Examples
  lpm store
  lpm store move --to central
  lpm store move --to local
  lpm store list`;

function boardHere(): BoardPaths {
  const paths = findBoardPaths();
  if (!paths) throw noBoardFound();
  return paths;
}

function show(): number {
  const paths = boardHere();
  if (isCentralBoard(paths)) {
    out(`${pad('central', 9)}${paths.lpmDir}`);
    out(`${pad('project', 9)}${paths.root}`);
    out(dim(`Move it into the project with ${cyan('lpm store move --to local')}.`));
  } else {
    out(`${pad('local', 9)}${paths.lpmDir}`);
    out(
      dim(
        centralStorePath() === null
          ? 'No central store is set. `lpm config set central_store <dir>` names one.'
          : `Move it to the central store with ${cyan('lpm store move --to central')}.`,
      ),
    );
  }
  return 0;
}

function parseTarget(value: string | undefined): BoardStore {
  if (value === 'central' || value === 'local') return value;
  throw new BoardError(value === undefined ? 'Missing --to' : `Unknown target "${value}"`, [
    'Use `lpm store move --to central` or `lpm store move --to local`.',
  ]);
}

function move(args: string[]): number {
  const { values } = parseArgs({ args, options: { to: { type: 'string' } }, allowPositionals: false });
  const to = parseTarget(values.to);
  const result = relocateBoard(boardHere(), to);
  recordProjectQuietly(result.paths);
  const where = to === 'central' ? 'the central store' : 'the project';
  out(`${green('Moved')} the board to ${where}: ${bold(result.paths.lpmDir)}`);
  if (to === 'central') out(dim(`  ${path.join(result.paths.root, '.lpm', 'config.yml')} now points at it`));
  for (const warning of result.warnings) out(`${yellow('warning')} ${warning}`);
  return 0;
}

function list(args: string[]): number {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean' } }, allowPositionals: false });
  const entries = listCentralBoards();
  if (values.json) {
    out(JSON.stringify(entries, null, 2));
    return 0;
  }
  const store = centralStorePath();
  if (store === null) {
    out(dim('No central store is set. `lpm config set central_store <dir>` names one.'));
    return 0;
  }
  if (!entries.length) {
    out(dim(`No boards in ${centralBoardsDir()}. Create one with ${cyan('lpm init --central')}.`));
    return 0;
  }
  const nameWidth = Math.max(...entries.map((entry) => entry.name.length)) + 2;
  const prefixWidth = Math.max(...entries.map((entry) => (entry.keyPrefix ?? '?').length)) + 2;
  for (const entry of entries) {
    const project = entry.projectPath ?? dim('(no project.json)');
    const state = entry.error
      ? red(`config does not parse: ${entry.error}`)
      : entry.pointerOk
        ? ''
        : yellow('project missing');
    out(`${pad(entry.name, nameWidth)}${pad(entry.keyPrefix ?? '?', prefixWidth)}${project}${state ? `  ${state}` : ''}`);
  }
  out(dim(`in ${centralBoardsDir()}`));
  return 0;
}

export function run(args: string[]): number {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined) return show();
  if (subcommand === 'move') return move(rest);
  if (subcommand === 'list') return list(rest);
  throw new BoardError(`Unknown subcommand "${subcommand}"`, ['Use `lpm store`, `lpm store list` or `lpm store move --to central|local`.']);
}
