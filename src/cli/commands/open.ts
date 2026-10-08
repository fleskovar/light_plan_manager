import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { BoardError, findNode } from '../../core/index.js';
import { requireBoard } from '../context.js';
import { dim, out } from '../ui.js';

export const help = `Open an issue or period markdown file in your editor.

Usage
  lpm open <id> [options]
  lpm edit <id> [options]

Options
      --path            Print the file path instead of opening it

Uses $VISUAL, then $EDITOR. With neither set, the path is printed.`;

export function run(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { path: { type: 'boolean' } },
  });

  const id = positionals[0];
  if (!id) throw new BoardError('Missing id', ['Usage: lpm open <id>']);

  const board = requireBoard();
  const issue = findNode(board, id);
  if (!issue) throw new BoardError(`No issue or period with id "${id}"`);

  const editor = process.env.VISUAL ?? process.env.EDITOR;
  if (values.path || !editor) {
    out(issue.file);
    if (!editor && !values.path) out(dim('Set $EDITOR to open issues directly.'));
    return 0;
  }

  const [command, ...editorArgs] = editor.split(' ').filter(Boolean);
  const result = spawnSync(command!, [...editorArgs, issue.file], { stdio: 'inherit' });
  if (result.error) {
    throw new BoardError(`Could not run editor "${editor}"`, [result.error.message]);
  }
  return result.status ?? 0;
}
