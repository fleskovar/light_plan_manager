import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_MARKER,
  appendActivityEntry,
  mergeActivity,
  parseActivity,
  splitActivity,
} from '../src/core/storage/activity.js';

// ---------------------------------------------------------------------------
// splitActivity
// ---------------------------------------------------------------------------

describe('splitActivity', () => {
  it('returns the whole body as prose when there is no marker', () => {
    const body = 'Some prose.\n\nMore prose.';
    const { prose, activity } = splitActivity(body);
    expect(prose).toBe(body);
    expect(activity).toBe('');
  });

  it('splits at the first marker, keeping the marker in activity', () => {
    const body = [
      'Prose before.',
      '',
      ACTIVITY_MARKER,
      '',
      '## Activity',
      '',
      '### 2026-08-10T14:00:00.000Z — alice — flagged: blocked',
      '',
      'Waiting.',
    ].join('\n');

    const { prose, activity } = splitActivity(body);
    expect(prose).toBe('Prose before.');
    expect(activity.startsWith(ACTIVITY_MARKER)).toBe(true);
    expect(activity).toContain('## Activity');
    expect(activity).toContain('Waiting.');
  });

  it('a second marker later in the body stays inside activity verbatim', () => {
    const body = [
      'Prose.',
      '',
      ACTIVITY_MARKER,
      '',
      '## Activity',
      '',
      '### 2026-08-10T14:00:00.000Z — alice — flagged: blocked',
      '',
      'Waiting.',
      '',
      ACTIVITY_MARKER, // hand-written second marker
      '',
      'More stuff.',
    ].join('\n');

    const { prose, activity } = splitActivity(body);
    expect(prose).toBe('Prose.');
    // The second marker is inside activity — count occurrences
    const occurrences = activity.split(ACTIVITY_MARKER).length - 1;
    expect(occurrences).toBe(2);
  });

  it('handles an empty body', () => {
    const { prose, activity } = splitActivity('');
    expect(prose).toBe('');
    expect(activity).toBe('');
  });

  it('handles a body that is only the marker', () => {
    const { prose, activity } = splitActivity(ACTIVITY_MARKER);
    expect(prose).toBe('');
    expect(activity).toBe(ACTIVITY_MARKER);
  });

  it('handles a marker mid-prose (not at end)', () => {
    const body = [
      'Top prose.',
      '',
      ACTIVITY_MARKER,
      '',
      '## Activity',
      '',
      '### 2026-08-10T14:00:00.000Z — alice — flagged: blocked',
      '',
      'Note.',
      '',
      'Trailing prose after the activity block.',
    ].join('\n');

    const { prose, activity } = splitActivity(body);
    expect(prose).toBe('Top prose.');
    // Everything from the marker to EOF is activity, including the "trailing prose"
    expect(activity).toContain('Trailing prose after the activity block.');
  });
});

// ---------------------------------------------------------------------------
// appendActivityEntry
// ---------------------------------------------------------------------------

describe('appendActivityEntry', () => {
  const entry = {
    at: '2026-08-10T14:03:11.000Z',
    author: 'fran',
    heading: 'flagged: blocked',
    text: 'Waiting on the API contract from LP-12.',
  };

  it('appends an entry to a body with no activity section, creating marker + heading', () => {
    const body = 'Some prose.';
    const result = appendActivityEntry(body, entry);

    expect(result).toContain('Some prose.');
    expect(result).toContain(ACTIVITY_MARKER);
    expect(result).toContain('## Activity');
    expect(result).toContain('### 2026-08-10T14:03:11.000Z — fran — flagged: blocked');
    expect(result).toContain('Waiting on the API contract from LP-12.');
  });

  it('appends to an existing activity section', () => {
    const body = [
      'Prose.',
      '',
      ACTIVITY_MARKER,
      '',
      '## Activity',
      '',
      '### 2026-08-09T10:00:00.000Z — alice — flagged: help',
      '',
      'First entry.',
    ].join('\n');

    const second = {
      at: '2026-08-10T15:00:00.000Z',
      author: 'bob',
      heading: 'flag cleared',
      text: 'Resolved.',
    };

    const result = appendActivityEntry(body, second);

    // Both entries present, in order
    expect(result).toContain('### 2026-08-09T10:00:00.000Z — alice — flagged: help');
    expect(result).toContain('First entry.');
    expect(result).toContain('### 2026-08-10T15:00:00.000Z — bob — flag cleared');
    expect(result).toContain('Resolved.');

    // Order: first entry before second
    const firstIdx = result.indexOf('alice');
    const secondIdx = result.indexOf('bob');
    expect(firstIdx).toBeLessThan(secondIdx);

    // Only one marker
    const occurrences = result.split(ACTIVITY_MARKER).length - 1;
    expect(occurrences).toBe(1);
  });

  it('appends to an empty body', () => {
    const result = appendActivityEntry('', entry);
    expect(result.trimStart().startsWith(ACTIVITY_MARKER)).toBe(true);
    expect(result).toContain('flagged: blocked');
  });

  it('handles an entry with empty text', () => {
    const noText = { ...entry, text: '' };
    const result = appendActivityEntry('Prose.', noText);
    expect(result).toContain('### 2026-08-10T14:03:11.000Z — fran — flagged: blocked');
    // Should not have a blank line after the heading when text is empty
    expect(result).not.toMatch(/\n\n\n$/);
  });

  it('round-trips: split the output and parse it back', () => {
    const body = 'Prose.';
    const result = appendActivityEntry(body, entry);
    const parsed = parseActivity(result);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]!).toMatchObject({
      at: entry.at,
      author: entry.author,
      heading: entry.heading,
      text: entry.text,
    });
  });

  it('round-trips with multiple entries', () => {
    let body = 'Prose.';
    body = appendActivityEntry(body, {
      at: '2026-08-09T10:00:00.000Z',
      author: 'alice',
      heading: 'flagged: help',
      text: 'First.',
    });
    body = appendActivityEntry(body, {
      at: '2026-08-10T15:00:00.000Z',
      author: 'bob',
      heading: 'flag cleared',
      text: 'Second.',
    });

    const parsed = parseActivity(body);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.author).toBe('alice');
    expect(parsed[1]!.author).toBe('bob');
    expect(parsed[0]!.text).toBe('First.');
    expect(parsed[1]!.text).toBe('Second.');
  });
});

// ---------------------------------------------------------------------------
// mergeActivity
// ---------------------------------------------------------------------------

describe('mergeActivity', () => {
  const diskBody = [
    'Some prose.',
    '',
    ACTIVITY_MARKER,
    '',
    '## Activity',
    '',
    '### 2026-08-09T10:00:00.000Z — alice — flagged: help',
    '',
    'First entry.',
    '',
    '### 2026-08-10T14:00:00.000Z — bob — flag cleared',
    '',
    'Resolved.',
  ].join('\n');

  it('keeps disk history when incoming has no activity section', () => {
    const incoming = 'Updated prose.\n\nMore content.';
    const result = mergeActivity(incoming, diskBody);

    expect(result.startsWith('Updated prose.\n\nMore content.')).toBe(true);
    expect(result).toContain(ACTIVITY_MARKER);
    expect(result).toContain('### 2026-08-09T10:00:00.000Z — alice — flagged: help');
    expect(result).toContain('### 2026-08-10T14:00:00.000Z — bob — flag cleared');
  });

  it('discards a stale activity section in the incoming body', () => {
    const incoming = [
      'Updated prose.',
      '',
      ACTIVITY_MARKER,
      '',
      '## Activity',
      '',
      '### 2026-08-08T09:00:00.000Z — eve — flagged: blocked',
      '',
      'Old stale entry that was pushed after the real events.',
    ].join('\n');

    const result = mergeActivity(incoming, diskBody);

    expect(result.startsWith('Updated prose.')).toBe(true);
    // Stale entry from incoming must be gone
    expect(result).not.toContain('eve');
    expect(result).not.toContain('Old stale entry');
    // Disk entries must be present
    expect(result).toContain('alice');
    expect(result).toContain('bob');
  });

  it('discards a forged activity section (incoming with different events)', () => {
    const incoming = [
      'Prose.',
      '',
      ACTIVITY_MARKER,
      '',
      '## Activity',
      '',
      '### 2026-08-11T12:00:00.000Z — mallory — flagged: blocked',
      '',
      'Forged.',
    ].join('\n');

    const result = mergeActivity(incoming, diskBody);

    expect(result).not.toContain('mallory');
    expect(result).not.toContain('Forged.');
    expect(result).toContain('alice');
    expect(result).toContain('bob');
  });

  it('returns incoming unmodified when disk has no activity section', () => {
    const incoming = 'Prose.';
    const disk = 'Prose.'; // no activity on disk
    const result = mergeActivity(incoming, disk);
    expect(result).toBe('Prose.');
  });

  it('preserves incoming prose when disk has an activity section', () => {
    const incoming = 'Completely different prose.';
    const result = mergeActivity(incoming, diskBody);
    expect(result.startsWith('Completely different prose.')).toBe(true);
    expect(result).toContain('alice');
  });

  it('handles empty incoming body', () => {
    const result = mergeActivity('', diskBody);
    expect(result).toContain(ACTIVITY_MARKER);
    expect(result).toContain('alice');
  });

  it('handles empty disk body', () => {
    const result = mergeActivity('Prose.', '');
    expect(result).toBe('Prose.');
  });

  it('handles both empty', () => {
    const result = mergeActivity('', '');
    expect(result).toBe('');
  });
});

// ---------------------------------------------------------------------------
// parseActivity
// ---------------------------------------------------------------------------

describe('parseActivity', () => {
  it('returns empty for a body with no activity section', () => {
    expect(parseActivity('Just prose.')).toEqual([]);
  });

  it('returns empty for an empty body', () => {
    expect(parseActivity('')).toEqual([]);
  });

  it('parses a single entry', () => {
    const body = [
      'Prose.',
      '',
      ACTIVITY_MARKER,
      '',
      '## Activity',
      '',
      '### 2026-08-10T14:03:11.000Z — fran — flagged: blocked',
      '',
      'Waiting on API contract.',
    ].join('\n');

    const entries = parseActivity(body);
    expect(entries).toHaveLength(1);
    expect(entries[0]!).toMatchObject({
      at: '2026-08-10T14:03:11.000Z',
      author: 'fran',
      heading: 'flagged: blocked',
      text: 'Waiting on API contract.',
    });
  });

  it('parses multiple entries in order', () => {
    const body = [
      'Prose.',
      '',
      ACTIVITY_MARKER,
      '',
      '## Activity',
      '',
      '### 2026-08-09T10:00:00.000Z — alice — flagged: help',
      '',
      'First.',
      '',
      '### 2026-08-10T14:00:00.000Z — bob — flag cleared',
      '',
      'Second.',
      '',
      '### 2026-08-11T09:00:00.000Z — carol — flagged: blocked',
      '',
      'Third, multi-line.',
      '',
      'With more text.',
    ].join('\n');

    const entries = parseActivity(body);
    expect(entries).toHaveLength(3);
    expect(entries[0]!.author).toBe('alice');
    expect(entries[0]!.text).toBe('First.');
    expect(entries[1]!.author).toBe('bob');
    expect(entries[1]!.text).toBe('Second.');
    expect(entries[2]!.author).toBe('carol');
    expect(entries[2]!.text).toBe('Third, multi-line.\n\nWith more text.');
  });

  it('entry heading strictness: ### in prose is not mistaken for an event', () => {
    const body = [
      '### This is a prose heading',
      '',
      'Some body text.',
      '',
      ACTIVITY_MARKER,
      '',
      '## Activity',
      '',
      '### 2026-08-10T14:00:00.000Z — alice — flagged: blocked',
      '',
      'Note.',
    ].join('\n');

    const entries = parseActivity(body);
    // Only the entry inside the activity section counts
    expect(entries).toHaveLength(1);
    expect(entries[0]!.author).toBe('alice');
  });

  it('a ### line without the strict heading format is not parsed as an entry', () => {
    const body = [
      'Prose.',
      '',
      ACTIVITY_MARKER,
      '',
      '## Activity',
      '',
      '### Just a comment, not an event heading',
      '',
      'Some text.',
      '',
      '### 2026-08-10T14:00:00.000Z — alice — flagged: blocked',
      '',
      'Real entry.',
    ].join('\n');

    const entries = parseActivity(body);
    // The first ### line doesn't match the strict heading format, so only the second counts
    expect(entries).toHaveLength(1);
    expect(entries[0]!.author).toBe('alice');
    expect(entries[0]!.text).toBe('Real entry.');
  });
});
