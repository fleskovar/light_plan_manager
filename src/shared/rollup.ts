/**
 * The single definition of "what status should a parent hold, given what is
 * inside it?", so the engine (`src/core/board/rollup.ts`), `lpm check` and the
 * browser (`web/src/lib/board/rollup.ts`) cannot disagree about when a feature
 * is finished.
 *
 * Nobody works a container. A feature is a name for the stories under it, so
 * its status is *derived*: when every story is done the feature is done, and
 * when one of them is reopened the feature is open again. Leaving that to a
 * person means a board where the last story is closed and the feature still
 * says "backlog" — the plan and the work saying different things about the same
 * fact.
 *
 * Four rules, and the roll-up is wrong without any of them:
 *
 *   - **`terminal: true` is what "done" means.** The board declares its end
 *     states in `.lpm/config.yml` and nothing here knows the word "done". A
 *     board whose end state is `shipped`, or which has two of them, rolls up
 *     exactly the same way.
 *   - **Which end state, when there is a choice.** A parent closes into the
 *     status its children agree on — five cancelled stories close a cancelled
 *     feature — and into the board's *first* terminal status when they do not.
 *   - **A parent already closed is left alone.** Closing a container is a
 *     statement about its contents (`hasOpenWork` in `blocking.ts` reads it that
 *     way), so re-deriving which end state it should have would overwrite a
 *     deliberate `cancelled` with `done` for nothing.
 *   - **Reopening only ever touches a parent that is closed.** A feature in
 *     `backlog` whose stories are half-started is not wrong, and dragging it
 *     forward would churn every ancestor on the board every time anybody moved
 *     a card. Only the contradiction is corrected: closed, with open work in it.
 *
 * Imports nothing, so it compiles for Node and for the browser alike.
 */

/** What the roll-up needs to know about a board's status column. */
export interface StatusRules {
  /** True when the board marks this status `terminal: true`. */
  isTerminal(status: string): boolean;
  /** True when the board marks this status `active: true` — work in progress. */
  isActive(status: string): boolean;
  /** The board's first end state, or null when it declares none. */
  terminalStatus: string | null;
  /** The board's first active status, where reopened work lands. */
  activeStatus: string | null;
  /** Where a document starts life. */
  defaultStatus: string;
}

/** Everything the walk needs about the issue tree, asked by id. */
export interface RollupLookup {
  /** The issue this one sits under, or null at the top of the collection. */
  parentOf(id: string): string | null;
  /** The issues directly inside this one. */
  childIdsOf(id: string): readonly string[];
  /** The status this issue holds. */
  statusOf(id: string): string;
}

/** A status a parent should be moved to, because of what is inside it. */
export interface StatusRollup {
  id: string;
  from: string;
  to: string;
}

/** The one terminal status every child shares, or null when they differ. */
function agreedEndState(children: readonly string[]): string | null {
  const first = children[0];
  if (first === undefined) return null;
  return children.every((status) => status === first) ? first : null;
}

/**
 * The status a parent holding these children should have, or null when the one
 * it has already says the truth.
 *
 * `children` are the statuses of the issues directly inside it. A parent with
 * nothing inside it answers for itself and is never touched.
 */
export function rolledUpStatus(
  current: string,
  children: readonly string[],
  rules: StatusRules,
): string | null {
  if (!children.length) return null;

  if (children.every((status) => rules.isTerminal(status))) {
    // Already closed: which end state it closed into is somebody's decision.
    if (rules.isTerminal(current)) return null;
    const target = agreedEndState(children) ?? rules.terminalStatus;
    return target && target !== current ? target : null;
  }

  // Open work inside. Only a parent claiming to be finished is contradicted.
  if (!rules.isTerminal(current)) return null;
  const begun = children.some((status) => rules.isTerminal(status) || rules.isActive(status));
  const target = (begun ? rules.activeStatus : null) ?? rules.defaultStatus;
  return target !== current ? target : null;
}

/**
 * Walk up from an issue whose status just changed and report every ancestor
 * that has to move with it, nearest first.
 *
 * `lookup.statusOf` must already answer with the *new* status of the issue that
 * moved; each rollup this returns is folded into the walk, so a story closing
 * the last open feature of an epic closes the epic too.
 *
 * Stops at the first ancestor that does not move: nothing above it saw its
 * contents change either.
 */
export function rollupsUpward(
  from: string,
  lookup: RollupLookup,
  rules: StatusRules,
): StatusRollup[] {
  const moved = new Map<string, string>();
  const statusOf = (id: string): string => moved.get(id) ?? lookup.statusOf(id);
  const out: StatusRollup[] = [];
  const seen = new Set<string>([from]);

  let current = lookup.parentOf(from);
  while (current && !seen.has(current)) {
    seen.add(current);
    const was = statusOf(current);
    const next = rolledUpStatus(
      was,
      lookup.childIdsOf(current).map(statusOf),
      rules,
    );
    if (!next) break;
    moved.set(current, next);
    out.push({ id: current, from: was, to: next });
    current = lookup.parentOf(current);
  }

  return out;
}

/**
 * Every parent on a board whose status disagrees with what is inside it, in an
 * order that can be applied as it stands.
 *
 * `ids` must be ordered deepest-first, so a feature is decided before the epic
 * above it and one pass carries a closed story all the way up. This is what
 * `lpm check` reports and what `--fix` writes.
 */
export function rollupsAcross(
  ids: readonly string[],
  lookup: RollupLookup,
  rules: StatusRules,
): StatusRollup[] {
  const moved = new Map<string, string>();
  const statusOf = (id: string): string => moved.get(id) ?? lookup.statusOf(id);
  const out: StatusRollup[] = [];

  for (const id of ids) {
    const children = lookup.childIdsOf(id);
    if (!children.length) continue;
    const was = statusOf(id);
    const next = rolledUpStatus(was, children.map(statusOf), rules);
    if (!next) continue;
    moved.set(id, next);
    out.push({ id, from: was, to: next });
  }

  return out;
}
