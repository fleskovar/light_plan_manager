import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  BOARD_ENV_VAR,
  BUILTIN_TEMPLATES,
  PROJECT_BOARD_BRANCH,
  expandHome,
  initBoard,
  loadConfig,
  projectRepository,
} from '../../core/index.js';
import { bold, cyan, dim, out, pad, yellow } from '../ui.js';
import { warnAboutTemplates } from './instructions.js';

export const help = `Create a light-plan board in the current (or given) folder.

Usage
  lpm init [dir] [options]

Options
  -t, --template <name|path>  ${BUILTIN_TEMPLATES.join(' | ')} or a path to your own
                              config YAML  (default: scrum)
      --prefix <PREFIX>       Issue id prefix, e.g. LP  (default: from the folder name)
      --no-git                Skip making .lpm its own git repo

By default .lpm becomes an independent git repository and is added to the
surrounding repo's .gitignore, so the board has its own history and remote.

${BOARD_ENV_VAR} is ignored here: init always creates the board in this folder.`;

/** Is a board being created that every other command will then look past? */
function shadowedBy(lpmDir: string, root: string): string | null {
  const ref = process.env[BOARD_ENV_VAR]?.trim();
  if (!ref) return null;
  const target = path.resolve(expandHome(ref));
  return target === lpmDir || target === root ? null : ref;
}

export function run(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      template: { type: 'string', short: 't' },
      prefix: { type: 'string' },
      'no-git': { type: 'boolean' },
    },
  });

  const result = initBoard({
    root: positionals[0] ?? process.cwd(),
    template: values.template,
    prefix: values.prefix,
    git: !values['no-git'],
  });

  const rootType = loadConfig(result.paths).config?.hierarchy[0]?.[0] ?? 'task';

  out(`${bold('Initialized board')} in ${result.paths.lpmDir}`);
  out();
  out(`  ${pad('template', 11)}${result.template}`);
  out(`  ${pad('prefix', 11)}${result.prefix}`);
  if (result.gitInitialized) out(`  ${pad('git', 11)}.lpm is now its own git repository`);
  if (result.gitignoreUpdated) out(`  ${pad('gitignore', 11)}added .lpm/ to the surrounding repo`);
  if (result.contextTemplates.length) {
    out(`  ${pad('briefs', 11)}${result.contextTemplates.length} context templates in .lpm/templates/context`);
  }
  if (result.contextTemplates.length) {
    out();
    warnAboutTemplates();
  }

  const shadow = shadowedBy(result.paths.lpmDir, result.paths.root);
  if (shadow) {
    out();
    out(`${yellow('note')} ${BOARD_ENV_VAR} points at ${shadow}`);
    out(dim('       Other commands will use that board. Unset it to work on this one.'));
  }
  out();
  out(dim('Next:'));
  out(`  ${cyan(`lpm new ${rootType} -t "My first issue"`)}`);
  // The second thing most people want is the board in the tracker their team
  // already uses, and `lpm remote add` is not a name anyone guesses.
  out(
    dim(
      `  lpm remote add <name> --provider github|jira|linear   # mirror this board onto a tracker`,
    ),
  );
  // Or the board shared through git — and when the project already pushes its
  // code somewhere, that is one command with no URL to find.
  const project = projectRepository(result.paths);
  out(
    dim(
      project
        ? `  lpm git setup      # or share it on ${project.url}, on its own branch ${PROJECT_BOARD_BRANCH}`
        : '  lpm git setup --url <url>   # or share it through a git repository',
    ),
  );
  return 0;
}
