/**
 * The single definition of "which containers does a dependency between two
 * pieces of work put in order?", so the engine
 * (`core/board/dependency-rollup.ts`) and the browser
 * (`web/src/lib/board/selectors.ts`) cannot disagree about it.
 *
 * A dependency is written between the two documents that actually have the
 * relationship — a story waits on a story — and that is the right place for it:
 * it is what the queue reads, and writing it any higher would block work that
 * is not waiting on anything. But it is not where the relationship is *read*.
 * Somebody looking at a feature, an epic or a whole increment asks "what does
 * this wait on", and until now the answer at every level above the story was
 * "nothing", which is not true and is exactly what makes a large plan hard to
 * trust. So the edge is reflected upward: the two features the two stories sit
 * in stand in the same order, the two epics above them do, and so on until the
 * container they share, inside which there is nothing left to order.
 *
 * Four rules, and the reflection is wrong without any of them:
 *
 *   - **It stops at the common parent.** Two stories in one feature order
 *     nothing above them: the feature waits on itself, which is not a fact
 *     anybody can act on. Everything strictly below the lowest common ancestor
 *     is reflected, and nothing at or above it is.
 *   - **The two chains are paired from the common parent downward**, not from
 *     the stories upward. The chains are rarely the same length — a story can
 *     wait on a whole feature — and pairing from the top is what keeps the
 *     outermost pair (the two epics) aligned, which is the pair a reader
 *     starting from the top of the board sees first. When one chain runs out,
 *     its last member stands for the rest of it, so the deeper side still
 *     reports what it waits on at every level it has.
 *   - **Nothing is written to a document.** This is a reading of the graph, the
 *     way `board.dependents` is, and it is deliberately *not* a `depends_on`
 *     edge on the container. Two reasons, either of them decisive. A stored
 *     edge would be inherited by everything inside the container, so one story
 *     waiting on one story would stop every other story in the feature — the
 *     board would say a dozen things are blocked that are not. And the
 *     reflection is not acyclic: two features that each contain a story
 *     waiting on the other are an ordinary plan, and rolling that up produces
 *     a loop the cycle check would have to refuse, which would mean refusing
 *     the second story link. Reflected edges are read, never gated, so a loop
 *     among them is a fact about the plan and not a stall.
 *   - **An edge somebody wrote is never reported as a reflection of another
 *     one.** If the two features already declare the dependency, that is the
 *     document's own word and the surfaces show it as such; repeating it as
 *     derived would say the same thing twice with two different meanings.
 *
 * Imports nothing, so it compiles for Node and for the browser alike.
 */

/** Everything the walk needs about the issue tree, asked by id. */
export interface HierarchyLookup {
  /** The issue this one sits under, or null at the top of the collection. */
  parentOf(id: string): string | null;
}

/** A dependency as it is written down: `from` waits on `to`. */
export interface DependencyEdge {
  from: string;
  to: string;
}

/** A dependency two containers are in because of work inside them. */
export interface RolledUpDependency extends DependencyEdge {
  /** The written dependency this reflects — `source` waits on `target`. */
  source: string;
  target: string;
  /**
   * How deep below the common parent this pair sits: 0 is the pair directly
   * inside it, 1 the pair inside that. Reported nearest the written edge
   * first, so the highest `level` comes first.
   */
  level: number;
}

/** An issue and everything above it, nearest first. Cycle-safe. */
function lineageOf(id: string, lookup: HierarchyLookup): string[] {
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
 * The containers one written dependency puts in order, nearest the written
 * edge first.
 *
 * Empty when there is nothing above the edge to order: the two ends sit in the
 * same container, or one of them is inside the other — an issue cannot be made
 * to wait on the container it is part of.
 */
export function rollUpDependency(
  edge: DependencyEdge,
  lookup: HierarchyLookup,
): RolledUpDependency[] {
  if (edge.from === edge.to) return [];

  const waiting = lineageOf(edge.from, lookup);
  const blocking = lineageOf(edge.to, lookup);
  const blockingAt = new Map(blocking.map((id, index): [string, number] => [id, index]));

  // The lowest common ancestor: the first id above the waiting end that also
  // stands above (or is) the blocking end. Either chain being empty afterwards
  // means one end contains the other, and there is nothing to reflect.
  let waitingCut = waiting.length;
  let blockingCut = blocking.length;
  for (const [index, id] of waiting.entries()) {
    const found = blockingAt.get(id);
    if (found === undefined) continue;
    waitingCut = index;
    blockingCut = found;
    break;
  }

  const above = waiting.slice(0, waitingCut).reverse();
  const under = blocking.slice(0, blockingCut).reverse();
  if (!above.length || !under.length) return [];

  const out: RolledUpDependency[] = [];
  const levels = Math.max(above.length, under.length);
  for (let level = 0; level < levels; level += 1) {
    const from = above[Math.min(level, above.length - 1)]!;
    const to = under[Math.min(level, under.length - 1)]!;
    // The last pair is the written edge itself on boards where both chains run
    // to the bottom; it is the fact being reflected, not a reflection of it.
    if (from === edge.from && to === edge.to) continue;
    out.push({ from, to, source: edge.from, target: edge.to, level });
  }
  return out.reverse();
}

/**
 * Every dependency the containers on a board are in because of the work inside
 * them, each pair reported once.
 *
 * `edges` is every dependency written on the board. Both ends of each one are
 * expected to exist — a dangling id is a problem for `check` to report, and
 * reflecting one would put a container in order behind nothing.
 *
 * A pair that is already written down is left out: it is that document's own
 * dependency, and the surfaces show it as one.
 */
export function rollUpDependencies(
  edges: readonly DependencyEdge[],
  lookup: HierarchyLookup,
): RolledUpDependency[] {
  const key = (from: string, to: string): string => `${from}->${to}`;
  const written = new Set(edges.map((edge) => key(edge.from, edge.to)));
  const seen = new Set<string>();
  const out: RolledUpDependency[] = [];

  for (const edge of edges) {
    for (const rolled of rollUpDependency(edge, lookup)) {
      const id = key(rolled.from, rolled.to);
      if (written.has(id) || seen.has(id)) continue;
      seen.add(id);
      out.push(rolled);
    }
  }
  return out;
}
