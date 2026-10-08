import { parseArgs } from 'node:util';
import { BoardError, findNode } from '../../core/index.js';
import { counterFactory, planDuplicate } from '../../shared/index.js';
import { requireBoard } from '../context.js';
import { boardView, printCreated, runPlan } from '../plan.js';
import { bold, dim, green, out, yellow } from '../ui.js';

export const help = `Duplicate documents, and everything nested under them.

Usage
  lpm copy <id> [<id>...] [options]

Options
      --under <id>      Put the copies under this parent instead ("root" for the top)
      --dry-run         Say what would happen, change nothing

Dependencies that ran between the copied documents are kept and repointed at
the copies; those that left the selection are dropped, so a duplicated
structure stands on its own rather than re-blocking whatever the original
blocked.

Examples
  lpm copy LP-3                    # the feature and its stories
  lpm copy LP-3 --under LP-9       # ...somewhere else
  lpm copy LP-4 LP-5 LP-6`;

export function run(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { under: { type: 'string' }, 'dry-run': { type: 'boolean' } },
  });

  if (!positionals.length) throw new BoardError('Missing id', ['Usage: lpm copy <id>']);

  const board = requireBoard();
  const ids = positionals.map((id) => {
    const node = findNode(board, id);
    if (!node) throw new BoardError(`No issue, period or resource with id "${id}"`);
    return node.id;
  });

  const plan = planDuplicate(boardView(board), counterFactory(), ids);
  if (!plan.ok) throw new BoardError(plan.error, plan.details);

  // The planner puts each copy beside its original; --under moves the roots.
  if (values.under !== undefined) {
    const parentId = values.under === 'root' ? null : values.under;
    if (parentId !== null && !findNode(board, parentId)) {
      throw new BoardError(`No document with id "${parentId}"`);
    }
    const roots = new Set(plan.created.slice(0, ids.length));
    for (const change of plan.changes) {
      if (change.kind === 'create' && roots.has(change.id)) change.patch.parentId = parentId;
    }
  }

  if (values['dry-run']) {
    out(`${yellow('Would copy')} ${ids.join(', ')}`);
    for (const change of plan.changes) {
      if (change.kind === 'create') out(`  + ${change.patch.title}`);
    }
    return 0;
  }

  const { created } = runPlan(board, plan, 'Copy');
  out(`${green('Copied')} ${bold(ids.join(', '))}`);
  printCreated(created, requireBoard(), 'new');
  out(dim(`  ${created.length} document(s) created`));
  return 0;
}
