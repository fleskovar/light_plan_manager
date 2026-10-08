import { ATTRIBUTE_TYPES } from '../../model/types.js';
import type { ParamDef, ParamDefs } from '../../model/types.js';
import { PARAM_NAME_RE } from '../../../shared/template-params.js';
import { displayPath } from '../../storage/paths.js';
import type { LoadContext, RawNode } from './scan.js';

export function readString(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

export function readDate(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = readString(data, key);
  return text ?? undefined;
}

/**
 * Read a number. Anything present but non-numeric is reported and treated as
 * missing, so the caller can fall back to a default the way `--fix` will.
 */
export function readNumber(
  data: Record<string, unknown>,
  key: string,
  raw: RawNode,
  ctx: LoadContext,
): number | undefined {
  const value = data[key];
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    ctx.problems.push({
      level: 'error',
      path: displayPath(ctx.paths, raw.file),
      message: `${key} must be a number, not ${JSON.stringify(value)}`,
    });
    return undefined;
  }
  return parsed;
}

/**
 * Read a switch. Absent is not false — it means "nobody has touched this", so
 * anything unreadable is reported and treated as absent rather than as off.
 * `yes`/`no` are accepted because YAML 1.2 does not read them as booleans and
 * somebody typing one by hand plainly means one.
 */
export function readBoolean(
  data: Record<string, unknown>,
  key: string,
  raw: RawNode,
  ctx: LoadContext,
): boolean | undefined {
  const value = data[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (['true', 'yes', 'on'].includes(text)) return true;
    if (['false', 'no', 'off'].includes(text)) return false;
  }
  ctx.problems.push({
    level: 'error',
    path: displayPath(ctx.paths, raw.file),
    message: `${key} must be true or false, not ${JSON.stringify(value)}`,
  });
  return undefined;
}

/**
 * Read a list of short strings. A bare string is accepted as a one-element list
 * so `depends_on: LP-3` behaves the way people write it by hand. `noun` is what
 * the entries are called in a message — ids for a link list, paths for
 * `related_files`.
 */
export function readTextList(
  data: Record<string, unknown>,
  key: string,
  raw: RawNode,
  ctx: LoadContext,
  noun = 'id',
): string[] {
  const value = data[key];
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') {
    const single = value.trim();
    return single ? [single] : [];
  }
  if (Array.isArray(value)) {
    const entries: string[] = [];
    for (const entry of value) {
      if (typeof entry === 'string' && entry.trim()) entries.push(entry.trim());
      else if (entry !== null && entry !== undefined) {
        ctx.problems.push({
          level: 'error',
          path: displayPath(ctx.paths, raw.file),
          message: `${key} contains a non-${noun} entry (${JSON.stringify(entry)})`,
        });
      }
    }
    return entries;
  }
  ctx.problems.push({
    level: 'error',
    path: displayPath(ctx.paths, raw.file),
    message: `${key} must be a list of ${noun}s`,
  });
  return [];
}

export function readIdList(
  data: Record<string, unknown>,
  key: string,
  raw: RawNode,
  ctx: LoadContext,
): string[] {
  return readTextList(data, key, raw, ctx, 'id');
}

const ATTRIBUTE_TYPE_NAMES: readonly string[] = ATTRIBUTE_TYPES;

/**
 * Read a template's `params:` block.
 *
 * Forgiving in the same way the rest of loading is: an entry that makes no sense
 * is reported and dropped rather than failing the board, so a half-written
 * template still opens in the registry and `check` is what says what is wrong
 * with it. A template that declares nothing simply has no parameters.
 */
export function readParams(
  data: Record<string, unknown>,
  key: string,
  raw: RawNode,
  ctx: LoadContext,
): ParamDefs {
  const value = data[key];
  if (value === undefined || value === null) return {};

  const where = displayPath(ctx.paths, raw.file);
  const reject = (message: string): void => {
    ctx.problems.push({ level: 'error', path: where, message });
  };

  if (typeof value !== 'object' || Array.isArray(value)) {
    reject(`${key} must be a map of parameter names to declarations`);
    return {};
  }

  const params: ParamDefs = {};
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!PARAM_NAME_RE.test(name)) {
      reject(`${key}.${name}: parameter names must be lower_snake_case`);
      continue;
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      reject(`${key}.${name}: must be a declaration with a "type"`);
      continue;
    }
    const declaration = entry as Record<string, unknown>;
    const type = declaration.type;
    if (typeof type !== 'string' || !ATTRIBUTE_TYPE_NAMES.includes(type)) {
      reject(`${key}.${name}.type: must be one of ${ATTRIBUTE_TYPE_NAMES.join(', ')}`);
      continue;
    }
    const values = declaration.values;
    if (type === 'enum' && !Array.isArray(values)) {
      reject(`${key}.${name}: enum parameters need a "values" list`);
      continue;
    }
    const def: ParamDef = { type: type as ParamDef['type'] };
    if (typeof declaration.description === 'string') def.description = declaration.description;
    if (declaration.required === true) def.required = true;
    if (declaration.default !== undefined) def.default = declaration.default;
    if (Array.isArray(values)) def.values = values.map(String);
    params[name] = def;
  }
  return params;
}
