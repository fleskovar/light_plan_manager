/**
 * The board as it travels over the wire.
 *
 * These types mirror `src/core/model` with the filesystem stripped out: no
 * `dir`, no `file`, no absolute paths. They are declared here rather than
 * re-exported from core so the browser bundle never reaches into the engine,
 * and so a change to core's internals is a deliberate change to the API rather
 * than an accidental one.
 *
 * Nothing in this folder imports anything. It compiles for Node and for the
 * browser, and both sides of the API depend on it.
 */

import { DERIVED_FLAG } from './flag-rollup.js';
import type { ParamDefs } from './template-params.js';

export type NodeKind = 'issue' | 'period' | 'resource' | 'squad' | 'template';

export const NODE_KINDS: readonly NodeKind[] = [
  'issue',
  'period',
  'resource',
  'squad',
  'template',
];

export type AttributeType =
  | 'string'
  | 'text'
  | 'int'
  | 'float'
  | 'bool'
  | 'date'
  | 'enum'
  | 'array';

export interface AttributeDto {
  name: string;
  type: AttributeType;
  description?: string;
  required?: boolean;
  default?: unknown;
  /** Allowed values; present only for `enum`. */
  values?: string[];
}

export interface TypeDto {
  name: string;
  kind: NodeKind;
  label: string;
  /** Folder depth this type must sit at, which is its index in the hierarchy. */
  depth: number;
  attributes: AttributeDto[];
  /** True for a resource type that describes a pool rather than a person. */
  generic: boolean;
  /**
   * True for an issue type whose work is taken whole: it carries work even when
   * it has children, and what is nested inside it does not.
   */
  atomic: boolean;
}

export interface StatusDto {
  id: string;
  label: string;
  terminal: boolean;
  active: boolean;
}

export interface ConfigDto {
  /** Directory name of the checkout the server was started in. */
  boardName: string;
  statuses: StatusDto[];
  defaultStatus: string;
  /** Every declared type, in every namespace, keyed by name. */
  types: Record<string, TypeDto>;
  /** Type names allowed at each depth, per namespace. Index is the depth. */
  hierarchy: Record<NodeKind, string[][]>;
  hasPeriods: boolean;
  hasResources: boolean;
  hasSquads: boolean;
  /** Attribute name the board ranks work by, or an empty string. */
  priorityAttribute: string;
  /** Attribute name the board measures effort with, or an empty string. */
  effortAttribute: string;
  /**
   * How the board plans, as it is in force — `queue` on a board with no period
   * types. Board truth, read from `planning:` in config.yml, so every view and
   * every teammate works the same queue. A file `lpm export` wrote before this
   * existed has none; read it through `plansWithPeriods`.
   */
  planning: Planning;
}

/**
 * How a board decides what happens next.
 *
 * `periods` plans with the calendar: increments, sprints, and the drawer's
 * Periods and Gantt tabs. `queue` reads the whole board as one increment holding
 * one sprint holding everything — the queue ignores every period and the app
 * stops drawing them — while every document keeps its `period:`, so switching
 * back is lossless.
 */
export type Planning = 'periods' | 'queue';

/**
 * Whether the app should show the timeline at all: period badges, period
 * fields, the Periods and Gantt tabs. A board planning by queue has them on
 * disk and out of sight. Absent `planning` is an older export, which planned
 * with its periods because nothing else existed.
 */
export function plansWithPeriods(config: Pick<ConfigDto, 'hasPeriods' | 'planning'>): boolean {
  return config.hasPeriods && config.planning !== 'queue';
}

export interface NodeDtoBase {
  kind: NodeKind;
  id: string;
  type: string;
  title: string;
  body: string;
  parentId: string | null;
  depth: number;
  attributes: Record<string, unknown>;
  created?: string;
  updated?: string;
  author?: string;
}

export interface IssueDto extends NodeDtoBase {
  kind: 'issue';
  status: string;
  assignee: string | null;
  period: string | null;
  /**
   * Why work on this issue has stopped — `blocked`, `paused` or `help` — or
   * null when it has not. Raised and cleared straight through rather than
   * queued in a view, so this field is never patched: see `FLAG_REASONS`.
   */
  flag: string | null;
  dependsOn: string[];
  relatesTo: string[];
  /** Files this issue is about, as written: paths, optionally with a line range. */
  relatedFiles: string[];
}

/**
 * Why an issue somebody started has stopped.
 *
 * The engine's own copy is `FLAG_REASONS` in `core/model/types.ts`; this folder
 * imports nothing, so the list lives twice on purpose. They must agree, or the
 * canvas and `lpm flag list` will call the same flag two different things.
 */
export const FLAG_REASONS = ['blocked', 'paused', 'help'] as const;

export type FlagReason = (typeof FLAG_REASONS)[number];

const FLAG_LABELS: Record<string, string> = {
  blocked: 'Blocked',
  paused: 'Paused',
  help: 'Needs help',
  // Not a reason anybody may raise: the roll-up's word for a container standing
  // in front of stopped work. @see src/shared/flag-rollup.ts
  [DERIVED_FLAG]: 'Stopped inside',
};

/**
 * The label a flag is shown with; an unrecognized one is shown as written.
 *
 * `src/core/model/types.ts` carries the same list and the same function for the
 * engine (with a `isFlagReason` guard before the lookup). They must agree, or
 * the canvas and `lpm flag list` will call the same flag two different things.
 */
export function flagLabel(flag: string): string {
  return FLAG_LABELS[flag] ?? flag;
}

export interface PeriodDto extends NodeDtoBase {
  kind: 'period';
  starts?: string;
  ends?: string;
  /**
   * The switch over the dates: `true` runs this period whatever the calendar
   * says, `false` parks it, absent lets the dates decide. Absent is the normal
   * case, so read it through `periodStance` rather than as a boolean.
   */
  active?: boolean;
  /** Id of the squad that owns this period, or null. */
  squad: string | null;
}

export interface ResourceDto extends NodeDtoBase {
  kind: 'resource';
  capacity: number;
  covers: string[];
  /** True when this resource's type is a pool. Denormalized from the type. */
  generic: boolean;
}

export interface SquadDto extends NodeDtoBase {
  kind: 'squad';
  members: string[];
}

/**
 * A registry template on the wire.
 *
 * It carries an *issue* type name in `type`, which is the whole reason the
 * canvas can draw the registry with no new components: a template of a feature
 * resolves through `config.types` to the same label, icon and attributes a
 * feature has. `folder` is the one type only the registry uses.
 */
export interface TemplateDto extends NodeDtoBase {
  kind: 'template';
  description: string;
  /** What this template asks for. Only a root declares any. */
  params: ParamDefs;
  /** True when this is the template somebody instantiates, rather than part of one. */
  root: boolean;
  dependsOn: string[];
  relatesTo: string[];
  relatedFiles: string[];
}

export type NodeDto = IssueDto | PeriodDto | ResourceDto | SquadDto | TemplateDto;

/** One entry in a document's work log. */
export interface CommentDto {
  /** 1-based position, which is also the order it was written. */
  index: number;
  at: string;
  author: string;
  body: string;
}

export interface ProblemDto {
  level: 'error' | 'warn';
  path: string;
  message: string;
}

/** Everything the app needs about a board, in one response. */
export interface BoardSnapshot {
  config: ConfigDto;
  issues: IssueDto[];
  periods: PeriodDto[];
  resources: ResourceDto[];
  squads: SquadDto[];
  /** The template registry. Empty on a board that has never written one. */
  templates: TemplateDto[];
  problems: ProblemDto[];
  /** Set every time the board is read, to spot a snapshot going stale. */
  readAt: string;
}

export function isIssue(node: NodeDto): node is IssueDto {
  return node.kind === 'issue';
}

export function isPeriod(node: NodeDto): node is PeriodDto {
  return node.kind === 'period';
}

export function isResource(node: NodeDto): node is ResourceDto {
  return node.kind === 'resource';
}

export function isSquad(node: NodeDto): node is SquadDto {
  return node.kind === 'squad';
}

export function isTemplate(node: NodeDto): node is TemplateDto {
  return node.kind === 'template';
}

/**
 * Every node in a snapshot, in one list.
 *
 * `src/core/validation/shared.ts` carries the same function for the engine,
 * flattening a `LoadedBoard` instead of a `BoardSnapshot`. They must agree
 * on the order; the two data shapes are the reason they stay duplicated.
 */
export function allNodes(snapshot: BoardSnapshot): NodeDto[] {
  return [
    ...snapshot.issues,
    ...snapshot.periods,
    ...snapshot.resources,
    ...snapshot.squads,
    ...snapshot.templates,
  ];
}

/**
 * Type names a document of `kind` may take at `depth`.
 *
 * `src/core/config/lookup.ts` carries the same function for the engine,
 * routing through `hierarchyFor` rather than accessing `config.hierarchy`
 * directly. They must agree; the two config shapes are the reason they stay
 * duplicated.
 */
export function typesAtDepth(config: ConfigDto, kind: NodeKind, depth: number): string[] {
  return config.hierarchy[kind][depth] ?? [];
}

export function typeLabel(config: ConfigDto, type: string): string {
  return config.types[type]?.label ?? type;
}

export function statusOf(config: ConfigDto, id: string): StatusDto | undefined {
  return config.statuses.find((status) => status.id === id);
}

/**
 * What `GET /api/health` answers: the server is up, which board it serves, and
 * which unfinished features it was started with.
 *
 * `experimental` is `lpm ui --experimental`. Without it the server registers
 * no tracker routes (`/api/remotes*`) and the web app shows no tracker surface
 * at all — the Sync tab holds git sharing alone. It is a property of the
 * running server rather than of the board, so it lives here and never in a
 * snapshot or a view.
 */
export interface ServerInfoDto {
  ok: true;
  root: string;
  experimental: boolean;
}

/**
 * What `GET /api/me` answers: who this checkout says is working — the same
 * identity `lpm task next` uses (`LPM_USER`, then the profile, then
 * `.lpm/local.json`). Like `ServerInfoDto` it belongs to the running server and
 * never to a snapshot, because `lpm export` publishes snapshots and a published
 * board must not carry whoever happened to export it.
 */
export interface CurrentUserDto {
  /** The roster resource the reference names, or null when it names nobody. */
  id: string | null;
  /** The reference as written, or null when no user is set. */
  ref: string | null;
}

/**
 * What `GET /api/queue` answers: the engine's own sequence for one resource or
 * for the whole team — `simulateQueue`, which is `lpm task next` asked again
 * after every step. The queue panel numbers its cards by it, so the order a
 * reviewer reads in the browser is the order developers and agents will be
 * handed work in, and not a second opinion about it.
 *
 * It answers for the board on disk. Work the browser has not pushed yet is not
 * in it, which the panel says rather than guessing a position for.
 */
export interface QueueSequenceDto {
  /** The resource the sequence is for, or null for the whole team. */
  resource: string | null;
  planning: Planning;
  /** The sequence, first step first. */
  steps: QueueStepDto[];
  /** Open work units the sequence never reaches, and why. */
  skipped: QueueSkipDto[];
}

export interface QueueStepDto {
  id: string;
  /** 1-based position in the sequence. */
  order: number;
  /** Already in progress when the sequence was worked out. */
  started: boolean;
}

export interface QueueSkipDto {
  id: string;
  /** `SkipReason` in `board/simulate.ts`: flagged, active, routing, squad, parked, blocked, scope, ready. */
  reason: string;
  /** Unfinished blockers left at the end, for `blocked`. */
  blockedBy: string[];
}
