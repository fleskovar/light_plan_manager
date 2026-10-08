import type { SpawnSyncOptions, SpawnSyncReturns } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { BoardError } from '../../../core/index.js';
import { bold, cyan, dim, err, green, out, yellow } from '../../ui.js';
import { assetsDir } from '../agent/assets.js';
import { isNpxCache, lpmOnPath } from '../mcp/config.js';
import type { Rendered } from './bundle.js';
import { defaultBundleDir, loadBundles, renderBundles } from './bundle.js';

/**
 * `lpm hcm` hands light-plan's agents and skills to hcm
 * (harness-config-manager), so any project can install them with
 * `hcm install light-plan` and keep them current with `hcm update`.
 *
 * hcm is only ever run as a command — its registry is its own business — and
 * never from an install hook: registering changes somebody's home folder, so
 * it waits to be asked.
 */
export const help = `Register the light-plan hcm bundles, so any project can install them.

Usage
  lpm hcm init [--dir <path>] [--dev]
  lpm hcm build --dir <path>
  lpm hcm remove

Subcommands
  init     Render every bundle and register them with \`hcm registry add\`
  build    Render the bundles into a folder and register nothing — for
           publishing them as a repository or a release
  remove   Unregister the bundles (\`hcm registry remove\`)

Options
      --dir <path>   Where the bundles are written
                     (default: ${defaultBundleDir()})
      --dev          Register with \`hcm registry add --dev\`: hcm reads the
                     folder in place, so after editing assets/ in a checkout,
                     \`lpm hcm init --dev\` then \`hcm update light-plan\` lands
                     it without a version bump

The bundles are rendered from the agents and skills \`lpm agent\` installs
(assets/hcm/*.yml says which go where), at this package's version, with an
MCP entry that starts \`lpm mcp\` and a CLAUDE.md / AGENTS.md section pointing
at the skills. Run init again after upgrading light-plan, then \`hcm update\`.

Without a global install, run it from the package:
  npx light-plan hcm init                   from anywhere
  npx --no lpm hcm init                     in a project that depends on light-plan

Then, in any project
  hcm install light-plan -t claude-code
  hcm install light-plan -t copilot --flavor developer`;

const isWindows = process.platform === 'win32';

/**
 * Run hcm. On Windows npm installs it as `hcm.cmd`, which Node starts only
 * through a shell — and a shell splits at spaces, so every argument is quoted
 * and the line is handed over whole (Node deprecates an array with a shell).
 */
function hcm(args: string[], options: SpawnSyncOptions = {}): SpawnSyncReturns<string> {
  const settings = { stdio: 'inherit', encoding: 'utf8', ...options } as const;
  const result = isWindows
    ? spawnSync(['hcm', ...args.map((arg) => `"${arg}"`)].join(' '), { ...settings, shell: true })
    : spawnSync('hcm', args, settings);
  return result as SpawnSyncReturns<string>;
}

function requireHcm(): void {
  const probe = hcm(['--version'], { stdio: 'pipe' });
  if (probe.error || probe.status !== 0) {
    throw new BoardError('hcm is not installed', [
      'Install it with: npm install -g harness-config-manager',
    ]);
  }
}

function report(rendered: Rendered[]): void {
  for (const bundle of rendered) {
    out(`  ${green('+')} ${bundle.name} ${dim(`${bundle.version} · ${bundle.files} files`)}`);
    out(`    ${dim(bundle.dir)}`);
  }
}

function runBuild(dir: string | undefined): number {
  if (!dir) throw new BoardError('Pass --dir', ['`lpm hcm build` writes the bundles there.']);
  // A published bundle is installed on other machines, so it names `lpm`
  // rather than wherever this one happens to keep it.
  const rendered = renderBundles(path.resolve(dir), { onPath: true });
  out(bold('Rendered'));
  report(rendered);
  out();
  out(dim('Check them with: hcm validate <folder> && hcm refs check --path <folder>'));
  return 0;
}

function runInit(dir: string | undefined, dev: boolean): number {
  requireHcm();

  if (dev && /[\\/](node_modules|_npx)[\\/]/.test(assetsDir())) {
    err(
      `${yellow('warn')} ${assetsDir()} is an installed copy, not a working copy; ` +
        'edits to your checkout will not reach it. Run `npm link` in the checkout.',
    );
  }

  const target = path.resolve(dir ?? defaultBundleDir());
  const onPath = lpmOnPath();
  const rendered = renderBundles(target, { onPath });
  out(bold('Rendered'));
  report(rendered);
  out();

  const added = hcm(['registry', 'add', target, ...(dev ? ['--dev'] : [])]);
  if (added.error) throw new BoardError('Could not run hcm', [added.error.message]);
  if (added.status !== 0) return added.status ?? 1;

  out();
  if (dev) {
    out(`${green('Development mode')} hcm reads ${target} in place.`);
    out(dim('After editing assets/, run `lpm hcm init --dev`, then in each test project:'));
    for (const bundle of rendered) out(`  ${cyan(`hcm update ${bundle.name}`)}`);
  } else {
    out(bold('Next, in any project'));
    for (const bundle of rendered) out(`  ${cyan(`hcm install ${bundle.name} -t <harness>`)}`);
    out(dim('Projects that already have them: hcm update'));
  }
  if (!onPath && isNpxCache(assetsDir())) {
    out();
    out(dim('lpm is not on your PATH, so the MCP entry starts it with npx.'));
    out(dim('`npm install -g light-plan`, then `lpm hcm init` again, to skip the download.'));
  }
  return 0;
}

function runRemove(): number {
  requireHcm();
  const names = loadBundles().map((bundle) => bundle.name);
  const removed = hcm(['registry', 'remove', ...names]);
  if (removed.error) throw new BoardError('Could not run hcm', [removed.error.message]);
  return removed.status ?? 1;
}

export function run(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      dir: { type: 'string' },
      dev: { type: 'boolean' },
    },
  });
  const [sub, ...extra] = positionals;
  if (extra.length) throw new BoardError(`Unexpected argument "${extra[0]}"`);

  switch (sub) {
    case 'init':
      return runInit(values.dir, values.dev === true);
    case 'build':
      return runBuild(values.dir);
    case 'remove':
    case 'rm':
      return runRemove();
    default:
      throw new BoardError(sub ? `Unknown subcommand "${sub}"` : 'Name a subcommand', [
        'Expected one of: init, build, remove.',
        'Run `lpm hcm --help` for usage.',
      ]);
  }
}
