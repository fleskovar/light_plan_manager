import type {
  ConfigDto,
  IssueDto,
  NodeDto,
  NodeKind,
  PeriodDto,
  ResourceDto,
  TemplateDto,
} from '$shared';
import { isWorkUnit as sharedIsWorkUnit, workUnits as sharedWorkUnits } from '$shared';
import { blockerIds, progressComparator, rollUpDependencies } from '$shared';
import type {
  BlockingLookup,
  CohesionLookup,
  DependencyEdge,
  RolledUpDependency,
  WorkUnitNode,
} from '$shared';
import type { WorkingNodes } from './working.js';
import type { NodeIndex } from './index.js';

/** Pure reads over the working board. No state, no side effects, no fetching. */

export function nodesOfKind(nodes: WorkingNodes, kind: 'issue'): IssueDto[];
export function nodesOfKind(nodes: WorkingNodes, kind: 'period'): PeriodDto[];
export function nodesOfKind(nodes: WorkingNodes, kind: 'resource'): ResourceDto[];
export function nodesOfKind(nodes: WorkingNodes, kind: 'template'): TemplateDto[];
/** The two kinds that carry `dependsOn`, for callers that handle either. */
export function nodesOfKind(
  nodes: WorkingNodes,
  kind: 'issue' | 'template',
): (IssueDto | TemplateDto)[];
export function nodesOfKind(nodes: WorkingNodes, kind: NodeKind): NodeDto[] {
  return Object.values(nodes).filter((node) => node.kind === kind);
}

/**
 * Direct children of `id`, by `parentId`.
 *
 * Works against the flat working-copy record. `src/shared/plans/reading.ts`
 * carries the same function over `BoardView` — same data shape, same algorithm.
 * `src/core/board/query.ts` carries an engine copy that works by filesystem
 * directory path instead. When one changes, the other must follow.
 *
 * Pass an index for O(1) lookup instead of scanning the whole board.
 */
export function childrenOf(nodes: WorkingNodes, id: string, index?: NodeIndex): NodeDto[] {
  if (index) return index.childrenOf(id);
  return Object.values(nodes).filter((node) => node.parentId === id);
}

export function rootsOf(nodes: WorkingNodes, kind: NodeKind, index?: NodeIndex): NodeDto[] {
  if (index) return index.rootsOf(kind);
  return Object.values(nodes).filter((node) => node.kind === kind && node.parentId === null);
}

export function hasChildren(nodes: WorkingNodes, id: string, index?: NodeIndex): boolean {
  if (index) return index.hasChildren(id);
  return Object.values(nodes).some((node) => node.parentId === id);
}

/** A node's ancestors, nearest first. */
export function ancestorsOf(nodes: WorkingNodes, id: string, index?: NodeIndex): NodeDto[] {
  if (index) return index.ancestorsOf(id);
  const chain: NodeDto[] = [];
  const seen = new Set<string>([id]);
  let current = nodes[id]?.parentId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const parent = nodes[current];
    if (!parent) break;
    chain.push(parent);
    current = parent.parentId;
  }
  return chain;
}

export function subtreeIds(nodes: WorkingNodes, id: string, index?: NodeIndex): string[] {
  if (index) return index.subtreeIds(id);
  const ids = [id];
  for (const child of childrenOf(nodes, id)) ids.push(...subtreeIds(nodes, child.id));
  return ids;
}

/** The inverse of `dependsOn`, derived here exactly as the engine derives it. */
export function dependentsIndex(nodes: WorkingNodes, index?: NodeIndex): Record<string, string[]> {
  if (index) {
    // Rebuild the shape callers expect — a simple Record — from the index.
    const out: Record<string, string[]> = {};
    for (const node of Object.values(nodes)) {
      if (node.kind !== 'issue') continue;
      const deps = index.dependentsOf(node.id);
      if (deps.length) out[node.id] = deps;
    }
    return out;
  }
  const index_: Record<string, string[]> = {};
  for (const node of Object.values(nodes)) {
    if (node.kind !== 'issue') continue;
    for (const target of node.dependsOn) (index_[target] ??= []).push(node.id);
  }
  return index_;
}

/**
 * The containers the dependencies inside them put in order, derived here
 * exactly as the engine derives it — including the edits nobody has pushed yet,
 * which is the whole reason the browser computes it rather than reading it off
 * a DTO.
 *
 * Never written onto a document: a `dependsOn` on a container is inherited by
 * everything inside it, and would show a dozen stories as blocked that are
 * waiting on nothing.
 *
 * @see src/shared/dependency-rollup.ts for the rule and why it is that way.
 */
export function dependencyRollups(nodes: WorkingNodes): RolledUpDependency[] {
  const edges: DependencyEdge[] = [];
  for (const node of Object.values(nodes)) {
    if (node.kind !== 'issue') continue;
    for (const target of node.dependsOn) {
      if (nodes[target]?.kind === 'issue') edges.push({ from: node.id, to: target });
    }
  }
  return rollUpDependencies(edges, {
    parentOf: (id) => nodes[id]?.parentId ?? null,
  });
}

/** Both ends of the reflection for one issue, as ids the panel can list. */
export interface RolledUpNeighbours {
  /** Containers this one stands behind because of the work inside them both. */
  blockedBy: string[];
  /** Containers that stand behind this one for the same reason. */
  blocks: string[];
}

export function rolledUpNeighbours(nodes: WorkingNodes, id: string): RolledUpNeighbours {
  const rolled = dependencyRollups(nodes);
  return {
    blockedBy: rolled.filter((entry) => entry.from === id).map((entry) => entry.to),
    blocks: rolled.filter((entry) => entry.to === id).map((entry) => entry.from),
  };
}

/**
 * A depth-first walk of one collection, parents before children, siblings in
 * title order. Both the table and the import dialog render from this.
 */
export function orderedTree(nodes: WorkingNodes, kind: NodeKind, index?: NodeIndex): NodeDto[] {
  const byTitle = (a: NodeDto, b: NodeDto): number => a.title.localeCompare(b.title);
  const out: NodeDto[] = [];
  const walk = (parents: NodeDto[]): void => {
    for (const node of parents.sort(byTitle)) {
      out.push(node);
      walk(childrenOf(nodes, node.id, index));
    }
  };
  walk(rootsOf(nodes, kind, index));
  return out;
}

/**
 * Trailing digits of an id, which is the order ids were handed out. The board
 * stamps `created` and `updated` on every write, but a document that predates
 * those fields still has to sort sensibly, and its id says when it arrived.
 */
export function idSerial(id: string): number {
  const match = /(\d+)\s*$/.exec(id);
  return match ? Number(match[1]) : 0;
}

/** Newest first: by the stamp when there is one, and by id when there is not. */
export function byRecency(
  stamp: (node: NodeDto) => string | undefined,
): (a: NodeDto, b: NodeDto) => number {
  return (a, b) => (stamp(b) ?? '').localeCompare(stamp(a) ?? '') || idSerial(b.id) - idSerial(a.id);
}

export type StatusTone = 'todo' | 'active' | 'blocked' | 'review' | 'done';

/**
 * The colour family a status belongs to.
 *
 * The engine only knows two things about a status — whether it is terminal and
 * whether it counts as active — because that is all the CLI needs. The UI wants
 * five, so the rest is read off the status name. A board that calls its column
 * something unexpected simply gets the neutral tone.
 */
export function statusTone(config: ConfigDto, statusId: string): StatusTone {
  const status = config.statuses.find((entry) => entry.id === statusId);
  if (!status) return 'todo';
  if (status.terminal) return 'done';
  if (/block|impede|hold|stuck/i.test(status.id)) return 'blocked';
  if (status.active) return 'active';
  if (/review|qa|verify|test/i.test(status.id)) return 'review';
  return 'todo';
}

/**
 * The two things the engine actually knows about a status, and the two orders
 * everything that ranks work agrees on.
 *
 * The landing page's digest and the queue board both answer "what could be
 * picked up next?", so the primitives behind that answer live here rather than
 * once in each — a board where the digest and the queue disagreed about what is
 * ready would be worse than either.
 */
export function isTerminal(config: ConfigDto, issue: IssueDto): boolean {
  return config.statuses.find((status) => status.id === issue.status)?.terminal === true;
}

export function isActive(config: ConfigDto, issue: IssueDto): boolean {
  return config.statuses.find((status) => status.id === issue.status)?.active === true;
}

/** Position of an issue's priority in its type's enum; unset sorts last. */
export function priorityRank(config: ConfigDto, issue: IssueDto): number {
  const values = config.types[issue.type]?.attributes.find(
    (attribute) => attribute.name === config.priorityAttribute,
  )?.values;
  const value = issue.attributes[config.priorityAttribute];
  const index = values && typeof value === 'string' ? values.indexOf(value) : -1;
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

/** Later columns are closer to done, so they come first. */
export function statusRank(config: ConfigDto, issue: IssueDto): number {
  const index = config.statuses.findIndex((status) => status.id === issue.status);
  return index < 0 ? 0 : -index;
}

/**
 * Adapt a DTO node to the minimal shape `isWorkUnit` needs.
 *
 * `src/shared/work-unit.ts` carries the single definition — this file and
 * `src/core/board/query.ts` both call it through adapters like this one.
 * If `work-unit.ts` changes what a work unit is, both sides follow.
 */
function toWorkUnitNode(node: NodeDto): WorkUnitNode {
  return { id: node.id, parentId: node.parentId, type: node.type };
}

/**
 * The smallest thing the board hands out as work.
 *
 * @see src/shared/work-unit.ts for the single definition.
 * Pass an index for O(1) hasChildren and ancestors instead of O(n) scans.
 */
export function isWorkUnit(
  nodes: WorkingNodes,
  config: ConfigDto,
  issue: IssueDto,
  index?: NodeIndex,
): boolean {
  if (index) {
    // Index-backed callbacks so sharedIsWorkUnit stays O(depth) per call
    return sharedIsWorkUnit(
      toWorkUnitNode(issue),
      (type) => config.types[type]?.atomic === true,
      (id) => {
        const parent = index.parentOf(id);
        return parent ? toWorkUnitNode(parent) : undefined;
      },
      index.hasChildren(issue.id),
    );
  }
  return sharedIsWorkUnit(
    toWorkUnitNode(issue),
    (type) => config.types[type]?.atomic === true,
    (id) => {
      const parent = nodes[id];
      return parent ? toWorkUnitNode(parent) : undefined;
    },
    childrenOf(nodes, issue.id).length > 0,
  );
}

/** Every issue the board would offer as one piece of work. */
export function workUnitsOf(
  nodes: WorkingNodes,
  config: ConfigDto,
  index?: NodeIndex,
): IssueDto[] {
  if (index) {
    // Fast path: use index-backed isWorkUnit for O(1) per unit
    const issues = nodesOfKind(nodes, 'issue');
    return issues.filter((issue) => isWorkUnit(nodes, config, issue, index));
  }
  const issues = nodesOfKind(nodes, 'issue');
  const parents = new Set<string>();
  for (const node of issues) if (node.parentId) parents.add(node.parentId);
  const result = sharedWorkUnits(
    issues.map(toWorkUnitNode),
    (type) => config.types[type]?.atomic === true,
    (id) => {
      const parent = nodes[id];
      return parent ? toWorkUnitNode(parent) : undefined;
    },
    (id) => parents.has(id),
  );
  const ids = new Set(result.map((node) => node.id));
  return issues.filter((issue) => ids.has(issue.id));
}

/**
 * The work under one issue: the units inside it, or the issue itself when it is
 * one. What "and everything under it" means anywhere a container stands in for
 * its contents.
 */
export function workUnitsUnder(
  nodes: WorkingNodes,
  config: ConfigDto,
  id: string,
  index?: NodeIndex,
): IssueDto[] {
  return subtreeIds(nodes, id, index)
    .map((entry) => nodes[entry])
    .filter((node): node is IssueDto => node?.kind === 'issue')
    .filter((issue) => isWorkUnit(nodes, config, issue, index));
}

/**
 * Adapt the working copy to the id-based lookup `$shared/blocking.ts` reads.
 *
 * Nothing is cached: the workspace mutates `nodes` in place through the single
 * applier in `working.ts`, so a memo keyed on it would answer for a board that
 * has since moved. The index does the caching that is safe to do — it is
 * maintained per change beside that applier.
 */
function blockingLookup(
  nodes: WorkingNodes,
  config: ConfigDto,
  index?: NodeIndex,
): BlockingLookup {
  const issue = (id: string): IssueDto | undefined => {
    const node = nodes[id];
    return node?.kind === 'issue' ? node : undefined;
  };
  return {
    exists: (id) => Boolean(issue(id)),
    parentOf: (id) => issue(id)?.parentId ?? null,
    dependenciesOf: (id) => issue(id)?.dependsOn ?? [],
    childIdsOf: (id) => childrenOf(nodes, id, index).map((child) => child.id),
    isTerminal: (id) => {
      const node = issue(id);
      return node ? isTerminal(config, node) : false;
    },
    isWorkUnit: (id) => {
      const node = issue(id);
      return node ? isWorkUnit(nodes, config, node, index) : false;
    },
  };
}

/**
 * Order two issues by how far along the part of the plan around them already
 * is, so the queue and the digest stay inside a feature somebody has started
 * rather than offering one story from each in turn.
 *
 * Mirrors the engine, which applies the same rule below the schedule, the
 * priority and the column and above the graph heuristics. Built once per sort
 * and never cached: the workspace mutates `nodes` in place, and the whole point
 * of the rule is that it reads the statuses as they now stand.
 *
 * @see src/shared/cohesion.ts for the rule and the order inside it.
 */
export function cohesionOrder(
  nodes: WorkingNodes,
  config: ConfigDto,
  index?: NodeIndex,
): (a: IssueDto, b: IssueDto) => number {
  const issue = (id: string): IssueDto | undefined => {
    const node = nodes[id];
    return node?.kind === 'issue' ? node : undefined;
  };
  const lookup: CohesionLookup = {
    parentOf: (id) => issue(id)?.parentId ?? null,
    childIdsOf: (id) => childrenOf(nodes, id, index).map((child) => child.id),
    isWorkUnit: (id) => {
      const node = issue(id);
      return node ? isWorkUnit(nodes, config, node, index) : false;
    },
    isTerminal: (id) => {
      const node = issue(id);
      return node ? isTerminal(config, node) : false;
    },
    isActive: (id) => {
      const node = issue(id);
      return node ? isActive(config, node) : false;
    },
  };
  const compare = progressComparator(lookup);
  return (a, b) => compare(a.id, b.id);
}

/**
 * The unfinished issues an issue is waiting on, nearest cause first.
 *
 * Mirrors the engine: dependencies are inherited from the issues above, and a
 * dependency on a container is cleared by the work inside it rather than by the
 * container's own status.
 *
 * @see src/shared/blocking.ts for the rules and why they are that way.
 */
export function blockersOf(
  nodes: WorkingNodes,
  config: ConfigDto,
  issue: IssueDto,
  index?: NodeIndex,
): IssueDto[] {
  return blockerIds(issue.id, blockingLookup(nodes, config, index))
    .map((id) => nodes[id])
    .filter((node): node is IssueDto => node?.kind === 'issue');
}

/** An issue nobody can start yet, because something it depends on is unfinished. */
export function isWaiting(
  nodes: WorkingNodes,
  config: ConfigDto,
  issue: IssueDto,
  index?: NodeIndex,
): boolean {
  return blockersOf(nodes, config, issue, index).length > 0;
}

export function issueEffort(config: ConfigDto, issue: IssueDto): number {
  if (!config.effortAttribute) return 0;
  const value = issue.attributes[config.effortAttribute];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Effort of an issue, or of the work units inside it — never both.
 *
 * The roll-up stops at a work unit, because a unit already answers for
 * everything nested in it: adding an atomic story's sub-tasks to its own points
 * would count the same work twice. Asked about a document *inside* a unit it
 * still reports that document's own effort — the reader clicked on it.
 */
export function rolledUpEffort(
  nodes: WorkingNodes,
  config: ConfigDto,
  id: string,
  index?: NodeIndex,
): number {
  const node = nodes[id];
  const children = childrenOf(nodes, id, index);
  if (!children.length || (node?.kind === 'issue' && isWorkUnit(nodes, config, node, index))) {
    return node?.kind === 'issue' ? issueEffort(config, node) : 0;
  }
  return children.reduce((total, child) => total + rolledUpEffort(nodes, config, child.id, index), 0);
}
