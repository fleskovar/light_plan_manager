/**
 * The correspondence store — which document is which remote issue, and what it
 * looked like last time both sides agreed.
 *
 * Lives under `.lpm/remotes/<name>/links.json`, committed like everything else.
 * Its sibling `mapping.json` holds the mapping fingerprint every sync compares
 * against (LP-370, `fingerprint.ts`).
 *
 * Why not a frontmatter field?  `remote_id:` would be a breaking reserved field
 * (it would shadow a user attribute of that name), it does not extend to two
 * remotes, and it has nowhere to keep the base snapshot.  Same reasoning that
 * keeps derived inverses out of the documents.
 *
 * ## Merge safety
 *
 * Keys are written sorted and each link entry is a contiguous line-group, so
 * two people syncing different issues on different branches produce a
 * non-overlapping diff.  The file ends with a trailing newline.  A hand-edited
 * or merge-mangled file is rejected with a `BoardError` naming the path and the
 * offending key — never a bare JSON parse error.
 *
 * ## Concurrency
 *
 * Two syncs can race on this file (CI plus a laptop, two teammates).  The
 * design decision is **last-writer-wins with git as the backstop**: no lockfile
 * in the per-remote folder.  The store's public API (`loadLinkStore` /
 * `saveLinkStore`) is free of the single-file assumption so a per-document split
 * under `links/` remains an internal change if the single file proves
 * conflict-prone in practice.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BoardPaths } from '../core/storage/paths.js';
import { BoardError } from '../core/errors.js';
import { isManagedCommentBody } from './managed-comment.js';
import { MANAGED_BLOCK_BEGIN, MANAGED_BLOCK_END } from './managed-block.js';
import type { HierarchyRecord } from './hierarchy.js';

// ---------------------------------------------------------------------------
// Managed-block convention
// ---------------------------------------------------------------------------

/**
 * When a provider cannot hold a field natively it is encoded into a managed
 * block inside the issue body.  The block is our output, not their content —
 * so it must be excluded when hashing the body for the base snapshot, or every
 * push would look like a remote edit on the next pull.
 *
 * The delimiters are the one definition in `managed-block.ts`, shared with the
 * codec that writes the block (LP-276) so the hash and the writer can never
 * drift apart.
 */

/** Escape regex metacharacters so a delimiter is matched literally. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Regex that matches a managed block and everything inside it.  The block may
 * appear at any position in the body and there may be at most one.
 */
const MANAGED_BLOCK_RE = new RegExp(
  `${escapeRegExp(MANAGED_BLOCK_BEGIN)}[\\s\\S]*?${escapeRegExp(MANAGED_BLOCK_END)}`,
  'g',
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One document's remote twin, as stored on disk. */
export interface LinkEntry {
  /** The remote system's opaque id for this issue. */
  remoteId: string;
  /** A human-readable key, e.g. `acme/payments#418`. */
  remoteKey: string;
  /** Full URL to the remote issue, so nothing has to reconstruct it. */
  remoteUrl: string;
  /**
   * The remote's GraphQL node id, where the platform has one (GitHub's
   * `node_id`). Recorded beside the number (`remoteId`) and the URL so a later
   * story (sub-issues, Projects v2) can address the issue on the GraphQL side
   * without a second lookup (LP-307). Absent on a platform without one.
   */
  nodeId?: string;
  /**
   * The remote parent this twin was actually filed under, as the last write
   * left it: the remote id, or `null` for "filed with no remote parent".
   *
   * The base snapshot records the *local* parent (`base.parent`), which
   * answers "did somebody reparent this locally?" and cannot answer the
   * question a plan filed a piece at a time asks — **was the parent on the
   * remote yet when this was created?** A story pushed before its feature is
   * filed at the remote's top level with its local parent unchanged, so no
   * diff ever appears, and pushing the feature afterwards left the story
   * hanging at the root for good. Recorded as `null` in that case, the next
   * push of the story sees a parent that has since become resolvable and
   * repairs the shape.
   *
   * Absent on a link written before this was recorded, which is read as "we do
   * not know" and changes nothing — an unknown must not manufacture a
   * reparent for every twin on the board.
   */
  parentRemoteId?: string | null;
  /** When this link was last written (ISO-8601). */
  syncedAt: string;
  /**
   * The remote's own revision marker at the time of sync — a timestamp or a
   * content hash, whatever the connector supplies.  Used on the next pull to
   * ask "has the remote side changed?".
   */
  remoteRev: string;
  /**
   * Every mapped field's value as it stood when both sides last agreed, keyed
   * by local attribute name.  Absent when no base snapshot has been stored yet
   * (the link was just created and a pull has not confirmed it).
   *
   * Fields encoded in a managed block rather than a native remote field still
   * appear here under their local names — the base is vocabulary-agnostic.
   */
  base?: Record<string, unknown>;
  /**
   * The remote id of the managed comment holding this twin's degraded fields,
   * when `encoding: comment` (or a refused body write) put them there. Absent
   * when the block lives in the body, or when no managed comment exists yet.
   * The next push needs this id to edit rather than duplicate the comment.
   */
  managedCommentId?: string;
  /**
   * Local user-comment index (1-based, as a string) → the remote comment id
   * that comment was posted as (LP-316). The push posts only indexes absent
   * from this map; the pull appends only remote ids absent from its values.
   * The managed comment is tracked separately (`managedCommentId`) and never
   * appears here, so it is excluded from comment sync in both directions.
   */
  commentIds?: Record<string, string>;
  /**
   * The hierarchy encoding the remote last used (LP-493), recorded after a
   * successful sync so the next sync can detect an encoding switch. Absent
   * before the first sync, or on a store predating LP-493.
   */
  hierarchy?: HierarchyRecord;
  /**
   * Content hash of `base` at write time, so a reader can detect an edit to
   * the file without comparing every field.  Absent when `base` is absent.
   */
  baseHash?: string;
}

/**
 * A decoupled document's tombstone — the memory that a human deliberately
 * dropped a link, so no later sync re-files it (LP-366 writes these; the
 * lifecycle resolver only reads them).  Unlike a link, a tombstone names no
 * living twin: the link is gone, and the last known remote key plus the reason
 * it was dropped are the whole record.
 */
export interface Tombstone {
  /** The last known human-readable key, e.g. `acme/payments#418`. */
  remoteKey: string;
  /** Why the link was dropped: `manual`, `out_of_scope`, or a policy reason. */
  reason: string;
  /** When it happened (ISO-8601). */
  at: string;
}

/** What lives on disk inside `.lpm/remotes/<name>/links.json`. */
export interface LinkStoreFile {
  version: 1;
  /**
   * The remote's cursor at the last successful pull — a page token, a
   * timestamp, or whatever the provider returns.  Lets the next pull ask only
   * for what changed since last time.  Null before the first pull.
   */
  cursor: string | null;
  /** Every linked document, keyed by local id.  Written in sorted key order. */
  links: Record<string, LinkEntry>;
  /**
   * The hierarchy encoding the remote last used, recorded after a successful
   * sync (LP-493).  Absent on a store that has never synced.
   */
  hierarchy?: HierarchyRecord;
  /**
   * Documents deliberately decoupled, keyed by local id.  Written in sorted key
   * order under a key separate from `links`, so the merge-friendliness of the
   * file covers tombstones too (LP-366).  Absent when there are none.
   */
  tombstones?: Record<string, Tombstone>;
  /**
   * When a person first confirmed writing to this remote (ISO-8601), the
   * one-time first-write consent (LP-350). Absent until then; a sync that
   * would make the first write asks for confirmation once and records this.
   */
  consentedAt?: string;
}

/**
 * The link store in memory: forward and reverse indexes for O(1) lookup in
 * both directions.
 */
export interface LinkStore {
  version: number;
  cursor: string | null;
  /** Local id → remote twin. */
  links: Map<string, LinkEntry>;
  /** Remote id → local id.  Built on load; never written to disk. */
  byRemote: Map<string, string>;
  /** Local id → tombstone, for documents deliberately decoupled. */
  tombstones: Map<string, Tombstone>;
  /** The hierarchy encoding the remote last used (LP-493). */
  hierarchy?: HierarchyRecord;
  /** When first-write consent was recorded (LP-350); absent until then. */
  consentedAt?: string;
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

/** The path to one remote's link store. */
export function linksPath(paths: BoardPaths, remoteName: string): string {
  return path.join(paths.remotesDir, remoteName, 'links.json');
}

/**
 * Read the link store from disk.  A missing file is a valid empty store — the
 * first sync creates it.  A file that exists but cannot be parsed is a
 * `BoardError` naming the path.
 */
export function loadLinkStore(paths: BoardPaths, remoteName: string): LinkStore {
  const file = linksPath(paths, remoteName);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    // File does not exist yet — the first sync will create it.
    return emptyStore();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new BoardError(`Cannot parse link store: ${file}`, [
      (error as Error).message,
      'Delete it to start fresh (all links will be lost), or repair the JSON.',
    ]);
  }

  const store = parsed as Partial<LinkStoreFile>;

  if (store.version !== 1) {
    const newer = typeof store.version === 'number' && store.version > 1;
    throw new BoardError(
      newer
        ? `Link store at ${file} was written by a newer version of light-plan`
        : `Unsupported link store version in ${file}`,
      newer
        ? [
            `This file is version ${store.version}; this build of light-plan understands version 1.`,
            'Upgrade light-plan to read this file, or delete it to start fresh (all links will be lost).',
          ]
        : [
            `Found version ${JSON.stringify(store.version)}; expected 1.`,
            'Delete it to start fresh (all links will be lost), or repair the version field.',
          ],
    );
  }

  const links = new Map<string, LinkEntry>();
  const byRemote = new Map<string, string>();
  const tombstones = new Map<string, Tombstone>();

  // The recorded hierarchy encoding (LP-493): a per-remote fact, like the
  // cursor. Absent on a store that has never synced.
  let hierarchy: HierarchyRecord | undefined;
  if (store.hierarchy !== undefined && store.hierarchy !== null) {
    const raw = store.hierarchy as unknown as Record<string, unknown>;
    if (
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      (raw.kind !== 'sub-issues' && raw.kind !== 'labels') ||
      typeof raw.nativeDepth !== 'number'
    ) {
      throw new BoardError(`Invalid link store: ${file}`, [
        `The hierarchy record is malformed (got ${JSON.stringify(store.hierarchy)}).`,
        'Delete the hierarchy field to let the next sync record a fresh one, or repair it.',
      ]);
    }
    hierarchy = {
      kind: raw.kind as HierarchyRecord['kind'],
      nativeDepth: raw.nativeDepth as number,
      // The anchor is part of the carrier decision, so dropping it on read
      // makes every twin look mis-parented on the next plan: the record says
      // "root" (the absent default), the resolution says "leaf", and the push
      // re-parents all of them, every time, for ever.
      ...(raw.anchor === 'root' || raw.anchor === 'leaf'
        ? { anchor: raw.anchor as HierarchyRecord['anchor'] }
        : {}),
    };
  }

  if (store.links && typeof store.links === 'object') {
    for (const [localId, entry] of Object.entries(store.links)) {
      if (!entry || typeof entry !== 'object') {
        throw new BoardError(`Invalid link store: ${file}`, [
          `Link "${localId}" is not an object (got ${typeof entry}).`,
          'Delete it to start fresh (all links will be lost), or repair the entry.',
        ]);
      }
      const link = entry as unknown as Record<string, unknown>;

      // remoteId is the only hard-required field — without it there is no link.
      if (typeof link.remoteId !== 'string' || !link.remoteId) {
        throw new BoardError(`Invalid link store: ${file}`, [
          `Link "${localId}" is missing a valid remoteId (got ${JSON.stringify(link.remoteId)}).`,
          'Every link must carry a non-empty remoteId string.',
          'Delete the entry to remove the link, or provide a valid remoteId.',
        ]);
      }

      // Validate types of optional fields so a hand-edited file surfaces
      // mistakes as BoardErrors rather than silently swallowing them.
      validateLinkField(link, localId, 'remoteKey', 'string', file);
      validateLinkField(link, localId, 'remoteUrl', 'string', file);
      validateLinkField(link, localId, 'syncedAt', 'string', file);
      validateLinkField(link, localId, 'remoteRev', 'string', file);
      validateLinkField(link, localId, 'managedCommentId', 'string', file);
      validateLinkField(link, localId, 'nodeId', 'string', file);
      if (link.base !== undefined && link.base !== null) {
        if (typeof link.base !== 'object') {
          throw new BoardError(`Invalid link store: ${file}`, [
            `Link "${localId}".base must be an object (got ${typeof link.base}).`,
            'Delete the base field to clear the snapshot, or provide a valid object.',
          ]);
        }
      }
      if (link.baseHash !== undefined && link.baseHash !== null) {
        if (typeof link.baseHash !== 'string') {
          throw new BoardError(`Invalid link store: ${file}`, [
            `Link "${localId}".baseHash must be a string (got ${typeof link.baseHash}).`,
            'Delete the baseHash field to let it be recomputed, or provide a valid hash.',
          ]);
        }
      }

      const linkEntry: LinkEntry = {
        remoteId: link.remoteId,
        remoteKey: typeof link.remoteKey === 'string' ? link.remoteKey : link.remoteId,
        remoteUrl: typeof link.remoteUrl === 'string' ? link.remoteUrl : '',
        syncedAt: typeof link.syncedAt === 'string' ? link.syncedAt : '',
        remoteRev: typeof link.remoteRev === 'string' ? link.remoteRev : '',
      };

      if (typeof link.managedCommentId === 'string') {
        linkEntry.managedCommentId = link.managedCommentId;
      }
      if (typeof link.nodeId === 'string') {
        linkEntry.nodeId = link.nodeId;
      }
      // `null` is a value here — "filed with no remote parent" — so it is
      // carried through rather than treated as absent.
      if (typeof link.parentRemoteId === 'string' || link.parentRemoteId === null) {
        linkEntry.parentRemoteId = link.parentRemoteId;
      }

      if (link.commentIds !== undefined && link.commentIds !== null) {
        if (typeof link.commentIds !== 'object' || Array.isArray(link.commentIds)) {
          throw new BoardError(`Invalid link store: ${file}`, [
            `Link "${localId}".commentIds must be an object of comment ids (got ${Array.isArray(link.commentIds) ? 'an array' : typeof link.commentIds}).`,
            'Delete the commentIds field to clear the recorded ids, or provide a valid object.',
          ]);
        }
        const commentIds: Record<string, string> = {};
        for (const [index, commentId] of Object.entries(link.commentIds as Record<string, unknown>)) {
          if (typeof commentId !== 'string') {
            throw new BoardError(`Invalid link store: ${file}`, [
              `Link "${localId}".commentIds["${index}"] must be a string (got ${typeof commentId}).`,
              'Delete the entry to clear it, or provide a valid comment id.',
            ]);
          }
          commentIds[index] = commentId;
        }
        linkEntry.commentIds = commentIds;
      }

      if (link.base !== undefined && link.base !== null && typeof link.base === 'object') {
        linkEntry.base = link.base as Record<string, unknown>;
      }
      if (typeof link.baseHash === 'string') {
        linkEntry.baseHash = link.baseHash;
      }

      links.set(localId, linkEntry);
      byRemote.set(linkEntry.remoteId, localId);
    }
  }

  if (store.tombstones && typeof store.tombstones === 'object') {
    for (const [localId, raw] of Object.entries(store.tombstones)) {
      if (!raw || typeof raw !== 'object') {
        throw new BoardError(`Invalid link store: ${file}`, [
          `Tombstone "${localId}" is not an object (got ${typeof raw}).`,
          'Delete the tombstone to remove the decoupled marker, or repair the entry.',
        ]);
      }
      const entry = raw as unknown as Record<string, unknown>;
      validateLinkField(entry, localId, 'remoteKey', 'string', file);
      validateLinkField(entry, localId, 'reason', 'string', file);
      validateLinkField(entry, localId, 'at', 'string', file);
      tombstones.set(localId, {
        remoteKey: typeof entry.remoteKey === 'string' ? entry.remoteKey : '',
        reason: typeof entry.reason === 'string' ? entry.reason : '',
        at: typeof entry.at === 'string' ? entry.at : '',
      });
    }
  }

  // A document may not be both linked and decoupled — the two are opposites,
  // and only a hand-edited or merge-mangled file could hold both.  Reject it
  // rather than let one silently outrank the other.
  for (const localId of tombstones.keys()) {
    if (links.has(localId)) {
      throw new BoardError(`Invalid link store: ${file}`, [
        `Document "${localId}" is both linked and decoupled.`,
        'Delete either the link or the tombstone — the two cannot both be true.',
      ]);
    }
  }

  return {
    version: store.version,
    cursor: typeof store.cursor === 'string' ? store.cursor : null,
    links,
    byRemote,
    tombstones,
    ...(hierarchy !== undefined ? { hierarchy } : {}),
    ...(typeof store.consentedAt === 'string' && store.consentedAt !== ''
      ? { consentedAt: store.consentedAt }
      : {}),
  };
}

/**
 * Write the link store to disk.  Creates the per-remote folder if it does not
 * exist.  Keys are written in sorted order so two people syncing different
 * issues produce a mergeable diff.
 */
export function saveLinkStore(paths: BoardPaths, remoteName: string, store: LinkStore): void {
  const file = linksPath(paths, remoteName);
  mkdirSync(path.dirname(file), { recursive: true });

  // Build a plain object with sorted keys.
  const sortedIds = [...store.links.keys()].sort();
  const links: Record<string, LinkEntry> = {};
  for (const id of sortedIds) {
    links[id] = store.links.get(id)!;
  }

  const onDisk: LinkStoreFile = {
    version: 1 as const,
    cursor: store.cursor,
    links,
  };

  if (store.hierarchy !== undefined) {
    onDisk.hierarchy = store.hierarchy;
  }

  if (store.consentedAt !== undefined) {
    onDisk.consentedAt = store.consentedAt;
  }

  const tombstoneIds = [...store.tombstones.keys()].sort();
  if (tombstoneIds.length > 0) {
    const tombstones: Record<string, Tombstone> = {};
    for (const id of tombstoneIds) tombstones[id] = store.tombstones.get(id)!;
    onDisk.tombstones = tombstones;
  }

  writeFileSync(file, `${JSON.stringify(onDisk, null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** The remote twin of `localId`, or undefined when it is not linked. */
export function getLink(store: LinkStore, localId: string): LinkEntry | undefined {
  return store.links.get(localId);
}

/** The tombstone for `localId`, when the document was deliberately decoupled. */
export function getTombstone(store: LinkStore, localId: string): Tombstone | undefined {
  return store.tombstones.get(localId);
}

/** True when `localId` was deliberately decoupled (LP-366 records these). */
export function isDecoupled(store: LinkStore, localId: string): boolean {
  return store.tombstones.has(localId);
}

/**
 * Record (or replace) the tombstone for `localId`.  A tombstone is the memory
 * that a human dropped the link on purpose; it never names a living twin.
 */
export function setTombstone(store: LinkStore, localId: string, tombstone: Tombstone): void {
  store.tombstones.set(localId, tombstone);
}

/**
 * Remove the tombstone for `localId` — the document is free to be linked (and
 * therefore filed) again.  Returns true when there was one to remove.
 */
export function clearTombstone(store: LinkStore, localId: string): boolean {
  return store.tombstones.delete(localId);
}

/**
 * Decouple a document: drop its link (and with it the base snapshot — there is
 * nothing left to be a base for) and record a tombstone carrying the last
 * known remote key, the reason, and when it happened.  The remote twin is
 * never touched by this — decoupling is a local decision that leaves the
 * remote issue alone.
 *
 * Works whether or not the document is currently linked: a never-linked
 * document is decoupled with an empty remote key, which still marks it as
 * "never file this".  Returns the tombstone written.
 */
export function decoupleLink(
  store: LinkStore,
  localId: string,
  reason: string,
  at: string,
): Tombstone {
  const link = store.links.get(localId);
  const remoteKey = link?.remoteKey ?? '';
  removeLink(store, localId); // drops the link, the base snapshot and the reverse index
  const tombstone: Tombstone = { remoteKey, reason, at };
  store.tombstones.set(localId, tombstone);
  return tombstone;
}

/** The local id linked to `remoteId`, or undefined when it is not linked. */
export function getLocalId(store: LinkStore, remoteId: string): string | undefined {
  return store.byRemote.get(remoteId);
}

/** True when `localId` has a recorded remote twin. */
export function isLinked(store: LinkStore, localId: string): boolean {
  return store.links.has(localId);
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Record (or replace) the remote twin of `localId`.  If this local id was
 * previously linked to a different remote id the old reverse entry is dropped.
 */
export function setLink(store: LinkStore, localId: string, entry: LinkEntry): void {
  const old = store.links.get(localId);
  if (old && old.remoteId !== entry.remoteId) {
    store.byRemote.delete(old.remoteId);
  }
  store.links.set(localId, entry);
  store.byRemote.set(entry.remoteId, localId);
  // A live link is the opposite of a tombstone: linking (or re-linking) a
  // document ends its decoupled state, so the tombstone must not linger and
  // outrank the link in the lifecycle resolver.
  store.tombstones.delete(localId);
}

/**
 * Remove the link for `localId`.  Returns true when there was one to remove.
 */
export function removeLink(store: LinkStore, localId: string): boolean {
  const entry = store.links.get(localId);
  if (!entry) return false;
  store.byRemote.delete(entry.remoteId);
  store.links.delete(localId);
  return true;
}

/** The remote id of the managed comment recorded for `localId`, or undefined. */
export function getManagedCommentId(store: LinkStore, localId: string): string | undefined {
  return store.links.get(localId)?.managedCommentId;
}

/**
 * True when a remote comment is the managed comment for `localId` — our own
 * output, excluded from comment sync in both directions (LP-278).  Known by
 * id where the link store records it; by body where the id was lost.  A push
 * never re-posts it as a user comment, and a pull never imports it as one.
 */
export function isManagedComment(
  store: LinkStore,
  localId: string,
  commentId: string,
  body: string,
): boolean {
  if (getManagedCommentId(store, localId) === commentId) return true;
  return isManagedCommentBody(body);
}

/**
 * Record (or clear) the managed comment id for `localId`.  A no-op when the
 * document is not linked — the comment is an attribute of an existing link.
 */
export function setManagedCommentId(
  store: LinkStore,
  localId: string,
  commentId: string | undefined,
): void {
  const link = store.links.get(localId);
  if (!link) return;
  if (commentId === undefined) delete link.managedCommentId;
  else link.managedCommentId = commentId;
}

// ---------------------------------------------------------------------------
// User-comment correspondence (LP-316)
// ---------------------------------------------------------------------------

/**
 * The local comment indexes (1-based, as a string) already synced for
 * `localId`, or an empty set when the document is unlinked or has none.  The
 * push posts only indexes absent from this set; a comment the log has since
 * grown past (new entries appended below) is still present, because appends
 * never shift the indexes recorded for earlier entries.
 */
export function getSyncedCommentIndexes(store: LinkStore, localId: string): Set<number> {
  const record = store.links.get(localId)?.commentIds;
  const indexes = new Set<number>();
  if (!record) return indexes;
  for (const key of Object.keys(record)) {
    const index = Number(key);
    if (Number.isInteger(index) && index > 0) indexes.add(index);
  }
  return indexes;
}

/**
 * The remote comment ids already synced for `localId`, or an empty set.  The
 * pull appends only remote ids absent from this set; the managed comment's id
 * is deliberately not among them, so the caller still excludes it by body/id
 * rather than trusting the absence to be meaningful.
 */
export function getSyncedRemoteCommentIds(store: LinkStore, localId: string): Set<string> {
  const record = store.links.get(localId)?.commentIds;
  const ids = new Set<string>();
  if (!record) return ids;
  for (const value of Object.values(record)) ids.add(value);
  return ids;
}

/**
 * Record that the local comment at `index` (1-based) is the remote comment
 * `commentId` for `localId` (LP-316).  A no-op when the document is not
 * linked.  Clearing a synced comment is not offered — the log is append-only
 * and a recorded id stays recorded, so nothing is ever posted twice.
 */
export function setCommentId(
  store: LinkStore,
  localId: string,
  index: number,
  commentId: string,
): void {
  const link = store.links.get(localId);
  if (!link) return;
  if (link.commentIds === undefined) link.commentIds = {};
  link.commentIds[String(index)] = commentId;
}

/**
 * Change the local id a link is keyed under.  Does nothing when `oldId` has no
 * link or when the two ids are equal, and overwrites any existing link at
 * `newId` as the safe default — the caller must resolve that collision first.
 */
export function rewriteLinkId(store: LinkStore, oldId: string, newId: string): void {
  if (oldId === newId) return;
  const entry = store.links.get(oldId);
  if (!entry) return;
  // If newId already had a link the old one is dropped — that is the safe
  // default, and the caller checks for collisions before calling.
  const oldAtNew = store.links.get(newId);
  if (oldAtNew) store.byRemote.delete(oldAtNew.remoteId);
  store.links.delete(oldId);
  store.links.set(newId, entry);
  store.byRemote.set(entry.remoteId, newId);
}

/**
 * Report links whose local document no longer exists.  Never prunes silently —
 * the caller decides whether to call `removeLink` for each.  The returned array
 * is the list of local ids that have no matching document.
 */
export function findMissingLinks(store: LinkStore, existingIds: Set<string>): string[] {
  const missing: string[] = [];
  for (const localId of store.links.keys()) {
    if (!existingIds.has(localId)) {
      missing.push(localId);
    }
  }
  return missing;
}

/**
 * Remove every link whose local document is not in `existingIds`.  Returns the
 * ids that were pruned.
 */
export function pruneMissingLinks(store: LinkStore, existingIds: Set<string>): string[] {
  const missing = findMissingLinks(store, existingIds);
  for (const id of missing) {
    removeLink(store, id);
  }
  return missing;
}

/**
 * Tombstones whose local document no longer exists.  Like `findMissingLinks`,
 * never prunes silently — the caller decides.  A tombstone left behind by a
 * deleted document is dead weight, not a correctness bug, but `lpm check`
 * reports it so the store stays honest.
 */
export function findMissingTombstones(store: LinkStore, existingIds: Set<string>): string[] {
  const missing: string[] = [];
  for (const localId of store.tombstones.keys()) {
    if (!existingIds.has(localId)) missing.push(localId);
  }
  return missing;
}

/**
 * Remove every tombstone whose local document is not in `existingIds`.
 * Returns the ids that were pruned.
 */
export function pruneMissingTombstones(store: LinkStore, existingIds: Set<string>): string[] {
  const missing = findMissingTombstones(store, existingIds);
  for (const id of missing) {
    store.tombstones.delete(id);
  }
  return missing;
}

/**
 * Strip the managed block from a body, returning the text the remote side
 * wrote — the content the hash should represent.  When there is no managed
 * block the body is returned unchanged.
 */
export function stripManagedBlock(body: string): string {
  return body.replace(MANAGED_BLOCK_RE, '').trim();
}

/**
 * Compute a stable hash of the *normalised* body — managed block excluded — so
 * the base snapshot stores a short token rather than the full text.  The
 * returned string carries a `sha256:` prefix so a reader can tell a hash from
 * a literal body value at a glance.
 *
 * The hash is over the trimmed text after the managed block is removed; two
 * bodies that differ only in trailing whitespace outside the managed block
 * produce the same hash.
 *
 * **Line endings are normalised first**, and that is not cosmetic. A board
 * checked out on Windows has `
` in every document; a remote hands its text
 * back with `
`. Hashing them apart makes every document permanently *ahead*:
 * the push rewrites all of them, the next push does it again, and two
 * teammates on different operating systems fight over bodies neither has
 * edited.
 *
 * `normalize` is the same argument made for a remote whose body format is not
 * markdown (`Translator.normalizeBody`): Jira stores ADF, which has paragraphs
 * but no source line breaks, so a hard-wrapped body comes back as one long
 * line and would differ from itself for ever. Pass it when hashing a **board**
 * body that will be compared against a base recorded from the remote's echo;
 * never when hashing prose the remote just handed back, which has already been
 * through that round trip.
 */
export function hashBody(body: string, normalize?: (markdown: string) => string): string {
  const stripped = stripManagedBlock(body).replace(/\r\n/g, '\n');
  const normalised = normalize === undefined ? stripped : normalize(stripped).trim();
  const hash = createHash('sha256').update(normalised, 'utf8').digest('hex');
  return `sha256:${hash}`;
}

/**
 * True when `value` looks like a body hash — a string that starts with
 * `sha256:` followed by 64 hex digits.
 */
export function isBodyHash(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

// ---------------------------------------------------------------------------
// Base snapshots
// ---------------------------------------------------------------------------

/**
 * Compute the base snapshot for one document: every mapped field's value as it
 * stands right now.  The body is stored as a hash (`hashBody`), not as the full
 * text.  Fields carried in the managed block still appear under their local
 * names — the base is vocabulary-agnostic.
 *
 * `mappedFields` is the set of local attribute names the mapping declares.
 * Only those fields land in the snapshot; nothing else is included, because a
 * field the mapping does not mention cannot diverge.
 */
export function computeBase(
  document: {
    title: string;
    body: string;
    attributes: Record<string, unknown>;
    status?: string;
    assignee?: string | null;
    period?: string | null;
    dependsOn?: string[];
    relatesTo?: string[];
    relatedFiles?: string[];
  },
  mappedFields: ReadonlySet<string>,
  normalizeBody?: (markdown: string) => string,
): Record<string, unknown> {
  const base: Record<string, unknown> = {};

  for (const field of mappedFields) {
    if (field === 'body') {
      base.body = hashBody(document.body, normalizeBody);
    } else if (field === 'title') {
      base.title = document.title;
    } else if (
      field === 'status' ||
      field === 'assignee' ||
      field === 'period'
    ) {
      base[field] = (document as Record<string, unknown>)[field] ?? null;
    } else if (
      field === 'dependsOn' ||
      field === 'depends_on' ||
      field === 'relatesTo' ||
      field === 'relates_to' ||
      field === 'relatedFiles' ||
      field === 'related_files'
    ) {
      // List fields — snapshot a sorted copy so the order is stable.
      // Normalise the field name for lookup: the document shape uses
      // camelCase, but the mapping may declare either spelling.
      const lookupKey =
        field === 'depends_on' ? 'dependsOn' :
        field === 'relates_to' ? 'relatesTo' :
        field === 'related_files' ? 'relatedFiles' :
        field;
      const list = (document as Record<string, unknown>)[lookupKey];
      base[field] = Array.isArray(list) ? [...list].sort() : [];
    } else {
      // Config-declared attribute or unknown field.
      base[field] = document.attributes[field] ?? null;
    }
  }

  return base;
}

/**
 * Update the base snapshot for one linked document.  After a successful sync
 * only the documents that landed should have their base updated — a partially
 * failed sync must not snapshot work that did not reach the remote.
 *
 * The `base` value here should come from `computeBase`; the `baseHash` is
 * derived from it automatically.
 */
export function updateBase(
  store: LinkStore,
  localId: string,
  base: Record<string, unknown>,
  remoteRev: string,
  syncedAt: string,
): void {
  const link = store.links.get(localId);
  if (!link) return;

  const hash = createHash('sha256')
    .update(JSON.stringify(base), 'utf8')
    .digest('hex');

  link.base = base;
  link.baseHash = `sha256:${hash}`;
  link.remoteRev = remoteRev;
  link.syncedAt = syncedAt;
}

// ---------------------------------------------------------------------------
// Cursor management
// ---------------------------------------------------------------------------

/**
 * Return the cursor to hand to the provider on the next pull, or `null` when
 * a full scan should be performed.
 *
 * A stored cursor lets the pull ask the remote only for issues updated since
 * the last successful sync.  The cursor is an opaque value the remote supplied
 * — a page token, a timestamp, a revision hash — and its meaning is the
 * provider's alone.
 *
 * When `fullSync` is `true` (the default on the CLI; `--changed` asks for the
 * incremental listing instead) the stored cursor
 * is ignored and `null` is returned, forcing a full listing.  When the
 * provider does not support incremental queries the caller should also pass
 * `null` regardless; this function does not inspect capabilities — the caller
 * knows which provider it is talking to.
 */
export function getCursorForPull(
  store: LinkStore,
  opts?: { fullSync?: boolean },
): string | null {
  if (opts?.fullSync) return null;
  return store.cursor;
}

/**
 * Advance the cursor to a value the **remote** supplied.
 *
 * The cursor must come from the remote's response (a `nextCursor` or
 * equivalent field), never from `Date.now()`.  Using local wall-clock time
 * would miss edits made during the sync window whenever the clocks differ —
 * every provider that supports incremental queries returns a server-side
 * marker, and the caller must use it.
 *
 * This function does not validate the value at runtime; the contract is
 * enforced by the pull planner, which is the only caller.
 */
export function advanceCursor(store: LinkStore, cursor: string): void {
  store.cursor = cursor;
}

/**
 * Reset the cursor to `null`, forcing the next pull to do a full scan.
 *
 * Safe to call at any time — a store with no cursor is a valid state (it is
 * how every store starts).  Useful after a failed pull, when the remote
 * configuration changes, or when the operator wants to rebuild the link
 * store from a fresh crawl.
 */
export function clearCursor(store: LinkStore): void {
  store.cursor = null;
}

/**
 * Record the one-time first-write consent (LP-350): a person confirmed that
 * writing to this remote is intended, so the next sync no longer asks. Set
 * once; an existing consent is never overwritten, because the confirmation is
 * a fact about the remote, not about this particular run.
 */
export function recordConsent(store: LinkStore, at: string): void {
  if (store.consentedAt === undefined) store.consentedAt = at;
}

/** True when first-write consent has been recorded for this remote. */
export function isConsented(store: LinkStore): boolean {
  return store.consentedAt !== undefined;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate that an optional field on a link entry has the expected type.
 * Throws `BoardError` naming the path and the offending key when the field is
 * present but of the wrong type — so a hand-edited or merge-mangled file
 * surfaces the mistake rather than silently correcting it.
 */
function validateLinkField(
  link: Record<string, unknown>,
  localId: string,
  field: string,
  expected: 'string',
  file: string,
): void {
  const value = link[field];
  if (value === undefined || value === null) return; // absent is fine
  if (typeof value !== expected) {
    throw new BoardError(`Invalid link store: ${file}`, [
      `Link "${localId}".${field} must be a ${expected} (got ${typeof value}).`,
      `Delete the ${field} field to clear it, or provide a valid ${expected}.`,
    ]);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyStore(): LinkStore {
  return {
    version: 1,
    cursor: null,
    links: new Map(),
    byRemote: new Map(),
    tombstones: new Map(),
  };
}
