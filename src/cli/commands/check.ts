import { parseArgs } from 'node:util';
import type { Problem } from '../../core/index.js';
import { applyFixes, checkBoard, loadBoard } from '../../core/index.js';
import { checkRemoteConfiguration, fixOrphanedLinks } from '../../remote/index.js';
import { requireBoard } from '../context.js';
import { bold, cyan, dim, green, out, plural, red, yellow } from '../ui.js';

export const help = `Validate the board against its config.

Usage
  lpm check [options]

Options
      --fix       Repair everything that can be repaired automatically:
                  fill in missing id / type / title / status / created / author,
                  add declared attributes, rename folders to match, resync the
                  id counter, prune links to documents that no longer exist
      --strict    Exit non-zero on warnings too

Without --fix nothing is written. Exits 1 when errors remain.`;

/** Group by file so deeply nested paths are printed once, not per problem. */
function report(problems: Problem[]): void {
  const groups = new Map<string, Problem[]>();
  for (const problem of problems) {
    const group = groups.get(problem.path);
    if (group) group.push(problem);
    else groups.set(problem.path, [problem]);
  }

  for (const [path, group] of groups) {
    out(bold(path));
    for (const problem of group) {
      const tag = problem.level === 'error' ? red('error') : yellow(' warn');
      const mark = problem.fixable ? dim(' (fixable)') : '';
      out(`  ${tag}  ${problem.message}${mark}`);
    }
  }
}

function summarize(problems: Problem[], strict: boolean): number {
  const errors = problems.filter((problem) => problem.level === 'error');
  const warnings = problems.filter((problem) => problem.level === 'warn');
  const fixable = problems.filter((problem) => problem.fixable);

  if (!problems.length) {
    out(`${green('OK')} board is valid.`);
    return 0;
  }

  out();
  const parts = [plural(errors.length, 'error'), plural(warnings.length, 'warning')];
  out(`${bold(plural(problems.length, 'problem'))}  ${dim('(')}${parts.join(', ')}${dim(')')}`);
  if (fixable.length) {
    out(`${dim(`${fixable.length} fixable — run`)} ${cyan('lpm check --fix')}`);
  }

  return errors.length || (strict && warnings.length) ? 1 : 0;
}

export function run(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: { fix: { type: 'boolean' }, strict: { type: 'boolean' } },
  });

  let board = requireBoard();

  if (values.fix) {
    const actions = applyFixes(board);
    board = loadBoard(board.paths);
    const remoteActions = fixOrphanedLinks(board);
    if (actions.length || remoteActions.length) {
      out(bold(`Fixed ${plural(actions.length + remoteActions.length, 'thing')}:`));
      for (const action of actions) out(`  ${action}`);
      for (const action of remoteActions) out(`  ${action}`);
      out();
    } else {
      out(dim('Nothing to fix.'));
      out();
    }
  }

  const problems = [...checkBoard(board), ...checkRemoteConfiguration(board)];
  report(problems);
  return summarize(problems, Boolean(values.strict));
}
