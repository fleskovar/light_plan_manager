import type { LoadedBoard } from '../board/load.js';
import { findNode } from '../board/query.js';
import { BoardError } from '../errors.js';
import type { AnyNode } from '../model/types.js';
import type { Comment } from '../storage/comments.js';
import { appendComment, readComments, writeComments } from '../storage/comments.js';
import { nowIso } from '../storage/document.js';
import { gitIdentity } from '../storage/git.js';
import { boardWrite } from './shared.js';

/**
 * Commenting on a document.
 *
 * The narrative half of a board: what was tried, what broke, what a reviewer
 * asked for. Kept separate from the document's own body, which describes what
 * the work *is* rather than how it went — and separate from the frontmatter,
 * which is the part tools read.
 *
 * Nothing here validates the board, because a comment cannot make one invalid.
 */
export interface CommentInput {
  body: string;
  /** Defaults to the git identity of the checkout. */
  author?: string;
  /** Defaults to now. Accepted so an importer can preserve history. */
  at?: string;
}

export interface CommentResult {
  node: AnyNode;
  comment: Comment;
  /** How many the document has now. */
  total: number;
}

function requireNode(board: LoadedBoard, id: string): AnyNode {
  const node = findNode(board, id);
  if (!node) throw new BoardError(`No issue, period or resource with id "${id}"`);
  return node;
}

export function addComment(
  board: LoadedBoard,
  id: string,
  input: CommentInput,
): CommentResult {
  return boardWrite(board, `comment on ${id}`, () => {
    const body = input.body.trim();
    if (!body) throw new BoardError('A comment cannot be empty');

    const node = requireNode(board, id);
    const at = input.at ?? nowIso();
    const author = input.author?.trim() || gitIdentity(board.paths.lpmDir) || 'unknown';

    appendComment(node.dir, { at, author, body });
    const comments = readComments(node.dir);
    return { node, comment: comments.at(-1)!, total: comments.length };
  });
}

export function listComments(board: LoadedBoard, id: string): Comment[] {
  return readComments(requireNode(board, id).dir);
}

/** Delete one comment by its position. Numbering starts at 1. */
export function removeComment(board: LoadedBoard, id: string, index: number): Comment {
  // Read-modify-write of the whole log: two deletions racing would each rewrite
  // the file from the list they read, and one of the two would come back.
  return boardWrite(board, `delete a comment on ${id}`, () => {
    const node = requireNode(board, id);
    const comments = readComments(node.dir);
    const target = comments.find((comment) => comment.index === index);
    if (!target) {
      throw new BoardError(`${id} has no comment ${index}`, [
        comments.length ? `It has ${comments.length}.` : 'It has none.',
      ]);
    }
    writeComments(
      node.dir,
      comments.filter((comment) => comment.index !== index),
    );
    return target;
  });
}
