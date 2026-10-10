import { DERIVED_FLAG } from '../../shared/flag-rollup.js';
import type { ParamDefs } from '../../shared/template-params.js';

export { DERIVED_FLAG, isDerivedFlag } from '../../shared/flag-rollup.js';
export type { ParamDef, ParamDefs } from '../../shared/template-params.js';

/** Attribute value kinds a board config may declare. Deliberately small. */
export const ATTRIBUTE_TYPES = [
  'string',
  'text',
  'int',
  'float',
  'bool',
  'date',
  'enum',
  'array',
] as const;

export type AttributeType = (typeof ATTRIBUTE_TYPES)[number];

export interface AttributeDef {
  type: AttributeType;
  description?: string;
  required?: boolean;
  default?: unknown;
  /** Allowed values, required for (and only for) `enum`. */
  values?: string[];
}

/** Shared shape of an issue type, a period type and a resource type. */
export interface TypeDef {
  label: string;
  attributes: Record<string, AttributeDef>;
  /** Markdown scaffolding written into new documents of this type. */
  body: string;
  /**
   * Resource types only: documents of this type are a pool ("a jr. developer"),
   * not a named person. Whether a resource is generic is a property of its type,
   * so no document has to declare it.
   */
  generic?: boolean;
  /**
   * Issue types only: work of this type is taken whole. It is offered by the
   * queue even when it has children, and nothing nested inside it is offered
   * separately -- the children are its checklist, not somebody else's ticket.
   * Absent means the old rule: only issues with no children are work.
   */
  atomic?: boolean;
}

export interface StatusDef {
  id: string;
  label: string;
  /** Marks a column as an end state (e.g. Done). */
  terminal?: boolean;
  /** Marks a column as work in progress, for `lpm task current` / `start`. */
  active?: boolean;
}

/** Which way a remote syncs. `both` runs the two planners in turn. */
export type RemoteDirection = 'both' | 'push' | 'pull';

/**
 * What to do when one side deletes a document the other side still mirrors.
 * The single policy reads in both directions, with the value set the two
 * directions need between them:
 *
 * - **Pull side** (the remote twin is confirmed gone — LP-365): `unlink`
 *   decouples the local document (a tombstone, so the next sync never
 *   re-files it); `close` moves it to the board's terminal status and
 *   decouples it; `delete` removes it through the ordinary `remove`
 *   operation; `restore` re-files it upstream under a new remote id and
 *   re-links; `manual` moves neither side and reports the document as
 *   conflicted for a human to settle.
 *
 * - **Push side** (the local document is deleted, or leaves the remote's
 *   `scope:` — LP-351): `unlink` (the default) leaves the remote twin alone
 *   and drops the link; `close` closes the twin and posts a comment saying
 *   why; `delete` deletes the twin, only where the platform allows and only
 *   with confirmation every run — it is never satisfied by a remembered
 *   consent. `restore` and `manual` have no push-side meaning and fall back
 *   to `unlink`, so a value meant for the pull side can never delete or close
 *   upstream by surprise.
 */
export type RemoteOnDelete = 'unlink' | 'close' | 'delete' | 'restore' | 'manual';

/** How a field both sides edited is resolved. */
export type RemoteConflictPolicy = 'manual' | 'local' | 'remote';

/**
 * Which side wins a field both sides edited, declared as a per-field override
 * (`fields: { status: { owner: remote } }`). A field with an owner never
 * conflicts — the owner simply wins. `manual` is deliberately not one of
 * these: an owner names a winner, and `manual` is the *absence* of one, which
 * the remote's default `conflict` policy already expresses.
 */
export type RemoteFieldOwner = 'local' | 'remote';

/**
 * Where fields the remote cannot hold natively are encoded: a managed block
 * in the issue body (the default), or a managed comment when the body is not
 * writable. Core validates the spelling; `src/remote` acts on it.
 */
export type RemoteEncoding = 'block' | 'comment';

/**
 * How user comments sync (LP-316). `push` (the default) sends new local
 * comments upstream and never pulls remote ones down; `both` does that and
 * also appends remote comments to `_comments.md` on pull. Comment sync is a
 * side channel — comments are not board state — so it follows the remote's
 * `direction` (a `pull` remote never pushes comments, a `push` remote never
 * pulls them) and the mode only widens what a direction already allows.
 */
export type RemoteCommentsMode = 'push' | 'both';

/**
 * One declared remote, as core stores it after validating the *frame*.
 *
 * Core knows a remote has a name, a provider, a scope, a direction and two
 * policies — it never knows what a provider is. `connection` and `mapping` are
 * opaque records here; the provider's own schema validates their contents when
 * the remote is opened (`src/remote/remotes.ts`), exactly as `storage/views.ts`
 * owns the contents of a view file while core owns the file itself.
 */
export interface RemoteConfig {
  /** Provider name, resolved to an implementation when the remote is opened. */
  provider: string;
  /** Issue id at the root of the mirrored subtree; absent means the whole board. */
  scope?: string;
  /** Which direction the sync runs. Defaults to `both`. */
  direction: RemoteDirection;
  /** What to do when the remote twin disappears. */
  on_delete: RemoteOnDelete;
  /** How a field both sides edited is resolved. */
  conflict: RemoteConflictPolicy;
  /**
   * The bulk guard (LP-364): a run where more than this fraction of linked
   * twins is missing at once is treated as unreachable rather than as a wave
   * of deletions. Absent means the default (0.5) applies; `1` disables the
   * guard, since a fraction can never exceed 1.
   */
  bulk_guard?: number;
  /**
   * The write threshold (LP-350): a push whose plan creates or closes more
   * than this many issues stops and requires `--yes`. Absent means the
   * default (25) applies.
   */
  write_threshold?: number;
  /**
   * Per-field conflict overrides, keyed by board field name (a canonical
   * field such as `status` or `depends_on`, or a declared attribute name):
   * the field always takes the named owner and never conflicts.
   * Defaults to `{}` — every field follows `conflict`.
   */
  fields: Record<string, RemoteFieldOwner>;
  /**
   * Where degraded fields are encoded: a managed block in the body, or a
   * managed comment. Defaults to `block`; `comment` is the spelling of
   * "the body is not writable" (LP-278).
   */
  encoding: RemoteEncoding;
  /** How user comments sync: `push` (default) or `both` (LP-316). */
  comments: RemoteCommentsMode;
  /** Provider-specific connection settings. Opaque to core; the provider validates it. */
  connection: Record<string, unknown>;
  /** Provider-specific vocabulary mapping. Opaque to core; the provider validates it. */
  mapping: Record<string, unknown>;
}

/**
 * The one type the template registry adds to the issue vocabulary: a container
 * that stands in for a level instead of templatizing it.
 *
 * A template of a feature has to sit at the feature's depth, so something has to
 * occupy the epic's level above it — that is a folder. It is never instantiated
 * and it holds nothing but other folders and the roots of templates.
 *
 * The name is reserved across every namespace (`config/schema.ts` refuses it),
 * because the registry reuses the issue types by name and a board declaring its
 * own `folder` would make "which folder?" unanswerable.
 */
export const TEMPLATE_FOLDER_TYPE = 'folder';

/** The definition the registry uses for its one own type. */
export const TEMPLATE_FOLDER_DEF: TypeDef = {
  label: 'Folder',
  attributes: {},
  body: '',
};

export interface BoardConfig {
  version: number;
  key_prefix: string;
  default_status: string;
  statuses: StatusDef[];
  issue_types: Record<string, TypeDef>;
  /**
   * Normalized issue hierarchy. Index is folder depth; each level lists the
   * type names allowed at that depth. Level 0 types live at the board root.
   */
  hierarchy: string[][];

  /** Prefix for period ids. Distinct from `key_prefix`. */
  period_prefix: string;
  /** Period types. Empty when the board does not use a time hierarchy. */
  period_types: Record<string, TypeDef>;
  /** Normalized period hierarchy, same shape as `hierarchy`. */
  period_hierarchy: string[][];
  /**
   * The catch-all period a new issue is scheduled in when nobody named one —
   * the innermost of the standing chain `lpm init` seeds. Empty when unset.
   * It only catches while it is the board's whole timeline: read it through
   * `defaultPeriodFor`, never directly. @see docs/periods.md
   */
  default_period: string;

  /** Prefix for resource ids. Distinct from the other two prefixes. */
  resource_prefix: string;
  /** Resource types. Empty when the board does not use a team roster. */
  resource_types: Record<string, TypeDef>;
  /** Normalized resource hierarchy, same shape as `hierarchy`. */
  resource_hierarchy: string[][];

  /**
   * Prefix for template ids. Distinct from the other prefixes.
   *
   * The registry has no `template_types` or `template_hierarchy` beside this,
   * and never will: a template *is* an issue of one of the board's own types,
   * so the namespace is derived from `issue_types` and `hierarchy` rather than
   * declared a second time. @see templateTypes / templateHierarchy
   */
  template_prefix: string;

  /** Prefix for squad ids. Distinct from the other three prefixes. */
  squad_prefix: string;
  /** Squad types. Empty when the board does not use squads. */
  squad_types: Record<string, TypeDef>;
  /** Normalized squad hierarchy, same shape as `hierarchy`. */
  squad_hierarchy: string[][];

  /**
   * Name of the enum issue attribute that ranks work, most important value
   * first. Empty when the board declares none.
   */
  priority_attribute: string;
  /** Name of the numeric issue attribute that measures effort. Empty when unset. */
  effort_attribute: string;

  /**
   * The remotes this board mirrors to, keyed by remote name. Empty when the
   * board declares none. Core stores the frame of each entry and never acts on
   * it; `src/remote` opens a remote and validates its provider-specific parts.
   */
  remotes: Record<string, RemoteConfig>;

  /**
   * Remotes that are declared but turned off, keyed by name — the same blocks
   * `remotes` holds, moved aside. Nothing opens, pushes, pulls or reports on
   * one; it exists so a mirror can be turned off (to share the board through
   * git instead) and on again without being configured from scratch. Its link
   * store and credentials under `.lpm/remotes/<name>/` are left exactly as they
   * were. Read it with `remotesOffNames`; `operations/remotes-off.ts` moves a
   * block between the two.
   */
  remotes_off: Record<string, RemoteConfig>;

  /**
   * How this board is shared through its own git repository, or null when it
   * is not. Read it with `gitSyncOf`; `src/core/gitsync` is what acts on it.
   * Exclusive with `remotes`: a board syncs through git or mirrors onto
   * trackers, never both.
   */
  git_sync: GitSyncConfig | null;

  /**
   * How the board plans, as written in `planning:` — `periods` when the key is
   * absent. `queue` reads the whole board as one continuous run: the queue
   * ignores every period (no schedule rank, no parked switch, no squad gate)
   * while each document keeps its `period:` exactly as it was, so switching
   * back changes nothing on disk. Read it with `planningOf`, which also answers
   * for a board with no period types; `operations/planning.ts` writes it.
   */
  planning: PlanningMode;
}

/** How a board decides what happens next. @see BoardConfig.planning */
export type PlanningMode = 'periods' | 'queue';

export const PLANNING_MODES: readonly PlanningMode[] = ['periods', 'queue'];

/**
 * The board's git remote: which remote of the `.lpm` repository it pushes to,
 * and which branch there. The URL is not here — git keeps it in `.lpm/.git`,
 * per clone, which is where a teammate's clone already has it.
 */
export interface GitSyncConfig {
  /** The git remote name inside `.lpm` (`origin`). */
  remote: string;
  /** The branch on that remote the board lives on (`main`, `_lpm_board_remote`). */
  branch: string;
}

export function hasPeriods(config: BoardConfig): boolean {
  return Object.keys(config.period_types).length > 0;
}

export function hasResources(config: BoardConfig): boolean {
  return Object.keys(config.resource_types).length > 0;
}

export function hasSquads(config: BoardConfig): boolean {
  return Object.keys(config.squad_types).length > 0;
}

/**
 * Frontmatter keys owned by light-plan. Custom attributes may not use these.
 * Fields backed by frontmatter keep the snake_case spelling of the key;
 * fields derived at load time (dir, parentId, depth) are camelCase.
 */
export const ISSUE_RESERVED_FIELDS = [
  'id',
  'type',
  'title',
  'status',
  'assignee',
  'period',
  'flag',
  'depends_on',
  'relates_to',
  'related_files',
  'created',
  'updated',
  'author',
] as const;

export const PERIOD_RESERVED_FIELDS = [
  'id',
  'type',
  'title',
  'starts',
  'ends',
  'active',
  'squad',
  'created',
  'updated',
  'author',
] as const;

export const RESOURCE_RESERVED_FIELDS = [
  'id',
  'type',
  'title',
  'capacity',
  'covers',
  'created',
  'updated',
  'author',
] as const;

export const TEMPLATE_RESERVED_FIELDS = [
  'id',
  'type',
  'title',
  'description',
  'params',
  'depends_on',
  'relates_to',
  'related_files',
  'created',
  'updated',
  'author',
] as const;

export const SQUAD_RESERVED_FIELDS = [
  'id',
  'type',
  'title',
  'members',
  'created',
  'updated',
  'author',
] as const;

/**
 * Why an issue somebody is working on has stopped.
 *
 * A flag is not a status: the work stays where it is, in whatever column the
 * board calls "in progress", and the flag says it is not moving. That is
 * deliberate — a board that had to invent a "blocked" column would lose the
 * distinction between "nobody has started this" and "somebody started it and
 * hit a wall", and only the second one needs anyone's attention today.
 */
export const FLAG_REASONS = ['blocked', 'paused', 'help'] as const;

export type FlagReason = (typeof FLAG_REASONS)[number];

const FLAG_LABELS: Record<string, string> = {
  blocked: 'Blocked',
  paused: 'Paused',
  help: 'Needs help',
  [DERIVED_FLAG]: 'Stopped inside',
};

/**
 * A reason a *person* may raise. `DERIVED_FLAG` is deliberately not one: it is
 * the roll-up's word for "something inside this has stopped", and letting
 * somebody type it would make a container's own flag indistinguishable from one
 * the roll-up may clear. `flagIssue` refuses it for that reason.
 */
export function isFlagReason(value: string): value is FlagReason {
  return (FLAG_REASONS as readonly string[]).includes(value);
}

/**
 * A value that may legitimately sit in a document's `flag` field — the reasons
 * a person may raise, plus the one the roll-up writes.
 *
 * A different question from `isFlagReason`, and `check` asks this one: `--fix`
 * writes `DERIVED_FLAG` onto containers, so validating against the raiseable
 * reasons alone would make the repair produce a board that fails the check that
 * asked for it.
 */
export function isValidFlag(value: string): boolean {
  return isFlagReason(value) || value === DERIVED_FLAG;
}

/**
 * The label a flag is shown with, falling back to whatever the file says — a
 * value this version does not know is still printed rather than swallowed.
 *
 * `src/shared/model.ts` carries the same list and the same function for the
 * browser, which imports nothing from core by design. They must agree, or the
 * canvas and `lpm flag list` will call the same flag two different things.
 */
export function flagLabel(flag: string): string {
  return FLAG_LABELS[flag] ?? flag;
}

export type NodeKind = 'issue' | 'period' | 'resource' | 'squad' | 'template';

export function reservedFieldsFor(kind: NodeKind): readonly string[] {
  if (kind === 'issue') return ISSUE_RESERVED_FIELDS;
  if (kind === 'period') return PERIOD_RESERVED_FIELDS;
  if (kind === 'resource') return RESOURCE_RESERVED_FIELDS;
  return kind === 'template' ? TEMPLATE_RESERVED_FIELDS : SQUAD_RESERVED_FIELDS;
}

/** Everything an issue and a period have in common. */
export interface BaseNode {
  kind: NodeKind;
  id: string;
  type: string;
  title: string;
  created?: string;
  updated?: string;
  author?: string;
  /** Config-declared custom attributes, plus any extra frontmatter keys found. */
  attributes: Record<string, unknown>;
  body: string;
  /** Absolute path to the document's folder. */
  dir: string;
  /** Absolute path to the document's markdown file. */
  file: string;
  parentId: string | null;
  /** Folder depth below the collection root; 0 for top-level documents. */
  depth: number;
}

export interface Issue extends BaseNode {
  kind: 'issue';
  status: string;
  /** Id of the resource this issue is assigned to — a person or a pool. */
  assignee: string | null;
  /** Id of the period this issue is scheduled in, at any level. */
  period: string | null;
  /**
   * Why this issue has stalled, or `null` when it has not — one of
   * `FLAG_REASONS`. Raised by whoever is doing the work and cleared by whoever
   * is running the plan, always with a comment saying why (`flagIssue` writes
   * both, so no front end can raise a flag nobody can act on).
   *
   * Anything unrecognized is kept rather than dropped, so a flag written by a
   * newer version of light-plan still shouts; `check` is what reports it.
   */
  flag: string | null;
  /** Ids this issue is blocked by. The inverse is derived, never stored. */
  depends_on: string[];
  /** Ids this issue is associated with, without implying an ordering. */
  relates_to: string[];
  /**
   * Files this issue is about: the requirement it was written from, the source
   * that has to change, the fixture that proves it. Free text rather than ids,
   * because the things worth pointing at live outside the board — a path
   * relative to the project root, optionally with a line range
   * (`docs/prd.md#L10-L42`).
   *
   * Deliberately not checked against the filesystem. An issue may name a file
   * that does not exist yet — that is frequently the whole point of it — and a
   * board that failed CI because somebody renamed a module would teach people
   * to stop filling this in.
   */
  related_files: string[];
}

export interface Period extends BaseNode {
  kind: 'period';
  /** Inclusive start date, YYYY-MM-DD. */
  starts?: string;
  /** Inclusive end date, YYYY-MM-DD. */
  ends?: string;
  /**
   * A switch held over the dates: `true` runs this period whatever the calendar
   * says, `false` parks it. **Absent is the normal case** and means the dates
   * decide, which is why this is optional rather than defaulted — a board that
   * has never touched a switch behaves exactly as it always did.
   *
   * It exists because not every team plans by date. Turning a sprint off is how
   * a reader says "not this one, work on that one instead" without inventing
   * dates they do not believe in, and `periodStance` is the only place that
   * reads it.
   */
  active?: boolean;
  /** Id of the squad that owns this period, or null. */
  squad: string | null;
}

export interface Resource extends BaseNode {
  kind: 'resource';
  /**
   * Full-time equivalents this resource supplies: 1 for a full-time person,
   * 0.5 part-time, 3 for a pool of three. Defaults to 1 when absent.
   */
  capacity: number;
  /** Generic resources this one can be drawn from. The inverse is derived. */
  covers: string[];
}

export interface Squad extends BaseNode {
  kind: 'squad';
  /** Resource ids that belong to this squad. The inverse is derived. */
  members: string[];
}

/**
 * A reusable piece of plan, kept in the registry (`.lpm/registry/`) and copied
 * into the board on request.
 *
 * A template is written exactly like the issue it produces — it carries one of
 * the board's own issue types, sits at that type's depth, and nests the same way
 * — minus everything about *this* piece of work: no status, no assignee, no
 * period, no flag. What it adds is a `description` (so the registry reads as a
 * catalogue rather than a folder listing) and, on a root, the `params` whoever
 * instantiates it has to answer.
 */
export interface Template extends BaseNode {
  kind: 'template';
  /** What this template is for, one or two lines. Shown in the registry. */
  description: string;
  /**
   * What this template asks for, keyed by name. Declared only on a **root** —
   * a template whose parent is a folder or nothing — because the root is the
   * only thing anybody instantiates, and its children take the same answers.
   * Empty on everything else.
   */
  params: ParamDefs;
  /** Template ids this one depends on. Repointed at the copies on instantiation. */
  depends_on: string[];
  /** Template ids this one is associated with, without implying an ordering. */
  relates_to: string[];
  /** Files the issues produced from this template should point at. */
  related_files: string[];
}

export type AnyNode = Issue | Period | Resource | Squad | Template;

export interface IssueNode extends Issue {
  children: IssueNode[];
}

export interface PeriodNode extends Period {
  children: PeriodNode[];
}

export interface ResourceNode extends Resource {
  children: ResourceNode[];
}

export interface SquadNode extends Squad {
  children: SquadNode[];
}

export interface TemplateNode extends Template {
  children: TemplateNode[];
}

/** True for the registry's own container type, which is never instantiated. */
export function isFolderTemplate(node: { type: string }): boolean {
  return node.type === TEMPLATE_FOLDER_TYPE;
}

export type ProblemLevel = 'error' | 'warn';

export interface Problem {
  level: ProblemLevel;
  /** Path relative to the board root, for display. */
  path: string;
  message: string;
  /** True when `check --fix` can repair this automatically. */
  fixable?: boolean;
}
