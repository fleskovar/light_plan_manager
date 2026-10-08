import { parseArgs } from 'node:util';
import { BoardError, findNode, nodesOf, removeNode, subtreeOf } from '../../core/index.js';
import { requireBoard } from '../context.js';
import { bold, dim, out, plural, red, yellow } from '../ui.js';

export const help = `Delete a document and everything nested under it.

Usage
  lpm rm <id> [options]

Options
  -r, --recursive       Required when the document has children
      --dry-run         List what would go, delete nothing

Anything that pointed at what you delete is rewritten: dependencies, coverage,
assignees and period links are cleaned up so the board is left valid. The
folder is removed from disk — recover it with git if you did not mean it.

Examples
  lpm rm LP-7
  lpm rm LP-3 --recursive
  lpm rm LP-3 --dry-run`;

export function run(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      recursive: { type: 'boolean', short: 'r' },
      'dry-run': { type: 'boolean' },
    },
  });

  const id = positionals[0];
  if (!id) throw new BoardError('Missing id', ['Usage: lpm rm <id>']);

  const board = requireBoard();
  const node = findNode(board, id);
  if (!node) throw new BoardError(`No issue, period or resource with id "${id}"`);

  const doomed = subtreeOf(nodesOf(board, node.kind), node);
  const descendants = doomed.length - 1;

  // Deleting one thing is a small mistake; deleting a programme's worth of work
  // because you typed the wrong id is not, so the subtree case has to be asked for.
  if (descendants > 0 && !values.recursive && !values['dry-run']) {
    throw new BoardError(`${node.id} has ${plural(descendants, 'descendant')}`, [
      `Pass --recursive to delete all ${doomed.length}, or --dry-run to list them.`,
    ]);
  }

  if (values['dry-run']) {
    out(`${yellow('Would delete')} ${bold(node.id)}  ${node.title}`);
    for (const entry of doomed.slice(1)) out(dim(`  - ${entry.id}  ${entry.title}`));
    return 0;
  }

  const result = removeNode(board, node);
  out(`${red('Deleted')} ${bold(node.id)}  ${node.title}`);
  for (const gone of result.removed.slice(1)) out(dim(`  - ${gone}`));
  out(dim(`  ${result.path}`));
  if (result.detached.length) {
    out(`  ${plural(result.detached.length, 'document')} rewritten: ${result.detached.join(', ')}`);
  }
  return 0;
}
