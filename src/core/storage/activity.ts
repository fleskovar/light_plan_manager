/**
 * Activity section codec — pure text in, text out.
 *
 * An activity section is a delimited block at the end of an issue body that
 * records flag raise, clear and auto-clear events. It looks like this:
 *
 * ```
 * <!-- lpm:activity -->
 *
 * ## Activity
 *
 * ### 2026-08-10T14:03:11.000Z — fran — flagged: blocked
 *
 * Waiting on the API contract from LP-12.
 * ```
 *
 * The marker is the seam: everything before it is the prose (editable body
 * content); everything from the marker to EOF is the activity section.
 *
 * This module has no I/O and imports nothing beyond what pure text handling
 * needs. It sits beside `comments.ts` in `src/core/storage/` because both
 * answer the same question — "how do we record a timestamped note against a
 * document?" — and they agree on the answer: append to a plain-text block so
 * git merges it without conflict.
 */
export const ACTIVITY_MARKER = '<!-- lpm:activity -->';

const ACTIVITY_HEADING = '## Activity';

/**
 * An entry heading strict enough that prose cannot be mistaken for one: the
 * timestamp has to come first, followed by an em-dash, the author, another
 * em-dash, and the event label.  Anything else after a `###` in the body is
 * left alone.
 */
const ENTRY_HEADING = /^###[ \t]+(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)[ \t]+—[ \t]+(.+?)[ \t]+—[ \t]+(.+)$/;

export interface ActivityEntry {
  /** ISO timestamp. */
  at: string;
  author: string;
  /** Event label, e.g. "flagged: blocked", "flag cleared". */
  heading: string;
  /** Entry body (optional prose under the heading line). */
  text: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Split `body` at the first activity marker.
 *
 * Returns `prose` (everything before the marker) and `activity` (the marker
 * through EOF).  When there is no marker, `prose` is the entire body and
 * `activity` is empty.
 *
 * A second marker appearing later in the body — hand-written or from a merge —
 * stays inside `activity` verbatim (degraded, never lossy).
 */
export function splitActivity(body: string): { prose: string; activity: string } {
  const idx = body.indexOf(ACTIVITY_MARKER);
  if (idx === -1) return { prose: body, activity: '' };

  // Slice at the marker so `activity` includes the marker line itself.
  return {
    prose: body.slice(0, idx).trimEnd(),
    activity: body.slice(idx),
  };
}

/**
 * Append an activity entry to `body`, creating the marker and section heading
 * when they are absent.
 *
 * The entry's `heading` is the event label (e.g. "flagged: blocked"), rendered
 * as a level-3 heading with the timestamp and author before it.
 */
export function appendActivityEntry(
  body: string,
  entry: { at: string; author: string; heading: string; text: string },
): string {
  let formatted = `\n### ${entry.at} — ${entry.author} — ${entry.heading}\n`;
  if (entry.text.trim()) formatted += `\n${entry.text.trim()}\n`;

  const { prose, activity } = splitActivity(body);

  if (activity) {
    // Append to the existing section.
    return prose + '\n' + activity.trimEnd() + formatted;
  }

  // Create the section.
  const markerBlock = `\n\n${ACTIVITY_MARKER}\n\n${ACTIVITY_HEADING}\n`;
  return prose.trimEnd() + markerBlock + formatted;
}

/**
 * Merge an incoming body edit with the on-disk body so a stale body write
 * cannot clobber the activity section.
 *
 * Rule: the incoming body's own activity section (if any) is discarded; the
 * disk's activity section is re-attached to the incoming prose.  This is the
 * anti-clobber primitive — whatever a stale edit carries in its own activity
 * section is replaced by disk truth.
 */
export function mergeActivity(incomingBody: string, diskBody: string): string {
  const incoming = splitActivity(incomingBody);
  const disk = splitActivity(diskBody);

  if (!disk.activity) return incomingBody;

  return incoming.prose.trimEnd() + '\n' + disk.activity;
}

/**
 * Parse an activity section body (the part after the marker and heading) into
 * individual entries.  Used by tests and by anything that needs to inspect
 * history.
 */
export function parseActivity(body: string): ActivityEntry[] {
  const { activity } = splitActivity(body);
  if (!activity) return [];

  const entries: ActivityEntry[] = [];
  let current: ActivityEntry | null = null;
  const lines: string[] = [];

  const flush = (): void => {
    if (!current) return;
    current.text = lines.join('\n').trim();
    entries.push(current);
    lines.length = 0;
  };

  for (const line of activity.split(/\r?\n/)) {
    const match = ENTRY_HEADING.exec(line);
    if (match) {
      flush();
      current = {
        at: match[1]!,
        author: match[2]!.trim(),
        heading: match[3]!.trim(),
        text: '',
      };
      continue;
    }
    if (current) lines.push(line);
  }
  flush();

  return entries;
}
