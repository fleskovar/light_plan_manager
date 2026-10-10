import type {
  AttributeDef,
  BoardConfig,
  GitSyncConfig,
  NodeKind,
  PlanningMode,
  RemoteConfig,
  TypeDef,
} from '../model/types.js';
import { TEMPLATE_FOLDER_DEF, TEMPLATE_FOLDER_TYPE, hasPeriods } from '../model/types.js';
import type { StatusRules } from '../../shared/rollup.js';
import { BoardError } from '../errors.js';

/**
 * Read-only accessors over a parsed config. Every rule about "where can this
 * type live" and "what statuses exist" is answered here, so callers never poke
 * at the raw shape and the issue/period/resource namespaces stay
 * interchangeable.
 */

/**
 * The registry's hierarchy: the issue hierarchy, with a folder allowed beside
 * every level.
 *
 * A template of a feature has to sit where a feature sits, or instantiating it
 * would produce something the board refuses; so the registry mirrors the issue
 * levels exactly, and a `folder` stands in for whatever level nobody wanted to
 * templatize. That is why the registry has no hierarchy in the config file:
 * a second declaration could only ever drift from this one.
 */
export function templateHierarchy(config: BoardConfig): string[][] {
  return config.hierarchy.map((level) => [...level, TEMPLATE_FOLDER_TYPE]);
}

/** The registry's types: the board's own issue types, plus the folder. */
export function templateTypes(config: BoardConfig): Record<string, TypeDef> {
  return { ...config.issue_types, [TEMPLATE_FOLDER_TYPE]: TEMPLATE_FOLDER_DEF };
}

/** The hierarchy that governs a kind of document. */
export function hierarchyFor(config: BoardConfig, kind: NodeKind): string[][] {
  if (kind === 'issue') return config.hierarchy;
  if (kind === 'period') return config.period_hierarchy;
  if (kind === 'resource') return config.resource_hierarchy;
  return kind === 'template' ? templateHierarchy(config) : config.squad_hierarchy;
}

export function typesFor(config: BoardConfig, kind: NodeKind): Record<string, TypeDef> {
  if (kind === 'issue') return config.issue_types;
  if (kind === 'period') return config.period_types;
  if (kind === 'resource') return config.resource_types;
  return kind === 'template' ? templateTypes(config) : config.squad_types;
}

/**
 * The declared definition of a type, or throws. The one place the lookup lives
 * so the two callers' error messages agree.
 */
export function typeDefOf(config: BoardConfig, kind: NodeKind, type: string): TypeDef {
  const types = typesFor(config, kind);
  const def = types[type];
  if (!def) {
    const available = Object.keys(types);
    throw new BoardError(`Unknown ${kind} type "${type}"`, [
      available.length ? `Available types: ${available.join(', ')}` : 'This board declares none.',
    ]);
  }
  return def;
}

/** Folder depth at which documents of `type` are allowed, or -1 when unknown. */
export function depthOfType(config: BoardConfig, kind: NodeKind, type: string): number {
  return hierarchyFor(config, kind).findIndex((level) => level.includes(type));
}

/**
 * Every folder depth a type may sit at.
 *
 * Almost always one — `checkNamespace` refuses a declared type that appears at
 * two levels, and a type's index in the hierarchy *is* the depth it belongs at.
 * The registry's `folder` is the exception and the reason this exists: it stands
 * in for whichever level nobody templatized, so it is legal at all of them. Ask
 * this rather than `depthOfType` whenever a *placement* is being decided, or a
 * folder can never be nested.
 */
export function allowedDepths(config: BoardConfig, kind: NodeKind, type: string): number[] {
  const depths: number[] = [];
  hierarchyFor(config, kind).forEach((level, depth) => {
    if (level.includes(type)) depths.push(depth);
  });
  return depths;
}

/**
 * Type names a document of `kind` may take at `depth`.
 *
 * `src/shared/model.ts` carries the same function for the browser, accessing
 * `config.hierarchy` directly. They must agree; the two config shapes are the
 * reason they stay duplicated.
 */
export function typesAtDepth(config: BoardConfig, kind: NodeKind, depth: number): string[] {
  return hierarchyFor(config, kind)[depth] ?? [];
}

export function statusIds(config: BoardConfig): string[] {
  return config.statuses.map((status) => status.id);
}

export function isTerminalStatus(config: BoardConfig, status: string): boolean {
  return config.statuses.find((entry) => entry.id === status)?.terminal === true;
}

/** The first end state, where `lpm task done` moves an issue. */
export function terminalStatusId(config: BoardConfig): string | null {
  return config.statuses.find((status) => status.terminal)?.id ?? null;
}

/**
 * Statuses that mean "someone is working on this". Boards declare them with
 * `active: true`; without that, the first non-terminal status after the default
 * one is assumed, which is where most boards put their work-in-progress column.
 */
export function activeStatusIds(config: BoardConfig): string[] {
  const declared = config.statuses.filter((status) => status.active).map((status) => status.id);
  if (declared.length) return declared;

  const start = config.statuses.findIndex((status) => status.id === config.default_status);
  const next = config.statuses.slice(start + 1).find((status) => !status.terminal);
  return next ? [next.id] : [];
}

export function isActiveStatus(config: BoardConfig, status: string): boolean {
  return activeStatusIds(config).includes(status);
}

/** The status `lpm task start` moves an issue into. */
export function startStatusId(config: BoardConfig): string | null {
  return activeStatusIds(config)[0] ?? null;
}

/**
 * The board's status column, as the roll-up rule reads it. The one adapter
 * between a `BoardConfig` and `src/shared/rollup.ts`, so `moveNode`, `check`
 * and `--fix` all derive a parent's status from the same declaration.
 */
export function statusRulesFor(config: BoardConfig): StatusRules {
  return {
    isTerminal: (status) => isTerminalStatus(config, status),
    isActive: (status) => isActiveStatus(config, status),
    terminalStatus: terminalStatusId(config),
    activeStatus: startStatusId(config),
    defaultStatus: config.default_status,
  };
}

/**
 * Which namespace a type name belongs to, or null when it is unknown.
 *
 * Answers `issue` for a type the registry also uses, which is right: `lpm new
 * feature` creates an issue, and a *template* of a feature is asked for by name
 * (`lpm template new feature`), never inferred. Only `folder` resolves to the
 * registry, because only `folder` means nothing anywhere else.
 */
export function kindOfType(config: BoardConfig, type: string): NodeKind | null {
  if (config.issue_types[type]) return 'issue';
  if (config.period_types[type]) return 'period';
  if (config.resource_types[type]) return 'resource';
  if (config.squad_types[type]) return 'squad';
  return type === TEMPLATE_FOLDER_TYPE ? 'template' : null;
}

/** The id prefix used by a kind of document. */
export function prefixFor(config: BoardConfig, kind: NodeKind): string {
  if (kind === 'issue') return config.key_prefix;
  if (kind === 'period') return config.period_prefix;
  if (kind === 'resource') return config.resource_prefix;
  return kind === 'template' ? config.template_prefix : config.squad_prefix;
}

/**
 * True when a resource type describes a pool ("a jr. developer") rather than a
 * named person. Declared once per type, so no document repeats it.
 */
export function isGenericType(config: BoardConfig, type: string): boolean {
  return config.resource_types[type]?.generic === true;
}

/**
 * True when work of this issue type is taken whole: the queue offers it even
 * when it has children, and offers nothing nested inside it. A board that flags
 * nothing keeps the older rule, where only childless issues are work.
 */
export function isAtomicType(config: BoardConfig, type: string): boolean {
  return config.issue_types[type]?.atomic === true;
}

/** The declared definition of the attribute the board ranks work by, if any. */
export function priorityAttributeOf(config: BoardConfig, issueType: string): AttributeDef | null {
  if (!config.priority_attribute) return null;
  return config.issue_types[issueType]?.attributes[config.priority_attribute] ?? null;
}

/** The declared definition of the attribute the board measures effort with, if any. */
export function effortAttributeOf(config: BoardConfig, issueType: string): AttributeDef | null {
  if (!config.effort_attribute) return null;
  return config.issue_types[issueType]?.attributes[config.effort_attribute] ?? null;
}

/** True when the board declares at least one remote. */
export function hasRemotes(config: BoardConfig): boolean {
  return Object.keys(config.remotes).length > 0;
}

/** The names of every declared remote, sorted — for errors and listings. */
export function remoteNames(config: BoardConfig): string[] {
  return Object.keys(config.remotes).sort();
}

/**
 * The names of every remote that is declared but turned off, sorted. Nothing
 * syncs with one; they are listed so a person can turn one back on.
 */
export function remotesOffNames(config: BoardConfig): string[] {
  return Object.keys(config.remotes_off).sort();
}

/**
 * The declared remote of that name, or null. The one place remotes are read
 * from, so callers never inspect the raw `config.remotes` map.
 */
export function remoteNamed(config: BoardConfig, name: string): RemoteConfig | null {
  return config.remotes[name] ?? null;
}

/**
 * How the board is shared through its git repository, or null when it is not.
 * The one place `git_sync` is read, so callers never inspect the raw block.
 */
export function gitSyncOf(config: BoardConfig): GitSyncConfig | null {
  return config.git_sync;
}

/**
 * How the board plans, as it is in force: `queue` on a board with no period
 * types, whatever `planning:` says, because there is nothing to plan with.
 * The one place `planning` is read.
 */
export function planningOf(config: BoardConfig): PlanningMode {
  return hasPeriods(config) ? config.planning : 'queue';
}

/**
 * Whether the queue reads the board as one continuous run, ignoring every
 * period: no schedule rank, no parked switch, no squad owning a sprint. The
 * documents keep their `period:` either way. @see operations/planning.ts
 */
export function ignoresPeriods(config: BoardConfig): boolean {
  return planningOf(config) === 'queue';
}
