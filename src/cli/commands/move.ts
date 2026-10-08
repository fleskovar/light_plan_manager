import { parseArgs } from 'node:util';
import { BoardError, findNode, moveNode } from '../../core/index.js';
import { requireBoard } from '../context.js';
import { bold, dim, green, out, printRollups } from '../ui.js';

export const help = `Change where an issue sits: its status, parent, period or assignee.

Usage
  lpm move <id> [options]

Options
  -s, --status <id>     Move the issue to this status (issues only)
  -p, --parent <id>     Re-parent; use "root" for the top level
      --period <id>     Schedule the issue in a period; use "none" to unschedule
      --assignee <id>   Assign to a person or pool, by id or name; "none" to unassign

Re-parenting moves the folder and everything inside it, and is rejected when
the result would break the configured hierarchy. Periods and resources can be
re-parented too; --status, --period and --assignee apply to issues only.

A status change carries the containers above it: close the last issue in a
feature and the feature closes too, up as far as it goes. Reopen one and they
reopen with it. "lpm check" reports a container that is out of step, and
"lpm check --fix" rolls it up.

Examples
  lpm move LP-7 --status in_progress
  lpm move LP-7 --period TL-3
  lpm move LP-7 --assignee alice
  lpm move LP-7 --assignee none
  lpm move TL-3 --parent TL-1`;

export function run(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      status: { type: 'string', short: 's' },
      parent: { type: 'string', short: 'p' },
      period: { type: 'string' },
      assignee: { type: 'string' },
    },
  });

  const id = positionals[0];
  if (!id) throw new BoardError('Missing id', ['Usage: lpm move <id> --status <status>']);
  if (
    values.status === undefined &&
    values.parent === undefined &&
    values.period === undefined &&
    values.assignee === undefined
  ) {
    throw new BoardError('Nothing to do', [
      'Pass --status, --parent, --period and/or --assignee.',
    ]);
  }

  const board = requireBoard();
  const node = findNode(board, id);
  if (!node) throw new BoardError(`No issue, period or resource with id "${id}"`);

  const parentId =
    values.parent === undefined ? undefined : values.parent === 'root' ? null : values.parent;
  const period =
    values.period === undefined ? undefined : values.period === 'none' ? null : values.period;
  const assignee =
    values.assignee === undefined ? undefined : values.assignee === 'none' ? null : values.assignee;

  const before = node.kind === 'issue' ? node : null;
  const result = moveNode(board, node, { status: values.status, parentId, period, assignee });
  const moved = result.node;

  out(`${green('Moved')} ${bold(moved.id)}  ${moved.title}`);
  if (result.statusChanged && moved.kind === 'issue') {
    out(`  status    ${before?.status} ${dim('->')} ${moved.status}`);
  }
  if (result.periodChanged && moved.kind === 'issue') {
    out(`  period    ${before?.period ?? 'none'} ${dim('->')} ${moved.period ?? 'none'}`);
  }
  if (result.assigneeChanged && moved.kind === 'issue') {
    out(`  assignee  ${before?.assignee ?? 'none'} ${dim('->')} ${moved.assignee ?? 'none'}`);
  }
  if (result.movedTo) out(`  location  ${result.movedTo}`);
  printRollups(result.rollups);
  if (!result.statusChanged && !result.periodChanged && !result.assigneeChanged && !result.movedTo) {
    out(dim('  nothing changed'));
  }
  return 0;
}
