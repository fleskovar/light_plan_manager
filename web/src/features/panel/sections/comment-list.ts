import type { CommentDto } from '$shared';

/**
 * Two rules for the comment list, kept out of `Comments.svelte` so they can be
 * tested without a DOM.
 *
 * The component fetches the comments again whenever its `id` prop is read
 * anew, and the issue window re-reads it on each board poll, every five
 * seconds. Without these rules each poll replaced the list and scrolled it
 * to the end, so a reader could not stay on an older comment.
 */

/** True when `next` holds the same comments as `current`, in the same order. */
export function sameComments(current: readonly CommentDto[], next: readonly CommentDto[]): boolean {
  return (
    current.length === next.length &&
    current.every((comment, index) => {
      const other = next[index]!;
      return (
        comment.index === other.index &&
        comment.at === other.at &&
        comment.author === other.author &&
        comment.body === other.body
      );
    })
  );
}

/** The distance from the end, in pixels, that still counts as "at the end". */
export const END_SLACK = 40;

/**
 * True when the list scrolls to its end after the number of comments changes
 * from `previous` to `next`. The list scrolls on the first load, and when a
 * new comment arrives while the reader is at the end. It never moves a
 * reader who scrolled up.
 */
export function followsToEnd(previous: number, next: number, atEnd: boolean): boolean {
  if (next <= previous) return false;
  return previous === 0 || atEnd;
}
