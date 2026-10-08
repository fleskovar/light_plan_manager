import type { AttributeDef } from './types.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Shape *and* calendar validity, so 2026-13-01 and 2026-02-30 are rejected. */
export function isCalendarDate(text: string): boolean {
  if (!DATE_RE.test(text)) return false;
  const [year, month, day] = text.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (value instanceof Date) return 'a date object';
  return typeof value;
}

export function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** Canonicalize a value read from YAML (mainly: dates come back as Date objects). */
export function normalizeAttributeValue(def: AttributeDef, value: unknown): unknown {
  if (def.type === 'date' && value instanceof Date) return value.toISOString().slice(0, 10);
  return value;
}

/** Returns an error message, or null when the value fits the declared type. */
export function validateAttributeValue(def: AttributeDef, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  switch (def.type) {
    case 'string':
    case 'text':
      return typeof value === 'string' ? null : `expected a string, got ${describe(value)}`;
    case 'int':
      return typeof value === 'number' && Number.isInteger(value)
        ? null
        : `expected an integer, got ${describe(value)}`;
    case 'float':
      return typeof value === 'number' && Number.isFinite(value)
        ? null
        : `expected a number, got ${describe(value)}`;
    case 'bool':
      return typeof value === 'boolean' ? null : `expected true or false, got ${describe(value)}`;
    case 'date':
      return typeof value === 'string' && isCalendarDate(value)
        ? null
        : `expected a valid YYYY-MM-DD date, got ${describe(value)}`;
    case 'enum':
      return typeof value === 'string' && (def.values ?? []).includes(value)
        ? null
        : `expected one of [${(def.values ?? []).join(', ')}], got ${describe(value)}`;
    case 'array':
      return Array.isArray(value) ? null : `expected a list, got ${describe(value)}`;
  }
}

export interface ParsedInput {
  value?: unknown;
  error?: string;
}

/** Coerce a raw `--set key=value` string into the attribute's declared type. */
export function parseAttributeInput(def: AttributeDef, raw: string): ParsedInput {
  const text = raw.trim();
  switch (def.type) {
    case 'string':
    case 'text':
      return { value: raw };
    case 'int': {
      if (!/^-?\d+$/.test(text)) return { error: `expected an integer, got "${raw}"` };
      return { value: Number.parseInt(text, 10) };
    }
    case 'float': {
      const num = Number(text);
      if (text === '' || !Number.isFinite(num)) return { error: `expected a number, got "${raw}"` };
      return { value: num };
    }
    case 'bool': {
      const lowered = text.toLowerCase();
      if (['true', 'yes', 'y', '1'].includes(lowered)) return { value: true };
      if (['false', 'no', 'n', '0'].includes(lowered)) return { value: false };
      return { error: `expected true or false, got "${raw}"` };
    }
    case 'date': {
      if (!isCalendarDate(text)) return { error: `expected a valid YYYY-MM-DD date, got "${raw}"` };
      return { value: text };
    }
    case 'enum': {
      const allowed = def.values ?? [];
      if (!allowed.includes(text)) {
        return { error: `expected one of [${allowed.join(', ')}], got "${raw}"` };
      }
      return { value: text };
    }
    case 'array': {
      const items = text
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '');
      return { value: items };
    }
  }
}

/** The value a new issue starts with: the declared default, or a type-appropriate blank. */
export function initialValueFor(def: AttributeDef): unknown {
  if (def.default !== undefined) return def.default;
  return def.type === 'array' ? [] : null;
}
