/**
 * Markdown ↔ Atlassian Document Format (ADF), hand-rolled and dependency-free.
 *
 * This is the production form of the LP-322 spike;
 * LP-323 wires it into the Jira provider. Jira Cloud's v3 API returns an
 * issue's `description` as a structured ADF document — a JSON tree — not as
 * markdown or plain text. Every sync therefore converts:
 *
 *   push  markdown → ADF   (`markdownToAdf`)
 *   pull  ADF → markdown   (`adfToMarkdown`)
 *
 * ## The contract: a stable fixed point
 *
 * The property that keeps a sync from rewriting every description on every run
 * is *idempotence*: `adfToMarkdown(markdownToAdf(x))` must equal
 * `adfToMarkdown(markdownToAdf(adfToMarkdown(markdownToAdf(x))))` — convert
 * once, then convert again, and the second pass equals the first. Soft line
 * breaks inside a paragraph have no ADF representation, so they collapse on
 * the first pass and must stay collapsed on every pass after; byte-preserving a
 * human's original wrapping is *not* the target. The base snapshot is taken
 * from the issue as Jira stored it, absorbing that normalisation once.
 *
 * ## The subset, and what happens outside it
 *
 * The converter owns exactly what light-plan's templates emit: headings,
 * paragraphs, bold/italic/code/strike/links, bullet/ordered/task lists, tables,
 * code blocks, block quotes, rules and hard breaks. Task-list checkboxes
 * survive via ADF's `taskItem` state (`TODO` / `DONE`).
 *
 * A node *outside* that subset — a panel, a status lozenge, an embedded card a
 * human wrote in Jira's editor — must not be destroyed by the round trip. Two
 * mechanisms carry it, and neither flattens it:
 *
 *   - an unknown **block** node is emitted as a ` ```lpm-adf ` fenced block
 *     holding the node's JSON, and `markdownToAdf` decodes that fence back into
 *     the exact same node;
 *   - an unknown **inline** node, or a text run carrying a mark the converter
 *     does not own, is emitted as `[<plain text>](lpm-adf:<base64url>)`, and
 *     the inline parser decodes the payload back into the exact same node.
 *
 * The `lpm-adf:` namespace is reserved: a human writing a fence of that
 * language, or a link with that scheme, is handing the converter a raw ADF
 * node and accepts that it is parsed, not rendered.
 *
 * ## The floor
 *
 * `adfToPlainText` is the one-way floor the epic reserves for a body the
 * converter cannot round-trip faithfully: extract readable text, never claim
 * fidelity. `adfHasUnknownNodes` tells a caller which bodies that is, so the
 * sync layer can mark them **remote-owned** rather than flatten them. The
 * primary path is the lossless round trip above; the floor is the fallback,
 * never the default.
 *
 * Pure: no imports, no disk, no network — it compiles for Node and for the
 * browser exactly like the other rule modules in this folder.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** One ADF mark (formatting applied to a text run): `code`, `em`, `strong`, … */
export interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

/** One ADF node — a block, an inline node, or a text leaf. */
export interface AdfNode {
  type: string;
  content?: AdfNode[];
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: AdfMark[];
}

/** The root of an ADF document, the shape Jira's v3 `description` holds. */
export interface AdfDocument {
  version: 1;
  type: 'doc';
  content: AdfNode[];
}

/** Block node types the converter emits and reads back. */
const KNOWN_BLOCK_TYPES = new Set([
  'doc',
  'paragraph',
  'heading',
  'rule',
  'blockquote',
  'codeBlock',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
]);

/** Inline node types the converter emits and reads back. */
const KNOWN_INLINE_TYPES = new Set(['text', 'hardBreak']);

/** Mark types the converter emits and reads back. */
const KNOWN_MARK_TYPES = new Set(['code', 'em', 'strong', 'strike', 'link']);

/**
 * Marks ADF refuses to combine with `code`.
 *
 * The `code` mark is exclusive: a text node carrying it may also carry `link`
 * and nothing else. Markdown has no such rule — ``**`lpm remote add`**`` is
 * ordinary, and this repository's own issues are full of it — so a naive
 * conversion produces `marks: [code, strong]`, and Jira rejects the *whole
 * description* as "not valid Atlassian Document Format content". One bold code
 * span in one paragraph and an 8,000-character epic will not file.
 *
 * The emphasis loses, not the code: a reader of `**`x`**` is being shown a
 * literal, and the bold is decoration on top of it.
 */
const CODE_EXCLUDES = new Set(['em', 'strong', 'strike', 'subsup', 'textColor', 'underline']);

/**
 * Add a mark to an inline node, dropping it when ADF will not have it beside
 * one already there. Every mark an inline parser applies goes through here, so
 * the exclusion cannot be forgotten at one of the three call sites.
 */
function addMark(node: AdfNode, mark: { type: string }): void {
  const marks = (node.marks ??= []);
  const hasCode = marks.some((existing) => existing.type === 'code');
  if (hasCode && CODE_EXCLUDES.has(mark.type)) return;
  if (mark.type === 'code') {
    // The code mark arriving last wins the same argument, from the other side.
    node.marks = marks.filter((existing) => !CODE_EXCLUDES.has(existing.type));
    node.marks.push(mark);
    return;
  }
  marks.push(mark);
}

/** The reserved fence language carrying a raw unknown block node. */
const ADF_FENCE_LANG = 'lpm-adf';

/** The reserved link scheme carrying a raw unknown inline node (or mark). */
const ADF_LINK_SCHEME = 'lpm-adf:';

// ---------------------------------------------------------------------------
// A dependency-free base64url codec (the payload may be arbitrary JSON)
// ---------------------------------------------------------------------------

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** UTF-8 encode a string to bytes — `encodeURIComponent` is the Unicode-agnostic key. */
function utf8Bytes(value: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i += 1) {
    let code = value.codePointAt(i)!;
    if (code > 0xffff) i += 1; // the low surrogate is part of this code point
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
}

/** Decode UTF-8 bytes back to a string. */
function stringFromUtf8(bytes: number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i]!;
    let code: number;
    let length: number;
    if (b < 0x80) {
      code = b;
      length = 1;
    } else if ((b & 0xe0) === 0xc0) {
      code = ((b & 0x1f) << 6) | (bytes[i + 1]! & 0x3f);
      length = 2;
    } else if ((b & 0xf0) === 0xe0) {
      code = ((b & 0x0f) << 12) | ((bytes[i + 1]! & 0x3f) << 6) | (bytes[i + 2]! & 0x3f);
      length = 3;
    } else {
      code =
        ((b & 0x07) << 18) |
        ((bytes[i + 1]! & 0x3f) << 12) |
        ((bytes[i + 2]! & 0x3f) << 6) |
        (bytes[i + 3]! & 0x3f);
      length = 4;
    }
    out += String.fromCodePoint(code);
    i += length;
  }
  return out;
}

/** Encode bytes as unpadded base64url. */
function base64urlEncode(bytes: number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : undefined;
    out += B64_ALPHABET[b0 >> 2]!;
    out += B64_ALPHABET[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)]!;
    if (b1 !== undefined) {
      out += B64_ALPHABET[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)]!;
    }
    if (b2 !== undefined) {
      out += B64_ALPHABET[b2 & 63]!;
    }
  }
  return out;
}

/** Decode unpadded base64url to bytes, or null when the input is not base64url. */
function base64urlDecode(value: string): number[] | null {
  if (value.length === 0) return [];
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of value) {
    const index = B64_ALPHABET.indexOf(char);
    if (index === -1) return null;
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return bytes;
}

/** Encode an ADF node as a lossless inline payload. */
function encodePayload(node: AdfNode): string {
  return base64urlEncode(utf8Bytes(JSON.stringify(node)));
}

/** Decode a lossless payload back to an ADF node, or null when it is not one. */
function decodePayload(payload: string): AdfNode | null {
  const bytes = base64urlDecode(payload);
  if (bytes === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stringFromUtf8(bytes));
  } catch {
    return null;
  }
  if (parsed !== null && typeof parsed === 'object' && typeof (parsed as AdfNode).type === 'string') {
    return parsed as AdfNode;
  }
  return null;
}

// ---------------------------------------------------------------------------
// markdown → ADF
// ---------------------------------------------------------------------------

/** Escape rules for the markdown emitter (see `adfToMarkdown`).
 * `_` is deliberately NOT escaped and NOT treated as emphasis: light-plan's
 * templates only emit `*` for em, and bare `_` is common in identifiers
 * (`depends_on`, `story_points`) where escaping it would corrupt the text. */
const ESCAPE_ALWAYS = new Set(['\\', '`', '*', '[', ']']);

function escapeText(value: string): string {
  let out = '';
  for (const char of value) {
    out += ESCAPE_ALWAYS.has(char) ? '\\' + char : char;
  }
  return out;
}

/**
 * Parse the inline span of one line into ADF inline nodes.
 * Handles: `code`, **strong**, *em*, ~~strike~~, [label](url), backslash
 * escapes, and the lossless `lpm-adf:` link. Everything else is a text run.
 */
function parseInline(text: string): AdfNode[] {
  const out: AdfNode[] = [];
  let buf = '';
  const flush = (): void => {
    if (buf !== '') {
      out.push({ type: 'text', text: buf });
      buf = '';
    }
  };

  let i = 0;
  const length = text.length;
  while (i < length) {
    const c = text[i]!;
    if (c === '\\' && i + 1 < length) {
      buf += text[i + 1]!;
      i += 2;
      continue;
    }
    if (c === '`') {
      const end = text.indexOf('`', i + 1);
      if (end !== -1) {
        flush();
        out.push({ type: 'text', text: text.slice(i + 1, end), marks: [{ type: 'code' }] });
        i = end + 1;
        continue;
      }
    }
    if (c === '[') {
      const close = text.indexOf(']', i + 1);
      if (close !== -1 && text[close + 1] === '(') {
        const open = text.indexOf(')', close + 2);
        if (open !== -1) {
          const label = text.slice(i + 1, close);
          const href = text.slice(close + 2, open);
          flush();
          if (href.startsWith(ADF_LINK_SCHEME)) {
            const decoded = decodePayload(href.slice(ADF_LINK_SCHEME.length));
            if (decoded !== null) out.push(decoded);
            else out.push({ type: 'text', text: label, marks: [{ type: 'link', attrs: { href } }] });
          } else {
            out.push({ type: 'text', text: label, marks: [{ type: 'link', attrs: { href } }] });
          }
          i = open + 1;
          continue;
        }
      }
    }
    if (c === '*' && text[i + 1] === '*') {
      const end = text.indexOf('**', i + 2);
      if (end !== -1) {
        flush();
        const inner = parseInline(text.slice(i + 2, end));
        for (const node of inner) addMark(node, { type: 'strong' });
        out.push(...inner);
        i = end + 2;
        continue;
      }
    }
    if (c === '~' && text[i + 1] === '~') {
      const end = text.indexOf('~~', i + 2);
      if (end !== -1) {
        flush();
        const inner = parseInline(text.slice(i + 2, end));
        for (const node of inner) addMark(node, { type: 'strike' });
        out.push(...inner);
        i = end + 2;
        continue;
      }
    }
    if (c === '*') {
      const end = text.indexOf('*', i + 1);
      if (end !== -1) {
        flush();
        const inner = parseInline(text.slice(i + 1, end));
        for (const node of inner) addMark(node, { type: 'em' });
        out.push(...inner);
        i = end + 1;
        continue;
      }
    }
    buf += c;
    i += 1;
  }
  flush();
  return out;
}

/** The inline content of a paragraph built from its raw lines, hard breaks kept. */
function paragraphInline(rawLines: string[]): AdfNode[] {
  const content: AdfNode[] = [];
  for (let index = 0; index < rawLines.length; index += 1) {
    let line = rawLines[index]!;
    const hard = line.endsWith('  ');
    if (hard) line = line.slice(0, -2);
    const nodes = parseInline(line.replace(/[ \t]+/g, ' ').trim());
    content.push(...nodes);
    if (hard) {
      content.push({ type: 'hardBreak' });
    } else if (index < rawLines.length - 1) {
      content.push({ type: 'text', text: ' ' });
    }
  }
  // A soft break at either edge is whitespace the emitter would trim anyway.
  while (content.length > 0 && content[0]!.type === 'text' && content[0]!.text === ' ') {
    content.shift();
  }
  while (
    content.length > 0 &&
    content[content.length - 1]!.type === 'text' &&
    content[content.length - 1]!.text === ' '
  ) {
    content.pop();
  }
  return content.length > 0 ? content : [{ type: 'text', text: '' }];
}

/** A paragraph node from raw (possibly multi-line) text. */
function paragraphOf(raw: string): AdfNode {
  return { type: 'paragraph', content: paragraphInline(raw.replace(/\r/g, '').split('\n')) };
}

const isRule = (line: string): boolean => /^\s*([-*_])(\s*\1){2,}\s*$/.test(line.trim());
const isFence = (line: string): boolean => /^\s*```/.test(line) || /^\s*~~~/.test(line);

interface ListMarker {
  indent: number;
  ordered: boolean;
  rest: string;
}

function listItemMarker(line: string): ListMarker | null {
  const match = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
  if (!match) return null;
  return {
    indent: match[1]!.replace(/\t/g, '    ').length,
    ordered: /\d+\./.test(match[2]!),
    rest: match[3]!,
  };
}

function taskMarker(rest: string): { done: boolean; text: string } | null {
  const match = /^\[([ xX])\]\s+(.*)$/.exec(rest);
  if (!match) return null;
  return { done: match[1] !== ' ', text: match[2]! };
}

/** A fresh, doc-unique `localId` for task-list nodes (Jira requires one). */
function taskListIds(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `lpm-${counter}`;
  };
}

/** Read a node's `attrs` as a record, or an empty one. */
function attrsOf(node: AdfNode): Record<string, unknown> {
  const attrs = node.attrs;
  return attrs && typeof attrs === 'object' ? (attrs as Record<string, unknown>) : {};
}

function splitTableRow(line: string): string[] | null {
  let value = line.trim();
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|')) value = value.slice(0, -1);
  const cells = value.split('|').map((cell) => cell.trim());
  if (cells.every((cell) => cell === '')) return null;
  return cells;
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line);
  return cells !== null && cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function tableHeader(text: string): AdfNode {
  return { type: 'tableHeader', content: [paragraphOf(text)] };
}

function tableCell(text: string): AdfNode {
  return { type: 'tableCell', content: [paragraphOf(text)] };
}

function listNode(ordered: boolean, items: AdfNode[]): AdfNode {
  return ordered ? { type: 'orderedList', content: items } : { type: 'bulletList', content: items };
}

function listItemOf(item: { task: { done: boolean; text: string } | null; text: string }): AdfNode {
  // A task checkbox inside a non-uniform list stays literal.
  const text = item.task
    ? (item.task.done ? '[x] ' : '[ ] ') + item.task.text
    : item.text;
  return { type: 'listItem', content: [paragraphOf(text)] };
}

/** Decode an `lpm-adf` fence payload back to the block node it was, or null. */
function decodeFencePayload(code: string): AdfNode | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(code);
  } catch {
    return null;
  }
  if (parsed !== null && typeof parsed === 'object' && typeof (parsed as AdfNode).type === 'string') {
    return parsed as AdfNode;
  }
  return null;
}

function parseBlocks(lines: string[], nextTaskId: () => string): AdfNode[] {
  const nodes: AdfNode[] = [];
  let i = 0;
  const n = lines.length;

  while (i < n) {
    const raw = lines[i]!;
    const line = raw.trim();

    if (line === '') {
      i += 1;
      continue;
    }

    // Fenced code block — and the `lpm-adf` fence, which decodes to a raw node.
    if (isFence(line)) {
      const lang = line.replace(/^\s*```|^\s*~~~|\s*$/g, '').trim();
      i += 1;
      const code: string[] = [];
      while (i < n && !isFence(lines[i]!)) {
        code.push(lines[i]!);
        i += 1;
      }
      i += 1; // closing fence
      const text = code.join('\n');
      if (lang === ADF_FENCE_LANG) {
        const decoded = decodeFencePayload(text);
        if (decoded !== null) {
          nodes.push(decoded);
          continue;
        }
      }
      nodes.push({
        type: 'codeBlock',
        attrs: lang ? { language: lang } : {},
        content: [{ type: 'text', text }],
      });
      continue;
    }

    // Heading.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      nodes.push({
        type: 'heading',
        attrs: { level: heading[1]!.length },
        content: parseInline(heading[2]!),
      });
      i += 1;
      continue;
    }

    // Horizontal rule.
    if (isRule(line)) {
      nodes.push({ type: 'rule' });
      i += 1;
      continue;
    }

    // A full-line HTML comment (the managed block's delimiters travel as text
    // when a caller did not strip them — the translator strips them first).
    if (/^<!--/.test(line) && /-->$/.test(line)) {
      nodes.push(paragraphOf(line));
      i += 1;
      continue;
    }

    // Blockquote.
    if (line.startsWith('>')) {
      const inner: string[] = [];
      while (i < n && lines[i]!.trim().startsWith('>')) {
        inner.push(lines[i]!.replace(/^\s*>\s?/, ''));
        i += 1;
      }
      nodes.push({ type: 'blockquote', content: parseBlocks(inner, nextTaskId) });
      continue;
    }

    // Table: a header row followed by a separator row.
    if (line.startsWith('|')) {
      const headerCells = splitTableRow(line);
      if (headerCells && i + 1 < n && isTableSeparator(lines[i + 1]!)) {
        const rows: AdfNode[] = [
          { type: 'tableRow', content: headerCells.map(tableHeader) },
        ];
        i += 2; // header + separator
        while (i < n && lines[i]!.trim().startsWith('|')) {
          const cells = splitTableRow(lines[i]!);
          if (cells) {
            rows.push({ type: 'tableRow', content: cells.map(tableCell) });
          }
          i += 1;
        }
        nodes.push({ type: 'table', content: rows });
        continue;
      }
    }

    // List (bullet / ordered / task), grouped; nesting is flattened deliberately.
    const marker = listItemMarker(line);
    if (marker) {
      const items: { indent: number; task: { done: boolean; text: string } | null; text: string }[] = [];
      const ordered = marker.ordered;
      let allTasks = taskMarker(marker.rest) !== null;
      while (i < n && lines[i]!.trim() !== '') {
        const item = listItemMarker(lines[i]!);
        if (!item) break;
        if (item.ordered !== ordered) break;
        const task = taskMarker(item.rest);
        if (task === null) allTasks = false;
        items.push({ indent: item.indent, task, text: task ? task.text : item.rest });
        i += 1;
      }

      if (allTasks) {
        nodes.push({
          type: 'taskList',
          attrs: { localId: nextTaskId() },
          content: items.map((item) => ({
            type: 'taskItem',
            attrs: { localId: nextTaskId(), state: item.task!.done ? 'DONE' : 'TODO' },
            content: parseInline(item.text),
          })),
        });
      } else {
        nodes.push(listNode(ordered, items.map(listItemOf)));
      }
      continue;
    }

    // Paragraph: consume until a blank line.
    const parts: string[] = [];
    while (i < n && lines[i]!.trim() !== '') {
      parts.push(lines[i]!);
      i += 1;
    }
    nodes.push({ type: 'paragraph', content: paragraphInline(parts) });
  }

  return nodes;
}

/** Convert light-plan markdown to an ADF document (the shape Jira stores). */
export function markdownToAdf(markdown: string): AdfDocument {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  return { version: 1, type: 'doc', content: parseBlocks(lines, taskListIds()) };
}

// ---------------------------------------------------------------------------
// ADF → markdown
// ---------------------------------------------------------------------------

const MARK_ORDER: readonly string[] = ['code', 'em', 'strong', 'strike', 'link'];

/** The plain, human-readable text of an inline node (for labels and the floor). */
function inlinePlainText(node: AdfNode): string {
  switch (node.type) {
    case 'text':
      return node.text ?? '';
    case 'hardBreak':
      return '\n';
    case 'mention':
      return '@' + String(attrsOf(node)['text'] ?? '');
    case 'emoji':
      return String(attrsOf(node)['shortName'] ?? '');
    case 'status':
      return String(attrsOf(node)['text'] ?? '');
    case 'date':
      return String(attrsOf(node)['timestamp'] ?? '');
    case 'inlineCard':
      return String(attrsOf(node)['url'] ?? '');
    default:
      return JSON.stringify(node);
  }
}

/** A safe link label — `[` `]` `(` `)` and `\` cannot appear inside it. */
function safeLabel(value: string): string {
  return value.replace(/[\\[\](\)]/g, ' ').trim();
}

/** Whether a text run's marks are all ones the emitter can render natively. */
function hasUnknownMark(node: AdfNode): boolean {
  return (node.marks ?? []).some((mark) => !KNOWN_MARK_TYPES.has(mark.type));
}

function inlineToMarkdown(nodes: readonly AdfNode[]): string {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'text') {
      const marks = node.marks ?? [];
      const hasCode = marks.some((mark) => mark.type === 'code');
      // A mark we cannot render, or a text run the emitter cannot express,
      // rides the lossless link so the round trip keeps it byte for byte.
      if (hasUnknownMark(node)) {
        out += '[' + safeLabel(node.text ?? '') + '](' + ADF_LINK_SCHEME + encodePayload(node) + ')';
        continue;
      }
      let text = hasCode ? node.text ?? '' : escapeText(node.text ?? '');
      for (const mark of marks) {
        if (mark.type === 'code') text = '`' + text + '`';
        else if (mark.type === 'em') text = '*' + text + '*';
        else if (mark.type === 'strong') text = '**' + text + '**';
        else if (mark.type === 'strike') text = '~~' + text + '~~';
        else if (mark.type === 'link') {
          text = '[' + text + '](' + String(attrsOf({ type: 'text', attrs: mark.attrs })['href'] ?? '') + ')';
        }
        // unknown marks were handled above via the lossless link
      }
      out += text;
    } else if (node.type === 'hardBreak') {
      out += '  \n';
    } else if (KNOWN_INLINE_TYPES.has(node.type)) {
      out += escapeText(node.text ?? '');
    } else {
      // An unknown inline node: lossless link, label is its plain text.
      out += '[' + safeLabel(inlinePlainText(node)) + '](' + ADF_LINK_SCHEME + encodePayload(node) + ')';
    }
  }
  return out;
}

function blockToMarkdown(node: AdfNode): string {
  switch (node.type) {
    case 'paragraph':
      return inlineToMarkdown(node.content ?? []);
    case 'heading': {
      const level = attrsOf(node)['level'];
      return '#'.repeat(typeof level === 'number' && level >= 1 && level <= 6 ? level : 1) + ' ' + inlineToMarkdown(node.content ?? []);
    }
    case 'rule':
      return '---';
    case 'blockquote':
      return (node.content ?? [])
        .map((child) =>
          blockToMarkdown(child)
            .split('\n')
            .map((line) => '> ' + line)
            .join('\n'),
        )
        .join('\n');
    case 'codeBlock':
      return (
        '```' +
        String(attrsOf(node)['language'] ?? '') +
        '\n' +
        (node.content ?? []).map((child) => child.text ?? '').join('') +
        '\n```'
      );
    case 'bulletList':
    case 'orderedList': {
      const ordered = node.type === 'orderedList';
      return (node.content ?? [])
        .map((item, index) => {
          const prefix = ordered ? `${index + 1}. ` : '- ';
          const inner = (item.content ?? []).map(blockToMarkdown);
          return prefix + inner[0] + (inner.length > 1 ? '\n' + inner.slice(1).join('\n') : '');
        })
        .join('\n');
    }
    case 'taskList':
      return (node.content ?? [])
        .map((item) => {
          const done = attrsOf(item)['state'] === 'DONE';
          return '- [' + (done ? 'x' : ' ') + '] ' + inlineToMarkdown(item.content ?? []);
        })
        .join('\n');
    case 'taskItem':
      // A taskItem reached outside a taskList (an older ADF shape).
      return '- [' + (attrsOf(node)['state'] === 'DONE' ? 'x' : ' ') + '] ' + inlineToMarkdown(node.content ?? []);
    case 'table': {
      const rows = node.content ?? [];
      if (rows.length === 0) return '';
      const renderRow = (row: AdfNode): string =>
        '| ' +
        (row.content ?? [])
          .map((cell) => (cell.content ?? []).map(blockToMarkdown).join(' '))
          .join(' | ') +
        ' |';
      const first = renderRow(rows[0]!);
      const columns = rows[0]!.content?.length ?? 1;
      const separator = '| ' + Array(columns).fill('---').join(' | ') + ' |';
      return [first, separator, ...rows.slice(1).map(renderRow)].join('\n');
    }
    case 'doc':
      return (node.content ?? []).map(blockToMarkdown).join('\n\n');
    default:
      // An unknown block node: lossless fence, so the round trip keeps it.
      return '```' + ADF_FENCE_LANG + '\n' + JSON.stringify(node, null, 2) + '\n```';
  }
}

/** Convert an ADF document (or a single node) back to markdown. */
export function adfToMarkdown(doc: AdfNode | AdfDocument): string {
  return blockToMarkdown(doc);
}

// ---------------------------------------------------------------------------
// The plain-text floor, and the "does this body have nodes we do not own?" ask
// ---------------------------------------------------------------------------

/** The readable text of a block, best-effort — the one-way floor's output. */
function blockToPlainText(node: AdfNode): string {
  switch (node.type) {
    case 'doc':
      return (node.content ?? []).map(blockToPlainText).join('\n\n');
    case 'paragraph':
    case 'heading':
      return (node.content ?? []).map(inlinePlainText).join('');
    case 'rule':
      return '---';
    case 'blockquote':
      return (node.content ?? []).map(blockToPlainText).join('\n');
    case 'codeBlock':
      return (node.content ?? []).map((child) => child.text ?? '').join('');
    case 'bulletList':
    case 'orderedList': {
      const ordered = node.type === 'orderedList';
      return (node.content ?? [])
        .map((item, index) => `${ordered ? `${index + 1}.` : '-'} ${(item.content ?? []).map(blockToPlainText).join(' ')}`)
        .join('\n');
    }
    case 'taskList':
      return (node.content ?? [])
        .map((item) => `- [${attrsOf(item)['state'] === 'DONE' ? 'x' : ' '}] ${(item.content ?? []).map(inlinePlainText).join('')}`)
        .join('\n');
    case 'taskItem':
      return `- [${attrsOf(node)['state'] === 'DONE' ? 'x' : ' '}] ${(node.content ?? []).map(inlinePlainText).join('')}`;
    case 'table': {
      const rows = node.content ?? [];
      if (rows.length === 0) return '';
      return rows
        .map((row) => '| ' + (row.content ?? []).map((cell) => (cell.content ?? []).map(blockToPlainText).join(' ')).join(' | ') + ' |')
        .join('\n');
    }
    default:
      return JSON.stringify(node);
  }
}

/** Extract the readable text of an ADF document — the plain-text floor. */
export function adfToPlainText(doc: AdfNode | AdfDocument): string {
  return blockToPlainText(doc);
}

/** True when the document carries a node (or a mark) the converter does not own. */
export function adfHasUnknownNodes(doc: AdfNode | AdfDocument): boolean {
  const stack: AdfNode[] = [doc];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const known =
      node.type === 'doc' || KNOWN_BLOCK_TYPES.has(node.type) || KNOWN_INLINE_TYPES.has(node.type);
    if (!known) return true;
    if (node.type === 'text' && hasUnknownMark(node)) return true;
    if (node.content) stack.push(...node.content);
  }
  return false;
}
