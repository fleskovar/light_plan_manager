import { parseArgs } from 'node:util';
import { BoardError, findIssue } from '../../core/index.js';
import { counterFactory, planBreakdown } from '../../shared/index.js';
import { requireBoard } from '../context.js';
import { boardView, printCreated, runPlan } from '../plan.js';
import { bold, dim, green, out, plural, yellow } from '../ui.js';

export const help = `Break an issue into smaller ones, keeping the graph wired up.

Usage
  lpm split <id> --into <n> [options]
  lpm split <id> --titles "First,Second,Third" [options]

Options
      --into <n>        How many pieces
      --titles <a,b,c>  Titles for the pieces; sets --into when it is omitted
      --replace         Put the pieces where the original was and delete it
      --children        Nest the pieces inside the original (the default)
      --no-chain        Do not make each piece depend on the one before it
      --split-effort    Divide the board's effort attribute across the pieces
      --dry-run         Say what would happen, change nothing

Whichever mode you choose, the rewiring is done for you: whatever blocked the
original blocks the first piece, and whatever waited on it waits on the last.

Examples
  lpm split LP-7 --into 5 --children
  lpm split LP-7 --into 3 --replace --split-effort
  lpm split LP-7 --titles "Schema,API,UI" --replace`;

export function run(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      into: { type: 'string' },
      titles: { type: 'string' },
      replace: { type: 'boolean' },
      children: { type: 'boolean' },
      'no-chain': { type: 'boolean' },
      'split-effort': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
    },
  });

  const id = positionals[0];
  if (!id) throw new BoardError('Missing id', ['Usage: lpm split <id> --into <n>']);
  if (values.replace && values.children) {
    throw new BoardError('Pick one of --replace and --children');
  }

  const titles = values.titles
    ?.split(',')
    .map((title) => title.trim())
    .filter(Boolean);
  const count = values.into === undefined ? titles?.length : Number(values.into);
  if (!count || !Number.isInteger(count) || count < 1) {
    throw new BoardError('Missing --into', ['Pass --into <n>, or --titles with a list.']);
  }

  const board = requireBoard();
  const issue = findIssue(board, id);
  if (!issue) throw new BoardError(`No issue with id "${id}"`);

  const mode = values.replace ? 'replace' : 'children';
  const plan = planBreakdown(boardView(board), counterFactory(), issue.id, {
    count,
    mode,
    titles,
    chain: !values['no-chain'],
    ...(values['split-effort'] ? { splitAttribute: board.config.effort_attribute } : {}),
  });

  if (values['dry-run']) {
    if (!plan.ok) throw new BoardError(plan.error, plan.details);
    out(`${yellow('Would split')} ${bold(issue.id)}  ${issue.title}`);
    out(dim(`  into ${plural(count, 'piece')}, ${mode === 'replace' ? 'replacing it' : 'nested inside it'}`));
    for (const change of plan.changes) {
      if (change.kind === 'create') out(`  + ${change.patch.title}`);
      if (change.kind === 'delete') out(`  - ${change.id}`);
    }
    return 0;
  }

  const { created } = runPlan(board, plan, 'Split');
  const after = requireBoard();

  out(`${green('Split')} ${bold(issue.id)}  ${issue.title}`);
  printCreated(created, after, 'new');
  if (mode === 'replace') out(dim(`  ${issue.id} was replaced and deleted`));
  return 0;
}
