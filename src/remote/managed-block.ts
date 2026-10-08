/**
 * The managed block codec — both sides of the degradation ladder's rung 4.
 *
 * When a provider cannot hold a field natively — no dependency edge, no second
 * hierarchy level, no custom fields — the value goes into a managed block: a
 * delimited region in the issue body that a human can read and the next pull
 * can parse back.  The block is the sync layer's own output, not the remote's
 * content, which is why it is excluded when the body is hashed for the base
 * snapshot (`stripManagedBlock` in `links.ts`).
 *
 * The write side is `renderManagedBlock` / `applyManagedBlock` (LP-276); the
 * read side is `parseManagedBlock` (LP-277), which recovers the prose and the
 * fields, degrading to "no block" with a warning when a human mangled it.
 *
 * The block is delimited by `<!-- lpm:begin -->` and `<!-- lpm:end -->` and
 * written as a markdown table for human readers.  The parser matches the
 * delimiters, never the markdown — the table is presentation, the delimiters
 * are the contract.
 *
 * ## Idempotence is the point
 *
 * The same fields must produce the same bytes, so:
 *
 *   - entries are sorted by name (code-unit order) before rendering, so the
 *     block is byte-stable whatever order the fields arrive in;
 *   - each id list is sorted the same way;
 *   - nothing inside the block carries a timestamp.  A "last synced" line would
 *     make every push a body change, which would make every pull see a remote
 *     body edit — the loop this whole design exists to prevent.
 *
 * ## Id references
 *
 * A field whose value is a local id (a `parent`, a `depends_on` list) is
 * rendered as a markdown link to its remote twin when the caller supplies the
 * URL, and as the bare local id otherwise.  The local id is the link *text*
 * either way, so the next pull can recover it without knowing anything about
 * the remote's URL scheme.
 *
 * A field whose value is a **remote** reference (the `refs` kind — LP-314's
 * `depends_on` / `relates_to` rows) is rendered as a bare `#418` short
 * reference instead, which the platform itself turns into a clickable link
 * with a free back-reference.  The next pull resolves `418` through the link
 * store, never by parsing the cell back to a local id.
 *
 * Pure: no disk, no network, no Node imports — the planners and the web bundle
 * carry it.  `links.ts` imports these delimiters (the reverse would break the
 * browser build).
 */

// ---------------------------------------------------------------------------
// The block convention
// ---------------------------------------------------------------------------

export const MANAGED_BLOCK_BEGIN = '<!-- lpm:begin -->';
export const MANAGED_BLOCK_END = '<!-- lpm:end -->';

/** The markdown table's header rows, mirroring the LP-255 example. */
const TABLE_HEADER = ['| light-plan | |', '| --- | --- |'];

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * One field the block carries: a name and its value, plus how the value is
 * rendered.
 *
 *   - `text` — a plain scalar (a board type, an attribute value the caller has
 *     already stringified);
 *   - `id`   — a single reference to another local document (a `parent`);
 *   - `ids`  — a list of references to other local documents (`depends_on`,
 *     `relates_to`);
 *   - `refs` — a list of **remote** references, each rendered as a short
 *     `#<id>` reference the platform turns into a clickable link (GitHub's
 *     `#418`) and read back through the link store, never as a local id.
 *
 * Only `id` / `ids` values are rendered as remote links; `refs` values are
 * rendered as `#<id>` references; `text` values are written verbatim.  The
 * value must be single-line — a newline or a `|` inside it would break the
 * table row, and the caller owns that sanitisation.
 */
export type ManagedBlockEntry =
  | { name: string; kind: 'text'; value: string }
  | { name: string; kind: 'id'; value: string }
  | { name: string; kind: 'ids'; value: readonly string[] }
  | { name: string; kind: 'refs'; value: readonly string[] };

/**
 * Local id → the remote twin's URL, for rendering `id` / `ids` entries as
 * clickable links.  Absent (or an unknown id) renders the bare local id, which
 * is what the pull parser reads back.
 */
export type ManagedBlockLinks = ReadonlyMap<string, string>;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** A local id as it appears in a cell: a link when the URL is known, else bare. */
function idCell(id: string, links: ManagedBlockLinks | undefined): string {
  const url = links?.get(id);
  return url !== undefined && url !== '' ? `[${id}](${url})` : id;
}

/** One table row: the field name and its rendered value. */
function renderRow(entry: ManagedBlockEntry, links: ManagedBlockLinks | undefined): string {
  let value: string;
  switch (entry.kind) {
    case 'text':
      value = entry.value;
      break;
    case 'id':
      value = idCell(entry.value, links);
      break;
    case 'ids':
      value = [...entry.value]
        .sort()
        .map((id) => idCell(id, links))
        .join(', ');
      break;
    case 'refs':
      // A remote reference renders as the platform's own short link form
      // (`#418`), which GitHub turns into a clickable link with a free
      // back-reference.  The value is the bare remote id (the issue number),
      // never the local id — a person reading the remote sees the other
      // *remote* issue, and the next pull resolves it through the link store.
      value = [...entry.value].sort().map((id) => `#${id}`).join(', ');
      break;
  }
  return `| ${entry.name} | ${value} |`;
}

/** Stable code-unit order for entry names — locale-independent on purpose. */
function byName(a: ManagedBlockEntry, b: ManagedBlockEntry): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Render the managed block: the delimiters, the table header, and one row per
 * entry.  Entries are sorted by name and each id list is sorted, so the same
 * fields always produce the same bytes.
 *
 * Returns `''` for an empty entry list — an empty block is not a block, and
 * `applyManagedBlock` treats it as "remove any existing block".
 */
export function renderManagedBlock(
  entries: readonly ManagedBlockEntry[],
  links?: ManagedBlockLinks,
): string {
  if (entries.length === 0) return '';

  const rows = [...entries].sort(byName).map((entry) => renderRow(entry, links));
  return [MANAGED_BLOCK_BEGIN, ...TABLE_HEADER, ...rows, MANAGED_BLOCK_END].join('\n');
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

/** The result of locating the block: what sits before and after the delimiters. */
interface ManagedBlockSplit {
  found: boolean;
  before: string;
  after: string;
}

/**
 * Is the marker at `at` **its own line**, rather than mentioned inside a sentence?
 *
 * `renderManagedBlock` always writes the delimiters on lines of their own, so a
 * marker with prose before it on the same line is somebody *talking about* the
 * block, not the block.
 *
 * This is the whole of LP-534. Without it, `splitManagedBlock` matched the first
 * `begin` anywhere in the body — including a document whose own prose describes
 * the delimiters — and everything up to the next `end` was replaced by the block
 * on every push. Five documents on this repository's own board were silently
 * corrupted that way, and because the damage was on the *remote* while the board
 * was untouched, they then sat permanently "to push" with nothing anybody had
 * edited. Every one of those mentions was mid-line, and every real delimiter
 * begins a line, so this one predicate separates them exactly.
 */
function startsLine(body: string, at: number): boolean {
  const lineStart = body.lastIndexOf('\n', at - 1) + 1;
  return body.slice(lineStart, at).trim() === '';
}

/** The first index at or after `from` where `marker` begins a line, or -1. */
function indexOfMarkerLine(body: string, marker: string, from: number): number {
  let at = body.indexOf(marker, from);
  while (at !== -1) {
    if (startsLine(body, at)) return at;
    at = body.indexOf(marker, at + marker.length);
  }
  return -1;
}

/**
 * Locate the block with an explicit delimiter search, never a markdown parser
 * — it has to survive whatever the remote's editor does to the surrounding
 * text.  The block is the first `begin` marker **that begins a line** through
 * the first such `end` marker after it; a stray second block degrades into
 * `after` rather than being lost, and a delimiter mentioned inside a sentence is
 * prose and is left alone (LP-534).
 */
function splitManagedBlock(body: string): ManagedBlockSplit {
  const start = indexOfMarkerLine(body, MANAGED_BLOCK_BEGIN, 0);
  if (start === -1) return { found: false, before: body, after: '' };
  const end = indexOfMarkerLine(body, MANAGED_BLOCK_END, start + MANAGED_BLOCK_BEGIN.length);
  if (end === -1) return { found: false, before: body, after: '' };
  return {
    found: true,
    before: body.slice(0, start),
    after: body.slice(end + MANAGED_BLOCK_END.length),
  };
}

/** Append the block at the end of the body, separated from the prose. */
function appendBlock(body: string, block: string): string {
  const prose = body.trimEnd();
  return prose === '' ? block : `${prose}\n\n${block}`;
}

/** Remove the block, collapsing the whitespace it occupied. */
function removeBlock(before: string, after: string): string {
  const head = before.replace(/\s+$/, '');
  const tail = after.replace(/^\s+/, '');
  if (head === '' && tail === '') return '';
  if (head === '') return tail;
  if (tail === '') return head;
  return `${head}\n\n${tail}`;
}

/**
 * Write the managed block into `body`:
 *
 *   - no existing block, entries present → appended at the end of the body;
 *   - existing block → replaced in place, never appended, so prose a human
 *     wrote above or below it is preserved exactly;
 *   - no entries → any existing block is removed.
 *
 * Idempotent: applying the same entries to the result again produces the same
 * body, because the replacement is in place and the append path only fires
 * when no block exists yet.
 */
export function applyManagedBlock(
  body: string,
  entries: readonly ManagedBlockEntry[],
  links?: ManagedBlockLinks,
): string {
  const block = renderManagedBlock(entries, links);
  const split = splitManagedBlock(body);

  if (!split.found) {
    return block === '' ? body : appendBlock(body, block);
  }
  if (block === '') {
    return removeBlock(split.before, split.after);
  }
  return split.before + block + split.after;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * The result of parsing a managed block back out of a remote body.
 *
 * `fields` holds the raw cell text of each row, trimmed and keyed by field
 * name — links are *not* unwrapped here, because the codec does not know which
 * fields carry references.  `parseManagedId` / `parseManagedIdList` unwrap the
 * `id` / `ids` cells the write side rendered as markdown links.
 */
export interface ManagedBlockParseResult {
  /**
   * Whether a well-formed block (both delimiters, begin before end) was found
   * and stripped.  When false, `body` is the input unchanged and `fields` is
   * empty — the caller should fall back to its base snapshot.
   */
  found: boolean;
  /** The prose with every managed block removed, to store as the local body. */
  body: string;
  /** Field name → the raw cell text (trimmed, links not unwrapped). */
  fields: Record<string, string>;
  /** Non-fatal findings — a mangled block, a duplicate block, an unreadable row. */
  warnings: string[];
}

/**
 * The normalisation pass that lets the delimiters match after a remote
 * reformatted the body on save (Jira's ADF round-trip).  It rewrites `\r\n`
 * and lone `\r` to `\n`; the delimiters are then searched as literal text, so
 * a body already using `\n` is untouched and its prose survives byte for byte.
 */
function normaliseBody(body: string): string {
  return body.replace(/\r\n?/g, '\n');
}

/** One block's span: the begin delimiter's offset, and the offset just past the end. */
interface ManagedBlockSpan {
  start: number;
  end: number;
}

/**
 * Locate every well-formed block in order.  A begin whose matching end would
 * swallow a later begin is a dangling begin — its block was never closed — and
 * is reported rather than merged, so its prose is never wiped.
 */
function scanBlocks(body: string): { spans: ManagedBlockSpan[]; danglingBegin: boolean } {
  const spans: ManagedBlockSpan[] = [];
  let danglingBegin = false;
  let cursor = 0;
  for (;;) {
    // Only a delimiter that **begins a line** is a delimiter (LP-534): the read
    // side has to agree with the write side about that, or a document whose prose
    // mentions the markers is written correctly and then parsed back with its own
    // sentences stripped out — which is the same corruption arriving from the
    // other direction.
    const start = indexOfMarkerLine(body, MANAGED_BLOCK_BEGIN, cursor);
    if (start === -1) return { spans, danglingBegin };
    const end = indexOfMarkerLine(body, MANAGED_BLOCK_END, start + MANAGED_BLOCK_BEGIN.length);
    if (end === -1) return { spans, danglingBegin: true };

    // A begin appearing before this end means `start`'s block was never
    // closed — skip it and let the later begin start the real block.
    const nextBegin = indexOfMarkerLine(body, MANAGED_BLOCK_BEGIN, start + MANAGED_BLOCK_BEGIN.length);
    if (nextBegin !== -1 && nextBegin < end) {
      danglingBegin = true;
      cursor = start + MANAGED_BLOCK_BEGIN.length;
      continue;
    }

    spans.push({ start, end: end + MANAGED_BLOCK_END.length });
    cursor = end + MANAGED_BLOCK_END.length;
  }
}

/**
 * Recover the prose a body holds once every block is removed.  The block's own
 * surrounding whitespace is structural — it was put there by the writer — so a
 * seam collapses to a single blank line, while the body's own edges (leading
 * whitespace of the first piece, trailing of the last) are preserved exactly.
 */
function removeBlocks(body: string, spans: ManagedBlockSpan[]): string {
  const pieces: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    pieces.push(body.slice(cursor, span.start));
    cursor = span.end;
  }
  pieces.push(body.slice(cursor));

  const first = pieces[0]!.replace(/\s+$/, '');
  const last = pieces[pieces.length - 1]!.replace(/^\s+/, '');
  const middle = pieces.slice(1, -1).map((piece) => piece.replace(/^\s+|\s+$/g, ''));

  return [first, ...middle, last].filter((piece) => piece !== '').join('\n\n');
}

/** Split a table row into its trimmed cells; `null` when it is not a row. */
function splitRow(line: string): string[] | null {
  // Strip the row's own pipes (at most one each side) so an empty value cell
  // survives — `| name | |` is a name with an empty value, not a nameless row.
  let text = line;
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|')) text = text.slice(0, -1);
  const cells = text.split('|').map((cell) => cell.trim());
  if (cells.every((cell) => cell === '')) return null;
  return cells;
}

/** True for a markdown table's separator row (`| --- | --- |`). */
function isSeparatorRow(name: string): boolean {
  return /^:?-+:?$/.test(name);
}

/**
 * Parse the block's markdown table into fields.  The writer's shape is known —
 * a title row, a separator row, then one `| name | value |` row per field — but
 * the remote may have damaged it, so this is best-effort: unreadable rows are
 * reported and skipped, never thrown.  Returns the fields and the warnings.
 */
function parseTable(content: string): { fields: Record<string, string>; warnings: string[] } {
  const fields: Record<string, string> = {};
  const warnings: string[] = [];
  let rows = 0;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;

    const cells = splitRow(line);
    if (cells === null || cells.length < 2) {
      warnings.push(`unreadable line in managed block: ${line}`);
      continue;
    }

    const name = cells[0]!;
    const value = cells[1]!;
    if (isSeparatorRow(name)) continue;
    if (name === 'light-plan' && value === '') continue; // the title row
    if (name === '') continue;

    if (Object.prototype.hasOwnProperty.call(fields, name)) {
      warnings.push(`duplicate field "${name}" in managed block; keeping the first`);
      continue;
    }
    fields[name] = value;
    rows += 1;
  }

  if (rows === 0) {
    warnings.push('managed block contained no readable fields');
  }
  return { fields, warnings };
}

/**
 * Parse a managed block back out of a remote body.
 *
 * The delimiters are searched as literal text over the normalised body, never
 * with a markdown parser, so prose a human wrote above and below survives the
 * strip byte for byte (only the block-adjacent whitespace collapses).  The
 * first block wins: a second block is reported, never merged.  A body whose
 * block a human mangled degrades to `found: false` with a warning — the body
 * is returned unchanged, the fields come back empty, and the caller falls back
 * to its base values rather than wiping what it cannot read.
 *
 * Pure: no disk, no network.
 */
export function parseManagedBlock(body: string): ManagedBlockParseResult {
  const normalised = normaliseBody(body);
  const { spans, danglingBegin } = scanBlocks(normalised);

  if (spans.length === 0) {
    const warnings: string[] = [];
    if (danglingBegin) {
      warnings.push(
        'managed block begin marker has no matching end marker; treating the body as plain prose',
      );
    } else if (indexOfMarkerLine(normalised, MANAGED_BLOCK_END, 0) !== -1) {
      warnings.push(
        'managed block end marker has no matching begin marker; treating the body as plain prose',
      );
    }
    return { found: false, body: normalised, fields: {}, warnings };
  }

  const warnings: string[] = [];
  if (spans.length > 1) {
    warnings.push(`found ${spans.length} managed blocks; using the first`);
  }
  if (danglingBegin) {
    warnings.push('a managed block begin marker has no matching end marker; left as prose');
  }

  const first = spans[0]!;
  const content = normalised.slice(
    first.start + MANAGED_BLOCK_BEGIN.length,
    first.end - MANAGED_BLOCK_END.length,
  );
  const parsed = parseTable(content);
  warnings.push(...parsed.warnings);

  return { found: true, body: removeBlocks(normalised, spans), fields: parsed.fields, warnings };
}

/** A cell rendered as a link (`[LP-9](url)`) → its link text; anything else → itself. */
export function parseManagedId(cell: string): string {
  const match = /^\[([^\]]+)\]\([^)]*\)$/.exec(cell);
  return match === null ? cell : match[1]!;
}

/** A comma-separated id-list cell → the bare ids, each link unwrapped. */
export function parseManagedIdList(cell: string): string[] {
  return cell
    .split(',')
    .map((token) => parseManagedId(token.trim()))
    .filter((id) => id !== '');
}

/**
 * A `refs` cell parsed back out of the block, each token classified.
 *
 * The write side renders a same-repo reference as `#418`; the read side here
 * classifies each comma-separated token into:
 *
 *   - `refs`      — `#418` → the bare remote id `418`, resolved through the
 *                   link store by the caller;
 *   - `crossRepo` — `owner/repo#12`, a reference to another repository, which
 *                   is out of scope and left alone;
 *   - `unknown`   — anything else (a bare local id, a markdown link, free
 *                   text a human typed) — reported, never silently resolved.
 *
 * Pure, like the rest of the codec: the caller owns the link store.
 */
export interface ManagedRefParse {
  refs: string[];
  crossRepo: string[];
  unknown: string[];
}

export function parseManagedRefs(cell: string): ManagedRefParse {
  const refs: string[] = [];
  const crossRepo: string[] = [];
  const unknown: string[] = [];

  for (const raw of cell.split(',')) {
    const token = raw.trim();
    if (token === '') continue;

    if (token.startsWith('#')) {
      const id = token.slice(1).trim();
      if (id === '') unknown.push(token);
      else refs.push(id);
    } else if (/^[^\s#/]+\/[^\s#/]+#\S+$/.test(token)) {
      // `owner/repo#12` — a cross-repository reference, recognisable by the
      // `owner/repo` prefix before the `#`. Out of scope: never mangled into
      // a local id.
      crossRepo.push(token);
    } else {
      unknown.push(token);
    }
  }

  return { refs, crossRepo, unknown };
}

/**
 * Build a `refs` entry — a list of remote references rendered as `#<id>`.
 * `remoteIds` are the remote system's own ids (GitHub issue numbers), not
 * local ids: the block must round-trip across boards, and a fresh checkout
 * resolves the number through the link store exactly as it resolves a native
 * edge.
 */
export function refsEntry(name: string, remoteIds: readonly string[]): ManagedBlockEntry {
  return { name, kind: 'refs', value: remoteIds };
}
