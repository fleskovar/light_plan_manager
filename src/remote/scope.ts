/**
 * Remote scope — which subtree of the board a remote mirrors.
 *
 * Scope is a single id (`scope: LP-2` in the remote's declaration) naming the
 * root of the mirrored subtree. Everything *inside* that subtree is the
 * remote's; everything outside it is somebody else's. No `scope` means the
 * whole board is in scope.
 *
 * Scope is evaluated against the **current** tree, never the link store. That
 * is deliberate and needs saying out loud: reparenting an issue changes which
 * remote owns it. A link whose document has moved out of scope is *out of
 * scope*, not deleted — the two are different outcomes with different
 * resolutions (the remote's `on_delete` policy applies to the first; the link
 * lifecycle to the second), and both are found by asking "is this document
 * still in the subtree?" rather than "is there a link for it?".
 *
 * Pure: no disk, no network. Everything takes its inputs and returns a value,
 * so both planners (`planPush` / `planPull`) can call it identically against a
 * real board or an in-memory one.
 */

import type { Issue } from '../core/model/types.js';

/**
 * The set of issue ids a remote's scope covers, or `null` when the remote has
 * no scope and mirrors the whole board.
 *
 * `null` and an empty set mean different things: `null` is "everything", an
 * empty set is "a scope id that names nothing" (a stale scope `lpm check`
 * reports before any sync runs).
 */
export type RemoteScope = ReadonlySet<string> | null;

/**
 * Compute the subtree a `scopeId` names.
 *
 * Returns `null` when `scopeId` is absent — the whole board is in scope.
 * Returns the set of the scope root plus every descendant (parent-first walk
 * over `parentId`) when it is present. A `scopeId` that does not name an
 * existing issue yields an empty set; nothing is invented, and the check pass
 * in core validation reports the stale id before a sync can act on it.
 */
export function resolveScope(
  issues: readonly Issue[],
  scopeId: string | undefined,
): RemoteScope {
  if (!scopeId) return null;

  // Parent id -> child ids, built once so the walk is O(subtree), not O(n²).
  const ids = new Set<string>();
  const children = new Map<string, string[]>();
  for (const issue of issues) {
    ids.add(issue.id);
    if (!issue.parentId) continue;
    const siblings = children.get(issue.parentId);
    if (siblings) siblings.push(issue.id);
    else children.set(issue.parentId, [issue.id]);
  }

  // A scope id that names nothing mirrors nothing. `lpm check` reports the
  // stale id before any sync runs; this empty set is the same answer at sync
  // time — the remote must not be told about a phantom root.
  if (!ids.has(scopeId)) return new Set();

  const inScope = new Set<string>();
  const queue = [scopeId];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (inScope.has(id)) continue;
    inScope.add(id);
    for (const childId of children.get(id) ?? []) queue.push(childId);
  }
  return inScope;
}

/**
 * True when `issueId` is inside a remote's scope. A `null` scope (no `scope:`
 * key) holds everything.
 */
export function isInScope(scope: RemoteScope, issueId: string): boolean {
  return scope === null || scope.has(issueId);
}

/**
 * Linked local ids that have fallen outside this remote's scope.
 *
 * The caller decides what to do with each (the remote's `on_delete` policy),
 * but the split itself is the one thing a sync must get right: a document that
 * still exists but has moved out of the subtree is not the same as a deleted
 * document, and neither may be silently dropped from the link store.
 *
 * Returns `[]` for a `null` scope — the whole board is in scope, so nothing
 * can have left it.
 */
export function linksOutsideScope(
  scope: RemoteScope,
  linkedIds: Iterable<string>,
): string[] {
  if (scope === null) return [];
  const outside: string[] = [];
  for (const id of linkedIds) {
    if (!scope.has(id)) outside.push(id);
  }
  return outside;
}
