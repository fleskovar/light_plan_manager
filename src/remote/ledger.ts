/**
 * The ledger — which remote owns which document, across every declared remote.
 *
 * A board may declare several remotes, and each keeps its own correspondence
 * store (`.lpm/remotes/<name>/links.json`). Read one at a time they answer "is
 * LP-12 on *this* tracker?"; nothing answered the question a person actually
 * asks, which is **"where does LP-12 live?"** — and nothing stopped the same
 * document being filed onto two trackers at once. Two twins of one story is not
 * a mirror of a plan: a status moves on one side, the other keeps its own, and
 * the next sync of each writes a different truth back onto the same document.
 *
 * So: **one document, one remote, at a time.** This module is the whole of that
 * rule. It is deliberately a *derived* index rather than a file of its own —
 * built by reading the stores that already exist, in the same spirit as the
 * dependency inverses the engine derives at load. A committed `ledger.json`
 * would be a second copy of a fact the link stores already hold, free to
 * disagree with them after a merge, and needing its own repair pass to say
 * which copy was right. There is nothing to repair here: the stores *are* the
 * ledger.
 *
 * Where it is enforced, and what happens:
 *
 *   - `lpm remote push` — a document another remote owns is never created a
 *     second time. It is reported in the plan's `skipped` list with the reason
 *     `owned_elsewhere` and the key it already has, exactly as a decoupled
 *     document is reported, so a whole-board push to a second remote is a
 *     readable report rather than a refusal or a duplicate.
 *   - `lpm remote link` — adopting a twin for a document that already has one
 *     elsewhere is refused outright, because it is one explicit document and
 *     the person is asking for the thing the rule forbids.
 *
 * Nothing here writes. The remedy — `lpm remote decouple <id>` on the remote
 * that holds it — is the operator's, and is named in every message.
 */

import type { BoardConfig } from '../core/model/types.js';
import type { BoardPaths } from '../core/storage/paths.js';
import { remoteNamed, remoteNames } from '../core/config/lookup.js';
import { BoardError } from '../core/errors.js';
import { loadLinkStore } from './links.js';

/** Where one document is filed: the remote that holds it, and the twin's key. */
export interface LedgerEntry {
  /** The local document id. */
  localId: string;
  /** The declared remote's name (`jira`, `upstream`). */
  remote: string;
  /** That remote's provider (`jira`, `github`, `linear`, `jsonfile`). */
  provider: string;
  /** The remote system's opaque id. */
  remoteId: string;
  /** The human-readable key, e.g. `acme/payments#418` or `PAY-31`. */
  remoteKey: string;
  /** Full URL to the twin, when the store recorded one. */
  remoteUrl: string;
  /** When the link was last written (ISO-8601). */
  syncedAt: string;
}

/** Every document that has a twin, keyed by local id. */
export interface Ledger {
  /** Local id → where it is filed. */
  byLocalId: ReadonlyMap<string, LedgerEntry>;
  /** Remote name → the documents that remote holds, in id order. */
  byRemote: ReadonlyMap<string, readonly LedgerEntry[]>;
}

/**
 * Build the ledger by reading every declared remote's link store.
 *
 * A remote whose store does not exist yet contributes nothing (the first sync
 * creates it). A document that somehow appears in two stores — a hand-edited
 * file, a merge that took both sides — is reported by `conflicts()` rather than
 * silently resolved: this is a read, and picking a winner is not its call.
 */
export function buildLedger(paths: BoardPaths, config: BoardConfig): Ledger {
  const byLocalId = new Map<string, LedgerEntry>();
  const byRemote = new Map<string, LedgerEntry[]>();

  for (const name of remoteNames(config)) {
    const provider = remoteNamed(config, name)?.provider ?? name;
    const store = loadLinkStore(paths, name);
    const entries: LedgerEntry[] = [];
    for (const [localId, link] of store.links) {
      const entry: LedgerEntry = {
        localId,
        remote: name,
        provider,
        remoteId: link.remoteId,
        remoteKey: link.remoteKey,
        remoteUrl: link.remoteUrl,
        syncedAt: link.syncedAt,
      };
      entries.push(entry);
      // First writer wins the index; `conflicts` reports the rest, so a board
      // in this state is told about it rather than quietly given an answer.
      if (!byLocalId.has(localId)) byLocalId.set(localId, entry);
    }
    entries.sort((a, b) => a.localId.localeCompare(b.localId));
    byRemote.set(name, entries);
  }

  return { byLocalId, byRemote };
}

/** Where one document is filed, or `undefined` when it has no twin anywhere. */
export function ownerOf(ledger: Ledger, localId: string): LedgerEntry | undefined {
  return ledger.byLocalId.get(localId);
}

/**
 * The remote a document is filed on, when that is not `remoteName` — the one
 * question every enforcement point asks. `undefined` means the document is free
 * (no twin at all) or already belongs to this remote.
 */
export function otherOwner(
  ledger: Ledger,
  localId: string,
  remoteName: string,
): LedgerEntry | undefined {
  const entry = ledger.byLocalId.get(localId);
  return entry !== undefined && entry.remote !== remoteName ? entry : undefined;
}

/**
 * Every document filed somewhere other than `remoteName`. The push planner
 * takes this as the set it must not create a second twin for.
 */
export function idsOwnedElsewhere(ledger: Ledger, remoteName: string): Map<string, LedgerEntry> {
  const out = new Map<string, LedgerEntry>();
  for (const [localId, entry] of ledger.byLocalId) {
    if (entry.remote !== remoteName) out.set(localId, entry);
  }
  return out;
}

/**
 * Documents that appear in more than one remote's store — the state this rule
 * exists to prevent, arrived at by a hand edit or a merge that took both sides.
 * Reported by `lpm remote ledger`, never repaired here.
 */
export function conflicts(paths: BoardPaths, config: BoardConfig): LedgerEntry[][] {
  const seen = new Map<string, LedgerEntry[]>();
  for (const name of remoteNames(config)) {
    const provider = remoteNamed(config, name)?.provider ?? name;
    const store = loadLinkStore(paths, name);
    for (const [localId, link] of store.links) {
      const entry: LedgerEntry = {
        localId,
        remote: name,
        provider,
        remoteId: link.remoteId,
        remoteKey: link.remoteKey,
        remoteUrl: link.remoteUrl,
        syncedAt: link.syncedAt,
      };
      const group = seen.get(localId);
      if (group) group.push(entry);
      else seen.set(localId, [entry]);
    }
  }
  return [...seen.values()]
    .filter((group) => group.length > 1)
    .sort((a, b) => a[0]!.localId.localeCompare(b[0]!.localId));
}

/**
 * Refuse an operation that would give `localId` a second twin.
 *
 * Used where the request names one document explicitly (`lpm remote link`): the
 * person asked for exactly the thing the rule forbids, so the answer is an
 * error naming the holder and the one command that releases it. A bulk push
 * reports instead — see the module comment.
 */
export function requireUnclaimed(ledger: Ledger, localId: string, remoteName: string): void {
  const owner = otherOwner(ledger, localId, remoteName);
  if (owner === undefined) return;
  throw new BoardError(
    `${localId} is already mirrored on remote "${owner.remote}" as ${owner.remoteKey}`,
    [
      'A document is mirrored by one remote at a time, so its status and fields have one upstream.',
      `Release it first:  lpm remote decouple ${localId}`,
      `Then file it here: lpm remote push ${localId} --remote ${remoteName}`,
    ],
  );
}
