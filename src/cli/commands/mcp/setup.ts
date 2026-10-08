import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { BoardError, findBoardPaths } from '../../../core/index.js';
import { noBoardFound } from '../../context.js';
import { bold, cyan, dim, green, out, yellow } from '../../ui.js';
import {
  DEFAULT_SERVER_NAME,
  buildEntry,
  defaultConfigPath,
  lpmOnPath,
  mergeEntry,
  readConfig,
  serialize,
} from './config.js';

export function run(args: string[]): number {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      file: { type: 'string' },
      output: { type: 'string', short: 'o' },
      name: { type: 'string' },
      user: { type: 'string' },
      profile: { type: 'string' },
      'read-only': { type: 'boolean' },
      'allow-remote': { type: 'boolean' },
      print: { type: 'boolean' },
      force: { type: 'boolean' },
      root: { type: 'string' },
    },
  });

  const paths = findBoardPaths(values.root);
  if (!paths) throw noBoardFound('Or pass --root <path>.');
  if (values.file && values.output) {
    throw new BoardError('Pass one of --file and --output', [
      '--file merges into an existing config; --output writes a new one.',
    ]);
  }

  const onPath = lpmOnPath();
  const name = values.name ?? DEFAULT_SERVER_NAME;
  const entry = buildEntry({
    onPath,
    root: paths.root,
    user: values.user,
    profile: values.profile,
    readOnly: values['read-only'] === true,
    allowRemote: values['allow-remote'] === true,
  });

  // Merging needs whatever is already in the target; a fresh file starts empty.
  const merging = values.file !== undefined;
  const target = merging
    ? path.resolve(values.file!)
    : path.resolve(values.output ?? defaultConfigPath(paths.root));
  const config = readConfig(merging ? target : null);
  const { data, replaced } = mergeEntry(config, name, entry, values.force === true);

  if (values.print) {
    out(serialize(data).trimEnd());
    return 0;
  }

  const existed = existsSync(target);
  if (!merging && existed && !values.force) {
    throw new BoardError(`${target} already exists`, [
      `Pass --file ${path.relative(process.cwd(), target) || target} to add to it,`,
      'or --force to replace the whole file.',
    ]);
  }

  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, serialize(data), 'utf8');

  const verb = replaced ? 'Replaced' : existed ? 'Added' : 'Wrote';
  out(`${green(verb)} ${bold(name)} in ${target}`);
  out(`  ${dim('key')}      ${config.key}`);
  out(`  ${dim('command')}  ${entry.command} ${entry.args.join(' ')}`);
  out(`  ${dim('cwd')}      ${entry.cwd}`);
  out();

  if (!onPath && entry.command === process.execPath) {
    out(yellow('  lpm is not on your PATH, so the config points at this checkout.'));
    out(dim('  Run `npm link` (or `make link`) and re-run with --force for a portable config.'));
    out();
  } else if (!onPath) {
    out(dim('  lpm is not on your PATH, so the host will start it with npx.'));
    out(dim('  `npm install -g light-plan` and re-run with --force to skip the download.'));
    out();
  }
  out(dim('Restart your agent host to pick it up.'));
  out(dim(`Check it with: ${cyan('lpm mcp --root ' + paths.root)}`));
  return 0;
}
