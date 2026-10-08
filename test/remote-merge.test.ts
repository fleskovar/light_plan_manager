import { describe, expect, it } from 'vitest';
import {
  NO_BASE,
  canonicalValue,
  mergeLists,
  mergeValues,
  valuesEqual,
  type ListMerge,
  type MergeOutcome,
} from '../src/remote/merge.js';

/**
 * LP-284 — the field-by-field three-way merge against the base snapshot.
 * LP-285 — list-valued fields merge as sets, element by element.
 *
 * Pure: every test drives `mergeValues` / `mergeLists` with literals.  No
 * board, no disk, no network — the same property the planner suite relies on.
 */

describe('mergeValues — the four cases', () => {
  it('none when both sides equal the base', () => {
    expect(mergeValues('a', 'a', 'a')).toBe('none');
  });

  it('push when only the local side changed', () => {
    expect(mergeValues('b', 'a', 'a')).toBe('push');
  });

  it('pull when only the remote side changed', () => {
    expect(mergeValues('a', 'b', 'a')).toBe('pull');
  });

  it('conflict when both sides changed', () => {
    expect(mergeValues('b', 'c', 'a')).toBe('conflict');
  });

  it('none when both sides made the same edit', () => {
    // Both moved from base, but to the same value — nothing to sync, nothing
    // to resolve.
    expect(mergeValues('b', 'b', 'a')).toBe('none');
  });
});

describe('mergeValues — changed on both sides, different fields', () => {
  it('resolves each field independently: a title push and a status pull', () => {
    const title = mergeValues('new title', 'old title', 'old title');
    const status = mergeValues('in_progress', 'done', 'in_progress');

    expect(title).toBe('push');
    expect(status).toBe('pull');
    expect([title, status]).not.toContain('conflict');
  });

  it('a conflict in one field does not infect an unchanged sibling', () => {
    const points = mergeValues(8, 13, 5);
    const title = mergeValues('same', 'same', 'same');

    expect(points).toBe('conflict');
    expect(title).toBe('none');
  });
});

describe('mergeValues — no base snapshot', () => {
  it('conflict when the two sides differ', () => {
    expect(mergeValues('a', 'b', NO_BASE)).toBe('conflict');
  });

  it('none when the two sides already agree', () => {
    expect(mergeValues('a', 'a', NO_BASE)).toBe('none');
  });

  it('conflict even when one side would equal a hypothetical base', () => {
    // With no base there is nothing to attribute either side's value to, so a
    // difference is a conflict — never a silent push or pull.
    expect(mergeValues('a', 'b', NO_BASE)).toBe('conflict');
  });

  it('treats list differences the same way', () => {
    expect(mergeValues(['a', 'b'], ['a', 'b', 'c'], NO_BASE)).toBe('conflict');
  });
});

describe('mergeValues — normalisation', () => {
  it('ignores trailing newlines', () => {
    expect(mergeValues('title\n', 'title', 'title\n\n')).toBe('none');
  });

  it('folds CRLF into LF', () => {
    expect(mergeValues('a\r\nb', 'a\nb', 'a\r\nb')).toBe('none');
  });

  it('ignores surrounding whitespace', () => {
    expect(mergeValues('  x  ', 'x', 'x')).toBe('none');
  });

  it('ignores list order when nothing changed', () => {
    expect(mergeValues(['a', 'b'], ['b', 'a'], ['a', 'b'])).toBe('none');
  });

  it('detects a local list change regardless of order', () => {
    expect(mergeValues(['c', 'a', 'b'], ['b', 'a'], ['a', 'b'])).toBe('push');
  });

  it('detects a remote list change regardless of order', () => {
    expect(mergeValues(['a', 'b'], ['c', 'b', 'a'], ['a', 'b'])).toBe('pull');
  });

  it('conflicts when both sides change a list to different sets', () => {
    expect(mergeValues(['a', 'b', 'd'], ['a', 'b', 'c'], ['a', 'b'])).toBe('conflict');
  });
});

describe('mergeValues — value kinds', () => {
  it('compares numbers without string coercion', () => {
    expect(mergeValues(5, 5, 5)).toBe('none');
    expect(mergeValues(8, 5, 5)).toBe('push');
    expect(mergeValues(5, 8, 5)).toBe('pull');
    expect(mergeValues(8, 13, 5)).toBe('conflict');
  });

  it('treats null as a real base value, distinct from NO_BASE', () => {
    // Base null, local null, remote assigned → the remote moved: pull.
    expect(mergeValues(null, 'RS-1', null)).toBe('pull');
    // Base null, local assigned, remote null → the local moved: push.
    expect(mergeValues('RS-1', null, null)).toBe('push');
    // Base null, both sides assigned differently → conflict.
    expect(mergeValues('RS-1', 'RS-2', null)).toBe('conflict');
  });

  it('compares booleans', () => {
    expect(mergeValues(true, false, false)).toBe('push');
    expect(mergeValues(false, true, false)).toBe('pull');
    expect(mergeValues(true, false, true)).toBe('pull');
  });
});

describe('canonicalValue', () => {
  it('trims and folds line endings in strings', () => {
    expect(canonicalValue('  a\r\nb\n')).toBe('a\nb');
  });

  it('sorts array elements', () => {
    expect(canonicalValue(['b', 'a', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('canonicalises array elements before sorting', () => {
    expect(canonicalValue([' b ', 'a'])).toEqual(['a', 'b']);
  });

  it('sorts object keys', () => {
    expect(JSON.stringify(canonicalValue({ b: 1, a: 2 }))).toBe(JSON.stringify({ a: 2, b: 1 }));
  });

  it('leaves numbers, booleans and null alone', () => {
    expect(canonicalValue(5)).toBe(5);
    expect(canonicalValue(true)).toBe(true);
    expect(canonicalValue(null)).toBeNull();
  });

  it('does not mutate its input', () => {
    const input = ['b', 'a'];
    canonicalValue(input);
    expect(input).toEqual(['b', 'a']);
  });
});

describe('valuesEqual', () => {
  it('compares canonical forms', () => {
    expect(valuesEqual('a', 'a\n')).toBe(true);
    expect(valuesEqual(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(valuesEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it('reports genuine differences', () => {
    expect(valuesEqual('a', 'b')).toBe(false);
    expect(valuesEqual(['a', 'b'], ['a', 'c'])).toBe(false);
    expect(valuesEqual(1, '1')).toBe(false);
  });

  it('distinguishes null from undefined', () => {
    expect(valuesEqual(null, undefined)).toBe(false);
  });
});

describe('MergeOutcome exhaustiveness', () => {
  it('the outcome vocabulary is exactly the four words the table promises', () => {
    const outcomes: MergeOutcome[] = ['none', 'push', 'pull', 'conflict'];
    expect(outcomes).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// LP-285 — mergeLists: list-valued fields as sets
// ---------------------------------------------------------------------------

/** A compact, order-independent view of a list merge, for the assertions below. */
function shape(result: ListMerge) {
  return {
    merged: result.merged,
    conflicts: result.conflicts,
    localAdded: result.localAdded,
    localRemoved: result.localRemoved,
    remoteAdded: result.remoteAdded,
    remoteRemoved: result.remoteRemoved,
  };
}

describe('mergeLists — additions and removals against base (AC #1)', () => {
  it('both sides adding a different value: both survive, no conflict', () => {
    // The headline case: a label added here and a label added there both stick.
    expect(shape(mergeLists(['a', 'x'], ['a', 'y'], ['a']))).toEqual({
      merged: ['a', 'x', 'y'],
      conflicts: [],
      localAdded: ['x'],
      localRemoved: [],
      remoteAdded: ['y'],
      remoteRemoved: [],
    });
  });

  it('both sides adding the same value: it lands once, not twice', () => {
    expect(shape(mergeLists(['a', 'x'], ['a', 'x'], ['a']))).toEqual({
      merged: ['a', 'x'],
      conflicts: [],
      localAdded: ['x'],
      localRemoved: [],
      remoteAdded: ['x'],
      remoteRemoved: [],
    });
  });

  it('both sides removing the same value: it is dropped once', () => {
    expect(shape(mergeLists(['a'], ['a'], ['a', 'b']))).toEqual({
      merged: ['a'],
      conflicts: [],
      localAdded: [],
      localRemoved: ['b'],
      remoteAdded: [],
      remoteRemoved: ['b'],
    });
  });

  it('one side removing and the other untouched: the removal wins', () => {
    expect(shape(mergeLists(['a'], ['a', 'b'], ['a', 'b']))).toEqual({
      merged: ['a'],
      conflicts: [],
      localAdded: [],
      localRemoved: ['b'],
      remoteAdded: [],
      remoteRemoved: [],
    });
  });

  it('one side adding and the other untouched: the addition survives', () => {
    expect(shape(mergeLists(['a', 'b'], ['a'], ['a']))).toEqual({
      merged: ['a', 'b'],
      conflicts: [],
      localAdded: ['b'],
      localRemoved: [],
      remoteAdded: [],
      remoteRemoved: [],
    });
  });

  it('additions and removals from both sides apply together in one merge', () => {
    // Local added x and dropped w; remote added z and dropped y.  All four land.
    expect(shape(mergeLists(['a', 'x', 'y'], ['a', 'w', 'z'], ['a', 'y', 'w']))).toEqual({
      merged: ['a', 'x', 'z'],
      conflicts: [],
      localAdded: ['x'],
      localRemoved: ['w'],
      remoteAdded: ['z'],
      remoteRemoved: ['y'],
    });
  });

  it('a changed list that both sides edited compatibly is never a whole-list conflict', () => {
    // Local: [a, b, d]; remote: [a, b, c]; base: [a, b].  `mergeValues` would
    // call this a conflict; the set merge resolves it to [a, b, c, d].
    const result = mergeLists(['a', 'b', 'd'], ['a', 'b', 'c'], ['a', 'b']);
    expect(result.conflicts).toEqual([]);
    expect(result.merged).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('mergeLists — per-element conflict (AC #2)', () => {
  it('with no base, every value exactly one side has is a single-value conflict', () => {
    const result = mergeLists(['a', 'b'], ['a', 'c'], NO_BASE);
    expect(result.conflicts).toEqual(['b', 'c']); // one entry per value, not the whole list
    expect(result.merged).toEqual(['a']);
    expect(result.localAdded).toEqual([]); // nothing to attribute without a base
    expect(result.remoteAdded).toEqual([]);
  });

  it('with no base, two agreeing lists merge cleanly with no conflict', () => {
    expect(shape(mergeLists(['a', 'b'], ['b', 'a'], NO_BASE))).toEqual({
      merged: ['a', 'b'],
      conflicts: [],
      localAdded: [],
      localRemoved: [],
      remoteAdded: [],
      remoteRemoved: [],
    });
  });

  it('against a sound base, additions and removals never conflict', () => {
    // Local added x and removed y; remote added y back and removed x — both
    // moves are still attributable and compatible, so nothing is undecidable.
    const result = mergeLists(['a', 'x'], ['a', 'y'], ['a', 'x', 'y']);
    expect(result.conflicts).toEqual([]);
  });
});

describe('mergeLists — the four list fields named in the story', () => {
  it('depends_on: an edge added on each side survives (no cycle by itself)', () => {
    // Two people each add a dependency that is fine alone.
    const result = mergeLists(['LP-1'], ['LP-2'], []);
    expect(result.merged).toEqual(['LP-1', 'LP-2']);
    expect(result.conflicts).toEqual([]);
  });

  it('relates_to: a non-gating edge merges exactly like a gating one', () => {
    const result = mergeLists(['LP-1'], ['LP-2'], []);
    expect(result.localAdded).toEqual(['LP-1']);
    expect(result.remoteAdded).toEqual(['LP-2']);
  });

  it('covers: a resource pooling work merges the same way', () => {
    const result = mergeLists(['LP-1', 'LP-2'], ['LP-1', 'LP-3'], ['LP-1']);
    expect(result.merged).toEqual(['LP-1', 'LP-2', 'LP-3']);
    expect(result.conflicts).toEqual([]);
  });

  it('labels: order and surrounding whitespace never matter', () => {
    expect(mergeLists([' urgent ', 'sync'], ['sync', 'urgent'], ['sync'])).toMatchObject({
      merged: ['sync', 'urgent'],
      conflicts: [],
    });
  });
});

describe('mergeLists — normalisation and shape', () => {
  it('ignores list order in every input', () => {
    expect(mergeLists(['b', 'a'], ['a', 'b'], ['a', 'b']).merged).toEqual(['a', 'b']);
  });

  it('de-duplicates repeated elements', () => {
    expect(mergeLists(['a', 'a', 'b'], ['b'], ['b']).merged).toEqual(['a', 'b']);
  });

  it('treats a non-array as an empty list', () => {
    expect(shape(mergeLists(undefined, ['a'], []))).toEqual({
      merged: ['a'],
      conflicts: [],
      localAdded: [],
      localRemoved: [],
      remoteAdded: ['a'],
      remoteRemoved: [],
    });
  });

  it('all six result lists are sorted and stable', () => {
    const result = mergeLists(['d', 'a'], ['c', 'b'], ['d', 'b']);
    expect(result.merged).toEqual(result.merged.slice().sort());
    expect(result.conflicts).toEqual(result.conflicts.slice().sort());
    expect(result.localAdded).toEqual(result.localAdded.slice().sort());
    expect(result.localRemoved).toEqual(result.localRemoved.slice().sort());
    expect(result.remoteAdded).toEqual(result.remoteAdded.slice().sort());
    expect(result.remoteRemoved).toEqual(result.remoteRemoved.slice().sort());
  });
});
