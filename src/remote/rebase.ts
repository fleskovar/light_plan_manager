/**
 * Re-basing — bringing base snapshots back in step after a mapping change
 * (LP-371).
 *
 * A mapping change invalidates every base snapshot recorded under the old
 * mapping, and `checkMappingChange` (LP-370) stops the sync before it can
 * manufacture a board-wide wave of phantom conflicts. This file owns the way
 * out: an explicit re-base that re-reads **both** sides under the new mapping
 * and rewrites each base from the values that actually agree — never from
 * whatever local currently says, which would silently discard every genuine
 * remote edit made since the last sync.
 *
 * ## What is re-read, and what is not
 *
 * The base snapshot is only meaningful relative to the mapping it was recorded
 * under, so only the **mapping-governed** fields are re-read and re-decided:
 *
 *   - `status`     — `mapping.statuses` (always present; `openRemote` enforces
 *                    totality);
 *   - `assignee`   — `mapping.accounts`, when declared;
 *   - `period`     — `mapping.periods`, when declared;
 *   - attributes   — every name `mapping.attributes` declares.
 *
 * Everything else in a base — `title`, `body` (a hash) and the tracked
 * `dependsOn` edges — is **mapping-independent**, so it is preserved from the
 * stored base rather than re-read. A genuine title/body edit is what the normal
 * three-way merge (LP-257) catches on the next sync, against the base that is
 * still a valid common ancestor for those fields.
 *
 * ## Agree, or conflict — never force
 *
 * For each governed field the local value (from the board, in base vocabulary)
 * is compared with the remote value (from the fetched record, translated back
 * under the new mapping). Agreement writes the agreed value into the new base;
 * disagreement writes **nothing** for that field and marks the document
 * `conflicted`. Dropping the field — rather than keeping the stale value — is
 * what lets the normal merge re-derive the conflict on the next sync (both
 * sides differ from a base that no longer says either), and it is the reason
 * this is not the forbidden shortcut: local never wins by default.
 *
 * ## Partial completion, like a sync
 *
 * The re-base writes each document's base and persists the link store before
 * moving on, exactly as `applyChanges` and `executePush` do. A document whose
 * remote twin could not be read (a thrown fetch) is reported as failed and
 * left untouched; a re-run finishes it. The mapping fingerprint is the commit
 * marker for the batch: it is updated **only** when nothing failed, so a
 * re-base interrupted partway leaves the stored fingerprint pointing at the old
 * mapping and a re-run resumes rather than declaring victory. A twin that is
 * simply gone (`get` returns null) or a link with no local document is
 * reported but does not block the fingerprint — those are lifecycle (LP-361)
 * and board-health (orphaned links) concerns, not mapping ones.
 *
 * ## Read-only toward the remote
 *
 * The only connector method this touches is `get`. It never creates, updates,
 * deletes, links or comments — that is what makes it safe to suggest to a user
 * who is already unsure why their board stopped.
 */

import type { LoadedBoard } from '../core/board/load.js';
import type { IssueDto } from '../shared/model.js';
import type { BoardView } from '../shared/plans/reading.js';
import { toSnapshot } from '../sync/dto.js';
import type { Roster } from './accounts.js';
import { saveMappingSnapshot } from './fingerprint.js';
import type { LinkStore } from './links.js';
import { saveLinkStore, updateBase } from './links.js';
import type { PeriodIndex } from './periods.js';
import { attributeDefsOf, periodIndexOf, rosterOf } from './preflight.js';
import type { AttributeDefs, Connector, RemoteRecord, Translator } from './provider.js';
import type { OpenedRemote } from './remotes.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One field whose two sides disagree under the new mapping. */
export interface RebaseConflict {
  localId: string;
  /** The board field that diverged: `status`, `assignee`, `period` or an attribute name. */
  field: string;
  /** The local (board) value, in base vocabulary. */
  local: unknown;
  /** The remote value, translated back under the new mapping, in base vocabulary. */
  remote: unknown;
}

/** The outcome for one linked document. */
export interface RebaseOutcome {
  localId: string;
  remoteId: string;
  /** `rebased` when every governed field agreed; `conflicted` otherwise. */
  state: 'rebased' | 'conflicted';
  /**
   * The new base: the mapping-independent fields preserved from the old base,
   * plus the governed fields whose two sides agreed. A conflicted field is
   * absent, so the next sync's merge sees both sides changed.
   */
  base: Record<string, unknown>;
  conflicts: RebaseConflict[];
}

/** The pure re-base decision: one outcome per readable linked document. */
export interface RebasePlan {
  outcomes: RebaseOutcome[];
}

/** What the planner needs to translate the remote side. */
export interface RebaseOptions {
  translator: Translator;
  attributes: AttributeDefs;
  roster?: Roster;
  periods?: PeriodIndex;
}

/** What one re-base run reports. */
export interface RebaseReport {
  /** Every document that was re-read and planned. */
  outcomes: RebaseOutcome[];
  /** Local ids fully re-based (no conflicts), sorted. */
  rebased: string[];
  /** Local ids whose two sides disagree on at least one field, sorted. */
  conflicted: string[];
  /** A link whose remote twin was not found (`get` returned null). */
  unreadable: { localId: string; remoteId: string }[];
  /** A link whose local document no longer exists. */
  orphaned: { localId: string }[];
  /** A fetch that failed; blocks the fingerprint update. */
  failed: { localId: string; remoteId: string; error: string }[];
  /** True when the mapping fingerprint was written. */
  fingerprintUpdated: boolean;
  dryRun: boolean;
}

export interface ApplyRebaseOptions {
  /** Produce the report and write nothing. */
  dryRun?: boolean;
  /** Clock for the `syncedAt` written into each link. Injectable for tests. */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Which fields a mapping change can invalidate
// ---------------------------------------------------------------------------

/**
 * The field names a mapping change governs, and therefore the fields the
 * re-base re-reads. `title`, `body` and the tracked edges are deliberately
 * absent: the mapping never touches them, so their stored base stays a valid
 * common ancestor and is preserved.
 */
function governedFields(mapping: Record<string, unknown>): Set<string> {
  const fields = new Set<string>(['status']);
  if (mapping['accounts'] !== undefined) fields.add('assignee');
  if (mapping['periods'] !== undefined) fields.add('period');
  const attributes = mapping['attributes'];
  if (attributes && typeof attributes === 'object' && !Array.isArray(attributes)) {
    for (const name of Object.keys(attributes)) fields.add(name);
  }
  return fields;
}

/** The local value of a governed field, in base vocabulary. */
function localValueOf(doc: IssueDto, field: string): unknown {
  if (field === 'status') return doc.status;
  if (field === 'assignee') return doc.assignee ?? null;
  if (field === 'period') return doc.period ?? null;
  return doc.attributes[field] ?? null;
}

/** The remote value of a governed field, in base vocabulary. */
function remoteValueOf(patch: {
  status?: string;
  assignee?: string | null;
  period?: string | null;
  attributes?: Record<string, unknown>;
}, field: string): unknown {
  if (field === 'status') return patch.status ?? null;
  if (field === 'assignee') return patch.assignee ?? null;
  if (field === 'period') return patch.period ?? null;
  return patch.attributes?.[field] ?? null;
}

// ---------------------------------------------------------------------------
// Planning (pure)
// ---------------------------------------------------------------------------

/**
 * Plan a re-base: for every linked document whose two sides could be read,
 * decide the new base from the values that agree and collect the fields that
 * conflict. Pure: no disk, no network — `remoteRecords` is the already-fetched
 * remote side, keyed by local id, and everything else is read from its
 * arguments.
 *
 * A document is skipped (not in the plan) when its local document is gone or
 * its record was not fetched; the caller reports those as `orphaned` /
 * `unreadable` / `failed`.
 */
export function planRebase(
  board: BoardView,
  store: LinkStore,
  remoteRecords: ReadonlyMap<string, RemoteRecord>,
  mapping: Record<string, unknown>,
  options: RebaseOptions,
): RebasePlan {
  const governed = governedFields(mapping);
  const outcomes: RebaseOutcome[] = [];

  for (const localId of [...store.links.keys()].sort()) {
    const link = store.links.get(localId)!;
    const record = remoteRecords.get(localId);
    if (record === undefined) continue;
    const doc = board.nodes[localId];
    if (!doc || doc.kind !== 'issue') continue;

    const patch = options.translator.fieldsFromRecord(
      record,
      mapping,
      options.attributes,
      options.roster,
      options.periods,
    ).patch;

    // Preserve the mapping-independent fields of the old base; re-decide the
    // governed ones below.
    const base: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(link.base ?? {})) {
      if (!governed.has(key)) base[key] = value;
    }

    const conflicts: RebaseConflict[] = [];
    for (const field of [...governed].sort()) {
      const local = localValueOf(doc, field);
      const remote = remoteValueOf(patch, field);
      if (local === remote) {
        base[field] = local;
      } else {
        conflicts.push({ localId, field, local, remote });
      }
    }

    outcomes.push({
      localId,
      remoteId: link.remoteId,
      state: conflicts.length > 0 ? 'conflicted' : 'rebased',
      base,
      conflicts,
    });
  }

  return { outcomes };
}

// ---------------------------------------------------------------------------
// Applying (I/O)
// ---------------------------------------------------------------------------

/** An error message from any thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The board as the planner reads it. */
function viewOf(board: LoadedBoard): BoardView {
  const snapshot = toSnapshot(board);
  const nodes = Object.fromEntries(
    [...snapshot.issues, ...snapshot.periods, ...snapshot.resources, ...snapshot.templates].map(
      (node) => [node.id, node],
    ),
  );
  return { config: snapshot.config, nodes };
}

/**
 * Re-base one remote: fetch the remote side of every linked document, plan the
 * new bases, and — unless `dryRun` — write them back to the link store.
 *
 * Only `connector.get` is ever called; the remote is read, never written.
 * Each document's base is persisted before the next is touched, so an
 * interruption leaves the completed documents re-based. The mapping
 * fingerprint is updated only when nothing failed: it is the commit marker for
 * the batch, and a re-run finishes a partially-completed re-base.
 */
export async function applyRebase(
  board: LoadedBoard,
  remote: OpenedRemote,
  connector: Connector,
  store: LinkStore,
  options: ApplyRebaseOptions = {},
): Promise<RebaseReport> {
  const now = options.now ?? (() => new Date());
  const dryRun = options.dryRun === true;
  const mapping = remote.mapping;

  const view = viewOf(board);
  const attributes = attributeDefsOf(board);
  const roster = rosterOf(board);
  const periods = periodIndexOf(board);

  const remoteRecords = new Map<string, RemoteRecord>();
  const unreadable: RebaseReport['unreadable'] = [];
  const orphaned: RebaseReport['orphaned'] = [];
  const failed: RebaseReport['failed'] = [];

  // Read the remote side of every linked document. A gone twin and an orphaned
  // link are reported; only a thrown fetch is a failure (and blocks the
  // fingerprint), because a re-run cannot fix a stable absence but may fix a
  // transient error.
  for (const localId of [...store.links.keys()].sort()) {
    const link = store.links.get(localId)!;
    if (!view.nodes[localId] || view.nodes[localId]!.kind !== 'issue') {
      orphaned.push({ localId });
      continue;
    }

    let record: RemoteRecord | null;
    try {
      record = await connector.get(link.remoteId);
    } catch (error) {
      failed.push({ localId, remoteId: link.remoteId, error: messageOf(error) });
      continue;
    }
    if (record === null) {
      unreadable.push({ localId, remoteId: link.remoteId });
      continue;
    }
    remoteRecords.set(localId, record);
  }

  const plan = planRebase(view, store, remoteRecords, mapping, {
    translator: remote.provider.translator,
    attributes,
    roster,
    periods,
  });

  const rebased: string[] = [];
  const conflicted: string[] = [];

  for (const outcome of plan.outcomes) {
    if (outcome.state === 'rebased') rebased.push(outcome.localId);
    else conflicted.push(outcome.localId);

    if (dryRun) continue;
    const link = store.links.get(outcome.localId)!;
    // `remoteRev` is the remote's revision at the last sync; the re-base did
    // not write to the remote, so it stays as it was. `syncedAt` moves.
    updateBase(store, outcome.localId, outcome.base, link.remoteRev, now().toISOString());
    saveLinkStore(board.paths, remote.name, store);
  }

  const fingerprintUpdated = !dryRun && failed.length === 0;
  if (fingerprintUpdated) {
    saveMappingSnapshot(board.paths, remote.name, mapping);
  }

  return {
    outcomes: plan.outcomes,
    rebased,
    conflicted,
    unreadable,
    orphaned,
    failed,
    fingerprintUpdated,
    dryRun,
  };
}
