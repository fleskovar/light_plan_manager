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
 * are the reference: headings, bullet and numbered lists, task lists, fenced
 * and inline code, quotes, rules, bold/italic/strike and links. Anything else
 * comes through as text, which is a fair rendering of it.
 *
 * The published viewer deliberately does *not* use this: it reads a board from
 * a URL a stranger handed the reader, and "plain text, always" is a promise
 * that needs no argument about escaping to believe.
 */

const escape = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Only schemes that name a document. Anything else is left as text. */
function safeUrl(url: string): string | null {
  const trimmed = url.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  return null;
}

/** Inline marks, applied to text that is already escaped. */
function inline(text: string): string {
  return (
    text
      // Code first: nothing inside a span of code is a mark.
      .replace(/`([^`]+)`/g, (_, code: string) => `<code>${code}</code>`)
      .replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (whole, label: string, url: string) => {
        const href = safeUrl(url);
        return href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label || href}</a>` : whole;
      })
      // Autolinks, which survived escaping as &lt;https://…&gt;.
      .replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, (whole, url: string) => {
        const href = safeUrl(url);
        return href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>` : whole;
      })
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
  );
}

interface ListFrame {
  tag: 'ul' | 'ol';
  indent: number;
}

/**
 * Render a markdown body to HTML.
 *
 * Returns an empty string for an empty body, so a caller can decide what to
 * show instead of a blank box.
 */
export function renderMarkdown(source: string): string {
  const lines = escape(source ?? '').split(/\r?\n/);
  const out: string[] = [];
  const lists: ListFrame[] = [];

  let paragraph: string[] = [];
  let quote: string[] = [];
  let code: { fence: string; lines: string[] } | null = null;

  const closeLists = (toIndent = -1): void => {
    while (lists.length && lists[lists.length - 1]!.indent > toIndent) {
      out.push(`</${lists.pop()!.tag}>`);
    }
  };

  const flushParagraph = (): void => {
    if (!paragraph.length) return;
    out.push(`<p>${inline(paragraph.join('<br>'))}</p>`);
    paragraph = [];
  };

  const flushQuote = (): void => {
    if (!quote.length) return;
    out.push(`<blockquote>${inline(quote.join('<br>'))}</blockquote>`);
    quote = [];
  };

  const flushAll = (indent = -1): void => {
    flushParagraph();
    flushQuote();
    closeLists(indent);
  };

  for (const line of lines) {
    // Inside a fence, every line is content until the fence closes.
    if (code) {
      if (line.trim().startsWith(code.fence)) {
        out.push(`<pre><code>${code.lines.join('\n')}</code></pre>`);
        code = null;
      } else {
        code.lines.push(line);
      }
      continue;
    }

    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      flushAll();
      code = { fence: fence[1]!, lines: [] };
      continue;
    }

    if (!line.trim()) {
      flushAll();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline(heading[2]!.trim())}</h${level}>`);
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushAll();
      out.push('<hr>');
      continue;
    }

    const quoted = /^\s*&gt;\s?(.*)$/.exec(line);
    if (quoted) {
      flushParagraph();
      closeLists();
      quote.push(quoted[1]!);
      continue;
    }

    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flushParagraph();
      flushQuote();
      const indent = item[1]!.length;
      const tag: ListFrame['tag'] = /^\d/.test(item[2]!) ? 'ol' : 'ul';
      closeLists(indent);
      const top = lists[lists.length - 1];
      if (!top || top.indent < indent) {
        lists.push({ tag, indent });
        out.push(`<${tag}>`);
      } else if (top.tag !== tag) {
        out.push(`</${top.tag}>`);
        lists[lists.length - 1] = { tag, indent };
        out.push(`<${tag}>`);
      }

      // A task list is what a checklist in an acceptance criterion becomes.
      const task = /^\[([ xX])\]\s+(.*)$/.exec(item[3]!);
      if (task) {
        const done = task[1]!.toLowerCase() === 'x';
        out.push(
          `<li class="task"><input type="checkbox" disabled${done ? ' checked' : ''}> ${inline(task[2]!)}</li>`,
        );
      } else {
        out.push(`<li>${inline(item[3]!)}</li>`);
      }
      continue;
    }

    // A plain line: continues a list item, a quote or a paragraph.
    if (lists.length) {
      out.push(`<p class="loose">${inline(line.trim())}</p>`);
      continue;
    }
    if (quote.length) {
      quote.push(line.trim());
      continue;
    }
    paragraph.push(line.trim());
  }

  if (code) out.push(`<pre><code>${code.lines.join('\n')}</code></pre>`);
  flushAll();

  return out.join('\n');
}
