/**
 * Template parameters: what a registry template asks for, and how those answers
 * are written into the documents it produces.
 *
 * The single definition, imported by core (which reads a `params:` block off a
 * document) and by the browser (which shows the form and the planner that
 * instantiates one). It imports nothing, like the other rule modules here.
 *
 * Deliberately **not** a template engine. `.lpm/templates/context/` renders with
 * Eta and needs `analyze.ts` between it and the shell, because a compiled
 * template is a script. A registry template is a *document*: `{{name}}` is
 * replaced with a value and nothing is ever compiled or evaluated, so there is
 * no escape to guard against and no `--unsafe` to offer.
 */

/**
 * What one parameter accepts, spelled exactly like a config attribute.
 *
 * `src/core/model/types.ts` carries `AttributeDef` with the same shape, and the
 * two are structurally compatible on purpose: a parameter is validated by
 * `validateAttributeValue`, so a template asking for an `enum` of three values
 * refuses a fourth for the same reason a document does. This folder imports
 * nothing, which is why the shape is written twice rather than shared.
 */
export interface ParamDef {
  type: 'string' | 'text' | 'int' | 'float' | 'bool' | 'date' | 'enum' | 'array';
  description?: string;
  required?: boolean;
  default?: unknown;
  /** Allowed values, for (and only for) `enum`. */
  values?: string[];
}

/** A template's declared parameters, keyed by name. */
export type ParamDefs = Record<string, ParamDef>;

/** Parameter names are spelled like attribute names, so one rule covers both. */
export const PARAM_NAME_RE = /^[a-z][a-z0-9_]*$/;

/**
 * A placeholder: `{{name}}`, with optional spaces inside the braces.
 *
 * There is no escape for a literal `{{name}}` and there is deliberately no
 * expression syntax — a placeholder is a name and nothing else. A template that
 * needs to write braces writes them apart.
 */
const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

/** Every parameter name a piece of text refers to, in order, without repeats. */
export function placeholdersIn(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1]!;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** Every parameter name anything in this value refers to — strings and lists. */
export function placeholdersInValue(value: unknown): string[] {
  if (typeof value === 'string') return placeholdersIn(value);
  if (Array.isArray(value)) {
    const names: string[] = [];
    for (const entry of value) {
      for (const name of placeholdersInValue(entry)) {
        if (!names.includes(name)) names.push(name);
      }
    }
    return names;
  }
  return [];
}

/**
 * True when a value is waiting for a parameter rather than holding an answer.
 *
 * The one place the exemption is defined. A template's attributes are declared
 * by the *issue* type it will produce, so `story_points: "{{points}}"` is a
 * string sitting in an integer field — which is the whole point of a template
 * and must not be validated as though the template were the issue. Nothing
 * relaxes on the board itself: the value is filled in before an issue is
 * written, and `planInstantiate` refuses a placeholder no parameter answers.
 */
export function holdsPlaceholder(value: unknown): boolean {
  return placeholdersInValue(value).length > 0;
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(asText).join(', ');
  return String(value);
}

/** Replace every placeholder in a piece of text. Unknown names are left alone. */
export function substitute(text: string, values: Record<string, unknown>): string {
  return text.replace(PLACEHOLDER, (whole, name: string) =>
    name in values ? asText(values[name]) : whole,
  );
}

/**
 * Fill a value that may not be text at all.
 *
 * A string that is *entirely* one placeholder keeps the parameter's own type:
 * `story_points: "{{points}}"` with `points: 5` writes the number 5, not the
 * string "5", so a template can carry a value the board would otherwise reject.
 * Anything else is interpolated as text, and lists are filled entry by entry.
 */
export function fillValue(value: unknown, values: Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((entry) => fillValue(entry, values));
  if (typeof value !== 'string') return value;

  const whole = /^\s*\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}\s*$/.exec(value);
  if (whole && whole[1]! in values) return values[whole[1]!];
  return substitute(value, values);
}

export interface ResolvedParams {
  /** Every declared parameter, with the value the instantiation will use. */
  values: Record<string, unknown>;
  /** Why the answers were refused. Empty when they were accepted. */
  errors: string[];
}

/**
 * Work out the value of every declared parameter from the answers given.
 *
 * Refuses an answer the template did not ask for rather than ignoring it: a
 * typo in a parameter file is otherwise a template that silently produced the
 * wrong board, which is the failure nobody notices. A required parameter with
 * no answer and no default is refused for the same reason.
 *
 * `validate` is passed in because "is this a valid value for this type?" lives
 * in `core/model/attributes.ts`, which this module may not import. Callers with
 * no engine to hand may pass nothing and get name checking alone.
 */
export function resolveParams(
  declared: ParamDefs,
  given: Record<string, unknown>,
  validate?: (def: ParamDef, value: unknown) => string | null,
): ResolvedParams {
  const errors: string[] = [];
  const names = Object.keys(declared);

  for (const name of Object.keys(given)) {
    if (!(name in declared)) {
      errors.push(
        names.length
          ? `"${name}" is not a parameter of this template (it declares: ${names.join(', ')})`
          : `"${name}" is not a parameter of this template (it declares none)`,
      );
    }
  }

  const values: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(declared)) {
    const supplied = name in given ? given[name] : undefined;
    if (supplied === undefined || supplied === null || supplied === '') {
      if (def.default !== undefined) {
        values[name] = def.default;
        continue;
      }
      if (def.required) {
        errors.push(
          def.description
            ? `"${name}" is required: ${def.description}`
            : `"${name}" is required`,
        );
        continue;
      }
      values[name] = def.type === 'array' ? [] : '';
      continue;
    }
    const problem = validate?.(def, supplied);
    if (problem) {
      errors.push(`"${name}": ${problem}`);
      continue;
    }
    values[name] = supplied;
  }

  return { values, errors };
}
