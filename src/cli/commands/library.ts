import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { BoardPaths, LibraryDoc } from '../../core/index.js';
import {
  BoardError,
  createLibraryDoc,
  createLibraryFolder,
  displayPath,
  libraryDir,
  libraryParentOf,
  libraryReferrers,
  listLibraryDocs,
  listLibraryFolders,
  moveLibraryDoc,
  readLibraryDoc,
  removeLibraryDoc,
  removeLibraryFolder,
  requireLibraryId,
  updateLibraryDoc,
} from '../../core/index.js';
import { requireBoard } from '../context.js';
import { bold, cyan, dim, err, green, out, pad, plural, yellow } from '../ui.js';

export const help = `The board library: markdown documents that live beside the issues.

Usage
  lpm library [list] [--json]
  lpm library tree [<folder>] [--json]
  lpm library show <id> [--json]
  lpm library new <id> [-t "Title"] [-d "Description"] [-m <text> | -f <path>]
  lpm library set <id> [-t "Title"] [-d "Description"] [-m <text> | -f <path>]
  lpm library mv <id> <new-id> [--no-refs]
  lpm library refs <id>
  lpm library rm <id>
  lpm library mkdir <folder>
  lpm library rmdir <folder> [-r]

Subcommands
  list        Every document: its id, its title and its description
  tree        The folders and the documents, nested, also the empty folders
  show        Print the body of one document. --json prints every field
  new         Add a document
  set         Change the title, the description or the body of a document
  mv          Rename a document, or move a folder of documents, and rewrite the
              references of the issues and templates to the new ids
  refs        The issues and templates that reference a document
  rm          Delete a document. The references to it stay, and lpm check reports them
  mkdir       Create a folder, and each folder above it
  rmdir       Delete a folder. -r also deletes the documents inside it

Options
  -t, --title <text>        The title. Without one, the first "# " heading or the id
  -d, --description <text>  One line that says what the document is for
  -m, --message <text>      The body
  -f, --file <path>         Read the body from a file ("-" for stdin)
      --json                Print JSON
      --no-refs             With mv: keep the references at the old ids
  -r, --recursive           With rmdir: delete the documents inside the folder too

A document is the file .lpm/library/<id>.md. The id is the path below the
library folder without ".md", for example prompts/code-review. Each part holds
lowercase letters, digits, "-", "_" and ".".

Folders organise the documents. A document is in a folder when its id starts
with the folder: prompts/code-review is in the folder prompts. A new document
creates its folders. A folder stays when its last document leaves it, and each
folder holds a .gitkeep file, so git keeps an empty folder too. To move a
document into a folder, give it an id below that folder with mv.

An issue or a template references a document with the related file
"library:<id>", or with a markdown link to "library:<id>" in its body. The
working brief of \`lpm instructions\`, and so of \`lpm queue agent\`, prints each
document that the issue or one of its ancestors references.

Examples
  lpm library new prompts/code-review -t "Code review prompt" -f ./review.md
  lpm library new prd/payments -d "Requirements for the payments epic"
  lpm set LP-4 --related library:prd/payments
  lpm library show prompts/code-review > review.md
  lpm library mv prd/payments prd/payments-v1
  lpm library mv prompts agent-prompts      # the folder, with everything inside it
  lpm library mkdir archive/2026
  lpm library mv prd/payments archive/2026/payments
  lpm library rmdir archive -r
  lpm library refs prd/payments`;

export function run(args: string[]): number {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case undefined:
    case 'list':
    case 'ls':
      return list(rest);
    case 'show':
    case 'cat':
      return show(rest);
    case 'new':
    case 'add':
      return write(rest, 'new');
    case 'set':
    case 'edit':
      return write(rest, 'set');
    case 'mv':
    case 'move':
    case 'rename':
      return move(rest);
    case 'refs':
      return refs(rest);
    case 'rm':
    case 'delete':
      return remove(rest);
    case 'tree':
      return tree(rest);
    case 'mkdir':
      return mkdir(rest);
    case 'rmdir':
      return rmdir(rest);
    default:
      throw new BoardError(`Unknown subcommand "${subcommand}"`, [
        'Use one of: list, tree, show, new, set, mv, refs, rm, mkdir, rmdir.',
      ]);
  }
}

function requireId(positionals: string[], usage: string): string {
  const raw = positionals[0];
  if (!raw) throw new BoardError('Missing library id', [`Usage: ${usage}`]);
  return requireLibraryId(raw);
}

function toJson(doc: LibraryDoc, root: BoardPaths): Record<string, unknown> {
  return {
    id: doc.id,
    ref: `library:${doc.id}`,
    title: doc.title,
    description: doc.description,
    path: displayPath(root, doc.file),
    updated: doc.updated,
    revision: doc.revision,
    body: doc.body,
  };
}

function list(args: string[]): number {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean' } } });
  const board = requireBoard();
  const docs = listLibraryDocs(board.paths);
  if (values.json) {
    // The list leaves the bodies out. `lpm library show <id> --json` prints one.
    const entries = docs.map((doc) => {
      const { body: _body, ...entry } = toJson(doc, board.paths);
      return entry;
    });
    out(JSON.stringify(entries, null, 2));
    return 0;
  }
  if (!docs.length) {
    out(dim('The library is empty. `lpm library new <id>` adds a document to .lpm/library.'));
    return 0;
  }
  const width = Math.max(...docs.map((doc) => doc.id.length));
  for (const doc of docs) {
    out(`${cyan(pad(doc.id, width))}  ${bold(doc.title)}${doc.description ? dim(`  ${doc.description}`) : ''}`);
  }
  out();
  out(dim(`  ${plural(docs.length, 'document')} in ${displayPath(board.paths, libraryDir(board.paths))}`));
  return 0;
}

function show(args: string[]): number {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } });
  const id = requireId(positionals, 'lpm library show <id>');
  const board = requireBoard();
  const doc = readLibraryDoc(board.paths, id);
  if (!doc) throw new BoardError(`The library has no document "${id}"`, ['`lpm library` lists the documents.']);
  if (values.json) {
    out(JSON.stringify(toJson(doc, board.paths), null, 2));
    return 0;
  }
  // The body is the content, so it goes to stdout alone and can be piped.
  // The title and the path go to stderr.
  err(dim(`${doc.title} · ${displayPath(board.paths, doc.file)}`));
  process.stdout.write(doc.body.endsWith('\n') ? doc.body : `${doc.body}\n`);
  return 0;
}

function readBody(message: string | undefined, file: string | undefined): string | undefined {
  if (file !== undefined) {
    try {
      return readFileSync(file === '-' ? 0 : file, 'utf8');
    } catch (error) {
      throw new BoardError(`Could not read ${file}`, [(error as Error).message]);
    }
  }
  return message;
}

function write(args: string[], mode: 'new' | 'set'): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      title: { type: 'string', short: 't' },
      description: { type: 'string', short: 'd' },
      message: { type: 'string', short: 'm' },
      file: { type: 'string', short: 'f' },
    },
  });
  const id = requireId(positionals, `lpm library ${mode} <id> [options]`);
  const body = readBody(values.message, values.file);
  const board = requireBoard();
  if (mode === 'new') {
    const doc = createLibraryDoc(board, { id, title: values.title, description: values.description, body });
    out(`${green('Added')} ${bold(`library:${doc.id}`)}  ${doc.title}`);
    out(dim(`  ${displayPath(board.paths, doc.file)}`));
    return 0;
  }
  if (values.title === undefined && values.description === undefined && body === undefined) {
    throw new BoardError('Nothing to change', ['Pass --title, --description, --message or --file.']);
  }
  const doc = updateLibraryDoc(board, id, { title: values.title, description: values.description, body });
  out(`${green('Updated')} ${bold(`library:${doc.id}`)}  ${doc.title}`);
  return 0;
}

function move(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { 'no-refs': { type: 'boolean' } },
  });
  if (positionals.length !== 2) {
    throw new BoardError('Pass the id to move and the new id', ['Usage: lpm library mv <id> <new-id> [--no-refs]']);
  }
  const board = requireBoard();
  const result = moveLibraryDoc(board, positionals[0]!, positionals[1]!, { updateReferences: !values['no-refs'] });
  if (result.kind === 'folder') {
    out(`${green('Moved')} the folder ${bold(`${positionals[0]}/`)} → ${bold(`${positionals[1]}/`)}`);
  }
  for (const entry of result.moved) {
    out(`${result.kind === 'folder' ? '  ' : ''}${green('Moved')} ${bold(`library:${entry.from}`)} → ${bold(`library:${entry.to}`)}`);
  }
  if (result.rewritten.length) out(dim(`  Rewrote the references of ${result.rewritten.join(', ')}.`));
  if (result.stale.length) {
    out(yellow(`  ${result.stale.join(', ')} still reference the old ids. lpm check reports these references.`));
  }
  return 0;
}

function tree(args: string[]): number {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } });
  const below = positionals[0] ? requireLibraryId(positionals[0]) : '';
  const board = requireBoard();
  const inside = (id: string): boolean => !below || id === below || id.startsWith(`${below}/`);
  const folders = listLibraryFolders(board.paths).filter(inside);
  const docs = listLibraryDocs(board.paths).filter((doc) => inside(doc.id));
  if (below && !folders.includes(below)) throw new BoardError(`The library has no folder "${below}"`);
  if (values.json) {
    const documents = docs.map((doc) => {
      const { body: _body, ...entry } = toJson(doc, board.paths);
      return entry;
    });
    out(JSON.stringify({ folders, documents }, null, 2));
    return 0;
  }
  if (!folders.length && !docs.length) {
    out(dim('The library is empty. `lpm library new <id>` adds a document, `lpm library mkdir <folder>` a folder.'));
    return 0;
  }
  // One line for each folder and each document, folders before documents at each level.
  const children = (parent: string): { folders: string[]; docs: LibraryDoc[] } => ({
    folders: folders.filter((folder) => libraryParentOf(folder) === parent),
    docs: docs.filter((doc) => libraryParentOf(doc.id) === parent),
  });
  const print = (parent: string, depth: number): void => {
    const level = children(parent);
    for (const folder of level.folders) {
      out(`${'  '.repeat(depth)}${bold(`${folder.split('/').at(-1)}/`)}`);
      print(folder, depth + 1);
    }
    for (const doc of level.docs) {
      const name = doc.id.split('/').at(-1)!;
      out(`${'  '.repeat(depth)}${cyan(name)}  ${doc.title}${doc.description ? dim(`  ${doc.description}`) : ''}`);
    }
  };
  if (below) {
    out(bold(`${below}/`));
    print(below, 1);
  } else {
    print('', 0);
  }
  out();
  out(dim(`  ${plural(folders.length, 'folder')}, ${plural(docs.length, 'document')}`));
  return 0;
}

function mkdir(args: string[]): number {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  const folder = requireId(positionals, 'lpm library mkdir <folder>');
  const board = requireBoard();
  createLibraryFolder(board, folder);
  out(`${green('Created')} the folder ${bold(`${folder}/`)}`);
  return 0;
}

function rmdir(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { recursive: { type: 'boolean', short: 'r' } },
  });
  const folder = requireId(positionals, 'lpm library rmdir <folder> [-r]');
  const board = requireBoard();
  const result = removeLibraryFolder(board, folder, { recursive: values.recursive === true });
  out(`${green('Deleted')} the folder ${bold(`${result.folder}/`)}`);
  if (result.removed.length) out(dim(`  With ${plural(result.removed.length, 'document')}: ${result.removed.join(', ')}`));
  if (result.referencedBy.length) {
    out(yellow(`  ${result.referencedBy.join(', ')} still reference them. lpm check reports these references.`));
  }
  return 0;
}

function refs(args: string[]): number {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  const id = requireId(positionals, 'lpm library refs <id>');
  const board = requireBoard();
  const ids = libraryReferrers(board, id);
  if (!readLibraryDoc(board.paths, id)) out(yellow(`The library has no document "${id}".`));
  if (!ids.length) {
    out(dim(`No issue or template references library:${id}.`));
    return 0;
  }
  for (const nodeId of ids) {
    const node = [...board.issues, ...board.templates].find((entry) => entry.id === nodeId)!;
    out(`${cyan(node.id)}  ${node.title}`);
  }
  return 0;
}

function remove(args: string[]): number {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  const id = requireId(positionals, 'lpm library rm <id>');
  const board = requireBoard();
  const result = removeLibraryDoc(board, id);
  out(`${green('Deleted')} ${bold(`library:${result.doc.id}`)}  ${result.doc.title}`);
  if (result.referencedBy.length) {
    out(yellow(`  ${result.referencedBy.join(', ')} still reference it. lpm check reports these references.`));
  }
  return 0;
}
