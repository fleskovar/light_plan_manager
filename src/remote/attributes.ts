/**
 * Attribute coercion — the board's eight attribute types in, the remote's
 * field types out, and back again (LP-270).
 *
 * One slice of the mapping engine (LP-254). A board declares its own attribute
 * types (`string`, `text`, `int`, `float`, `bool`, `date`, `enum`, `array`);
 * a remote has its own field kinds (`text`, `number`, `boolean`, `date`,
 * `single_select`, `multi_select`, `labels`). This module is the join between
 * the two: a pure function for each direction, with a defined failure when
 * there is no coercion.
 *
 * The branch structure deliberately mirrors `src/core/model/attributes.ts`
 * (`normalizeAttributeValue`, `validateAttributeValue`, `parseAttributeInput`):
 * one switch over the attribute type, on both sides of the wire, so a ninth
 * attribute type is one more case in a familiar place.
 *
 * Pure: no disk, no network. Everything takes its inputs and returns a value,
 * so the coercion is testable against literals — the acceptance criterion that
 * mapping tests need no board on disk and no network.
 *
 * What this file does *not* do: the degradation ladder (LP-255) that orders
 * "custom field, then managed block" when an attribute has no mapping, and the
 * managed-block serializer that walks with it. `attributePlacement` here names
 * the rung an attribute lands on; the ladder itself and the serializer live
 * with LP-255.
 */

import { isCalendarDate } from '../core/model/attributes.js';
import type { AttributeType } from '../core/model/types.js';

// ---------------------------------------------------------------------------
// Remote field vocabulary
// ---------------------------------------------------------------------------

/**
 * The kinds of field a remote can hold, and the wire shape of each:
 *
 *   - `text`          a single string
 *   - `number`        a number
 *   - `boolean`       true / false
 *   - `date`          a string, `YYYY-MM-DD`
 *   - `single_select` a string that must be one of `options`
 *   - `multi_select`  a string list, each item one of `options`
 *   - `labels`        a free-form string list (shared with humans)
 */
export type RemoteFieldKind =
  | 'text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'single_select'
  | 'multi_select'
  | 'labels';

/** A remote field a board attribute is mapped onto: its kind, and the option
 * list the kind needs (`single_select`, `multi_select`). */
export interface RemoteField {
  kind: RemoteFieldKind;
  /** Allowed remote values, for `single_select` and `multi_select`. */
  options?: string[];
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** The outcome of one coercion, in either direction. */
export type CoerceResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: string; options?: string[] };

/**
 * A coercion failure, attributed and directional, ready to be reported. The
 * planner aggregates these before anything is written (LP-273); the translator
 * returns them so nothing is silently dropped.
 */
export interface AttributeProblem {
  attribute: string;
  direction: 'push' | 'pull';
  reason: string;
  /** The option list, when the failure is "value is not one of the options". */
  options?: string[];
}

// ---------------------------------------------------------------------------
// Push: board value → remote value
// ---------------------------------------------------------------------------

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (value instanceof Date) return 'a date object';
  return typeof value;
}

function noCoercion(type: AttributeType, kind: RemoteFieldKind): CoerceResult {
  return { ok: false, reason: `no coercion from ${type} to a ${kind} field` };
}

function coerceInteger(value: unknown): CoerceResult {
  return typeof value === 'number' && Number.isInteger(value)
    ? { ok: true, value }
    : { ok: false, reason: `expected an integer, got ${describe(value)}` };
}

function coerceNumber(value: unknown): CoerceResult {
  return typeof value === 'number' && Number.isFinite(value)
    ? { ok: true, value }
    : { ok: false, reason: `expected a number, got ${describe(value)}` };
}

function coerceSingleSelect(value: unknown, options?: string[]): CoerceResult {
  if (typeof value !== 'string') {
    return { ok: false, reason: `expected one of the remote options, got ${describe(value)}` };
  }
  if (options !== undefined && !options.includes(value)) {
    return {
      ok: false,
      reason: `"${value}" is not one of the remote options`,
      options: [...options],
    };
  }
  return { ok: true, value };
}

function coerceMultiSelect(value: unknown, options?: string[]): CoerceResult {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    return { ok: false, reason: `expected a list of strings, got ${describe(value)}` };
  }
  if (options !== undefined) {
    const offender = value.find((item) => !options.includes(item));
    if (offender !== undefined) {
      return {
        ok: false,
        reason: `"${offender}" is not one of the remote options`,
        options: [...options],
      };
    }
  }
  return { ok: true, value: [...value] };
}

function coerceStringList(value: unknown): CoerceResult {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? { ok: true, value: [...value] }
    : { ok: false, reason: `expected a list of strings, got ${describe(value)}` };
}

/**
 * Coerce a board attribute value onto a remote field, for the push direction.
 *
 * The coercion is decided by the *board type* and the *remote field kind*; the
 * result is the wire value or a failure naming what did not fit. A kind with
 * no coercion for the type is a failure, never a silent default — the one
 * thing a mapping must not do is guess.
 */
export function coerceToRemote(
  type: AttributeType,
  value: unknown,
  field: RemoteField,
): CoerceResult {
  switch (type) {
    case 'string':
    case 'text':
      if (field.kind !== 'text') return noCoercion(type, field.kind);
      return typeof value === 'string'
        ? { ok: true, value }
        : { ok: false, reason: `expected a string, got ${describe(value)}` };
    case 'int':
      if (field.kind === 'number') return coerceInteger(value);
      if (field.kind === 'text') {
        return typeof value === 'number' && Number.isInteger(value)
          ? { ok: true, value: String(value) }
          : { ok: false, reason: `expected an integer, got ${describe(value)}` };
      }
      return noCoercion(type, field.kind);
    case 'float':
      if (field.kind === 'number') return coerceNumber(value);
      if (field.kind === 'text') {
        return typeof value === 'number' && Number.isFinite(value)
          ? { ok: true, value: String(value) }
          : { ok: false, reason: `expected a number, got ${describe(value)}` };
      }
      return noCoercion(type, field.kind);
    case 'bool':
      if (field.kind === 'boolean') {
        return typeof value === 'boolean'
          ? { ok: true, value }
          : { ok: false, reason: `expected true or false, got ${describe(value)}` };
      }
      if (field.kind === 'text') {
        return typeof value === 'boolean'
          ? { ok: true, value: String(value) }
          : { ok: false, reason: `expected true or false, got ${describe(value)}` };
      }
      return noCoercion(type, field.kind);
    case 'date':
      if (field.kind === 'date' || field.kind === 'text') {
        return typeof value === 'string' && isCalendarDate(value)
          ? { ok: true, value }
          : { ok: false, reason: `expected a valid YYYY-MM-DD date, got ${describe(value)}` };
      }
      return noCoercion(type, field.kind);
    case 'enum':
      if (field.kind === 'single_select') return coerceSingleSelect(value, field.options);
      if (field.kind === 'text') {
        return typeof value === 'string'
          ? { ok: true, value }
          : { ok: false, reason: `expected an enum value (a string), got ${describe(value)}` };
      }
      return noCoercion(type, field.kind);
    case 'array':
      if (field.kind === 'labels') return coerceStringList(value);
      if (field.kind === 'multi_select') return coerceMultiSelect(value, field.options);
      return noCoercion(type, field.kind);
  }
}

// ---------------------------------------------------------------------------
// Pull: remote value → board value
// ---------------------------------------------------------------------------

/**
 * Coerce a remote value back to a board attribute value, for the pull
 * direction. `opts.values` is the board's declared `values` for an `enum`
 * attribute — the option list a stray remote value is checked against, and the
 * one reported when it does not fit. A value that will not coerce back is a
 * failure; the caller leaves the attribute alone and reports it, never writing
 * a guessed value.
 */
export function coerceFromRemote(
  type: AttributeType,
  remoteValue: unknown,
  opts: { values?: readonly string[] } = {},
): CoerceResult {
  switch (type) {
    case 'string':
    case 'text':
      return typeof remoteValue === 'string'
        ? { ok: true, value: remoteValue }
        : { ok: false, reason: `expected a string, got ${describe(remoteValue)}` };
    case 'int':
      if (typeof remoteValue === 'number' && Number.isInteger(remoteValue)) {
        return { ok: true, value: remoteValue };
      }
      if (typeof remoteValue === 'string' && /^-?\d+$/.test(remoteValue.trim())) {
        return { ok: true, value: Number.parseInt(remoteValue.trim(), 10) };
      }
      return { ok: false, reason: `expected an integer, got ${describe(remoteValue)}` };
    case 'float':
      if (typeof remoteValue === 'number' && Number.isFinite(remoteValue)) {
        return { ok: true, value: remoteValue };
      }
      if (
        typeof remoteValue === 'string' &&
        remoteValue.trim() !== '' &&
        Number.isFinite(Number(remoteValue))
      ) {
        return { ok: true, value: Number(remoteValue) };
      }
      return { ok: false, reason: `expected a number, got ${describe(remoteValue)}` };
    case 'bool':
      if (typeof remoteValue === 'boolean') return { ok: true, value: remoteValue };
      if (typeof remoteValue === 'string') {
        const lowered = remoteValue.trim().toLowerCase();
        if (lowered === 'true') return { ok: true, value: true };
        if (lowered === 'false') return { ok: true, value: false };
      }
      return { ok: false, reason: `expected true or false, got ${describe(remoteValue)}` };
    case 'date':
      return typeof remoteValue === 'string' && isCalendarDate(remoteValue)
        ? { ok: true, value: remoteValue }
        : { ok: false, reason: `expected a valid YYYY-MM-DD date, got ${describe(remoteValue)}` };
    case 'enum':
      if (typeof remoteValue !== 'string') {
        return { ok: false, reason: `expected a string, got ${describe(remoteValue)}` };
      }
      if (opts.values !== undefined && !opts.values.includes(remoteValue)) {
        return {
          ok: false,
          reason: `"${remoteValue}" is not one of [${opts.values.join(', ')}]`,
          options: [...opts.values],
        };
      }
      return { ok: true, value: remoteValue };
    case 'array':
      return Array.isArray(remoteValue) && remoteValue.every((item) => typeof item === 'string')
        ? { ok: true, value: [...remoteValue] }
        : { ok: false, reason: `expected a list of strings, got ${describe(remoteValue)}` };
  }
}

// ---------------------------------------------------------------------------
// Placement — the ladder's first step (LP-255 owns the ladder itself)
// ---------------------------------------------------------------------------

/** Where one board attribute lands on the remote. */
export type AttributePlacement = 'mapped' | 'custom_field' | 'managed';

/**
 * Answer, per declared board attribute, which rung of the degradation ladder it
 * lands on: `mapped` when the mapping names it; otherwise `custom_field` when
 * the provider can provision custom fields, or `managed` — the managed block —
 * when it cannot. Pure, so the preflight can name the rung before anything is
 * written; the ladder's ordering and the managed-block serializer are LP-255.
 *
 * `declared` is the board's attribute names, `mapped` the names the remote's
 * `mapping.attributes` claims, and `provisionable` whether the provider can
 * hold custom fields (the `customFields` cell of its capabilities table).
 */
export function attributePlacement(
  declared: readonly string[],
  mapped: ReadonlySet<string>,
  opts: { provisionable: boolean },
): Record<string, AttributePlacement> {
  const out: Record<string, AttributePlacement> = {};
  for (const name of declared) {
    out[name] = mapped.has(name) ? 'mapped' : opts.provisionable ? 'custom_field' : 'managed';
  }
  return out;
}
