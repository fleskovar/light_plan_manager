/**
 * User-comment sync — the work log and the ticket thread as one conversation
 * (LP-316).
 *
 * Comments are deliberately outside board state: `load.ts` never reads
 * `_comments.md`, `check` ignores it, and the web app writes it straight
 * through rather than queueing.  Comment sync follows that — it is a side
 * channel, not part of the change protocol.
 *
 * Two planners, both pure, both idempotent through the link store:
 *
 *   - `planCommentPush` decides which local log entries to post upstream.  An
 *     entry is posted when its 1-based index is **not** recorded in the link
 *     store's `commentIds` map, and never otherwise — so a comment is posted
 *     exactly once, and re-posting on a later sync is impossible even after a
 *     crash between the post and the record (the record lands with the post,
 *     under the board lock, like every other link-store write).
 *   - `planCommentPull` decides which remote comments to append to the log.  A
 *     remote comment is appended when its id is **not** among the recorded
 *     `commentIds` values, and the managed comment is excluded in both
 *     directions by `isManagedCommentBody` (push) and the caller's
 *     `isManagedComment` (pull) — our own block output is never mistaken for a
 *     human's prose.
 *
 * The pushed body names the local author because the wire API cannot set the
 * comment author on most platforms (GitHub posts as the token): the name is
 * written into the body so it survives the trip.  The pulled comment keeps the
 * remote author and timestamp verbatim in the `_comments.md` heading.
 *
 * A comment edited or deleted upstream is deliberately **not** rewritten
 * locally: the log is append-only by design, and `commentIds` records only
 * "this local comment is that remote comment", never the reverse rewrite.
 *
 * Pure: no disk, no network, no Node imports — carried by the planners and the
 * web bundle exactly like `managed-block.ts`.
 */

import { isManagedCommentBody } from './managed-comment.js';
import type { RemoteComment } from './provider.js';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * One local log entry, as `storage/comments.ts` reads it.  Declared here
 * (rather than imported) because that module imports `node:fs` and would drag
 * Node into the browser bundle; the shapes are structurally identical.
 */
export interface LocalComment {
  /** 1-based position in `_comments.md`, which is also the order it was written. */
  index: number;
  /** ISO timestamp. */
  at: string;
  author: string;
  body: string;
}

/** A local comment the push should post upstream. */
export interface CommentPushItem {
  index: number;
  at: string;
  author: string;
  body: string;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render a local comment's body for posting upstream, naming the local author.
 *
 * The author is written into the body because most comment APIs post as the
 * authenticated account and cannot set an author; naming them in the body is
 * the one way the name survives.  The `(light-plan)` tag marks the comment as
 * ours for a human reading the remote thread — it is never used as a filter,
 * because the link store's `commentIds` is the authority on what is already
 * synced.
 */
export function renderCommentForRemote(author: string, body: string): string {
  return `**${author}** (light-plan)\n\n${body}`;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * The local comments a push should post upstream: every entry whose index is
 * not already recorded in the link store, minus the managed comment (our own
 * block output, which never belongs in the human thread and is recognised by
 * body rather than index).
 */
export function planCommentPush(
  local: readonly LocalComment[],
  synced: ReadonlySet<number>,
): CommentPushItem[] {
  const items: CommentPushItem[] = [];
  for (const comment of local) {
    if (synced.has(comment.index)) continue;
    if (isManagedCommentBody(comment.body)) continue;
    items.push({ index: comment.index, at: comment.at, author: comment.author, body: comment.body });
  }
  return items;
}

/**
 * The remote comments a pull should append to `_comments.md`: every comment
 * whose id is not already recorded, minus the managed comment.  `isManaged` is
 * the caller's `isManagedComment(store, localId, id, body)` — known by id where
 * the link store records the managed comment, by body where the id was lost —
 * so our own block output never reappears as a user comment.
 *
 * The order is the remote's own (oldest first), so an appended thread reads in
 * the order it was written.
 */
export function planCommentPull(
  remote: readonly RemoteComment[],
  synced: ReadonlySet<string>,
  isManaged: (id: string, body: string) => boolean,
): RemoteComment[] {
  return remote.filter((comment) => !synced.has(comment.id) && !isManaged(comment.id, comment.body));
}
