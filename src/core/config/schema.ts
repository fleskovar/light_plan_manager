import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import { validateAttributeValue } from '../model/attributes.js';
import type { AttributeType, BoardConfig, NodeKind } from '../model/types.js';
import { ATTRIBUTE_TYPES, TEMPLATE_FOLDER_TYPE, reservedFieldsFor } from '../model/types.js';
import type { BoardPaths } from '../storage/paths.js';

const IDENT_RE = /^[a-z][a-z0-9_]*$/;
/** The one remote name a tracker may not take: `lpm remote git` is the board's own git remote. */
export const RESERVED_REMOTE_NAME = 'git';
const PREFIX_RE = /^[A-Z][A-Z0-9]{0,9}$/;
const PREFIX_MESSAGE = 'must be 1-10 uppercase letters or digits, starting with a letter';

/**
 * The id prefix registry templates take when a board says nothing.
 *
 * Every other namespace is opt-in and so has no default; the registry is always
 * there, because it is written in the board's own issue types. A board whose
 * `key_prefix` really is `TPL` sets `template_prefix` instead — the collision
 * check below says so rather than letting two namespaces mint the same id.
 */
const DEFAULT_TEMPLATE_PREFIX = 'TPL';

const attributeDefSchema = z.object({
  type: z.enum(ATTRIBUTE_TYPES),
  description: z.string().optional(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  values: z.array(z.string()).min(1).optional(),
});

const typeSchema = z.object({
  label: z.string().min(1),
  attributes: z.record(z.string(), attributeDefSchema).default({}),
  body: z.string().default(''),
  generic: z.boolean().optional(),
  atomic: z.boolean().optional(),
});

const statusSchema = z.object({
  id: z.string().regex(IDENT_RE, 'must be lower_snake_case'),
  label: z.string().min(1),
  terminal: z.boolean().optional(),
  active: z.boolean().optional(),
});

const hierarchySchema = z.array(z.union([z.string(), z.array(z.string()).min(1)])).min(1);
const typeMapSchema = z.record(z.string().regex(IDENT_RE, 'must be lower_snake_case'), typeSchema);

/**
 * A per-field conflict override: the field always takes this owner and never
 * conflicts. `owner: local` means the board wins, `owner: remote` the remote.
 */
const fieldOwnerSchema = z.object({
  owner: z.enum(['local', 'remote']),
});

/**
 * The frame of one remote. Core validates this much and nothing more:
 * `connection` and `mapping` are opaque records whose contents are the
 * provider's to validate, not core's — core must never know what a provider is.
 *
 * `fields` is the one policy block core *can* read the contents of: it names
 * board fields (canonical fields and attribute names), which are core's
 * vocabulary, not a provider's. The `{ owner }` spelling is flattened to the
 * owner value, so a caller reads `fields.status` and gets `'remote'`.
 */
const remoteSchema = z.object({
  provider: z.string().min(1),
  scope: z.string().optional(),
  direction: z.enum(['both', 'push', 'pull']).default('both'),
  on_delete: z.enum(['unlink', 'close', 'delete', 'restore', 'manual']).default('unlink'),
  conflict: z.enum(['manual', 'local', 'remote']),
  /**
   * The bulk guard (LP-364): a run where more than this fraction of linked
   * twins is missing at once is treated as unreachable rather than as a wave
   * of deletions, because infrastructure failures arrive all at once and real
   * deletions arrive a few at a time. `1` disables the guard (a fraction can
   * never exceed 1); absent means the resolver's default of 0.5 applies.
   */
  bulk_guard: z.number().min(0).max(1).optional(),
  /**
   * The write threshold (LP-350): a push whose plan creates or closes more
   * than this many issues stops and requires `--yes`, so a misconfigured scope
   * cannot turn into a wave of duplicate or closed tickets. Absent means the
   * default of 25 applies.
   */
  write_threshold: z.number().int().positive().optional(),
  fields: z
    .record(z.string(), fieldOwnerSchema)
    .transform((entries) =>
      Object.fromEntries(Object.entries(entries).map(([field, entry]) => [field, entry.owner])),
    )
    .default({}),
  encoding: z.enum(['block', 'comment']).default('block'),
  comments: z.enum(['push', 'both']).default('push'),
  connection: z.record(z.string(), z.unknown()).default({}),
  mapping: z.record(z.string(), z.unknown()).default({}),
});

/**
 * A git remote or branch name, conservatively: the characters every host
 * accepts, nothing a shell or a refspec would read as syntax, and no leading
 * dash (which git would take for an option).
 */
const GIT_NAME_RE = /^(?!-)[A-Za-z0-9._/-]+$/;
const GIT_NAME_MESSAGE = 'must be a plain git name (letters, digits, ".", "_", "-", "/")';

const rawConfigSchema = z.object({
  version: z.number().int().positive().default(1),
  key_prefix: z.string().regex(PREFIX_RE, PREFIX_MESSAGE),
  statuses: z.array(statusSchema).min(1),
  default_status: z.string().optional(),
  issue_types: typeMapSchema,
  hierarchy: hierarchySchema,

  period_prefix: z.string().regex(PREFIX_RE, PREFIX_MESSAGE).optional(),
  period_types: typeMapSchema.optional(),
  period_hierarchy: hierarchySchema.optional(),
  default_period: z.string().optional(),

  resource_prefix: z.string().regex(PREFIX_RE, PREFIX_MESSAGE).optional(),
  resource_types: typeMapSchema.optional(),
  resource_hierarchy: hierarchySchema.optional(),

  squad_prefix: z.string().regex(PREFIX_RE, PREFIX_MESSAGE).optional(),
  squad_types: typeMapSchema.optional(),
  squad_hierarchy: hierarchySchema.optional(),

  // The registry has no types or hierarchy of its own: a template *is* an issue
  // of one of the board's own types, so both are derived from `issue_types` and
  // `hierarchy`. Only the id prefix has to be said out loud.
  template_prefix: z.string().regex(PREFIX_RE, PREFIX_MESSAGE).optional(),

  priority_attribute: z.string().regex(IDENT_RE, 'must be lower_snake_case').optional(),
  effort_attribute: z.string().regex(IDENT_RE, 'must be lower_snake_case').optional(),

  remotes: z.record(z.string(), remoteSchema).default({}),
  // Remotes turned off, kept whole so they can be turned on again — see
  // `operations/remotes-off.ts`. Validated as strictly as an active one, so a
  // block that was valid when it was turned off is valid when it comes back.
  remotes_off: z.record(z.string(), remoteSchema).default({}),

  // Sharing the board itself through its git repository. Present means on.
  git_sync: z
    .object({
      remote: z.string().regex(GIT_NAME_RE, GIT_NAME_MESSAGE).default('origin'),
      branch: z.string().regex(GIT_NAME_RE, GIT_NAME_MESSAGE).default('main'),
    })
    .strict()
    .optional(),
});

type RawConfig = z.infer<typeof rawConfigSchema>;

export interface ConfigResult {
  config: BoardConfig | null;
  errors: string[];
}

import { formatZodIssues } from '../model/zod.js';

function normalizeHierarchy(levels: Array<string | string[]>): string[][] {
  return levels.map((level) => (typeof level === 'string' ? [level] : level));
}

/** The config keys that describe one namespace, keyed by the kind they govern. */
const NAMESPACE_KEYS = {
  issue: { types: 'issue_types', hierarchy: 'hierarchy', prefix: 'key_prefix' },
  period: { types: 'period_types', hierarchy: 'period_hierarchy', prefix: 'period_prefix' },
  resource: { types: 'resource_types', hierarchy: 'resource_hierarchy', prefix: 'resource_prefix' },
  squad: { types: 'squad_types', hierarchy: 'squad_hierarchy', prefix: 'squad_prefix' },
} as const;

/**
 * The namespaces a board *declares*. The registry is deliberately not one of
 * them: it reuses `issue_types` and `hierarchy`, so there is nothing about it
 * for a config to get wrong beyond its id prefix.
 */
type DeclaredKind = keyof typeof NAMESPACE_KEYS;

/** Hierarchy <-> type-map consistency, shared by all three namespaces. */
function checkNamespace(
  types: Record<string, { attributes: Record<string, unknown> }>,
  hierarchy: string[][],
  kind: DeclaredKind,
  errors: string[],
): void {
  const { types: typesKey, hierarchy: label } = NAMESPACE_KEYS[kind];
  const declared = Object.keys(types);
  const seen = new Map<string, number>();

  hierarchy.forEach((level, depth) => {
    for (const name of level) {
      if (seen.has(name)) {
        errors.push(
          `${label}: "${name}" appears at level ${seen.get(name)} and level ${depth}; each type belongs to exactly one level`,
        );
      } else {
        seen.set(name, depth);
      }
      if (!declared.includes(name)) {
        errors.push(`${label}: "${name}" is not defined under ${typesKey}`);
      }
    }
  });

  for (const name of declared) {
    if (!seen.has(name)) {
      errors.push(`${typesKey}.${name}: declared but missing from ${label}`);
    }
  }
}

function checkAttributes(
  path: string,
  types: RawConfig['issue_types'],
  kind: DeclaredKind,
  errors: string[],
): void {
  const reserved = reservedFieldsFor(kind);
  for (const [typeName, typeDef] of Object.entries(types)) {
    for (const [attrName, attrDef] of Object.entries(typeDef.attributes)) {
      const where = `${path}.${typeName}.attributes.${attrName}`;
      if (reserved.includes(attrName)) {
        errors.push(`${where}: "${attrName}" is a reserved field name`);
      }
      if (!IDENT_RE.test(attrName)) {
        errors.push(`${where}: attribute names must be lower_snake_case`);
      }
      if (attrDef.type === 'enum' && !attrDef.values) {
        errors.push(`${where}: enum attributes need a "values" list`);
      }
      if (attrDef.type !== 'enum' && attrDef.values) {
        errors.push(`${where}: "values" is only valid for enum attributes`);
      }
      if (attrDef.default !== undefined) {
        const problem = validateAttributeValue(attrDef, attrDef.default);
        if (problem) errors.push(`${where}.default: ${problem}`);
      }
    }
  }
}

/**
 * Periods and resources are opt-in: a board declares the whole namespace or
 * none of it. Returns true when this one is in use.
 */
function checkOptionalNamespace(
  kind: 'period' | 'resource' | 'squad',
  raw: RawConfig,
  hierarchy: string[][],
  errors: string[],
): boolean {
  const keys = NAMESPACE_KEYS[kind];
  const types = raw[keys.types];
  const rawHierarchy = raw[keys.hierarchy];
  if (!types && !rawHierarchy) return false;

  if (!types) errors.push(`${keys.types}: required when ${keys.hierarchy} is set`);
  if (!rawHierarchy) errors.push(`${keys.hierarchy}: required when ${keys.types} is set`);
  if (!raw[keys.prefix]) {
    errors.push(`${keys.prefix}: required when the board declares ${kind} types`);
  }
  if (types && rawHierarchy) {
    checkNamespace(types, hierarchy, kind, errors);
    checkAttributes(keys.types, types, kind, errors);
  }
  return true;
}

/**
 * A type flag that means something in exactly one namespace. `generic` describes
 * a pool of people and means nothing outside the roster; `atomic` describes a
 * unit of work and means nothing outside the issue tree. Declaring one where
 * nothing will ever read it is a typo, not a harmless extra key.
 */
function checkTypeFlag(
  flag: 'generic' | 'atomic',
  owner: NodeKind,
  kind: DeclaredKind,
  types: RawConfig['issue_types'],
  errors: string[],
): void {
  const key = NAMESPACE_KEYS[kind].types;
  for (const [name, def] of Object.entries(types)) {
    if (def[flag] !== undefined) {
      errors.push(`${key}.${name}.${flag}: only ${owner} types can be ${flag}`);
    }
  }
}

/**
 * `priority_attribute` / `effort_attribute` name an issue attribute the engine
 * reads (to rank work and to add up load), so the named attribute has to exist
 * and have a usable type wherever it is declared.
 */
function checkIssueAttributeRef(
  key: 'priority_attribute' | 'effort_attribute',
  name: string | undefined,
  types: RawConfig['issue_types'],
  allowed: AttributeType[],
  errors: string[],
): void {
  if (!name) return;
  const declaring = Object.entries(types).filter(([, def]) => def.attributes[name]);
  if (!declaring.length) {
    errors.push(`${key}: "${name}" is not an attribute of any issue type`);
    return;
  }
  for (const [typeName, def] of declaring) {
    const attribute = def.attributes[name]!;
    if (!allowed.includes(attribute.type)) {
      errors.push(
        `${key}: issue_types.${typeName}.attributes.${name} is "${attribute.type}"; expected ${allowed.join(' or ')}`,
      );
    }
  }
}

/**
 * Remote names follow IDENT_RE, and no two remotes may both claim the same
 * documents. Core cannot see the board tree from the config alone, so it
 * rejects every overlap it *can* see: an absent scope means the whole board,
 * which contains every other scope, and two equal scopes are the same subtree.
 * Two different, both-present scopes are left alone — whether one sits inside
 * the other is answered against the board tree (by `lpm check`), not here.
 */
function checkRemotes(raw: RawConfig, errors: string[]): void {
  for (const [key, block] of [
    ['remotes', raw.remotes],
    ['remotes_off', raw.remotes_off],
  ] as const) {
    for (const name of Object.keys(block)) {
      if (!IDENT_RE.test(name)) {
        errors.push(`${key}.${name}: remote names must be lower_snake_case`);
      }
      if (name === RESERVED_REMOTE_NAME) {
        errors.push(
          `${key}.${name}: "${name}" is reserved — \`lpm remote git\` is the board's own git remote`,
        );
      }
    }
  }

  // One name, one remote: the two blocks share `.lpm/remotes/<name>/`, so a
  // name in both would be two declarations writing one link store.
  for (const name of Object.keys(raw.remotes_off)) {
    if (raw.remotes[name]) {
      errors.push(
        `remotes.${name}: also declared under remotes_off — a turned-off remote comes back with ` +
          `\`lpm remote on ${name}\`, not by declaring it again`,
      );
    }
  }

  // A board is shared through git *or* mirrored onto trackers. Git replicates
  // the whole folder — every tracker's link store with it — so "one remote per
  // document" can only be decided for the board as a whole.
  if (raw.git_sync && Object.keys(raw.remotes).length > 0) {
    errors.push(
      `git_sync and remotes: a board syncs through git or mirrors onto trackers, not both ` +
        `(declared: ${Object.keys(raw.remotes).sort().join(', ')}). ` +
        'Turn the trackers off with `lpm remote off <name>` (kept, and `lpm remote on <name>` brings ' +
        'one back), or turn git sync off with `lpm git off`.',
    );
  }

  const names = Object.keys(raw.remotes);
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const a = raw.remotes[names[i]!]!.scope;
      const b = raw.remotes[names[j]!]!.scope;
      if (a === b || a === undefined || b === undefined) {
        // Say *why*, because the commonest way to hit this is the reasonable
        // wish to mirror one board onto two trackers: both declarations claim
        // the whole board, and "overlapping scopes" reads as a typo rather than
        // as the rule it is. Name the fix in the same line.
        const whole = a === undefined || b === undefined;
        errors.push(
          `remotes: "${names[i]}" and "${names[j]}" have overlapping scopes` +
            (whole
              ? ' — both mirror the whole board. Give each a different `scope:` (a document id), because two remotes may never mirror the same work.'
              : ` — both mirror ${a}. Two remotes may never mirror the same work.`),
        );
      }
    }
  }
}

/** Cross-field rules zod cannot express on its own. */
function checkSemantics(raw: RawConfig, hierarchies: Record<DeclaredKind, string[][]>): string[] {
  const errors: string[] = [];

  checkNamespace(raw.issue_types, hierarchies.issue, 'issue', errors);
  checkAttributes('issue_types', raw.issue_types, 'issue', errors);
  checkTypeFlag('generic', 'resource', 'issue', raw.issue_types, errors);

  const statusIdList = raw.statuses.map((status) => status.id);
  const duplicateStatus = statusIdList.find((id, index) => statusIdList.indexOf(id) !== index);
  if (duplicateStatus) errors.push(`statuses: duplicate status id "${duplicateStatus}"`);
  if (raw.default_status && !statusIdList.includes(raw.default_status)) {
    errors.push(`default_status: "${raw.default_status}" is not one of [${statusIdList.join(', ')}]`);
  }
  for (const status of raw.statuses) {
    if (status.terminal && status.active) {
      errors.push(`statuses.${status.id}: a status cannot be both terminal and active`);
    }
  }

  checkIssueAttributeRef('priority_attribute', raw.priority_attribute, raw.issue_types, ['enum'], errors);
  checkIssueAttributeRef('effort_attribute', raw.effort_attribute, raw.issue_types, ['int', 'float'], errors);

  const usesPeriods = checkOptionalNamespace('period', raw, hierarchies.period, errors);
  if (usesPeriods) {
    checkTypeFlag('generic', 'resource', 'period', raw.period_types ?? {}, errors);
    checkTypeFlag('atomic', 'issue', 'period', raw.period_types ?? {}, errors);
  }
  // The catch-all period new issues fall into (`lpm init` writes it). Only the
  // shape is checked here — whether the document exists is the board's
  // business, and `lpm check` reports one that does not.
  if (raw.default_period !== undefined) {
    const prefix = raw.period_prefix ?? '';
    if (!usesPeriods) {
      errors.push('default_period: names a period, but the config declares no period_types');
    } else if (!raw.default_period.startsWith(`${prefix}-`)) {
      errors.push(`default_period: "${raw.default_period}" is not a period id (${prefix}-<n>)`);
    }
  }
  const usesResources = checkOptionalNamespace('resource', raw, hierarchies.resource, errors);
  if (usesResources) {
    checkTypeFlag('atomic', 'issue', 'resource', raw.resource_types ?? {}, errors);
  }
  const usesSquads = checkOptionalNamespace('squad', raw, hierarchies.squad, errors);
  if (usesSquads) {
    checkTypeFlag('generic', 'resource', 'squad', raw.squad_types ?? {}, errors);
    checkTypeFlag('atomic', 'issue', 'squad', raw.squad_types ?? {}, errors);
  }

  // Ids from different namespaces must never collide...
  const prefixes: Array<[string, string]> = [['key_prefix', raw.key_prefix]];
  if (usesPeriods && raw.period_prefix) prefixes.push(['period_prefix', raw.period_prefix]);
  if (usesResources && raw.resource_prefix) prefixes.push(['resource_prefix', raw.resource_prefix]);
  if (usesSquads && raw.squad_prefix) prefixes.push(['squad_prefix', raw.squad_prefix]);
  // The registry is never opt-in — every board has one, because its types are
  // the board's own — so its prefix is always in the collision check.
  prefixes.push(['template_prefix', raw.template_prefix ?? DEFAULT_TEMPLATE_PREFIX]);
  for (let index = 1; index < prefixes.length; index += 1) {
    const [key, value] = prefixes[index]!;
    const clash = prefixes.slice(0, index).find(([, other]) => other === value);
    if (clash) {
      errors.push(`${key}: "${value}" must differ from ${clash[0]} so ids never collide`);
    }
  }

  // ...and `lpm new <type>` resolves the namespace from the type name, so a
  // name may not mean two different things either.
  const namespaces: Array<['issue' | 'period' | 'resource' | 'squad', Record<string, unknown>]> = [
    ['issue', raw.issue_types],
  ];
  if (usesPeriods) namespaces.push(['period', raw.period_types ?? {}]);
  if (usesResources) namespaces.push(['resource', raw.resource_types ?? {}]);
  if (usesSquads) namespaces.push(['squad', raw.squad_types ?? {}]);
  const owner = new Map<string, string>();
  for (const [kind, types] of namespaces) {
    for (const name of Object.keys(types)) {
      // The registry reuses the issue types by name and adds exactly one of its
      // own, so a board that also called something `folder` would make "which
      // folder?" unanswerable. @see TEMPLATE_FOLDER_TYPE
      if (name === TEMPLATE_FOLDER_TYPE) {
        errors.push(
          `${NAMESPACE_KEYS[kind].types}.${name}: "${name}" is reserved for the template registry`,
        );
        continue;
      }
      const previous = owner.get(name);
      if (previous) {
        const article = previous === 'issue' ? 'an' : 'a';
        errors.push(
          `${NAMESPACE_KEYS[kind].types}.${name}: "${name}" is also ${article} ${previous} type; type names must be unique across namespaces`,
        );
      } else {
        owner.set(name, kind);
      }
    }
  }

  checkRemotes(raw, errors);

  return errors;
}

export function parseConfigText(text: string): ConfigResult {
  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch (error) {
    return { config: null, errors: [`invalid YAML: ${(error as Error).message}`] };
  }

  const parsed = rawConfigSchema.safeParse(doc);
  if (!parsed.success) return { config: null, errors: formatZodIssues(parsed.error) };

  const raw = parsed.data;
  const hierarchies: Record<DeclaredKind, string[][]> = {
    issue: normalizeHierarchy(raw.hierarchy),
    period: normalizeHierarchy(raw.period_hierarchy ?? []),
    resource: normalizeHierarchy(raw.resource_hierarchy ?? []),
    squad: normalizeHierarchy(raw.squad_hierarchy ?? []),
  };
  const errors = checkSemantics(raw, hierarchies);
  if (errors.length) return { config: null, errors };

  return {
    config: {
      version: raw.version,
      key_prefix: raw.key_prefix,
      default_status: raw.default_status ?? raw.statuses[0]!.id,
      statuses: raw.statuses,
      issue_types: raw.issue_types,
      hierarchy: hierarchies.issue,
      period_prefix: raw.period_prefix ?? '',
      period_types: raw.period_types ?? {},
      period_hierarchy: hierarchies.period,
      default_period: raw.default_period ?? '',
      resource_prefix: raw.resource_prefix ?? '',
      resource_types: raw.resource_types ?? {},
      resource_hierarchy: hierarchies.resource,
      squad_prefix: raw.squad_prefix ?? '',
      squad_types: raw.squad_types ?? {},
      squad_hierarchy: hierarchies.squad,
      template_prefix: raw.template_prefix ?? DEFAULT_TEMPLATE_PREFIX,
      priority_attribute: raw.priority_attribute ?? '',
      effort_attribute: raw.effort_attribute ?? '',
      remotes: raw.remotes,
      remotes_off: raw.remotes_off,
      git_sync: raw.git_sync ?? null,
    },
    errors: [],
  };
}

export function loadConfig(paths: BoardPaths): ConfigResult {
  let text: string;
  try {
    text = readFileSync(paths.configPath, 'utf8');
  } catch (error) {
    return { config: null, errors: [`cannot read config: ${(error as Error).message}`] };
  }
  return parseConfigText(text);
}

