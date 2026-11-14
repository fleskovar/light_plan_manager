import { parseArgs } from 'node:util';
import { BoardError } from '../../core/index.js';
import { upgradeLightPlan, type UpgradeOutcome } from '../self-upgrade.js';
import { bold, cyan, dim, green, out, red, yellow } from '../ui.js';

/**
 * Upgrading light-plan itself. A thin printer over `upgradeLightPlan` in
 * `cli/self-upgrade.ts`, which runs npm.
 */

export const help = `Upgrade light-plan to the latest version on the npm registry.

Usage
  lpm upgrade              Install the latest version, when it is newer
  lpm upgrade --check      Compare the installed version with the latest version, and install nothing

Options
      --check    Report the two versions and the npm command, and run no install

\`lpm upgrade\` asks npm for the version that the tag \`latest\` names. When that
version is newer than the installed version, the command runs npm:

  light-plan is installed               The command that \`lpm upgrade\` runs
  globally (npm install -g light-plan)  npm install -g light-plan@<latest>
  in a project (npm install light-plan) npm install light-plan@<latest>, in the project
  from a clone, or with npm link        none. Pull the clone and build it.
  through npx, or with pnpm or yarn     none. The command prints what to run.

A project install also writes the new version into the \`dependencies\` of the
project's package.json.

The command exits with the status 1 when npm fails, when npm cannot reach the
registry, and when npm does not manage the install.

Examples
  lpm upgrade
  lpm upgrade --check`;

/** Say what the upgrade did. Returns the exit code that the outcome asks for. */
function report(outcome: UpgradeOutcome): number {
  switch (outcome.kind) {
    case 'current':
      out(`${green('Up to date')}  light-plan ${bold(outcome.installed)} is the latest version`);
      return 0;
    case 'ahead':
      out(`${green('Up to date')}  light-plan ${bold(outcome.installed)} is newer than the latest version ${outcome.latest}`);
      return 0;
    case 'available':
      out(`${yellow('Available')}  light-plan ${bold(outcome.latest)} (installed: ${outcome.installed})`);
      out(`${dim('  install it with:')} ${cyan('lpm upgrade')} ${dim('or')} ${cyan(outcome.command)}`);
      return 0;
    case 'upgraded':
      out(`${green('Upgraded')}  light-plan ${outcome.from} → ${bold(outcome.to)}`);
      out(dim('  restart a running `lpm ui` or `lpm mcp` to use the new version'));
      return 0;
    case 'failed':
      out(`${red('npm could not upgrade')} light-plan ${outcome.installed} to ${outcome.latest}`);
      out(`${dim('  run the command yourself to see why:')} ${cyan(outcome.command)}`);
      return 1;
    case 'unreachable':
      out(`${red('npm did not return the latest version')} of light-plan (installed: ${outcome.installed})`);
      out(dim('  check the network connection, and that `npm view light-plan version` works'));
      return 1;
    case 'unmanaged': {
      const latest = outcome.latest ? `, latest: ${outcome.latest}` : '';
      out(`${yellow('Not upgraded')}  light-plan (installed: ${bold(outcome.installed)}${latest})`);
      out(dim(`  light-plan runs from ${outcome.folder}`));
      if (outcome.install === 'checkout') {
        out(dim('  this folder is a clone or an `npm link`, and npm does not manage it'));
        out(`${dim('  update the clone with:')} ${cyan(outcome.command)}`);
        out(`${dim('  or replace it with the published package:')} ${cyan('npm install -g light-plan@latest')}`);
      } else {
        out(dim('  this folder is an npx cache, or pnpm or yarn manages it, and npm cannot upgrade it'));
        out(`${dim('  use:')} ${cyan(outcome.command)}`);
      }
      return 1;
    }
  }
}

export function run(args: string[]): number {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { check: { type: 'boolean' } },
  });
  if (positionals.length) {
    throw new BoardError('lpm upgrade takes no arguments', ['lpm upgrade  or  lpm upgrade --check']);
  }
  const check = values.check === true;
  out(dim(check ? 'Asking npm for the latest version of light-plan' : 'Upgrading light-plan with npm'));
  return report(upgradeLightPlan({ check }));
}
