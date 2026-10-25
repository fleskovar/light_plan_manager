import type { LoadedBoard } from '../board/load.js';
import { BoardError, ConflictError } from '../errors.js';
import type { AnyNode } from '../model/types.js';
import type { LibraryDoc } from '../storage/library.js';
import {
  deleteLibraryDoc,
  deleteLibraryFolder,
  ensureLibraryFolder,
  libraryDocExists,
  libraryFolderExists,
  listLibraryFolders,
  renameLibraryFolder,
  libraryRefsOf,
  listLibraryDocs,
  normalizeLibraryId,
  readLibraryDoc,
  renameLibraryDocFile,
  requireLibraryId,
  rewriteLibraryLinks,
  rewriteLibraryRef,
  writeLibraryDoc,
} from '../storage/library.js';
import { boardWrite, requireUnchanged } from './shared.js';
import { updateNode } from './update.js';

/**
 * Writing the board library: `.lpm/library/<id>.md`.
 *
 * Each write runs under `boardWrite`, so it takes the board lock, and on a
 * board shared through git it commits and pushes the file, exactly as a write
 * to an issue does. `storage/library.ts` holds the file format and the id
 * rule.
 *
 * A library document is not a node of the board, so a write validates the id
 * and the revision only. A reference to a document that does not exist does
 * not make a board invalid: `check` reports it as a warning.
 */
export interface CreateLibraryDocInput {
  id: string;
  title?: string;
  description?: string;
  body?: string;
}

export interface UpdateLibraryDocInput {
  title?: string;
  description?: string;
  body?: string;
  /**
   * The revision that the caller read (`LibraryDoc.revision`). When the file
   * holds another revision, the update fails with a `ConflictError` and writes
   * nothing. Without it, the update writes over the file.
   */
  revision?: string;
}

export function createLibraryDoc(board: LoadedBoard, input: CreateLibraryDocInput): LibraryDoc {
  const id = requireLibraryId(input.id);
  return boardWrite(board, `add library document ${id}`, () => {
    if (libraryDocExists(board.paths, id)) {
      throw new BoardError(`The library already has a document "${id}"`, [
        `\`lpm library set ${id}\` changes it.`,
      ]);
    }
    writeLibraryDoc(board.paths, id, {
      title: input.title,
      description: input.description,
      body: input.body ?? '',
    });
    return readLibraryDoc(board.paths, id)!;
  });
}

function requireDoc(board: LoadedBoard, id: string): LibraryDoc {
  const doc = readLibraryDoc(board.paths, id);
  if (!doc) {
    throw new BoardError(`The library has no document "${id}"`, ['`lpm library` lists the documents.']);
  }
  return doc;
}

export function updateLibraryDoc(board: LoadedBoard, rawId: string, input: UpdateLibraryDocInput): LibraryDoc {
  const id = requireLibraryId(rawId);
  return boardWrite(board, `edit library document ${id}`, () => {
    const current = requireDoc(board, id);
    if (input.revision !== undefined && input.revision !== current.revision) {
      throw new ConflictError(`The library document ${id} changed on disk while you were editing it`, [
        'Read the document again, then make the change again.',
      ]);
    }
    writeLibraryDoc(board.paths, id, {
      // A title that came from the first heading stays out of the frontmatter.
      title: input.title ?? (current.titled ? current.title : undefined),
      description: input.description ?? current.description,
      body: input.body ?? current.body,
      extra: current.extra,
    });
    return readLibraryDoc(board.paths, id)!;
  });
}

export interface RemoveLibraryDocResult {
  doc: LibraryDoc;
  /** The issues and templates that still reference the document. Their references now point at nothing. */
  referencedBy: string[];
}

export function removeLibraryDoc(board: LoadedBoard, rawId: string): RemoveLibraryDocResult {
  const id = requireLibraryId(rawId);
  return boardWrite(board, `delete library document ${id}`, () => {
    const doc = requireDoc(board, id);
    deleteLibraryDoc(board.paths, id);
    return { doc, referencedBy: libraryReferrers(board, id) };
  });
}

export interface MoveLibraryDocOptions {
  /**
   * Rewrite the references of the issues and templates to the new ids. The
   * default is true. With false, the references keep the old ids, and `check`
   * reports them.
   */
  updateReferences?: boolean;
}

export interface MoveLibraryDocResult {
  /** `document` when the first id named a document, `folder` when it named a folder. */
  kind: 'document' | 'folder';
  /** Each document that moved, with its old and its new id, sorted by the old id. */
  moved: { from: string; to: string }[];
  /** The issues and templates whose references the move rewrote. */
  rewritten: string[];
  /** The issues and templates that still reference an old id, because `updateReferences` was false. */
  stale: string[];
}

/** The new path of `below`, a path inside the folder `from`, when `from` becomes `to`. Null when it breaks the id rule. */
function moveInto(below: string, from: string, to: string): string | null {
  return normalizeLibraryId(`${to}/${below.slice(from.length + 1)}`);
}

/**
 * What `from` names, and the new id of each document that moves.
 *
 * `from` names one document when the library holds `<from>.md`. Otherwise it
 * names a folder, and every document and folder below `<from>/` moves to the
 * same place below `<to>/`: `prompts/review` becomes `agent-prompts/review`.
 * A folder can be empty.
 */
function planMoves(
  board: LoadedBoard,
  from: string,
  to: string,
): { kind: 'document' | 'folder'; moves: Map<string, string> } {
  if (libraryDocExists(board.paths, from)) {
    if (libraryDocExists(board.paths, to)) {
      throw new BoardError(`The library already has a document "${to}"`, [
        'Pick another id, or delete that document first.',
      ]);
    }
    return { kind: 'document', moves: new Map([[from, to]]) };
  }
  if (!libraryFolderExists(board.paths, from)) {
    throw new BoardError(`The library has no document and no folder "${from}"`, [
      '`lpm library tree` lists them.',
    ]);
  }
  const prefix = `${from}/`;
  if (to.startsWith(prefix)) {
    throw new BoardError(`A folder cannot move into itself: "${to}" is inside "${from}"`);
  }
  if (libraryFolderExists(board.paths, to)) {
    throw new BoardError(`The library already has a folder "${to}"`, [
      'Pick another name, or move the documents into that folder one by one.',
    ]);
  }
  for (const folder of listLibraryFolders(board.paths).filter((entry) => entry.startsWith(prefix))) {
    if (moveInto(folder, from, to) === null) {
      throw new BoardError(`"${to}/${folder.slice(prefix.length)}" is not a valid library folder`, [
        'A path has 8 parts at most.',
      ]);
    }
  }
  const moves = new Map<string, string>();
  for (const doc of listLibraryDocs(board.paths).filter((entry) => entry.id.startsWith(prefix))) {
    const next = moveInto(doc.id, from, to);
    if (next === null) {
      throw new BoardError(`"${to}/${doc.id.slice(prefix.length)}" is not a valid library id`, [
        'An id has 8 parts at most.',
      ]);
    }
    moves.set(doc.id, next);
  }
  return { kind: 'folder', moves };
}

/** The issues and templates that reference one of `ids`. */
function referrersOf(board: LoadedBoard, ids: { has(id: string): boolean }): AnyNode[] {
  return [...board.issues, ...board.templates].filter((node) => libraryRefsOf(node).some((id) => ids.has(id)));
}

/**
 * Rewrite the references of the issues and templates through `moves`, which
 * maps an old id to a new id. The caller checked with `requireUnchanged` that
 * each of them is unchanged on disk.
 */
function rewriteReferences(board: LoadedBoard, referrers: AnyNode[], moves: ReadonlyMap<string, string>): string[] {
  const rewritten: string[] = [];
  for (const node of referrers) {
    if (node.kind !== 'issue' && node.kind !== 'template') continue;
    const relatedFiles = node.related_files.map((ref) => rewriteLibraryRef(ref, moves));
    const body = rewriteLibraryLinks(node.body, moves);
    const filesChanged = relatedFiles.some((ref, at) => ref !== node.related_files[at]);
    const bodyChanged = body !== node.body;
    if (!filesChanged && !bodyChanged) continue;
    updateNode(board, node, {
      ...(filesChanged ? { relatedFiles } : {}),
      ...(bodyChanged ? { body } : {}),
    });
    rewritten.push(node.id);
  }
  return rewritten;
}

/**
 * Rename a library document, or move a folder with everything inside it, and
 * rewrite the references to the documents that moved.
 *
 * The operation checks everything before it changes anything: the new id or
 * folder must be free, a folder cannot move into itself, and no issue or
 * template whose references it rewrites may have changed on disk since the
 * board was read. Then it renames the file or the folder, and rewrites the
 * `library:` entries of `related_files` and the `[label](library:<id>)` links
 * of the bodies through `updateNode`. All of it runs in one board write, so a
 * board that `git_sync` shares gets one commit.
 */
export function moveLibraryDoc(
  board: LoadedBoard,
  rawFrom: string,
  rawTo: string,
  options: MoveLibraryDocOptions = {},
): MoveLibraryDocResult {
  const from = requireLibraryId(rawFrom);
  const to = requireLibraryId(rawTo);
  if (from === to) throw new BoardError(`"${from}" already has this id`);
  return boardWrite(board, `move library ${from} to ${to}`, () => {
    const { kind, moves } = planMoves(board, from, to);
    const referrers = referrersOf(board, moves);
    const update = options.updateReferences !== false;
    if (update) for (const node of referrers) requireUnchanged(board, node);

    if (kind === 'document') renameLibraryDocFile(board.paths, from, to);
    else renameLibraryFolder(board.paths, from, to);

    return {
      kind,
      moved: [...moves].map(([old, next]) => ({ from: old, to: next })).sort((a, b) => a.from.localeCompare(b.from)),
      rewritten: update ? rewriteReferences(board, referrers, moves) : [],
      stale: update ? [] : referrers.map((node) => node.id),
    };
  });
}

/**
 * Create a folder in the library, and each folder above it. Each new folder
 * holds `.gitkeep`, so it stays in git while it holds no document.
 */
export function createLibraryFolder(board: LoadedBoard, rawFolder: string): string {
  const folder = requireLibraryId(rawFolder);
  return boardWrite(board, `add library folder ${folder}`, () => {
    if (libraryFolderExists(board.paths, folder)) {
      throw new BoardError(`The library already has a folder "${folder}"`);
    }
    ensureLibraryFolder(board.paths, folder);
    return folder;
  });
}

export interface RemoveLibraryFolderResult {
  folder: string;
  /** The documents that the delete removed, sorted by id. */
  removed: string[];
  /** The issues and templates that still reference a removed document. */
  referencedBy: string[];
}

/**
 * Delete a folder of the library. A folder that holds documents, also in a
 * folder below it, is refused unless `recursive` is true. Then every document
 * below the folder goes too, and the answer names the issues and templates
 * that still reference one of them.
 */
export function removeLibraryFolder(
  board: LoadedBoard,
  rawFolder: string,
  options: { recursive?: boolean } = {},
): RemoveLibraryFolderResult {
  const folder = requireLibraryId(rawFolder);
  return boardWrite(board, `delete library folder ${folder}`, () => {
    if (!libraryFolderExists(board.paths, folder)) {
      throw new BoardError(`The library has no folder "${folder}"`, ['`lpm library tree` lists the folders.']);
    }
    const prefix = `${folder}/`;
    const removed = listLibraryDocs(board.paths)
      .map((doc) => doc.id)
      .filter((id) => id.startsWith(prefix));
    if (removed.length && !options.recursive) {
      const count = removed.length === 1 ? '1 document' : `${removed.length} documents`;
      throw new BoardError(`The folder "${folder}" holds ${count}`, [
        'Move them out first, or delete the folder with everything inside it (lpm library rmdir -r).',
      ]);
    }
    deleteLibraryFolder(board.paths, folder);
    const referencedBy = referrersOf(board, new Set(removed)).map((node) => node.id);
    return { folder, removed, referencedBy };
  });
}

/** The ids of the issues and templates that reference the library document `id`. */
export function libraryReferrers(board: LoadedBoard, id: string): string[] {
  const normal = requireLibraryId(id);
  return [...board.issues, ...board.templates]
    .filter((node) => libraryRefsOf(node).includes(normal))
    .map((node) => node.id);
}

