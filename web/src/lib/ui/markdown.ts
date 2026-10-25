import { isLibraryRef, normalizeLibraryId } from '$shared';

/**
 * Markdown for a document body, rendered safely by construction.
 *
 * Bodies are markdown and are much easier to read as headings, lists and
 * checkboxes than as source. The catch is that rendering markdown is how you
 * end up handing someone else's board the page, so this works one way only:
 *
 *   1. **Escape the whole source first.** After `escape` there is no `<` left,
 *      so nothing in the document can become a tag.
 *   2. **Only ever add tags.** Every rule below emits its own markup around
 *      already-escaped text. There is no path from input to raw HTML.
 *   3. **Refuse a URL that is not a document.** Only `http`, `https` and
 *      `mailto` links are linked; anything else (`javascript:`, `data:`) stays
 *      as plain text.
 *
 * The subset is what issue bodies actually use — the templates in `templates/`
 * and the writing skills in `assets/skills/` are the reference: headings,
 * paragraphs, bullet, numbered and task lists (nested, and holding paragraphs
 * or code), pipe tables, fenced code, quotes, rules, inline code,
 * bold/italic/strike and links. Anything else comes through as text, which is
 * a fair rendering of it.
 *
 * `[[LP-12]]` links to the document with the id `LP-12`. The caller passes
 * `RenderOptions.nodeLink`, which gives the address and the title for an id.
 * Without that function, the text `[[LP-12]]` stays as it is.
 *
 * `[the PRD](library:prd/payments)` links to a document of the board library
 * when the caller sets `RenderOptions.libraryLink`. Without it, the text stays
 * as it is, because `library:` is not a scheme that a browser can open.
 *
 * Line breaks follow CommonMark: the lines of one paragraph join with a space,
 * because bodies are hard-wrapped at 80 columns. A line that ends in two
 * spaces or a backslash keeps its break.
 *
 * The published viewer deliberately does *not* use this: it reads a board from
 * a URL a stranger handed the reader, and "plain text, always" is a promise
 * that needs no argument about escaping to believe.
 */

const escape = (text: string): string =>
  text
    // NUL marks a stashed fragment in `inline`, so the source may not hold one.
    .replace(/\u0000/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Only schemes that name a document. Anything else is left as text. */
function safeUrl(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed.includes('\u0000')) return null;
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  return null;
}

const anchor = (href: string, label: string): string =>
  `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;

/**
 * The characters an id in `[[ID]]` can hold. Board ids have the form
 * `PREFIX-<n>`. No character in this set needs escaping in an attribute.
 */
const NODE_LINK = /\[\[[ \t]*([A-Za-z0-9][\w.-]*)[ \t]*\]\]/g;

/** What a caller tells the renderer about one id that `[[ID]]` names. */
export interface NodeLinkTarget {
  /** The address of the link. The renderer escapes it. */
  href: string;
  /** The title of the document. The link shows it as a tooltip. */
  title: string;
}

export interface RenderOptions {
  /**
   * Returns the target for an id in `[[ID]]`, or null when the board holds no
   * document with that id. Without this function, `[[ID]]` stays as text.
   */
  nodeLink?: (id: string) => NodeLinkTarget | null;
  /**
   * With `true`, `[label](library:<id>)` renders as a link with the attribute
   * `data-library`, which `Markdown.svelte` reads to open the Library dialog.
   * Without it, or for an id that breaks the id rule, the text stays as it is.
   */
  libraryLink?: boolean;
}

/** The markup for `[label](library:<id>)`. `label` is escaped already. */
function libraryLinkHtml(id: string, label: string): string {
  return `<a class="library-link" href="#" data-library="${escape(id)}" title="Library document ${escape(id)}">${label}</a>`;
}

/**
 * The markup for `[[ID]]`. A known id becomes a link with the attribute
 * `data-node`, which `Markdown.svelte` reads to open the issue window. An
 * unknown id becomes a span, so the reader sees that the target is missing.
 */
function nodeLinkHtml(id: string, target: NodeLinkTarget | null): string {
  if (!target) {
    return `<span class="node-link missing" title="No document with the id ${id}">${id}</span>`;
  }
  const tooltip = `${id}: ${escape(target.title)}`;
  return `<a class="node-link" href="${escape(target.href)}" data-node="${id}" title="${tooltip}">${id}</a>`;
}

/** Bold, italic and strike, applied to text whose code and links are stashed. */
function emphasis(text: string): string {
  return text
    .replace(/\*\*\*(?!\s)([^*]+?)(?<!\s)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(?!\s)([\s\S]+?)(?<!\s)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__(?!\s)([\s\S]+?)(?<!\s)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/(^|[^*\w])\*(?!\s)([^*]+?)(?<!\s)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_(?!\s)([^_]+?)(?<!\s)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(?!\s)([^~]+?)(?<!\s)~~/g, '<del>$1</del>');
}

/** Cut the punctuation that ends a sentence off a bare URL. */
function trimUrl(url: string): string {
  let end = url;
  for (;;) {
    const before = end;
    end = end.replace(/(?:[.,;:!?'*_~]|&quot;)$/, '');
    // A closing parenthesis belongs to the URL only when the URL opened one.
    if (end.endsWith(')') && (end.match(/\(/g) ?? []).length < (end.match(/\)/g) ?? []).length) {
      end = end.slice(0, -1);
    }
    if (end === before) return end;
  }
}

/**
 * Inline marks, applied to text that is already escaped.
 *
 * Code spans, escapes and links are replaced by numbered placeholders first,
 * so no later rule can put a mark inside them. The placeholders are swapped
 * back at the end.
 */
function inline(text: string, options: RenderOptions): string {
  const stash: string[] = [];
  const keep = (html: string): string => `\u0000${stash.push(html) - 1}\u0000`;
  const { nodeLink } = options;

  const marked = text
    // Code first: nothing inside a span of code is a mark.
    .replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _ticks: string, code: string) => {
      const inner = /^ .* $/s.test(code) ? code.slice(1, -1) : code;
      return keep(`<code>${inner.replace(/\n/g, ' ')}</code>`);
    })
    // A line that ends in two spaces or a backslash keeps its break.
    .replace(/(?: {2,}|\\)\n/g, () => `${keep('<br>')}\n`)
    // A backslash keeps the next mark character as text.
    .replace(/\\([\\`*_[\]()#+\-.!|~{}])/g, (_, char: string) => keep(char))
    // `[[ID]]` names another document on the board. It runs before the rule
    // for `[label](url)`, so the brackets are gone when that rule looks.
    .replace(NODE_LINK, (whole, id: string) => (nodeLink ? keep(nodeLinkHtml(id, nodeLink(id))) : whole))
    // An image is linked by its alt text rather than loaded: a body cannot
    // make the reader's browser fetch from a server the body names.
    .replace(
      /(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^\n]*?&quot;)?\)/g,
      (whole, bang: string, label: string, url: string) => {
        if (!bang && isLibraryRef(url)) {
          const id = options.libraryLink ? normalizeLibraryId(url) : null;
          return id === null ? whole : keep(libraryLinkHtml(id, label.trim() ? emphasis(label) : id));
        }
        const href = safeUrl(url);
        if (!href) return whole;
        const text = label.trim() ? emphasis(label) : bang ? 'image' : href;
        return keep(anchor(href, text));
      },
    )
    // Autolinks, which survived escaping as &lt;https://…&gt;.
    .replace(/&lt;((?:https?:\/\/|mailto:)(?:[^\s&]|&amp;)+)&gt;/g, (whole, url: string) => {
      const href = safeUrl(url);
      return href ? keep(anchor(href, href)) : whole;
    })
    // A bare URL in running text.
    .replace(/(^|[\s(])(https?:\/\/(?:[^\s&\u0000]|&amp;)+)/g, (whole, lead: string, url: string) => {
      const trimmed = trimUrl(url);
      const href = safeUrl(trimmed);
      if (!href) return whole;
      return `${lead}${keep(anchor(href, href))}${url.slice(trimmed.length)}`;
    });

  let html = emphasis(marked);
  // A stashed fragment can hold another one: a link label with code in it.
  for (;;) {
    const restored = html.replace(/\u0000(\d+)\u0000/g, (_, index: string) => stash[Number(index)] ?? '');
    if (restored === html) return html;
    html = restored;
  }
}

// -- Blocks -------------------------------------------------------------------

const BLANK = /^\s*$/;
const FENCE = /^( {0,3})(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}&gt; ?(.*)$/;
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:( +)(.*))?$/;
const DELIMITER_CELL = /^:?-+:?$/;

const isBlank = (line: string): boolean => BLANK.test(line);
const indentOf = (line: string): number => /^ */.exec(line)![0].length;

/** Tabs at the start of a line count as four spaces each. */
const expandTabs = (line: string): string =>
  line.replace(/^[ \t]+/, (lead) => lead.replace(/\t/g, '    '));

interface ListMarker {
  indent: number;
  ordered: boolean;
  start: number;
  /** The column where the text of the item starts. */
  contentIndent: number;
  text: string;
}

function listMarker(line: string): ListMarker | null {
  const match = LIST_ITEM.exec(line);
  if (!match) return null;
  const [, lead, marker, gap = '', text = ''] = match;
  // A marker followed by text with no space ("-x", "1.5") is not an item.
  if (!gap && text) return null;
  const ordered = /^\d/.test(marker!);
  // More than four spaces after the marker start indented code in
  // CommonMark; here they only mean the text starts one space in.
  const spacing = gap.length === 0 || gap.length > 4 ? 1 : gap.length;
  return {
    indent: lead!.length,
    ordered,
    start: ordered ? Number.parseInt(marker!, 10) : 1,
    contentIndent: lead!.length + marker!.length + spacing,
    text: gap.length > 4 ? gap.slice(1) + text : text,
  };
}

/** Split one table row into cells. A pipe inside code or after `\` is text. */
function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  let inCode = false;
  for (let index = 0; index < row.length; index += 1) {
    const char = row[index]!;
    if (char === '\\' && row[index + 1] === '|') {
      cell += '|';
      index += 1;
    } else if (char === '`') {
      inCode = !inCode;
      cell += char;
    } else if (char === '|' && !inCode) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

type Alignment = 'left' | 'center' | 'right' | null;

/** The column alignments, when `lines[at]` starts a table. */
function tableAt(lines: string[], at: number): Alignment[] | null {
  const header = lines[at];
  const delimiter = lines[at + 1];
  if (header === undefined || delimiter === undefined) return null;
  if (!header.includes('|') || !delimiter.includes('-')) return null;
  const cells = splitRow(delimiter);
  if (!cells.every((cell) => DELIMITER_CELL.test(cell))) return null;
  // A one-column table needs a pipe on its delimiter row, or every
  // paragraph followed by a `---` rule would be a table.
  if (cells.length === 1 && !delimiter.includes('|')) return null;
  if (splitRow(header).length !== cells.length) return null;
  return cells.map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
}

/** True when `lines[at]` starts a block that ends a paragraph. */
function interruptsParagraph(lines: string[], at: number): boolean {
  const line = lines[at]!;
  if (FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line)) return true;
  if (tableAt(lines, at)) return true;
  // CommonMark: only a bullet or a list that starts at 1 interrupts a
  // paragraph, so a wrapped line that begins "2026. " stays prose.
  const item = listMarker(line);
  return item !== null && item.text.trim() !== '' && (!item.ordered || item.start === 1);
}

function renderTable(
  lines: string[],
  at: number,
  alignments: Alignment[],
  options: RenderOptions,
): { html: string; next: number } {
  const cell = (tag: 'th' | 'td', text: string, column: number): string => {
    const align = alignments[column];
    return `<${tag}${align ? ` class="align-${align}"` : ''}>${inline(text, options)}</${tag}>`;
  };
  const row = (tag: 'th' | 'td', line: string): string => {
    const cells = splitRow(line);
    return `<tr>${alignments.map((_, column) => cell(tag, cells[column] ?? '', column)).join('')}</tr>`;
  };

  const head = row('th', lines[at]!);
  const body: string[] = [];
  let index = at + 2;
  while (index < lines.length && !isBlank(lines[index]!) && lines[index]!.includes('|')) {
    body.push(row('td', lines[index]!));
    index += 1;
  }
  const tbody = body.length ? `<tbody>${body.join('')}</tbody>` : '';
  return {
    html: `<div class="table-wrap"><table><thead>${head}</thead>${tbody}</table></div>`,
    next: index,
  };
}

function renderList(lines: string[], at: number, options: RenderOptions): { html: string; next: number } {
  const first = listMarker(lines[at]!)!;
  const items: string[][] = [];
  let loose = false;
  let index = at;

  for (;;) {
    const marker = listMarker(lines[index]!)!;
    const body = [marker.text];
    index += 1;

    // Collect the lines that belong to this item.
    while (index < lines.length) {
      const line = lines[index]!;
      if (isBlank(line)) {
        let next = index;
        while (next < lines.length && isBlank(lines[next]!)) next += 1;
        if (next < lines.length && indentOf(lines[next]!) >= marker.contentIndent) {
          for (; index < next; index += 1) body.push('');
          loose = true;
          continue;
        }
        break;
      }
      const indent = indentOf(line);
      if (indent >= marker.contentIndent) {
        body.push(line.slice(marker.contentIndent));
      } else if (listMarker(line) && indent > first.indent) {
        // A nested item indented less than this item's text: still nested.
        body.push(line.slice(indent));
      } else if (listMarker(line) || interruptsParagraph(lines, index) || isBlank(body.at(-1) ?? '')) {
        break;
      } else {
        // A lazy continuation of the item's last paragraph.
        body.push(line.trimStart());
      }
      index += 1;
    }
    items.push(body);

    // Is there a sibling after this item, perhaps past blank lines?
    let next = index;
    while (next < lines.length && isBlank(lines[next]!)) next += 1;
    const sibling = next < lines.length ? listMarker(lines[next]!) : null;
    if (!sibling || sibling.ordered !== first.ordered || sibling.indent >= first.contentIndent) break;
    if (next > index) loose = true;
    index = next;
  }

  const tag = first.ordered ? 'ol' : 'ul';
  const start = first.ordered && first.start !== 1 ? ` start="${first.start}"` : '';
  const rendered = items.map((body) => {
    // A task list is what a checklist in an acceptance criterion becomes.
    const task = /^\[([ xX])\][ \t]+(.*)$/.exec(body[0]!);
    if (!task) return `<li>${renderBlocks(body, options, !loose)}</li>`;
    const done = task[1]!.toLowerCase() === 'x';
    const content = renderBlocks([task[2]!, ...body.slice(1)], options, !loose);
    return `<li class="task"><input type="checkbox" disabled${done ? ' checked' : ''}> ${content}</li>`;
  });
  return { html: `<${tag}${start}>${rendered.join('')}</${tag}>`, next: index };
}

/**
 * Render escaped lines to HTML. With `tight`, a paragraph is emitted without
 * its `<p>`: that is how the text of a list item with no blank lines renders.
 */
function renderBlocks(lines: string[], options: RenderOptions, tight = false): string {
  const out: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;

    if (isBlank(line)) {
      index += 1;
      continue;
    }

    // Inside a fence, every line is content until the fence closes.
    const fence = FENCE.exec(line);
    if (fence) {
      const indent = fence[1]!.length;
      const marks = fence[2]!;
      const closing = new RegExp(`^ {0,3}${marks[0] === '`' ? '`' : '~'}{${marks.length},}\\s*$`);
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !closing.test(lines[index]!)) {
        const content = lines[index]!;
        code.push(content.slice(Math.min(indent, indentOf(content))));
        index += 1;
      }
      index += 1;
      const language = /^[\w+-]+$/.test(fence[3]!) ? ` class="language-${fence[3]}"` : '';
      out.push(`<pre><code${language}>${code.join('\n')}</code></pre>`);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline((heading[2] ?? '').trim(), options)}</h${level}>`);
      index += 1;
      continue;
    }

    if (RULE.test(line)) {
      out.push('<hr>');
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length) {
        const current = lines[index]!;
        const match = QUOTE.exec(current);
        if (match) quoted.push(match[1]!);
        // A lazy line continues the quote's paragraph.
        else if (!isBlank(current) && !isBlank(quoted.at(-1) ?? '') && !interruptsParagraph(lines, index)) {
          quoted.push(current.trim());
        } else break;
        index += 1;
      }
      out.push(`<blockquote>${renderBlocks(quoted, options)}</blockquote>`);
      continue;
    }

    const alignments = tableAt(lines, index);
    if (alignments) {
      const table = renderTable(lines, index, alignments, options);
      out.push(table.html);
      index = table.next;
      continue;
    }

    if (listMarker(line)) {
      const list = renderList(lines, index, options);
      out.push(list.html);
      index = list.next;
      continue;
    }

    const paragraph = [line.trimStart()];
    index += 1;
    while (index < lines.length && !isBlank(lines[index]!) && !interruptsParagraph(lines, index)) {
      paragraph.push(lines[index]!.trimStart());
      index += 1;
    }
    const text = inline(paragraph.join('\n').trimEnd(), options);
    out.push(tight ? text : `<p>${text}</p>`);
  }

  return out.join('\n');
}

/**
 * Render a markdown body to HTML.
 *
 * Returns an empty string for an empty body, so a caller can decide what to
 * show instead of a blank box.
 */
export function renderMarkdown(source: string, options: RenderOptions = {}): string {
  const lines = escape(source ?? '')
    .split(/\r?\n/)
    .map(expandTabs);
  return renderBlocks(lines, options);
}
