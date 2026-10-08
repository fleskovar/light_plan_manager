import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomic.js';

/**
 * The work log on a document.
 *
 * Comments live in a `_comments.md` beside the document's own file, as a flat
 * append-only list. That shape is chosen for the two things that actually
 * happen to them: an agent or a person adds one at the end, and two people do
 * that on different branches. Appends merge; a growing YAML list in the
 * frontmatter would not, and it would push the fields anyone reads down the
 * page.
 *
 * `load.ts` only ever opens `_issue.md` / `_period.md` / `_resource.md`, and it
 * only walks directories, so an extra file here is invisible to the engine.
 * Comments are read on demand rather than with the board.
 */
export const COMMENTS_FILE = '_comments.md';

export interface Comment {
  /** 1-based position in the file, which is also the order it was written. */
  index: number;
  /** ISO timestamp. */
  at: string;
  author: string;
  body: string;
}

/**
 * A heading strict enough that prose cannot be mistaken for it: the timestamp
 * has to come first. Anything else in the body is left alone.
 */
const HEADING = /^##[ \t]+(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)[ \t]+—[ \t]+(.*)$/;

export function commentsFile(dir: string): string {
  return path.join(dir, COMMENTS_FILE);
}

function formatEntry(comment: { at: string; author: string; body: string }): string {
  return `## ${comment.at} — ${comment.author}\n\n${comment.body.trim()}\n`;
}

/** Read a document's comments, oldest first. A missing file means none. */
export function readComments(dir: string): Comment[] {
  const file = commentsFile(dir);
  if (!existsSync(file)) return [];

  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }

  const comments: Comment[] = [];
  let current: Comment | null = null;
  const lines: string[] = [];

  const flush = (): void => {
    if (!current) return;
    current.body = lines.join('\n').trim();
    comments.push(current);
    lines.length = 0;
  };

  for (const line of raw.split(/\r?\n/)) {
    const match = HEADING.exec(line);
    if (match) {
      flush();
      current = {
        index: comments.length + 1,
        at: match[1]!,
        author: match[2]!.trim(),
        body: '',
      };
      continue;
    }
    if (current) lines.push(line);
  }
  flush();

  return comments;
}

/** Append one comment, creating the file if this is the first. */
export function appendComment(
  dir: string,
  comment: { at: string; author: string; body: string },
): void {
  const file = commentsFile(dir);
  const entry = formatEntry(comment);
  if (existsSync(file)) appendFileSync(file, `\n${entry}`, 'utf8');
  else writeFileSync(file, entry, 'utf8');
}

/**
 * Rewrite the whole log. Used to delete one entry; nothing else needs it.
 *
 * Atomic, unlike the append above: this one replaces the file, so a reader
 * catching it mid-write would see a truncated log rather than a shorter one.
 */
export function writeComments(dir: string, comments: Comment[]): void {
  writeFileAtomic(commentsFile(dir), comments.map(formatEntry).join('\n'));
}
