/**
 * The push executor — the push-side mirror of `applyChanges` in `src/sync/apply.ts`.
 *
 * `planPush` (`plan.ts`) returns a `RemoteOp[]` and makes no request; `lpm
 * remote push` (LP-341) is a thin printer.  This file owns the piece between
 * them: it walks the plan in order, has the provider's translator turn each op
 * into a request description, sends it through the (already decorated)
 * connector, and records what landed in the link store **before** attempting
 * the next op — so an interruption at any point leaves a store that matches the
 * remote, and re-running the sync is the retry mechanism (LP-298's resumability
 * rests on this loop).
 *
 * The planner stays pure and browser-compatible; this file does the I/O.  It
 * makes **no planning decision**: a test can hand it a literal plan and an
 * in-memory connector and assert exactly which requests were made and what was
 * recorded.  Ordering, scope, direction and diffing all live in `planPush`;
 * this loop only carries them out.
 *
 * ## Recording, per op, from the response
 *
 * Every landed write records two things before the next op runs:
 *
 *   - the link (`setLink` for a create): remote id, key, url and the remote's
 *     revision marker, all read off the `ConnectorResult` the request returned;
 *   - the base snapshot (`updateBase`): the mapped fields as the **remote** now
 *     holds them, read off the `ConnectorResult.record` the request returned
 *     and translated back to board vocabulary, with `remoteRev` from that same
 *     response (LP-288). Recording the local intent instead would make the
 *     next pull see our own write as a remote edit.
 *
 * The base's dependency list is tracked by this executor rather than read from
 * the document: a create starts with no remote edges and each landed `link` /
 * `unlink` moves it, so a partially-landed push re-plans exactly the edges that
 * still need making.
 *
 * ## The diff is the planner's; the full document is the executor's
 *
 * `planPush` emits an op only when something changed, and its `fields` / `status`
 * carry that diff.  The executor reads the full document back from the board
 * instead, because the translator produces a full request from full fields — a
 * partial set would make it drop the type/status labels and the connector would
 * then clear them.  Conflict detection (LP-257) will later decide *which* fields
 * are actually sent; until then a push converges the twin onto the board's whole
 * current state.
 */

import type { LoadedBoard } from '../core/board/load.js';
import type { Issue } from '../core/model/types.js';
import {
  computeBase,
  decoupleLink,
  getManagedCommentId,
  hashBody,
  removeLink,
  saveLinkStore,
  setCommentId,
  setLink,
  setManagedCommentId,
  updateBase,
} from './links.js';
import type { LinkStore } from './links.js';
import type { ManagedBlockEntry, ManagedBlockLinks } from './managed-block.js';
import { applyManagedBlock, refsEntry } from './managed-block.js';
import { parentBlockEntry, recordOf } from './hierarchy.js';
import type { ResolvedHierarchy } from './hierarchy.js';
import { planManagedComment, renderManagedComment } from './managed-comment.js';
import type { ManagedCommentCapability } from './managed-comment.js';
import type { RemoteOp, RemoteRef } from './plan.js';
import {
  attributeDefsOf,
  boardFieldsOf,
  periodIndexOf,
  rosterOf,
} from './preflight.js';
import {
  ASSIGNEE_FIELD,
  mapAssigneeToRemote,
  normalizeAccountMapping,
  poolLabel,
  type Roster,
} from './accounts.js';
import type { DegradedPeriod, PeriodIndex } from './periods.js';
import { degradedPeriodField, mapPeriodToRemote, normalizePeriodMapping } from './periods.js';
import type { AttributeDefs, BoardOp, Connector, RemoteRecord, RemoteRequest } from './provider.js';
import type { OpenedRemote } from './remotes.js';
import { BudgetExhaustedError, RemoteError } from './transport/index.js';

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/** One progress event, emitted before each op is attempted (LP-298). */
export interface OpProgress {
  /** 1-based position of this op in the plan. */
  index: number;
  /** Total number of ops in the plan. */
  total: number;
  /** The op about to be attempted. */
  op: RemoteOp;
  /** The board document the op acts on. */
  localId: string;
}

/** An op that landed on the remote and was recorded in the link store. */
export interface LandedOp {
  kind: RemoteOp['kind'];
  localId: string;
  status: 'landed';
  /** The remote id the op resolved or wrote. */
  remoteId?: string;
}

/** An op that was attempted and rejected. */
export interface FailedOp {
  kind: RemoteOp['kind'];
  localId: string;
  status: 'failed';
  error: string;
}

/** An op the remote refused because its twin changed since it was read (a 409). */
export interface ConflictedOp {
  kind: RemoteOp['kind'];
  localId: string;
  status: 'conflicted';
  error: string;
}

/** An op that was never attempted: it waits on a failed create, or the connector cannot do it. */
export interface SkippedOp {
  kind: RemoteOp['kind'];
  localId: string;
  status: 'skipped';
  reason: string;
}

/** The counts a summary reports (LP-298), per document-level outcome. */
export interface PushSummary {
  /** New twins filed (`create` / `restore` ops that landed). */
  created: number;
  /** Existing twins written or re-wired: every other landed op. */
  updated: number;
  skipped: number;
  conflicted: number;
  failed: number;
}

/** Why a run stopped before it reached the end of the plan. */
export interface StopInfo {
  reason: 'aborted' | 'budget' | 'limit';
  /** 1-based position of the op that was in flight, or the next un-attempted one. */
  atOp: number;
  /** Human-readable detail: how far the budget got, the limit reached, … */
  detail: string;
  /** How many remaining remote-write ops were deferred (`--limit`, LP-350). */
  deferred?: number;
}

/** What one push execution landed, per document. */
export interface PushExecutionResult {
  landed: LandedOp[];
  failed: FailedOp[];
  skipped: SkippedOp[];
  /** Ops the remote refused with a conflict (409), split out of `failed` (LP-298). */
  conflicted: ConflictedOp[];
  /** Aggregated counts for the CLI/server summary line. */
  summary: PushSummary;
  /** Present when the run stopped early — aborted, budget-exhausted, or `--limit`. */
  stopped?: StopInfo;
}

export interface ExecutePushOptions {
  /** Progress callback, one call per op before it is attempted. */
  onProgress?: (progress: OpProgress) => void;
  /** Clock for the `syncedAt` written into each link. Injectable for tests. */
  now?: () => Date;
  /**
   * The resolved comment capability, for the managed-comment op (LP-278).
   * Defaults to "no comments", so an executor handed no capabilities skips
   * the op with a reason rather than guessing.
   */
  comments?: ManagedCommentCapability;
  /**
   * Abort signal (LP-298): checked before each op and threaded into every
   * connector write, so Ctrl-C aborts the in-flight request and the run stops
   * at a consistent point — after the current op, nothing further attempted.
   */
  signal?: AbortSignal;
  /**
   * At most this many remote write ops are performed (LP-298): a cautious
   * first run stops here and re-running continues from the link store. Local
   * bookkeeping (`unlinkLocal`, `decouple`) does not count.
   */
  limit?: number;
  /**
   * The hierarchy encoding resolved for this run (LP-493). Recorded on the
   * link store after a clean run, so the next push can detect an encoding
   * switch and migrate the twins whose parent changed carrier.
   */
  hierarchy?: ResolvedHierarchy;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The field names the base snapshot records, derived from the mapping. */
function mappedFieldsOf(mapping: Record<string, unknown>): Set<string> {
  const fields = new Set<string>(['title', 'body', 'status']);
  if (mapping['accounts'] !== undefined) fields.add('assignee');
  if (mapping['periods'] !== undefined) fields.add('period');
  const attributes = mapping['attributes'];
  if (attributes && typeof attributes === 'object' && !Array.isArray(attributes)) {
    for (const name of Object.keys(attributes)) fields.add(name);
  }
  // The effort attribute (Linear's native `estimate` — LP-333) is a tracked
  // field too: the base snapshot records it, so an estimate changed in Linear
  // comes back as a field change rather than a phantom.
  const effort = mapping['effort'];
  if (effort && typeof effort === 'object' && !Array.isArray(effort)) {
    const attribute = (effort as Record<string, unknown>)['attribute'];
    if (typeof attribute === 'string' && attribute !== '') fields.add(attribute);
  }
  return fields;
}

/** The board document an op acts on, for the summary and the progress callback. */
function localIdOf(op: RemoteOp): string {
  switch (op.kind) {
    case 'link':
    case 'unlink':
      return op.dependent.localId;
    case 'comment':
      return op.ref.localId;
    case 'edges':
      return op.localId;
    default:
      return op.localId;
  }
}

/** The dependency list a base snapshot records, in either spelling. */
function readEdges(base: Record<string, unknown> | undefined): string[] {
  if (!base) return [];
  const value = base['dependsOn'] ?? base['depends_on'];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** The relates list a base snapshot records, in either spelling. */
function readRelates(base: Record<string, unknown> | undefined): string[] {
  if (!base) return [];
  const value = base['relatesTo'] ?? base['relates_to'];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** An error message from any thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Classify a thrown write failure (LP-298): a stop-the-run condition (budget
 * exhausted, the caller's signal aborted) vs a per-op outcome (a 409 conflict
 * vs an ordinary failure).
 *
 * `RemoteError` is transport vocabulary — the executor may read it because a
 * connector built on the transport layer throws it, but the executor itself
 * never constructs one.  A conflict is any `RemoteError` classified `conflict`
 * (HTTP 409), which `classifyStatus` maps; `status === 409` is the defensive
 * fallback for an error that bypassed that classification.
 */
function classifyFailure(
  error: unknown,
  signal?: AbortSignal,
): 'budget' | 'aborted' | 'conflict' | 'failed' {
  if (error instanceof BudgetExhaustedError) return 'budget';
  if (signal?.aborted) return 'aborted';
  if (error instanceof RemoteError) {
    if (error.kind === 'abort') return 'aborted';
    if (error.code === 'conflict' || error.status === 409) return 'conflict';
    return 'failed';
  }
  if (error instanceof Error && error.name === 'AbortError') return 'aborted';
  return 'failed';
}

/**
 * True when an op can invoke a connector write — the ops `--limit` counts
 * (LP-298). `unlinkLocal` and `decouple` are local link-store edits, never a
 * remote write, so a cautious first run does not spend its limit on them.
 */
export function isRemoteWrite(op: RemoteOp): boolean {
  switch (op.kind) {
    case 'create':
    case 'restore':
    case 'update':
    case 'transition':
    case 'close':
    case 'delete':
    case 'link':
    case 'unlink':
    case 'edges':
    case 'reparent':
    case 'comment':
    case 'managedComment':
      return true;
    default:
      return false;
  }
}

/**
 * Local id → remote URL, for rendering the managed comment's id cells as
 * clickable links.  Derived from the link store (the same source the block
 * writer uses), with an explicit override winning when a dry-run supplied one.
 */
function managedCommentLinks(
  store: LinkStore,
  override?: ManagedBlockLinks,
): ManagedBlockLinks {
  const links = new Map<string, string>();
  for (const [localId, entry] of store.links) {
    if (entry.remoteUrl !== '') links.set(localId, entry.remoteUrl);
  }
  if (override) {
    for (const [id, url] of override) links.set(id, url);
  }
  return links;
}

// ---------------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------------

/**
 * Walk a push plan through a connector, recording each landed operation.
 *
 * Mutates `store` in place and writes it back to
 * `.lpm/remotes/<remote.name>/links.json` after every landed op, so an
 * interruption at any point leaves the store matching the remote.  A failed op
 * does not abort the run: independent documents continue, dependents of the
 * failure (a child of a failed create, an edge naming its endpoint) are skipped
 * with a reason, and the summary reports created, updated, skipped,
 * conflicted and failed per document (LP-298).  A budget-exhausted or aborted
 * failure ends the whole run cleanly rather than cascading through the ops
 * behind it; `--limit` stops before the next write once it is reached.
 *
 * No planning: the plan's order is respected as-is, every op's references are
 * resolved through the placeholder map a landed create populates, and nothing
 * here re-derives scope, direction or diffs.
 */
export async function executePush(
  board: LoadedBoard,
  remote: OpenedRemote,
  connector: Connector,
  store: LinkStore,
  plan: RemoteOp[],
  options: ExecutePushOptions = {},
): Promise<PushExecutionResult> {
  const now = options.now ?? (() => new Date());
  const translator = remote.provider.translator;
  const mapping = remote.mapping;
  const attributes = attributeDefsOf(board);
  const roster = rosterOf(board);
  const periods = periodIndexOf(board);
  const mappedFields = mappedFieldsOf(mapping);

  /** Placeholder (`new:N`) → the remote id its create landed with. */
  const placeholders = new Map<string, string>();
  /**
   * Remote dependency edges per local id, tracked by the executor so the base
   * records what actually landed rather than what the document wants.  Seeded
   * lazily from the store's existing base on first touch.
   */
  const edges = new Map<string, Set<string>>();
  const landed: LandedOp[] = [];
  const failed: FailedOp[] = [];
  const skipped: SkippedOp[] = [];
  const conflicted: ConflictedOp[] = [];
  const total = plan.length;
  /** Set when the run stops early (abort, budget, limit); absent on a full run. */
  let stop: StopInfo | undefined;
  /** How many remote writes have been attempted, for `--limit` (LP-298). */
  let writesAttempted = 0;

  /** The remote id a ref names, or undefined when its create has not landed. */
  const resolveRef = (ref: RemoteRef): string | undefined =>
    ref.kind === 'linked' ? ref.remoteId : placeholders.get(ref.placeholder);

  /** The tracked edge set for a local id, seeded from the stored base. */
  const edgesOf = (localId: string): Set<string> => {
    let set = edges.get(localId);
    if (set) return set;
    set = new Set(readEdges(store.links.get(localId)?.base));
    edges.set(localId, set);
    return set;
  };

  /**
   * Remote relates edges per local id, tracked exactly like `edges` so the
   * base records what actually landed (LP-314).
   */
  const relates = new Map<string, Set<string>>();
  const relatesOf = (localId: string): Set<string> => {
    let set = relates.get(localId);
    if (set) return set;
    set = new Set(readRelates(store.links.get(localId)?.base));
    relates.set(localId, set);
    return set;
  };

  /** The remote id a landed local edge points at, or undefined when unresolved. */
  const remoteIdOfLocal = (localId: string): string | undefined =>
    store.links.get(localId)?.remoteId;

  /**
   * Compose a body: the prose plus the full managed block (degraded parent,
   * the degraded period levels, and the edge rows that landed).  Called on
   * every body write so a prose edit never strips the block.  The degraded
   * periods are derived from the document's own period (LP-313);
   * `extraBlockParent` names the degraded parent's remote id when the op
   * carries one; the edges come from the tracked state, which holds what
   * actually landed rather than what the document wants.
   */
  /**
   * The period levels one issue's schedule degrades to — the `period:<type>`
   * rows that ride the managed block.
   *
   * A provider with no native period container declares no `periods` mapping
   * at all: the jsonfile provider is the worked example, and its schema has no
   * such key to declare. `ladder.ts` already answers that case — with no
   * mapping, *every* period level rides the block — so walk the chain with a
   * container name no period type can match and let each level degrade.
   * Both writers below go through this: when only one of them did, the `edges`
   * op wrote the sprint and the create did not, and a schedule the board shows
   * was nowhere on the remote at all (LP-533).
   */
  const degradedPeriodsOf = (periodId: string): DegradedPeriod[] => {
    const periodMapping = normalizePeriodMapping(mapping['periods']) ?? {
      container: '',
      carrier: 'milestones' as const,
    };
    return mapPeriodToRemote(periods, periodMapping, periodId).degraded;
  };

  /**
   * The assignee, when the request will not carry it.
   *
   * A tracker's `assignee` is a single user account on every platform, so a pool
   * — or a person with no account there — cannot be written to it. Where the
   * provider writes labels the translator encodes a pool as `pool:<id>` and that
   * is carriage enough; where it does not (Jira), or where the person has no
   * account value at all, the block is the only place left. Without this the
   * information is not *degraded*, it is **lost**: pushed from one board and
   * pulled into another, every assignment the tracker could not represent was
   * simply gone.
   */
  /**
   * Does this provider encode a pool as a `pool:` label?
   *
   * Only the translator knows — GitHub and Linear write one, Jira writes no
   * labels at all — so it is asked once, with a synthetic op. The translator is
   * pure, so the probe costs nothing and reaches no network; guessing from the
   * capability table would be wrong, because `provisioning.labels` is about
   * *creating* a label list and says nothing about whether one is written.
   */
  let poolRidesLabel: boolean | undefined;
  const carriesPoolAsLabel = (): boolean => {
    if (poolRidesLabel !== undefined) return poolRidesLabel;
    const probe = '__pool_probe__';
    const probeRoster: Roster = new Map([
      [probe, { id: probe, title: probe, generic: true, attributes: {} }],
    ]);
    const described = translator.describeRequest(
      { kind: 'create', localId: probe, fields: { type: '', status: '', assignee: probe } },
      mapping,
      attributes,
      probeRoster,
      periods,
    );
    poolRidesLabel = (described.request.labels ?? []).includes(poolLabel(probe));
    return poolRidesLabel;
  };

  const assigneeEntryOf = (localId: string): ManagedBlockEntry[] => {
    const doc = board.byId.get(localId);
    const assignee = doc?.assignee;
    if (!assignee) return [];
    const push = mapAssigneeToRemote(roster, normalizeAccountMapping(mapping['accounts']), assignee);
    // Written to the native assignee field, or encoded as a label the pull
    // already reads: the block would be a second copy of a fact the remote holds.
    if (push.account !== undefined && push.account !== '') return [];
    if (push.labels.length > 0 && carriesPoolAsLabel()) return [];
    return [{ name: ASSIGNEE_FIELD, kind: 'id', value: assignee }];
  };

  const composeBody = (localId: string, prose: string, extraBlockParent?: string): string => {
    const entries: ManagedBlockEntry[] = [];
    if (extraBlockParent !== undefined) entries.push(parentBlockEntry(extraBlockParent));
    entries.push(...assigneeEntryOf(localId));
    const doc = board.byId.get(localId);
    if (doc && doc.period) {
      for (const level of degradedPeriodsOf(doc.period)) {
        entries.push({ name: degradedPeriodField(level.type), kind: 'text', value: level.name });
      }
    }
    const depends = [...edgesOf(localId)]
      .map(remoteIdOfLocal)
      .filter((id): id is string => id !== undefined)
      .sort();
    if (depends.length > 0) entries.push(refsEntry('depends_on', depends));
    const rel = [...relatesOf(localId)]
      .map(remoteIdOfLocal)
      .filter((id): id is string => id !== undefined)
      .sort();
    if (rel.length > 0) entries.push(refsEntry('relates_to', rel));
    return applyManagedBlock(prose, entries);
  };

  /** The degraded period block entries for a document, for the `edges` op
   * which builds its block without the translator (LP-313). */
  const degradedEntriesOf = (localId: string): ManagedBlockEntry[] => {
    const doc = board.byId.get(localId);
    if (!doc || !doc.period) return [];
    return degradedPeriodsOf(doc.period).map((level) => ({
      name: degradedPeriodField(level.type),
      kind: 'text' as const,
      value: level.name,
    }));
  };

  /**
   * The base snapshot for a landed write, sourced from the remote's post-write
   * record (LP-288).
   *
   * The remote is the authority on what a write actually produced — it may
   * normalise markdown, reorder labels or reject part of an update — so the
   * base starts from the local document's fields (the fallback for a field the
   * record does not carry) and overlays every field the record does carry,
   * translated back to board vocabulary. Recording the intent instead would
   * make the next pull see our own write as a remote edit, which is the
   * ping-pong this whole story exists to prevent.
   */
  const baseFromRecord = (
    doc: Issue,
    remoteRecord: RemoteRecord | undefined,
  ): Record<string, unknown> => {
    const base = computeBase(doc, mappedFields, translator.normalizeBody); // fallback: local intent
    if (remoteRecord === undefined) return base;

    const patch = translator.fieldsFromRecord(remoteRecord, mapping, attributes, roster, periods).patch;
    if (patch.title !== undefined) base.title = patch.title;
    if (patch.body !== undefined) base.body = hashBody(patch.body);
    if (patch.status !== undefined) base.status = patch.status;
    if (patch.assignee !== undefined) base.assignee = patch.assignee;
    if (patch.period !== undefined) base.period = patch.period;
    if (patch.attributes !== undefined) {
      for (const [name, value] of Object.entries(patch.attributes)) {
        if (mappedFields.has(name)) base[name] = value;
      }
    }
    return base;
  };

  /** Record a full base snapshot (fields + tracked edges) and persist the store. */
  const recordBase = (
    localId: string,
    doc: Issue,
    remoteRecord: RemoteRecord | undefined,
    remoteRev: string,
    syncedAt: string,
    unwritten: readonly string[] = [],
  ): void => {
    const base = baseFromRecord(doc, remoteRecord);
    // A field the remote would not take (an issue scheduled into a sprint the
    // tracker has not got) is recorded as **unset**, never as the value we
    // hoped for. That is what makes the repair automatic: the next push sees
    // the board's value against an empty base, and writes it the moment the
    // other half exists. Recording the local value instead would make the two
    // sides look agreed and the scheduling would never land.
    for (const field of unwritten) base[field] = null;
    base['dependsOn'] = [...edgesOf(localId)].sort();
    base['relatesTo'] = [...relatesOf(localId)].sort();
    // Shape (LP-368): the agreed parent and type, so the next pull can tell
    // who moved a document. A push never writes parent/type — the shared
    // planners own reparenting — so the local document's shape is the agreed
    // shape after a landed write.
    base['parent'] = doc.parentId ?? null;
    base['type'] = doc.type;
    updateBase(store, localId, base, remoteRev, syncedAt);
    saveLinkStore(board.paths, remote.name, store);
  };

  /**
   * Record which remote parent a twin was actually filed under (`null` when it
   * was filed at the remote's root because its parent had no twin yet).
   *
   * This is the memory that lets a plan be pushed a piece at a time: the base
   * snapshot records the *local* parent, which never changes when the parent
   * is simply missing upstream, so without this a story filed before its
   * feature stayed at the root for ever.
   */
  const recordParent = (localId: string, remoteParentId: string | null): void => {
    const link = store.links.get(localId);
    if (!link) return;
    store.links.set(localId, { ...link, parentRemoteId: remoteParentId });
    saveLinkStore(board.paths, remote.name, store);
  };

  /** Record only an edge change (a landed link / unlink / edges) and persist the store. */
  const recordEdges = (localId: string, remoteRev: string, syncedAt: string): void => {
    const link = store.links.get(localId);
    if (!link) return; // the dependent's create did not land — nothing to record
    const base = { ...(link.base ?? {}) };
    base['dependsOn'] = [...edgesOf(localId)].sort();
    base['relatesTo'] = [...relatesOf(localId)].sort();
    updateBase(store, localId, base, remoteRev, syncedAt);
    saveLinkStore(board.paths, remote.name, store);
  };

  /** The local id an op is waiting on, when it is a create that has not landed. */
  const waitingOn = (ref: RemoteRef | undefined): string | undefined =>
    ref && ref.kind === 'created' && resolveRef(ref) === undefined ? ref.localId : undefined;

  /** The loop index, declared up here so `handleFailure` can report where it stopped. */
  let i = 0;

  /**
   * Record one write failure and report whether the whole run must stop.
   * A budget-exhausted or aborted failure ends the run cleanly (the store is
   * already consistent — the landed op before this one was recorded); a
   * conflict is split into `conflicted`, anything else into `failed`.
   */
  const handleFailure = (kind: RemoteOp['kind'], localId: string, error: unknown): boolean => {
    const outcome = classifyFailure(error, options.signal);
    if (outcome === 'budget' || outcome === 'aborted') {
      stop = { reason: outcome, atOp: i + 1, detail: messageOf(error) };
      return true;
    }
    if (outcome === 'conflict') {
      conflicted.push({ kind, localId, status: 'conflicted', error: messageOf(error) });
    } else {
      failed.push({ kind, localId, status: 'failed', error: messageOf(error) });
    }
    return false;
  };

  /**
   * Set the Project status column for a landed status-affecting write
   * (LP-312), or throw. The caller records the failure and skips recording
   * the base, so a failed status write leaves the base behind the board's
   * current status and the next push re-attempts it — never silently settles
   * for a stale column. A no-op when the request carries no Project status
   * (no Project status field declared).
   */
  const applyProjectStatus = async (request: RemoteRequest, remoteId: string): Promise<void> => {
    if (request.projectStatus === undefined) return;
    if (typeof connector.setProjectStatus !== 'function') {
      throw new Error('the connector cannot set the Project status field');
    }
    await connector.setProjectStatus(remoteId, request.projectStatus, options.signal);
  };

  outer: for (i = 0; i < plan.length; i += 1) {
    const op = plan[i]!;
    const localId = localIdOf(op);

    // Stop conditions, checked before the op is attempted.  A `--limit` only
    // withholds remote writes: local bookkeeping (unlinkLocal, decouple) still
    // runs, so the store can reach a consistent state behind the last write.
    if (options.signal?.aborted) {
      stop = { reason: 'aborted', atOp: i + 1, detail: 'interrupted before the op was attempted' };
      break;
    }
    if (options.limit !== undefined && writesAttempted >= options.limit && isRemoteWrite(op)) {
      // The ops from here on are never attempted — they are deferred, so the
      // report says how many (LP-350): a cautious first run stops and re-running
      // continues from the link store.
      const deferred = plan.slice(i).filter(isRemoteWrite).length;
      stop = {
        reason: 'limit',
        atOp: i + 1,
        detail: `--limit ${options.limit}: ${writesAttempted} write ${writesAttempted === 1 ? 'operation' : 'operations'} already performed`,
        deferred,
      };
      break;
    }

    options.onProgress?.({ index: i + 1, total, op, localId });

    switch (op.kind) {
      case 'create': {
        const parentRemoteId = op.parent ? resolveRef(op.parent) : undefined;
        const blockParentRemoteId = op.blockParent ? resolveRef(op.blockParent) : undefined;
        const blockedBy = waitingOn(op.parent) ?? waitingOn(op.blockParent);
        if (blockedBy !== undefined) {
          skipped.push({
            kind: 'create',
            localId,
            status: 'skipped',
            reason: `waits on ${blockedBy}, which was not created`,
          });
          break;
        }

        const doc = board.byId.get(op.localId);
        if (!doc) {
          failed.push({
            kind: 'create',
            localId,
            status: 'failed',
            error: `document ${op.localId} does not exist on the board`,
          });
          break;
        }

        // Like the update cases below, the request is built from the board's
        // full document, not from `op.fields` — they are identical in a real
        // sync, and one source of truth is simpler than two.
        const boardOp: BoardOp = { kind: 'create', localId: op.localId, fields: boardFieldsOf(doc) };
        const described = translator.describeRequest(boardOp, mapping, attributes, roster, periods);
        const request: RemoteRequest = { ...described.request };
        if (parentRemoteId !== undefined) {
          request.parent = parentRemoteId;
        }
        if (typeof request.body === 'string') {
          // Degraded parent (LP-309) and degraded period levels (LP-313) ride
          // the managed block; the edges land in the later `edges` op once
          // every endpoint exists.
          request.body = composeBody(op.localId, request.body, blockParentRemoteId);
        }

        try {
          writesAttempted += 1;
          const result = await connector.create(request, options.signal);
          placeholders.set(op.placeholder, result.remoteId);
          edges.set(op.localId, new Set());
          relates.set(op.localId, new Set());
          setLink(store, op.localId, {
            remoteId: result.remoteId,
            remoteKey: result.remoteKey,
            remoteUrl: result.remoteUrl,
            ...(result.nodeId !== undefined ? { nodeId: result.nodeId } : {}),
            syncedAt: now().toISOString(),
            remoteRev: result.remoteRev,
          });
          await applyProjectStatus(request, result.remoteId);
          recordBase(op.localId, doc, result.record, result.remoteRev, now().toISOString(), result.unwritten);
          recordParent(op.localId, parentRemoteId ?? blockParentRemoteId ?? null);
          landed.push({ kind: 'create', localId, status: 'landed', remoteId: result.remoteId });
        } catch (error) {
          if (handleFailure('create', localId, error)) break outer;
        }
        break;
      }

      case 'restore': {
        // Re-file a vanished twin (LP-365).  Like `create`, except the
        // document already carries a link to the deleted twin: `setLink`
        // replaces it (and the reverse index) with the new remote id, and
        // `recordBase` rewrites the base from the response — a re-file, never
        // a true undelete.  The old comments and key are gone with the twin.
        const parentRemoteId = op.parent ? resolveRef(op.parent) : undefined;
        const blockParentRemoteId = op.blockParent ? resolveRef(op.blockParent) : undefined;
        const blockedBy = waitingOn(op.parent) ?? waitingOn(op.blockParent);
        if (blockedBy !== undefined) {
          skipped.push({
            kind: 'restore',
            localId,
            status: 'skipped',
            reason: `waits on ${blockedBy}, which was not restored`,
          });
          break;
        }

        const doc = board.byId.get(op.localId);
        if (!doc) {
          failed.push({
            kind: 'restore',
            localId,
            status: 'failed',
            error: `document ${op.localId} does not exist on the board`,
          });
          break;
        }

        const boardOp: BoardOp = { kind: 'create', localId: op.localId, fields: boardFieldsOf(doc) };
        const described = translator.describeRequest(boardOp, mapping, attributes, roster, periods);
        const request: RemoteRequest = { ...described.request };
        if (parentRemoteId !== undefined) {
          request.parent = parentRemoteId;
        }
        if (typeof request.body === 'string') {
          request.body = composeBody(op.localId, request.body, blockParentRemoteId);
        }

        try {
          writesAttempted += 1;
          const result = await connector.create(request, options.signal);
          placeholders.set(op.placeholder, result.remoteId);
          edges.set(op.localId, new Set());
          relates.set(op.localId, new Set());
          setLink(store, op.localId, {
            remoteId: result.remoteId,
            remoteKey: result.remoteKey,
            remoteUrl: result.remoteUrl,
            ...(result.nodeId !== undefined ? { nodeId: result.nodeId } : {}),
            syncedAt: now().toISOString(),
            remoteRev: result.remoteRev,
          });
          await applyProjectStatus(request, result.remoteId);
          recordBase(op.localId, doc, result.record, result.remoteRev, now().toISOString(), result.unwritten);
          recordParent(op.localId, parentRemoteId ?? blockParentRemoteId ?? null);
          landed.push({ kind: 'restore', localId, status: 'landed', remoteId: result.remoteId });
        } catch (error) {
          if (handleFailure('restore', localId, error)) break outer;
        }
        break;
      }

      case 'close': {
        // Policy close (`on_delete: close`, LP-351): the twin is closed because
        // the local document went away — deleted, or out of the remote's scope —
        // not because the board reached a terminal status.  Post the note, close
        // to the board's terminal status, then drop the link.  The document may
        // not exist on the board (a deletion), so the type comes from the base
        // snapshot the link store recorded.
        if (op.note !== undefined) {
          const terminal = board.config.statuses.find((status) => status.terminal)?.id;
          const doc = board.byId.get(op.localId);
          const type =
            doc?.type ?? (store.links.get(op.localId)?.base?.['type'] as string | undefined);
          if (terminal === undefined || type === undefined) {
            failed.push({
              kind: 'close',
              localId,
              status: 'failed',
              error:
                terminal === undefined
                  ? 'no terminal status declared on the board'
                  : `the deleted document ${op.localId} recorded no type in its base snapshot`,
            });
            break;
          }
          const boardOp: BoardOp = {
            kind: 'update',
            localId: op.localId,
            remoteId: op.ref.remoteId,
            fields: { type, status: terminal },
          };
          const described = translator.describeRequest(boardOp, mapping, attributes, roster, periods);
          try {
            writesAttempted += 1;
            if (typeof connector.comment === 'function') {
              await connector.comment(op.ref.remoteId, op.note, options.signal);
            }
            const result = await connector.update(op.ref.remoteId, described.request, options.signal);
            await applyProjectStatus(described.request, op.ref.remoteId);
            // Drop the link: a tombstone when the document still exists (out of
            // scope — never re-file it), a plain unlink when it is gone.
            if (doc) {
              decoupleLink(store, op.localId, 'out_of_scope', now().toISOString());
            } else {
              removeLink(store, op.localId);
            }
            saveLinkStore(board.paths, remote.name, store);
            landed.push({ kind: 'close', localId, status: 'landed', remoteId: op.ref.remoteId });
          } catch (error) {
            if (handleFailure('close', localId, error)) break outer;
          }
          break;
        }

        // Ordinary close: the board reached a terminal status.  Same path as a
        // transition — the document is still present, the twin is updated to the
        // terminal status, and the link is kept.
        const doc = board.byId.get(op.localId);
        if (!doc) {
          failed.push({
            kind: 'close',
            localId,
            status: 'failed',
            error: `document ${op.localId} does not exist on the board`,
          });
          break;
        }
        const boardOp: BoardOp = {
          kind: 'update',
          localId: op.localId,
          remoteId: op.ref.remoteId,
          fields: { ...boardFieldsOf(doc), title: undefined, body: undefined },
        };
        const described = translator.describeRequest(boardOp, mapping, attributes, roster, periods);
        try {
          writesAttempted += 1;
          const result = await connector.update(op.ref.remoteId, described.request, options.signal);
          await applyProjectStatus(described.request, op.ref.remoteId);
          recordBase(op.localId, doc, result.record, result.remoteRev, now().toISOString(), result.unwritten);
          landed.push({ kind: 'close', localId, status: 'landed', remoteId: op.ref.remoteId });
        } catch (error) {
          if (handleFailure('close', localId, error)) break outer;
        }
        break;
      }

      case 'delete': {
        // `on_delete: delete` (LP-351): remove the twin through the connector's
        // `delete` method, which degrades where the platform cannot hard-delete
        // (GitHub closes instead, documented on its adapter).  The link is
        // dropped only after the delete lands, so a failure leaves it in place
        // and the next sync retries.
        try {
          writesAttempted += 1;
          await connector.delete(op.ref.remoteId, options.signal);
          const doc = board.byId.get(op.localId);
          if (doc) {
            decoupleLink(store, op.localId, 'out_of_scope', now().toISOString());
          } else {
            removeLink(store, op.localId);
          }
          saveLinkStore(board.paths, remote.name, store);
          landed.push({ kind: 'delete', localId, status: 'landed', remoteId: op.ref.remoteId });
        } catch (error) {
          if (handleFailure('delete', localId, error)) break outer;
        }
        break;
      }

      case 'update':
      case 'transition': {
        const doc = board.byId.get(op.localId);
        if (!doc) {
          failed.push({
            kind: op.kind,
            localId,
            status: 'failed',
            error: `document ${op.localId} does not exist on the board`,
          });
          break;
        }

        // The translator needs the full document for the label/state
        // derivation — a partial type/status would make it drop those labels
        // and the connector would then clear them. Title and body are the two
        // independent fields, so they ride on the plan's diff: an `update` op
        // carries them only when they changed, and a `transition` never
        // re-sends them — an unchanged title or body is not sent over the wire
        // (LP-307).
        const diff = op.kind === 'update' ? op.fields : {};
        // A body rewrite re-applies the managed block (LP-314): the block is
        // our own output, never the board's prose, so a prose edit must not
        // strip the parent / edge / period rows. The degraded parent rides the
        // op; the degraded periods and edges come from the tracked state (what
        // actually landed). A period change also rewrites the block, because
        // the degraded levels above the container live in it (LP-313).
        const blockParentRemoteId =
          op.kind === 'update' && op.blockParent !== undefined
            ? resolveRef(op.blockParent)
            : undefined;
        // The body is recomposed whenever something *the block carries* moved,
        // not only when the prose did. `assignee` is in that list because an
        // assignee the tracker cannot hold rides the block: without it, changing
        // only the assignee left the block saying what it said before, and the
        // change reached neither the remote's own field nor the fallback — which
        // is the same loss the fallback exists to prevent, arriving one push
        // later.
        const bodyField =
          diff.body !== undefined || diff.period !== undefined || diff.assignee !== undefined
            ? composeBody(op.localId, diff.body ?? doc.body, blockParentRemoteId)
            : undefined;
        const boardOp: BoardOp = {
          kind: 'update',
          localId: op.localId,
          remoteId: op.ref.remoteId,
          fields: {
            ...boardFieldsOf(doc),
            title: diff.title,
            body: bodyField,
          },
        };
        const described = translator.describeRequest(boardOp, mapping, attributes, roster, periods);

        try {
          writesAttempted += 1;
          const result = await connector.update(op.ref.remoteId, described.request, options.signal);
          if (op.kind === 'transition') {
            await applyProjectStatus(described.request, op.ref.remoteId);
          }
          recordBase(op.localId, doc, result.record, result.remoteRev, now().toISOString(), result.unwritten);
          landed.push({ kind: op.kind, localId, status: 'landed', remoteId: op.ref.remoteId });
        } catch (error) {
          if (handleFailure(op.kind, localId, error)) break outer;
        }
        break;
      }

      case 'link': {
        const blockedBy = waitingOn(op.dependent) ?? waitingOn(op.dependency);
        if (blockedBy !== undefined) {
          skipped.push({
            kind: 'link',
            localId,
            status: 'skipped',
            reason: `waits on ${blockedBy}, which was not created`,
          });
          break;
        }
        if (typeof connector.link !== 'function') {
          skipped.push({
            kind: 'link',
            localId,
            status: 'skipped',
            reason: 'connector does not support links',
          });
          break;
        }

        const dependentRemoteId = resolveRef(op.dependent)!;
        const dependencyRemoteId = resolveRef(op.dependency)!;
        try {
          writesAttempted += 1;
          const result = await connector.link(dependentRemoteId, dependencyRemoteId, options.signal, op.linkKind);
          if (op.linkKind === 'relates') relatesOf(op.dependent.localId).add(op.dependency.localId);
          else edgesOf(op.dependent.localId).add(op.dependency.localId);
          recordEdges(op.dependent.localId, result.remoteRev, now().toISOString());
          landed.push({ kind: 'link', localId, status: 'landed', remoteId: dependentRemoteId });
        } catch (error) {
          if (handleFailure('link', localId, error)) break outer;
        }
        break;
      }

      case 'unlink': {
        if (typeof connector.unlink !== 'function') {
          skipped.push({
            kind: 'unlink',
            localId,
            status: 'skipped',
            reason: 'connector does not support unlinks',
          });
          break;
        }
        try {
          writesAttempted += 1;
          const result = await connector.unlink(op.dependent.remoteId, op.dependency.remoteId, options.signal, op.linkKind);
          if (op.linkKind === 'relates') relatesOf(op.dependent.localId).delete(op.dependency.localId);
          else edgesOf(op.dependent.localId).delete(op.dependency.localId);
          recordEdges(op.dependent.localId, result.remoteRev, now().toISOString());
          landed.push({ kind: 'unlink', localId, status: 'landed', remoteId: op.dependent.remoteId });
        } catch (error) {
          if (handleFailure('unlink', localId, error)) break outer;
        }
        break;
      }

      case 'edges': {
        // Write the dependency / relate edges into the managed block (LP-314).
        // The op carries the complete current set; a reference whose endpoint
        // did not land is omitted rather than written as a dangling local id
        // (AC #2), and the next push re-plans it once the number exists.
        const blockedBy =
          waitingOn(op.ref) ??
          waitingOn(op.parent) ??
          op.dependsOn.map(waitingOn).find((id) => id !== undefined) ??
          op.relatesTo.map(waitingOn).find((id) => id !== undefined);
        if (blockedBy !== undefined) {
          skipped.push({
            kind: 'edges',
            localId,
            status: 'skipped',
            reason: `waits on ${blockedBy}, which was not created`,
          });
          break;
        }

        const doc = board.byId.get(op.localId);
        if (!doc) {
          failed.push({
            kind: 'edges',
            localId,
            status: 'failed',
            error: `document ${op.localId} does not exist on the board`,
          });
          break;
        }

        const dependentRemoteId = resolveRef(op.ref);
        if (dependentRemoteId === undefined) {
          skipped.push({
            kind: 'edges',
            localId,
            status: 'skipped',
            reason: 'the twin was not created',
          });
          break;
        }

        // Resolve every reference to its remote id; an unresolved endpoint is
        // left out of the row.  Only the ones that resolved are recorded as
        // landed, so a partially-landed push re-plans exactly the missing ones.
        const resolveRefs = (refs: readonly RemoteRef[]): { remoteIds: string[]; localIds: string[] } => {
          const remoteIds: string[] = [];
          const localIds: string[] = [];
          for (const ref of refs) {
            const remoteId = resolveRef(ref);
            if (remoteId === undefined) continue;
            remoteIds.push(remoteId);
            localIds.push(ref.localId);
          }
          return { remoteIds, localIds };
        };

        const depends = resolveRefs(op.dependsOn);
        const relates = resolveRefs(op.relatesTo);
        const parentRemoteId = op.parent !== undefined ? resolveRef(op.parent) : undefined;

        const entries: ManagedBlockEntry[] = [];
        if (parentRemoteId !== undefined) entries.push(parentBlockEntry(parentRemoteId));
        entries.push(...degradedEntriesOf(op.localId));
        if (depends.remoteIds.length > 0) entries.push(refsEntry('depends_on', depends.remoteIds));
        if (relates.remoteIds.length > 0) entries.push(refsEntry('relates_to', relates.remoteIds));

        const block = applyManagedBlock(doc.body, entries);
        const request: RemoteRequest = { kind: 'update', body: block };
        try {
          writesAttempted += 1;
          const result = await connector.update(dependentRemoteId, request, options.signal);
          edgesOf(op.localId).clear();
          for (const local of depends.localIds) edgesOf(op.localId).add(local);
          relatesOf(op.localId).clear();
          for (const local of relates.localIds) relatesOf(op.localId).add(local);
          recordEdges(op.localId, result.remoteRev, now().toISOString());
          landed.push({ kind: 'edges', localId, status: 'landed', remoteId: dependentRemoteId });
        } catch (error) {
          if (handleFailure('edges', localId, error)) break outer;
        }
        break;
      }

      case 'reparent': {
        // Move an existing twin's parent, in place (LP-493): a local reparent
        // or a hierarchy-encoding switch. The native edge and the block's
        // `parent` row are driven to the op's stated end state — `parent` set
        // writes (or keeps) the native edge, `blockParent` set writes the row,
        // and an absent field clears that carrier. The twin keeps its remote
        // id; it is never re-created.
        const blockedBy = waitingOn(op.parent) ?? waitingOn(op.blockParent);
        if (blockedBy !== undefined) {
          skipped.push({
            kind: 'reparent',
            localId,
            status: 'skipped',
            reason: `waits on ${blockedBy}, which was not created`,
          });
          break;
        }

        const doc = board.byId.get(op.localId);
        if (!doc) {
          failed.push({
            kind: 'reparent',
            localId,
            status: 'failed',
            error: `document ${op.localId} does not exist on the board`,
          });
          break;
        }

        const parentRemoteId = op.parent !== undefined ? resolveRef(op.parent) : undefined;
        const blockParentRemoteId = op.blockParent !== undefined ? resolveRef(op.blockParent) : undefined;

        // Native half: set the native parent edge, or clear it when the
        // encoding no longer carries it. The connector's `reparent` is
        // idempotent — setting the parent an issue already has, or clearing
        // one it does not have, is a no-op — which is what makes a re-run
        // after an interrupted migration safe (AC #7).
        if (typeof connector.reparent === 'function') {
          try {
            writesAttempted += 1;
            await connector.reparent(op.ref.remoteId, parentRemoteId ?? null, options.signal);
          } catch (error) {
            if (handleFailure('reparent', localId, error)) break outer;
            break;
          }
        } else if (parentRemoteId !== undefined) {
          skipped.push({
            kind: 'reparent',
            localId,
            status: 'skipped',
            reason: 'connector cannot move an existing issue to a native parent',
          });
          break;
        }

        // Block half: rewrite the body's managed block so the `parent` row
        // matches the current encoding (set, updated, or removed), keeping the
        // degraded period levels and the edge rows that actually landed.
        try {
          writesAttempted += 1;
          const result = await connector.update(
            op.ref.remoteId,
            { kind: 'update', body: composeBody(op.localId, doc.body, blockParentRemoteId) },
            options.signal,
          );
          recordBase(op.localId, doc, result.record, result.remoteRev, now().toISOString(), result.unwritten);
          recordParent(op.localId, parentRemoteId ?? blockParentRemoteId ?? null);
          landed.push({ kind: 'reparent', localId, status: 'landed', remoteId: op.ref.remoteId });
        } catch (error) {
          if (handleFailure('reparent', localId, error)) break outer;
        }
        break;
      }

      case 'comment': {
        if (typeof connector.comment !== 'function') {
          skipped.push({
            kind: 'comment',
            localId,
            status: 'skipped',
            reason: 'connector does not support comments',
          });
          break;
        }
        const remoteId = resolveRef(op.ref);
        if (remoteId === undefined) {
          skipped.push({
            kind: 'comment',
            localId,
            status: 'skipped',
            reason: 'the twin was not created',
          });
          break;
        }
        try {
          writesAttempted += 1;
          const result = await connector.comment(remoteId, op.body, options.signal);
          // Record the remote comment id against the local comment's index, so
          // the next push never posts this comment again (LP-316).  A comment
          // whose id the connector did not return stays unrecorded and would be
          // re-posted — but GitHub and Jira both return it, and a platform that
          // cannot is a provider bug, not a reason to pretend it landed.
          if (result.commentId !== undefined) {
            setCommentId(store, op.ref.localId, op.index, result.commentId);
            saveLinkStore(board.paths, remote.name, store);
          }
          landed.push({ kind: 'comment', localId, status: 'landed', remoteId });
        } catch (error) {
          if (handleFailure('comment', localId, error)) break outer;
        }
        break;
      }

      case 'managedComment': {
        if (typeof connector.comment !== 'function' && typeof connector.editComment !== 'function' && typeof connector.deleteComment !== 'function') {
          skipped.push({
            kind: 'managedComment',
            localId,
            status: 'skipped',
            reason: 'connector does not support comments',
          });
          break;
        }

        const capability: ManagedCommentCapability =
          options.comments ?? { native: false, editable: false, deletable: false };
        const existingId = getManagedCommentId(store, op.localId);
        const action = planManagedComment(capability, existingId, op.entries.length > 0);
        const links = managedCommentLinks(store, op.links);

        switch (action.kind) {
          case 'none':
            landed.push({ kind: 'managedComment', localId, status: 'landed' });
            break;

          case 'unavailable':
            failed.push({ kind: 'managedComment', localId, status: 'failed', error: action.reason });
            break;

          case 'post': {
            if (typeof connector.comment !== 'function') {
              skipped.push({
                kind: 'managedComment',
                localId,
                status: 'skipped',
                reason: 'connector does not support comments',
              });
              break;
            }
            try {
              writesAttempted += 1;
              const result = await connector.comment(
                op.ref.remoteId,
                renderManagedComment(op.entries, links),
                options.signal,
              );
              setManagedCommentId(store, op.localId, result.commentId);
              saveLinkStore(board.paths, remote.name, store);
              landed.push({
                kind: 'managedComment',
                localId,
                status: 'landed',
                remoteId: result.commentId,
              });
            } catch (error) {
              if (handleFailure('managedComment', localId, error)) break outer;
            }
            break;
          }

          case 'edit': {
            if (typeof connector.editComment !== 'function') {
              skipped.push({
                kind: 'managedComment',
                localId,
                status: 'skipped',
                reason: 'connector cannot edit comments',
              });
              break;
            }
            try {
              writesAttempted += 1;
              await connector.editComment(
                op.ref.remoteId,
                action.commentId,
                renderManagedComment(op.entries, links),
                options.signal,
              );
              landed.push({
                kind: 'managedComment',
                localId,
                status: 'landed',
                remoteId: action.commentId,
              });
            } catch (error) {
              if (handleFailure('managedComment', localId, error)) break outer;
            }
            break;
          }

          case 'replace': {
            if (typeof connector.deleteComment !== 'function' || typeof connector.comment !== 'function') {
              skipped.push({
                kind: 'managedComment',
                localId,
                status: 'skipped',
                reason: 'connector cannot delete and repost comments',
              });
              break;
            }
            try {
              writesAttempted += 1;
              await connector.deleteComment(op.ref.remoteId, action.commentId, options.signal);
              const result = await connector.comment(
                op.ref.remoteId,
                renderManagedComment(op.entries, links),
                options.signal,
              );
              setManagedCommentId(store, op.localId, result.commentId);
              saveLinkStore(board.paths, remote.name, store);
              landed.push({
                kind: 'managedComment',
                localId,
                status: 'landed',
                remoteId: result.commentId,
              });
            } catch (error) {
              if (handleFailure('managedComment', localId, error)) break outer;
            }
            break;
          }

          case 'remove': {
            if (typeof connector.deleteComment !== 'function') {
              skipped.push({
                kind: 'managedComment',
                localId,
                status: 'skipped',
                reason: 'connector cannot delete comments',
              });
              break;
            }
            try {
              writesAttempted += 1;
              await connector.deleteComment(op.ref.remoteId, action.commentId, options.signal);
              setManagedCommentId(store, op.localId, undefined);
              saveLinkStore(board.paths, remote.name, store);
              landed.push({ kind: 'managedComment', localId, status: 'landed' });
            } catch (error) {
              if (handleFailure('managedComment', localId, error)) break outer;
            }
            break;
          }
        }
        break;
      }

      case 'unlinkLocal': {
        if (removeLink(store, op.localId)) {
          saveLinkStore(board.paths, remote.name, store);
        }
        landed.push({ kind: 'unlinkLocal', localId, status: 'landed' });
        break;
      }

      case 'decouple': {
        // Drop the link (and its base snapshot) and record a tombstone.  The
        // remote twin is never touched — decoupling is a local decision.
        decoupleLink(store, op.localId, op.reason, now().toISOString());
        saveLinkStore(board.paths, remote.name, store);
        landed.push({ kind: 'decouple', localId, status: 'landed' });
        break;
      }
    }
  }

  // Record the hierarchy encoding this run resolved (LP-493): the commit
  // marker for a switch. Written only when the run landed cleanly — no per-op
  // failure, no conflict, and no early stop — so a partially-migrated switch
  // stays detected and a re-run resumes rather than declaring victory.
  if (
    options.hierarchy !== undefined &&
    failed.length === 0 &&
    conflicted.length === 0 &&
    stop === undefined
  ) {
    store.hierarchy = recordOf(options.hierarchy);
    saveLinkStore(board.paths, remote.name, store);
  }

  return {
    landed,
    failed,
    skipped,
    conflicted,
    summary: {
      created: landed.filter((op) => op.kind === 'create' || op.kind === 'restore').length,
      updated: landed.filter((op) => op.kind !== 'create' && op.kind !== 'restore').length,
      skipped: skipped.length,
      conflicted: conflicted.length,
      failed: failed.length,
    },
    ...(stop ? { stopped: stop } : {}),
  };
}
