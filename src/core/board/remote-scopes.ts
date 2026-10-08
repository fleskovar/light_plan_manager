/**
 * Which documents each declared remote claims — and where two remotes claim
 * the same ones.
 *
 * A remote mirrors a subtree (`scope: LP-10`) or, with no `scope`, the whole
 * board. **Two remotes may never claim the same document.** A document
 * mirrored to two trackers at once is filed twice, closed twice, and edited
 * from two directions into a conflict nobody asked for — and no `on_delete`
 * policy or three-way merge can dig it back out, because the two remotes have
 * no idea the other exists.
 *
 * Half of that rule is already enforced where it can be answered from the
 * config alone (`checkRemotes` in `config/schema.ts`): two equal scopes are
 * the same subtree, and an absent scope contains every other. The other half
 * needs the board tree, because "is LP-42 inside LP-10?" is a question about
 * parenting, not about config — and that is this file. `config/schema.ts`
 * says so in as many words and this is the check it points at.
 *
 * Pure: no disk, no network. It takes the issues and the declared scopes and
 * returns a value, so `lpm check` (reporting a board that drifted into this
 * state through a reparent, a hand edit or a merge) and `lpm remote add`
 * (refusing to write one in the first place) enforce one rule rather than two
 * that can disagree.
 */

import type { Issue } from '../model/types.js';

/** One remote's claim, as the config declares it. */
export interface DeclaredScope {
  /** The remote's name, for naming it in a message. */
  name: string;
  /** The scope id, or undefined for the whole board. */
  scope: string | undefined;
}

/** Two remotes claiming the same documents, and why. */
export interface ScopeOverlap {
  /** The remote whose scope contains the other's. */
  outer: string;
  /** The remote nested inside it. */
  inner: string;
  /** The outer remote's scope id (`undefined` — the whole board — never reaches here). */
  outerScope: string;
  /** The inner remote's scope id. */
  innerScope: string;
}

/** A `scope:` naming a document the board does not have. */
export interface StaleScope {
  name: string;
  scope: string;
}

/** Issue id → its parent's id, for walking ancestry upward. */
function parentIndex(issues: readonly Issue[]): Map<string, string | undefined> {
  const parents = new Map<string, string | undefined>();
  for (const issue of issues) parents.set(issue.id, issue.parentId ?? undefined);
  return parents;
}

/**
 * True when `ancestorId` is `id` itself or sits above it in the tree. The walk
 * is bounded by the number of issues, so a parent cycle arriving by hand edit
 * or merge terminates rather than hanging the check that would report it.
 */
function isAtOrUnder(
  parents: Map<string, string | undefined>,
  id: string,
  ancestorId: string,
): boolean {
  let current: string | undefined = id;
  for (let steps = 0; current !== undefined && steps <= parents.size; steps += 1) {
    if (current === ancestorId) return true;
    current = parents.get(current);
  }
  return false;
}

/**
 * Every pair of declared remotes whose scopes claim the same documents through
 * *nesting* — one scope sitting at or inside the other.
 *
 * Equal scopes and an absent scope are left to `config/schema.ts`, which
 * refuses them before a board with them can load at all; reporting them again
 * here would say the same thing twice in different words. A scope naming no
 * document claims nothing and cannot overlap — `staleScopes` reports it
 * instead.
 *
 * Pairs come back in declaration order, outer remote first.
 */
export function scopeOverlaps(
  issues: readonly Issue[],
  remotes: readonly DeclaredScope[],
): ScopeOverlap[] {
  const known = new Set(issues.map((issue) => issue.id));
  const scoped = remotes.filter(
    (remote): remote is DeclaredScope & { scope: string } =>
      remote.scope !== undefined && known.has(remote.scope),
  );
  if (scoped.length < 2) return [];

  const parents = parentIndex(issues);
  const overlaps: ScopeOverlap[] = [];
  for (let i = 0; i < scoped.length; i += 1) {
    for (let j = i + 1; j < scoped.length; j += 1) {
      const a = scoped[i]!;
      const b = scoped[j]!;
      if (a.scope === b.scope) continue; // config/schema.ts already refuses this
      const bInsideA = isAtOrUnder(parents, b.scope, a.scope);
      const aInsideB = isAtOrUnder(parents, a.scope, b.scope);
      if (!bInsideA && !aInsideB) continue;
      const outer = bInsideA ? a : b;
      const inner = bInsideA ? b : a;
      overlaps.push({
        outer: outer.name,
        inner: inner.name,
        outerScope: outer.scope,
        innerScope: inner.scope,
      });
    }
  }
  return overlaps;
}

/**
 * Declared scopes naming a document the board does not have — a subtree that
 * was deleted, renamed or never existed. Such a remote mirrors nothing, which
 * is worth saying out loud before somebody wonders why a sync is empty.
 */
export function staleScopes(
  issues: readonly Issue[],
  remotes: readonly DeclaredScope[],
): StaleScope[] {
  const known = new Set(issues.map((issue) => issue.id));
  return remotes
    .filter((remote): remote is DeclaredScope & { scope: string } => remote.scope !== undefined)
    .filter((remote) => !known.has(remote.scope))
    .map((remote) => ({ name: remote.name, scope: remote.scope }));
}

/** The declared scopes of a board's remotes, in declaration order. */
export function declaredScopes(
  remotes: Record<string, { scope?: string }>,
): DeclaredScope[] {
  return Object.entries(remotes).map(([name, remote]) => ({ name, scope: remote.scope }));
}
