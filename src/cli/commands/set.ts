import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { AnyNode } from '../../core/index.js';
import { BoardError, findNode, updateNode } from '../../core/index.js';
import { requireBoard } from '../context.js';
import { parseSets, typeDefOf } from '../plan.js';
import { bold, dim, green, out } from '../ui.js';

export const help = `Edit a document: its title, its body, or its attributes.

Usage
  lpm set <id> [options]

Options
  -t, --title <text>    Rename it; the folder is renamed to match
      --body <text>     Replace the markdown body
      --body-file <path>  Replace the body with the contents of a file ("-" for stdin)
      --set key=value   Set an attribute; repeatable
      --related <path>  Issues only: attach a file this issue is about; repeatable
      --unrelated <path>  Issues only: detach one; repeatable
      --starts <date>   Periods only, YYYY-MM-DD
      --ends <date>     Periods only, YYYY-MM-DD
      --capacity <n>    Resources only, in full-time equivalents

Where an issue *sits* is \`lpm move\` (status, parent, period, assignee) and what
it *is* is \`lpm convert\` (type). This changes the document's own content.

A related file is a path from the project root, optionally with a line range:
\`docs/prd.md#L10-L42\`, \`src/checkout/session.ts\`. It is never checked against
the filesystem — an issue may name a file that does not exist yet, and that is
usually the point of naming it.

Examples
  lpm set LP-7 --title "Checkout as a guest"
  lpm set LP-7 --set story_points=5 --set priority=high
  lpm set LP-7 --related "docs/prd.md#L10-L42" --related src/checkout/session.ts
  lpm set LP-7 --unrelated src/checkout/session.ts
  lpm set LP-7 --body-file notes.md
  lpm set TL-2 --starts 2026-08-03 --ends 2026-08-14
  lpm set RS-1 --capacity 0.5`;

/**
 * The list `--related` and `--unrelated` add up to, or `undefined` when neither
 * was given. Add and remove rather than replace: a developer attaching the file
 * they have just found should not have to retype the three already there.
 */
function editFileRefs(
  node: AnyNode,
  add: string[] | undefined,
  remove: string[] | undefined,
): string[] | undefined {
  if (!add?.length && !remove?.length) return undefined;
  if (node.kind !== 'issue') {
    throw new BoardError(`${node.id} is a ${node.kind}; related files apply to issues only`);
  }
  const wanted = [...node.related_files];
  for (const raw of add ?? []) {
    const ref = raw.trim();
    if (ref && !wanted.includes(ref)) wanted.push(ref);
  }
  const gone = new Set((remove ?? []).map((ref) => ref.trim()));
  return wanted.filter((ref) => !gone.has(ref));
}

function readBody(text: string | undefined, file: string | undefined): string | undefined {
  if (text !== undefined) return text;
  if (file === undefined) return undefined;
  try {
    return readFileSync(file === '-' ? 0 : file, 'utf8');
  } catch (error) {
    throw new BoardError(`Could not read ${file}`, [(error as Error).message]);
  }
}

export function run(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      title: { type: 'string', short: 't' },
      body: { type: 'string' },
      'body-file': { type: 'string' },
      set: { type: 'string', multiple: true },
      related: { type: 'string', multiple: true },
      unrelated: { type: 'string', multiple: true },
      starts: { type: 'string' },
      ends: { type: 'string' },
      capacity: { type: 'string' },
    },
  });

  const id = positionals[0];
  if (!id) throw new BoardError('Missing id', ['Usage: lpm set <id> --title "..."']);

  const board = requireBoard();
  const node = findNode(board, id);
  if (!node) throw new BoardError(`No issue, period or resource with id "${id}"`);

  const body = readBody(values.body, values['body-file']);
  const attributes = values.set?.length
    ? parseSets(typeDefOf(board, node), node.type, values.set)
    : undefined;
  const capacity = values.capacity === undefined ? undefined : Number(values.capacity);
  if (capacity !== undefined && !Number.isFinite(capacity)) {
    throw new BoardError(`Invalid --capacity "${values.capacity}"`);
  }
  const relatedFiles = editFileRefs(node, values.related, values.unrelated);

  if (
    values.title === undefined &&
    body === undefined &&
    attributes === undefined &&
    relatedFiles === undefined &&
    values.starts === undefined &&
    values.ends === undefined &&
    capacity === undefined
  ) {
    throw new BoardError('Nothing to do', [
      'Pass --title, --body, --body-file, --set, --related, --unrelated, --starts, --ends and/or --capacity.',
    ]);
  }

  const result = updateNode(board, node, {
    title: values.title,
    body,
    attributes,
    relatedFiles,
    starts: values.starts,
    ends: values.ends,
    capacity,
  });

  const width = Math.max(8, ...Object.keys(attributes ?? {}).map((key) => key.length));
  const show = (value: unknown): string =>
    Array.isArray(value) ? value.join(', ') : value === null ? 'none' : String(value);

  out(`${green('Updated')} ${bold(result.node.id)}  ${result.node.title}`);
  if (values.title !== undefined) {
    out(`  ${'title'.padEnd(width)}  ${node.title} ${dim('->')} ${result.node.title}`);
  }
  for (const [key, value] of Object.entries(attributes ?? {})) {
    out(`  ${key.padEnd(width)}  ${show(value)}`);
  }
  if (relatedFiles !== undefined) {
    out(`  ${'files'.padEnd(width)}  ${relatedFiles.join(', ') || 'none'}`);
  }
  if (body !== undefined) out(`  ${'body'.padEnd(width)}  ${body.split('\n').length} line(s)`);
  return 0;
}
