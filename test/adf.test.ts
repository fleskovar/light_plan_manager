/**
 * LP-323 — the markdown ↔ ADF converter (`src/shared/adf.ts`).
 *
 * The production form of the LP-322 spike. These tests assert the story's
 * body-conversion acceptance criteria offline:
 *
 *   - markdown → ADF covers the subset light-plan's templates emit (headings,
 *     paragraphs, bold/italic/code/strike/links, bullet/ordered/task lists,
 *     tables, code blocks, block quotes, rules, hard breaks);
 *   - ADF → markdown is the inverse, and the round trip is a stable fixed
 *     point (convert twice, the second equals the first);
 *   - task-list checkboxes survive via `taskItem` state `TODO` / `DONE`;
 *   - ADF nodes the converter does not own (a panel, a status lozenge) survive
 *     the round trip untouched, losslessly;
 *   - the plain-text floor (`adfToPlainText`) and the "does this body carry
 *     unknown nodes" ask (`adfHasUnknownNodes`) work.
 */

import { describe, expect, it } from 'vitest';
import {
  adfHasUnknownNodes,
  adfToMarkdown,
  adfToPlainText,
  markdownToAdf,
  type AdfDocument,
} from '../src/shared/adf.js';

/** Round-trip once, then again — the second pass must equal the first. */
function roundTrip(md: string): { once: string; twice: string; idempotent: boolean } {
  const once = adfToMarkdown(markdownToAdf(md));
  const twice = adfToMarkdown(markdownToAdf(once));
  return { once, twice, idempotent: once === twice };
}

/** The template bodies light-plan actually emits, verbatim shapes. */
const CORPUS: Array<{ name: string; body: string }> = [
  {
    name: 'user_story template',
    body: `As a **<role>**, I want **<capability>**, so that **<benefit>**.

## Acceptance Criteria

- [ ] **Given** <context> **when** <action> **then** <outcome>

## Definition of Done

- [ ] Code reviewed and merged
- [ ] Tests cover the acceptance criteria
- [ ] Documentation updated

## Notes

-`,
  },
  {
    name: 'epic template',
    body: `## Summary

A short paragraph describing the epic.

## Business Value

Why is this worth doing now? What happens if we do not?

## Success Criteria

- [ ] Measurable criterion

## Out of Scope

-`,
  },
  {
    name: 'program template (key-results table)',
    body: `## Vision

What outcome does this program pursue, and for whom?

## Business Outcomes

- Outcome 1

## Key Results

| Metric | Baseline | Target |
| --- | --- | --- |
|  |  |  |

## Out of Scope

-`,
  },
  {
    name: 'bug template (ordered steps)',
    body: `## Summary

One sentence describing the defect.

## Steps to Reproduce

1.

## Expected Behaviour

## Actual Behaviour

## Environment

- Version:
- Platform:`,
  },
];

describe('markdownToAdf', () => {
  it('wraps content in a versioned doc node', () => {
    const doc = markdownToAdf('hello');
    expect(doc.version).toBe(1);
    expect(doc.type).toBe('doc');
    expect(doc.content).toHaveLength(1);
  });

  it('covers every construct the templates emit', () => {
    const doc = markdownToAdf(
      [
        '# Heading 1',
        '',
        'A **bold** *em* ~~strike~~ `code` [link](https://example.com) paragraph.',
        '',
        '- bullet one',
        '- bullet two',
        '',
        '1. first',
        '2. second',
        '',
        '- [ ] open task',
        '- [x] done task',
        '',
        '> a quote',
        '',
        '| A | B |',
        '| --- | --- |',
        '| 1 | 2 |',
        '',
        '```ts',
        'const x = 1;',
        '```',
        '',
        '---',
      ].join('\n'),
    );

    const types = collectTypes(doc);
    expect(types).toContain('heading');
    expect(types).toContain('bulletList');
    expect(types).toContain('orderedList');
    expect(types).toContain('taskList');
    expect(types).toContain('blockquote');
    expect(types).toContain('table');
    expect(types).toContain('codeBlock');
    expect(types).toContain('rule');
  });
});

describe('adfToMarkdown', () => {
  it('is the inverse for the subset', () => {
    const md = [
      '## Acceptance Criteria',
      '',
      '- [ ] **Given** context **then** outcome',
      '',
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
    ].join('\n');
    const once = adfToMarkdown(markdownToAdf(md));
    expect(once).toBe(md);
  });

  it('preserves task-list checkbox state as TODO / DONE', () => {
    const doc: AdfDocument = {
      version: 1,
      type: 'doc',
      content: [
        {
          type: 'taskList',
          attrs: { localId: 'l1' },
          content: [
            { type: 'taskItem', attrs: { localId: 'i1', state: 'TODO' }, content: [{ type: 'text', text: 'open' }] },
            { type: 'taskItem', attrs: { localId: 'i2', state: 'DONE' }, content: [{ type: 'text', text: 'done' }] },
          ],
        },
      ],
    };
    expect(adfToMarkdown(doc)).toBe('- [ ] open\n- [x] done');
  });

  it('renders a hard break and reads it back', () => {
    const doc: AdfDocument = {
      version: 1,
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'line one' }, { type: 'hardBreak' }, { type: 'text', text: 'line two' }],
        },
      ],
    };
    const md = adfToMarkdown(doc);
    expect(md).toBe('line one  \nline two');
    // The two-space line ending round-trips to a hardBreak, not a space.
    expect(JSON.stringify(markdownToAdf(md))).toBe(JSON.stringify(doc));
  });
});

describe('the fixed point (convert twice, the second equals the first)', () => {
  for (const entry of CORPUS) {
    it(`is idempotent for the ${entry.name}`, () => {
      const result = roundTrip(entry.body);
      expect(result.once).toBe(result.twice);
    });
  }

  it('is idempotent for a body with soft line breaks (they collapse once)', () => {
    const wrapped = 'This is a paragraph that a\nhuman wrapped across two\nlines by hand.';
    const once = adfToMarkdown(markdownToAdf(wrapped));
    expect(once).toBe('This is a paragraph that a human wrapped across two lines by hand.');
    expect(adfToMarkdown(markdownToAdf(once))).toBe(once);
  });

  it('is idempotent for the managed-block sample (HTML comments ride as text)', () => {
    const withBlock = [
      'Prose above.',
      '',
      '<!-- lpm:begin -->',
      '| light-plan | |',
      '| --- | --- |',
      '| type | feature |',
      '<!-- lpm:end -->',
      '',
      'Prose below.',
    ].join('\n');
    const result = roundTrip(withBlock);
    expect(result.idempotent).toBe(true);
  });
});

describe('unknown ADF nodes survive the round trip untouched', () => {
  it('preserves an unknown block node (a panel) losslessly', () => {
    const panel: AdfDocument = {
      version: 1,
      type: 'doc',
      content: [
        {
          type: 'panel',
          attrs: { panelType: 'info' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'inside' }] }],
        },
      ],
    };
    const md = adfToMarkdown(panel);
    // The panel is carried as a reserved fence, not flattened.
    expect(md).toContain('```lpm-adf');
    expect(md).toContain('"panel"');
    expect(markdownToAdf(md)).toEqual(panel);
  });

  it('preserves an unknown inline node (a status lozenge) losslessly', () => {
    const status: AdfDocument = {
      version: 1,
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'status', attrs: { text: 'OPEN', color: 'green' } }],
        },
      ],
    };
    const md = adfToMarkdown(status);
    expect(md).toContain('lpm-adf:');
    expect(markdownToAdf(md)).toEqual(status);
  });

  it('preserves a text run carrying an unknown mark losslessly', () => {
    const colored: AdfDocument = {
      version: 1,
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'red text', marks: [{ type: 'textColor', attrs: { color: '#ff0000' } }] }],
        },
      ],
    };
    const md = adfToMarkdown(colored);
    expect(md).toContain('lpm-adf:');
    expect(markdownToAdf(md)).toEqual(colored);
  });

  it('does not treat a normal link as a lossless payload', () => {
    const doc = markdownToAdf('[text](https://example.com)');
    const paragraph = doc.content[0]!;
    const text = (paragraph as { content?: Array<{ marks?: Array<{ type: string; attrs?: Record<string, unknown> }> }> }).content![0]!;
    expect(text.marks![0]!.type).toBe('link');
    expect(text.marks![0]!.attrs!.href).toBe('https://example.com');
  });
});

describe('the plain-text floor and the unknown-node ask', () => {
  it('extracts readable text from a document', () => {
    const md = ['# Title', '', 'A paragraph.', '', '- one', '- two'].join('\n');
    const text = adfToPlainText(markdownToAdf(md));
    expect(text).toBe('Title\n\nA paragraph.\n\n- one\n- two');
  });

  it('extracts the lozenge text from an unknown inline node', () => {
    const doc: AdfDocument = {
      version: 1,
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'status', attrs: { text: 'DONE' } }] }],
    };
    expect(adfToPlainText(doc)).toBe('DONE');
  });

  it('reports a body with unknown nodes, and clears one without', () => {
    expect(adfHasUnknownNodes(markdownToAdf('plain prose'))).toBe(false);

    const panel: AdfDocument = {
      version: 1,
      type: 'doc',
      content: [{ type: 'panel', content: [] }],
    };
    expect(adfHasUnknownNodes(panel)).toBe(true);
  });
});

/** Every node type in a document, flattened. */
function collectTypes(node: { type: string; content?: Array<{ type: string; content?: Array<{ type: string; content?: unknown[] }> }> }): string[] {
  const out: string[] = [node.type];
  for (const child of node.content ?? []) out.push(...collectTypes(child as never));
  return out;
}

describe('marks ADF will not combine', () => {
  /** Every mark on the first text node carrying `text`. */
  function marksOf(doc: ReturnType<typeof markdownToAdf>, text: string): string[] {
    let found: string[] | undefined;
    const walk = (node: { type?: string; text?: string; marks?: { type: string }[]; content?: unknown[] }): void => {
      if (node.type === 'text' && node.text === text) found = (node.marks ?? []).map((m) => m.type);
      for (const child of (node.content ?? []) as typeof node[]) walk(child);
    };
    walk(doc as never);
    return found ?? [];
  }

  it('drops the emphasis from bold code rather than emitting both', () => {
    // ADF's `code` mark is exclusive: a text node carrying it may also carry a
    // link and nothing else. Markdown has no such rule and `**`x`**` is
    // ordinary — emitting `[code, strong]` made Jira reject the *whole*
    // description as "not valid Atlassian Document Format content", so one bold
    // code span in one paragraph stopped an 8,000-character epic from filing.
    expect(marksOf(markdownToAdf('**`lpm remote push`** files it'), 'lpm remote push')).toEqual(['code']);
  });

  it('drops it the other way round too, whichever mark is applied last', () => {
    expect(marksOf(markdownToAdf('`*x*`'), '*x*')).toEqual(['code']);
    expect(marksOf(markdownToAdf('*`x`*'), 'x')).toEqual(['code']);
    expect(marksOf(markdownToAdf('~~`x`~~'), 'x')).toEqual(['code']);
  });

  it('leaves a mark that stands on its own alone', () => {
    expect(marksOf(markdownToAdf('**bold**'), 'bold')).toEqual(['strong']);
    expect(marksOf(markdownToAdf('*italic*'), 'italic')).toEqual(['em']);
    expect(marksOf(markdownToAdf('`code`'), 'code')).toEqual(['code']);
  });
});
