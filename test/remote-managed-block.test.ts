import { describe, expect, it } from 'vitest';
import {
  applyManagedBlock,
  MANAGED_BLOCK_BEGIN,
  MANAGED_BLOCK_END,
  parseManagedBlock,
  parseManagedId,
  parseManagedIdList,
  parseManagedRefs,
  refsEntry,
  renderManagedBlock,
  type ManagedBlockEntry,
  type ManagedBlockLinks,
} from '../src/remote/managed-block.js';

/** The LP-255 example's fields, in a deliberately shuffled order. */
const EXAMPLE_ENTRIES: ManagedBlockEntry[] = [
  { name: 'type', kind: 'text', value: 'user_story' },
  { name: 'parent', kind: 'id', value: 'LP-9' },
  { name: 'depends_on', kind: 'ids', value: ['LP-7', 'LP-4'] },
  { name: 'id', kind: 'text', value: 'LP-12' },
];

const EXAMPLE_LINKS: ManagedBlockLinks = new Map([
  ['LP-9', 'https://github.com/acme/payments/issues/418'],
  ['LP-4', 'https://github.com/acme/payments/issues/404'],
  ['LP-7', 'https://github.com/acme/payments/issues/407'],
]);

// ---------------------------------------------------------------------------
// renderManagedBlock
// ---------------------------------------------------------------------------

describe('renderManagedBlock', () => {
  it('renders fields between the delimiters as a markdown table', () => {
    const block = renderManagedBlock(EXAMPLE_ENTRIES);
    expect(block).toBe(
      [
        '<!-- lpm:begin -->',
        '| light-plan | |',
        '| --- | --- |',
        '| depends_on | LP-4, LP-7 |',
        '| id | LP-12 |',
        '| parent | LP-9 |',
        '| type | user_story |',
        '<!-- lpm:end -->',
      ].join('\n'),
    );
  });

  it('sorts entries by name so order does not change the bytes', () => {
    const shuffled: ManagedBlockEntry[] = [
      { name: 'depends_on', kind: 'ids', value: ['LP-4', 'LP-7'] },
      { name: 'type', kind: 'text', value: 'user_story' },
      { name: 'parent', kind: 'id', value: 'LP-9' },
      { name: 'id', kind: 'text', value: 'LP-12' },
    ];
    expect(renderManagedBlock(shuffled)).toBe(renderManagedBlock(EXAMPLE_ENTRIES));
  });

  it('sorts id lists so list order does not change the bytes', () => {
    const reversed: ManagedBlockEntry[] = [
      { name: 'depends_on', kind: 'ids', value: ['LP-7', 'LP-4'] },
    ];
    const forward: ManagedBlockEntry[] = [
      { name: 'depends_on', kind: 'ids', value: ['LP-4', 'LP-7'] },
    ];
    expect(renderManagedBlock(reversed)).toBe(renderManagedBlock(forward));
  });

  it('renders ids as remote links where a URL is known, bare otherwise', () => {
    const entries: ManagedBlockEntry[] = [
      { name: 'parent', kind: 'id', value: 'LP-9' },
      { name: 'depends_on', kind: 'ids', value: ['LP-4', 'LP-7', 'LP-99'] },
    ];
    const block = renderManagedBlock(entries, EXAMPLE_LINKS);
    expect(block).toContain('| parent | [LP-9](https://github.com/acme/payments/issues/418) |');
    expect(block).toContain(
      '| depends_on | [LP-4](https://github.com/acme/payments/issues/404), [LP-7](https://github.com/acme/payments/issues/407), LP-99 |',
    );
  });

  it('keeps the local id as the link text so a pull can parse it back', () => {
    const block = renderManagedBlock([{ name: 'parent', kind: 'id', value: 'LP-9' }], EXAMPLE_LINKS);
    const match = /\| parent \| \[(LP-9)\]\(/.exec(block);
    expect(match?.[1]).toBe('LP-9');
  });

  it('contains no timestamps', () => {
    const block = renderManagedBlock(EXAMPLE_ENTRIES, EXAMPLE_LINKS);
    expect(block).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('returns an empty string for an empty entry list', () => {
    expect(renderManagedBlock([])).toBe('');
  });
});

// ---------------------------------------------------------------------------
// applyManagedBlock — append
// ---------------------------------------------------------------------------

describe('applyManagedBlock', () => {
  it('appends the block at the end of the body', () => {
    const result = applyManagedBlock('As a user, I want…', EXAMPLE_ENTRIES);
    expect(result).toBe(`As a user, I want…\n\n${renderManagedBlock(EXAMPLE_ENTRIES)}`);
  });

  it('appends to an empty body with no leading blank line', () => {
    expect(applyManagedBlock('', EXAMPLE_ENTRIES)).toBe(renderManagedBlock(EXAMPLE_ENTRIES));
  });

  it('normalises trailing whitespace before appending', () => {
    expect(applyManagedBlock('prose\n\n\n', EXAMPLE_ENTRIES)).toBe(
      `prose\n\n${renderManagedBlock(EXAMPLE_ENTRIES)}`,
    );
  });

  it('is idempotent: applying the same entries twice gives the same body', () => {
    const once = applyManagedBlock('prose', EXAMPLE_ENTRIES);
    expect(applyManagedBlock(once, EXAMPLE_ENTRIES)).toBe(once);
  });
});

// ---------------------------------------------------------------------------
// applyManagedBlock — replace in place
// ---------------------------------------------------------------------------

describe('applyManagedBlock — replace in place', () => {
  it('replaces an existing block rather than appending a second one', () => {
    const body = [
      'As a user, I want…',
      '',
      MANAGED_BLOCK_BEGIN,
      '| light-plan | |',
      '| --- | --- |',
      '| id | LP-99 |',
      MANAGED_BLOCK_END,
    ].join('\n');

    const result = applyManagedBlock(body, EXAMPLE_ENTRIES);
    expect(result).toBe(`As a user, I want…\n\n${renderManagedBlock(EXAMPLE_ENTRIES)}`);
    expect(result.split(MANAGED_BLOCK_BEGIN)).toHaveLength(2); // exactly one block
    expect(result.split(MANAGED_BLOCK_END)).toHaveLength(2);
  });

  it('preserves prose a human wrote above and below the block', () => {
    const body = [
      'Above.',
      '',
      MANAGED_BLOCK_BEGIN,
      '| light-plan | |',
      '| --- | --- |',
      '| id | LP-99 |',
      MANAGED_BLOCK_END,
      '',
      'Below.',
    ].join('\n');

    const result = applyManagedBlock(body, EXAMPLE_ENTRIES);
    expect(result).toBe(`Above.\n\n${renderManagedBlock(EXAMPLE_ENTRIES)}\n\nBelow.`);
  });

  it('is idempotent when replacing in place', () => {
    const body = `prose\n\n${renderManagedBlock([{ name: 'id', kind: 'text', value: 'LP-99' }])}`;
    const once = applyManagedBlock(body, EXAMPLE_ENTRIES);
    expect(applyManagedBlock(once, EXAMPLE_ENTRIES)).toBe(once);
  });
});

// ---------------------------------------------------------------------------
// applyManagedBlock — remove
// ---------------------------------------------------------------------------

describe('applyManagedBlock — remove', () => {
  it('removes an existing block when there are no fields', () => {
    const body = `prose\n\n${renderManagedBlock(EXAMPLE_ENTRIES)}`;
    expect(applyManagedBlock(body, [])).toBe('prose');
  });

  it('removes a block that sits between prose, collapsing the gap', () => {
    const body = `Above.\n\n${renderManagedBlock(EXAMPLE_ENTRIES)}\n\nBelow.`;
    expect(applyManagedBlock(body, [])).toBe('Above.\n\nBelow.');
  });

  it('leaves a body with no block unchanged', () => {
    expect(applyManagedBlock('prose', [])).toBe('prose');
    expect(applyManagedBlock('', [])).toBe('');
  });

  it('removing is idempotent', () => {
    const body = `prose\n\n${renderManagedBlock(EXAMPLE_ENTRIES)}`;
    expect(applyManagedBlock(applyManagedBlock(body, []), [])).toBe('prose');
  });
});

// ---------------------------------------------------------------------------
// Round-trip shape
// ---------------------------------------------------------------------------

describe('round-trip shape', () => {
  it('produces a block the strip in links.ts would remove entirely', () => {
    const block = renderManagedBlock(EXAMPLE_ENTRIES);
    expect(block.startsWith(`${MANAGED_BLOCK_BEGIN}\n`)).toBe(true);
    expect(block.endsWith(`\n${MANAGED_BLOCK_END}`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseManagedBlock — prose preservation
// ---------------------------------------------------------------------------

describe('parseManagedBlock', () => {
  const BLOCK = renderManagedBlock(EXAMPLE_ENTRIES);

  it('strips the block and preserves prose above and below byte for byte', () => {
    const above = 'First paragraph.\n\nSecond paragraph with *emphasis*.';
    const below = 'Third paragraph.\n\nFourth paragraph.';
    const body = `${above}\n\n${BLOCK}\n\n${below}`;

    const parsed = parseManagedBlock(body);
    expect(parsed.found).toBe(true);
    expect(parsed.body).toBe(`${above}\n\n${below}`);
    expect(parsed.warnings).toEqual([]);
  });

  it('handles a block at the very end', () => {
    const parsed = parseManagedBlock(`prose\n\n${BLOCK}`);
    expect(parsed.found).toBe(true);
    expect(parsed.body).toBe('prose');
  });

  it('handles a block at the very start', () => {
    const parsed = parseManagedBlock(`${BLOCK}\n\nprose`);
    expect(parsed.found).toBe(true);
    expect(parsed.body).toBe('prose');
  });

  it('returns an empty body when the body is only a block', () => {
    const parsed = parseManagedBlock(BLOCK);
    expect(parsed.found).toBe(true);
    expect(parsed.body).toBe('');
  });

  it('preserves leading whitespace of the prose before the block', () => {
    const parsed = parseManagedBlock(`    indented code\n\n${BLOCK}`);
    expect(parsed.body).toBe('    indented code');
  });

  it('leaves a body with no block unchanged and reports nothing', () => {
    const parsed = parseManagedBlock('plain prose, no block');
    expect(parsed.found).toBe(false);
    expect(parsed.body).toBe('plain prose, no block');
    expect(parsed.fields).toEqual({});
    expect(parsed.warnings).toEqual([]);
  });

  it('recovers every field from the table', () => {
    const parsed = parseManagedBlock(`prose\n\n${BLOCK}`);
    expect(parsed.fields).toEqual({
      depends_on: 'LP-4, LP-7',
      id: 'LP-12',
      parent: 'LP-9',
      type: 'user_story',
    });
  });

  it('returns link-wrapped id cells raw, for parseManagedId to unwrap', () => {
    const block = renderManagedBlock(EXAMPLE_ENTRIES, EXAMPLE_LINKS);
    const parsed = parseManagedBlock(block);
    expect(parsed.fields.parent).toBe('[LP-9](https://github.com/acme/payments/issues/418)');
    expect(parseManagedId(parsed.fields.parent!)).toBe('LP-9');
  });
});

// ---------------------------------------------------------------------------
// parseManagedBlock — mangled blocks
// ---------------------------------------------------------------------------

describe('parseManagedBlock — mangled blocks', () => {
  it('degrades to no block when the end marker is gone', () => {
    const body = `prose\n\n${MANAGED_BLOCK_BEGIN}\n| id | LP-12 |`;
    const parsed = parseManagedBlock(body);

    expect(parsed.found).toBe(false);
    expect(parsed.body).toBe(body); // unchanged — nothing is destroyed
    expect(parsed.fields).toEqual({});
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });

  it('reports a stray end marker with no begin', () => {
    const parsed = parseManagedBlock(`prose\n\n${MANAGED_BLOCK_END}`);
    expect(parsed.found).toBe(false);
    expect(parsed.fields).toEqual({});
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });

  it('warns when the delimiters survive but no row is readable', () => {
    const body = `prose\n\n${MANAGED_BLOCK_BEGIN}\nsome human note\n${MANAGED_BLOCK_END}`;
    const parsed = parseManagedBlock(body);

    expect(parsed.found).toBe(true); // boundaries known, so the block is stripped
    expect(parsed.body).toBe('prose');
    expect(parsed.fields).toEqual({});
    expect(parsed.warnings.some((w) => w.includes('no readable fields'))).toBe(true);
  });

  it('drops a hand-edited row rather than wiping the field silently', () => {
    const block = renderManagedBlock([
      { name: 'id', kind: 'text', value: 'LP-12' },
      { name: 'depends_on', kind: 'ids', value: ['LP-4', 'LP-7'] },
    ]);
    const body = block.replace(/\| depends_on \| .*/, 'this row was hand-edited');
    const parsed = parseManagedBlock(body);

    // depends_on is absent, not '' — the caller can tell it must fall back.
    expect(parsed.fields.id).toBe('LP-12');
    expect(parsed.fields.depends_on).toBeUndefined();
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });

  it('never throws on arbitrary garbage between delimiters', () => {
    const bodies = [
      `${MANAGED_BLOCK_BEGIN}\n\n\n${MANAGED_BLOCK_END}`,
      `${MANAGED_BLOCK_BEGIN}\n| | |\n${MANAGED_BLOCK_END}`,
      `${MANAGED_BLOCK_BEGIN}\nnot a table at all\n${MANAGED_BLOCK_END}`,
      `${MANAGED_BLOCK_BEGIN}${MANAGED_BLOCK_END}`,
    ];
    for (const body of bodies) {
      expect(() => parseManagedBlock(body)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// parseManagedBlock — duplicate blocks
// ---------------------------------------------------------------------------

describe('parseManagedBlock — duplicate blocks', () => {
  it('uses the first block and reports the duplicate', () => {
    const first = renderManagedBlock(EXAMPLE_ENTRIES);
    const second = renderManagedBlock([{ name: 'type', kind: 'text', value: 'task' }]);
    const body = `above\n\n${first}\n\n${second}\n\nbelow`;

    const parsed = parseManagedBlock(body);
    expect(parsed.found).toBe(true);
    // First block wins — its type survives, the duplicate's does not.
    expect(parsed.fields.type).toBe('user_story');
    expect(parsed.warnings.some((w) => w.includes('2 managed blocks'))).toBe(true);
    // Both blocks are our output, so both are stripped.
    expect(parsed.body).toBe('above\n\nbelow');
  });

  it('does not merge a dangling begin with a later well-formed block', () => {
    const block = renderManagedBlock(EXAMPLE_ENTRIES);
    const body = `above\n\n${MANAGED_BLOCK_BEGIN}\nmangled prose\n\n${block}\n\nbelow`;

    const parsed = parseManagedBlock(body);
    expect(parsed.found).toBe(true);
    // The unclosed begin and its text survive as prose; only the real block is
    // stripped, and its fields are the ones recovered.
    expect(parsed.body).toBe(`above\n\n${MANAGED_BLOCK_BEGIN}\nmangled prose\n\nbelow`);
    expect(parsed.warnings.some((w) => w.includes('no matching end marker'))).toBe(true);
    expect(parsed.fields.id).toBe('LP-12');
  });
});

// ---------------------------------------------------------------------------
// parseManagedBlock — normalisation (Jira ADF round-trip)
// ---------------------------------------------------------------------------

describe('parseManagedBlock — normalisation', () => {
  it('finds the delimiters in a CRLF body exactly as in an LF one', () => {
    const lf = `above\n\n${renderManagedBlock(EXAMPLE_ENTRIES)}\n\nbelow`;
    const crlf = lf.replace(/\n/g, '\r\n');

    const parsedLf = parseManagedBlock(lf);
    const parsedCrlf = parseManagedBlock(crlf);
    expect(parsedCrlf.found).toBe(true);
    expect(parsedCrlf.body).toBe(parsedLf.body);
    expect(parsedCrlf.fields).toEqual(parsedLf.fields);
  });

  it('normalises lone carriage returns too', () => {
    const body = `above\n\n${renderManagedBlock(EXAMPLE_ENTRIES)}\n\nbelow`.replace(/\n/g, '\r');
    expect(parseManagedBlock(body).found).toBe(true);
    expect(parseManagedBlock(body).body).toBe('above\n\nbelow');
  });
});

// ---------------------------------------------------------------------------
// parseManagedId / parseManagedIdList
// ---------------------------------------------------------------------------

describe('parseManagedId / parseManagedIdList', () => {
  it('returns a bare id unchanged', () => {
    expect(parseManagedId('LP-9')).toBe('LP-9');
  });

  it('unwraps a markdown link to its link text', () => {
    expect(parseManagedId('[LP-9](https://github.com/acme/payments/issues/418)')).toBe('LP-9');
  });

  it('splits a comma-separated list and unwraps each link', () => {
    expect(
      parseManagedIdList('[LP-4](https://github.com/acme/payments/issues/404), [LP-7](https://github.com/acme/payments/issues/407), LP-99'),
    ).toEqual(['LP-4', 'LP-7', 'LP-99']);
  });

  it('tolerates a separator the remote reformatted (no space, extra space)', () => {
    expect(parseManagedIdList('LP-4,LP-7')).toEqual(['LP-4', 'LP-7']);
    expect(parseManagedIdList('LP-4 ,  LP-7')).toEqual(['LP-4', 'LP-7']);
  });

  it('returns an empty list for an empty cell', () => {
    expect(parseManagedIdList('')).toEqual([]);
    expect(parseManagedIdList('   ')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// refs — remote `#418` references (LP-314)
// ---------------------------------------------------------------------------

describe('refs entries — remote references', () => {
  it('renders remote ids as `#<id>` references, sorted', () => {
    const block = renderManagedBlock([
      refsEntry('depends_on', ['418', '407']),
      refsEntry('relates_to', ['12']),
    ]);
    expect(block).toContain('| depends_on | #407, #418 |');
    expect(block).toContain('| relates_to | #12 |');
  });

  it('renders a bare `#<id>` that a platform turns into a link', () => {
    const block = renderManagedBlock([refsEntry('depends_on', ['418'])]);
    expect(block).toContain('| depends_on | #418 |');
    // The `#418` token is the whole point: no markdown link wrapper, because
    // GitHub links a bare `#418` itself and shows a back-reference.
    expect(block).not.toMatch(/\[[^\]]+\]\([^)]*\)/);
  });
});

describe('parseManagedRefs', () => {
  it('classifies same-repo `#418`, cross-repo `owner/repo#12`, and unknown tokens', () => {
    expect(parseManagedRefs('#418, #407')).toEqual({
      refs: ['418', '407'],
      crossRepo: [],
      unknown: [],
    });
    expect(parseManagedRefs('acme/payments#12')).toEqual({
      refs: [],
      crossRepo: ['acme/payments#12'],
      unknown: [],
    });
    expect(parseManagedRefs('#418, acme/other#9, LP-404')).toEqual({
      refs: ['418'],
      crossRepo: ['acme/other#9'],
      unknown: ['LP-404'],
    });
  });

  it('tolerates a separator the remote reformatted', () => {
    expect(parseManagedRefs('#418,#407')).toEqual({ refs: ['418', '407'], crossRepo: [], unknown: [] });
    expect(parseManagedRefs('#418 ,  #407')).toEqual({ refs: ['418', '407'], crossRepo: [], unknown: [] });
  });

  it('returns empty buckets for an empty cell', () => {
    expect(parseManagedRefs('')).toEqual({ refs: [], crossRepo: [], unknown: [] });
    expect(parseManagedRefs('   ')).toEqual({ refs: [], crossRepo: [], unknown: [] });
  });

  it('round-trips through the block writer and reader', () => {
    const body = applyManagedBlock('prose', [refsEntry('depends_on', ['418', '12'])]);
    const parsed = parseManagedBlock(body);
    expect(parseManagedRefs(parsed.fields.depends_on!)).toEqual({
      refs: ['12', '418'],
      crossRepo: [],
      unknown: [],
    });
  });
});

// ---------------------------------------------------------------------------
// Property-style tests: random prose, random position, random damage
// ---------------------------------------------------------------------------

/** A small deterministic PRNG (mulberry32) so the property tests reproduce. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta',
  'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'rho',
  'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega',
  'one', 'two', 'three', 'four', 'five', 'six',
];

/** Random prose: words joined by spaces and newlines, never the delimiters. */
function randomProse(rng: () => number): string {
  const count = Math.floor(rng() * 14);
  const words: string[] = [];
  for (let i = 0; i < count; i += 1) {
    words.push(WORDS[Math.floor(rng() * WORDS.length)]!);
  }
  let out = '';
  for (let i = 0; i < words.length; i += 1) {
    if (i > 0) out += rng() < 0.8 ? ' ' : rng() < 0.5 ? '\n' : '\n\n';
    out += words[i];
  }
  return out;
}

const RANDOM_ENTRIES: ManagedBlockEntry[] = [
  { name: 'id', kind: 'text', value: 'LP-42' },
  { name: 'type', kind: 'text', value: 'user_story' },
  { name: 'parent', kind: 'id', value: 'LP-9' },
  { name: 'depends_on', kind: 'ids', value: ['LP-4', 'LP-7', 'LP-2'] },
  { name: 'story_points', kind: 'text', value: '5' },
];

describe('property: our own block round-trips', () => {
  const rng = mulberry32(0x2f77);

  it('prose survives and every field parses back, for 200 random bodies', () => {
    for (let i = 0; i < 200; i += 1) {
      const prose = randomProse(rng);
      const parsed = parseManagedBlock(applyManagedBlock(prose, RANDOM_ENTRIES));

      expect(parsed.found).toBe(true);
      expect(parsed.body).toBe(prose.trimEnd());
      expect(parsed.warnings).toEqual([]);
      expect(parsed.fields.type).toBe('user_story');
      expect(parseManagedId(parsed.fields.parent!)).toBe('LP-9');
      expect(parseManagedIdList(parsed.fields.depends_on!)).toEqual(['LP-2', 'LP-4', 'LP-7']);
    }
  });

  it('survives a random block position and random surrounding whitespace', () => {
    const rng2 = mulberry32(0x42cafe);
    const block = renderManagedBlock(RANDOM_ENTRIES);

    for (let i = 0; i < 200; i += 1) {
      const above = randomProse(rng2);
      const below = randomProse(rng2);
      // **At least one newline**, because a delimiter is only a delimiter when it
      // begins a line (LP-534) and `applyManagedBlock` always separates the block
      // with a blank line. Zero newlines glues `begin` onto the end of a prose
      // line, which is now read as prose — see the case below, which asserts that
      // deliberately rather than leaving it to a generator to stumble on.
      const ws = () => '\n'.repeat(1 + Math.floor(rng2() * 3));
      const body = `${above}${ws()}${block}${ws()}${below}`;

      const parsed = parseManagedBlock(body);
      expect(parsed.found).toBe(true);
      expect(parsed.warnings).toEqual([]);
      expect(parsed.body).toBe([above, below].filter((p) => p !== '').join('\n\n'));
      expect(parsed.fields.id).toBe('LP-42');
    }
  });

  it('reads a delimiter glued onto the end of a prose line as prose', () => {
    // The one thing the line-start rule gives up, stated rather than discovered.
    // `applyManagedBlock` always separates the block with a blank line, so this
    // body is not one we write; it is one a remote's editor could produce by
    // stripping the separator. Reading it as prose is the safe failure: the block
    // content stays visible and the fields ride again on the next push. The
    // permissive alternative — matching a marker anywhere — destroyed the prose of
    // five real documents that merely *described* the delimiters, which is not
    // recoverable at all.
    const glued = `Prose that runs straight into it ${MANAGED_BLOCK_BEGIN}\n| light-plan | |\n| --- | --- |\n| parent | LP-1 |\n${MANAGED_BLOCK_END}`;
    const parsed = parseManagedBlock(glued);

    expect(parsed.found).toBe(false);
    expect(parsed.fields).toEqual({});
    // Nothing is lost: the whole body, block text included, comes back as prose.
    expect(parsed.body).toBe(glued);
  });

  it('degrades rather than crashes for 200 random damages', () => {
    const rng3 = mulberry32(0xda74);

    for (let i = 0; i < 200; i += 1) {
      const prose = randomProse(rng3);
      let body = applyManagedBlock(prose, RANDOM_ENTRIES);

      const damage = Math.floor(rng3() * 3);
      if (damage === 0) {
        body = body.replace(MANAGED_BLOCK_END, '');
      } else if (damage === 1) {
        body = body.replace(MANAGED_BLOCK_BEGIN, '');
      } else {
        body = body.replace(/\| depends_on \| .*/, 'this row was hand-edited');
      }

      const parsed = parseManagedBlock(body); // must never throw

      if (damage <= 1) {
        expect(parsed.found).toBe(false);
        expect(parsed.fields).toEqual({});
        expect(parsed.warnings.length).toBeGreaterThan(0);
      } else {
        // The block survives, but the mangled field is absent — a fallback
        // signal, never a silent empty list.
        expect(parsed.found).toBe(true);
        expect(parsed.fields.depends_on).toBeUndefined();
        expect(parsed.warnings.length).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// A body whose own prose contains the delimiters (LP-534)
// ---------------------------------------------------------------------------

/**
 * A document may talk about the block without *being* the block.
 *
 * `splitManagedBlock` used to match the first `begin` marker anywhere in the
 * body, so a document whose prose described the delimiters had everything between
 * its own two mentions replaced by the block — on every push. Five documents on
 * this repository's own board were corrupted that way (LP-276, LP-322, LP-503,
 * LP-509 and LP-534, which is the bug report), and because the damage was on the
 * *remote* while the board was untouched, they then sat permanently "to push"
 * with nothing anybody had edited.
 *
 * The discriminator is that a real delimiter **begins a line** —
 * `renderManagedBlock` writes them that way and always has — while a mention
 * inside a sentence does not. Checked against all five real bodies before it was
 * written: every one of their mentions was mid-line.
 */
describe('a body whose prose mentions the delimiters (LP-534)', () => {
  const prose = [
    'The block sits between `<!-- lpm:begin -->` WORDS-IN-THE-MIDDLE `<!-- lpm:end -->`',
    'and this trailing sentence is also part of the prose.',
  ].join('\n');

  const entries: ManagedBlockEntry[] = [{ name: 'parent', kind: 'id', value: 'LP-9' }];

  it('leaves the prose alone and appends the block after it', () => {
    const withBlock = applyManagedBlock(prose, entries);

    expect(withBlock).toContain('WORDS-IN-THE-MIDDLE');
    expect(withBlock).toContain('and this trailing sentence is also part of the prose.');
    // The block is appended, so the prose comes first and the block last.
    expect(withBlock.indexOf('WORDS-IN-THE-MIDDLE')).toBeLessThan(
      withBlock.lastIndexOf('| parent | LP-9 |'),
    );
  });

  it('round-trips: the prose parses back byte for byte', () => {
    // The property that makes the document stop being permanently ahead — what
    // the push writes, the pull recovers, so the base and the board agree.
    const parsed = parseManagedBlock(applyManagedBlock(prose, entries));

    expect(parsed.found).toBe(true);
    expect(parsed.body).toBe(prose);
    expect(parsed.fields['parent']).toBe('LP-9');
  });

  it('is idempotent, so a second push writes nothing new', () => {
    const once = applyManagedBlock(prose, entries);
    expect(applyManagedBlock(once, entries)).toBe(once);
  });

  it('still replaces a real block in place when the prose also mentions one', () => {
    // The hard case: a document that both describes the delimiters *and* carries a
    // real block. The real one begins a line; the mentions do not.
    const once = applyManagedBlock(prose, entries);
    const updated = applyManagedBlock(once, [{ name: 'parent', kind: 'id', value: 'LP-42' }]);

    expect(updated).toContain('WORDS-IN-THE-MIDDLE');
    expect(updated).toContain('| parent | LP-42 |');
    expect(updated).not.toContain('| parent | LP-9 |');
    // One block, not two.
    expect(updated.split(MANAGED_BLOCK_BEGIN).length - 1).toBe(2); // the prose mention + the block
    expect(parseManagedBlock(updated).body).toBe(prose);
  });

  it('removes a real block without touching the prose that describes it', () => {
    const once = applyManagedBlock(prose, entries);
    expect(applyManagedBlock(once, [])).toBe(prose);
  });

  it('finds a block whose delimiters are indented', () => {
    // "Begins a line" means the marker is the first thing on it, not that it is at
    // column zero — a remote's editor may indent what it round-trips.
    const body = `Prose.\n\n  ${MANAGED_BLOCK_BEGIN}\n| light-plan | |\n| --- | --- |\n| parent | LP-1 |\n  ${MANAGED_BLOCK_END}`;
    const parsed = parseManagedBlock(body);
    expect(parsed.found).toBe(true);
    expect(parsed.fields['parent']).toBe('LP-1');
  });
});
