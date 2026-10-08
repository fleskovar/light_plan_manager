/**
 * Projects v2 field and option provisioning (LP-311): what `lpm remote
 * provision` creates beyond the labels LP-308 already handles.
 *
 * A mapping that names a Project field which does not exist is the single most
 * common setup failure, and creating it is one GraphQL mutation — so this
 * module computes the fields the mapping needs, compares them against the
 * Project's *current* state (as resolved and cached by LP-310), and produces a
 * plan of mutations. It is idempotent by construction: the plan is always
 * "desired minus current", so a second run against an unchanged Project is
 * empty.
 *
 * ## Field types, from board vocabulary
 *
 *   - the status column, and any `enum` attribute → `SINGLE_SELECT`, with its
 *     options in board order (the status field reads left-to-right the way the
 *     config writes it);
 *   - the effort attribute (and any other `int` / `float` attribute) → `NUMBER`;
 *   - a `date` attribute → `DATE`;
 *   - everything else → `TEXT`.
 *
 * ## Adding options re-sends the whole list
 *
 * GitHub has no "add one option" mutation. `updateProjectV2Field` *replaces*
 * the option list, so adding a missing option means sending the existing
 * options back — each carrying its `id`, which is what preserves the option's
 * identity and stops existing item values from being cleared — followed by the
 * missing ones in desired order. The existing options are untouched: same
 * names, same ids.
 *
 * ## Pure vs I/O
 *
 * `desiredProjectFields` and `planProjectProvision` are pure (no disk, no
 * network); `provisionProjectGraphql` is the network half, driven through the
 * same `graphql` connector entry point LP-310 added, so a dry-run prints the
 * plan and never reaches this function.
 */

import type { LoadedBoard } from '../../../core/board/load.js';
import { BoardError } from '../../../core/errors.js';
import { mapStatusToRemote, normalizeStatusMappings } from '../../mapping.js';
import { attributeDefsOf } from '../../preflight.js';
import type { AttributeDefs } from '../../provider.js';
import type { OpenedRemote } from '../../remotes.js';
import type { ProjectGraphqlConnector, ProjectIds } from './projects.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The `ProjectV2CustomFieldType` values a mapping can produce. */
export type ProjectDataType = 'TEXT' | 'NUMBER' | 'DATE' | 'SINGLE_SELECT' | 'ITERATION';

/** One field the mapping needs, in Project vocabulary. */
export interface DesiredProjectField {
  /** The Project field name, as written in `mapping.fields`. */
  name: string;
  /** What kind of field to create. */
  dataType: ProjectDataType;
  /** Ordered option names — only for `SINGLE_SELECT`, empty otherwise. */
  options: string[];
}

/** One field to create — its name does not exist in the Project today. */
export interface CreateProjectFieldPlan {
  name: string;
  dataType: ProjectDataType;
  options: string[];
}

/** Options to add to one existing single-select field. */
export interface AddProjectOptionsPlan {
  fieldName: string;
  fieldId: string;
  /**
   * The full option list to send — `updateProjectV2Field` replaces the list,
   * so the existing options are sent back (each with its id, to preserve its
   * identity) followed by the missing ones in desired order.
   */
  options: Array<{ name: string; id?: string }>;
  /** Just the missing option names, for the report. */
  missing: string[];
}

/** What a push would (or did) create before filing: fields and options. */
export interface ProjectProvisionPlan {
  createFields: CreateProjectFieldPlan[];
  addOptions: AddProjectOptionsPlan[];
  /** True when nothing needs creating — the second-run, nothing-to-do case. */
  empty: boolean;
}

/** What one `provisionProjectGraphql` run actually created. */
export interface ProjectProvisionOutcome {
  /** Project field names created. */
  created: string[];
  /** Options added per field, each with the names that were missing. */
  optionsAdded: Array<{ field: string; added: string[] }>;
}

// ---------------------------------------------------------------------------
// Field types, from board vocabulary
// ---------------------------------------------------------------------------

/** A loose record read off a mapping block. */
function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/**
 * The Project field type a board field needs. `status` is a single select (the
 * board's columns); `title` is text; `period` is an iteration field when the
 * carrier is an iteration (LP-313); a declared attribute maps by its type —
 * enum to a single select, int/float to a number, date to a date — and
 * anything else (an unknown key, a string/bool/array attribute) is text.
 */
export function projectDataTypeOf(
  boardField: string,
  defs: AttributeDefs,
): ProjectDataType {
  if (boardField === 'status') return 'SINGLE_SELECT';
  if (boardField === 'title') return 'TEXT';
  if (boardField === 'period') return 'ITERATION';
  switch (defs[boardField]?.type) {
    case 'enum':
      return 'SINGLE_SELECT';
    case 'int':
    case 'float':
      return 'NUMBER';
    case 'date':
      return 'DATE';
    default:
      return 'TEXT';
  }
}

/**
 * The fields the mapping names, each with its Project type and — for a single
 * select — its ordered options.
 *
 * `status` options are the remote status labels in board order (`mapping.
 * statuses` is the source of the label, so a renamed remote status is used,
 * not the board's own label); an enum attribute's options are its declared
 * `values`, in declaration order. Deduplicated by Project field name (two
 * board fields mapping to one Project field is a config mistake; the first
 * spelling wins rather than provisioning twice).
 */
export function desiredProjectFields(
  board: LoadedBoard,
  remote: OpenedRemote,
): DesiredProjectField[] {
  const fields = asRecord(remote.mapping['fields']);
  const defs = attributeDefsOf(board);
  const statusMappings = normalizeStatusMappings(asRecord(remote.mapping['statuses']));
  const statusOptions = board.config.statuses
    .map((status) => mapStatusToRemote(statusMappings, status.id))
    .filter((label): label is string => typeof label === 'string');

  const byName = new Map<string, DesiredProjectField>();
  for (const [boardField, rawName] of Object.entries(fields)) {
    const name = String(rawName);
    if (name === '' || byName.has(name)) continue;

    const dataType = projectDataTypeOf(boardField, defs);
    let options: string[] = [];
    if (boardField === 'status') {
      options = statusOptions;
    } else {
      const def = defs[boardField];
      if (def?.type === 'enum') options = [...(def.values ?? [])];
    }

    // GitHub requires at least one option for a single-select field; a
    // single-select with nothing to select cannot be created, so it is skipped
    // rather than sent as a doomed mutation.
    if (dataType === 'SINGLE_SELECT' && options.length === 0) continue;

    byName.set(name, { name, dataType, options });
  }
  return [...byName.values()];
}

// ---------------------------------------------------------------------------
// The plan: desired minus current
// ---------------------------------------------------------------------------

/**
 * Compare the mapping's desired fields against the Project's current state and
 * return what is missing. A field whose name is absent is created; a
 * single-select field that exists but lacks options gains exactly the missing
 * ones (existing options are re-sent, never dropped or renamed). Idempotent:
 * an unchanged Project yields an empty plan.
 */
export function planProjectProvision(
  current: ProjectIds,
  desired: DesiredProjectField[],
): ProjectProvisionPlan {
  const createFields: CreateProjectFieldPlan[] = [];
  const addOptions: AddProjectOptionsPlan[] = [];

  for (const field of [...desired].sort((a, b) => a.name.localeCompare(b.name))) {
    const existing = current.fields[field.name];
    if (existing === undefined) {
      createFields.push({ name: field.name, dataType: field.dataType, options: field.options });
      continue;
    }

    // The field exists; only a single-select can gain options, and only when
    // the desired type and the live type both say so — a wrong-typed field is
    // reported by the id cache's mismatch detection, not re-created.
    if (field.dataType !== 'SINGLE_SELECT' || existing.type !== 'SINGLE_SELECT') {
      continue;
    }

    const missing = field.options.filter((name) => existing.options[name] === undefined);
    if (missing.length === 0) continue;

    const options: Array<{ name: string; id?: string }> = [
      ...Object.keys(existing.options).map((name) => ({ name, id: existing.options[name] })),
      ...missing.map((name) => ({ name })),
    ];
    addOptions.push({ fieldName: field.name, fieldId: existing.id, options, missing });
  }

  return { createFields, addOptions, empty: createFields.length === 0 && addOptions.length === 0 };
}

// ---------------------------------------------------------------------------
// The network half
// ---------------------------------------------------------------------------

/** Create a field (with its options, for a single-select). */
const CREATE_FIELD_MUTATION = `
mutation($input: CreateProjectV2FieldInput!) {
  createProjectV2Field(input: $input) {
    projectV2Field { id }
  }
}
`;

/** Replace a single-select's options — the only way to add one (LP-311). */
const UPDATE_FIELD_MUTATION = `
mutation($input: UpdateProjectV2FieldInput!) {
  updateProjectV2Field(input: $input) {
    projectV2Field { id }
  }
}
`;

/** The `graphql` entry point, or a `BoardError` when the connector has none. */
function graphqlOf(
  connector: ProjectGraphqlConnector,
): (query: string, variables?: Record<string, unknown>) => Promise<Record<string, unknown>> {
  if (typeof connector.graphql !== 'function') {
    throw new BoardError(`The ${connector.name} connector has no GraphQL API`, [
      'Projects v2 fields are GraphQL-only, so this provider must expose a GraphQL entry point to provision them.',
    ]);
  }
  return connector.graphql.bind(connector);
}

/**
 * The scope a Project-write needs, in both token vocabularies. Named in the
 * error so an operator knows exactly what to grant, rather than guessing at a
 * bare 403.
 */
const PROJECT_SCOPE = 'write:project (a fine-grained token) or project (a classic token)';

/**
 * Turn a GraphQL `errors` payload into a `BoardError`. A permission-shaped
 * failure (FORBIDDEN / INSUFFICIENT_SCOPES / "not accessible" and friends)
 * names the required scope; anything else reports the raw message.
 *
 * `operation` is the human-readable thing that failed, e.g.
 * `create Project field "Priority"` — it is the "what could not be created".
 */
function mutationError(operation: string, errors: unknown[]): BoardError {
  const first = (errors[0] as { message?: unknown; type?: unknown } | undefined);
  const message = typeof first?.message === 'string' ? first.message : JSON.stringify(errors[0]);
  const type = typeof first?.type === 'string' ? first.type : '';
  const denied = /permission|not accessible|forbidden|insufficient|scope|authoriz/i.test(
    `${type} ${message}`,
  );
  if (denied) {
    return new BoardError(
      `Cannot ${operation}: the credential lacks the scope to write Project structure`,
      [`GitHub said: ${message}`, `Required scope: ${PROJECT_SCOPE}`],
    );
  }
  return new BoardError(`Cannot ${operation}`, [`GitHub GraphQL said: ${message}`]);
}

/** Send one mutation, throwing a `BoardError` on a GraphQL error. */
async function mutate(
  graphql: (query: string, variables?: Record<string, unknown>) => Promise<Record<string, unknown>>,
  query: string,
  variables: Record<string, unknown>,
  operation: string,
): Promise<void> {
  const body = await graphql(query, variables);
  const errors = body && typeof body === 'object' ? body['errors'] : undefined;
  if (Array.isArray(errors) && errors.length > 0) {
    throw mutationError(operation, errors as unknown[]);
  }
}

/**
 * Execute a provisioning plan against the live Project, one mutation at a
 * time: create each missing field (with its options), then add the missing
 * options to each existing single-select. Returns what was created; a failed
 * mutation throws a `BoardError` naming the operation and — for a permission
 * failure — the required scope.
 *
 * The caller re-resolves and re-caches the ids afterwards (LP-310), so the
 * new field and option node ids land in `.lpm/remotes/<name>/github.json`.
 */
export async function provisionProjectGraphql(
  connector: ProjectGraphqlConnector,
  projectId: string,
  plan: ProjectProvisionPlan,
): Promise<ProjectProvisionOutcome> {
  const graphql = graphqlOf(connector);
  const created: string[] = [];
  const optionsAdded: Array<{ field: string; added: string[] }> = [];

  for (const field of plan.createFields) {
    const input: Record<string, unknown> = {
      projectId,
      dataType: field.dataType,
      name: field.name,
    };
    if (field.dataType === 'SINGLE_SELECT') {
      input['singleSelectOptions'] = field.options.map((name) => ({ name }));
    }
    await mutate(
      graphql,
      CREATE_FIELD_MUTATION,
      { input },
      `create Project field "${field.name}"`,
    );
    created.push(field.name);
  }

  for (const entry of plan.addOptions) {
    await mutate(
      graphql,
      UPDATE_FIELD_MUTATION,
      { input: { fieldId: entry.fieldId, singleSelectOptions: entry.options } },
      `add ${entry.missing.length === 1 ? 'an option to' : `${entry.missing.length} options to`} Project field "${entry.fieldName}"`,
    );
    optionsAdded.push({ field: entry.fieldName, added: entry.missing });
  }

  return { created, optionsAdded };
}
