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
    expect(renderMarkdown('> careful')).toBe('<blockquote>careful</blockquote>');
    expect(renderMarkdown('---')).toBe('<hr>');
    expect(renderMarkdown('run `lpm check`')).toContain('<code>lpm check</code>');
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
