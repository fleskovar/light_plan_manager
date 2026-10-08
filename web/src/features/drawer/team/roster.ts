import type { ConfigDto, ResourceDto } from '$shared';
import { ancestorsOf, issueEffort, nodesOfKind, workUnitsOf } from '$lib/board/selectors.js';
import type { WorkingNodes } from '$lib/board/working.js';

/**
 * Reading the roster.
 *
 * Load is counted over work units only, exactly as `lpm team` does it: a
 * parent's effort is its children's, and an `atomic` story's is already its
 * sub-tasks', so counting both would report twice the work. Work
 * parked in a pool is counted against the pool, and separately shown against
 * everyone who covers it — that is the point of a pool, and it is why the two
 * numbers are reported side by side rather than added together.
 */
export interface RosterEntry {
  resource: ResourceDto;
  /** Issues assigned directly to this resource. */
  assigned: number;
  /** Effort of those issues, when the board measures effort. */
  load: number;
  /** Effort waiting in the pools this resource covers. */
  poolLoad: number;
  /** The pools this resource can take work from, resolved from its ids. */
  covers: ResourceDto[];
  /** Resources that can take work from this pool. Pools only. */
  coveredBy: ResourceDto[];
}

export function buildRoster(nodes: WorkingNodes, config: ConfigDto): RosterEntry[] {
  const resources = nodesOfKind(nodes, 'resource');
  const issues = workUnitsOf(nodes, config);

  const loadFor = (id: string): { assigned: number; load: number } => {
    const mine = issues.filter((issue) => issue.assignee === id);
    return {
      assigned: mine.length,
      load: mine.reduce((total, issue) => total + issueEffort(config, issue), 0),
    };
  };

  const direct = new Map(resources.map((resource) => [resource.id, loadFor(resource.id)]));
  const byId = new Map(resources.map((resource) => [resource.id, resource]));

  return resources.map((resource) => ({
    resource,
    assigned: direct.get(resource.id)?.assigned ?? 0,
    load: direct.get(resource.id)?.load ?? 0,
    poolLoad: resource.covers.reduce((total, pool) => total + (direct.get(pool)?.load ?? 0), 0),
    covers: resource.covers
      .map((poolId) => byId.get(poolId))
      .filter((pool): pool is ResourceDto => pool !== undefined),
    coveredBy: resources.filter((other) => other.covers.includes(resource.id)),
  }));
}

/**
 * The two sides of coverage, for whichever card was opened.
 *
 * Coverage is stored one way round — a person's document lists the pools they
 * can take work from — but it is read both ways, and a pool's card is exactly
 * where someone thinks "who can actually pick this up?". So the editor offers
 * the inverse as a list to tick, and writes it to the other document.
 */
export interface Coverage {
  /** Pools this resource could cover. Empty for a pool. */
  pools: ResourceDto[];
  /** Resources that could cover this pool. Empty for anything but a pool. */
  coverers: ResourceDto[];
}

export function coverageOptions(nodes: WorkingNodes, resource: ResourceDto): Coverage {
  const resources = nodesOfKind(nodes, 'resource').filter((one) => one.id !== resource.id);
  return {
    pools: resource.generic ? [] : resources.filter((one) => one.generic),
    coverers: resource.generic ? resources.filter((one) => !one.generic) : [],
  };
}

export type GroupMode = 'type' | 'team' | 'work' | 'pool';

export interface RosterGroup {
  key: string;
  label: string;
  entries: RosterEntry[];
  /** Shown next to the group name. */
  note?: string;
}

/**
 * Slice the roster. `work` deliberately allows a person to appear in more than
 * one group — someone assigned across two programmes belongs to both, and
 * hiding that would defeat the purpose of the grouping.
 */
export function groupRoster(
  nodes: WorkingNodes,
  config: ConfigDto,
  entries: RosterEntry[],
  mode: GroupMode,
): RosterGroup[] {
  const groups = new Map<string, RosterGroup>();
  const push = (key: string, label: string, entry: RosterEntry): void => {
    const group = groups.get(key) ?? { key, label, entries: [] };
    group.entries.push(entry);
    groups.set(key, group);
  };

  for (const entry of entries) {
    if (mode === 'type') {
      const type = config.types[entry.resource.type];
      push(entry.resource.type, type?.label ?? entry.resource.type, entry);
      continue;
    }

    if (mode === 'team') {
      const parent = entry.resource.parentId ? nodes[entry.resource.parentId] : null;
      push(parent?.id ?? '_top', parent?.title ?? 'Unattached', entry);
      continue;
    }

    if (mode === 'pool') {
      if (entry.resource.generic) push(entry.resource.id, entry.resource.title, entry);
      for (const poolId of entry.resource.covers) {
        push(poolId, nodes[poolId]?.title ?? poolId, entry);
      }
      if (!entry.resource.generic && !entry.resource.covers.length) {
        push('_none', 'No pool', entry);
      }
      continue;
    }

    // 'work': grouped by the top-level issue each assignment rolls up to.
    const roots = new Set<string>();
    for (const issue of nodesOfKind(nodes, 'issue')) {
      if (issue.assignee !== entry.resource.id) continue;
      const chain = ancestorsOf(nodes, issue.id);
      const root = chain.at(-1) ?? issue;
      roots.add(root.id);
    }
    if (!roots.size) push('_idle', 'Unassigned', entry);
    for (const rootId of roots) push(rootId, nodes[rootId]?.title ?? rootId, entry);
  }

  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}
