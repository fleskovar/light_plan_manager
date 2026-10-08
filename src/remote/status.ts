/**
 * The drift report (LP-342) — the pure half of `lpm remote status`.
 *
 * `conflicts.ts` already merges every linked document's fields against their
 * base snapshots; this file is the *classification* on top of it.  It turns a
 * board, a link store and (when they could be fetched) the remote patches into
 * the five buckets the story names — ahead, behind, conflicted, unlinked,
 * orphaned — plus the three the story's buckets deliberately leave out
 * (decoupled, unreadable, failed), all in one `RemoteStatusReport`.
 *
 * ## Pure, with one async half
 *
 * This file is pure: no disk, no network.  The remote side arrives as
 * `patches` (already-fetched records translated back to board vocabulary), or
 * as `null` plus a `remoteMissing` reason when it could not be read at all —
 * no credentials, no network.  The caller (the CLI) owns the fetch and the
 * connector; this file owns the answer.  That split is what makes the
 * no-credentials criterion testable offline: the local half (ahead, unlinked,
 * orphaned, decoupled) is computed from the board and the link store alone.
 *
 * ## Ahead offline vs ahead merged
 *
 * With the remote side, `ahead` / `behind` / `conflicted` come from the
 * three-way merge (`planConflicts`): a field is `push`, `pull` or `conflict`.
 * Without it, `behind` and `conflicted` cannot exist, and `ahead` is the
 * weaker claim "the local side differs from its base snapshot" — un-pushed
 * local edits, whatever the remote may also have done.  The report says the
 * remote half is missing rather than pretending the weaker claim is the full
 * one.
 */

import type { IssueDto } from '../shared/model.js';
import type { BoardView } from '../shared/plans/reading.js';
import { subtreeIds } from '../shared/plans/reading.js';
import type {
  RemoteStatusDecoupled,
  RemoteStatusField,
  RemoteStatusBlocked,
  RemoteStatusBlockedField,
  RemoteStatusIncoming,
  RemoteStatusReport,
} from '../shared/remote-status.js';
import type { ConflictOptions } from './conflicts.js';
import { localValueOf, planConflicts } from './conflicts.js';
import { hashBody } from './links.js';
import type { LinkStore } from './links.js';
import { NO_BASE, valuesEqual } from './merge.js';
import type { BoardFieldsPatch } from './provider.js';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** What the caller knows about a field the remote will not take. */
export type UnwritableField = Omit<RemoteStatusBlockedField, 'field'>;

/** What `planStatus` needs: the board, the store, the remote's frame, and the remote side or its absence. */
export interface StatusInputs {
  board: BoardView;
  store: LinkStore;
  /** The remote's scope root id; absent means the whole board is in scope. */
  scope?: string;
  /** Conflict policy, overrides and pending resolutions — what `planConflicts` composes. */
  options: ConflictOptions;
  /** The tracked field names, derived from the mapping. */
  fields: ReadonlySet<string>;
  /** Fetched remote patches, or null when the remote could not be read. */
  patches: ReadonlyMap<string, BoardFieldsPatch> | null;
  /** Why the remote could not be read, when it could not. */
  remoteMissing?: string;
  /**
   * Remote name / provider / target / scope / last sync, for the report's header.
   *
   * `inScope` and `mirrored` are deliberately **not** the caller's to supply:
   * they are arithmetic over the same scope set the buckets are filtered by, and
   * a caller that computed them separately could hand back a denominator that
   * disagreed with the numerators beside it.
   */
  remote: Omit<RemoteStatusReport['remote'], 'inScope' | 'mirrored'>;
  /** The documents a fetch failed for, keyed by local id (caller-collected). */
  failed?: RemoteStatusReport['failed'];
  /** The documents whose twin was not found, keyed by local id (caller-collected). */
  unreadable?: RemoteStatusReport['unreadable'];
  /**
   * Remote issues with no twin, in the order the caller found them.
   *
   * Caller-collected for the same reason `patches` is: this file is pure and
   * the listing is a request. Absent when the remote was not read, which is
   * why the report's own field defaults to empty rather than to unknown — "no
   * incoming work" and "nobody looked" are told apart by `remoteMissing`.
   */
  incoming?: readonly RemoteStatusIncoming[];
  /** How many remote issues the listing returned, when it was read. */
  remoteRead?: number;
  /** The remote half came from an incremental listing — absence proves nothing. */
  incremental?: boolean;
  /**
   * Fields this remote cannot take, per document: `localId → field → reason`.
   *
   * Supplied by the caller because it comes from the *provider's* translator and
   * this file knows nothing about providers. Absent means "nothing is known to be
   * unwritable", which reports no document as blocked — the honest default, since
   * a caller that cannot ask the translator must not claim a change will land.
   */
  unwritable?: ReadonlyMap<string, ReadonlyMap<string, UnwritableField>>;
  /** Populate the per-field `fields` detail — `--verbose`. */
  verbose?: boolean;
}

// ---------------------------------------------------------------------------
// Scope and the local-side buckets
// ---------------------------------------------------------------------------

/** True when `id` is inside the remote's scope. A null scope holds everything. */
function inScopeOf(scopeSet: ReadonlySet<string> | null, id: string): boolean {
  return scopeSet === null || scopeSet.has(id);
}

/**
 * The fields a document differs from its base snapshot on, for the offline
 * `ahead` half.  A document with no base differs on every tracked field — its
 * twin was recorded but never confirmed, so everything is un-pushed.
 */
function localAheadFields(
  doc: IssueDto,
  base: Record<string, unknown> | undefined,
  fields: ReadonlySet<string>,
  normalizeBody?: (markdown: string) => string,
): string[] {
  if (base === undefined) return [...fields].sort();
  const changed: string[] = [];
  for (const field of [...fields].sort()) {
    if (!(field in base)) continue; // a field the base does not record is not tracked
    const local = localValueOf(doc, field);
    const comparable = field === 'body' ? hashBody(String(local), normalizeBody) : local;
    if (!valuesEqual(comparable, base[field])) changed.push(field);
  }
  return changed;
}

/**
 * Is this document ahead *only* on fields the remote cannot take?
 *
 * "Only" is the whole test. A document ahead on an unwritable assignee **and** a
 * title is going to have its title written, so it is ordinary pending work and
 * must stay in the headline; one ahead on nothing but the assignee will still be
 * ahead after every sync anybody ever runs. Returning the blocked fields rather
 * than a boolean is what lets the report say *why* without a second lookup.
 */
function blockedEntryOf(
  localId: string,
  changed: readonly string[],
  unwritable: ReadonlyMap<string, ReadonlyMap<string, UnwritableField>> | undefined,
): RemoteStatusBlocked | undefined {
  if (unwritable === undefined || changed.length === 0) return undefined;
  const fields = unwritable.get(localId);
  if (fields === undefined) return undefined;
  if (!changed.every((field) => fields.has(field))) return undefined;
  return {
    localId,
    fields: changed.map((field) => {
      const entry = fields.get(field)!;
      return {
        field,
        reason: entry.reason,
        ...(entry.remedy !== undefined ? { remedy: entry.remedy } : {}),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Planning (pure)
// ---------------------------------------------------------------------------

/**
 * Classify the whole board's drift into a `RemoteStatusReport`.
 *
 * With `patches` (the remote side readable) every linked document is merged
 * through `planConflicts` and each field's `outcome` (after policy and pending
 * resolutions) places the document: `push` → ahead, `pull` → behind,
 * `conflict` → conflicted.  A document can sit in several buckets at once — a
 * title edited locally while a status moved upstream is ahead *and* behind —
 * and `--verbose`'s field detail is what disambiguates a mixed case.
 *
 * With `patches === null` the report carries `remoteMissing`, `behind` and
 * `conflicted` are empty (they cannot be computed), and `ahead` is the offline
 * half: every linked, in-scope document that differs from its base.
 */
export function planStatus(inputs: StatusInputs): RemoteStatusReport {
  const { board, store, options, fields } = inputs;
  const scopeSet =
    inputs.scope !== undefined ? new Set(subtreeIds(board, inputs.scope)) : null;

  const issues = Object.values(board.nodes).filter(
    (node): node is IssueDto => node.kind === 'issue',
  );

  // -- unlinked: in-scope issues with no link and no tombstone --------------
  const unlinked = issues
    .filter(
      (issue) =>
        inScopeOf(scopeSet, issue.id) &&
        !store.links.has(issue.id) &&
        !store.tombstones.has(issue.id),
    )
    .map((issue) => issue.id)
    .sort();

  // -- orphaned: links whose local document is gone -------------------------
  const orphaned = [...store.links.keys()]
    .filter((id) => {
      const node = board.nodes[id];
      return !node || node.kind !== 'issue';
    })
    .sort();

  // -- decoupled: tombstones, sorted ----------------------------------------
  const decoupled: RemoteStatusDecoupled[] = [...store.tombstones.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([localId, tombstone]) => ({
      localId,
      reason: tombstone.reason,
      remoteKey: tombstone.remoteKey,
    }));

  // The denominator, from the same scope set the buckets are filtered by, so a
  // count can never be reported against a total that disagrees with it.
  const inScope = issues.filter((issue) => inScopeOf(scopeSet, issue.id)).length;
  const mirrored = issues.filter(
    (issue) => inScopeOf(scopeSet, issue.id) && store.links.has(issue.id),
  ).length;

  const blocked: RemoteStatusBlocked[] = [];

  const report: RemoteStatusReport = {
    remote: { ...inputs.remote, inScope, mirrored },
    ahead: [],
    blocked,
    behind: [],
    conflicted: [],
    unlinked,
    incoming: [...(inputs.incoming ?? [])],
    orphaned,
    decoupled,
    unreadable: inputs.unreadable ?? [],
    failed: inputs.failed ?? [],
  };

  if (inputs.remoteRead !== undefined) report.remoteRead = inputs.remoteRead;
  if (inputs.incremental === true) report.incremental = true;

  // The remote twin of every linked document, so a reader (the side panel) can
  // turn a local id into its remote url without a second fetch.
  report.links = Object.fromEntries(
    [...store.links.entries()].map(([localId, link]) => [
      localId,
      { remoteId: link.remoteId, remoteKey: link.remoteKey, remoteUrl: link.remoteUrl },
    ]),
  );

  if (inputs.remoteMissing !== undefined) {
    report.remoteMissing = inputs.remoteMissing;
  }

  // -- the merge, when the remote side was read -----------------------------
  if (inputs.patches === null) {
    // Offline half: ahead = local differs from base, for every linked,
    // in-scope issue.  Behind and conflict need the remote and stay empty.
    const detail: Record<string, RemoteStatusField[]> = {};
    const ahead: string[] = [];
    for (const issue of issues) {
      if (!inScopeOf(scopeSet, issue.id) || !store.links.has(issue.id)) continue;
      const base = store.links.get(issue.id)!.base;
      const changed = localAheadFields(issue, base, fields, options.normalizeBody);
      if (changed.length === 0) continue;
      ahead.push(issue.id);
      const entry = blockedEntryOf(issue.id, changed, inputs.unwritable);
      if (entry !== undefined) blocked.push(entry);
      // `--verbose` answers here too. It used to return before this, so the
      // one report a reader can have instantly could say "440 documents are
      // ahead" and not one word about *what* — which is the difference
      // between a number and something somebody can act on.
      if (inputs.verbose === true) {
        detail[issue.id] = changed.map((field) => ({
          field,
          local: localValueOf(issue, field),
          remote: null,
          base: base === undefined ? null : (base[field] ?? null),
          outcome: 'push' as const,
        }));
      }
    }
    report.ahead = ahead.sort();
    blocked.sort((a, b) => a.localId.localeCompare(b.localId));
    if (Object.keys(detail).length > 0) report.fields = detail;
    return report;
  }

  const plan = planConflicts(board, store, inputs.patches, options, fields);
  const detail: Record<string, RemoteStatusField[]> = {};
  const wantFields = inputs.verbose === true;

  for (const doc of plan.documents) {
    const fieldsWithAction = doc.fields.filter((entry) => entry.outcome !== 'none');

    if (fieldsWithAction.some((entry) => entry.outcome === 'conflict')) {
      report.conflicted.push(doc.localId);
    }
    const pushed = fieldsWithAction.filter((entry) => entry.outcome === 'push');
    if (pushed.length > 0) {
      report.ahead.push(doc.localId);
      // Only a document that is *exclusively* ahead on unwritable fields is
      // blocked; a `pull` or a `conflict` on the same document says nothing
      // about whether its push will land.
      const entry = blockedEntryOf(
        doc.localId,
        pushed.map((field) => field.field),
        inputs.unwritable,
      );
      if (entry !== undefined) blocked.push(entry);
    }
    if (fieldsWithAction.some((entry) => entry.outcome === 'pull')) {
      report.behind.push(doc.localId);
    }

    if (fieldsWithAction.length > 0 && wantFields) {
      detail[doc.localId] = fieldsWithAction.map((entry) => ({
        field: entry.field,
        local: entry.local,
        remote: entry.remote,
        base: entry.base === NO_BASE ? null : entry.base,
        outcome: entry.outcome,
      }));
    }
  }

  if (Object.keys(detail).length > 0) {
    report.fields = detail;
  }
  blocked.sort((a, b) => a.localId.localeCompare(b.localId));
  return report;
}
