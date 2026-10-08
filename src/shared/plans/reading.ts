import type { BlockingLookup } from '../blocking.js';
import type { ConfigDto, IssueDto, NodeDto, NodeKind, TemplateDto } from '../model.js';
import { isWorkUnit } from '../work-unit.js';

/**
 * The types and helpers that all planners read the board with.
 *
 * `BoardView` is the slice of a board a planner needs: the config, and the
 * documents by id. These helpers walk it without knowing which planner called
 * them.
 */

/** The slice of a board a planner needs: the config, and the documents by id. */
export interface BoardView {
  config: ConfigDto;
  nodes: Record<string, NodeDto>;
}

/**
 * Ids for documents that do not exist yet. The caller supplies this because the
 * web app numbers temporary ids across a whole session of queued edits, while a
 * one-shot command can start from scratch.
 */
export type IdFactory = () => string;

export function counterFactory(start = 1): IdFactory {
  let next = start;
  return () => `new:${next++}`;
}

// -- reading ---------------------------------------------------------------

/**
 * Direct children of `id`, by `parentId`.
 *
 * Works against the flat DTO record. `src/core/board/query.ts` carries the
 * engine's own copy, which works against a typed `T[]` using filesystem
 * directory paths — same noun, different data shape and navigation. They stay
 * duplicated because the engine's is a generic path-based filter needed by
 * `subtreeOf`, and the DTO one is a flat id-based lookup. When one changes,
 * the other must follow.
 */
export function childrenOf(view: BoardView, id: string): NodeDto[] {
  return Object.values(view.nodes).filter((node) => node.parentId === id);
}

export function subtreeIds(view: BoardView, id: string): string[] {
  const ids = [id];
  for (const child of childrenOf(view, id)) ids.push(...subtreeIds(view, child.id));
  return ids;
}

export function ancestorsOf(view: BoardView, id: string): NodeDto[] {
  const chain: NodeDto[] = [];
  const seen = new Set([id]);
  let current = view.nodes[id]?.parentId ?? null;
  while (current && !seen.has(current)) {
    seen.add(current);
    const parent = view.nodes[current];
    if (!parent) break;
    chain.push(parent);
    current = parent.parentId;
  }
  return chain;
}

/**
 * Documents that declare a dependency on `id` — issues, and the registry
 * templates that carry the same edge one level removed.
 *
 * The two can never mix: a template's dependencies name templates and an
 * issue's name issues, so filtering by the edge alone is enough.
 */
export function dependentsOf(view: BoardView, id: string): (IssueDto | TemplateDto)[] {
  return Object.values(view.nodes).filter(
    (node): node is IssueDto | TemplateDto =>
      (node.kind === 'issue' || node.kind === 'template') && node.dependsOn.includes(id),
  );
}

/**
 * Adapt a `BoardView` to the id-based lookup `../blocking.ts` reads, so a
 * planner asks what an issue is waiting on in exactly the words the engine and
 * the canvas use.
 *
 * The third adapter to that interface, and deliberately so: the engine's
 * (`blockingLookupFor`) walks typed `Issue[]` with a filesystem-path parent
 * index, the browser's (`blockingLookup` in `web/src/lib/board/selectors.ts`)
 * walks the mutable working copy through its own maintained index, and this one
 * walks a flat immutable DTO record. Same questions, three data shapes. The
 * *answers* are shared — they all come from `blocking.ts` — which is the part
 * that has to agree.
 *
 * The parent and child indexes are built once here rather than scanning per
 * question, because the upstream walk asks about a whole graph rather than one
 * issue.
 */
export function blockingLookupOf(view: BoardView): BlockingLookup {
  const issues = new Map<string, IssueDto>();
  const children = new Map<string, string[]>();
  for (const node of Object.values(view.nodes)) {
    if (node.kind !== 'issue') continue;
    issues.set(node.id, node);
  }
  for (const issue of issues.values()) {
    if (!issue.parentId) continue;
    const siblings = children.get(issue.parentId);
    if (siblings) siblings.push(issue.id);
    else children.set(issue.parentId, [issue.id]);
  }

  const terminal = new Set(
    view.config.statuses.filter((status) => status.terminal).map((status) => status.id),
  );
  const isAtomic = (type: string): boolean => view.config.types[type]?.atomic ?? false;

  return {
    exists: (id) => issues.has(id),
    parentOf: (id) => issues.get(id)?.parentId ?? null,
    dependenciesOf: (id) => issues.get(id)?.dependsOn ?? [],
    childIdsOf: (id) => children.get(id) ?? [],
    isTerminal: (id) => {
      const issue = issues.get(id);
      return issue ? terminal.has(issue.status) : false;
    },
    isWorkUnit: (id) => {
      const issue = issues.get(id);
      if (!issue) return false;
      return isWorkUnit(issue, isAtomic, (parent) => issues.get(parent), Boolean(children.get(id)?.length));
    },
  };
}

/**
 * The type a document must take to sit at `depth`, preferring the one it
 * already has. Null when the hierarchy has no level there, which is the
 * difference between "this will be demoted to a story" and "you cannot do that".
 */
export function typeAtDepth(
  config: ConfigDto,
  kind: NodeKind,
  depth: number,
  preferred: string,
): string | null {
  const allowed = config.hierarchy[kind][depth] ?? [];
  if (!allowed.length) return null;
  return allowed.includes(preferred) ? preferred : allowed[0]!;
}

/**
 * Would `blocked` waiting on `blocker` close a loop? Returns the cycle if so.
 *
 * Walks `dependsOn`, the one edge that decides what the queue offers, so a loop
 * through it stalls the work for good.
 *
 * Works against the flat DTO record (`BoardView`), walking with a recursive
 * DFS. `src/core/model/links.ts` carries the engine's own copy, which works
 * against a typed `Issue[]` with a BFS through an adjacency graph. Both ask the
 * same question; they differ in data shape and algorithm, which is why they
 * stay duplicated. When one changes, the other must follow.
 */
export function wouldCycle(view: BoardView, blocked: string, blocker: string): string[] | null {
  if (blocked === blocker) return [blocked, blocker];
  const path: string[] = [];
  const seen = new Set<string>();

  const walk = (id: string): boolean => {
    if (id === blocked) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    path.push(id);
    const node = view.nodes[id];
    if (node?.kind === 'issue' || node?.kind === 'template') {
      for (const next of node.dependsOn) if (walk(next)) return true;
    }
    path.pop();
    return false;
  };

  return walk(blocker) ? [blocked, blocker, ...path.slice(1), blocked] : null;
}
