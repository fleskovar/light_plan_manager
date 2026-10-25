import type { LoadedBoard } from '../board/load.js';
import { BoardError, ConflictError } from '../errors.js';
import type { LibraryDoc } from '../storage/library.js';
import {
  deleteLibraryDoc,
  libraryDocExists,
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
  /** Each document that moved, with its old and its new id, sorted by the old id. */
  moved: { from: string; to: string }[];
  /** The issues and templates whose references the move rewrote. */
  rewritten: string[];
  /** The issues and templates that still reference an old id, because `updateReferences` was false. */
  stale: string[];
}

/**
 * The documents that `from` names, each with its new id below `to`.
 *
 * `from` names one document when the library holds `<from>.md`. Otherwise it
 * names a folder, and every document below `<from>/` moves to the same place
 * below `<to>/`: `prompts/review` in the folder `prompts` becomes
 * `agent-prompts/review`.
 */
function planMoves(board: LoadedBoard, from: string, to: string): Map<string, string> {
  if (libraryDocExists(board.paths, from)) return new Map([[from, to]]);
  const prefix = `${from}/`;
  const inside = listLibraryDocs(board.paths).filter((doc) => doc.id.startsWith(prefix));
  if (!inside.length) {
    throw new BoardError(`The library has no document and no folder "${from}"`, ['`lpm library` lists the documents.']);
  }
  if (to.startsWith(prefix)) {
    throw new BoardError(`A folder cannot move into itself: "${to}" is inside "${from}"`);
  }
  const moves = new Map<string, string>();
  for (const doc of inside) {
    const next = normalizeLibraryId(`${to}/${doc.id.slice(prefix.length)}`);
    if (next === null) {
      throw new BoardError(`"${to}/${doc.id.slice(prefix.length)}" is not a valid library id`, [
        'An id has 8 parts at most.',
      ]);
    }
    moves.set(doc.id, next);
  }
  return moves;
}

/**
 * Rename a library document, or move a folder of documents, and rewrite the
 * references to them.
 *
 * The operation checks everything before it changes anything: no document
 * may have a new id already, and no issue or template whose references it
 * rewrites may have changed on disk since the board was read. Then it renames
 * the files and rewrites the `library:` entries of `related_files` and the
 * `[label](library:<id>)` links of the bodies through `updateNode`. All of it
 * runs in one board write, so a board that `git_sync` shares gets one commit.
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
  return boardWrite(board, `move library document ${from} to ${to}`, () => {
    const moves = planMoves(board, from, to);
    // A new id is never an old id: a single move has `from !== to`, and a
    // folder move refuses a target inside the folder.
    const taken = [...moves.values()].filter((id) => libraryDocExists(board.paths, id));
    if (taken.length) {
      throw new BoardError(`The library already has a document "${taken[0]}"`, [
        'Pick another id, or delete that document first.',
      ]);
    }

    const referrers = [...board.issues, ...board.templates].filter((node) =>
      libraryRefsOf(node).some((id) => moves.has(id)),
    );
    const update = options.updateReferences !== false;
    if (update) for (const node of referrers) requireUnchanged(board, node);

    for (const [old, next] of moves) {
      renameLibraryDocFile(board.paths, old, next);
    }

    const rewritten: string[] = [];
    if (update) {
      for (const node of referrers) {
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
    }

    return {
      moved: [...moves].map(([old, next]) => ({ from: old, to: next })).sort((a, b) => a.from.localeCompare(b.from)),
      rewritten,
      stale: update ? [] : referrers.map((node) => node.id),
    };
  });
}

/** The ids of the issues and templates that reference the library document `id`. */
export function libraryReferrers(board: LoadedBoard, id: string): string[] {
  const normal = requireLibraryId(id);
  return [...board.issues, ...board.templates]
    .filter((node) => libraryRefsOf(node).includes(normal))
    .map((node) => node.id);
}

