import type { AttributeType, ParamDef, ParamDefs } from '$shared';
import { PARAM_NAME_RE } from '$shared';

/**
 * Editing a template's parameter list.
 *
 * The rules live here rather than in the component so they can be tested
 * without a DOM, which is the standing arrangement for everything under
 * `features/`. A parameter list is a map, and a map is awkward to edit in
 * place — renaming a key, keeping the order — so the editor works on an array
 * of rows and this converts in both directions.
 */

export interface ParamRow {
  name: string;
  type: AttributeType;
  required: boolean;
  /** As typed. Turned into a value of the right type on the way out. */
  defaultText: string;
  description: string;
  /** For `enum`, one per line as typed. */
  valuesText: string;
}

const TYPES: AttributeType[] = ['string', 'text', 'int', 'float', 'bool', 'date', 'enum', 'array'];

export { TYPES as PARAM_TYPES };

export function toRows(params: ParamDefs): ParamRow[] {
  return Object.entries(params).map(([name, def]) => ({
    name,
    type: def.type,
    required: def.required === true,
    defaultText: def.default === undefined ? '' : String(def.default),
    description: def.description ?? '',
    valuesText: (def.values ?? []).join('\n'),
  }));
}

/** Turn one row's typed default back into a value of its declared type. */
function defaultOf(row: ParamRow): unknown {
  const text = row.defaultText.trim();
  if (!text) return undefined;
  if (row.type === 'int') return Number.parseInt(text, 10);
  if (row.type === 'float') return Number.parseFloat(text);
  if (row.type === 'bool') return text === 'true' || text === 'yes';
  if (row.type === 'array') return text.split(',').map((entry) => entry.trim()).filter(Boolean);
  return text;
}

export interface RowsResult {
  params: ParamDefs;
  /** Why a row was dropped. Shown beside the editor rather than thrown. */
  errors: string[];
}

/**
 * Rows back into a parameter map.
 *
 * A row that is not yet a valid declaration is *left out* rather than rejected,
 * because this runs on every keystroke: somebody halfway through typing a name
 * must not see an error dialog, and must not have the half-typed row written to
 * the board either.
 */
export function fromRows(rows: ParamRow[]): RowsResult {
  const params: ParamDefs = {};
  const errors: string[] = [];

  for (const row of rows) {
    const name = row.name.trim();
    if (!name) continue;
    if (!PARAM_NAME_RE.test(name)) {
      errors.push(`"${name}" is not a parameter name; use lower_snake_case`);
      continue;
    }
    if (name in params) {
      errors.push(`"${name}" is declared twice`);
      continue;
    }
    const values = row.valuesText
      .split('\n')
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (row.type === 'enum' && !values.length) {
      errors.push(`"${name}" is an enum and needs at least one value`);
      continue;
    }
    const def: ParamDef = { type: row.type };
    if (row.required) def.required = true;
    if (row.description.trim()) def.description = row.description.trim();
    const fallback = defaultOf(row);
    if (fallback !== undefined && !Number.isNaN(fallback)) def.default = fallback;
    if (row.type === 'enum') def.values = values;
    params[name] = def;
  }

  return { params, errors };
}

export function blankRow(): ParamRow {
  return {
    name: '',
    type: 'string',
    required: false,
    defaultText: '',
    description: '',
    valuesText: '',
  };
}
