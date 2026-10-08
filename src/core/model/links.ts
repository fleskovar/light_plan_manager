/**
 * The minimum a document has to be to take part in the gating graph: an id and
 * the ids it waits on. Issues have it, and so do registry templates — the same
 * cycle is the same mistake in both, so the check is written once against the
 * shape rather than twice against the two types.
 */
export interface Gated {
  id: string;
  depends_on: string[];
}

/**
 * id -> the ids that gate it, restricted to ids that actually exist.
 *
 * `depends_on` is the only gating edge: it says the work cannot start until
 * something else is finished, and `nextTasks` withholds the issue while it is
 * open. `relates_to` implies nothing and is deliberately absent — a loop of
 * associations is not a stall.
 */
function adjacency(issues: readonly Gated[]): Map<string, string[]> {
  const known = new Set(issues.map((issue) => issue.id));
  const graph = new Map<string, string[]>();
  for (const issue of issues) {
    graph.set(
      issue.id,
      issue.depends_on.filter((target) => known.has(target) && target !== issue.id),
    );
  }
  return graph;
}

/** Rotate so the smallest id comes first, giving one stable key per cycle. */
function canonicalKey(cycle: string[]): string {
  let pivot = 0;
  for (let index = 1; index < cycle.length; index += 1) {
    if (cycle[index]! < cycle[pivot]!) pivot = index;
  }
  return [...cycle.slice(pivot), ...cycle.slice(0, pivot)].join('>');
}

/**
 * Every distinct cycle in a gating graph, each reported once. Members are
 * listed in traversal order and do not repeat the entry point.
 *
 * Takes the graph rather than building one, because `check` runs it over the
 * *inherited* edges (a story waits on what its feature waits on) while `link`
 * runs it over the written ones. Same algorithm, two graphs, one implementation.
 */
export function findCyclesIn(graph: Map<string, string[]>, order: string[]): string[][] {
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];
  const cycles = new Map<string, string[]>();

  const visit = (node: string): void => {
    state.set(node, 'open');
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const seen = state.get(next);
      if (seen === 'open') {
        const start = stack.indexOf(next);
        if (start >= 0) {
          const cycle = stack.slice(start);
          const key = canonicalKey(cycle);
          if (!cycles.has(key)) cycles.set(key, cycle);
        }
      } else if (seen === undefined) {
        visit(next);
      }
    }
    stack.pop();
    state.set(node, 'done');
  };

  for (const id of order) {
    if (!state.has(id)) visit(id);
  }
  return [...cycles.values()];
}

/** Every distinct cycle in the edges as written, for `link` and for tests. */
export function findDependencyCycles(issues: readonly Gated[]): string[][] {
  return findCyclesIn(
    adjacency(issues),
    issues.map((issue) => issue.id),
  );
}

function findPath(graph: Map<string, string[]>, from: string, to: string): string[] | null {
  const previous = new Map<string, string>();
  const queue = [from];
  const seen = new Set([from]);

  while (queue.length) {
    const node = queue.shift()!;
    if (node === to) {
      const path = [node];
      let cursor = node;
      while (previous.has(cursor)) {
        cursor = previous.get(cursor)!;
        path.unshift(cursor);
      }
      return path;
    }
    for (const next of graph.get(node) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      previous.set(next, node);
      queue.push(next);
    }
  }
  return null;
}

/**
 * The cycle that adding a gating edge from `from` to `to` would create, or null
 * if it is safe. Lets `lpm link` reject a bad edge instead of writing it and
 * having `lpm check` complain afterwards.
 *
 * Works against typed engine documents with a BFS through an adjacency graph.
 * `src/shared/plans/reading.ts` carries the DTO-shaped copy, which works
 * against the flat `BoardView` record with a recursive DFS. Both ask the same
 * question; they differ in data shape and algorithm, which is why they stay
 * duplicated. When one changes, the other must follow.
 */
export function wouldCycle(issues: readonly Gated[], from: string, to: string): string[] | null {
  if (from === to) return [from];
  const path = findPath(adjacency(issues), to, from);
  return path ? [from, ...path.slice(0, -1)] : null;
}

export function formatCycle(cycle: string[]): string {
  return [...cycle, cycle[0]].join(' -> ');
}
