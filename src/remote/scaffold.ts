/**
 * The mapping scaffold (LP-369): draft a remote's `mapping:` block from what
 * is already known — the board's config on one side, the provider's resolved
 * capability descriptor on the other — so first-time setup is reviewing a
 * filled-in file instead of inventing a vocabulary translation from nothing.
 *
 * `scaffoldMapping` is a pure function: `BoardConfig` and
 * `ResolvedCapabilities` in, a mapping object plus YAML text out. It touches
 * no disk and makes no request, so it is testable against a descriptor
 * literal. It works from the *static* descriptor only — reading a live remote
 * for its real statuses, custom fields and accounts is the connector's job
 * (LP-246), and the provider epics refine the scaffold with what the API
 * actually reports.
 *
 * ## What it decides, and what it refuses to
 *
 *   - **types**       — the board type's own name, which is an answer
 *                       whenever nobody has to look one up: a provider with no
 *                       native issue types carries it on a label, and one
 *                       whose vocabulary we write ourselves (`jsonfile`) has
 *                       nothing to discover. A `TODO` marker only where the
 *                       platform has native types with names of its own, which
 *                       are a live fact.
 *   - **statuses**    — a board status with an obvious counterpart (a binary
 *                       open/closed provider carrying the state as a label) is
 *                       mapped to its own label; one without (a provider whose
 *                       workflow states are named remotely) is a `TODO` marker,
 *                       never a guess and never an omission.  The `closed`
 *                       flag follows the board's `terminal` flag, which is
 *                       structural and so always knowable.
 *   - **attributes**  — a label prefix when the value fits a label; the
 *                       managed block (with a comment naming the cost) when it
 *                       does not and the provider has no custom fields; a
 *                       custom field when the provider holds them.  The last
 *                       two are emitted as commented-out lines so the cost is
 *                       visible while editing, not at the first sync.
 *   - **accounts**    — the resource attribute whose value is the remote
 *                       account, guessed from the provider name or a known
 *                       candidate; a `TODO` marker when none is obvious.
 *   - **periods**     — the deepest period level as the container, the one
 *                       level that maps to a milestone / sprint / cycle.
 *
 * The last two are drafted only for a provider whose schema declares them
 * (`ScaffoldOptions.mappingKeys`). Both answers come from the board alone, so
 * the scaffold can always *work them out* — but a provider that holds neither
 * strips the key, and a block that cannot take effect is worse than an absent
 * one: it reads as a decision somebody made.
 *
 * ## Markers
 *
 * Every decision the scaffold cannot make is written as a `TODO:` string in
 * the emitted mapping, never a silent default. A marker is a plain string, so
 * the block still parses and round-trips; `findMarkers` walks a raw mapping
 * and names each one, and `openRemote` refuses a remote whose mapping still
 * carries markers. Fill them in and the block parses through the provider's
 * own schema unchanged.
 */

import type { AttributeDef, BoardConfig } from '../core/model/types.js';
import { hasPeriods, hasResources } from '../core/model/types.js';
import type { ResolvedCapabilities } from './capabilities.js';
import type { BoardStatusRole, BoardTypeRole, StandardVocabulary } from './vocabulary.js';
import YAML from 'yaml';

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

/** The prefix a scaffold marker starts with. `TODO: choose …`. */
export const MARKER_PREFIX = 'TODO:';

/** True when a value is a scaffold marker left for a human to fill in. */
export function isMarker(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(MARKER_PREFIX);
}

/** One unresolved decision in a mapping block. */
export interface MappingMarker {
  /** Dot path under `remotes.<name>.mapping`, e.g. `statuses.in_review`. */
  path: string;
  /** The question to answer, the marker text after `TODO: `. */
  question: string;
}

/**
 * Every marker still present in a raw mapping, in deterministic (sorted-key)
 * order.  Walks arrays and objects recursively; a marker is a string value
 * starting with `TODO:`, wherever it sits.
 */
export function findMarkers(mapping: Record<string, unknown>): MappingMarker[] {
  const out: MappingMarker[] = [];
  const walk = (value: unknown, path: string[]): void => {
    if (isMarker(value)) {
      out.push({
        path: path.join('.'),
        question: value.slice(MARKER_PREFIX.length).trim(),
      });
      return;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) walk(value[i], [...path, String(i)]);
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const key of Object.keys(value).sort()) {
        walk((value as Record<string, unknown>)[key], [...path, key]);
      }
    }
  };
  walk(mapping, []);
  return out;
}

/** A marker string: `TODO: <question>`. */
function marker(question: string): string {
  return `${MARKER_PREFIX} ${question}`;
}

// ---------------------------------------------------------------------------
// The scaffold
// ---------------------------------------------------------------------------

/** Options for `scaffoldMapping`. */
export interface ScaffoldOptions {
  /** Provider name, used to guess which resource attribute holds the account. */
  provider?: string;
  /**
   * The platform's conventional words for a board's types and statuses
   * (`Provider.standardVocabulary`). When given, a decision the scaffold cannot
   * *know* is drafted as the platform's convention instead of a `TODO:` marker,
   * so the remote opens and syncs with no hand-edited mapping.
   *
   * Absent means the older behaviour: a marker per unanswerable decision. That
   * is still right for a provider with no stated convention — a name invented
   * from nothing would fail at the first write, and a marker at least says so
   * before anything is attempted.
   */
  vocabulary?: StandardVocabulary;
  /**
   * The `mapping` keys the provider's own schema declares
   * (`mappingKeyNames` in `config-file.ts`). When given, a block the provider
   * does not declare is not drafted at all.
   *
   * Without this the scaffold drafted `accounts` and `periods` for every
   * provider, because both are answerable from the board config alone — and a
   * provider whose schema has no such key strips it on the way in, so the
   * block sat in config.yml stating a mapping that could never take effect.
   * `jsonfile` is the worked example: it holds no native period container and
   * resolves no account, so `periods: { container: sprint }` under it claimed a
   * remote container the file tracker has never had.
   *
   * Absent means "draft every block", which is what a caller with no provider
   * schema to hand wants — a test against a capability literal, say.
   * `types`, `statuses` and `attributes` are drafted either way: they are the
   * three blocks the sync itself requires of every provider (`openRemote`
   * refuses a remote whose status mapping is not total, whatever the provider),
   * so a shape that could not be read must never suppress them.
   */
  mappingKeys?: readonly string[];
}

/** What `scaffoldMapping` returns. */
export interface MappingScaffold {
  /** The mapping block, ready to paste under `remotes.<name>.mapping:`. */
  mapping: Record<string, unknown>;
  /** Every decision still waiting on a human, in emission order. */
  markers: MappingMarker[];
  /** The YAML text, with comments carrying the per-line degradation cost. */
  text: string;
}

/**
 * Draft a remote's `mapping:` block from a board config and a resolved
 * capability descriptor.  Pure — no disk, no network.
 *
 * The returned `mapping` is a plain object the caller may use directly; `text`
 * is the same block as YAML with comments, the form a human edits.  `markers`
 * is every `TODO:` left in the block; `openRemote` refuses a remote whose
 * mapping still carries one.
 */
export function scaffoldMapping(
  config: BoardConfig,
  capabilities: ResolvedCapabilities,
  options: ScaffoldOptions = {},
): MappingScaffold {
  // A block the provider's schema does not declare is not drafted: its schema
  // would strip the key, so the written block would state a mapping that has no
  // effect. Absent `mappingKeys` means the caller has no schema to consult.
  const declares = (key: string): boolean =>
    options.mappingKeys === undefined || options.mappingKeys.includes(key);

  const types = scaffoldTypes(config, capabilities, options.vocabulary);
  const statuses = scaffoldStatuses(config, capabilities, options.vocabulary);
  const attributes = scaffoldAttributes(config, capabilities);
  const accounts = declares('accounts') ? scaffoldAccounts(config, options.provider) : undefined;
  const periods = declares('periods') ? scaffoldPeriods(config) : undefined;

  const mapping: Record<string, unknown> = {
    types: types.mapping,
    statuses: statuses.mapping,
    attributes: attributes.mapping,
  };
  if (accounts) mapping.accounts = accounts.mapping;
  if (periods) mapping.periods = periods.mapping;

  return {
    mapping,
    markers: findMarkers(mapping),
    text: renderText(types, statuses, attributes, accounts, periods),
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TypeScaffold {
  mapping: Record<string, unknown>;
  native: boolean;
}

/**
 * Each board issue type's role, as a provider's convention reads it: the name,
 * the level it sits at, and the three facts about what that level is *for*.
 *
 * `atomic` is the board's own word for "the smallest unit of work the queue
 * hands out", so a level below an atomic one is a checklist inside one job —
 * which is what a tracker calls a sub-task. Deriving it here, once, is what
 * keeps every provider's convention reading the same board.
 */
function typeRoles(config: BoardConfig): BoardTypeRole[] {
  const levels = config.hierarchy;
  const roles: BoardTypeRole[] = [];
  for (let depth = 0; depth < levels.length; depth += 1) {
    const level = levels[depth]!;
    const names = Array.isArray(level) ? level : [level];
    // A level is inside a unit when *any* type above it is atomic — the
    // outermost atomic level wins, exactly as `isWorkUnit` resolves it.
    const insideUnit = levels
      .slice(0, depth)
      .flat()
      .some((name) => config.issue_types[name]?.atomic === true);
    for (const name of names) {
      roles.push({
        name,
        depth,
        depthCount: levels.length,
        atomic: config.issue_types[name]?.atomic === true,
        insideUnit,
        leaf: depth === levels.length - 1,
      });
    }
  }
  return roles;
}

/** Each board status's role, in board order. */
function statusRoles(config: BoardConfig): BoardStatusRole[] {
  return config.statuses.map((status, index) => ({
    id: status.id,
    label: status.label,
    index,
    count: config.statuses.length,
    terminal: status.terminal === true,
    active: status.active === true,
  }));
}

function scaffoldTypes(
  config: BoardConfig,
  capabilities: ResolvedCapabilities,
  vocabulary: StandardVocabulary | undefined,
): TypeScaffold {
  const native = capabilities.nativeTypes;
  // A remote whose vocabulary we write ourselves (`jsonfile`) has no existing
  // type names to discover, so the board's own name *is* the answer. Asking
  // would be asking somebody to invent a synonym for a word they just used.
  // A provider with no native types is in the same position: the value rides a
  // label nobody has to look up, so the board's name serves there too.
  const askable = native && capabilities.vocabulary !== 'open';
  const mapping: Record<string, unknown> = {};
  for (const role of typeRoles(config)) {
    // One name, whatever the carrier: the provider writes it to its native
    // type field or to a label, and the mapping does not repeat the decision
    // the provider has already made.
    //
    // Where the name is the platform's to give, the platform's own convention
    // answers it when the provider states one, and only a provider that states
    // none leaves a marker: an unanswered question that blocks the remote from
    // opening is worse than a conventional answer the preflight will check.
    const remote = !askable
      ? role.name
      : (vocabulary?.typeFor?.(role) ??
        marker(`choose the remote issue type for board type "${role.name}"`));
    mapping[role.name] = { remote };
  }
  return { mapping, native };
}

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

interface StatusScaffold {
  mapping: Record<string, unknown>;
  binary: boolean;
}

function scaffoldStatuses(
  config: BoardConfig,
  capabilities: ResolvedCapabilities,
  vocabulary: StandardVocabulary | undefined,
): StatusScaffold {
  const binary = capabilities.status.kind === 'binary';
  // Same reasoning as the types above: a binary open/closed remote carries the
  // status as a label of our choosing, and a remote whose whole vocabulary is
  // ours (`jsonfile`) has no workflow states to look up. Only a platform with
  // its *own* named states — Jira's workflow, Linear's team states — has an
  // answer a scaffold cannot know, and that is the one the platform's own
  // convention answers, falling back to a marker where none is stated.
  const named = binary || capabilities.vocabulary === 'open';
  const mapping: Record<string, unknown> = {};
  for (const role of statusRoles(config)) {
    const status = config.statuses[role.index]!;
    const remote = named
      ? status.label
      : (vocabulary?.statusFor?.(role) ??
        marker(`choose the remote state for board status "${status.label}"`));
    // One state to start with, written as a plain name. A status *may* list
    // several remote states that all mean it ("Done", "Won't Fix"), but a
    // scaffold has no way to know the extras and a one-item list reads like a
    // decision nobody made.
    mapping[status.id] = { remote, closed: status.terminal === true };
  }
  return { mapping, binary };
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

interface AttributeScaffold {
  /** The `mapping.attributes` block: label-carried attributes only. */
  mapping: Record<string, unknown>;
  /** Attributes assigned to the managed block, with the prefix a label would use. */
  managed: Array<{ name: string; prefix: string; required: boolean }>;
  /** Attributes provisionable as a custom field. */
  customField: string[];
}

/** Every attribute declared on some issue type, sorted. */
function declaredAttributeNames(config: BoardConfig): string[] {
  const names = new Set<string>();
  for (const type of Object.values(config.issue_types)) {
    for (const name of Object.keys(type.attributes)) names.add(name);
  }
  return [...names].sort();
}

/** The first definition of an attribute name across issue types. */
function attributeDef(config: BoardConfig, name: string): AttributeDef | undefined {
  for (const type of Object.values(config.issue_types)) {
    const def = type.attributes[name];
    if (def) return def;
  }
  return undefined;
}

/** A label prefix for an attribute name: `story_points` → `StoryPoints`. */
function prefixFor(name: string): string {
  return name
    .split('_')
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function scaffoldAttributes(
  config: BoardConfig,
  capabilities: ResolvedCapabilities,
): AttributeScaffold {
  const mapping: Record<string, unknown> = {};
  const managed: AttributeScaffold['managed'] = [];
  const customField: string[] = [];

  // Custom fields are the provisionable home; without them the carriers are a
  // label (rung 3) or the managed block (rung 4).  A `text` attribute is the
  // one type a label cannot carry faithfully — prose does not belong in a
  // label — so it degrades to the managed block and the cost is named on the
  // line.
  const hasCustomFields = capabilities.customFields !== null;
  for (const name of declaredAttributeNames(config)) {
    const def = attributeDef(config, name);
    if (hasCustomFields) {
      customField.push(name);
    } else if (def?.type === 'text') {
      managed.push({ name, prefix: prefixFor(name), required: def.required === true });
    } else {
      mapping[name] = prefixFor(name);
    }
  }

  return { mapping, managed, customField };
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

const ACCOUNT_CANDIDATES = ['email', 'username', 'login', 'account', 'handle'];

/** The resource attribute most likely to hold a remote account, or undefined. */
function candidateAccountAttribute(config: BoardConfig, provider: string | undefined): string | undefined {
  const stringAttrs = new Set<string>();
  for (const type of Object.values(config.resource_types)) {
    for (const [name, def] of Object.entries(type.attributes)) {
      if (def.type === 'string') stringAttrs.add(name);
    }
  }
  if (stringAttrs.size === 0) return undefined;

  const candidates = [provider, ...ACCOUNT_CANDIDATES].filter(
    (name): name is string => typeof name === 'string' && name.length > 0,
  );
  for (const candidate of candidates) {
    if (stringAttrs.has(candidate)) return candidate;
  }
  if (stringAttrs.size === 1) return [...stringAttrs][0];
  return undefined;
}

interface AccountsScaffold {
  mapping: Record<string, unknown>;
}

function scaffoldAccounts(
  config: BoardConfig,
  provider: string | undefined,
): AccountsScaffold | undefined {
  if (!hasResources(config)) return undefined;
  const via =
    candidateAccountAttribute(config, provider) ??
    marker('choose which resource attribute holds the remote account');
  return { mapping: { via } };
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

interface PeriodsScaffold {
  mapping: Record<string, unknown>;
}

function scaffoldPeriods(config: BoardConfig): PeriodsScaffold | undefined {
  if (!hasPeriods(config)) return undefined;
  // The deepest (most specific) level is the natural container: a sprint maps
  // to a milestone, not an increment.
  const container = config.period_hierarchy.flat().at(-1)!;
  return { mapping: { container } };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Serialize a section's object and indent it under its key. */
function section(
  name: string,
  comment: string | undefined,
  obj: Record<string, unknown>,
  extraLines: string[] = [],
): string {
  const lines: string[] = [];
  if (comment) lines.push(comment);
  lines.push(`${name}:`);
  for (const line of YAML.stringify(obj).trimEnd().split('\n')) {
    lines.push(line === '' ? '' : `  ${line}`);
  }
  for (const extra of extraLines) lines.push(extra);
  return lines.join('\n');
}

/** The commented-out lines naming an attribute the mapping does not carry. */
function attributeCommentLines(attributes: AttributeScaffold): string[] {
  const lines: string[] = [];
  for (const entry of attributes.managed) {
    const required = entry.required ? ' (required)' : '';
    lines.push(
      `  # ${entry.name}: ${entry.prefix}  # no native or provisionable home${required} — rides the managed block (rung 4); uncomment to carry it as a label`,
    );
  }
  for (const name of attributes.customField) {
    lines.push(`  # ${name} — provisionable as a custom field (rung 2)`);
  }
  return lines;
}

function renderText(
  types: TypeScaffold,
  statuses: StatusScaffold,
  attributes: AttributeScaffold,
  accounts: AccountsScaffold | undefined,
  periods: PeriodsScaffold | undefined,
): string {
  const parts: string[] = [
    '# Mapping scaffold — generated from the board config and the provider capability',
    '# descriptor. Review every line: a value that still starts with "TODO:" must be',
    '# filled in before the remote can be opened.',
    '',
    section(
      'types',
      types.native
        ? '# board type -> the remote issue type(s) that mean it'
        : '# board type -> the label(s) that mark it (no native issue types here)',
      types.mapping,
    ),
    '',
    section(
      'statuses',
      '# board status -> the remote state that means it, and whether it closes the issue',
      statuses.mapping,
    ),
    '',
    section(
      'attributes',
      '# board attribute -> the label prefix carrying its value ("<prefix>:<value>")',
      attributes.mapping,
      attributeCommentLines(attributes),
    ),
  ];

  if (accounts) {
    parts.push(
      '',
      section('accounts', '# which resource attribute holds the remote account', accounts.mapping),
    );
  }
  if (periods) {
    parts.push(
      '',
      section('periods', '# the period level that maps to the remote container (milestone, sprint, …)', periods.mapping),
    );
  }

  return `${parts.join('\n')}\n`;
}
