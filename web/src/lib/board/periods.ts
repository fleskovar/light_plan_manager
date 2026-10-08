import type { IssueDto, NodeDto, PeriodDto } from '$shared';
import { isPeriodRunning, periodHoldsDate, periodStance as sharedPeriodStance } from '$shared/period-stance';
import type { PeriodNode, PeriodStance } from '$shared/period-stance';
import type { WorkingNodes } from './working.js';

/**
 * Where an issue sits in time, and which of those periods is *now*.
 *
 * A board schedules by putting an issue **in a period** rather than by giving
 * it dates, and periods nest — an increment holds sprints. So "when is this?"
 * is answered by a chain (`PI-2 › Sprint 5`), not by a single name, and the
 * canvas shows the whole chain because the sprint alone does not say which
 * quarter it belongs to.
 *
 * "Now" is read off the documents rather than configured: the period that
 * contains today, or the one somebody switched on. When periods nest, the
 * innermost one wins — an epic parked on the increment is in flight for a
 * quarter, which is not the same claim as a story in the sprint that is running
 * this week, and only the second is work to pick up today.
 *
 * The switch (`period.active`) is the rule from `src/shared/period-stance.ts`,
 * the single definition called by the engine and the browser both.
 */

/** Today as `YYYY-MM-DD`, which is how a period document writes its dates. */
export function todayIso(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** The period chain a document names, outermost first: increment, then sprint. */
export function periodChain(nodes: WorkingNodes, periodId: string | null): PeriodDto[] {
  const chain: PeriodDto[] = [];
  const seen = new Set<string>();
  let current = periodId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const node: NodeDto | undefined = nodes[current];
    if (!node || node.kind !== 'period') break;
    chain.unshift(node);
    current = node.parentId;
  }
  return chain;
}

/** Whether `today` falls inside a period. An open end runs on indefinitely. */
export { periodHoldsDate as holdsDate };

/** Where a period stands once the switch and the calendar have both been read. */
export type { PeriodStance };

/** Adapt a `WorkingNodes` record to the minimal shape `periodStance` needs. */
function periodNode(nodes: WorkingNodes, id: string): PeriodNode | undefined {
  const node = nodes[id];
  if (!node || node.kind !== 'period') return undefined;
  return { id: node.id, parentId: node.parentId, active: (node as PeriodDto).active };
}

/**
 * The switch as it applies to one period — the single definition, in
 * `src/shared/period-stance.ts`, called by the engine and the browser both.
 */
export function periodStance(nodes: WorkingNodes, periodId: string): PeriodStance {
  const node = periodNode(nodes, periodId);
  if (!node) return 'auto';
  return sharedPeriodStance(node, (id) => periodNode(nodes, id));
}

/** Is this period running today? The switch when it is set, the dates otherwise. */
export function isRunning(nodes: WorkingNodes, period: PeriodDto, today: string): boolean {
  const node = periodNode(nodes, period.id);
  if (!node) return false;
  return isPeriodRunning(node, (id) => periodNode(nodes, id), today, period);
}

/**
 * The periods that are running today, innermost only.
 *
 * Two sprints that overlap are both current, which is a fact about the board
 * rather than a case to resolve here. An increment is only current when nothing
 * *inside it* is — otherwise every issue parked on the quarter would light up
 * alongside the sprint that is actually running. Note "inside it" rather than
 * "deepest on the board": a sprint running in one increment says nothing about
 * another increment somebody switched on by hand.
 */
export function currentPeriodIds(nodes: WorkingNodes, today: string): Set<string> {
  const running = Object.values(nodes).filter(
    (node): node is PeriodDto => node.kind === 'period' && isRunning(nodes, node, today),
  );
  if (!running.length) return new Set();

  const covered = new Set<string>();
  for (const period of running) {
    // Everything above this one is standing in for it, so it steps back.
    for (const ancestor of periodChain(nodes, period.id).slice(0, -1)) covered.add(ancestor.id);
  }
  return new Set(running.filter((period) => !covered.has(period.id)).map((period) => period.id));
}

/** What the canvas draws on a node: where it is scheduled, and whether that is now. */
export interface Placement {
  /** Period titles, outermost first. Empty when the issue is unscheduled. */
  chain: string[];
  /** The period this issue names is running today. */
  current: boolean;
}

export function placementOf(
  nodes: WorkingNodes,
  node: NodeDto,
  current: Set<string>,
): Placement | null {
  if (node.kind !== 'issue') return null;
  const issue: IssueDto = node;
  if (!issue.period) return null;
  const chain = periodChain(nodes, issue.period);
  if (!chain.length) return null;
  return { chain: chain.map((period) => period.title), current: current.has(issue.period) };
}
