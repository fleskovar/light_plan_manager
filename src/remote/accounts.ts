/**
 * Resource ↔ account mapping — how a board's people and pools become a
 * remote's assignees, and back again (LP-271).
 *
 * One slice of the mapping engine (LP-254). The board's roster is a statement
 * about the team: named people (the `person` type) and generic pools (any
 * resource type declared `generic: true`). A remote has assignees — GitHub
 * logins, Jira account ids — and no notion of a pool. This module is the join:
 *
 *   - push: a person whose `via` attribute holds a value becomes that remote
 *     account; a person with no value degrades to unassigned and is reported —
 *     once per person, never once per issue; a pool has no account anywhere and
 *     degrades to unassigned plus a `pool:` label naming it, which is what lets
 *     the pull restore the pool.
 *   - pull: an account matching a person's `via` value restores that person;
 *     the `pool:` label restores the pool; an account matching nobody is
 *     reported with the `lpm new person` that would add them, and is never
 *     invented — the roster is a statement about the team, and a sync must not
 *     enlarge it.
 *
 * Pure: no disk, no network. The roster is passed in, exactly as the board's
 * attribute definitions are passed to the attribute coercion (`attributes.ts`).
 */

/** The `mapping.accounts` block: which resource attribute carries the remote account. */
export interface AccountMapping {
  /** Resource attribute whose value is the remote account (`github`, `email`). */
  via: string;
}

/**
 * Normalize the `mapping.accounts` block; `undefined` when it names no
 * attribute. The provider schema rejects malformed values before this runs;
 * this is the pure spelling of the same rule for callers that read a mapping
 * without a schema in hand.
 */
export function normalizeAccountMapping(raw: unknown): AccountMapping | undefined {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const via = (raw as Record<string, unknown>).via;
    if (typeof via === 'string' && via.length > 0) return { via };
  }
  return undefined;
}

/** A resource as the account mapping sees it: id, title, and whether it is a pool. */
export interface MappedResource {
  id: string;
  title: string;
  /** True when the resource is a generic pool rather than a named person. */
  generic: boolean;
  /** The resource's attributes, keyed by name — the `via` value lives here. */
  attributes: Record<string, unknown>;
}

/** Resources keyed by id — the roster slice the account mapping reads. */
export type Roster = ReadonlyMap<string, MappedResource>;

/**
 * The label prefix carrying a pool assignment on the remote. Reserved: a
 * mapping must not use `pool` as an attribute label prefix, or the pull could
 * read a pool assignment out of an unrelated label.
 */
export const POOL_LABEL_PREFIX = 'pool:';

/** The label naming a pool: `pool:<resource-id>`. */
export function poolLabel(resourceId: string): string {
  return `${POOL_LABEL_PREFIX}${resourceId}`;
}

/**
 * The managed-block row an assignee rides when the remote cannot hold it.
 *
 * Rung 4 of the degradation ladder, applied to the last field that was falling
 * off the end of it. A tracker's `assignee` is a single user account everywhere
 * — no platform lets an issue be assigned to a team or a group — so a board that
 * assigns work to a **pool**, or to a person with no account on that tracker,
 * had nowhere to put it: GitHub and Linear could at least encode a pool as a
 * label, and Jira dropped it silently. Pushed from one board and pulled into
 * another, the roster half of the plan simply evaporated.
 *
 * The value is the board's **resource id**, which is what the `pool:` label has
 * always carried, so the two encodings recover the same way.
 */
export const ASSIGNEE_FIELD = 'assignee';

/**
 * The observed labels, plus the assignee the managed block carried.
 *
 * The block's value and the `pool:` label are the same thing — a board resource
 * id — so folding one into the other gives every provider a single way to
 * recover an assignee, rather than a second resolution path per translator that
 * could disagree with the first. The block wins nothing and loses nothing:
 * `mapAssigneeFromRemote` takes the first label that names a resource it knows,
 * and a document has only ever one of the two encodings.
 */
export function withBlockAssignee(
  labels: readonly string[],
  managedFields: Record<string, string>,
): string[] {
  const carried = managedFields[ASSIGNEE_FIELD];
  if (carried === undefined || carried === '') return [...labels];
  // An `id` cell is rendered as a markdown link when the writer knew the twin's
  // URL, so the link text is the id. Unwrapped here rather than by importing
  // `parseManagedId`: this module is the account mapping and has no business
  // depending on the block codec, which already depends on nothing.
  const match = /^\[([^\]]+)\]\([^)]*\)$/.exec(carried);
  return [...labels, poolLabel(match === null ? carried : match[1]!)];
}

/** The pool id a label names, or `undefined` when it is not a pool label. */
export function poolIdFromLabel(label: string): string | undefined {
  if (!label.startsWith(POOL_LABEL_PREFIX)) return undefined;
  const id = label.slice(POOL_LABEL_PREFIX.length);
  return id.length > 0 ? id : undefined;
}

// ---------------------------------------------------------------------------
// Push: board assignee → remote account / labels
// ---------------------------------------------------------------------------

/**
 * A person whose account could not be resolved, to be reported. The dedupe key
 * is `resourceId` — the planner reports each gap once per person, not once per
 * issue.
 */
export interface ResourceGap {
  /** The resource id the gap is about. */
  resourceId: string;
  /** Human-readable resource title, for the report. */
  resourceTitle: string;
  /** Why the resource has no account. */
  reason: string;
}

/** What one issue's board assignee becomes on the remote (push direction). */
export interface AccountPush {
  /** The remote account to assign; absent means the issue goes unassigned. */
  account?: string;
  /** Labels carrying an unassignable assignee (a pool), so the pull restores it. */
  labels: string[];
  /** A person with no resolvable account — reported once per person. */
  gap?: ResourceGap;
}

/**
 * Resolve one issue's assignee (a resource id) to what the remote should see.
 *
 *   - no assignee (`null` / `undefined` / `''`) → unassigned, nothing to report;
 *   - a person with a value for `accounts.via` → that account;
 *   - a person with no value → unassigned, plus a `gap` to report;
 *   - a generic pool → unassigned, plus the `pool:` label that restores it;
 *   - an id not on the roster → unassigned, plus a `gap` naming it (a stale
 *     assignee `lpm check` would already have reported).
 *
 * When `accounts` is `undefined` no person can resolve — every person degrades
 * to unassigned with a gap, because a remote with no account mapping can never
 * carry an assignment.
 */
export function mapAssigneeToRemote(
  resources: Roster,
  accounts: AccountMapping | undefined,
  assigneeId: string | null | undefined,
): AccountPush {
  if (!assigneeId) return { labels: [] };

  const resource = resources.get(assigneeId);
  if (!resource) {
    return {
      labels: [],
      gap: {
        resourceId: assigneeId,
        resourceTitle: assigneeId,
        reason: 'not on the roster',
      },
    };
  }

  if (resource.generic) {
    return { labels: [poolLabel(resource.id)] };
  }

  if (!accounts) {
    return {
      labels: [],
      gap: {
        resourceId: resource.id,
        resourceTitle: resource.title,
        reason: 'no account mapping is configured (set mapping.accounts.via)',
      },
    };
  }

  const value = resource.attributes[accounts.via];
  if (typeof value === 'string' && value.length > 0) {
    return { account: value, labels: [] };
  }

  return {
    labels: [],
    gap: {
      resourceId: resource.id,
      resourceTitle: resource.title,
      reason: `no "${accounts.via}" attribute value`,
    },
  };
}

/**
 * Deduplicate push gaps by resource id — "once per person, not once per
 * issue". The mapping reports a gap per issue; a reporter calls this before
 * printing, so a person lacking a `github` value is named once even when forty
 * of their issues are pushed. Order is first-seen.
 */
export function uniqueResourceGaps(gaps: readonly ResourceGap[]): ResourceGap[] {
  const seen = new Set<string>();
  const out: ResourceGap[] = [];
  for (const gap of gaps) {
    if (seen.has(gap.resourceId)) continue;
    seen.add(gap.resourceId);
    out.push(gap);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pull: remote account / labels → board assignee
// ---------------------------------------------------------------------------

/** A remote assignee nobody on the roster matches — reported, never invented. */
export interface UnknownAccount {
  /** The remote account found. */
  account: string;
  /** The `lpm new person` that would add them to the roster. */
  suggestion: string;
}

/** What a remote issue's assignee becomes locally (pull direction). */
export interface AccountPull {
  /** The resolved resource id, when a person or pool matched. */
  resourceId?: string;
  /** True when the remote issue is explicitly unassigned. */
  unassigned?: boolean;
  /** A remote account on no roster. */
  unknown?: UnknownAccount;
}

/**
 * Resolve a remote issue's assignee back to a board resource.
 *
 * The `pool:` label wins — it is our own encoding of a pool assignment, and the
 * only label that is authoritative about the *local* assignee. Otherwise the
 * account is matched against each named person's `via` value:
 *
 *   - a matching person → that resource;
 *   - no account and no pool label → `unassigned`;
 *   - an account matching nobody → `unknown`, with the `lpm new person` that
 *     would add them. A resource is never invented here.
 */
export function mapAssigneeFromRemote(
  resources: Roster,
  accounts: AccountMapping | undefined,
  observed: { account?: string; labels: readonly string[] },
): AccountPull {
  for (const label of observed.labels) {
    const id = poolIdFromLabel(label);
    if (id !== undefined && resources.has(id)) {
      return { resourceId: id };
    }
  }

  if (!observed.account) {
    return { unassigned: true };
  }

  if (!accounts) {
    return {
      unknown: {
        account: observed.account,
        suggestion: `configure mapping.accounts.via, then create a person whose account is "${observed.account}"`,
      },
    };
  }

  for (const resource of resources.values()) {
    if (resource.generic) continue;
    const value = resource.attributes[accounts.via];
    if (typeof value === 'string' && value === observed.account) {
      return { resourceId: resource.id };
    }
  }

  return {
    unknown: {
      account: observed.account,
      suggestion: `lpm new person --set ${accounts.via}="${observed.account}"`,
    },
  };
}
