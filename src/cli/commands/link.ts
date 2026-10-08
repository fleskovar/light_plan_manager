import { parseArgs } from 'node:util';
import {
  BoardError,
  findIssue,
  findRegistryTemplate,
  findResource,
  linkIssue,
  linkResource,
  linkTemplate,
  rollupsForEdges,
} from '../../core/index.js';
import { requireBoard } from '../context.js';
import { bold, dim, green, out, printDependencyRollups } from '../ui.js';

export const help = `Record a dependency between issues, or what a resource can cover.

Usage
  lpm link <id> [options]

Options (issues and registry templates)
      --depends-on <ids>   Issues that block <id>; comma-separated, repeatable
      --relates-to <ids>   Non-blocking associations

Options (resources)
      --covers <ids>       Pools <id> can be drawn from

Options (both)
      --remove             Remove the given links instead of adding them

Only the forward edge is stored. The inverses ("what does this block?", "who can
cover this pool?") are derived when the board is loaded, so there is nothing to
keep in sync. Adding a dependency that would close a cycle is rejected.

A dependency is the only edge that orders work: --relates-to implies nothing.
Why an issue is written the way it is belongs in its body and its related files,
not in a third kind of arrow.

A dependency between two pieces of work also puts the containers above them in
the same order, up to the container they share -- two stories in two features
put those two features in order, and the epics above them. That reflection is
reported here and read wherever the board is read; it is never written onto the
containers, because a dependency on a feature is inherited by everything inside
it and would stop work that is waiting on nothing.

Examples
  lpm link LP-7 --depends-on LP-3
  lpm link LP-7 --depends-on LP-3,LP-4 --relates-to LP-9
  lpm link LP-7 --depends-on LP-3 --remove
  lpm link RS-1 --covers RS-7,RS-8
  lpm link TPL-6 --depends-on TPL-5   # inside a registry template

A template's dependencies name other templates and become the dependencies
between the issues it produces, so they are added, removed and cycle-checked in
exactly the same way.`;

function idList(values: string[] | undefined): string[] {
  return (values ?? []).flatMap((entry) => entry.split(',')).map((id) => id.trim()).filter(Boolean);
}

export function run(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      'depends-on': { type: 'string', multiple: true },
      'relates-to': { type: 'string', multiple: true },
      covers: { type: 'string', multiple: true },
      remove: { type: 'boolean' },
    },
  });

  const id = positionals[0];
  if (!id) throw new BoardError('Missing id', ['Usage: lpm link <id> --depends-on <id>']);

  const board = requireBoard();
  const covers = idList(values.covers);

  if (covers.length) {
    const resource = findResource(board, id);
    if (!resource) throw new BoardError(`No resource with id or name "${id}"`);
    if (idList(values['depends-on']).length || idList(values['relates-to']).length) {
      throw new BoardError('Mixing --covers with issue links', [
        'Run one command for the coverage and another for the dependencies.',
      ]);
    }

    const cover = linkResource(board, resource, { covers, remove: Boolean(values.remove) });
    if (!cover.added.length && !cover.removed.length) {
      out(dim('Nothing changed; that coverage was already in that state.'));
      return 0;
    }
    out(`${green('Linked')} ${bold(cover.resource.id)}  ${cover.resource.title}`);
    if (cover.added.length) out(`  covers       + ${cover.added.join(', ')}`);
    if (cover.removed.length) out(`  covers       - ${cover.removed.join(', ')}`);
    return 0;
  }

  const input = {
    dependsOn: idList(values['depends-on']),
    relatesTo: idList(values['relates-to']),
    remove: Boolean(values.remove),
  };

  // The id decides which collection is being wired: `depends_on` means the same
  // thing in the registry, one level removed. @see linkTemplate
  const issue = findIssue(board, id);
  const template = issue ? null : findRegistryTemplate(board, id);
  if (!issue && !template) throw new BoardError(`No issue or template with id "${id}"`);

  const result = issue
    ? linkIssue(board, issue, input)
    : linkTemplate(board, template!, input);

  const rolled = issue
    ? rollupsForEdges(
        board,
        result.addedDependsOn.map((target) => ({ from: issue.id, to: target })),
      )
    : [];

  const lines: string[] = [];
  if (result.addedDependsOn.length) lines.push(`  depends on   + ${result.addedDependsOn.join(', ')}`);
  if (result.removedDependsOn.length) lines.push(`  depends on   - ${result.removedDependsOn.join(', ')}`);
  if (result.addedRelatesTo.length) lines.push(`  relates to   + ${result.addedRelatesTo.join(', ')}`);
  if (result.removedRelatesTo.length) lines.push(`  relates to   - ${result.removedRelatesTo.join(', ')}`);

  if (!lines.length) {
    out(dim('Nothing changed; those links were already in that state.'));
    return 0;
  }

  out(`${green('Linked')} ${bold(result.issue.id)}  ${result.issue.title}`);
  for (const line of lines) out(line);
  printDependencyRollups(rolled);
  return 0;
}
