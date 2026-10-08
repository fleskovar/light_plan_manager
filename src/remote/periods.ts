/**
 * Period ↔ container mapping — how a board's periods (increments, sprints)
 * become a remote's containers (milestones, sprints, cycles, iterations), and
 * back again (LP-272, LP-313).
 *
 * One slice of the mapping engine (LP-254). A board declares a period
 * hierarchy (`increment › sprint`); a remote has one container concept — a
 * GitHub milestone, a Jira sprint, a Linear cycle — with a name and, where the
 * platform holds them, dates. This module is the join:
 *
 *   - push: an issue's period (an id) resolves through the period index to a
 *     container reference (name + dates) when its type is the mapped level, or
 *     to a degraded level name when its type sits above the mapped level. The
 *     transversal cut is the interesting case — a feature in an increment, its
 *     stories in sprints: the sprint maps to the container, the increment to a
 *     degraded level the executor carries in the managed block (LP-313).
 *   - pull: a remote observation (container name + dates, plus the degraded
 *     level names) resolves back to a local period by name among the mapped
 *     level's periods; the dates are recovered for the planner to reconcile; a
 *     container matching no local period is reported with a suggestion, never
 *     invented.
 *
 * The mapping is data: `mapping.periods` declares which period *type* is the
 * container level, and which *carrier* the remote uses for it — a milestone or
 * a Projects v2 iteration field (LP-313). Depth is derived from
 * `period_hierarchy`, never declared — the same rule the type mapping follows
 * (LP-268). A board with no periods has no period mapping and nothing here is
 * required (the story's fourth criterion): `normalizePeriodMapping` returns
 * `undefined`, the push returns nothing to write, and the pull resolves
 * nothing.
 *
 * Pure: no disk, no network. The period index is passed in, exactly as the
 * roster is passed to `accounts.ts`.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** The native carrier a mapped period rides: a milestone, an iteration field or a Jira sprint. */
export type PeriodCarrier = 'milestones' | 'iteration' | 'sprint';

/** The `mapping.periods` block: which period type maps to the remote's
 * container, and which carrier carries it (LP-313). */
export interface PeriodMapping {
  /** The period type that maps to the remote's container (sprint, cycle, …). */
  container: string;
  /** The native carrier: a milestone (default) or a Project iteration field. */
  carrier: PeriodCarrier;
}

/**
 * Normalize the `mapping.periods` block; `undefined` when it names no
 * container or carrier. Three spellings are accepted:
 *
 *   - `'milestones'` / `'iteration'` / `'sprint'` — the shorthand, naming only
 *     the carrier; the container defaults to the deepest period level
 *     (`openRemote` fills it in via `resolvePeriodContainer`);
 *   - `{ container: 'sprint' }` — the carrier defaults to `milestones`;
 *   - `{ container: 'sprint', carrier: 'iteration' | 'sprint' }` — both explicit.
 *
 * The provider schema rejects malformed values before this runs; this is the
 * pure spelling of the same rule for callers that read a mapping without a
 * schema in hand.
 */
export function normalizePeriodMapping(raw: unknown): PeriodMapping | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') {
    if (raw === 'milestones' || raw === 'iteration' || raw === 'sprint') {
      return { container: '', carrier: raw };
    }
    return undefined;
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const rec = raw as Record<string, unknown>;
    const container = typeof rec.container === 'string' && rec.container.length > 0 ? rec.container : '';
    const carrier: PeriodCarrier =
      rec.carrier === 'iteration' || rec.carrier === 'sprint' ? rec.carrier : 'milestones';
    if (container === '' && rec.carrier === undefined) return undefined;
    return { container, carrier };
  }
  return undefined;
}

/**
 * Resolve a mapping whose `container` is empty (the string shorthand) to the
 * deepest declared period level — the one level that maps to a milestone /
 * sprint / cycle, exactly as `scaffoldPeriods` picks it. A mapping that
 * already names a container is returned unchanged.
 */
export function resolvePeriodContainer(
  mapping: PeriodMapping,
  periodHierarchy: readonly (readonly string[])[],
): PeriodMapping {
  if (mapping.container !== '') return mapping;
  const deepest = periodHierarchy.flat().at(-1);
  return { ...mapping, container: deepest ?? mapping.container };
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** A local period as the period mapping sees it. */
export interface MappedPeriod {
  id: string;
  title: string;
  /** Period type name, e.g. `increment` or `sprint`. */
  type: string;
  /** The enclosing period's id, or null at the timeline root. */
  parentId: string | null;
  /** Inclusive start date, `YYYY-MM-DD`, when the period carries one. */
  starts?: string;
  /** Inclusive end date, `YYYY-MM-DD`, when the period carries one. */
  ends?: string;
}

/** Periods keyed by id — the timeline slice the period mapping reads. */
export type PeriodIndex = ReadonlyMap<string, MappedPeriod>;

/**
 * The remote container a mapped period becomes: a sprint / milestone / cycle
 * is carried by its name, plus the dates the platform holds.
 */
export interface PeriodContainer {
  name: string;
  starts?: string;
  ends?: string;
}

// ---------------------------------------------------------------------------
// The degraded level's block convention
// ---------------------------------------------------------------------------

/**
 * The managed-block field name carrying a degraded period level's name:
 * `period:<type>` (`period:increment` → `PI-2`). The container level never
 * rides the block — it has a native carrier — so only the levels above the
 * mapped one appear under this prefix (LP-313).
 */
export function degradedPeriodField(type: string): string {
  return `period:${type}`;
}

/** The period types beyond the container level, in hierarchy order. */
export function degradedLevels(
  mapping: PeriodMapping,
  periodHierarchy: readonly (readonly string[])[],
): string[] {
  return periodHierarchy.flat().filter((type) => type !== mapping.container);
}

/** The period types on the timeline beyond the container level, derived from
 * the index rather than the config — the caller (a translator) has the loaded
 * timeline but not the hierarchy. */
export function degradedTypesOf(index: PeriodIndex, mapping: PeriodMapping): Set<string> {
  const types = new Set<string>();
  for (const period of index.values()) {
    if (period.type !== mapping.container) types.add(period.type);
  }
  return types;
}

/**
 * Read the degraded period levels back out of a managed block's parsed fields.
 * Each degraded type is looked up under its `period:<type>` field name; a row
 * a human added for an unknown type is ignored, and a row naming the container
 * level is ignored too — the container rides a native carrier, never the block.
 */
export function degradedFromBlockFields(
  fields: Record<string, string>,
  degradedTypes: ReadonlySet<string>,
): DegradedPeriod[] {
  const degraded: DegradedPeriod[] = [];
  for (const type of degradedTypes) {
    const name = fields[degradedPeriodField(type)];
    if (typeof name === 'string' && name !== '') degraded.push({ type, name });
  }
  degraded.sort((a, b) => a.type.localeCompare(b.type));
  return degraded;
}

// ---------------------------------------------------------------------------
// Push: board period → remote container / degraded levels
// ---------------------------------------------------------------------------

/** A period id the index does not know — reported rather than dropped. */
export interface PeriodGap {
  periodId: string;
  reason: string;
}

/** A degraded period level: the period type and its title, carried in the
 * managed block rather than a native container. */
export interface DegradedPeriod {
  type: string;
  name: string;
}

/** What one issue's period becomes on the remote (push direction). */
export interface PeriodPush {
  /**
   * The container to schedule the issue into, when its period (or an ancestor)
   * sits at the mapped level. Absent when no period in the chain does — an
   * issue scheduled directly in an increment has no container, only a degraded
   * level.
   */
  container?: PeriodContainer;
  /** The degraded levels' names, carried in the managed block on push. */
  degraded: DegradedPeriod[];
  /** A period id the index does not know, reported rather than dropped. */
  gap?: PeriodGap;
}

/**
 * Resolve an issue's period (a period id) to what the remote should see.
 *
 * Walks the chain from the issue's period up to the timeline root, classifying
 * each level against the mapping: the mapped level becomes the container, every
 * other level a degraded level carried in the managed block. A container is
 * taken from the nearest period at the mapped level — the issue's own period
 * when it sits there, its ancestor's when it does not.
 *
 *   - no period → nothing to write;
 *   - a period the index does not know → a `gap`, reported rather than dropped.
 */
export function mapPeriodToRemote(
  index: PeriodIndex,
  mapping: PeriodMapping,
  periodId: string | null | undefined,
): PeriodPush {
  if (!periodId) return { degraded: [] };

  const start = index.get(periodId);
  if (!start) {
    return { degraded: [], gap: { periodId, reason: 'not on the timeline' } };
  }

  const degraded: DegradedPeriod[] = [];
  let container: PeriodContainer | undefined;

  const seen = new Set<string>();
  let cursor: MappedPeriod | undefined = start;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    if (cursor.type === mapping.container) {
      if (container === undefined) {
        container = { name: cursor.title };
        if (cursor.starts !== undefined) container.starts = cursor.starts;
        if (cursor.ends !== undefined) container.ends = cursor.ends;
      }
    } else {
      degraded.push({ type: cursor.type, name: cursor.title });
    }
    cursor = cursor.parentId ? index.get(cursor.parentId) : undefined;
  }

  degraded.sort((a, b) => a.type.localeCompare(b.type));
  return container === undefined ? { degraded } : { container, degraded };
}

// ---------------------------------------------------------------------------
// Provision (the story's second criterion)
// ---------------------------------------------------------------------------

/**
 * What a push creates for one period before it files: the container (name
 * + dates) when the period sits at the mapped level, or `undefined` when it is
 * a degraded level — a degraded period has no container to create, and its
 * membership is carried by the managed block instead. Where the platform cannot
 * hold a container at all (no native `periods` capability cell) the caller
 * reports it; the capability table itself is `capabilities.ts`, not this file.
 */
export function provisionForPeriod(
  period: MappedPeriod,
  mapping: PeriodMapping,
): PeriodContainer | undefined {
  if (period.type !== mapping.container) return undefined;
  const container: PeriodContainer = { name: period.title };
  if (period.starts !== undefined) container.starts = period.starts;
  if (period.ends !== undefined) container.ends = period.ends;
  return container;
}

// ---------------------------------------------------------------------------
// Pull: remote container / degraded levels → board period
// ---------------------------------------------------------------------------

/** What the remote carries that a period could be recovered from. */
export interface PeriodObservation {
  /** The container's name (milestone title, sprint name, iteration title). */
  container?: string;
  /** The container's dates, when the remote holds them. */
  starts?: string;
  ends?: string;
  /** The degraded-level names read back out of the managed block. */
  degraded: DegradedPeriod[];
}

/** A container matching no local period — reported, never invented. */
export interface PeriodMissing {
  containerName: string;
  /** The fix: create the local period, or provision the remote container. */
  suggestion: string;
}

/** Why `mapPeriodFromRemote` could not produce a single local period. */
export type PeriodResolutionFailure = 'unmapped' | 'ambiguous';

/**
 * The result of resolving a remote observation back to a local period.
 *
 * `periodId` is set when the container name matched exactly one local period at
 * the mapped level; `starts` / `ends` are the dates as observed, recovered for
 * the planner to reconcile against the local period (a mismatch is a conflict
 * like any other — the merge is LP-257's, not this file's). `degraded` is the
 * degraded-level names read back out of the managed block. When `periodId` is
 * `undefined`, `unresolved` says why:
 *
 * - `unmapped`   — a container name with no matching local period (`missing`
 *                  carries the suggestion);
 * - `ambiguous`  — two local periods at the mapped level share the name
 *                  (`candidates` lists them).
 */
export interface PeriodPull {
  periodId?: string;
  starts?: string;
  ends?: string;
  degraded: DegradedPeriod[];
  unresolved?: PeriodResolutionFailure;
  candidates?: string[];
  missing?: PeriodMissing;
}

/**
 * Resolve a remote issue's container back to a local period. The container is
 * matched by name among the mapped level's periods; a name the board does not
 * have is reported (`missing`) with the fix, never invented — the timeline is
 * a statement about the plan, and a sync must not enlarge it. Dates are passed
 * through so the planner can reconcile them. The degraded-level names arrive
 * already read out of the managed block (`observation.degraded`), so this stays
 * a pure name-to-id join with no knowledge of the block's wire format.
 */
export function mapPeriodFromRemote(
  index: PeriodIndex,
  mapping: PeriodMapping,
  observation: PeriodObservation,
): PeriodPull {
  const result: PeriodPull = {
    starts: observation.starts,
    ends: observation.ends,
    degraded: [...observation.degraded],
  };

  const name = observation.container;
  if (name === undefined || name === '') return result;

  const matches = [...index.values()]
    .filter((period) => period.type === mapping.container && period.title === name)
    .map((period) => period.id)
    .sort();

  if (matches.length === 0) {
    result.unresolved = 'unmapped';
    result.missing = {
      containerName: name,
      suggestion: `create a ${mapping.container} titled "${name}" locally, or provision "${name}" on the remote`,
    };
    return result;
  }

  if (matches.length > 1) {
    result.unresolved = 'ambiguous';
    result.candidates = matches;
    return result;
  }

  result.periodId = matches[0];
  return result;
}
