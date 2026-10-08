/**
 * The managed comment — rung 5 of the degradation ladder (LP-278).
 *
 * When the remote body cannot carry the managed block — the remote declares
 * `encoding: comment`, or a body write is refused at runtime — the *same block*
 * is posted as a comment instead.  The comment body **is** the managed block:
 * the same delimiters, the same table, the same id links, so the pull parser
 * (`parseManagedBlock` in `managed-block.ts`) recovers it without knowing
 * whether it arrived in a body or a comment.  The block codec stays
 * carrier-agnostic; this module only adds the comment-shaped wrapper around it.
 *
 * Two facts are the whole of the design:
 *
 *   1. **The comment id lives in the link store** (`LinkEntry.managedCommentId`).
 *      Without it the next push cannot find the comment and posts a second one
 *      — the visible, annoying failure that makes people turn sync off.  The
 *      strategy planner below turns the recorded id plus the comment capability
 *      into exactly one action: post, edit, replace, remove or refuse.
 *   2. **A managed comment is our output, never a human's.**  It is excluded
 *      from comment sync in both directions: the push never re-posts it as a
 *      user comment, and a pull never imports it as one.  `isManagedCommentBody`
 *      is the shared test — by id where the link store knows it, by body where
 *      the id was lost.
 *
 * Pure: no disk, no network, no Node imports — the planners and the web bundle
 * carry it, exactly like `managed-block.ts`.
 */

import {
  parseManagedBlock,
  renderManagedBlock,
  type ManagedBlockEntry,
  type ManagedBlockLinks,
} from './managed-block.js';

// ---------------------------------------------------------------------------
// The comment body
// ---------------------------------------------------------------------------

/**
 * Render the managed comment's body.  It is the managed block itself — the
 * delimiters are what let the next pull recognise and strip it, and they are
 * what let `isManagedCommentBody` tell our comment from a human's.
 */
export function renderManagedComment(
  entries: readonly ManagedBlockEntry[],
  links?: ManagedBlockLinks,
): string {
  return renderManagedBlock(entries, links);
}

/**
 * True when a comment body is a managed comment — one of our own block outputs
 * rather than a human's prose.  The test is the codec's own parse: both
 * delimiters present, begin before end.  Cheap enough for the pull's comment
 * filter, and it degrades to `false` (treat as a human comment) when a human
 * mangled the delimiters, so nothing of ours is ever mistaken for theirs.
 */
export function isManagedCommentBody(body: string): boolean {
  return parseManagedBlock(body).found;
}

// ---------------------------------------------------------------------------
// The strategy
// ---------------------------------------------------------------------------

/**
 * The comment capability, in the shape the strategy planner reads.  Mirror of
 * `CommentSupport` in `capabilities.ts`, re-declared here as plain fields so
 * this module stays import-free of the Node-only capability cache.
 */
export interface ManagedCommentCapability {
  /** The provider holds comments at all. */
  native: boolean;
  /** A posted comment can be edited in place. */
  editable: boolean;
  /** A posted comment can be deleted. */
  deletable: boolean;
}

/** What the next push should do about the managed comment. */
export type ManagedCommentAction =
  /** No entries to write and no comment exists — nothing to do. */
  | { kind: 'none' }
  /** No comment yet: post a new one. */
  | { kind: 'post' }
  /** A comment exists and can be edited: edit it in place. */
  | { kind: 'edit'; commentId: string }
  /** A comment exists, cannot be edited, but can be deleted: delete + repost. */
  | { kind: 'replace'; commentId: string }
  /** Entries went away but the comment remains: delete it. */
  | { kind: 'remove'; commentId: string }
  /** The carrier cannot satisfy the request — report the reason. */
  | { kind: 'unavailable'; reason: string };

/**
 * Decide what one push should do about a document's managed comment, from the
 * recorded comment id, the comment capability, and whether there is anything
 * to write.
 *
 * The rules, in order:
 *
 *   - nothing to write, no comment → `none`;
 *   - nothing to write, a comment exists → `remove` (needs deletion);
 *   - something to write, no comment → `post` (needs comments at all);
 *   - something to write, a comment exists → `edit` when editable, else
 *     `replace` (delete + repost) when deletable, else `unavailable`.
 *
 * A `replace` must delete the old comment first — otherwise the remote accrues
 * one stale comment per push.  A platform that can neither edit nor delete
 * comments can only ever post once, so a change after that is refused rather
 * than silently dropped or duplicated.
 */
export function planManagedComment(
  capability: ManagedCommentCapability,
  existingId: string | undefined,
  hasEntries: boolean,
): ManagedCommentAction {
  if (!hasEntries) {
    if (existingId === undefined) return { kind: 'none' };
    if (!capability.deletable) {
      return { kind: 'unavailable', reason: 'the managed comment is empty and comments cannot be deleted' };
    }
    return { kind: 'remove', commentId: existingId };
  }

  if (existingId === undefined) {
    if (!capability.native) {
      return { kind: 'unavailable', reason: 'the remote holds no comments' };
    }
    return { kind: 'post' };
  }

  if (capability.editable) return { kind: 'edit', commentId: existingId };
  if (capability.deletable) return { kind: 'replace', commentId: existingId };
  return {
    kind: 'unavailable',
    reason: 'the managed comment exists but cannot be edited or deleted',
  };
}
