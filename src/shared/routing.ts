/**
 * The single definition of "whose queue is this work in?", so `lpm task next
 * --user` and the queue panel cannot disagree about who is offered what.
 *
 * Two questions, both about routing and neither about readiness: does a piece
 * of work reach this resource at all (`routeWork`), and does the squad owning
 * the sprint it is scheduled in let this resource take it (`owningSquad`). Both
 * callers adapt their own shapes to the structural interfaces declared here;
 * neither imports anything from the other.
 */

/** How a piece of work reaches a resource. */
export type WorkRoute = 'direct' | 'pool' | 'unassigned';

export interface RoutingResource {
  id: string;
  /** The pools this resource can take work from. */
  covers: readonly string[];
}

/**
 * How work assigned to `assignee` reaches `resource`, or null when it never
 * does: assigned to it, parked in a pool it covers, or assigned to nobody when
 * the caller is willing to consider that. A resource listed in `covers` that is
 * not a pool routes nothing — covering a *person* is not a way to take their
 * work.
 */
export function routeWork(
  assignee: string | null | undefined,
  resource: RoutingResource,
  isPool: (id: string) => boolean,
  includeUnassigned = false,
): WorkRoute | null {
  if (!assignee) return includeUnassigned ? 'unassigned' : null;
  if (assignee === resource.id) return 'direct';
  if (!resource.covers.includes(assignee)) return null;
  return isPool(assignee) ? 'pool' : null;
}

export interface SquadPeriod {
  id: string;
  parentId: string | null;
  /** The squad written on this period, or null. */
  squad: string | null;
}

/**
 * The squad that owns a period: its own, or the nearest ancestor's. Owning an
 * increment owns the sprints in it, the way parking an increment parks them.
 * A period with no squad anywhere above it is the ordinary case, and owned by
 * nobody — which applies no filter at all.
 */
export function owningSquad(
  periodId: string,
  getPeriod: (id: string) => SquadPeriod | undefined,
): string | null {
  const seen = new Set<string>();
  let current = getPeriod(periodId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.squad !== null) return current.squad;
    current = current.parentId ? getPeriod(current.parentId) : undefined;
  }
  return null;
}
