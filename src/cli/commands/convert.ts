import { parseArgs } from 'node:util';
import { BoardError, findNode, typesFor } from '../../core/index.js';
import {
  counterFactory,
  planBridgeReparent,
  planConvert,
  planReparent,
  reparentChoices,
} from '../../shared/index.js';
import { requireBoard } from '../context.js';
import { boardView, printCreated, runPlan } from '../plan.js';
import { bold, dim, green, out, yellow } from '../ui.js';

export const help = `Change what a document is: its type, and where that puts it.

Usage
  lpm convert <id> <type> [options]
  lpm convert <id> --under <parent-id>

Options
      --under <id>      Move it under this parent, demoting its type to fit
      --build-parents   Instead of demoting it, create the levels in between
      --dry-run         Say what would happen, change nothing

A type that belongs at a different depth takes the document with it: converting
a user story to a feature moves it up to its epic. Converting downwards has no
single right answer, so use --under, which is the command-line equivalent of
dropping a node onto another in the web UI.

A move that skips levels has two answers, and --build-parents picks the other
one: a story dropped onto a program either becomes an epic, or keeps its type
and gets the epic and feature it was missing.

Examples
  lpm convert LP-7 bug             # same level, different type
  lpm convert LP-7 feature         # promoted, and moved to its epic
  lpm convert LP-7 --under LP-9    # demoted to fit under LP-9
  lpm convert LP-7 --under LP-1 --build-parents
  lpm convert LP-7 --under root    # moved to the top level`;

export function run(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      under: { type: 'string' },
      'build-parents': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
    },
  });

  const [id, type] = positionals;
  if (!id) throw new BoardError('Missing id', ['Usage: lpm convert <id> <type>']);
  if (!type && values.under === undefined) {
    throw new BoardError('Missing type', [
      'Usage: lpm convert <id> <type>, or lpm convert <id> --under <parent-id>',
    ]);
  }

  const board = requireBoard();
  const node = findNode(board, id);
  if (!node) throw new BoardError(`No issue, period or resource with id "${id}"`);

  const view = boardView(board);
  const parentId = values.under === 'root' ? null : (values.under ?? undefined);
  const label = (name: string): string => typesFor(board.config, node.kind)[name]?.label ?? name;

  if (parentId !== undefined) {
    const choices = reparentChoices(view, node.id, parentId);
    const building = values['build-parents'] === true;

    if (building && !choices.bridge.length) {
      throw new BoardError(`Nothing can be created to hold ${node.id} there`, [
        'Drop --build-parents to demote its type instead.',
      ]);
    }
    if (!building && !choices.convert.allowed) {
      throw new BoardError(
        choices.convert.reason ?? 'That move is not allowed',
        choices.bridge.length
          ? [`Add --build-parents to create ${choices.bridge.map(label).join(' > ')} instead.`]
          : undefined,
      );
    }

    if (values['dry-run']) {
      out(`${yellow('Would move')} ${bold(node.id)} under ${parentId ?? 'the top level'}`);
      if (building) {
        out(`  creating  ${choices.bridge.map(label).join(dim(' > '))}`);
      } else if (choices.convert.type !== node.type) {
        out(`  type      ${label(node.type)} ${dim('->')} ${label(choices.convert.type)}`);
      }
      return 0;
    }

    if (building) {
      const report = runPlan(
        board,
        planBridgeReparent(view, counterFactory(), node.id, parentId),
        'Convert',
      );
      out(`${green('Moved')} ${bold(node.id)}  ${node.title}`);
      printCreated(report.created, requireBoard());
      return 0;
    }

    runPlan(board, planReparent(view, node.id, parentId), 'Convert');
    out(`${green('Moved')} ${bold(node.id)}  ${node.title}`);
    out(`  parent    ${node.parentId ?? 'root'} ${dim('->')} ${parentId ?? 'root'}`);
    if (choices.convert.type !== node.type) {
      out(`  type      ${label(node.type)} ${dim('->')} ${label(choices.convert.type)}`);
    }
    return 0;
  }

  const plan = planConvert(view, node.id, type!);
  if (values['dry-run']) {
    if (!plan.ok) throw new BoardError(plan.error, plan.details);
    const patch = plan.changes[0];
    out(`${yellow('Would convert')} ${bold(node.id)} to ${type}`);
    if (patch && patch.kind !== 'delete' && patch.patch.parentId !== undefined) {
      out(`  parent    ${node.parentId ?? 'root'} ${dim('->')} ${patch.patch.parentId ?? 'root'}`);
    }
    return 0;
  }

  runPlan(board, plan, 'Convert');
  const after = findNode(requireBoard(), node.id);
  out(`${green('Converted')} ${bold(node.id)}  ${after?.title ?? node.title}`);
  out(`  type      ${node.type} ${dim('->')} ${type}`);
  if (after && after.parentId !== node.parentId) {
    out(`  parent    ${node.parentId ?? 'root'} ${dim('->')} ${after.parentId ?? 'root'}`);
  }
  return 0;
}
