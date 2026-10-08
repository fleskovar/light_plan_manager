/**
 * Shape divergence — the report that answers "is the twin still the same
 * twin?" (LP-368).
 *
 * Existence is `lifecycle.ts`'s question (LP-363): is there still a twin at
 * all. Fields are `merge.ts` / `conflicts.ts`'s (LP-257): both sides exist —
 * which value wins. This file answers the question in between: the twin still
 * exists, but does it still *mean* the same thing? A remote reparent, a remote
 * retype, or a move out of the remote's scope is a correspondence that
 * survives while its shape does not, and none of them may silently reshape the
 * local tree.
 *
 * ## Pure by construction
 *
 * `resolveShapeDivergence` is pure: board, links and a fetched remote snapshot
 * in, a report out. No disk, no network — the fetched records arrive in
 * `remote.issues`, exactly as `resolveLifecycle` and `planPull` take them. The
 * two provider seams it needs (`parentIdOf`, `typeOf`) are callbacks, so the
 * resolver never learns a provider's vocabulary.
 *
 * ## Report, never apply
 *
 * The report is the deliverable. A legal reshape is *offered* as a plan —
 * planned through `planReparent` / `planConvert` from `src/shared/plans/` (the
 * same move / convert operations the CLI and the web canvas run, so a remote
 * reshape is never re-derived as raw folder writes) — but nothing here writes a
 * folder or returns a `Change[]` to be applied. A caller that wants to apply an
 * offered plan does so through the ordinary operations; this file only says
 * which plans would be legal and which rule the others break.
 *
 * ## The base records shape, so "both moved" is detectable
 *
 * A remote reparent is reported when the remote parent differs from the local
 * one. To tell *who* moved — and therefore to report the `conflicted` case
 * where both sides moved the same document to different parents — the base
 * snapshot records `parent` and `type` alongside the mapped fields. The
 * executor (`execute.ts`) and adoption (`adopt.ts`) write them; this resolver
 * only reads them, and a base that does not record them is "no agreed shape",
 * which can never be called `conflicted` — the honest fallback is to report the
 * remote side and move nothing.
 *
 * ## Scope exit is not deletion
 *
 * A linked twin whose remote parent names an issue with no local twin has left
 * the remote's scope (moved project, closed milestone). That is reported as a
 * parent divergence with an unmappable remote parent — a scope exit — never as
 * an absence, and never as a deletion. The deleted / unreachable / out-of-scope
 * distinction for a *vanished* twin is `lifecycle.ts`'s (LP-364); this file
 * only sees twins that are still present in the fetched listing.
 */

import type { Change } from '../shared/changes.js';
import type { IssueDto } from '../shared/model.js';
import type { Plan } from '../shared/plans/breakdown.js';
import type { BoardView } from '../shared/plans/reading.js';
import { subtreeIds } from '../shared/plans/reading.js';
import { planConvert, planReparent } from '../shared/plans/reparent.js';
import { getTombstone } from './links.js';
import type { LinkStore } from './links.js';
import type { BoardTypeResolution, TypeResolutionFailure } from './mapping.js';
import type { RemoteSnapshot } from './plan.js';
import type { RemoteRecord } from './provider.js';

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

/** What the report says about one axis of divergence. */
export type ShapeVerdict =
  /** The remote reshape is legal; `plan` carries the move / convert changes. */
  | 'applicable'
  /** The remote reshape breaks a named rule; nothing can be applied as-is. */
  | 'unapplicable'
  /** Both sides moved the document to different shapes; neither side moves. */
  | 'conflicted';

/** A remote reparent, mapped back to the local tree and assessed. */
export interface ParentDivergence {
  /** The local parent id, `null` at the root. */
  local: string | null;
  /**
   * The remote parent, mapped to the local id it names. `null` is the remote
   * root; `undefined` means the remote parent has no local twin — a scope exit.
   */
  remote: string | null | undefined;
  /** The last-agreed parent id, when the base snapshot records one. */
  base?: string | null;
  verdict: ShapeVerdict;
  /** The move / convert changes that would apply it, when `applicable`. */
  plan?: Change[];
  /** The named rule that forbids it, when `unapplicable`. */
  reason?: string;
}

/** A remote retype, mapped back through the type mapping and assessed. */
export interface TypeDivergence {
  /** The local board type. */
  local: string;
  /** The remote type mapped back to a board type; absent when it has none. */
  remote?: string;
  /**
   * Why the remote type has no single board counterpart: `unmapped` (no
   * counterpart), `depth` (counterpart not legal here) or `ambiguous` (several).
   */
  unresolved?: TypeResolutionFailure;
  /** Every board type the mapping matched, for the report. */
  candidates: string[];
  verdict: ShapeVerdict;
  /** The convert changes that would apply it, when `applicable`. */
  plan?: Change[];
  /** The named rule that forbids it, when `unapplicable`. */
  reason?: string;
}

/** One linked document whose twin still exists but changed shape. */
export interface ShapeDivergenceEntry {
  localId: string;
  remoteId: string;
  /** Human-readable remote key, carried from the link store. */
  remoteKey: string;
  /** Present when the remote reparented the document. */
  parent?: ParentDivergence;
  /** Present when the remote retyped the document. */
  type?: TypeDivergence;
}

/** What `resolveShapeDivergence` returns: one entry per diverged document. */
export interface ShapeDivergenceReport {
  entries: ShapeDivergenceEntry[];
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** The two provider seams the resolver needs, both pure callbacks. */
export interface ShapeOptions {
  /**
   * Reads the remote id of a record's parent, for providers that hold a native
   * hierarchy. Omit it for a flat remote (GitHub's sub-issues aside) and the
   * parent axis is not assessed.
   */
  parentIdOf?: (record: RemoteRecord) => string | undefined;
  /**
   * Maps a remote record back to a board type, at the document's depth — the
   * `mapTypeFromRemote` result (`mapping.ts`). Omit it for a remote with no
   * type mapping and the type axis is not assessed.
   */
  typeOf?: (record: RemoteRecord, depth: number) => BoardTypeResolution;
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Report shape divergence for every linked, in-scope document whose twin is
 * still present in the fetched listing.
 *
 * Pure: no disk, no network. A vanished twin is not this file's — the lifecycle
 * resolver (LP-364) classifies absence; a twin that is still present but points
 * somewhere new is exactly the case this file reports. The local tree is never
 * modified: the report only says what diverged, whether it would be legal to
 * follow, and — when it would — what plan a caller could apply.
 */
export function resolveShapeDivergence(
  board: BoardView,
  links: LinkStore,
  remote: RemoteSnapshot,
  options: ShapeOptions = {},
): ShapeDivergenceReport {
  if (remote.direction === 'push') return { entries: [] };

  const scopeSet = remote.scope ? new Set(subtreeIds(board, remote.scope)) : null;
  const entries: ShapeDivergenceEntry[] = [];

  for (const [localId, link] of [...links.links.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const node = board.nodes[localId];
    if (node === undefined || node.kind !== 'issue') continue;
    if (getTombstone(links, localId) !== undefined) continue;
    if (scopeSet !== null && !scopeSet.has(localId)) continue;
    if (!remote.issues.has(link.remoteId)) continue; // absence is lifecycle's

    const record = remote.issues.get(link.remoteId)!;

    const baseParent =
      link.base !== undefined && 'parent' in link.base
        ? { has: true as const, value: parentOfBase(link.base['parent']) }
        : { has: false as const, value: null as string | null };
    const baseType =
      link.base !== undefined && 'type' in link.base
        ? { has: true as const, value: typeof link.base['type'] === 'string' ? link.base['type'] : '' }
        : { has: false as const, value: '' };

    const parent =
      options.parentIdOf !== undefined
        ? assessParent(board, links, record, node, baseParent, options)
        : undefined;
    const type =
      options.typeOf !== undefined
        ? assessType(board, node, options.typeOf(record, node.depth), baseType)
        : undefined;

    if (parent === undefined && type === undefined) continue;

    entries.push({
      localId,
      remoteId: link.remoteId,
      remoteKey: link.remoteKey || link.remoteId,
      ...(parent !== undefined ? { parent } : {}),
      ...(type !== undefined ? { type } : {}),
    });
  }

  return { entries };
}

/** Read a base's stored parent id, tolerating any shape a hand edit produced. */
function parentOfBase(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

// ---------------------------------------------------------------------------
// Parent axis
// ---------------------------------------------------------------------------

/**
 * Assess the parent axis for one linked document. Returns undefined when the
 * two sides agree or when only the local side moved (that is push territory,
 * LP-280's ordering — this story is about what comes back down).
 */
function assessParent(
  board: BoardView,
  links: LinkStore,
  record: RemoteRecord,
  issue: IssueDto,
  base: { has: boolean; value: string | null },
  options: ShapeOptions,
): ParentDivergence | undefined {
  const remoteParentId = options.parentIdOf!(record);
  const localParent = issue.parentId ?? null;

  // Remote root → null; a remote parent id with no local twin → undefined.
  const remoteParent =
    remoteParentId === undefined ? null : (links.byRemote.get(remoteParentId) ?? undefined);

  if (remoteParent === localParent) return undefined;

  // Both sides moved the same document to different parents — neither wins.
  if (
    base.has &&
    localParent !== base.value &&
    remoteParent !== undefined &&
    remoteParent !== base.value
  ) {
    return { local: localParent, remote: remoteParent, base: base.value, verdict: 'conflicted' };
  }

  // Only the local side moved (remote still matches the agreed parent): a
  // local reparent is pushed up, not pulled down. Not this story's to report.
  if (base.has && localParent !== base.value && remoteParent === base.value) {
    return undefined;
  }

  // A remote parent with no local twin is a scope exit, never a deletion and
  // never an applicable move — there is no local document to move under.
  if (remoteParent === undefined) {
    return {
      local: localParent,
      remote: undefined,
      ...(base.has ? { base: base.value } : {}),
      verdict: 'unapplicable',
      reason: "the remote parent has no local twin — the issue left the remote's scope",
    };
  }

  // A remote reparent: offer it as a move when the hierarchy allows, otherwise
  // name the rule that forbids it. `planReparent` is the existing move/convert
  // operation, so a legal reshape is planned exactly as a human drag would be.
  const plan = planReparent(board, issue.id, remoteParent);
  if (plan.ok) {
    return {
      local: localParent,
      remote: remoteParent,
      ...(base.has ? { base: base.value } : {}),
      verdict: 'applicable',
      plan: plan.changes,
    };
  }
  return {
    local: localParent,
    remote: remoteParent,
    ...(base.has ? { base: base.value } : {}),
    verdict: 'unapplicable',
    reason: plan.error,
  };
}

// ---------------------------------------------------------------------------
// Type axis
// ---------------------------------------------------------------------------

/** The human-readable rule behind a failed type resolution. */
function typeFailureReason(unresolved: TypeResolutionFailure): string {
  switch (unresolved) {
    case 'unmapped':
      return 'the remote type has no board counterpart — refusing to default it';
    case 'depth':
      return 'the remote type is not legal at this depth';
    case 'ambiguous':
      return 'the remote type maps to several board types';
  }
}

/**
 * Assess the type axis for one linked document. Returns undefined when the two
 * sides agree. A type with no single board counterpart is reported rather than
 * defaulted; a type that resolves to a different board type is offered as a
 * convert (`planConvert`, the existing operation).
 */
function assessType(
  board: BoardView,
  issue: IssueDto,
  resolution: BoardTypeResolution,
  base: { has: boolean; value: string },
): TypeDivergence | undefined {
  if (resolution.type === undefined || resolution.unresolved !== undefined) {
    return {
      local: issue.type,
      candidates: resolution.candidates,
      unresolved: resolution.unresolved ?? 'unmapped',
      verdict: 'unapplicable',
      reason: typeFailureReason(resolution.unresolved ?? 'unmapped'),
    };
  }

  if (resolution.type === issue.type) return undefined;

  const plan = planConvert(board, issue.id, resolution.type);
  if (plan.ok) {
    return {
      local: issue.type,
      remote: resolution.type,
      candidates: resolution.candidates,
      verdict: 'applicable',
      plan: plan.changes,
    };
  }
  return {
    local: issue.type,
    remote: resolution.type,
    candidates: resolution.candidates,
    verdict: 'unapplicable',
    reason: plan.error,
  };
}
