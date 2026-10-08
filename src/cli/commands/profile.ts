import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { BoardPaths, LoadedBoard } from '../../core/index.js';
import {
  BoardError,
  PROFILE_ENV_VAR,
  USER_ENV_VAR,
  clearProfileFile,
  currentProfile,
  currentUser,
  describeScope,
  displayPath,
  profileTemplate,
  resolveProfilePath,
  resolveScope,
  scopedIssues,
  setProfileFile,
} from '../../core/index.js';
import { requireBoard } from '../context.js';
import { bold, cyan, dim, green, out, plural, yellow } from '../ui.js';

export const help = `Use a profile: the file that says who you are and which part of the board is yours.

Usage
  lpm profile                     Show the profile in force, resolved
  lpm profile <file>              Use this file from now on
  lpm profile --file <file>       Same, spelled out
  lpm profile --init <file>       Write a starter profile there, and use it

Options
      --file <path>   The profile to use
      --init <path>   Create a profile file, then use it
      --user <ref>    Whose id or name to put in a new profile (with --init)
      --clear         Stop using a profile
      --force         Overwrite an existing file (with --init)

A profile is YAML, lives outside the board, and is handed to one developer:

  user: RS-1
  scope:
    under:   [LP-2]         # only work at or below these documents
    exclude: [LP-9]         # never these, nor anything below them
    types:   [story, bug]   # only these issue types
    periods: [TL-2]         # only work scheduled here, or in a child period

Scope decides what the board *offers* you — \`lpm task next\`, and the listing
and recommendation tools an agent uses. It never hides a document you ask for
by id, and it never hides work you have already started. It is routing, not
access control.

Only the path is remembered, in .lpm/local.json, which is git-ignored. Set
${PROFILE_ENV_VAR} to point at a different one for one shell.

Full reference: docs/profiles.md

Examples
  lpm profile --init ~/.lpm/alice.yml --user "Alice Smith"
  lpm profile ./profiles/alice.yml
  lpm profile --clear`;

interface Values {
  file?: string;
  init?: string;
  user?: string;
  clear?: boolean;
  force?: boolean;
}

/**
 * Write a starter profile, refusing to clobber one somebody is using. Returns
 * the path *as it was typed*, so `--init ./profiles/alice.yml` records the same
 * relative path `lpm profile ./profiles/alice.yml` would — one that survives
 * the checkout moving.
 */
function runInit(paths: BoardPaths, target: string, values: Values): string {
  const file = resolveProfilePath(paths, target);
  if (existsSync(file) && !values.force) {
    throw new BoardError(`${file} already exists`, ['Pass --force to replace it.']);
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, profileTemplate(values.user), 'utf8');
  out(`${green('Wrote')} ${file}`);
  return target;
}

export function run(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      file: { type: 'string' },
      init: { type: 'string' },
      user: { type: 'string' },
      clear: { type: 'boolean' },
      force: { type: 'boolean' },
    },
  }) as { values: Values; positionals: string[] };

  const board = requireBoard();

  if (values.clear) {
    clearProfileFile(board);
    out(`${green('Cleared')} no profile in use${dim(` (${displayPath(board.paths, board.paths.localPath)})`)}`);
    return 0;
  }

  // `--init` writes the file; everything after it is the same as being handed one.
  const wanted = values.init
    ? runInit(board.paths, values.init, values)
    : (values.file ?? positionals[0]);

  if (wanted) {
    const setting = setProfileFile(board, wanted);
    out(`${green('Using')} ${bold(setting.file)}`);
    out(`  ${dim(displayPath(board.paths, board.paths.localPath))}`);
    out();
    return report(board, 'Next:');
  }

  return report(board, null);
}

/** Print the profile in force and what it means on this board. */
function report(board: LoadedBoard, footer: string | null): number {
  const current = currentProfile(board.paths);
  if (!current) {
    out(dim('No profile in use.'));
    out();
    out(`${dim('Point at one with')} ${cyan('lpm profile <file>')}`);
    out(`${dim('or write one with')}  ${cyan('lpm profile --init <file>')}`);
    return 0;
  }

  out(`${bold('Profile')}  ${current.file}`);
  out(`  ${dim(current.source === 'env' ? `from ${PROFILE_ENV_VAR}` : displayPath(board.paths, board.paths.localPath))}`);

  if (!current.profile) {
    out();
    out(`${yellow('warn')} it does not load, so the whole board is in scope`);
    for (const message of current.errors) out(`       ${message}`);
    return 1;
  }

  // A profile's `user:` beats `lpm me`, so the only thing that can be talking
  // instead is the environment.
  const overridden = Boolean(current.profile.user) && currentUser(board)?.source === 'env';
  const claimed = current.profile.user
    ? `${current.profile.user}${overridden ? dim(` (overridden by ${USER_ENV_VAR})`) : ''}`
    : dim('not set');
  out(`  user     ${claimed}`);

  const scope = resolveScope(board, current.profile.scope);
  out(`  scope    ${scope.active ? describeScope(scope) : dim('the whole board')}`);
  out(`  offers   ${plural(scopedIssues(board, scope).length, 'issue')} of ${board.issues.length}`);

  if (scope.unknown.length) {
    out();
    out(`${yellow('warn')} this board has nothing named ${scope.unknown.join(', ')}`);
    out(dim('       those entries filter nothing; a stale `under` offers no work at all'));
  }

  if (footer) {
    out();
    out(dim(footer));
    out(`  ${cyan('lpm task next')}`);
  }
  return 0;
}
