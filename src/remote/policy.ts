/**
 * Conflict policy resolution (LP-286).
 *
 * The three-way merge (`merge.ts`) ends at the four-case table and names a
 * disagreement `conflict` without saying whose value wins. This file decides.
 * A remote declares a default `conflict` policy — `manual`, `local` or
 * `remote` — and may pin individual fields to an owner, so a board whose
 * tracker runs the workflow can say `fields: { status: { owner: remote } }`
 * and never see status come back as a conflict: the remote simply wins.
 *
 * Resolution is per field and nothing else. A `push` or `pull` outcome already
 * has a winner (only one side moved), so policy is not consulted and nothing
 * is overwritten; a `conflict` outcome is the only one a policy can break.
 * Breaking a conflict in favour of one side *overwrites the other side's
 * edit*, and that fact is part of the result — the caller reports it rather
 * than dropping it silently. A "remote edit overwritten" line is the whole
 * difference between a policy and a clobber.
 *
 * ## The field vocabulary
 *
 * `fields:` and the merge caller name fields with the board's own spellings:
 * the canonical document fields (`title`, `body`, `status`, `assignee`,
 * `period`, `depends_on`, `relates_to`, `related_files`) plus a declared
 * attribute by its bare name (`story_points`). This is the frontmatter a
 * person reads in the `.lpm` files, not the camelCase DTO spelling — `status`
 * is the worked example, and it never conflicts when owned.
 *
 * Pure: every import is type-only, so this compiles for the browser exactly
 * like the planners and `merge.ts`. No disk, no network, no clock.
 */

import type { RemoteConflictPolicy, RemoteFieldOwner } from '../core/model/types.js';
import type { MergeOutcome } from './merge.js';

/**
 * A merge outcome after policy. `outcome` is what the sync actually does; when
 * a conflict was broken in favour of one side, `overwrote` names the side
 * whose edit was discarded — `local` means "the board edit was overwritten by
 * the remote", `remote` the reverse. Absent when nothing was overwritten: a
 * one-sided change, an agreement, or a conflict left for a human (`manual`).
 */
export interface ResolvedOutcome {
  outcome: MergeOutcome;
  /** The side whose edit was discarded by a policy decision, when one was. */
  overwrote?: 'local' | 'remote';
}

/**
 * Resolve one field's merge outcome under a policy.
 *
 * Non-conflict outcomes pass through unchanged — a `push` or `pull` already
 * names the winner and has nothing to overwrite. A `conflict` is the one a
 * policy decides:
 *
 *   - `manual` leaves it a conflict: neither side moves, the caller reports it
 *     and waits for `lpm remote resolve` (LP-287);
 *   - `local`  resolves to a push and overwrites the remote edit;
 *   - `remote` resolves to a pull and overwrites the local edit.
 */
export function resolveByPolicy(
  merge: MergeOutcome,
  policy: RemoteConflictPolicy,
): ResolvedOutcome {
  if (merge !== 'conflict') return { outcome: merge };
  switch (policy) {
    case 'manual':
      return { outcome: 'conflict' };
    case 'local':
      return { outcome: 'push', overwrote: 'remote' };
    case 'remote':
      return { outcome: 'pull', overwrote: 'local' };
  }
}

/**
 * The policy in force for one field: its per-field owner override when one is
 * declared, otherwise the remote's default `conflict` policy.
 *
 * `overrides` is the flattened `fields:` block (field name → owner), exactly
 * as core's config schema stores it. An owner is always `local` or `remote` —
 * a field with an owner never conflicts — so the returned policy is the owner,
 * or the default when the field has none.
 */
export function effectivePolicy(
  field: string,
  conflict: RemoteConflictPolicy,
  overrides?: Readonly<Record<string, RemoteFieldOwner>>,
): RemoteConflictPolicy {
  return overrides?.[field] ?? conflict;
}
