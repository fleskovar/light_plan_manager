/**
 * The field-by-field three-way merge (LP-284).
 *
 * Two people can edit the same linked document in two places between syncs.
 * Given the base snapshot — each mapped field's value as it stood when both
 * sides last agreed — a field is one of four cases, not two:
 *
 *   local vs base   remote vs base   outcome
 *   -------------   --------------   -------
 *   same            same             none
 *   changed         same             push
 *   same            changed          pull
 *   changed         changed          conflict
 *
 * This file owns the *decision* for one field and nothing more. It does not
 * say what a `push` or a `pull` means in operation terms (that is the
 * planners'), and it does not say how a `conflict` is resolved (that is the
 * policy story's, LP-286). Scalar fields end at the four-case table in
 * `mergeValues`; list-valued fields go through `mergeLists` below (LP-285),
 * which merges them element-by-element as sets — each side's additions and
 * removals against base are computed and applied together, so a value added on
 * both sides survives and a value removed on both sides is dropped, with only a
 * genuinely undecidable value reported as a per-element conflict.
 *
 * ## Normalisation
 *
 * Markdown from a remote often comes back with `\r\n`, a trailing newline
 * added or removed, and lists reordered.  Comparing raw values would report a
 * conflict for edits that agree, so every comparison goes through a canonical
 * form: strings are trimmed and line endings folded to `\n`, arrays are sorted
 * (a label, id or path list is a set — order is not load-bearing), and object
 * keys are sorted.  The base snapshot stores canonical forms too (`links.ts`
 * hashes the body and sorts lists), so local, remote and base all compare on
 * the same footing.  The body never reaches this function as raw text — it is
 * compared through `hashBody`, which already trims and strips the managed
 * block.
 *
 * ## No base
 *
 * A link created by *matching* rather than a previous sync has no base
 * snapshot.  With no base there is nothing to attribute a difference to, so a
 * field that differs between the two sides is a conflict — the only honest
 * answer short of clobbering one side or asking about everything.  A field
 * that is merely *absent from* a base that otherwise exists is a different
 * case and never reaches this function: the caller skips it, exactly as the
 * push planner's `diffIssue` does, because a field the base does not record
 * cannot be tracked and must not manufacture a phantom conflict.
 *
 * Pure: no imports, so this compiles for the browser exactly like the
 * planners.  No disk, no network, no clock.
 */

/**
 * The outcome of merging one field.  `none` means both sides already agree;
 * `push` / `pull` name the direction the agreed value has to travel; `conflict`
 * means both sides moved and neither value was derived from the other.
 */
export type MergeOutcome = 'none' | 'push' | 'pull' | 'conflict';

/**
 * The marker for "this document has no base snapshot", distinct from `null`
 * and `undefined` — either can be a legitimate base *value* (an unassigned
 * issue snapshots `assignee: null`).  Only the whole-document case uses it: a
 * base that exists but does not record a field is the caller's cue to skip the
 * field, not to pass `NO_BASE`.
 */
export const NO_BASE: unique symbol = Symbol('light-plan.no-base');

// ---------------------------------------------------------------------------
// Canonical forms
// ---------------------------------------------------------------------------

/** True for a plain object — recursable, unlike an array or a scalar. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A deterministic serialisation of a canonical value, for comparison and sort. */
function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  return JSON.stringify(value);
}

/**
 * The canonical form of a value, for comparison and for storage.
 *
 *   - strings are trimmed and `\r\n` / `\r` folded to `\n`, so a remote's
 *     line-ending and trailing-newline noise never disagrees with the board;
 *   - arrays are sorted by their elements' canonical forms, so list order does
 *     not matter;
 *   - plain-object keys are sorted, so key order does not matter.
 *
 * Scalars other than strings are returned unchanged.  The result is a plain
 * data value, never the input's identity — callers may store it.
 */
export function canonicalValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\r\n?/g, '\n').trim();
  }
  if (Array.isArray(value)) {
    return value.map(canonicalValue).sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalValue(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * True when two values agree in canonical form — trailing whitespace, line
 * endings, and list or key order ignored.
 */
export function valuesEqual(a: unknown, b: unknown): boolean {
  return stableStringify(canonicalValue(a)) === stableStringify(canonicalValue(b));
}

// ---------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------

/**
 * Decide one field's merge outcome from its local, remote and base values.
 *
 * `base` is `NO_BASE` when the document has no base snapshot (a link created by
 * matching, not by a previous sync); otherwise it is the concrete value the
 * base recorded, which may itself be `null` or `undefined`.
 *
 * Both sides agreeing is always `none` — whether or not either moved from
 * base, because a field two people edited to the same value needs no sync and
 * no resolution.  When they disagree: a side equal to base has not moved, so
 * the other side's value is the winner (`push` for the local edit, `pull` for
 * the remote one); when neither equals base — or there is no base to compare
 * against — the field is a `conflict`.
 */
export function mergeValues(local: unknown, remote: unknown, base: unknown): MergeOutcome {
  if (valuesEqual(local, remote)) return 'none';

  if (base === NO_BASE) return 'conflict';

  const localChanged = !valuesEqual(local, base);
  const remoteChanged = !valuesEqual(remote, base);

  if (localChanged && !remoteChanged) return 'push';
  if (!localChanged && remoteChanged) return 'pull';
  return 'conflict';
}

// ---------------------------------------------------------------------------
// List fields — per-element set merge (LP-285)
// ---------------------------------------------------------------------------

/**
 * The result of merging one list-valued field as a set.
 *
 * A list field is not one value that either side edits as a whole: it is a set
 * of elements (`labels`, `depends_on`, `relates_to`, `covers`), each of which
 * a side can add or remove on its own.  `mergeValues`'s four-case table is the
 * wrong granularity here — two people each adding a different label would read
 * as a whole-field conflict when the honest answer is that both additions
 * stick.  So the merge is per element:
 *
 *   - `localAdded` / `remoteAdded` are the values a side has that base did not;
 *   - `localRemoved` / `remoteRemoved` are the values base had that a side
 *     dropped;
 *   - `merged` is the set every value both sides can agree on: base minus both
 *     sides' removals, plus both sides' additions, minus the conflicting
 *     values;
 *   - `conflicts` are the values one side added and the other removed — the
 *     one genuinely undecidable case, reported one entry per value rather than
 *     once for the whole list.
 *
 * The caller applies `localAdded`/`localRemoved` toward the remote and
 * `remoteAdded`/`remoteRemoved` toward the board, and hands each `conflicts`
 * entry to the policy (`resolveByPolicy`) — exactly the per-element split the
 * story asks for, so one bad value never holds the whole list hostage.
 *
 * ## Labels the mapping does not claim
 *
 * `labels` is the one list field that can carry values the board has no word
 * for.  A label the mapping does not claim is not part of any field, so the
 * caller filters it out *before* merging and never returns it in the additions
 * or removals — that is what leaves it alone in both directions: a pull never
 * reads it into a board field, and a push's additions/removals never name it,
 * so nothing rewrites it.  The merge itself is deliberately field-agnostic and
 * trusts the caller to pass only the mapped values.
 *
 * ## Where a conflict can actually arise
 *
 * Against one consistent base a value cannot be both an addition and a removal:
 * "added" means base did not have it, "removed" means base did, and the two
 * never meet.  The four case table above is complete for a sound base, so
 * `conflicts` is empty there by construction.  The per-element conflict is
 * real for the **no-base** case — a link created by matching, with no snapshot
 * to attribute either side's list to — where every value exactly one side has
 * is reported as a single-value conflict rather than a whole-list one.  That
 * is deliberate and mirrors `mergeValues(…, NO_BASE)`, refined to elements.
 *
 * Pure: no imports, so this compiles for the browser exactly like the
 * planners.  No disk, no network, no clock.
 */
export interface ListMerge {
  /** The values both sides can agree on, sorted and de-duplicated. */
  merged: string[];
  /** Values one side added and the other removed, sorted and de-duplicated. */
  conflicts: string[];
  /** Values the local side added against base. */
  localAdded: string[];
  /** Values the local side removed against base. */
  localRemoved: string[];
  /** Values the remote side added against base. */
  remoteAdded: string[];
  /** Values the remote side removed against base. */
  remoteRemoved: string[];
}

/** The elements of a list field as canonical strings, de-duplicated and sorted. */
function listElements(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    const canonical = canonicalValue(entry);
    const key = typeof canonical === 'string' ? canonical : stableStringify(canonical);
    if (seen.has(key)) continue;
    seen.add(key);
  }
  return [...seen].sort();
}

/**
 * Merge a list-valued field as a set, element by element.
 *
 * `base` is `NO_BASE` when the document has no base snapshot; otherwise it is
 * the concrete list the base recorded.  With a base, each side's additions and
 * removals are computed against it and combined — the two never conflict, and
 * the merged set carries both sides' additions.  With no base, the values both
 * sides share are the merged set and every value exactly one side has is a
 * per-element conflict, so a difference is never upgraded to a whole-list one.
 */
export function mergeLists(local: unknown, remote: unknown, base: unknown): ListMerge {
  const localSet = new Set(listElements(local));
  const remoteSet = new Set(listElements(remote));

  if (base === NO_BASE) {
    const merged: string[] = [];
    const conflicts: string[] = [];
    for (const value of localSet) {
      if (remoteSet.has(value)) merged.push(value);
      else conflicts.push(value);
    }
    for (const value of remoteSet) {
      if (!localSet.has(value)) conflicts.push(value);
    }
    return {
      merged: merged.sort(),
      conflicts: conflicts.sort(),
      localAdded: [],
      localRemoved: [],
      remoteAdded: [],
      remoteRemoved: [],
    };
  }

  const baseSet = new Set(listElements(base));

  const localAdded = [...localSet].filter((value) => !baseSet.has(value));
  const localRemoved = [...baseSet].filter((value) => !localSet.has(value));
  const remoteAdded = [...remoteSet].filter((value) => !baseSet.has(value));
  const remoteRemoved = [...baseSet].filter((value) => !remoteSet.has(value));

  // A value added by one side and removed by the other is the one per-element
  // conflict.  Against a sound base it is empty (see the interface doc); the
  // formula is still spelled out so a hand-edited base cannot manufacture a
  // silent drop.
  const conflicts = [...new Set([
    ...localAdded.filter((value) => remoteRemoved.includes(value)),
    ...remoteAdded.filter((value) => localRemoved.includes(value)),
  ])].sort();
  const conflictSet = new Set(conflicts);
  const removed = new Set([...localRemoved, ...remoteRemoved]);

  const merged = new Set<string>();
  for (const value of baseSet) if (!removed.has(value)) merged.add(value);
  for (const value of localAdded) if (!conflictSet.has(value)) merged.add(value);
  for (const value of remoteAdded) if (!conflictSet.has(value)) merged.add(value);

  return {
    merged: [...merged].sort(),
    conflicts,
    localAdded: localAdded.sort(),
    localRemoved: localRemoved.sort(),
    remoteAdded: remoteAdded.sort(),
    remoteRemoved: remoteRemoved.sort(),
  };
}
