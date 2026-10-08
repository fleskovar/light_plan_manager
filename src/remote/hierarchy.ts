/**
 * Hierarchy encoding — how a board's issue tree survives a flat or shallow
 * tracker (LP-309).
 *
 * Two encodings, one board:
 *
 *   - `sub-issues` — the remote's native parent edge (GitHub's sub-issues),
 *     for the levels the account supports (one native parent level on GitHub);
 *   - `labels`      — the type label plus the parent id in the managed block,
 *     everywhere the native edge is not available.
 *
 * Which encoding a remote gets is decided per remote, at runtime, from the
 * *resolved* capability table (`hierarchyDepth`) and an optional forced choice
 * (`--hierarchy sub-issues|labels`).  The module is pure: capabilities +
 * hierarchy + option in, an encoding out — never an API version constant.
 *
 * The parent axis is the only thing this module owns.  The *type* axis is the
 * mapping's business (`mapping.ts`): a `lpm:epic` label is written and read by
 * the translator whatever the encoding, and this module's `labels` kind means
 * only "the parent rides the managed block, not a native edge".
 *
 * LP-493 adds the switch detection this module was missing: `HierarchyRecord`
 * is the two fields a remote records after a successful sync, and
 * `carrierChanged` answers "would this depth ride a different carrier under
 * the newly resolved encoding?" — the signal `planPush` turns into a
 * `reparent` op rather than a stale carrier left behind.
 */

import type { ResolvedCapabilities } from './capabilities.js';
import { degradedHierarchyLevels, type DegradedLevel } from './mapping.js';
import { parseManagedBlock, parseManagedId } from './managed-block.js';

// ---------------------------------------------------------------------------
// The encoding
// ---------------------------------------------------------------------------

/** The two spellings of the hierarchy decision. */
export type HierarchyEncoding = 'sub-issues' | 'labels';

/**
 * Which end of the board a remote's native parent chain is spent on.
 *
 * `root` gives the native edge to the *shallowest* levels: a programme's epics
 * nest natively and the work below degrades. That is right for a tracker whose
 * parent edge is type-blind — GitHub's sub-issues hold any issue under any
 * issue, so the only question is how deep it goes. It is the default and the
 * historical behaviour.
 *
 * `leaf` gives it to the *deepest*: the work items nest under their container
 * and everything above degrades. That is right for a tracker whose hierarchy is
 * defined from the bottom up — Jira's is (`Subtask` < standard < `Epic`), and
 * only a standard issue may sit under an Epic. Spending the chain at the root
 * there puts it exactly where Jira refuses it: a board with three levels above
 * its stories maps them all onto `Epic`, `Epic` may not sit under `Epic`, so
 * every native edge is rejected — while the one relationship Jira *would* hold,
 * the work item under its container, rides the block and the tracker shows a
 * flat list.
 */
export type HierarchyAnchor = 'root' | 'leaf';

/** The field name the degraded parent's remote id rides under in the block. */
export const PARENT_FIELD = 'parent';

/**
 * One remote's resolved hierarchy encoding: which kind it is, how many levels
 * nest natively (root = level 1), and which levels' parent therefore rides the
 * managed block.
 */
export interface ResolvedHierarchy {
  kind: HierarchyEncoding;
  /** Levels that nest natively, counting the root: 1 for labels, `hierarchyDepth + 1` for sub-issues. */
  nativeDepth: number;
  /** Which end of the board the native chain is spent on. */
  anchor: HierarchyAnchor;
  /** Shallowest depth whose parent edge is native (a root document has none). */
  nativeFrom: number;
  /** Deepest depth whose parent edge is native. */
  nativeTo: number;
  /** Levels whose parent is carried in the block. */
  degraded: DegradedLevel[];
}

/**
 * The hierarchy encoding a remote last used (LP-493): the two fields that
 * decide which carrier a parent rides. Recorded beside the links after a
 * successful sync, so the next sync can detect a switch — a plan gaining the
 * sub-issue API, or a forced `--hierarchy` — and migrate each twin in place
 * rather than leaving a stale carrier behind. `degraded` is derived, never
 * stored.
 */
export interface HierarchyRecord {
  kind: HierarchyEncoding;
  nativeDepth: number;
  /**
   * The anchor the last sync used. Absent on a record written before anchors
   * existed, which reads as `root` — the behaviour those twins were filed
   * under — so nothing migrates until the resolved anchor genuinely differs.
   */
  anchor?: HierarchyAnchor;
}

/** The `HierarchyRecord` a resolved encoding records. */
export function recordOf(resolved: ResolvedHierarchy): HierarchyRecord {
  return { kind: resolved.kind, nativeDepth: resolved.nativeDepth, anchor: resolved.anchor };
}

/**
 * True when a document at `depth` (ancestor count, root = 0) would ride a
 * different parent carrier under `resolved` than it did under `recorded`.
 * Absent `recorded` (the first sync, or a store predating LP-493) or absent
 * `resolved` answers false — there is nothing known to migrate.
 */
export function carrierChanged(
  recorded: HierarchyRecord | undefined,
  resolved: ResolvedHierarchy | undefined,
  depth: number,
): boolean {
  if (recorded === undefined || resolved === undefined) return false;
  // The recorded shape carries a count and (since anchors) an end; rebuilding
  // the span it implied is what lets a *changed anchor* migrate each twin in
  // place rather than leaving half the board parented the old way.
  const wasAnchor = recorded.anchor ?? 'root';
  const deepest = Math.max(resolved.nativeFrom - 1, 0) + (resolved.nativeTo - resolved.nativeFrom) + 1;
  const span = Math.max(recorded.nativeDepth - 1, 0);
  const was =
    wasAnchor === 'leaf'
      ? { nativeFrom: Math.max(1, deepest - span + 1), nativeTo: deepest }
      : { nativeFrom: 1, nativeTo: span };
  const wasNative = depth >= was.nativeFrom && depth <= was.nativeTo;
  return wasNative !== parentIsNative(depth, resolved);
}

/** The forced-choice option `--hierarchy` maps onto. */
export interface HierarchyOptions {
  /** Force one encoding, overriding capability detection. */
  force?: HierarchyEncoding;
}

/**
 * Resolve the hierarchy encoding for one remote.
 *
 * With no forced choice the capability decides: a remote that holds at least
 * one native parent level is `sub-issues`, a flat one `labels`.  `force`
 * overrides that — a user who wants the same behaviour across accounts pins it
 * (`labels` on a secondary account without sub-issues, or `sub-issues` on an
 * account where the probe would otherwise read "flat").
 */
export function resolveHierarchyEncoding(
  capabilities: Pick<ResolvedCapabilities, 'hierarchyDepth' | 'hierarchyAnchor'>,
  hierarchy: string[][],
  options: HierarchyOptions = {},
): ResolvedHierarchy {
  const depth = capabilities.hierarchyDepth;
  const kind: HierarchyEncoding = options.force ?? (depth >= 1 ? 'sub-issues' : 'labels');
  // `labels` never nests. `sub-issues` nests to the capability's depth; a
  // forced `sub-issues` over a probe that read "flat" assumes one native
  // level — the caller is asserting the account has the API.
  const nativeDepth = kind === 'labels' ? 1 : depth >= 1 ? depth + 1 : 2;
  const anchor: HierarchyAnchor = capabilities.hierarchyAnchor ?? 'root';

  // Which depths' *parent edge* is native. Root-anchored, the chain starts at
  // the first level below the root; leaf-anchored, it ends at the deepest level
  // the board has, so the work items are what nest.
  const deepest = Math.max(hierarchy.length - 1, 0);
  const span = Math.max(nativeDepth - 1, 0);
  const nativeFrom = anchor === 'leaf' ? Math.max(1, deepest - span + 1) : 1;
  const nativeTo = anchor === 'leaf' ? deepest : span;

  const degraded: DegradedLevel[] = [];
  for (let level = 1; level < hierarchy.length; level += 1) {
    if (level >= nativeFrom && level <= nativeTo) continue;
    const types = hierarchy[level] ?? [];
    if (types.length > 0) degraded.push({ depth: level, types: [...types] });
  }

  return { kind, nativeDepth, anchor, nativeFrom, nativeTo, degraded };
}

/**
 * True when a document at `depth` (ancestor count, root = 0) files under a
 * native parent edge.  A document at depth 0 has no parent at all; the native
 * edge covers depths 1 .. `nativeDepth - 1` — exactly one level of sub-issues
 * (nativeDepth 2) leaves depth 2 and below to the block.
 */
export function parentIsNative(depth: number, resolved: ResolvedHierarchy): boolean {
  return depth >= resolved.nativeFrom && depth <= resolved.nativeTo;
}

// ---------------------------------------------------------------------------
// The block carrier (the `labels` encoding's parent)
// ---------------------------------------------------------------------------

/**
 * Build the managed-block entry carrying the degraded parent's **remote** id.
 *
 * The value is the remote id, not the local one, deliberately: the block must
 * round-trip across boards.  A fresh checkout pulling this remote has never
 * seen the local id, but it resolves the remote id through the link store
 * exactly as it resolves a native sub-issue parent.  It is a `text` entry
 * rather than an `id` link so the cell stays a plain token either way.
 */
export function parentBlockEntry(parentRemoteId: string): {
  name: string;
  kind: 'text';
  value: string;
} {
  return { name: PARENT_FIELD, kind: 'text', value: parentRemoteId };
}

/**
 * Read the degraded parent's remote id back out of a remote body.  Returns
 * `undefined` when the body carries no managed block, when the block carries
 * no `parent` row, or when a human left the cell empty — the caller then
 * treats the issue as filed at the remote root.
 */
export function parentRemoteIdFromBlock(body: string): string | undefined {
  const parsed = parseManagedBlock(body);
  if (!parsed.found) return undefined;
  const cell = parsed.fields[PARENT_FIELD];
  if (cell === undefined || cell === '') return undefined;
  return parseManagedId(cell);
}
