/**
 * Where a remote issue belongs in the local tree — the one walk, shared by the
 * pull planner and the drift report.
 *
 * A remote issue that has a twin answers for itself: its anchor is that twin.
 * One that does not is anchored by whatever is above it — its remote parent's
 * twin, or its grandparent's — which is what lets a scoped remote decide
 * whether a *brand new* upstream issue is any of its business, and what lets a
 * report say where a pull would file it.
 *
 * It lives in its own file because two callers need exactly the same answer and
 * they must not drift: `planPull` uses it to decide what to adopt, and
 * `computeRemoteStatus` uses it to describe what is waiting to be adopted. A
 * second copy would be a report that offers work the pull then declines to
 * take, or the reverse.
 *
 * Pure: no disk, no network. `issues` is the listing the caller already has.
 */

import type { LinkStore } from './links.js';
import type { RemoteRecord } from './provider.js';

/** The local id a remote issue hangs off, or `undefined` when nothing above it is mirrored. */
export type AnchorResolver = (remoteId: string) => string | undefined;

/**
 * Build the anchor resolver for one listing.
 *
 * Memoized per remote id, and the memo doubles as the cycle guard: a remote
 * whose parent chain loops back on itself (which a tracker will happily let
 * somebody build) resolves to `undefined` rather than hanging the caller. The
 * `undefined` written before the recursive call is what does that.
 *
 * `parentIdOf` is the provider's seam and is optional — a provider with no
 * native parent read anchors nothing it does not already have a twin for,
 * which is the honest answer rather than a guessed hierarchy.
 */
export function anchorResolver(
  links: LinkStore,
  issues: ReadonlyMap<string, RemoteRecord>,
  parentIdOf?: (record: RemoteRecord) => string | undefined,
): AnchorResolver {
  const memo = new Map<string, string | undefined>();
  const anchorOf = (remoteId: string): string | undefined => {
    if (memo.has(remoteId)) return memo.get(remoteId);
    memo.set(remoteId, undefined); // cycle guard
    const linked = links.byRemote.get(remoteId);
    if (linked !== undefined) {
      memo.set(remoteId, linked);
      return linked;
    }
    const record = issues.get(remoteId);
    const parentRemote = record && parentIdOf ? parentIdOf(record) : undefined;
    if (parentRemote !== undefined && parentRemote !== '') {
      const anchored = anchorOf(parentRemote);
      memo.set(remoteId, anchored);
      return anchored;
    }
    return undefined;
  };
  return anchorOf;
}
