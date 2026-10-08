import type { ConfigDto } from '$shared';
import { issueEffort, workUnitsOf } from './selectors.js';
import type { WorkingNodes } from './working.js';

/**
 * The longest chain of dependent work.
 *
 * Weighted by the board's effort attribute when it declares one, and by "one
 * step per issue" when it does not — so a board without story points still gets
 * a meaningful answer. Only work units are considered, for the same reason the
 * CLI only recommends those: a parent's effort is its children's, and counting
 * both would double it.
 *
 * The board can contain a cycle (someone hand-edits two files, or a merge goes
 * badly), so the walk carries its own guard and simply stops rather than
 * hanging the browser.
 */
export interface CriticalPath {
  /** Ids on the longest chain, in order. */
  chain: string[];
  /** Total weight of that chain. */
  weight: number;
}

export function criticalPath(nodes: WorkingNodes, config: ConfigDto): CriticalPath {
  const units = new Set(workUnitsOf(nodes, config).map((issue) => issue.id));

  const weightOf = (id: string): number => {
    const node = nodes[id];
    if (node?.kind !== 'issue') return 0;
    return config.effortAttribute ? issueEffort(config, node) || 1 : 1;
  };

  const best = new Map<string, { weight: number; chain: string[] }>();
  const visiting = new Set<string>();

  const longestTo = (id: string): { weight: number; chain: string[] } => {
    const cached = best.get(id);
    if (cached) return cached;
    if (visiting.has(id)) return { weight: 0, chain: [] };
    visiting.add(id);

    const node = nodes[id];
    const upstream = node?.kind === 'issue' ? node.dependsOn.filter((dep) => units.has(dep)) : [];
    let winner = { weight: 0, chain: [] as string[] };
    for (const dependency of upstream) {
      const candidate = longestTo(dependency);
      if (candidate.weight > winner.weight) winner = candidate;
    }

    visiting.delete(id);
    const result = { weight: winner.weight + weightOf(id), chain: [...winner.chain, id] };
    best.set(id, result);
    return result;
  };

  let overall: CriticalPath = { chain: [], weight: 0 };
  for (const id of units) {
    const candidate = longestTo(id);
    if (candidate.weight > overall.weight) overall = candidate;
  }
  return overall;
}
