import { describe, expect, it } from 'vitest';
import {
  attributePlacement,
  coerceFromRemote,
  coerceToRemote,
  type RemoteField,
} from '../src/remote/attributes.js';

// ---------------------------------------------------------------------------
// Push: board value → remote value (coerceToRemote)
// ---------------------------------------------------------------------------

describe('coerceToRemote', () => {
  it('passes a string through a text field', () => {
    expect(coerceToRemote('string', 'hello', { kind: 'text' })).toEqual({ ok: true, value: 'hello' });
    expect(coerceToRemote('text', 'hello\nworld', { kind: 'text' })).toEqual({
      ok: true,
      value: 'hello\nworld',
    });
  });

  it('refuses a non-string in a text field', () => {
    expect(coerceToRemote('string', 5, { kind: 'text' })).toEqual({
      ok: false,
      reason: 'expected a string, got number',
    });
  });

  it('has no coercion from string to a non-text field', () => {
    expect(coerceToRemote('string', 'x', { kind: 'number' }).ok).toBe(false);
    expect(coerceToRemote('text', 'x', { kind: 'labels' }).ok).toBe(false);
  });

  it('coerces an int to a number and to text', () => {
    expect(coerceToRemote('int', 3, { kind: 'number' })).toEqual({ ok: true, value: 3 });
    expect(coerceToRemote('int', 3, { kind: 'text' })).toEqual({ ok: true, value: '3' });
  });

  it('refuses a non-integer int, and an int where a kind has no coercion', () => {
    expect(coerceToRemote('int', 3.5, { kind: 'number' })).toEqual({
      ok: false,
      reason: 'expected an integer, got number',
    });
    expect(coerceToRemote('int', '3', { kind: 'text' })).toEqual({
      ok: false,
      reason: 'expected an integer, got string',
    });
    expect(coerceToRemote('int', 3, { kind: 'boolean' })).toEqual({
      ok: false,
      reason: 'no coercion from int to a boolean field',
    });
  });

  it('coerces a float to a number and to text', () => {
    expect(coerceToRemote('float', 3.5, { kind: 'number' })).toEqual({ ok: true, value: 3.5 });
    expect(coerceToRemote('float', 3.5, { kind: 'text' })).toEqual({ ok: true, value: '3.5' });
  });

  it('refuses a non-number float', () => {
    expect(coerceToRemote('float', '3.5', { kind: 'number' })).toEqual({
      ok: false,
      reason: 'expected a number, got string',
    });
  });

  it('coerces a bool to a boolean and to text', () => {
    expect(coerceToRemote('bool', true, { kind: 'boolean' })).toEqual({ ok: true, value: true });
    expect(coerceToRemote('bool', false, { kind: 'text' })).toEqual({ ok: true, value: 'false' });
  });

  it('refuses a non-bool, and a bool where a kind has no coercion', () => {
    expect(coerceToRemote('bool', 'true', { kind: 'boolean' })).toEqual({
      ok: false,
      reason: 'expected true or false, got string',
    });
    expect(coerceToRemote('bool', true, { kind: 'number' }).ok).toBe(false);
  });

  it('passes a valid date to a date or text field and refuses an invalid one', () => {
    expect(coerceToRemote('date', '2026-08-10', { kind: 'date' })).toEqual({
      ok: true,
      value: '2026-08-10',
    });
    expect(coerceToRemote('date', '2026-08-10', { kind: 'text' })).toEqual({
      ok: true,
      value: '2026-08-10',
    });
    expect(coerceToRemote('date', '2026-02-30', { kind: 'date' })).toEqual({
      ok: false,
      reason: 'expected a valid YYYY-MM-DD date, got string',
    });
    expect(coerceToRemote('date', '2026-08-10', { kind: 'number' }).ok).toBe(false);
  });

  it('coerces an enum to a single_select when the value is an option', () => {
    const field: RemoteField = { kind: 'single_select', options: ['low', 'medium', 'high'] };
    expect(coerceToRemote('enum', 'high', field)).toEqual({ ok: true, value: 'high' });
  });

  it('reports an enum value with no matching option, with the option list', () => {
    const field: RemoteField = { kind: 'single_select', options: ['low', 'medium', 'high'] };
    expect(coerceToRemote('enum', 'urgent', field)).toEqual({
      ok: false,
      reason: '"urgent" is not one of the remote options',
      options: ['low', 'medium', 'high'],
    });
  });

  it('passes an enum through a text field (no remote option list to check)', () => {
    expect(coerceToRemote('enum', 'high', { kind: 'text' })).toEqual({ ok: true, value: 'high' });
  });

  it('refuses a non-string enum, and an enum where a kind has no coercion', () => {
    expect(coerceToRemote('enum', 5, { kind: 'single_select' })).toEqual({
      ok: false,
      reason: 'expected one of the remote options, got number',
    });
    expect(coerceToRemote('enum', 'high', { kind: 'number' }).ok).toBe(false);
  });

  it('coerces an array to labels and to multi_select', () => {
    expect(coerceToRemote('array', ['a', 'b'], { kind: 'labels' })).toEqual({
      ok: true,
      value: ['a', 'b'],
    });
    const field: RemoteField = { kind: 'multi_select', options: ['a', 'b', 'c'] };
    expect(coerceToRemote('array', ['a', 'c'], field)).toEqual({ ok: true, value: ['a', 'c'] });
  });

  it('reports an array item with no matching option', () => {
    const field: RemoteField = { kind: 'multi_select', options: ['a', 'b'] };
    expect(coerceToRemote('array', ['a', 'z'], field)).toEqual({
      ok: false,
      reason: '"z" is not one of the remote options',
      options: ['a', 'b'],
    });
  });

  it('refuses a non-list array, and an array where a kind has no coercion', () => {
    expect(coerceToRemote('array', 'a', { kind: 'labels' })).toEqual({
      ok: false,
      reason: 'expected a list of strings, got string',
    });
    expect(coerceToRemote('array', ['a'], { kind: 'text' }).ok).toBe(false);
  });

  it('does not alias the input list', () => {
    const input = ['a'];
    const result = coerceToRemote('array', input, { kind: 'labels' });
    if (!result.ok) throw new Error('expected ok');
    (result.value as string[]).push('mutation');
    expect(input).toEqual(['a']);
  });
});

// ---------------------------------------------------------------------------
// Pull: remote value → board value (coerceFromRemote)
// ---------------------------------------------------------------------------

describe('coerceFromRemote', () => {
  it('passes a string through, and refuses a non-string', () => {
    expect(coerceFromRemote('string', 'hello')).toEqual({ ok: true, value: 'hello' });
    expect(coerceFromRemote('text', 'hello')).toEqual({ ok: true, value: 'hello' });
    expect(coerceFromRemote('string', 5)).toEqual({
      ok: false,
      reason: 'expected a string, got number',
    });
  });

  it('recovers an int from a number or a numeric string', () => {
    expect(coerceFromRemote('int', 3)).toEqual({ ok: true, value: 3 });
    expect(coerceFromRemote('int', '3')).toEqual({ ok: true, value: 3 });
    expect(coerceFromRemote('int', '-3')).toEqual({ ok: true, value: -3 });
  });

  it('reports free text in a number field rather than guessing', () => {
    expect(coerceFromRemote('int', 'abc')).toEqual({
      ok: false,
      reason: 'expected an integer, got string',
    });
    expect(coerceFromRemote('int', '3.5')).toEqual({
      ok: false,
      reason: 'expected an integer, got string',
    });
  });

  it('recovers a float from a number or a numeric string', () => {
    expect(coerceFromRemote('float', 3.5)).toEqual({ ok: true, value: 3.5 });
    expect(coerceFromRemote('float', '3.5')).toEqual({ ok: true, value: 3.5 });
    expect(coerceFromRemote('float', 'abc')).toEqual({
      ok: false,
      reason: 'expected a number, got string',
    });
  });

  it('recovers a bool from a boolean or a true/false string', () => {
    expect(coerceFromRemote('bool', true)).toEqual({ ok: true, value: true });
    expect(coerceFromRemote('bool', 'true')).toEqual({ ok: true, value: true });
    expect(coerceFromRemote('bool', 'False')).toEqual({ ok: true, value: false });
    expect(coerceFromRemote('bool', 'yes')).toEqual({
      ok: false,
      reason: 'expected true or false, got string',
    });
  });

  it('recovers a date only from a valid calendar date', () => {
    expect(coerceFromRemote('date', '2026-08-10')).toEqual({ ok: true, value: '2026-08-10' });
    expect(coerceFromRemote('date', '2026-02-30')).toEqual({
      ok: false,
      reason: 'expected a valid YYYY-MM-DD date, got string',
    });
  });

  it('recovers an enum when the value is a declared option', () => {
    expect(coerceFromRemote('enum', 'high', { values: ['low', 'high'] })).toEqual({
      ok: true,
      value: 'high',
    });
  });

  it('reports an enum value with no matching option, with the option list', () => {
    expect(coerceFromRemote('enum', 'urgent', { values: ['low', 'high'] })).toEqual({
      ok: false,
      reason: '"urgent" is not one of [low, high]',
      options: ['low', 'high'],
    });
  });

  it('refuses a non-string enum', () => {
    expect(coerceFromRemote('enum', 5, { values: ['low'] })).toEqual({
      ok: false,
      reason: 'expected a string, got number',
    });
  });

  it('recovers an array from a string list, and refuses anything else', () => {
    expect(coerceFromRemote('array', ['a', 'b'])).toEqual({ ok: true, value: ['a', 'b'] });
    expect(coerceFromRemote('array', ['a', 5])).toEqual({
      ok: false,
      reason: 'expected a list of strings, got a list',
    });
    expect(coerceFromRemote('array', 'a')).toEqual({
      ok: false,
      reason: 'expected a list of strings, got string',
    });
  });

  it('does not alias the input list', () => {
    const input = ['a'];
    const result = coerceFromRemote('array', input);
    if (!result.ok) throw new Error('expected ok');
    (result.value as string[]).push('mutation');
    expect(input).toEqual(['a']);
  });
});

// ---------------------------------------------------------------------------
// Round trips: push then pull gives back the original board value
// ---------------------------------------------------------------------------

describe('round trips', () => {
  const cases: Array<{ type: Parameters<typeof coerceToRemote>[0]; value: unknown; values?: string[] }> = [
    { type: 'string', value: 'hello' },
    { type: 'text', value: 'two\nlines' },
    { type: 'int', value: 8 },
    { type: 'float', value: 3.5 },
    { type: 'bool', value: true },
    { type: 'date', value: '2026-08-10' },
    { type: 'enum', value: 'high', values: ['low', 'high'] },
    { type: 'array', value: ['a', 'b'] },
  ];

  it.each(cases)('round-trips a $type through its label carrier', ({ type, value, values }) => {
    // The push carrier is a text field (labels are text); an array is a label
    // list. Pull then coerces back to the board type.
    const field: RemoteField = type === 'array' ? { kind: 'labels' } : { kind: 'text' };
    const pushed = coerceToRemote(type, value, field);
    if (!pushed.ok) throw new Error(`push failed: ${pushed.reason}`);

    const pulled = coerceFromRemote(type, pushed.value, { values });
    expect(pulled).toEqual({ ok: true, value });
  });
});

// ---------------------------------------------------------------------------
// attributePlacement — the ladder's first step
// ---------------------------------------------------------------------------

describe('attributePlacement', () => {
  it('marks mapped attributes as mapped, and unmapped ones by capability', () => {
    const declared = ['priority', 'labels', 'owner'];
    const mapped = new Set(['priority']);
    expect(attributePlacement(declared, mapped, { provisionable: true })).toEqual({
      priority: 'mapped',
      labels: 'custom_field',
      owner: 'custom_field',
    });
    expect(attributePlacement(declared, mapped, { provisionable: false })).toEqual({
      priority: 'mapped',
      labels: 'managed',
      owner: 'managed',
    });
  });

  it('returns an empty record for an empty board', () => {
    expect(attributePlacement([], new Set(), { provisionable: false })).toEqual({});
  });
});
