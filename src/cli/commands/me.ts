import { parseArgs } from 'node:util';
import {
  USER_ENV_VAR,
  clearCurrentUser,
  currentScope,
  currentTasks,
  currentUser,
  describeScope,
  displayPath,
  genericResources,
  namedResources,
  setCurrentUser,
} from '../../core/index.js';
import { requireBoard } from '../context.js';
import { bold, cyan, dim, green, out, pad, yellow } from '../ui.js';

export const help = `Say who is using this checkout, so \`lpm task\` knows whose work to show.

Usage
  lpm me [<id or name>]
  lpm whoami

Options
      --clear     Forget the current user

With no argument the current user is printed. The setting lives in
.lpm/local.json, which is git-ignored: who is at this machine is not a
property of the board. Set ${USER_ENV_VAR} to override it for one command.

If you use a profile (\`lpm profile\`) and it names a user, that wins over what
is stored here — most specific first: ${USER_ENV_VAR}, then the profile, then this.

Examples
  lpm me RS-2
  lpm me "Alice Smith"
  lpm me --clear`;

export function run(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { clear: { type: 'boolean' } },
  });

  const board = requireBoard();

  if (values.clear) {
    clearCurrentUser(board);
    out(`${green('Cleared')} no current user${dim(` (${displayPath(board.paths, board.paths.localPath)})`)}`);
    return 0;
  }

  const wanted = positionals[0];
  if (wanted) {
    const resource = setCurrentUser(board, wanted);
    out(`${green('You are')} ${bold(resource.id)}  ${resource.title}`);
    if (resource.covers.length) out(`  ${dim(`covering ${resource.covers.join(', ')}`)}`);
    out(`  ${dim(displayPath(board.paths, board.paths.localPath))}`);
    out();
    out(dim('Next:'));
    out(`  ${cyan('lpm task next')}`);
    return 0;
  }

  const user = currentUser(board);
  if (!user) {
    out(dim('No current user set.'));
    const people = namedResources(board);
    if (people.length) {
      out();
      out(bold('Roster'));
      for (const person of people) out(`  ${pad(person.id, 8)}${person.title}`);
      const pools = genericResources(board);
      for (const pool of pools) out(`  ${pad(pool.id, 8)}${pool.title} ${dim('(pool)')}`);
    }
    out();
    out(`${dim('Set one with')} ${cyan('lpm me <id or name>')}`);
    return 0;
  }

  if (!user.resource) {
    out(`${yellow('warn')} current user "${user.ref}" is not in the roster`);
    out(`${dim('Set one with')} ${cyan('lpm me <id or name>')}`);
    return 1;
  }

  const wip = currentTasks(board, user.resource.id);
  out(`${bold(user.resource.id)}  ${user.resource.title}  ${dim(`${user.resource.capacity} FTE`)}`);
  if (user.resource.covers.length) out(`  covers    ${user.resource.covers.join(', ')}`);
  out(`  in flight ${wip.length ? wip.map((issue) => issue.id).join(', ') : dim('nothing')}`);
  if (user.source === 'env') out(`  ${dim(`from ${USER_ENV_VAR}`)}`);
  if (user.source === 'profile') {
    const scope = currentScope(board);
    out(`  ${dim(`from your profile · ${describeScope(scope)}`)}`);
    out(`  ${dim('see')} ${cyan('lpm profile')}`);
  }
  return 0;
}
