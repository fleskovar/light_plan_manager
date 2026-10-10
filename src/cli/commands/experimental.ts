import { parseArgs } from 'node:util';
import { BoardError, experimentalOf, setExperimental } from '../../core/index.js';
import { requireBoard } from '../context.js';
import {
  experimentalDependencies,
  installMissingDependencies,
  type InstallOutcome,
} from '../experimental-deps.js';
import { bold, cyan, dim, green, out, pad, red, yellow } from '../ui.js';

/**
 * Turning the experimental features on and off. A thin printer over two
 * things: `setExperimental`, which writes the key in `.lpm/config.yml`, and
 * `installMissingDependencies`, which installs the packages that the features
 * load.
 */

export const help = `Turn the experimental features on or off, and install the packages they need.

Usage
  lpm experimental                 Say whether the features are on, and which packages are installed
  lpm experimental on              Turn the features on and install the missing packages
  lpm experimental off             Turn the features off

Options
      --no-install    With \`on\`: write the key and do not install any package

\`lpm experimental on\` writes the key \`experimental\` with the value \`true\` into
.lpm/config.yml. \`lpm experimental off\` removes the key. When the key is absent,
the features are off. The key is part of the board config, so the team shares
it, and a board shared through git commits and pushes the change.

While the key holds \`true\`, \`lpm ui\` shows the tracker remotes (Jira, GitHub,
Linear) without the flag --experimental. Restart a running \`lpm ui\` after a
change. The commands \`lpm remote\` and \`lpm queue agent\` do not read the key.

The experimental features load packages that light-plan does not install:
jira.js for the Jira provider, and the pi coding agent for \`lpm queue agent\`.
\`lpm experimental on\` installs each one that is missing, with npm, beside
light-plan: globally for a global install, in the project for a project
install. Each run checks again, so a teammate who pulls a board that already
holds the key runs \`lpm experimental on\` to get the packages. \`lpm experimental
off\` uninstalls nothing.

The packages need Node 22 or newer. \`lpm queue agent\` needs Node 22.19.

Examples
  lpm experimental
  lpm experimental on
  lpm experimental on --no-install
  lpm experimental off`;

function describe(on: boolean): string {
  return on
    ? `${bold('on')}  ${dim('lpm ui shows the tracker remotes')}`
    : `${bold('off')}  ${dim('lpm ui shows git sync only')}`;
}

/** One line for each experimental package: its name, its range and whether Node finds it. */
function printDependencies(): void {
  const dependencies = experimentalDependencies();
  if (!dependencies.length) return;
  const width = Math.max(...dependencies.map((dependency) => dependency.name.length + dependency.range.length + 1));
  out(dim('  packages'));
  for (const dependency of dependencies) {
    const state = dependency.installed ? green('installed') : yellow('missing');
    out(`    ${pad(`${dependency.name} ${dependency.range}`, width + 2)}${state}`);
  }
}

/** Say what the install did. Returns the exit code that the outcome asks for. */
function reportInstall(outcome: InstallOutcome): number {
  switch (outcome.kind) {
    case 'present':
      out(dim('  every experimental package is installed'));
      return 0;
    case 'installed':
      out(`${green('  installed')} ${outcome.packages.join(', ')}`);
      return 0;
    case 'skipped':
      out(`${yellow('  not installed')} ${outcome.packages.join(', ')}`);
      out(dim(`  ${outcome.reason}`));
      out(`${dim('  install them with:')} ${cyan(outcome.command)}`);
      return 0;
    case 'failed':
      out(`${red('  npm could not install')} ${outcome.packages.join(', ')}`);
      out(`${dim('  run the command yourself to see why:')} ${cyan(outcome.command)}`);
      out(dim('  the key in .lpm/config.yml is written, so only the packages are missing'));
      return 1;
  }
}

export function run(args: string[]): number {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { 'no-install': { type: 'boolean' } },
  });
  const [wanted, ...rest] = positionals;
  if (rest.length || (wanted !== undefined && wanted !== 'on' && wanted !== 'off')) {
    throw new BoardError('Say on or off', ['lpm experimental on  or  lpm experimental off']);
  }

  const board = requireBoard();
  if (wanted === undefined) {
    const on = experimentalOf(board.config);
    out(`Experimental  ${describe(on)}`);
    printDependencies();
    out(`${dim(on ? '  turn the features off with' : '  turn the features on with')} ${cyan(on ? 'lpm experimental off' : 'lpm experimental on')}`);
    return 0;
  }

  const result = setExperimental(board.paths, wanted === 'on');
  out(`${result.changed ? green('Experimental') : dim('Already')}  ${describe(result.experimental)}`);
  if (result.changed) {
    out(
      dim(
        result.experimental
          ? '  wrote the key `experimental` with the value `true` to .lpm/config.yml'
          : '  removed the key `experimental` from .lpm/config.yml',
      ),
    );
  }
  if (!result.experimental) {
    if (result.changed) out(dim('  no package was uninstalled; restart a running `lpm ui`'));
    return 0;
  }

  // Checked on every `on`, not only on the first: a teammate who pulled a board
  // that already holds the key has the key and not the packages.
  let status = 0;
  if (values['no-install']) {
    printDependencies();
    out(dim('  --no-install: no package was installed'));
  } else {
    const missing = experimentalDependencies().filter((dependency) => !dependency.installed);
    if (missing.length) {
      out(dim(`  installing ${missing.map((dependency) => dependency.name).join(', ')} with npm`));
    }
    status = reportInstall(installMissingDependencies());
  }
  if (result.changed) out(dim('  restart a running `lpm ui` to see the tracker remotes'));
  return status;
}
