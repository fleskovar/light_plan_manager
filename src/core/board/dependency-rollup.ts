import type { DependencyEdge, RolledUpDependency } from '../../shared/dependency-rollup.js';
import { rollUpDependencies } from '../../shared/dependency-rollup.js';
import type { Issue } from '../model/types.js';
import type { LoadedBoard } from './load.js';

/**
 * Reading a board for the dependency roll-up: which containers are in order
 * because of the work inside them.
 *
 * Read-only, like the rest of `board/`, and nothing writes the answer — unlike
 * the status and flag roll-ups, a reflected dependency is derived on the way
 * out and never lands in a document.
 *
 * @see src/shared/dependency-rollup.ts for the rule itself and why it is that way.
 */

/** A reflected dependency with both documents resolved. */
export interface IssueDependencyRollup extends RolledUpDependency {
  /** The container that waits. */
  issue: Issue;
  /** The container it waits on. */
  blocker: Issue;
}

function resolve(board: LoadedBoard, rolled: RolledUpDependency[]): IssueDependencyRollup[] {
  const out: IssueDependencyRollup[] = [];
  for (const entry of rolled) {
    const issue = board.byId.get(entry.from);
    const blocker = board.byId.get(entry.to);
    if (issue && blocker) out.push({ ...entry, issue, blocker });
  }
  return out;
}

/** Every dependency written on the board, both ends of which it still has. */
function writtenEdges(board: LoadedBoard): DependencyEdge[] {
  const edges: DependencyEdge[] = [];
  for (const issue of board.issues) {
    for (const target of issue.depends_on) {
      if (board.byId.has(target)) edges.push({ from: issue.id, to: target });
    }
  }
  return edges;
}

/**
 * Every pair of containers the dependencies inside them put in order.
 *
 * Each pair once, in the order the written edges are read, and never a pair
 * that is written down already.
 */
export function dependencyRollups(board: LoadedBoard): IssueDependencyRollup[] {
  return resolve(
    board,
    rollUpDependencies(writtenEdges(board), {
      parentOf: (id) => board.byId.get(id)?.parentId ?? null,
    }),
  );
}

/**
 * What this issue waits on because of the work inside it — the reflection of
 * the dependencies its descendants declare, at this issue's own level.
 *
 * Empty for a work unit that nothing is nested in: its own `depends_on` is the
 * whole answer, and it is already on the document.
 */
export function rolledUpDependenciesOf(board: LoadedBoard, id: string): IssueDependencyRollup[] {
  return dependencyRollups(board).filter((entry) => entry.from === id);
}

/**
 * What waits on this issue because of the work inside *it* — the same
 * reflection read from the other end.
 */
export function rolledUpDependentsOf(board: LoadedBoard, id: string): IssueDependencyRollup[] {
  return dependencyRollups(board).filter((entry) => entry.to === id);
}

/**
 * The containers a set of dependencies puts in order, nearest first.
 *
 * What `lpm link` and the MCP tool report back after writing an edge: the
 * dependency lands on the two documents that have it, and this is everything
 * else the board now says because of it. Each pair once, and never one that is
 * written on a document — but a pair another dependency already reflected is
 * still reported, because this answers "what does *this* edge order" rather
 * than "what changed on the board".
 *
 * Safe to call with the handle the write went through: core operations write
 * straight to disk, so it is stale by then, and `edges` is what it is missing.
 */
export function rollupsForEdges(
  board: LoadedBoard,
  edges: readonly DependencyEdge[],
): IssueDependencyRollup[] {
  const key = (from: string, to: string): string => `${from}->${to}`;
  const asked = new Set(edges.map((edge) => key(edge.from, edge.to)));
  const written = new Set(
    writtenEdges(board)
      .map((edge) => key(edge.from, edge.to))
      .filter((one) => !asked.has(one)),
  );
  return resolve(
    board,
    rollUpDependencies(edges, { parentOf: (id) => board.byId.get(id)?.parentId ?? null }),
  ).filter((entry) => !written.has(key(entry.from, entry.to)));
}
