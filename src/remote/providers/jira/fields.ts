/**
 * Custom-field discovery (LP-327): resolve board attribute names to the
 * instance's `customfield_*` ids, cache the result per remote, and turn the
 * gaps into either a precise administrator-request list or a `provision` plan.
 *
 * Jira custom fields are the opposite of GitHub's Projects v2 fields: they
 * exist *globally* on the instance, are addressed by a per-instance id
 * (`customfield_10016`), and are only writable when they sit on the create /
 * edit *screen* for the right *issue type* in the right *project* — and
 * creating them needs the *Administer Jira* global permission, which the
 * syncing user usually does not have. So the honest scope (LP-320) is
 * discovery and a good error, not silent provisioning.
 *
 * The split mirrors `types.ts` (the pure judge plus the async preflight) and
 * `projects.ts` (the committed name→id cache):
 *
 *   - `parseFields` trims `GET /rest/api/3/field` into a `JiraField`;
 *   - `validateFieldMapping` resolves each `mapping.attributes` value — a
 *     `customfield_*` id passes through, a *name* resolves against the field
 *     list — and checks the field's type against the board attribute type;
 *   - `missingFromScreens` judges the resolved ids against the create-screen
 *     metadata (`POST /rest/api/3/issue/createmeta`), the one field list that
 *     says "this field is writable on a create of this type" before any write;
 *   - `fieldProblems` / `adminRequests` turn the report into the codebase's
 *     `Problem[]` and a copy-pasteable list of administrator requests;
 *   - `preflightFields` is the async composition that ties the connector
 *     fetch to the judges, ready for the sync command to call before a push;
 *   - `loadFieldCache` / `saveFieldCache` / `resolveFieldIds` cache the field
 *     list under `.lpm/remotes/<name>/jira.json`, so a teammate's first sync
 *     is a read rather than ten discovery requests.
 *
 * Two honest limits, stated up front. The create screen is the preflight proxy
 * for *both* create and edit — no issue exists to query `editmeta` against, and
 * Jira's default screen scheme serves one screen for both. And `provision`
 * adds a field to the instance's *default* screen: walking the full
 * screen-scheme chain to the exact issue-type screen is a later refinement,
 * and the administrator-request list names the exact issue types when that
 * precision matters.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BoardError } from '../../../core/errors.js';
import type { BoardPaths } from '../../../core/storage/paths.js';
import type { AttributeType, Problem } from '../../../core/model/types.js';
import { claimedTypeValues, normalizeTypeMappings } from '../../mapping.js';
import type { AttributeDefs } from '../../provider.js';

// ---------------------------------------------------------------------------
// The field model
// ---------------------------------------------------------------------------

/**
 * One custom field as `GET /rest/api/3/field` returns it, trimmed to what
 * discovery needs: the id (`customfield_10016`), the name a person writes in
 * the mapping, and the two schema facts that decide compatibility (`type`, the
 * value shape) and creation (`custom`, the plugin key).
 */
export interface JiraField {
  /** The per-instance id, e.g. `customfield_10016`. */
  id: string;
  /** The field's display name, e.g. "Story Points". */
  name: string;
  /** True when this is a custom field (as opposed to a system field). */
  custom: boolean;
  /** `schema.type` — the value shape: `string`, `number`, `date`, `option`, `array`, … */
  schemaType: string;
  /** `schema.custom` — the custom field type key, e.g. `...customfieldtypes:float`. */
  customType: string;
}

/** Read the raw `GET /rest/api/3/field` response into `JiraField`s. */
export function parseFields(raw: unknown): JiraField[] {
  if (!Array.isArray(raw)) return [];
  const out: JiraField[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record['id'] === 'string' ? record['id'] : '';
    const name = typeof record['name'] === 'string' ? record['name'] : '';
    if (id === '' || name === '') continue;
    const schema = record['schema'];
    const schemaRecord =
      schema !== null && typeof schema === 'object' ? (schema as Record<string, unknown>) : {};
    out.push({
      id,
      name,
      custom: record['custom'] === true,
      schemaType: typeof schemaRecord['type'] === 'string' ? schemaRecord['type'] : '',
      customType: typeof schemaRecord['custom'] === 'string' ? schemaRecord['custom'] : '',
    });
  }
  return out;
}

/** True when a mapping value already names a field id (`customfield_10016`). */
export function isCustomFieldId(value: string): boolean {
  return /^customfield_\d+$/.test(value.trim());
}

// ---------------------------------------------------------------------------
// Attribute type ↔ field type
// ---------------------------------------------------------------------------

/** The custom field type key and UI label a board attribute type is created as. */
export interface CustomFieldType {
  /** The `type` key `POST /rest/api/3/field` accepts. */
  typeKey: string;
  /** The field's name in the Jira admin UI, for a request a human reads. */
  label: string;
}

/**
 * The custom field type a board attribute type maps to when *created*, or
 * `undefined` when Jira has no field type that can carry it. `bool` is the one
 * without a native home — Jira has no boolean custom field — which is reported
 * rather than coerced into a guessed single-select.
 */
export function customFieldTypeFor(attributeType: AttributeType): CustomFieldType | undefined {
  switch (attributeType) {
    case 'string':
      return {
        typeKey: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield',
        label: 'Text Field (single line)',
      };
    case 'text':
      return {
        typeKey: 'com.atlassian.jira.plugin.system.customfieldtypes:textarea',
        label: 'Text Field (multi-line)',
      };
    case 'int':
    case 'float':
      return {
        typeKey: 'com.atlassian.jira.plugin.system.customfieldtypes:float',
        label: 'Number Field',
      };
    case 'date':
      return {
        typeKey: 'com.atlassian.jira.plugin.system.customfieldtypes:datepicker',
        label: 'Date Picker',
      };
    case 'enum':
      return {
        typeKey: 'com.atlassian.jira.plugin.system.customfieldtypes:select',
        label: 'Select List (single choice)',
      };
    case 'array':
      return {
        typeKey: 'com.atlassian.jira.plugin.system.customfieldtypes:multiselect',
        label: 'Select List (multiple choices)',
      };
    case 'bool':
      return undefined;
  }
}

/**
 * True when a field's `schema.type` can carry a board attribute of this type.
 * The shapes are Jira's own: `string` carries `string`/`text`, `number`
 * carries `int`/`float`, `date`/`datetime` carry `date`, `option` (a
 * single-select) carries `enum`, `array` (multi-select/checkbox) carries
 * `array`. `bool` fits nothing — there is no boolean custom field type.
 */
export function fieldFitsAttribute(attributeType: AttributeType, field: JiraField): boolean {
  switch (attributeType) {
    case 'string':
    case 'text':
      return field.schemaType === 'string';
    case 'int':
    case 'float':
      return field.schemaType === 'number';
    case 'date':
      return field.schemaType === 'date' || field.schemaType === 'datetime';
    case 'enum':
      return field.schemaType === 'option';
    case 'array':
      return field.schemaType === 'array';
    case 'bool':
      return false;
  }
}

// ---------------------------------------------------------------------------
// Name → id resolution (pure)
// ---------------------------------------------------------------------------

/** How one `mapping.attributes` value resolves against the field list. */
export type FieldResolution =
  /** The mapping already names a `customfield_*` id. */
  | { status: 'id'; id: string; field?: JiraField }
  /** The name resolved to exactly one field. */
  | { status: 'resolved'; field: JiraField }
  /** The name matches several fields — the config must name the id. */
  | { status: 'ambiguous'; name: string; fields: JiraField[] }
  /** No field has this name. */
  | { status: 'missing'; name: string };

/** Resolve one mapping value: a `customfield_*` id passes through, a name is looked up. */
export function resolveAttributeField(value: string, fields: readonly JiraField[]): FieldResolution {
  if (isCustomFieldId(value)) {
    const field = fields.find((f) => f.id === value);
    return { status: 'id', id: value, ...(field ? { field } : {}) };
  }
  const matches = fields.filter((f) => f.name === value);
  if (matches.length === 0) return { status: 'missing', name: value };
  if (matches.length === 1) return { status: 'resolved', field: matches[0]! };
  return { status: 'ambiguous', name: value, fields: matches };
}

/** One mapped attribute, after resolution and type checking. */
export interface FieldEntry {
  /** The board attribute name (the `mapping.attributes` key). */
  attribute: string;
  /** What the mapping wrote — a field name or a `customfield_*` id. */
  mapped: string;
  resolution: FieldResolution;
  /** The board attribute type, when the board declares it. */
  attributeType?: AttributeType;
  /** The resolved field, when there is exactly one. */
  field?: JiraField;
  /** True when the resolved field's type cannot carry the attribute type. */
  typeMismatch: boolean;
}

/** The mapping judged against the instance's field list. */
export interface FieldReport {
  /** The custom fields the instance reports, for "it has:" lists. */
  fields: JiraField[];
  entries: FieldEntry[];
}

/**
 * Judge `mapping.attributes` against the instance's field list: resolve each
 * value, and check each resolved field's type against the board attribute
 * type. Pure — types, fields and mapping in, a report out.
 */
export function validateFieldMapping(
  mapping: Record<string, unknown>,
  fields: readonly JiraField[],
  attributeDefs: AttributeDefs,
): FieldReport {
  const raw = (mapping['attributes'] ?? {}) as Record<string, unknown>;
  const entries: FieldEntry[] = [];
  for (const [attribute, value] of Object.entries(raw)) {
    if (typeof value !== 'string' || value.trim() === '') continue;
    const mapped = value.trim();
    const resolution = resolveAttributeField(mapped, fields);
    const def = attributeDefs[attribute];
    const field =
      resolution.status === 'resolved'
        ? resolution.field
        : resolution.status === 'id'
          ? resolution.field
          : undefined;
    entries.push({
      attribute,
      mapped,
      resolution,
      ...(def ? { attributeType: def.type } : {}),
      ...(field ? { field } : {}),
      typeMismatch: field !== undefined && def !== undefined && !fieldFitsAttribute(def.type, field),
    });
  }
  return { fields: [...fields], entries };
}

/**
 * The distinct issue type names the type mapping declares, sorted.
 *
 * Every value a Jira type mapping claims is an issuetype name — the mapping
 * declares *what* the type is called over there, and the provider decides that
 * Jira's carrier is the native issuetype field. Read through the normalizer,
 * because this takes a raw declaration rather than a schema-validated one.
 */
export function mappedIssueTypes(mapping: Record<string, unknown>): string[] {
  const types = normalizeTypeMappings((mapping['types'] ?? {}) as Record<string, unknown>);
  return [...new Set(claimedTypeValues(types))].sort();
}

// ---------------------------------------------------------------------------
// Screen presence (pure)
// ---------------------------------------------------------------------------

/** A resolved field that is not on the create screen of some mapped issue types. */
export interface ScreenAbsence {
  attribute: string;
  fieldId: string;
  fieldName: string;
  /** Issue type names whose create screen does not include the field. */
  missingFrom: string[];
}

/**
 * Judge the resolved fields against the create-screen metadata: for each mapped
 * issue type, is the field on that type's create screen? A field missing from
 * a type's create screen cannot be written on a create of that type — detected
 * here, from the metadata, rather than at the first failed write.
 */
export function missingFromScreens(
  report: FieldReport,
  createMeta: ReadonlyMap<string, ReadonlySet<string>>,
  issueTypes: readonly string[],
): ScreenAbsence[] {
  const types = issueTypes.filter((type) => createMeta.has(type));
  const out: ScreenAbsence[] = [];
  for (const entry of report.entries) {
    const field = entry.field;
    if (field === undefined) continue;
    const missingFrom: string[] = [];
    for (const type of types) {
      if (!createMeta.get(type)!.has(field.id)) missingFrom.push(type);
    }
    if (missingFrom.length > 0) {
      out.push({ attribute: entry.attribute, fieldId: field.id, fieldName: field.name, missingFrom });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The report → `Problem[]` and the administrator-request list
// ---------------------------------------------------------------------------

/**
 * The report as `Problem[]` — the shape `lpm remote …` prints and
 * `hasErrorProblems` gates on. Every finding is an error: an unresolved name,
 * an ambiguous name, a field type that cannot carry the attribute, or a field
 * not on the create screen, each would fail a write, so each blocks the push.
 */
export function fieldProblems(
  report: FieldReport,
  screen: ScreenAbsence[],
  remoteName: string,
  configPath: string,
): Problem[] {
  const problems: Problem[] = [];
  const names = report.fields.map((field) => field.name).sort();

  for (const entry of report.entries) {
    const path = `remotes.${remoteName}.mapping.attributes.${entry.attribute}`;
    if (entry.resolution.status === 'missing') {
      problems.push({
        level: 'error',
        path: configPath,
        message:
          `${path}: no custom field named "${entry.resolution.name}"` +
          (names.length > 0 ? ` — the instance has: ${names.join(', ')}` : ' — the instance reports no custom fields'),
      });
    } else if (entry.resolution.status === 'ambiguous') {
      problems.push({
        level: 'error',
        path: configPath,
        message:
          `${path}: the name "${entry.resolution.name}" matches ${entry.resolution.fields.length} custom fields ` +
          `(${entry.resolution.fields.map((f) => f.id).join(', ')}) — write the id you mean, not the name`,
      });
    }

    if (entry.typeMismatch && entry.field) {
      problems.push({
        level: 'error',
        path: configPath,
        message:
          `${path}: the field "${entry.field.name}" (${entry.field.id}) holds ${entry.field.schemaType || 'an unknown type'}, ` +
          `which cannot carry a ${entry.attributeType ?? '?'} attribute`,
      });
    }
  }

  for (const absence of screen) {
    const path = `remotes.${remoteName}.mapping.attributes.${absence.attribute}`;
    problems.push({
      level: 'error',
      path: configPath,
      message:
        `${path}: "${absence.fieldName}" (${absence.fieldId}) is not on the create screen of ` +
        `${absence.missingFrom.join(', ')} — an admin must add it there, or the first write will fail`,
    });
  }

  return problems;
}

/**
 * The report as a copy-pasteable list of requests for a Jira administrator.
 *
 * This is a real deliverable, not a fallback (LP-320): the person running the
 * sync is usually *not* the person who can change a Jira project, and a list
 * they can paste into a ticket is what makes adoption possible. Each line is a
 * self-contained request naming the field, the type, the project and — where
 * a field exists but is off-screen — the issue types it must be added to.
 */
export function adminRequests(
  report: FieldReport,
  screen: ScreenAbsence[],
  remoteName: string,
  projectKey: string,
): string[] {
  const requests: string[] = [];

  for (const entry of report.entries) {
    if (entry.resolution.status === 'missing') {
      const type = entry.attributeType ? customFieldTypeFor(entry.attributeType) : undefined;
      if (type !== undefined) {
        requests.push(
          `Create a custom field named "${entry.resolution.name}" of type "${type.label}" ` +
            `(${type.typeKey}) in project ${projectKey}, and add it to the create/edit screen of the issue types that carry "${entry.attribute}".`,
        );
      } else {
        requests.push(
          `Create a custom field to carry "${entry.attribute}" in project ${projectKey}. ` +
            `Jira has no native "${entry.attributeType ?? '?'}" field type — a single-select with True/False options is the usual substitute.`,
        );
      }
    } else if (entry.resolution.status === 'ambiguous') {
      const fields = entry.resolution.fields
        .map((f) => `${f.name} = ${f.id}`)
        .join('; ');
      requests.push(
        `Disambiguate "${entry.attribute}": it names ${entry.resolution.fields.length} fields (${fields}). ` +
          `Set remotes.${remoteName}.mapping.attributes.${entry.attribute} to the exact id.`,
      );
    }
  }

  for (const absence of screen) {
    requests.push(
      `Add "${absence.fieldName}" (${absence.fieldId}) to the create/edit screen of issue type` +
        `${absence.missingFrom.length === 1 ? '' : 's'} ${absence.missingFrom.join(', ')} in project ${projectKey}.`,
    );
  }

  return requests;
}

// ---------------------------------------------------------------------------
// The live preflight (async composition)
// ---------------------------------------------------------------------------

/** The connector surface the field logic reads — a live Jira connector or a fake. */
export interface JiraFieldConnector {
  readonly name: string;
  /** List the instance's custom fields (`GET /rest/api/3/field`, custom only). */
  fields?(): Promise<JiraField[]>;
  /** The create-screen field ids, keyed by issue type name (`createmeta`). */
  createMeta?(): Promise<Map<string, Set<string>>>;
  /** Create a custom field (needs Administer Jira). Returns its new id. */
  createField?(name: string, typeKey: string, signal?: AbortSignal): Promise<{ id: string }>;
  /** Add a field to the default screen (needs Administer Jira). */
  addFieldToScreen?(fieldId: string, signal?: AbortSignal): Promise<void>;
}

/** A connector that implements all four field operations — the live Jira connector. */
export interface JiraConnector extends JiraFieldConnector {
  fields(): Promise<JiraField[]>;
  createMeta(): Promise<Map<string, Set<string>>>;
  createField(name: string, typeKey: string, signal?: AbortSignal): Promise<{ id: string }>;
  addFieldToScreen(fieldId: string, signal?: AbortSignal): Promise<void>;
}

/**
 * The live preflight for custom fields: fetch the instance's fields through the
 * connector, judge the board's `mapping.attributes` against them, and — when
 * the connector can read the create-screen metadata — report a field that is
 * not on the create screen of a mapped issue type. Returns the `Problem[]` a
 * sync gates on (`hasErrorProblems`).
 *
 * A connector without `fields()` is a no-op (a fake, or a provider with no
 * custom fields), exactly as `preflightTypeScheme` is for a connector without
 * `issueTypes()`.
 */
export async function preflightFields(
  connector: JiraFieldConnector,
  mapping: Record<string, unknown>,
  attributeDefs: AttributeDefs,
  remoteName: string,
  configPath: string,
): Promise<Problem[]> {
  if (typeof connector.fields !== 'function') return [];
  const fields = await connector.fields();
  const report = validateFieldMapping(mapping, fields, attributeDefs);

  let screen: ScreenAbsence[] = [];
  const issueTypes = mappedIssueTypes(mapping);
  if (typeof connector.createMeta === 'function' && issueTypes.length > 0) {
    const meta = await connector.createMeta();
    screen = missingFromScreens(report, meta, issueTypes);
  }

  return fieldProblems(report, screen, remoteName, configPath);
}

// ---------------------------------------------------------------------------
// Provisioning (the admin path)
// ---------------------------------------------------------------------------

/** What `provision` would create and add to the default screen. */
export interface FieldProvisionPlan {
  /** Fields to create: the attribute, its desired name, and the type to create. */
  create: Array<{ attribute: string; name: string; typeKey: string; label: string }>;
  /** Resolved field ids that must be added to the default screen. */
  addToScreen: string[];
  empty: boolean;
}

/**
 * The provision plan for a field report: every missing field that Jira *can*
 * create (an attribute type with a native field type), plus every resolved
 * field that sits off-screen. An ambiguous name is deliberately not
 * provisionable — creating a field would guess which of two ids was meant, so
 * the config must disambiguate first (the report already says so).
 */
export function planFieldProvision(report: FieldReport, screen: ScreenAbsence[]): FieldProvisionPlan {
  const create: FieldProvisionPlan['create'] = [];
  const addToScreen = new Set<string>();

  for (const entry of report.entries) {
    if (entry.resolution.status !== 'missing') continue;
    const type = entry.attributeType ? customFieldTypeFor(entry.attributeType) : undefined;
    if (type === undefined) continue; // e.g. bool — no native field type; reported, not created
    create.push({ attribute: entry.attribute, name: entry.resolution.name, typeKey: type.typeKey, label: type.label });
  }

  for (const absence of screen) addToScreen.add(absence.fieldId);

  return {
    create,
    addToScreen: [...addToScreen].sort(),
    empty: create.length === 0 && addToScreen.size === 0,
  };
}

/** What a `provisionFields` run did. */
export interface FieldProvisionResult {
  created: Array<{ attribute: string; id: string }>;
  addedToScreen: string[];
}

/**
 * Execute a provision plan: create each missing field, then add it — and every
 * pre-existing off-screen field — to the default screen. The connector's
 * `createField` / `addFieldToScreen` carry the Administer-Jira requirement, so
 * a credential without it surfaces as a permission error there; the caller is
 * the one that decided to attempt provision at all.
 */
export async function provisionFields(
  connector: JiraFieldConnector,
  plan: FieldProvisionPlan,
  signal?: AbortSignal,
): Promise<FieldProvisionResult> {
  if (typeof connector.createField !== 'function' || typeof connector.addFieldToScreen !== 'function') {
    throw new BoardError(`The ${connector.name} connector cannot provision custom fields`, [
      'This provider exposes no field-creation API, so missing fields cannot be provisioned.',
    ]);
  }

  const created: FieldProvisionResult['created'] = [];
  for (const field of plan.create) {
    const result = await connector.createField(field.name, field.typeKey, signal);
    created.push({ attribute: field.attribute, id: result.id });
  }

  const ids = new Set<string>([...created.map((entry) => entry.id), ...plan.addToScreen]);
  const addedToScreen: string[] = [];
  for (const id of ids) {
    await connector.addFieldToScreen(id, signal);
    addedToScreen.push(id);
  }

  return { created, addedToScreen: addedToScreen.sort() };
}

// ---------------------------------------------------------------------------
// The committed cache (`.lpm/remotes/<name>/jira.json`)
// ---------------------------------------------------------------------------

/** What lives on disk inside `.lpm/remotes/<name>/jira.json`. */
export interface JiraFieldCacheFile {
  version: 1;
  /** ISO timestamp of the resolution that produced this file. */
  resolvedAt: string;
  /** The instance's custom fields, in the order the API returned them. */
  fields: JiraField[];
}

/** The path to one remote's Jira field cache. */
export function fieldCachePath(paths: BoardPaths, remoteName: string): string {
  return path.join(paths.remotesDir, remoteName, 'jira.json');
}

/**
 * Read the field cache, or `undefined` when none has been recorded yet. A file
 * that exists but is malformed (or a newer version) is a `BoardError` naming
 * the path; delete it to re-resolve.
 */
export function loadFieldCache(paths: BoardPaths, remoteName: string): JiraFieldCacheFile | undefined {
  const file = fieldCachePath(paths, remoteName);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new BoardError(`Cannot parse the Jira field cache: ${file}`, [
      (error as Error).message,
      'Delete it to re-resolve the fields, or repair the JSON.',
    ]);
  }

  const cache = parsed as Partial<JiraFieldCacheFile>;
  if (cache.version !== 1) {
    throw new BoardError(`Unsupported Jira field cache version in ${file}`, [
      `Found version ${JSON.stringify(cache.version)}; expected 1.`,
      'Delete it to re-resolve the fields.',
    ]);
  }
  if (!Array.isArray(cache.fields)) {
    throw new BoardError(`Invalid Jira field cache: ${file}`, [
      'The cache is missing a valid fields array.',
      'Delete it to re-resolve the fields.',
    ]);
  }
  return {
    version: 1,
    resolvedAt: typeof cache.resolvedAt === 'string' ? cache.resolvedAt : '',
    fields: cache.fields,
  };
}

/** Write the field cache to disk, creating the per-remote folder if needed. */
export function saveFieldCache(paths: BoardPaths, remoteName: string, cache: JiraFieldCacheFile): void {
  const file = fieldCachePath(paths, remoteName);
  mkdirSync(path.dirname(file), { recursive: true });
  const onDisk: JiraFieldCacheFile = { version: 1, resolvedAt: cache.resolvedAt, fields: cache.fields };
  writeFileSync(file, `${JSON.stringify(onDisk, null, 2)}\n`, 'utf8');
}

/** Options for `resolveFieldIds`. */
export interface ResolveFieldIdsOptions {
  /** Re-resolve even when a cache exists. */
  refresh?: boolean;
  /** Clock, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** What `resolveFieldIds` returns. */
export interface ResolveFieldIdsResult {
  /** The instance's custom fields — fresh, or straight from the cache. */
  fields: JiraField[];
  /** True when a network resolution ran (a cache miss or `--refresh`). */
  refreshed: boolean;
}

/**
 * Resolve the instance's custom fields, reading the cache when it exists and
 * re-resolving on a cache miss or `refresh`. The cache is the committed
 * `.lpm/remotes/<name>/jira.json`, so a teammate who pulls the board reads the
 * ids instead of re-fetching them; only a cache miss or an explicit `--refresh`
 * reaches the network. Name→id resolution itself is `validateFieldMapping`'s
 * job, over the list this returns.
 */
export async function resolveFieldIds(
  connector: JiraFieldConnector,
  paths: BoardPaths,
  remoteName: string,
  opts: ResolveFieldIdsOptions = {},
): Promise<ResolveFieldIdsResult> {
  const previous = loadFieldCache(paths, remoteName);
  if (previous !== undefined && opts.refresh !== true) {
    return { fields: previous.fields, refreshed: false };
  }

  if (typeof connector.fields !== 'function') {
    throw new BoardError(`The ${connector.name} connector cannot list custom fields`, [
      'This provider exposes no field list, so names cannot be resolved to ids.',
    ]);
  }

  const fields = await connector.fields();
  saveFieldCache(paths, remoteName, {
    version: 1,
    resolvedAt: new Date(opts.now ? opts.now() : Date.now()).toISOString(),
    fields,
  });
  return { fields, refreshed: true };
}
