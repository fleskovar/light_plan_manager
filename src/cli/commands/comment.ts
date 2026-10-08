import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  BoardError,
  addComment,
  currentUser,
  findNode,
  listComments,
  removeComment,
} from '../../core/index.js';
import { requireBoard } from '../context.js';
import { bold, cyan, dim, green, out, plural } from '../ui.js';

export const help = `Write down how the work is going, and read what others wrote.

Usage
  lpm comment <id> <text>
  lpm comment <id> --file <path>
  lpm comment <id> --list
  lpm comment <id> --remove <n>

Options
  -m, --message <text>  The comment; also accepted as a positional
  -f, --file <path>     Read it from a file ("-" for stdin)
      --list            Show the log instead of adding to it
      --remove <n>      Delete comment number <n>
      --author <name>   Override the author; defaults to this checkout's user

Comments live in a \`_comments.md\` beside the document, so they diff, merge and
blame like everything else. This is where an agent records what it tried and a
reviewer records what they want changed.

Examples
  lpm comment LP-7 "Blocked on the sandbox credentials"
  lpm comment LP-7 --file ./run-notes.md
  lpm comment LP-7 --list
  echo "done" | lpm comment LP-7 -f -`;

function readMessage(
  positional: string | undefined,
  message: string | undefined,
  file: string | undefined,
): string {
  if (file !== undefined) {
    try {
      return readFileSync(file === '-' ? 0 : file, 'utf8');
    } catch (error) {
      throw new BoardError(`Could not read ${file}`, [(error as Error).message]);
    }
  }
  const text = message ?? positional;
  if (!text) {
    throw new BoardError('Nothing to say', [
      'Pass the comment as an argument, with --message, or with --file.',
    ]);
  }
  return text;
}

export function run(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      message: { type: 'string', short: 'm' },
      file: { type: 'string', short: 'f' },
      list: { type: 'boolean' },
      remove: { type: 'string' },
      author: { type: 'string' },
    },
  });

  const id = positionals[0];
  if (!id) throw new BoardError('Missing id', ['Usage: lpm comment <id> "..."']);

  const board = requireBoard();
  const node = findNode(board, id);
  if (!node) throw new BoardError(`No issue, period or resource with id "${id}"`);

  if (values.list) {
    const comments = listComments(board, node.id);
    out(`${bold(node.id)}  ${node.title}`);
    if (!comments.length) {
      out(dim('  no comments yet'));
      return 0;
    }
    for (const comment of comments) {
      out();
      out(`  ${cyan(`#${comment.index}`)} ${comment.author} ${dim(comment.at)}`);
      for (const line of comment.body.split('\n')) out(`    ${line}`);
    }
    out();
    out(dim(`  ${plural(comments.length, 'comment')}`));
    return 0;
  }

  if (values.remove !== undefined) {
    const index = Number(values.remove);
    if (!Number.isInteger(index) || index < 1) {
      throw new BoardError(`Invalid --remove "${values.remove}"`, ['Expected a comment number.']);
    }
    const removed = removeComment(board, node.id, index);
    out(`${green('Removed')} comment #${index} on ${bold(node.id)}`);
    out(dim(`  ${removed.body.split('\n')[0]}`));
    return 0;
  }

  const body = readMessage(positionals.slice(1).join(' ') || undefined, values.message, values.file);
  // Whoever this checkout says it is, so a comment is attributed to the team
  // member rather than to whatever git happens to be configured with.
  const user = currentUser(board);
  const author =
    values.author ??
    (user?.resource ? `${user.resource.title} (${user.resource.id})` : undefined);
  const result = addComment(board, node.id, { body, author });

  out(`${green('Commented')} on ${bold(node.id)}  ${node.title}`);
  out(dim(`  #${result.comment.index} by ${result.comment.author}`));
  return 0;
}
