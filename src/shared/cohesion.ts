/**
 * The single definition of "which container is already under way?", so the
 * engine and the browser cannot disagree about which of two unrelated features
 * a queue should stay inside.
 *
 * A queue that ranks two ready stories only by priority, column and id will
 * happily hand out one story from every feature on the board in turn: nothing
 * in that order knows that somebody already finished two stories in the first
 * feature and started a third. That is not a neutral order — it is the board
 * telling a team to context-switch, and it leaves half-built features open all
 * over the plan. So work whose container is already moving is offered before
 * work whose container has not been touched.
 *
 * The rule is about *containers*, and it is asked from the root down: two
 * candidates are compared by the first ancestor they do not share, which is the
 * one level where they are genuinely alternatives. Stories in the same feature
 * are never separated by it, and a story in an ongoing epic is preferred to one
 * in an untouched epic before their features are ever consulted.
 *
 * Import-free by design: core adapts a `LoadedBoard` to `CohesionLookup` and
 * the browser adapts its working copy, exactly as they both do for
 * `work-unit.ts` and `blocking.ts`.
 */

/** The minimal shape the progress walk needs from a board. */
export interface CohesionLookup {
  parentOf(id: string): string | null;
  childIdsOf(id: string): string[];
  /** Whether the board offers this id as one piece of work. */
  isWorkUnit(id: string): boolean;
  isTerminal(id: string): boolean;
  isActive(id: string): boolean;
}

/**
 * How far the work inside one container has got.
 *
 * Counted over the **work units** underneath it at any depth — the things the
 * board would actually hand somebody — and never over the containers in
 * between, whose status is derived from those same units and would be counted
 * twice. What is inside an atomic unit is that unit's checklist, not work of
 * its own, so the walk stops there.
 */
export interface ContainerProgress {
  /** Work units inside, at any depth. Zero for a leaf. */
  total: number;
  /** Of those, the ones in a terminal status. */
  done: number;
  /** Of those, the ones in an active status — work in flight right now. */
  active: number;
}

/** @see ContainerProgress */
export function containerProgress(id: string, lookup: CohesionLookup): ContainerProgress {
  const progress: ContainerProgress = { total: 0, done: 0, active: 0 };
  const seen = new Set<string>([id]);

  const walk = (parentId: string): void => {
    for (const childId of lookup.childIdsOf(parentId)) {
      // A hand-edited or merged board can name a parent that names it back;
      // the walk terminates rather than hanging whoever asked.
      if (seen.has(childId)) continue;
      seen.add(childId);
      if (lookup.isWorkUnit(childId)) {
        progress.total += 1;
        if (lookup.isTerminal(childId)) progress.done += 1;
        else if (lookup.isActive(childId)) progress.active += 1;
        continue;
      }
      walk(childId);
    }
  };

  walk(id);
  return progress;
}

/** The share of the work inside that is finished; zero for an empty container. */
function completion(progress: ContainerProgress): number {
  return progress.total ? progress.done / progress.total : 0;
}

/**
 * Which of two containers a queue should stay inside, most ongoing first.
 *
 * Work in flight wins outright: the strongest reason not to open a third
 * feature is that somebody is inside the second one right now. Failing that,
 * the container closest to finished wins, measured as a *share* rather than a
 * count so a large container does not outrank a small one merely by holding
 * more work. An untouched container has neither and loses to both.
 */
export function compareProgress(a: ContainerProgress, b: ContainerProgress): number {
  const inFlight = Number(b.active > 0) - Number(a.active > 0);
  if (inFlight !== 0) return inFlight;

  const finished = completion(b) - completion(a);
  if (finished !== 0) return finished < 0 ? -1 : 1;

  return 0;
}

/** A node's ancestors, outermost first, ending with the node itself. */
function lineageOf(id: string, lookup: CohesionLookup): string[] {
  const chain = [id];
  const seen = new Set<string>([id]);
  let parentId = lookup.parentOf(id);
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    chain.unshift(parentId);
    parentId = lookup.parentOf(parentId);
  }
  return chain;
}

/**
 * Order two issues by how far along the part of the plan they sit in is.
 *
 * Built once per sort, because it caches the progress of every container it
 * looks at and a board's statuses move underneath it between sorts (that is
 * exactly what `simulateQueue` does, one step at a time).
 *
 * The comparison walks both lineages from the root and stops at the first
 * ancestor the two do not share — the level at which the two issues really are
 * alternatives. Two issues on the same chain (nothing to choose between) and
 * two issues whose containers are equally under way both come back 0, leaving
 * the caller's remaining tiebreaks to decide.
 */
export function progressComparator(lookup: CohesionLookup): (a: string, b: string) => number {
  const cache = new Map<string, ContainerProgress>();
  const progressOf = (id: string): ContainerProgress => {
    const known = cache.get(id);
    if (known) return known;
    const computed = containerProgress(id, lookup);
    cache.set(id, computed);
    return computed;
  };

  const lineages = new Map<string, string[]>();
  const lineage = (id: string): string[] => {
    const known = lineages.get(id);
    if (known) return known;
    const computed = lineageOf(id, lookup);
    lineages.set(id, computed);
    return computed;
  };

  return (a: string, b: string): number => {
    if (a === b) return 0;
    const left = lineage(a);
    const right = lineage(b);
    const depth = Math.min(left.length, right.length);
    for (let index = 0; index < depth; index += 1) {
      const here = left[index] as string;
      const there = right[index] as string;
      if (here === there) continue;
      return compareProgress(progressOf(here), progressOf(there));
    }
    // One is an ancestor of the other: they are not alternatives at any level.
    return 0;
  };
}
