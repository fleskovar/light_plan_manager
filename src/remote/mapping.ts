/**
 * Board vocabulary ↔ remote vocabulary: the type mapping (LP-268).
 *
 * One slice of the mapping engine (LP-254): how a board's issue types become a
 * remote's issue types — or labels, where the provider has no native types —
 * and back again.  The mapping is data: `mapping.types` in the remote's config
 * block, a map from a board type name to its remote representation.  This
 * module only applies it.
 *
 * Depth is never declared here.  `hierarchy` is the single source of parenting
 * truth locally; every function takes the issue hierarchy (what
 * `hierarchyFor(config, 'issue')` returns) and derives depth from it exactly as
 * `typesAtDepth` does — a type is legal at the depth where the hierarchy lists
 * it.  A second depth declaration in the remote config is the bug this
 * arrangement exists to prevent.
 *
 * Pure: no disk, no network.  Everything takes its inputs and returns a value,
 * so the mapping is testable against literals.  The sibling mappings are the
 * same shape — declarative, driven by config, applied here: status (below),
 * attribute in `attributes.ts` (LP-270), resource in `accounts.ts` (LP-271),
 * then period (LP-272).
 */

/**
 * One board type's remote representation, as declared under `mapping.types`.
 *
 * `remote` is **one** name — the remote issue type (Jira "Story", the
 * jsonfile `type` field) or the label that marks it (GitHub, Linear).  A board
 * type and a remote type are one-to-one in both directions: a push has one
 * name to write, and a pull reading that name knows which board type it is.
 * Nothing here is a list, because nothing here is a choice.
 *
 * That is the one way it differs from `StatusMapping` below, and the
 * difference is real rather than cosmetic: several *remote states* genuinely
 * mean one board status ("Done", "Won't Fix" and "Duplicate" are all the
 * board's `done`), so a status carries a list and a `push` that says which one
 * to write back.  No such case exists for types.
 *
 * **Which carrier the name lands in is the provider's business, not the
 * mapping's.**  A provider with native issue types (Jira, jsonfile) writes it
 * into the native type field; one without (GitHub, Linear) writes it as a
 * label.  Declaring the carrier here as well was a redundancy: `{ type: Story,
 * labels: [story] }` said the same thing twice, in two keys that could
 * disagree, about a decision the provider had already made.  It also means a
 * mapping survives a repository that later turns native issue types on — the
 * name is the same, only where it is written moves.
 *
 * The declaration may be written short (`user_story: Story`) or as the object
 * form (`user_story: { remote: Story }`); `normalizeTypeMapping` expands the
 * shorthand to the object form, which is the only form the engine reads.
 */
export interface TypeMapping {
  /** The remote name that means this board type. Never empty. */
  remote: string;
}

/** The `mapping.types` block: local type name → remote representation. */
export type TypeMappings = Record<string, TypeMapping>;

/**
 * Normalize one `mapping.types` value to the object form.  Accepts the bare
 * string (`user_story: Story`) and the object form, and returns `undefined`
 * when the value names nothing.
 *
 * Two **superseded** spellings are folded rather than refused, so a board
 * written against an older shape keeps working and means what it meant:
 * `{ type: Story, labels: [story] }` (the two carriers, before the provider
 * was left to choose) and a list (`[Story, "User Story"]`, before types were
 * one-to-one).  Where a fold has to choose, the native `type` wins over a
 * label and the first entry wins over the rest — the value that was actually
 * being written before.
 */
export function normalizeTypeMapping(value: unknown): TypeMapping | undefined {
  const remote = remoteNameOf(value);
  return remote === undefined ? undefined : { remote };
}

/** The single remote name a raw `mapping.types` value carries. */
function remoteNameOf(value: unknown): string | undefined {
  const first = (input: unknown): string | undefined => {
    if (typeof input === 'string' && input.length > 0) return input;
    if (Array.isArray(input)) {
      return input.find((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    }
    return undefined;
  };

  if (typeof value === 'string' || Array.isArray(value)) return first(value);
  if (value === null || typeof value !== 'object') return undefined;

  const raw = value as Record<string, unknown>;
  // `remote` first, then the superseded keys in the order that preserves what
  // the older shape actually wrote: the native type, then its label.
  return first(raw.remote) ?? first(raw.type) ?? first(raw.labels);
}

/**
 * Normalize the whole `mapping.types` block, dropping entries that name no
 * remote type.  The provider schema rejects malformed values before this runs;
 * this is the pure spelling of the same rule for callers that read a mapping
 * without a schema in hand.
 */
export function normalizeTypeMappings(raw: Record<string, unknown>): TypeMappings {
  const out: TypeMappings = {};
  for (const [type, value] of Object.entries(raw)) {
    const entry = normalizeTypeMapping(value);
    if (entry) out[type] = entry;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Push: board type → the remote representation written
// ---------------------------------------------------------------------------

/**
 * The remote name a push writes for a board type.  Returns `undefined` when
 * the type has no usable mapping; a default remote type must never be
 * invented, because filing everything as "Task" is precisely the silent data
 * loss this refuses.
 */
export function mapTypeToRemote(
  mappings: TypeMappings,
  boardType: string,
): string | undefined {
  return remoteNameFor(mappings[boardType]);
}

/**
 * One entry's remote name, read defensively.  The provider schema normalizes
 * every declaration before the engine sees it, so this is always a non-empty
 * string in practice — but a hand-built mapping that skipped the schema (an
 * older shape, a test literal) should read as *unmapped* rather than crash the
 * push that would have reported it.
 */
function remoteNameFor(entry: TypeMapping | undefined): string | undefined {
  const remote = entry?.remote;
  if (typeof remote === 'string' && remote.length > 0) return remote;
  // Tolerate an unnormalized value the same way `normalizeTypeMapping` would.
  return remote === undefined ? undefined : remoteNameOf(remote);
}

/** Every remote name any mapped type claims, in declaration order. */
export function claimedTypeValues(mappings: TypeMappings): string[] {
  return Object.values(mappings)
    .map((entry) => remoteNameFor(entry))
    .filter((name): name is string => name !== undefined);
}

/**
 * Board types (in hierarchy order) with no usable mapping — the list a
 * preflight reports when it refuses to open the remote.  A mapping entry that
 * names no remote type counts as missing.
 */
export function missingTypeMappings(
  mappings: TypeMappings,
  hierarchy: string[][],
): string[] {
  const declared = hierarchy.flat();
  return declared.filter((type) => mapTypeToRemote(mappings, type) === undefined);
}

// ---------------------------------------------------------------------------
// Pull: remote type / labels → board type
// ---------------------------------------------------------------------------

/** What the remote issue carries that a type could be recovered from. */
export interface RemoteTypeObservation {
  /** The remote's native issue type, when the provider has types. */
  remoteType?: string;
  /** The remote issue's labels. */
  labels: readonly string[];
}

/** Why `mapTypeFromRemote` could not produce a single board type. */
export type TypeResolutionFailure = 'unmapped' | 'depth' | 'ambiguous';

/**
 * The result of resolving a remote issue back to a board type.
 *
 * `candidates` is every board type whose mapping matched the observation, in
 * sorted order.  When `type` is set the resolution succeeded; when it is
 * `undefined`, `unresolved` says why:
 *
 * - `unmapped`   — no board type's mapping matched the observation (candidates
 *                  is empty).
 * - `depth`      — candidates matched, but none is legal at the document's
 *                  depth (the remote reparented it somewhere the local
 *                  hierarchy forbids).
 * - `ambiguous`  — more than one candidate is legal at the depth, and the
 *                  managed block's recorded type did not (or could not) break
 *                  the tie.  The depth-legal contenders are `candidates`
 *                  filtered by `hierarchy[depth]`.
 */
export interface BoardTypeResolution {
  type: string | undefined;
  candidates: string[];
  unresolved: TypeResolutionFailure | undefined;
}

/**
 * Resolve a remote issue's type back to a board type.  When the observation
 * matches several board types the resolution disambiguates **by depth first** —
 * the type must be legal at the document's depth — **then by the managed
 * block's recorded type**, the tiebreaker for two types that share a depth.
 *
 * `recordedType` is the `type` value the managed block wrote when this issue
 * was pushed; it is consulted only within the depth-narrowed set, so it can
 * break a tie but never override the hierarchy.
 */
export function mapTypeFromRemote(
  mappings: TypeMappings,
  hierarchy: string[][],
  observation: RemoteTypeObservation,
  opts: { depth: number; recordedType?: string },
): BoardTypeResolution {
  const candidates = boardTypesMatching(mappings, observation);

  if (candidates.length === 0) {
    return { type: undefined, candidates: [], unresolved: 'unmapped' };
  }

  const atDepth = new Set(hierarchy[opts.depth] ?? []);
  const narrowed = candidates.filter((type) => atDepth.has(type));

  if (narrowed.length === 1) {
    return { type: narrowed[0], candidates, unresolved: undefined };
  }
  if (narrowed.length === 0) {
    return { type: undefined, candidates, unresolved: 'depth' };
  }

  if (opts.recordedType !== undefined && narrowed.includes(opts.recordedType)) {
    return { type: opts.recordedType, candidates, unresolved: undefined };
  }

  return { type: undefined, candidates, unresolved: 'ambiguous' };
}

/**
 * True when a mapping entry matches the remote observation: one of the entry's
 * `remote` values is the observed native type, or is present as a label.
 *
 * The entry does not say which carrier its values were written to, so both are
 * checked — which is the point.  A repository that turns native issue types on
 * (or a provider that gains them) starts reporting the same value in a
 * different field, and the mapping that was already correct keeps working
 * rather than silently resolving nothing.  Matching still runs on the
 * *mapping's declared values*: a label a human happened to add only matters
 * when some board type claims it.
 */
function entryMatches(
  entry: TypeMapping,
  observation: RemoteTypeObservation,
): boolean {
  const remote = remoteNameFor(entry);
  if (remote === undefined) return false;
  return remote === observation.remoteType || observation.labels.includes(remote);
}

/**
 * Every board type whose mapping claims this observation, sorted — the shared
 * answer to "what type is this remote issue?" before depth and the managed
 * block get a say.  Each provider's translator reads it rather than filtering
 * `mapping.types` itself, so the four of them cannot drift apart on what
 * counts as a match.
 */
export function boardTypesMatching(
  mappings: TypeMappings,
  observation: RemoteTypeObservation,
): string[] {
  return Object.entries(mappings)
    .filter(([, entry]) => entryMatches(entry, observation))
    .map(([boardType]) => boardType)
    .sort();
}

// ---------------------------------------------------------------------------
// Degraded levels
// ---------------------------------------------------------------------------

/** One hierarchy level the remote cannot hold natively. */
export interface DegradedLevel {
  /** Folder depth of this level, matching `hierarchy`'s index. */
  depth: number;
  /** Type names that live at this level. */
  types: string[];
}

/**
 * The hierarchy levels beyond the remote's native depth — the levels whose
 * parenting must be carried by the degradation ladder rather than a native
 * parent field.  Their *types* still map normally; it is the nesting that
 * degrades.
 *
 * `nativeDepth` is the number of levels the remote can nest, counting the root
 * as level 1: a tracker with no hierarchy is 1, one with a single level of
 * sub-issues (GitHub) is 2, and so on.  Levels at index `nativeDepth` and
 * beyond are degraded.
 */
export function degradedHierarchyLevels(
  hierarchy: string[][],
  nativeDepth: number,
): DegradedLevel[] {
  const degraded: DegradedLevel[] = [];
  for (let depth = nativeDepth; depth < hierarchy.length; depth += 1) {
    const types = hierarchy[depth] ?? [];
    if (types.length > 0) degraded.push({ depth, types: [...types] });
  }
  return degraded;
}

// ---------------------------------------------------------------------------
// Status mapping (LP-269)
// ---------------------------------------------------------------------------

/**
 * One board status's remote representation, as declared under `mapping.statuses`.
 *
 * `remote` lists every remote state that means this board status — GitHub
 * labels, Jira workflow statuses, Linear states.  A push writes exactly one of
 * them: `push` when it names one, otherwise the first.  `closed` records
 * whether this status closes the remote issue; it must agree with the board
 * status's `terminal` flag, and a disagreement is a warning.
 *
 * The declaration may be written short — `done: Done`, or
 * `done: [Done, "Won't Fix", Duplicate]` — and `normalizeStatusMapping` expands
 * the shorthand to this object form, which is the only form the engine reads.
 */
export interface StatusMapping {
  /** Every remote state that means this board status. Never empty. */
  remote: string[];
  /** Which remote state a push writes. Defaults to `remote[0]`. */
  push?: string;
  /** Whether this status closes the remote issue. */
  closed?: boolean;
}

/** The `mapping.statuses` block: local status id → remote representation. */
export type StatusMappings = Record<string, StatusMapping>;

/**
 * Normalize one `mapping.statuses` value to the object form.  Accepts the
 * three spellings — a single remote state (`done: Done`), a list
 * (`done: [Done, "Won't Fix"]`), or the full object — and returns `undefined`
 * when the value carries no usable remote state.
 */
export function normalizeStatusMapping(value: unknown): StatusMapping | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return { remote: [value] };
  }
  if (Array.isArray(value)) {
    const remote = value.filter((v): v is string => typeof v === 'string' && v.length > 0);
    return remote.length > 0 ? { remote } : undefined;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const raw = value as Record<string, unknown>;
    const r = raw.remote;
    const remote =
      typeof r === 'string' && r.length > 0
        ? [r]
        : Array.isArray(r)
          ? r.filter((v): v is string => typeof v === 'string' && v.length > 0)
          : [];
    if (remote.length === 0) return undefined;
    const entry: StatusMapping = { remote };
    if (typeof raw.push === 'string' && raw.push.length > 0) entry.push = raw.push;
    if (typeof raw.closed === 'boolean') entry.closed = raw.closed;
    return entry;
  }
  return undefined;
}

/**
 * Normalize the whole `mapping.statuses` block, dropping entries that carry no
 * usable remote state.  The provider schema rejects malformed values before
 * this runs; this is the pure spelling of the same rule for callers that read
 * a mapping without a schema in hand.
 */
export function normalizeStatusMappings(raw: Record<string, unknown>): StatusMappings {
  const out: StatusMappings = {};
  for (const [status, value] of Object.entries(raw)) {
    const entry = normalizeStatusMapping(value);
    if (entry) out[status] = entry;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Push: board status → remote state
// ---------------------------------------------------------------------------

/**
 * One entry's `remote` states, read defensively.  Normalized entries always
 * carry a list; a hand-built one that skipped the schema may carry the bare
 * string the config also accepts (`done: { remote: Done }`), and that must
 * read as one state — never as a string being indexed into, which would hand
 * a push the single character `D`.
 */
export function statusStatesOf(entry: StatusMapping | undefined): string[] {
  const remote = entry?.remote as string[] | string | undefined;
  if (Array.isArray(remote)) return remote;
  return typeof remote === 'string' && remote.length > 0 ? [remote] : [];
}

/**
 * The remote state a push writes for a board status — `push` when declared,
 * otherwise the first `remote` state.  Returns `undefined` when the status has
 * no usable mapping; a default remote state must never be invented.
 */
export function mapStatusToRemote(
  mappings: StatusMappings,
  boardStatus: string,
): string | undefined {
  const states = statusStatesOf(mappings[boardStatus]);
  if (states.length === 0) return undefined;
  return mappings[boardStatus]?.push ?? states[0];
}

/**
 * Whether a board status closes the remote issue, per the mapping: `true` when
 * the entry says `closed: true`, `false` when it says `closed: false`, and
 * `undefined` when the status is unmapped or the entry does not say — absent
 * means "not declared", never "assume it matches `terminal`".
 */
export function isClosedRemote(
  mappings: StatusMappings,
  boardStatus: string,
): boolean | undefined {
  return mappings[boardStatus]?.closed;
}

/**
 * Board statuses with no usable mapping — the list a preflight reports when it
 * refuses to open the remote.  A status with no key, or whose entry normalised
 * away to nothing, counts as missing.
 */
export function missingStatusMappings(
  mappings: StatusMappings,
  boardStatusIds: readonly string[],
): string[] {
  return boardStatusIds.filter(
    (status) => mapStatusToRemote(mappings, status) === undefined,
  );
}

// ---------------------------------------------------------------------------
// Pull: remote state(s) → board status
// ---------------------------------------------------------------------------

/** Why `mapStatusFromRemote` could not produce a single board status. */
export type StatusResolutionFailure = 'unmapped' | 'ambiguous';

/**
 * The result of resolving observed remote states back to a board status.
 *
 * `candidates` is every board status whose `remote` list includes one of the
 * observed states, in sorted order.  When `status` is set the resolution
 * succeeded; when it is `undefined`, `unresolved` says why:
 *
 * - `unmapped`  — no board status claims any observed state;
 * - `ambiguous` — several board statuses each claim one observed state (the
 *                 issue carries both "Done" and "In Progress", say).
 */
export interface BoardStatusResolution {
  status: string | undefined;
  candidates: string[];
  unresolved: StatusResolutionFailure | undefined;
}

/**
 * Resolve observed remote states back to a single board status.  A board
 * status claims the issue when one of its `remote` states is observed; a
 * status mapping is expected to be many-remote-states-to-one-status, so a
 * single observed state can never be ambiguous on its own — only several
 * observed states that claim *different* board statuses are.
 */
export function mapStatusFromRemote(
  mappings: StatusMappings,
  observed: readonly string[],
): BoardStatusResolution {
  const candidates = Object.entries(mappings)
    .filter(([, entry]) => statusStatesOf(entry).some((state) => observed.includes(state)))
    .map(([status]) => status)
    .sort();

  if (candidates.length === 0) {
    return { status: undefined, candidates: [], unresolved: 'unmapped' };
  }
  if (candidates.length === 1) {
    return { status: candidates[0], candidates, unresolved: undefined };
  }
  return { status: undefined, candidates, unresolved: 'ambiguous' };
}

/**
 * Remote states with no board counterpart — the reverse-direction totality
 * the preflight reports before anything is written.  `observedRemoteStates` is
 * the full set of states the remote actually carries (from a live listing),
 * not the labels on one issue.
 */
export function unmappedRemoteStates(
  mappings: StatusMappings,
  observedRemoteStates: readonly string[],
): string[] {
  const claimed = new Set<string>();
  for (const entry of Object.values(mappings)) {
    for (const state of statusStatesOf(entry)) claimed.add(state);
  }
  return observedRemoteStates.filter((state) => !claimed.has(state));
}

// ---------------------------------------------------------------------------
// Terminal ↔ closed agreement
// ---------------------------------------------------------------------------

/**
 * Where a board status's `terminal` flag and the mapping's `closed` flag
 * disagree.  They must agree, or a push would close a non-end column (or leave
 * an end column open) — and a pull could not recover either faithfully.
 */
export interface StatusClosednessMismatch {
  status: string;
  /** The board's `terminal` flag. */
  terminal: boolean;
  /** The mapping's `closed` flag (false when absent). */
  closed: boolean;
}

/**
 * Board statuses whose `terminal` flag disagrees with the mapping's `closed`
 * flag, in both directions: terminal-but-not-closed, and closed-but-not-
 * terminal.  `statuses` is the board's status list (`BoardConfig.statuses`).
 */
export function statusClosednessMismatches(
  mappings: StatusMappings,
  statuses: readonly { id: string; terminal?: boolean }[],
): StatusClosednessMismatch[] {
  const mismatches: StatusClosednessMismatch[] = [];
  for (const status of statuses) {
    const terminal = status.terminal === true;
    const closed = mappings[status.id]?.closed === true;
    if (terminal !== closed) {
      mismatches.push({ status: status.id, terminal, closed });
    }
  }
  return mismatches;
}
