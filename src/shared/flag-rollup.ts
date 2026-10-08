/**
 * The single definition of "does a container stand in front of stopped work?",
 * so the engine (`core/board/flag-rollup.ts`), `lpm check` and the browser
 * cannot disagree about which parents are showing red.
 *
 * A flag says work has stopped and needs a person. Whoever is running the plan
 * reads the board from the top, and a story flagged four levels down was
 * invisible from there: the epic looked like every other epic, and the only way
 * to find the stall was to open everything. So a flag carries upward, the way a
 * closed story closes its feature — `src/shared/rollup.ts` is the same idea
 * applied to status, and this file is deliberately shaped like it.
 *
 * Four rules, and the roll-up is wrong without any of them:
 *
 *   - **A derived flag is a different word from a raised one.** `DERIVED_FLAG`
 *     is the only value this writes and the only value it clears. A person
 *     cannot raise it (`flagIssue` refuses it) and the roll-up never touches
 *     `blocked`, `paused` or `help`, so "somebody stopped this" and "something
 *     inside this stopped" stay two facts and the canvas can draw them
 *     differently. Without that there is no way to clear a derived flag safely:
 *     a feature nobody flagged and a feature somebody paused look identical.
 *   - **A flag of the container's own outranks the derived one.** A feature
 *     already flagged `paused` says something more specific than "work inside
 *     stopped", and overwriting it would lose it. It is left exactly as it is.
 *   - **Clearing follows the last flag out.** When nothing inside is flagged any
 *     more, the derived flag goes — that is the whole of "if all the children
 *     are not flagged, its flag should also be cleared", and it is what stops
 *     the board silting up with red nobody can act on.
 *   - **A leaf answers for itself.** A node with nothing inside it is never
 *     touched by the roll-up, in either direction.
 *
 * Imports nothing, so it compiles for Node and for the browser alike.
 */

/**
 * The flag a container carries because something inside it has stopped.
 *
 * Its own word rather than the child's, because the reason belongs to the issue
 * that has it: a story flagged `help` needs a person, and the epic above it does
 * not — what the epic has is stopped work somewhere underneath.
 */
export const DERIVED_FLAG = 'inside';

/** True for the flag the roll-up writes, as opposed to one somebody raised. */
export function isDerivedFlag(flag: string | null | undefined): boolean {
  return flag === DERIVED_FLAG;
}

/** Everything the walk needs about the issue tree, asked by id. */
export interface FlagLookup {
  /** The issue this one sits under, or null at the top of the collection. */
  parentOf(id: string): string | null;
  /** The issues directly inside this one. */
  childIdsOf(id: string): readonly string[];
  /** The flag this issue carries, or null. */
  flagOf(id: string): string | null;
}

/** A flag a parent should gain or lose, because of what is inside it. */
export interface FlagRollup {
  id: string;
  from: string | null;
  to: string | null;
}

/**
 * The flag a parent holding these children should have, or null when the one it
 * has already says the truth.
 *
 * `children` are the flags of the issues directly inside it — `null` for each
 * one that is not flagged. A parent with nothing inside it answers for itself
 * and is never touched.
 */
export function rolledUpFlag(
  current: string | null,
  children: readonly (string | null)[],
): FlagRollup['to'] | undefined {
  if (!children.length) return undefined;

  if (children.some((flag) => Boolean(flag))) {
    // Already saying something — its own flag, or this one already written.
    return current ? undefined : DERIVED_FLAG;
  }

  // Nothing stopped inside any more. Only the flag this put there comes off:
  // a `paused` somebody typed on the container is theirs to clear.
  return isDerivedFlag(current) ? null : undefined;
}

/**
 * Walk up from an issue whose flag just changed and report every ancestor that
 * has to change with it, nearest first.
 *
 * `lookup.flagOf` must already answer with the *new* flag of everything that
 * moved; each roll-up this returns is folded into the walk, so clearing the last
 * flag in a feature clears the epic above it too.
 *
 * Stops at the first ancestor that does not change: nothing above it saw its
 * contents change either.
 */
export function flagRollupsUpward(from: string, lookup: FlagLookup): FlagRollup[] {
  const moved = new Map<string, string | null>();
  const flagOf = (id: string): string | null =>
    moved.has(id) ? moved.get(id)! : lookup.flagOf(id);
  const out: FlagRollup[] = [];
  const seen = new Set<string>([from]);

  let current = lookup.parentOf(from);
  while (current && !seen.has(current)) {
    seen.add(current);
    const was = flagOf(current);
    const next = rolledUpFlag(was, lookup.childIdsOf(current).map(flagOf));
    if (next === undefined) break;
    moved.set(current, next);
    out.push({ id: current, from: was, to: next });
    current = lookup.parentOf(current);
  }

  return out;
}

/**
 * Every parent on a board whose flag disagrees with what is inside it, in an
 * order that can be applied as it stands.
 *
 * `ids` must be ordered deepest-first, so a feature is decided before the epic
 * above it and one pass carries a flagged story all the way up. This is what
 * `lpm check` reports and what `--fix` writes.
 */
export function flagRollupsAcross(ids: readonly string[], lookup: FlagLookup): FlagRollup[] {
  const moved = new Map<string, string | null>();
  const flagOf = (id: string): string | null =>
    moved.has(id) ? moved.get(id)! : lookup.flagOf(id);
  const out: FlagRollup[] = [];

  for (const id of ids) {
    const children = lookup.childIdsOf(id);
    if (!children.length) continue;
    const was = flagOf(id);
    const next = rolledUpFlag(was, children.map(flagOf));
    if (next === undefined) continue;
    moved.set(id, next);
    out.push({ id, from: was, to: next });
  }

  return out;
}
