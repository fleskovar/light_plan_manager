import { parseArgs } from 'node:util';
import { BoardError, findIssue } from '../../core/index.js';
import { counterFactory, planInsert } from '../../shared/index.js';
import { requireBoard } from '../context.js';
import { boardView, printCreated, runPlan } from '../plan.js';
import { bold, dim, green, out } from '../ui.js';

export const help = `Put an issue in the middle of a dependency.

Usage
  lpm insert --between <upstream>..<downstream> [options]

Options
      --between <a>..<b>  The dependency to split: b currently depends on a
      --issue <id>        Move this existing issue into it
      --type <type>       Otherwise create one of this type (default: a's type)
  -t, --title <text>      Title for the created issue

The edge is replaced, not added to: a -> b becomes a -> new -> b. This is the
command-line form of dragging a node onto an edge, and of an edge's "New..."
menu item.

Examples
  lpm insert --between LP-4..LP-7 -t "Validate the payload"
  lpm insert --between LP-4..LP-7 --issue LP-9
  lpm insert --between LP-4..LP-7 --type bug -t "Fix the encoding first"`;

export function run(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: {
      between: { type: 'string' },
      issue: { type: 'string' },
      type: { type: 'string' },
      title: { type: 'string', short: 't' },
    },
  });

  if (!values.between) {
    throw new BoardError('Missing --between', ['Usage: lpm insert --between <a>..<b>']);
  }
  const [source, target] = values.between.split('..');
  if (!source || !target) {
    throw new BoardError(`Invalid --between "${values.between}"`, [
      'Expected the form <upstream>..<downstream>, e.g. LP-4..LP-7.',
    ]);
  }

  const board = requireBoard();
  // Resolve ids up front so a typo is reported as a missing issue rather than
  // as a missing dependency between two things that do not exist.
  const upstream = findIssue(board, source);
  const downstream = findIssue(board, target);
  if (!upstream) throw new BoardError(`No issue with id "${source}"`);
  if (!downstream) throw new BoardError(`No issue with id "${target}"`);

  const plan = planInsert(boardView(board), counterFactory(), {
    source: upstream.id,
    target: downstream.id,
    ...(values.issue ? { issueId: findIssue(board, values.issue)?.id ?? values.issue } : {}),
    ...(values.type ? { type: values.type } : {}),
    ...(values.title ? { title: values.title } : {}),
  });

  const { created } = runPlan(board, plan, 'Insert');
  const after = requireBoard();
  const middle = created[0] ?? findIssue(after, values.issue ?? '')?.id ?? '';

  out(`${green('Inserted')} ${bold(middle)} between ${upstream.id} and ${downstream.id}`);
  if (created.length) printCreated(created, after, 'new');
  out(dim(`  ${upstream.id} -> ${middle} -> ${downstream.id}`));
  return 0;
}
