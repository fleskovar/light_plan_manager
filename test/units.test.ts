import { describe, expect, it } from 'vitest';
import type { AttributeDef } from '../src/core/index.js';
import {
  derivePrefix,
  firstHeading,
  idFromDirName,
  isEmpty,
  nodeDirName,
  numberOf,
  parseAttributeInput,
  parseFrontmatter,
  slugify,
  stringifyFrontmatter,
  titleFromDirName,
  validateAttributeValue,
} from '../src/core/index.js';

describe('slugify', () => {
  it.each([
    ['Guest checkout', 'guest-checkout'],
    ['  Spaces  everywhere  ', 'spaces-everywhere'],
    ['Café münchen', 'cafe-munchen'],
    ['C++ / C# support!', 'c-c-support'],
    ['---', 'untitled'],
    ['', 'untitled'],
  ])('%j -> %j', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('truncates without leaving a trailing dash', () => {
    const slug = slugify('a'.repeat(50) + ' ' + 'b'.repeat(50));
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('folder names', () => {
  it('names a folder after the id alone', () => {
    expect(nodeDirName('LP-12')).toBe('LP-12');
    expect(nodeDirName('TL-3')).toBe('TL-3');
  });

  it.each([
    ['LP-12-guest-checkout', 'LP', 'LP-12'],
    ['LP-12', 'LP', 'LP-12'],
    ['LP12-guest', 'LP', null],
    ['guest-checkout', 'LP', null],
    ['ACME-3-x', 'LP', null],
  ])('idFromDirName(%j, %j)', (name, prefix, expected) => {
    expect(idFromDirName(name, prefix)).toBe(expected);
  });

  it('recovers a readable title from a folder name', () => {
    expect(titleFromDirName('LP-12-guest-checkout', 'LP')).toBe('Guest checkout');
    expect(titleFromDirName('saved-cards', 'LP')).toBe('Saved cards');
  });

  it('extracts the numeric part of an id', () => {
    expect(numberOf('LP-12', 'LP')).toBe(12);
    expect(numberOf('ACME-3', 'LP')).toBe(0);
    expect(numberOf('LP-x', 'LP')).toBe(0);
  });
});

describe('derivePrefix', () => {
  it.each([
    ['light_plan', 'LP'],
    ['my-cool-app', 'MCA'],
    ['myapp', 'MY'],
    ['2fast', 'LP'],
    ['', 'LP'],
  ])('%j -> %j', (input, expected) => {
    expect(derivePrefix(input)).toBe(expected);
  });
});

describe('frontmatter', () => {
  it('round-trips data and body', () => {
    const text = stringifyFrontmatter({ id: 'LP-1', title: 'Hi' }, '## Body\n\ntext');
    const parsed = parseFrontmatter(text);
    expect(parsed.data).toEqual({ id: 'LP-1', title: 'Hi' });
    expect(parsed.body.trim()).toBe('## Body\n\ntext');
  });

  it('handles a document with no frontmatter', () => {
    const parsed = parseFrontmatter('# Title\n\nbody');
    expect(parsed.hadFrontmatter).toBe(false);
    expect(parsed.data).toEqual({});
    expect(parsed.body).toBe('# Title\n\nbody');
  });

  it('handles an empty frontmatter block', () => {
    const parsed = parseFrontmatter('---\n---\nbody\n');
    expect(parsed.hadFrontmatter).toBe(true);
    expect(parsed.data).toEqual({});
    expect(parsed.body).toBe('body\n');
  });

  it('handles CRLF line endings', () => {
    const parsed = parseFrontmatter('---\r\nid: LP-1\r\n---\r\nbody\r\n');
    expect(parsed.data).toEqual({ id: 'LP-1' });
    expect(parsed.body).toBe('body\r\n');
  });

  it('does not treat a horizontal rule in the body as frontmatter', () => {
    const parsed = parseFrontmatter('text\n\n---\n\nmore');
    expect(parsed.hadFrontmatter).toBe(false);
  });

  it('throws on duplicate keys', () => {
    expect(() => parseFrontmatter('---\nid: A\nid: B\n---\n')).toThrow();
  });

  it('reads only level-1 headings for titles', () => {
    expect(firstHeading('## Summary\n\n# Real title')).toBe('Real title');
    expect(firstHeading('## Summary only')).toBeNull();
  });
});

describe('attribute values', () => {
  const def = (over: Partial<AttributeDef>): AttributeDef =>
    ({ type: 'string', ...over }) as AttributeDef;

  it.each([
    ['int', '3', 3],
    ['int', '-2', -2],
    ['float', '1.5', 1.5],
    ['bool', 'yes', true],
    ['bool', 'FALSE', false],
    ['date', '2026-09-30', '2026-09-30'],
    ['string', ' keep spaces ', ' keep spaces '],
  ] as const)('parses %s input %j', (type, raw, expected) => {
    expect(parseAttributeInput(def({ type }), raw).value).toEqual(expected);
  });

  it('parses a comma-separated array, dropping blanks', () => {
    expect(parseAttributeInput(def({ type: 'array' }), 'a, b , ,c').value).toEqual(['a', 'b', 'c']);
  });

  it.each([
    ['int', 'big'],
    ['int', '3.5'],
    ['float', ''],
    ['bool', 'maybe'],
    ['date', '30-09-2026'],
    ['date', '2026-13-01'],
    ['date', '2026-02-30'],
  ] as const)('rejects %s input %j', (type, raw) => {
    expect(parseAttributeInput(def({ type }), raw).error).toBeTruthy();
  });

  it('enforces enum values both ways', () => {
    const enumDef = def({ type: 'enum', values: ['high', 'low'] });
    expect(parseAttributeInput(enumDef, 'high').value).toBe('high');
    expect(parseAttributeInput(enumDef, 'urgent').error).toMatch(/expected one of \[high, low\]/);
  });

  it('validates values already present in frontmatter', () => {
    expect(validateAttributeValue(def({ type: 'int' }), 3)).toBeNull();
    expect(validateAttributeValue(def({ type: 'int' }), 3.5)).toMatch(/integer/);
    expect(validateAttributeValue(def({ type: 'array' }), 'nope')).toMatch(/list/);
    expect(validateAttributeValue(def({ type: 'date' }), '2026-09-30')).toBeNull();
    expect(validateAttributeValue(def({ type: 'date' }), '2026-13-01')).toMatch(/date/);
    expect(validateAttributeValue(def({ type: 'string' }), null)).toBeNull();
  });

  it('treats blank strings and empty lists as empty', () => {
    expect(isEmpty('')).toBe(true);
    expect(isEmpty('  ')).toBe(true);
    expect(isEmpty([])).toBe(true);
    expect(isEmpty(null)).toBe(true);
    expect(isEmpty(0)).toBe(false);
    expect(isEmpty(false)).toBe(false);
  });
});
