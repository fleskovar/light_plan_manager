/**
 * The rule for the ids of the board library, shared by the engine and the
 * browser. This module imports nothing, so `src/core` may import it.
 *
 * A library document is the file `.lpm/library/<id>.md`. The id is the path
 * below the library folder without `.md`, with `/` between folders. Each part
 * holds lowercase letters, digits, `-`, `_` and `.`, starts with a letter or a
 * digit, and does not end with `.`. An id has 8 parts at most.
 *
 * A reference to a document is the text `library:<id>`, in `related_files` or
 * as the target of a markdown link in a body.
 */
export const LIBRARY_REF_PREFIX = 'library:';

const SEGMENT_RE = /^[a-z0-9][a-z0-9._-]*$/;
/** The largest number of parts in an id. */
export const LIBRARY_MAX_DEPTH = 8;

/**
 * The id that `raw` names, in its normal form, or null when `raw` names no
 * valid id. The function accepts a leading `library:`, a trailing `.md`,
 * backslashes, capitals and slashes at either end.
 */
export function normalizeLibraryId(raw: string): string | null {
  let text = raw.trim();
  if (text.toLowerCase().startsWith(LIBRARY_REF_PREFIX)) text = text.slice(LIBRARY_REF_PREFIX.length);
  text = text.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
  if (text.endsWith('.md')) text = text.slice(0, -'.md'.length);
  const parts = text.split('/');
  if (!text || parts.length > LIBRARY_MAX_DEPTH) return null;
  if (!parts.every((part) => SEGMENT_RE.test(part) && !part.endsWith('.'))) return null;
  return parts.join('/');
}

/** True when the text starts with `library:`, whether or not the id after it is valid. */
export function isLibraryRef(ref: string): boolean {
  return ref.trim().toLowerCase().startsWith(LIBRARY_REF_PREFIX);
}

/** The id that a reference names, or null when the text is not a valid `library:` reference. */
export function parseLibraryRef(ref: string): string | null {
  return isLibraryRef(ref) ? normalizeLibraryId(ref) : null;
}

/** The reference text for an id: `library:<id>`. */
export function libraryRef(id: string): string {
  return `${LIBRARY_REF_PREFIX}${id}`;
}
