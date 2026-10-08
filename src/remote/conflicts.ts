/**
 * The conflict driver (LP-287) — the merge across a whole linked document,
 * policy and pending resolutions applied.
 *
 * `merge.ts` decides one field's four cases; `policy.ts` breaks a conflict
 * from the remote's config; `resolutions.ts` holds a person's pending
 * decisions.  This file is the composition the CLI `lpm remote status` prints
 * and the sync will run: for every linked document, compare each tracked field
 * against its base snapshot and the remote side, apply policy then pending
 * resolutions, and report what is left as a conflict.
 *
 * ## Purity
 *
 * The planner itself is pure: no disk, no network.  The remote side arrives
 * as `remotePatches` — already-fetched records the caller translated back to
 * board vocabulary through the provider's `fieldsFromRecord` — and the local
 * side is read from a `BoardView` DTO.  The one Node-ism is `hashBody`
 * (imported from `links.ts`), because a base snapshot stores the body as a
 * `sha256:` hash and the merge must compare hash to hash.  That keeps this
 * file for the CLI and the sync, not the browser — the web conflict panel
 * (LP-346) reads conflicts the server already computed.
 *
 * ## Which fields
 *
 * The tracked fields are the ones the mapping can carry: `title`, `body` and
 * `status` always, `assignee` / `period` when those mappings are declared,
 * and every name in `mapping.attributes`.  A field the base snapshot does not
 * record is skipped rather than merged against nothing — the same rule the
 * push planner's `diffIssue` applies, so a new attribute never manufactures a
 * phantom conflict.  A document with no base at all (a twin recorded but never
 * confirmed) merges every tracked field with `NO_BASE`, so a difference is a
 * conflict, the only honest answer short of clobbering a side.
 */

import type { IssueDto } from '../shared/model.js';
import type { BoardView } from '../shared/plans/reading.js';
import type { RemoteFieldOwner, RemoteConflictPolicy } from '../core/model/types.js';
import { hashBody } from './links.js';
import type { LinkStore } from './links.js';
import { mergeValues, NO_BASE, type MergeOutcome } from './merge.js';
import { effectivePolicy, resolveByPolicy } from './policy.js';
import type { BoardFieldsPatch } from './provider.js';
import type { ResolutionOwner, ResolutionStore } from './resolutions.js';
import { ownerFor } from './resolutions.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One field's merge, after policy and pending resolutions. */
export interface FieldMerge {
  /** The board field name: `title`, `body`, `status`, … or an attribute name. */
  field: string;
  /** The local (board) value, in board vocabulary. Body is the raw text. */
  local: unknown;
  /** The remote value, translated back to board vocabulary. Body is the raw text. */
  remote: unknown;
  /** The base value: the stored snapshot, or `NO_BASE` when there was none. */
  base: unknown;
  /** The raw four-case merge, before policy and resolutions. */
  merge: MergeOutcome;
  /** What the sync will actually do, after policy and resolutions. */
  outcome: MergeOutcome;
  /** The side whose edit was discarded by a policy or resolution, when one was. */
  overwrote?: 'local' | 'remote';
  /** The pending resolution that broke this conflict, when one did. */
  resolution?: ResolutionOwner;
}

/** One linked document's merge. */
export interface DocumentMerge {
  localId: string;
  remoteId: string;
  /** Every tracked field, sorted by name. */
  fields: FieldMerge[];
  /** The subset whose `outcome` is `conflict` — what a human must settle. */
  conflicts: FieldMerge[];
  /** The subset a pending resolution will break on the next sync. */
  pending: FieldMerge[];
}

/** The pure conflict plan for a whole board. */
export interface ConflictPlan {
  documents: DocumentMerge[];
}

/** The policy and resolution layers `planConflicts` composes. */
export interface ConflictOptions {
  /** The remote's default conflict policy. */
  conflict: RemoteConflictPolicy;
  /** The remote's per-field owner overrides, keyed by field name. */
  overrides: Readonly<Record<string, RemoteFieldOwner>>;
  /** Pending resolutions recorded by `lpm remote resolve`. */
  resolutions: ResolutionStore;
  /**
   * A board body as it will read after a round trip through the remote's own
   * body format (`Translator.normalizeBody`). The base records the body the
   * remote echoed, so a provider whose bodies are not markdown — Jira's ADF
   * has paragraphs but no source line breaks — needs the local side put
   * through the same conversion or every hard-wrapped document reads as an
   * un-pushed edit that no one made.
   */
  normalizeBody?: (markdown: string) => string;
}

// ---------------------------------------------------------------------------
// Tracked fields
// ---------------------------------------------------------------------------

/**
 * The field names the merge tracks, derived from the mapping: `title`, `body`
 * and `status` always, `assignee` / `period` when those mappings exist, and
 * every attribute the mapping declares.  `lpm remote resolve` uses this to
 * validate a `--field` argument offline.
 */
export function trackedFields(mapping: Record<string, unknown>): Set<string> {
  const fields = new Set<string>(['title', 'body', 'status']);
  if (mapping['accounts'] !== undefined) fields.add('assignee');
  if (mapping['periods'] !== undefined) fields.add('period');
  const attributes = mapping['attributes'];
  if (attributes && typeof attributes === 'object' && !Array.isArray(attributes)) {
    for (const name of Object.keys(attributes)) fields.add(name);
  }
  // The effort attribute (Linear's native `estimate` — LP-333) is a tracked
  // field too, so the merge and `lpm remote resolve --field` know it exists.
  const effort = mapping['effort'];
  if (effort && typeof effort === 'object' && !Array.isArray(effort)) {
    const attribute = (effort as Record<string, unknown>)['attribute'];
    if (typeof attribute === 'string' && attribute !== '') fields.add(attribute);
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Value accessors
// ---------------------------------------------------------------------------

/** The local value of a tracked field, in board vocabulary. */
export function localValueOf(doc: IssueDto, field: string): unknown {
  if (field === 'title') return doc.title;
  if (field === 'body') return doc.body;
  if (field === 'status') return doc.status;
  if (field === 'assignee') return doc.assignee ?? null;
  if (field === 'period') return doc.period ?? null;
  return doc.attributes[field] ?? null;
}

/** The remote value of a tracked field, in board vocabulary. */
function remoteValueOf(patch: BoardFieldsPatch, field: string): unknown {
  if (field === 'title') return patch.title ?? null;
  if (field === 'body') return patch.body ?? '';
  if (field === 'status') return patch.status ?? null;
  if (field === 'assignee') return patch.assignee ?? null;
  if (field === 'period') return patch.period ?? null;
  return patch.attributes?.[field] ?? null;
}

/**
 * True when the remote side actually carries `field` — a value the translator
 * recovered, not one invented as absent.  A field the remote does not carry
 * (a status whose labels do not resolve, an attribute the mapping does not
 * read back) has no remote value to compare, so the merge skips it rather than
 * manufacturing a conflict against `null`.
 */
function remoteCarries(patch: BoardFieldsPatch, field: string): boolean {
  if (field === 'title') return patch.title !== undefined;
  if (field === 'body') return patch.body !== undefined;
  if (field === 'status') return patch.status !== undefined;
  if (field === 'assignee') return patch.assignee !== undefined;
  if (field === 'period') return patch.period !== undefined;
  return patch.attributes !== undefined && field in patch.attributes;
}

// ---------------------------------------------------------------------------
// Planning (pure)
// ---------------------------------------------------------------------------

/**
 * Merge one tracked field of one document: the four-case decision, then the
 * policy, then a pending resolution.
 *
 * The body is compared as a hash (`hashBody`) because that is what the base
 * stores; the reported `local` / `remote` stay the raw text so a renderer can
 * show what a person wrote.
 */
function mergeField(
  doc: IssueDto,
  patch: BoardFieldsPatch,
  field: string,
  base: unknown,
  options: ConflictOptions,
  localId: string,
): FieldMerge {
  const local = localValueOf(doc, field);
  const remote = remoteValueOf(patch, field);

  const localComparable = field === 'body' ? hashBody(String(local), options.normalizeBody) : local;
  const remoteComparable = field === 'body' ? hashBody(String(remote)) : remote;

  const merge = mergeValues(localComparable, remoteComparable, base);

  const resolution = ownerFor(options.resolutions, localId, field);
  const policy = resolution ?? effectivePolicy(field, options.conflict, options.overrides);
  const resolved = resolveByPolicy(merge, policy);

  return {
    field,
    local,
    remote,
    base,
    merge,
    outcome: resolved.outcome,
    overwrote: resolved.overwrote,
    resolution,
  };
}

/**
 * Plan the merge for every linked document whose remote side was supplied.
 *
 * Documents with no remote patch are skipped — the caller reports them as
 * unreadable or failed, exactly as `applyRebase` does.  A document with no
 * base merges every tracked field against `NO_BASE`; one with a base merges
 * only the fields the base records, skipping the rest.
 */
export function planConflicts(
  board: BoardView,
  store: LinkStore,
  remotePatches: ReadonlyMap<string, BoardFieldsPatch>,
  options: ConflictOptions,
  fields: ReadonlySet<string>,
): ConflictPlan {
  const documents: DocumentMerge[] = [];

  for (const localId of [...store.links.keys()].sort()) {
    const patch = remotePatches.get(localId);
    if (patch === undefined) continue;
    const doc = board.nodes[localId];
    if (!doc || doc.kind !== 'issue') continue;

    const link = store.links.get(localId)!;
    const hasBase = link.base !== undefined;

    const merged: FieldMerge[] = [];
    for (const field of [...fields].sort()) {
      if (!remoteCarries(patch, field)) continue;
      if (hasBase && !(field in (link.base as Record<string, unknown>))) continue;
      const base = hasBase ? (link.base as Record<string, unknown>)[field] : NO_BASE;
      merged.push(mergeField(doc, patch, field, base, options, localId));
    }

    documents.push({
      localId,
      remoteId: link.remoteId,
      fields: merged,
      conflicts: merged.filter((entry) => entry.outcome === 'conflict'),
      pending: merged.filter(
        (entry) => entry.merge === 'conflict' && entry.resolution !== undefined,
      ),
    });
  }

  return { documents };
}
