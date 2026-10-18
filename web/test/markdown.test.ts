import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '$lib/ui/markdown.js';

describe('renderMarkdown', () => {
  it('renders the shapes an issue body is actually made of', () => {
    const html = renderMarkdown(
      ['## Summary', '', 'Ship the **card** form.', '', '- [x] Validate', '- [ ] Submit'].join('\n'),
    );
    expect(html).toContain('<h2>Summary</h2>');
    expect(html).toContain('<p>Ship the <strong>card</strong> form.</p>');
    expect(html).toContain('<input type="checkbox" disabled checked>');
    expect(html).toContain('<input type="checkbox" disabled>');
  });

  it('nests a list by its indentation and closes what it opened', () => {
    const html = renderMarkdown(['- one', '  - deeper', '- two'].join('\n'));
    expect(html.match(/<ul>/g)).toHaveLength(2);
    expect(html.match(/<\/ul>/g)).toHaveLength(2);
    expect(html.indexOf('deeper')).toBeGreaterThan(html.indexOf('one'));
  });

  it('keeps a numbered list numbered', () => {
    expect(renderMarkdown('1. first\n2. second')).toContain('<ol>');
  });

  it('leaves a fenced block alone', () => {
    const html = renderMarkdown(['```', 'const a = **not bold**;', '```'].join('\n'));
    expect(html).toBe('<pre><code>const a = **not bold**;</code></pre>');
  });

  it('renders quotes, rules and inline code', () => {
    expect(renderMarkdown('> careful')).toBe('<blockquote><p>careful</p></blockquote>');
    expect(renderMarkdown('---')).toBe('<hr>');
    expect(renderMarkdown('run `lpm check`')).toContain('<code>lpm check</code>');
  });

  describe('tables', () => {
    const table = [
      '| Kind | Types | Reader |',
      '| :--- | :---: | ---: |',
      '| Container | `program`, `epic` | The planner |',
      '| Step | `sub_task` | The developer |',
    ].join('\n');

    it('renders a pipe table with a head and a body', () => {
      const html = renderMarkdown(table);
      expect(html).toContain('<table>');
      expect(html.match(/<th[ >]/g)).toHaveLength(3);
      expect(html.match(/<tr>/g)).toHaveLength(3);
      expect(html).toContain('<td class="align-left">Container</td>');
      expect(html).toContain('<td class="align-center"><code>program</code>, <code>epic</code></td>');
      expect(html).toContain('<td class="align-right">The developer</td>');
    });

    it('wraps the table so a wide one scrolls inside its own box', () => {
      expect(renderMarkdown(table)).toMatch(/^<div class="table-wrap"><table>/);
    });

    it('keeps an escaped pipe and a pipe in code inside their cell', () => {
      const html = renderMarkdown(['| a | b |', '| --- | --- |', '| x \\| y | `p | q` |'].join('\n'));
      expect(html).toContain('<td>x | y</td>');
      expect(html).toContain('<td><code>p | q</code></td>');
    });

    it('fills a short row and drops the cells past the header', () => {
      const html = renderMarkdown(['| a | b |', '| - | - |', '| 1 |', '| 1 | 2 | 3 |'].join('\n'));
      expect(html).toContain('<tr><td>1</td><td></td></tr>');
      expect(html).toContain('<tr><td>1</td><td>2</td></tr>');
    });

    it('starts a table right after a line of prose', () => {
      const html = renderMarkdown(['The rules:', '| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n'));
      expect(html).toContain('<p>The rules:</p>');
      expect(html).toContain('<table>');
    });

    it('does not read a paragraph above a rule as a table', () => {
      expect(renderMarkdown('a | b\n---')).not.toContain('<table>');
    });
  });

  describe('paragraphs', () => {
    it('joins the lines of a hard-wrapped paragraph with a space', () => {
      expect(renderMarkdown('The examples are about\none feature.')).toBe(
        '<p>The examples are about\none feature.</p>',
      );
    });

    it('keeps a break after two spaces or a backslash', () => {
      expect(renderMarkdown('one  \ntwo\\\nthree')).toBe('<p>one<br>\ntwo<br>\nthree</p>');
    });

    it('applies bold across a wrapped line', () => {
      expect(renderMarkdown('**a long\nphrase**')).toContain('<strong>a long\nphrase</strong>');
    });

    it('leaves marks inside code alone', () => {
      const html = renderMarkdown('call `fn(*args, **kwargs)` and `__init__`');
      expect(html).toContain('<code>fn(*args, **kwargs)</code>');
      expect(html).toContain('<code>__init__</code>');
      expect(html).not.toContain('<em>');
    });

    it('does not read a lone star between spaces as emphasis', () => {
      expect(renderMarkdown('2 * 3 * 4')).toBe('<p>2 * 3 * 4</p>');
    });

    it('links a bare URL without the full stop after it', () => {
      const html = renderMarkdown('See https://example.com/a_b_c.');
      expect(html).toContain('<a href="https://example.com/a_b_c"');
      expect(html).toMatch(/<\/a>\.<\/p>$/);
    });

    it('links an image by its alt text and does not load it', () => {
      const html = renderMarkdown('![diagram](https://example.com/d.png)');
      expect(html).not.toContain('<img');
      expect(html).toContain('>diagram</a>');
    });

    it('keeps a wrapped line that starts with a year as prose', () => {
      expect(renderMarkdown('lost in\n2026. Then')).not.toContain('<ol');
    });
  });

  describe('lists', () => {
    it('keeps a numbered list with blank lines between items as one list', () => {
      const html = renderMarkdown('1. first\n\n2. second\n\n3. third');
      expect(html.match(/<ol>/g)).toHaveLength(1);
      expect(html).toContain('<li><p>second</p></li>');
    });

    it('starts a numbered list at its first number', () => {
      expect(renderMarkdown('3. third\n4. fourth')).toContain('<ol start="3">');
    });

    it('keeps a wrapped line in its list item', () => {
      expect(renderMarkdown('- a long item\n  that wraps\n- next')).toBe(
        '<ul><li>a long item\nthat wraps</li><li>next</li></ul>',
      );
    });

    it('keeps an indented code block in its list item', () => {
      const html = renderMarkdown(['1. Run:', '', '   ```sh', '   npm test', '   ```', '2. Read'].join('\n'));
      expect(html.match(/<ol>/g)).toHaveLength(1);
      expect(html).toContain('<li><p>Run:</p>\n<pre><code class="language-sh">npm test</code></pre></li>');
    });

    it('nests a bullet list under a numbered item', () => {
      expect(renderMarkdown('1. step\n   - detail\n2. next')).toBe(
        '<ol><li>step\n<ul><li>detail</li></ul></li><li>next</li></ol>',
      );
    });

    it('renders a table inside a list item', () => {
      const html = renderMarkdown(['- Item:', '', '  | a | b |', '  | - | - |', '  | 1 | 2 |'].join('\n'));
      expect(html).toMatch(/^<ul><li><p>Item:<\/p>\n<div class="table-wrap">/);
    });
  });

  // The whole reason this file exists rather than a dependency.
  describe('safety', () => {
    it('escapes markup instead of emitting it', () => {
      const html = renderMarkdown('<img src=x onerror="alert(1)"> and <b>bold</b>');
      expect(html).not.toContain('<img');
      expect(html).not.toContain('<b>');
      expect(html).toContain('&lt;img');
    });

    it('escapes the innards of a code fence too', () => {
      expect(renderMarkdown('```\n<script>alert(1)</script>\n```')).not.toContain('<script>');
    });

    it('links only schemes that name a document', () => {
      const html = renderMarkdown('[docs](https://example.com) [bad](javascript:alert(1))');
      expect(html).toContain('<a href="https://example.com"');
      // The refused one stays as the text it was written as, and links nowhere.
      expect(html).not.toContain('href="javascript:');
      expect(html).toContain('[bad](javascript:alert(1))');
    });

    it('opens links in a new tab without handing over the opener', () => {
      expect(renderMarkdown('<https://example.com>')).toContain('rel="noopener noreferrer"');
    });

    it('escapes the cells of a table', () => {
      const html = renderMarkdown('| <b>x</b> |\n| --- |\n| <script>y</script> |');
      expect(html).not.toContain('<b>');
      expect(html).not.toContain('<script>');
    });

    it('does not link a bare URL of another scheme', () => {
      expect(renderMarkdown('javascript:alert(1)')).not.toContain('<a');
    });

    it('ignores a NUL in the source', () => {
      expect(renderMarkdown('a \u00000\u0000 `b`')).toBe('<p>a 0 <code>b</code></p>');
    });

    it('cannot be closed out of by a quote in a link', () => {
      const html = renderMarkdown('[x](https://example.com/" onmouseover="alert(1))');
      expect(html).not.toContain('onmouseover="alert(1)"');
    });
  });

  it('is empty for an empty body', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown('   \n  ')).toBe('');
  });
});
