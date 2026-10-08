/**
 * Link lifecycle — the state of each correspondence, and whether it still
 * exists at all (LP-363).
 *
 * A link between a local document and a remote issue is not a boolean; it is a
 * state.  The remote side can be deleted, moved, converted or hidden from view
 * at any moment, and light-plan finds out on the next pull, after the fact.  So
 * this file is the resolver that names the state: given the board, the link
 * store and the remote issues that were fetched, it reports exactly one state
 * per in-scope correspondence:
 *
 *   linked      both sides exist and correspond
 *   local_only  an in-scope document that has never been pushed
 *   remote_only an in-scope remote issue with no local document — adoptable
 *   orphaned    a link one side of which is gone; `side` says which
 *   decoupled   a human dropped the link on purpose; never re-filed
 *   conflicted  two sides disagree about existence, and a human must choose
 *
 * ## Pure by construction
 *
 * The resolver is a pure function: board in, links in, remote issues in, states
 * out.  It reads no disk and makes no request, so the whole state table is
 * testable from literals and a dry-run is the same code path as a real sync.
 *
 * ## Derived, never stored — except `decoupled`
 *
 * Every state is derived from the three inputs, except `decoupled`.  Whether a
 * human once said "forget the remote twin" is a fact, not a computation, so it
 * lives in the link store as a tombstone (`links.ts`, written by LP-366; this
 * resolver only reads it).  Deriving it would be guessing, and guessing re-files
 * a document a human deliberately cut loose.
 *
 * ## The two directions of `orphaned`
 *
 * A link whose local document is gone is our own doing and safe to reason
 * about: somebody deleted the document, and the remote twin is simply
 * unanchored.  A link whose remote twin is absent from the fetched set is a
 * different matter — it may be deleted, moved, archived, or hidden by a
 * credential that lost scope — and LP-364 tells those apart: a remote-side
 * orphan carries an `absence` of `deleted`, `unreachable` or `out_of_scope`,
 * each with the `evidence` behind it, and a run that is unreachable as a whole
 * sets `runUnreachable` so the caller writes nothing.  The resolver records
 * both directions under one `orphaned` state with a `side` that keeps them
 * distinct.
 *
 * ## Scope
 *
 * A document outside the remote's `scope:` subtree is not reported in any state
 * — it is somebody else's board.  A linked document that moved out of scope is
 * likewise silent here; LP-366 turns that into a tombstone with reason
 * `out_of_scope`.  A fetched remote issue is "in scope" when its remote-parent
 * chain anchors at a linked local document inside the subtree; that anchor walk
 * mirrors `planPull`'s and must stay in step with it.
 *
 * ## Out of scope for this story
 *
 * Acting on a state is not this story's.  LP-365 resolves orphaned twins,
 * LP-366 writes tombstones, LP-367 adopts `remote_only` issues, and LP-368
 * reports shape divergence (a remote reparent or retype) — the other way a
 * correspondence reaches `conflicted`.  The planners consume this report; this
 * file only names states.
 */

import type { BoardView } from '../shared/plans/reading.js';
import { subtreeIds } from '../shared/plans/reading.js';
import type { IssueDto } from '../shared/model.js';
import { getTombstone } from './links.js';
import type { LinkEntry, LinkStore } from './links.js';
import type { RemoteSnapshot } from './plan.js';
import type { ReachabilityResult, RemoteRecord } from './provider.js';

/** The six lifecycle states a correspondence can be in. */
export type LifecycleState =
  | 'linked'
  | 'local_only'
  | 'remote_only'
  | 'orphaned'
  | 'decoupled'
  | 'conflicted';

/** Which side of a broken link is gone. */
export type OrphanedSide = 'local' | 'remote';

/**
 * Why a linked remote twin is absent from the fetched listing (LP-364). Three
 * answers, and they are never conflated: `deleted` means the twin is genuinely
 * gone; `unreachable` means the remote could not be seen (or the run declined
 * to decide); `out_of_scope` means the twin exists but left the configured
 * scope (moved project, closed milestone, transferred repo).
 */
export type RemoteAbsence = 'deleted' | 'unreachable' | 'out_of_scope';

/**
 * What a direct read of one absent twin saw — the caller already fetched this
 * (the resolver itself makes no request). `not_found` is a 404/410; `found`
 * means the twin exists but is not in the scoped listing, which is
 * `out_of_scope`, never `deleted`; `error` means the read failed, which cannot
 * prove a deletion. Each carries its own evidence, so a surprising
 * classification can be argued with.
 */
export type TwinRead =
  | { kind: 'not_found'; evidence: string }
  | { kind: 'found'; evidence: string }
  | { kind: 'error'; evidence: string };

/**
 * The bulk guard's default: a run where more than half the linked twins are
 * missing at once is treated as unreachable. Real deletions arrive a few at a
 * time; infrastructure failures arrive all at once. Set `bulk_guard` in the
 * remote's config to move it (1 disables the guard — a fraction never exceeds 1).
 */
export const DEFAULT_BULK_GUARD = 0.5;

/** One correspondence's state, as the resolver reports it. */
export interface LifecycleEntry {
  state: LifecycleState;
  /** The local document id, when there is (or was) one. */
  localId?: string;
  /** The remote issue id, when there is (or was) one. */
  remoteId?: string;
  /** Human-readable remote key, carried from the link store when present. */
  remoteKey?: string;
  /** Full URL to the remote issue, carried from the link store when present. */
  remoteUrl?: string;
  /** Which side is missing; present only when `state` is `orphaned`. */
  side?: OrphanedSide;
  /**
   * Why the remote twin is absent; present only when `state` is `orphaned` and
   * `side` is `remote` (LP-364). `deleted`, `unreachable` or `out_of_scope`.
   */
  absence?: RemoteAbsence;
  /** The evidence behind `absence` — the request and answer that produced it. */
  evidence?: string;
  /** Why the document was decoupled; present only when `state` is `decoupled`. */
  reason?: string;
}

/** What `resolveLifecycle` returns: one entry per in-scope correspondence. */
export interface LifecycleReport {
  entries: LifecycleEntry[];
  /**
   * True when the run as a whole is unreachable — the remote's own probe failed
   * or the bulk guard tripped — and therefore nothing may be written to either
   * side. A caller that writes anyway would be turning an expired credential
   * into a wave of deletions (LP-364).
   */
  runUnreachable: boolean;
  /** Why the run is unreachable, when it is — the evidence behind the verdict. */
  runUnreachableReason?: string;
}

/**
 * The one seam the resolver needs beyond the board, links and remote issues:
 * reading a record's remote parent id, for providers that hold a native
 * hierarchy.  Omit it (or return undefined) for a flat remote, and unlinked
 * remote issues with no remote parent are unanchored — which, for a scoped
 * remote, means out of scope.
 */
export interface LifecycleOptions {
  parentIdOf?: (record: RemoteRecord) => string | undefined;
  /**
   * The reachability probe's answer, when the caller ran it. A failed probe
   * makes the whole run unreachable — no twin is classified `deleted`.
   */
  reachability?: ReachabilityResult;
  /**
   * A direct read of one absent twin, when the caller performed one. Absent
   * means the run has no per-twin evidence, so a missing twin is classified
   * conservatively (`unreachable`) rather than `deleted`.
   */
  readOf?: (remoteId: string) => TwinRead | undefined;
  /**
   * The bulk guard fraction: a run where more than this fraction of linked
   * twins is missing at once is `unreachable` regardless of individual reads.
   * Defaults to {@link DEFAULT_BULK_GUARD}.
   */
  bulkGuard?: number;
}

/**
 * Classify every in-scope correspondence into exactly one lifecycle state.
 *
 * Pure: no disk, no network.  `remote.issues` is the listing the caller already
 * fetched (remote id → raw record); for a `direction: push` remote nothing is
 * fetched, so the remote side is not assessed — linked documents stay `linked`,
 * and neither `remote_only` nor a remote-side `orphaned` is reported.
 */
export function resolveLifecycle(
  board: BoardView,
  links: LinkStore,
  remote: RemoteSnapshot,
  options: LifecycleOptions = {},
): LifecycleReport {
  const scopeSet = remote.scope ? new Set(subtreeIds(board, remote.scope)) : null;
  // Absence is only evidence when the listing was exhaustive. A pull that
  // fetched the two issues somebody named (`remote.partial`) says nothing
  // about the other two hundred, so no twin is assessed against it — without
  // this, a targeted pull on a mirrored board reads every other twin as
  // deleted and the bulk guard (correctly) refuses the whole run.
  const assessRemote = remote.direction !== 'push' && remote.partial !== true;
  const entries: LifecycleEntry[] = [];

  // -- remote ids claimed by more than one live local document ---------------
  // A one-to-many correspondence is an existence disagreement: two documents
  // claim one twin, and neither classification is safe.  Marked `conflicted`;
  // LP-367 refuses to create such a link, but a hand-edited or merge-mangled
  // store can still hold one.  Only live documents count — a link whose local
  // document is gone is an orphaned link, not a claimant.
  const claimants = new Map<string, string[]>();
  for (const [localId, entry] of links.links) {
    const node = board.nodes[localId];
    if (node === undefined || node.kind !== 'issue') continue;
    const ids = claimants.get(entry.remoteId);
    if (ids) ids.push(localId);
    else claimants.set(entry.remoteId, [localId]);
  }
  const collided = new Set<string>();
  for (const ids of claimants.values()) {
    if (ids.length > 1) for (const id of ids) collided.add(id);
  }

  // -- local documents in scope ----------------------------------------------
  const localIssues = Object.values(board.nodes)
    .filter((node): node is IssueDto => node.kind === 'issue')
    .filter((issue) => scopeSet === null || scopeSet.has(issue.id))
    .sort((a, b) => a.id.localeCompare(b.id));

  // -- LP-364: why a remote twin is absent -----------------------------------
  // A linked twin absent from the fetched listing may be deleted, moved out of
  // scope, or hidden by a credential that lost access.  Those three are never
  // conflated: first the reachability probe (the whole remote cannot be seen),
  // then the bulk guard (too many vanished at once to be deletions), then the
  // per-twin read (a 404 proves deletion, a live twin proves out-of-scope).
  const reachability = options.reachability;
  const readOf = options.readOf;
  const bulkGuard = options.bulkGuard ?? DEFAULT_BULK_GUARD;

  // The denominator and numerator the bulk guard counts: live, in-scope,
  // non-tombstoned, non-collided linked documents, and the subset whose twin
  // is absent from the listing.
  const missingIds: string[] = [];
  let linkedTotal = 0;
  if (assessRemote) {
    for (const issue of localIssues) {
      if (getTombstone(links, issue.id) !== undefined) continue;
      const link = links.links.get(issue.id);
      if (link === undefined || collided.has(issue.id)) continue;
      linkedTotal += 1;
      if (!remote.issues.has(link.remoteId)) missingIds.push(issue.id);
    }
  }

  let runUnreachable = false;
  let runUnreachableReason: string | undefined;
  if (assessRemote && reachability !== undefined && !reachability.reachable) {
    runUnreachable = true;
    runUnreachableReason = reachability.evidence;
  } else if (assessRemote && linkedTotal > 0 && missingIds.length / linkedTotal > bulkGuard) {
    runUnreachable = true;
    runUnreachableReason =
      `bulk guard: ${missingIds.length} of ${linkedTotal} linked twins are missing ` +
      `(threshold ${bulkGuard}) — declined to treat them as deletions`;
  }

  for (const issue of localIssues) {
    const tombstone = getTombstone(links, issue.id);
    if (tombstone !== undefined) {
      // A human decision outranks everything else: never linked, never
      // local_only, never re-filed, whatever either side now looks like.
      entries.push({
        state: 'decoupled',
        localId: issue.id,
        remoteKey: tombstone.remoteKey || undefined,
        reason: tombstone.reason || undefined,
      });
      continue;
    }

    const link = links.links.get(issue.id);
    if (link === undefined) {
      entries.push({ state: 'local_only', localId: issue.id });
      continue;
    }

    if (collided.has(issue.id)) {
      entries.push(linkEntry('conflicted', issue.id, link));
      continue;
    }

    if (!assessRemote || remote.issues.has(link.remoteId)) {
      entries.push(linkEntry('linked', issue.id, link));
    } else {
      entries.push(classifyAbsent(issue.id, link, runUnreachable, runUnreachableReason, readOf));
    }
  }

  // -- links whose local document no longer exists ---------------------------
  const orphanedLocal: LifecycleEntry[] = [];
  for (const [localId, link] of links.links) {
    const node = board.nodes[localId];
    if (node !== undefined && node.kind === 'issue') continue; // handled above or out of scope
    orphanedLocal.push({ ...linkEntry('orphaned', localId, link), side: 'local' });
  }
  orphanedLocal.sort((a, b) => a.localId!.localeCompare(b.localId!));
  entries.push(...orphanedLocal);

  // -- remote issues in scope with no local document -------------------------
  if (assessRemote) {
    // Anchor a remote issue in the local tree: its own twin when it has one,
    // otherwise the anchor of its remote parent.  Mirrors `planPull`'s
    // `anchorOf`; a change to one must follow the other.
    const anchorMemo = new Map<string, string | undefined>();
    const anchorOf = (remoteId: string): string | undefined => {
      if (anchorMemo.has(remoteId)) return anchorMemo.get(remoteId);
      anchorMemo.set(remoteId, undefined); // cycle guard
      const linked = links.byRemote.get(remoteId);
      if (linked !== undefined) {
        anchorMemo.set(remoteId, linked);
        return linked;
      }
      const record = remote.issues.get(remoteId);
      const parentRemote = record && options.parentIdOf ? options.parentIdOf(record) : undefined;
      if (parentRemote) {
        const anchored = anchorOf(parentRemote);
        anchorMemo.set(remoteId, anchored);
        return anchored;
      }
      return undefined;
    };
    const inScopeRemote = (remoteId: string): boolean => {
      if (scopeSet === null) return true;
      const anchored = anchorOf(remoteId);
      return anchored !== undefined && scopeSet.has(anchored);
    };

    const remoteOnly = [...remote.issues.keys()]
      .filter((remoteId) => !links.byRemote.has(remoteId) && inScopeRemote(remoteId))
      .sort((a, b) => a.localeCompare(b))
      .map((remoteId) => ({ state: 'remote_only' as const, remoteId }));
    entries.push(...remoteOnly);
  }

  return {
    entries,
    runUnreachable,
    ...(runUnreachableReason === undefined ? {} : { runUnreachableReason }),
  };
}

/**
 * Classify one linked, in-scope document whose twin is absent from the fetched
 * listing.  A run already judged unreachable (probe or bulk) overrides every
 * per-twin read; otherwise the direct read decides: a 404 is `deleted`, a live
 * twin is `out_of_scope`, anything else is `unreachable`.
 */
function classifyAbsent(
  localId: string,
  link: LinkEntry,
  runUnreachable: boolean,
  runUnreachableReason: string | undefined,
  readOf: ((remoteId: string) => TwinRead | undefined) | undefined,
): LifecycleEntry {
  const base = { ...linkEntry('orphaned', localId, link), side: 'remote' as const };
  if (runUnreachable) {
    return { ...base, absence: 'unreachable', evidence: runUnreachableReason };
  }
  const read = readOf ? readOf(link.remoteId) : undefined;
  if (read === undefined) {
    return {
      ...base,
      absence: 'unreachable',
      evidence: 'no reachability signal and no direct read of the twin',
    };
  }
  switch (read.kind) {
    case 'not_found':
      return { ...base, absence: 'deleted', evidence: read.evidence };
    case 'found':
      return { ...base, absence: 'out_of_scope', evidence: read.evidence };
    case 'error':
      return { ...base, absence: 'unreachable', evidence: read.evidence };
  }
}

/** Build an entry that carries a link's remote identity. */
function linkEntry(
  state: LifecycleState,
  localId: string,
  link: LinkEntry,
): LifecycleEntry {
  return {
    state,
    localId,
    remoteId: link.remoteId,
    remoteKey: link.remoteKey || undefined,
    remoteUrl: link.remoteUrl || undefined,
  };
}
