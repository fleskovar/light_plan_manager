import path from 'node:path';
import { isAtomicType, isGenericType, isTerminalStatus } from '../config/lookup.js';
import type { AnyNode, BaseNode, Issue, NodeKind, Period, Resource, Squad, Template } from '../model/types.js';
import { slugify } from '../storage/paths.js';
import { periodHoldsDate, periodStance as sharedPeriodStance } from '../../shared/period-stance.js';
import type { PeriodNode, PeriodStance } from '../../shared/period-stance.js';
import {
  isWorkUnit as sharedIsWorkUnit,
  workUnits as sharedWorkUnits,
} from '../../shared/work-unit.js';
import type { WorkUnitNode } from '../../shared/work-unit.js';
import {
  nextPeriodAfter as sharedNextPeriodAfter,
} from '../../shared/period-query.js';
import type { DatedPeriod } from '../../shared/period-query.js';
import type { LoadedBoard } from './load.js';

function findIn<T extends BaseNode>(nodes: T[], index: Map<string, T>, id: string): T | null {
  const exact = index.get(id);
  if (exact) return exact;
  const wanted = id.toLowerCase();
  return nodes.find((node) => node.id.toLowerCase() === wanted) ?? null;
}

/** Resolve an issue by id, case-insensitively, so `lp-3` finds `LP-3`. */
export function findIssue(board: LoadedBoard, id: string): Issue | null {
  return findIn(board.issues, board.byId, id);
}

export function findPeriod(board: LoadedBoard, id: string): Period | null {
  return findIn(board.periods, board.periodsById, id);
}

/**
 * Resolve a resource by id or by name, so `--assignee alice` works as well as
 * `--assignee RS-2`. Tries the id, then the whole name, then its slug, then a
 * unique prefix of either — an ambiguous prefix resolves to nothing rather
 * than to a guess.
 */
export function findResource(board: LoadedBoard, idOrName: string): Resource | null {
  const byId = findIn(board.resources, board.resourcesById, idOrName);
  if (byId) return byId;

  const wanted = idOrName.trim().toLowerCase();
  if (!wanted) return null;
  const slug = slugify(idOrName);

  const only = (matches: Resource[]): Resource | null =>
    matches.length === 1 ? matches[0]! : null;

  return (
    only(board.resources.filter((resource) => resource.title.toLowerCase() === wanted)) ??
    only(board.resources.filter((resource) => slugify(resource.title) === slug)) ??
    only(
      board.resources.filter(
        (resource) =>
          resource.title.toLowerCase().startsWith(wanted) ||
          slugify(resource.title).startsWith(slug),
      ),
    )
  );
}

export function findSquad(board: LoadedBoard, id: string): Squad | null {
  return findIn(board.squads, board.squadsById, id);
}

export function findRegistryTemplate(board: LoadedBoard, id: string): Template | null {
  return findIn(board.templates, board.templatesById, id);
}

/** Resolve an id in any namespace. */
export function findNode(board: LoadedBoard, id: string): AnyNode | null {
  return (
    findIssue(board, id) ??
    findPeriod(board, id) ??
    findResource(board, id) ??
    findSquad(board, id) ??
    findRegistryTemplate(board, id)
  );
}

export function nodesOf(board: LoadedBoard, kind: NodeKind): BaseNode[] {
  if (kind === 'issue') return board.issues;
  if (kind === 'period') return board.periods;
  if (kind === 'resource') return board.resources;
  return kind === 'template' ? board.templates : board.squads;
}

/**
 * Resolve an id case-insensitively so `lp-3` finds `LP-3`, across all three
 * collections. The single place this rule lives, so operations helpers do not
 * hand-roll it inline.
 */
export function findOfKind(board: LoadedBoard, kind: NodeKind, id: string): BaseNode | null {
  if (kind === 'issue') return findIssue(board, id);
  if (kind === 'period') return findPeriod(board, id);
  if (kind === 'resource') return findResource(board, id);
  return kind === 'template' ? findRegistryTemplate(board, id) : findSquad(board, id);
}

/** True when a resource is a pool ("a jr. developer") rather than a person. */
export function isGenericResource(board: LoadedBoard, resource: Resource): boolean {
  return isGenericType(board.config, resource.type);
}

/** Named resources (people), in board order. */
export function namedResources(board: LoadedBoard): Resource[] {
  return board.resources.filter((resource) => !isGenericResource(board, resource));
}

/** Generic resources (pools), in board order. */
export function genericResources(board: LoadedBoard): Resource[] {
  return board.resources.filter((resource) => isGenericResource(board, resource));
}

/** Resources that can take work assigned to a pool. */
export function resourcesCovering(board: LoadedBoard, poolId: string): Resource[] {
  return (board.coveredBy.get(poolId) ?? [])
    .map((id) => board.resourcesById.get(id))
    .filter((resource): resource is Resource => Boolean(resource));
}

/** Resource ids that belong to a squad — the forward edge, one hop. */
export function squadMembers(board: LoadedBoard, squadId: string): string[] {
  const squad = findSquad(board, squadId);
  return squad ? [...squad.members] : [];
}

/** Squads a resource belongs to — the derived inverse, one hop. */
export function squadsOf(board: LoadedBoard, resourceId: string): Squad[] {
  return (board.squadOf.get(resourceId) ?? [])
    .map((id) => board.squadsById.get(id))
    .filter((squad): squad is Squad => Boolean(squad));
}

/**
 * The squad that owns a period, walking up the tree.
 *
 * Follows the same pattern as `periodStance`: a sprint with an explicit squad
 * uses it; one without inherits from its nearest ancestor that has one. `null`
 * means no squad anywhere in the chain — the period is unowned.
 *
 * This is the single definition the engine and every front end read from.
 */
export function effectiveSquad(board: LoadedBoard, periodId: string): string | null {
  const seen = new Set<string>();
  let current = board.periodsById.get(periodId) ?? null;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.squad !== null) return current.squad;
    current = current.parentId ? (board.periodsById.get(current.parentId) ?? null) : null;
  }
  return null;
}

/**
 * Every issue somebody has flagged, in board order.
 *
 * The one list a plan owner reads first: work that is under way and has stopped.
 * Unlike everything else that ranks work this is not scoped or filtered — a
 * flag is a request addressed to whoever is running the plan, and hiding one
 * because it sits outside the reader's slice would be the failure the flag
 * exists to prevent.
 */
export function flaggedIssues(board: LoadedBoard): Issue[] {
  return board.issues.filter((issue) => Boolean(issue.flag));
}

/** A node plus every descendant, parents first. */
export function subtreeOf<T extends BaseNode>(nodes: T[], node: T): T[] {
  const prefix = node.dir + path.sep;
  return nodes.filter((other) => other.dir === node.dir || other.dir.startsWith(prefix));
}

/**
 * Direct children of `node`, by filesystem directory.
 *
 * Works against a typed node array using `path.dirname`. `src/shared/plans/reading.ts`
 * and `web/src/lib/board/selectors.ts` each carry a DTO-shaped copy that works by
 * `parentId` — same noun, different data shape. They stay duplicated because this
 * is a generic path-based filter needed by `subtreeOf`, and the DTO ones are flat
 * id-based lookups. When one changes, the other must follow.
 */
export function childrenOf<T extends BaseNode>(nodes: T[], node: T): T[] {
  return nodes.filter((other) => path.dirname(other.dir) === node.dir);
}

/**
 * Adapt an engine `Issue` to the minimal shape `isWorkUnit` needs.
 *
 * `src/shared/work-unit.ts` carries the single definition of "what is a piece of
 * work?" — this file and `web/src/lib/board/selectors.ts` both call it through
 * adapters like this one, so the engine and the canvas cannot disagree about
 * what counts. If `work-unit.ts` changes what a work unit is, both sides follow.
 */
function toWorkUnitNode(issue: Issue): WorkUnitNode {
  return { id: issue.id, parentId: issue.parentId, type: issue.type };
}

/**
 * The smallest thing the board hands out as work.
 *
 * @see src/shared/work-unit.ts for the single definition.
 */
export function isWorkUnit(board: LoadedBoard, issue: Issue): boolean {
  return sharedIsWorkUnit(
    toWorkUnitNode(issue),
    (type) => isAtomicType(board.config, type),
    (id) => {
      const parent = board.byId.get(id);
      return parent ? toWorkUnitNode(parent) : undefined;
    },
    board.issues.some((other) => other.parentId === issue.id),
  );
}

/** Every issue the board would offer as one piece of work, in board order. */
export function workUnits(board: LoadedBoard): Issue[] {
  const parents = new Set<string>();
  for (const issue of board.issues) if (issue.parentId) parents.add(issue.parentId);
  const sharedResult = sharedWorkUnits(
    board.issues.map(toWorkUnitNode),
    (type) => isAtomicType(board.config, type),
    (id) => {
      const parent = board.byId.get(id);
      return parent ? toWorkUnitNode(parent) : undefined;
    },
    (id) => parents.has(id),
  );
  const ids = new Set(sharedResult.map((node) => node.id));
  return board.issues.filter((issue) => ids.has(issue.id));
}

/** A period and its ancestors, outermost first (e.g. increment, then sprint). */
export function periodChain(board: LoadedBoard, periodId: string): Period[] {
  const chain: Period[] = [];
  let current = findPeriod(board, periodId);
  const guard = new Set<string>();
  while (current && !guard.has(current.id)) {
    guard.add(current.id);
    chain.unshift(current);
    current = current.parentId ? findPeriod(board, current.parentId) : null;
  }
  return chain;
}

/** The period an issue is scheduled in, if any. */
export function periodOf(board: LoadedBoard, issue: Issue): Period | null {
  return issue.period ? findPeriod(board, issue.period) : null;
}

export type { PeriodStance } from '../../shared/period-stance.js';

/** Adapt a `LoadedBoard` to the minimal shape `periodStance` needs. */
function periodNode(board: LoadedBoard, period: Period): PeriodNode {
  return {
    id: period.id,
    parentId: period.parentId,
    active: period.active,
  };
}

/**
 * The switch as it applies to one period — the single definition, in
 * `src/shared/period-stance.ts`, called by the engine and the browser both.
 */
export function periodStance(board: LoadedBoard, period: Period): PeriodStance {
  return sharedPeriodStance(periodNode(board, period), (id) => {
    const parent = findPeriod(board, id);
    return parent ? periodNode(board, parent) : undefined;
  });
}

/** Whether `today` falls inside a period's dates. An open end runs on. */
export { periodHoldsDate };

/**
 * A period that ran out of calendar with work still in it: past its end date,
 * and holding issues nobody has finished. The switch says nothing about this —
 * parking a sprint does not close it.
 */
export function isPeriodOverdue(board: LoadedBoard, period: Period, today: string): boolean {
  if (!period.ends || period.ends >= today) return false;
  return openIssuesInPeriod(board, period.id).length > 0;
}

/**
 * Issues scheduled *directly* in a period that are not finished. Directly,
 * because correcting an overrun is a per-timebox job: an increment's own epics
 * are its business, and the sprints inside it answer for their own stories.
 *
 * Works against the typed `LoadedBoard` and guards a missing period.
 * `src/shared/plans/timeline.ts` carries the DTO-shaped copy, which is
 * direct-only and does not guard. They stay duplicated because the DTO
 * version needs no guard (its `BoardView` is caller-built) and this one
 * reads from disk. When one changes, the other must follow.
 */
export function openIssuesInPeriod(board: LoadedBoard, periodId: string): Issue[] {
  const period = findPeriod(board, periodId);
  if (!period) return [];
  return board.issues.filter(
    (issue) => issue.period === period.id && !isTerminalStatus(board.config, issue.status),
  );
}

/**
 * The period that comes after this one beside it: the next sibling in date
 * order, which is where work that did not fit goes. Null for the last one,
 * because there is nowhere further to push and pretending otherwise would
 * quietly unschedule somebody's work.
 *
 * @see src/shared/period-query.ts for the single definition.
 */
export function nextPeriodAfter(board: LoadedBoard, periodId: string): Period | null {
  const periods: DatedPeriod[] = board.periods.map((entry) => ({
    id: entry.id,
    parentId: entry.parentId,
    starts: entry.starts,
  }));
  const result = sharedNextPeriodAfter(periods, periodId);
  return result ? findPeriod(board, result.id) : null;
}

/**
 * Issues scheduled in a period, optionally including its child periods.
 *
 * Works against the typed `LoadedBoard` with a `subtreeOf` walk to collect
 * descendant period ids. `src/shared/plans/timeline.ts` carries the DTO-shaped
 * copy, which is direct-only. They stay duplicated because the descendant walk
 * needs the engine's typed `Period[]`; the DTO version serves planners that
 * only need direct membership. When one changes, the other must follow.
 */
export function issuesInPeriod(
  board: LoadedBoard,
  periodId: string,
  includeDescendants = true,
): Issue[] {
  const period = findPeriod(board, periodId);
  if (!period) return [];
  const ids = new Set<string>([period.id]);
  if (includeDescendants) {
    for (const node of subtreeOf(board.periods, period)) ids.add(node.id);
  }
  return board.issues.filter((issue) => issue.period && ids.has(issue.period));
}
