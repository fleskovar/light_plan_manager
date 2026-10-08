import type { ConfigDto, IssueDto, NodeDto } from '$shared';

export interface FacetState {
  statuses: Set<string>;
  types: Set<string>;
  assignees: Set<string>;
  periods: Set<string>;
}

/**
 * An empty facet set — all values pass.
 * Not a frozen object so callers can mutate through it.
 */
export function emptyFacet(): FacetState {
  return {
    statuses: new Set(),
    types: new Set(),
    assignees: new Set(),
    periods: new Set(),
  };
}

/** True when any facet has a selection. */
export function faceted(state: FacetState): boolean {
  return state.statuses.size > 0 ||
    state.types.size > 0 ||
    state.assignees.size > 0 ||
    state.periods.size > 0;
}

/**
 * Build a predicate that keeps only rows matching all active facets.
 * A facet with no selections is inactive (matches everything).
 * Compose this with the existing `keep` in `buildRows`.
 */
export function facetKeep(
  state: FacetState,
  nodes: Record<string, NodeDto>,
): (node: NodeDto) => boolean {
  return (node: NodeDto): boolean => {
    if (node.kind !== 'issue') return true;
    const i = node as IssueDto;

    if (state.statuses.size > 0 && !state.statuses.has(i.status)) return false;
    if (state.types.size > 0 && !state.types.has(i.type)) return false;

    if (state.assignees.size > 0) {
      if (!i.assignee || !state.assignees.has(i.assignee)) return false;
    }

    if (state.periods.size > 0) {
      if (!i.period || !state.periods.has(i.period)) return false;
    }

    return true;
  };
}

/** Distinct status ids from the config, in declaration order. */
export function availableStatuses(config: ConfigDto): string[] {
  return config.statuses.map((s) => s.id);
}

/** Distinct issue types from the config. */
export function availableTypes(config: ConfigDto): string[] {
  const types = new Set<string>();
  for (const level of config.hierarchy.issue) {
    for (const t of level) types.add(t);
  }
  return [...types];
}

/** Distinct assignee ids currently used by any issue. */
export function availableAssignees(nodes: Record<string, NodeDto>): string[] {
  const ids = new Set<string>();
  for (const node of Object.values(nodes)) {
    if (node.kind === 'issue') {
      const i = node as IssueDto;
      if (i.assignee) ids.add(i.assignee);
    }
  }
  return [...ids].sort();
}

/** Distinct period ids currently used by any issue. */
export function availablePeriods(nodes: Record<string, NodeDto>): string[] {
  const ids = new Set<string>();
  for (const node of Object.values(nodes)) {
    if (node.kind === 'issue') {
      const i = node as IssueDto;
      if (i.period) ids.add(i.period);
    }
  }
  return [...ids].sort();
}
