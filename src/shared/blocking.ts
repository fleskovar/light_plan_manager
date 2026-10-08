/**
 * The single definition of "what is this issue waiting on?", so the engine
 * (`src/core/board/tasks/ranking.ts`) and the browser
 * (`web/src/lib/board/selectors.ts`) cannot disagree about what is ready.
 *
 * Both callers adapt their own data shapes to the id-based lookup declared
 * here; neither imports anything from the other.
 *
 * Two rules, and the board is wrong without either of them:
 *
 *   - **Dependencies are inherited.** A story sits inside a feature, and a
 *     feature that waits on another feature waits on it *with everything in
 *     it*. Reading only the story's own `depends_on` offered the stories of a
 *     feature whose predecessor had not been started — the plan said one thing
 *     and the queue said another, which is the whole reason to write the edge
 *     down.
 *   - **A container is finished when the work inside it is.** Nobody moves a
 *     feature through the columns; the stories under it are what get worked, so
 *     testing a container's own status would leave its dependents blocked for
 *     ever. `hasOpenWork` therefore looks *inside* a container, and takes a
 *     terminal status on the container itself as the answer for everything
 *     under it — closing one is a statement about its contents.
 *
 * `blockerIds` answers "why can I not start this now"; `upstreamWork` answers
 * the longer question behind it — everything that has to happen first, to the
 * end of the graph — from those same two rules, so the picture the canvas draws
 * and the queue the engine ranks cannot tell different stories.
 *
 * A cycle in `depends_on` stalls the queue for good, so `checkDependencies` runs
 * `findDependencyCycles` over the inherited graph these rules produce — a cycle
 * that only exists once the edges are inherited stalls exactly as hard as a
 * written one, and is far harder to see by eye.
 */

/** Everything the two rules need to know about a board, asked by id. */
export interface BlockingLookup {
  /** True when the board has an issue with this id at all. */
  exists(id: string): boolean;
  /** The issue this one sits under, or null at the top of the collection. */
  parentOf(id: string): string | null;
  /** What the document declares in `depends_on`. */
  dependenciesOf(id: string): readonly string[];
  /** The issues directly inside this one. */
  childIdsOf(id: string): readonly string[];
  /** True when this issue's status is one the board calls terminal. */
  isTerminal(id: string): boolean;
  /**
   * True when the board offers this issue as one piece of work.
   * @see src/shared/work-unit.ts — the single definition of that.
   */
  isWorkUnit(id: string): boolean;
}

/** An issue and everything above it, nearest first. Cycle-safe. */
function lineageOf(id: string, lookup: BlockingLookup): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | null = id;
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = lookup.parentOf(current);
  }
  return chain;
}

/**
 * Everything `id` waits on: what its own document declares in `depends_on`,
 * plus what every issue above it declares, nearest cause first — so the list
 * reads as "the nearest reason you cannot start".
 *
 * An edge pointing back into the issue's own lineage is dropped rather than
 * reported. It can only mean somebody wrote an edge onto an ancestor — or onto
 * a task the issue itself contains — and honouring it would block the work on
 * itself for ever, a stall nobody could diagnose from the queue.
 */
export function effectiveDependencies(id: string, lookup: BlockingLookup): string[] {
  const lineage = lineageOf(id, lookup);
  const inLineage = new Set(lineage);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ancestor of lineage) {
    for (const target of lookup.dependenciesOf(ancestor)) {
      if (inLineage.has(target) || seen.has(target)) continue;
      seen.add(target);
      out.push(target);
    }
  }
  return out;
}

/**
 * Is there work left in this issue — in it, or anywhere inside it?
 *
 * A terminal status is the end of the question, whatever the children say. A
 * work unit answers for itself, which is what makes an `atomic` story in flight
 * still block its dependents once its sub-tasks are ticked off. Anything else
 * is a container, and a container is exactly as unfinished as its contents.
 *
 * An id the board does not have blocks nothing: a dangling reference is a
 * problem for `check` to report, not a reason to stop offering work.
 */
export function hasOpenWork(id: string, lookup: BlockingLookup): boolean {
  if (!lookup.exists(id) || lookup.isTerminal(id)) return false;
  const children = lookup.childIdsOf(id);
  if (!children.length || lookup.isWorkUnit(id)) return true;
  return children.some((child) => hasOpenWork(child, lookup));
}

/**
 * The unfinished issues standing between `id` and being started, nearest cause
 * first. Empty means it can be picked up.
 *
 * Reports the dependency as it is *written* — the feature, not the five stories
 * inside it — because that is the document a reader has to open to find out
 * where the work stands.
 */
export function blockerIds(id: string, lookup: BlockingLookup): string[] {
  return effectiveDependencies(id, lookup).filter((target) => hasOpenWork(target, lookup));
}

/**
 * The work left inside an issue: the units somebody would actually be handed.
 *
 * The same walk `hasOpenWork` does, reporting *what* it found rather than
 * whether it found anything. A terminal status ends the question, and a work
 * unit answers for itself — an atomic story with three sub-tasks is one job,
 * not three.
 *
 * Empty means there is nothing left to do in there.
 */
export function openWorkUnits(id: string, lookup: BlockingLookup): string[] {
  if (!lookup.exists(id) || lookup.isTerminal(id)) return [];
  const children = lookup.childIdsOf(id);
  if (!children.length || lookup.isWorkUnit(id)) return [id];

  const found: string[] = [];
  const seen = new Set<string>();
  for (const child of children) {
    for (const unit of openWorkUnits(child, lookup)) {
      if (seen.has(unit)) continue;
      seen.add(unit);
      found.push(unit);
    }
  }
  return found;
}

/** Why an issue is upstream: an edge somebody wrote, or work inside one. */
export type UpstreamReason = 'dependency' | 'contents';

/** One issue that has to be finished before the starting point can be. */
export interface UpstreamEntry {
  id: string;
  /** Hops from the starting point. 1 is something it waits on directly. */
  distance: number;
  reason: UpstreamReason;
  /**
   * The issue this one was reached through — the issue waiting on it, or the
   * container it is the contents of. Enough to redraw the path back.
   */
  through: string;
}

/**
 * Everything that has to be finished before `id` can be, nearest cause first.
 *
 * `blockerIds` answers "why can I not start this *now*" and stops at the first
 * unfinished thing. This is the whole chain behind that answer: what those
 * blockers wait on, and what *those* wait on, to the end of the graph.
 *
 * Two kinds of entry, and the second is the one that is easy to leave out:
 *
 *   - **`dependency`** — an edge, inherited exactly as `blockerIds` inherits
 *     it, reported as it is written (the feature, not the stories in it).
 *   - **`contents`** — the open work *inside* a blocking container. A container
 *     is finished when its contents are, so a feature standing in the way is
 *     really its three unfinished stories standing in the way, and they are
 *     what somebody has to be handed. Leaving them out would answer "what is
 *     blocked" and not "what has to happen", and would give the scheduling half
 *     of this nothing a queue could ever offer.
 *
 * Breadth-first, so an issue reached two ways keeps its *nearest* reason. The
 * starting point is never in the result, and every id appears exactly once.
 */
export function upstreamWork(id: string, lookup: BlockingLookup): UpstreamEntry[] {
  const found: UpstreamEntry[] = [];
  const seen = new Set<string>([id]);
  let frontier = blockerIds(id, lookup).map((target) => ({ id: target, through: id }));

  for (let distance = 1; frontier.length; distance += 1) {
    const next: { id: string; through: string }[] = [];
    for (const step of frontier) {
      if (seen.has(step.id)) continue;
      seen.add(step.id);
      found.push({ id: step.id, distance, reason: 'dependency', through: step.through });

      // The contents sit at the same distance as the container they are in:
      // they are not one step further back, they *are* what it amounts to.
      for (const unit of openWorkUnits(step.id, lookup)) {
        if (unit !== step.id && !seen.has(unit)) {
          seen.add(unit);
          found.push({ id: unit, distance, reason: 'contents', through: step.id });
        }
        for (const blocker of blockerIds(unit, lookup)) next.push({ id: blocker, through: unit });
      }
      for (const blocker of blockerIds(step.id, lookup)) {
        next.push({ id: blocker, through: step.id });
      }
    }
    frontier = next;
  }
  return found;
}
