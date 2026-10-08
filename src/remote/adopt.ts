/**
 * Adoption — pointing an existing local document at an existing remote issue
 * (LP-367).
 *
 * A new remote is usually a full one: `remote_only` issues and `local_only`
 * documents describing the same work are the normal starting state, and the
 * first sync must be able to marry them rather than double the backlog.  The
 * same operation repairs a link that broke for any of the reasons the
 * lifecycle (LP-363) catalogues.
 *
 * Adoption is deliberately a *local* write and nothing else: it records a
 * correspondence in the link store and seeds the base snapshot from the
 * remote's current values, but it touches neither document.  The **next sync**
 * is what reconciles the difference between the two models — the push planner
 * sees "local differs from base" and files the diff, the pull planner sees
 * "remote matches base" and leaves it.  Seeding the base from the remote (not
 * from local) is the point: it makes that first sync show the real difference
 * instead of declaring local the winner by construction.
 *
 * ## Pure by construction
 *
 * `planAdoption` and `suggestManagedPairings` are pure functions: board in,
 * links in, the fetched remote record in, a plan out.  The fetch that produces
 * the record is the caller's (the CLI drives the connector's `resolve`), so a
 * dry-run is the same code path as a real adoption with the writes gated off.
 *
 * ## The managed-block suggestion
 *
 * A remote issue light-plan filed itself carries a managed block whose `id`
 * cell names the local document it was (`| id | LP-42 |`).  On a re-cloned
 * board — link store gone, issues already filed — that cell is the exact,
 * non-fuzzy signal that pairs a remote issue back to its document.  This file
 * reads it (`ownIdOfManagedBlock`) and turns the whole fetched listing into
 * `AdoptionSuggestion[]` (`suggestManagedPairings`).  Everything else (title
 * matching, bulk pairing) is deliberately out of scope: a wrong automatic
 * adoption silently merges two unrelated pieces of work.
 */

import type { BoardView } from '../shared/plans/reading.js';
import { hashBody } from './links.js';
import type { LinkEntry, LinkStore } from './links.js';
import { parseManagedBlock, parseManagedId } from './managed-block.js';
import type { BoardFieldsPatch, RemoteRecord } from './provider.js';

// ---------------------------------------------------------------------------
// Managed-block suggestions
// ---------------------------------------------------------------------------

/**
 * The local document id a remote issue's managed block names, when it names
 * one.  Reads the block's `id` cell — the field the block writer uses for the
 * issue's own id — and unwraps it as a link when it was rendered as one.
 * Returns `undefined` when there is no block, no `id` cell, or an empty value.
 */
export function ownIdOfManagedBlock(record: RemoteRecord): string | undefined {
  const body = record['body'];
  if (typeof body !== 'string') return undefined;
  const parsed = parseManagedBlock(body);
  if (!parsed.found) return undefined;
  const cell = parsed.fields['id'];
  if (cell === undefined) return undefined;
  const id = parseManagedId(cell.trim());
  return id === '' ? undefined : id;
}

/** A pairing a re-cloned board can adopt directly: remote issue → local document. */
export interface AdoptionSuggestion {
  remoteId: string;
  localId: string;
}

/**
 * Every fetched remote issue whose managed block names an unlinked local
 * document — the exact pairings `lpm remote link` offers before a human
 * confirms them.  A remote issue already linked, a named id that is not an
 * in-scope issue, and a local document that already has a twin are all
 * skipped: a suggestion is only offered when adopting it would actually work.
 *
 * Pure: no disk, no network.  `remoteIssues` is the listing the caller already
 * fetched, keyed by remote id.
 */
export function suggestManagedPairings(
  remoteIssues: ReadonlyMap<string, RemoteRecord>,
  links: LinkStore,
  board: BoardView,
): AdoptionSuggestion[] {
  const suggestions: AdoptionSuggestion[] = [];
  for (const [remoteId, record] of remoteIssues) {
    if (links.byRemote.has(remoteId)) continue; // already has a twin
    const localId = ownIdOfManagedBlock(record);
    if (localId === undefined) continue;
    const node = board.nodes[localId];
    if (node === undefined || node.kind !== 'issue') continue; // not a local document
    if (links.links.has(localId)) continue; // the document already points elsewhere
    suggestions.push({ remoteId, localId });
  }
  return suggestions.sort(
    (a, b) => a.localId.localeCompare(b.localId) || a.remoteId.localeCompare(b.remoteId),
  );
}

// ---------------------------------------------------------------------------
// The adoption plan
// ---------------------------------------------------------------------------

/** What the caller fetched for the key being adopted, plus the translated patch. */
export interface AdoptSeeds {
  /** The remote system's opaque id for the issue (what `get` / `update` address). */
  remoteId: string;
  /** Human-readable key, e.g. `acme/payments#418`. */
  remoteKey: string;
  /** Full URL to the remote issue. */
  remoteUrl: string;
  /** The remote's revision marker, for the base snapshot. */
  remoteRev: string;
  /** The raw remote body, exactly as fetched (its managed block, if any, is stripped when hashed). */
  remoteBody: string;
  /** The fields recovered from the remote record, in board vocabulary. */
  patch: BoardFieldsPatch;
}

/** Why an adoption was refused. Each carries what the caller reports. */
export type AdoptRefusal =
  | { kind: 'no_such_document'; localId: string }
  | { kind: 'already_linked'; localId: string; existing: LinkEntry }
  | { kind: 'remote_claimed'; localId: string; remoteId: string; holder: string };

/** A successful adoption plan: the link to record and the base to seed with it. */
export interface AdoptPlanOk {
  localId: string;
  /** The link entry; `setLink` records it and clears any tombstone. */
  entry: LinkEntry;
  /** The base snapshot, seeded from the remote's current values. */
  base: Record<string, unknown>;
  /** True when the document was decoupled and adoption cleared its tombstone. */
  clearedTombstone: boolean;
  /** True when the document already had a link and `--repoint` moved it. */
  repointed: boolean;
}

/** The result of `planAdoption`. */
export type AdoptionPlan =
  | { ok: true; plan: AdoptPlanOk }
  | { ok: false; refusal: AdoptRefusal };

/** Options for `planAdoption`. */
export interface AdoptOptions {
  /** Explicitly allow moving an already-linked document to a different twin. */
  repoint?: boolean;
  /**
   * The field names the base snapshot records, derived from the mapping
   * (`trackedFields`).  Defaults to the always-tracked fields: title, body,
   * status.
   */
  mappedFields?: ReadonlySet<string>;
}

/** The fields every base snapshot tracks, whatever the mapping declares. */
const DEFAULT_MAPPED_FIELDS: ReadonlySet<string> = new Set(['title', 'body', 'status']);

/**
 * Seed a base snapshot from the remote's current values, never from local.
 *
 * Every mapped field lands in the base as the remote holds it — a field the
 * remote does not carry is recorded as `null`, not as the local value — so the
 * first sync after adoption reports the real difference between the two models.
 * The body is stored as a hash of the remote prose (`hashBody` strips the
 * managed block, which is our own output).  The dependency and relate lists
 * are seeded empty: the next push files the local edges — as native links or
 * managed-block rows, whichever the remote's capability chooses (LP-314) —
 * rather than adopting the remote's block edges.
 */
function baseFromRemote(
  seeds: AdoptSeeds,
  mappedFields: ReadonlySet<string>,
  shape: { parentId: string | null; type: string },
): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  for (const field of mappedFields) {
    if (field === 'body') {
      base.body = hashBody(seeds.remoteBody);
    } else if (field === 'title') {
      base.title = seeds.patch.title ?? '';
    } else if (field === 'status') {
      base.status = seeds.patch.status ?? null;
    } else if (field === 'assignee') {
      base.assignee = seeds.patch.assignee ?? null;
    } else if (field === 'period') {
      base.period = seeds.patch.period ?? null;
    } else {
      base[field] = seeds.patch.attributes?.[field] ?? null;
    }
  }
  base['dependsOn'] = [];
  // Shape (LP-368): adoption agrees the two documents are the same work, so the
  // local document's parent and type are the agreed shape the next sync
  // reconciles against. Seeding from local — not the remote record — is
  // deliberate: the remote parent has no local twin at adopt time, and the
  // first sync must report the real difference rather than claim agreement.
  base['parent'] = shape.parentId ?? null;
  base['type'] = shape.type;
  return base;
}

/**
 * Plan an adoption: validate it and produce the link and base to record.
 *
 * The refusals, in order:
 *
 *   - the local id is not an issue on the board;
 *   - the local id is already linked and `--repoint` was not given;
 *   - the remote issue is already the twin of a different document — two
 *     documents may not share one twin, whatever the local id says.
 *
 * A decoupled document is adopted freely: recording the link clears its
 * tombstone (the link is the opposite of the tombstone).  Nothing here writes
 * to disk or to the remote; the caller records `entry` and `base` with
 * `setLink` + `updateBase` and saves the store.
 */
export function planAdoption(
  board: BoardView,
  links: LinkStore,
  localId: string,
  seeds: AdoptSeeds,
  syncedAt: string,
  options: AdoptOptions = {},
): AdoptionPlan {
  const node = board.nodes[localId];
  if (node === undefined || node.kind !== 'issue') {
    return { ok: false, refusal: { kind: 'no_such_document', localId } };
  }

  const existing = links.links.get(localId);
  if (existing !== undefined && options.repoint !== true) {
    return { ok: false, refusal: { kind: 'already_linked', localId, existing } };
  }

  const holder = links.byRemote.get(seeds.remoteId);
  if (holder !== undefined && holder !== localId) {
    return {
      ok: false,
      refusal: { kind: 'remote_claimed', localId, remoteId: seeds.remoteId, holder },
    };
  }

  const clearedTombstone = links.tombstones.has(localId);
  const repointed = existing !== undefined;

  const entry: LinkEntry = {
    remoteId: seeds.remoteId,
    remoteKey: seeds.remoteKey,
    remoteUrl: seeds.remoteUrl,
    syncedAt,
    remoteRev: seeds.remoteRev,
  };
  const base = baseFromRemote(seeds, options.mappedFields ?? DEFAULT_MAPPED_FIELDS, {
    parentId: node.parentId ?? null,
    type: node.type,
  });

  return { ok: true, plan: { localId, entry, base, clearedTombstone, repointed } };
}
