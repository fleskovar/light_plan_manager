import type { ConfigDto, NodeDto } from '$shared';
import { byRecency } from '$lib/board/selectors.js';
import type { WorkingNodes } from '$lib/board/working.js';

/**
 * The handful of questions a plan gets asked over and over.
 *
 * These are not saved searches and not a query language — the scope note in the
 * README rules that out. They are the four lists someone standing in front of a
 * board wants without typing: what is being worked on, what just finished, what
 * just arrived, and what is on the canvas.
 *
 * "Recently" is a rank, not a date window: the most recent `RECENT_LIMIT`, so a
 * board that has been quiet for a month still answers the question. The engine
 * stamps `updated` on every write and `created` once, and ids are handed out in
 * order, so a board whose documents predate those fields still ranks sensibly.
 */
export type QuickFilter = 'all' | 'active' | 'done' | 'new' | 'canvas';

export const RECENT_LIMIT = 25;

export interface FilterChoice {
  id: QuickFilter;
  label: string;
  hint: string;
}

export const QUICK_FILTERS: readonly FilterChoice[] = [
  { id: 'all', label: 'All', hint: 'Every issue on the board' },
  { id: 'active', label: 'In progress', hint: 'Issues in an active status' },
  { id: 'done', label: 'Just finished', hint: `The last ${RECENT_LIMIT} finished issues` },
  { id: 'new', label: 'Just added', hint: `The last ${RECENT_LIMIT} issues created` },
  { id: 'canvas', label: 'On canvas', hint: 'Only issues on the canvas' },
];

export interface FilterInput {
  nodes: WorkingNodes;
  config: ConfigDto;
  /** Ids on the canvas, for the `canvas` filter. */
  members: Set<string>;
  limit?: number;
}

function mostRecent(
  nodes: NodeDto[],
  stamp: (node: NodeDto) => string | undefined,
  limit: number,
): Set<string> {
  return new Set(
    nodes
      .slice()
      .sort(byRecency(stamp))
      .slice(0, limit)
      .map((node) => node.id),
  );
}

/**
 * The predicate a filter stands for, or `undefined` for "everything" — which
 * the table treats as no filtering at all rather than as a predicate that
 * always passes, so an unfiltered board keeps its folding.
 */
export function filterMatcher(
  filter: QuickFilter,
  input: FilterInput,
): ((node: NodeDto) => boolean) | undefined {
  if (filter === 'all') return undefined;

  const issues = Object.values(input.nodes).filter((node) => node.kind === 'issue');
  const limit = input.limit ?? RECENT_LIMIT;

  if (filter === 'canvas') return (node) => input.members.has(node.id);

  if (filter === 'active') {
    const active = new Set(
      input.config.statuses.filter((status) => status.active).map((status) => status.id),
    );
    return (node) => node.kind === 'issue' && active.has(node.status);
  }

  if (filter === 'done') {
    const terminal = new Set(
      input.config.statuses.filter((status) => status.terminal).map((status) => status.id),
    );
    const finished = issues.filter((node) => node.kind === 'issue' && terminal.has(node.status));
    // Finishing something is a write, so `updated` is when it finished.
    const recent = mostRecent(finished, (node) => node.updated ?? node.created, limit);
    return (node) => recent.has(node.id);
  }

  const recent = mostRecent(issues, (node) => node.created, limit);
  return (node) => recent.has(node.id);
}

/**
 * Ids to fold so the tree shows down to `depth` and no deeper: everything at
 * that depth or below is closed, everything above it is left open. Folding a
 * node hides its *children*, so "show down to epics" closes the epics
 * themselves — the caller passes the depth it wants to be the last one
 * visible, not the first one hidden.
 */
export function foldToDepth(
  nodes: WorkingNodes,
  depth: number,
): Record<string, true> {
  const result: Record<string, true> = {};
  for (const node of Object.values(nodes)) {
    if (node.kind === 'issue' && node.depth >= depth) {
      result[node.id] = true;
    }
  }
  return result;
}

/** One button per level of the issue hierarchy, labelled by the types there. */
export function levelChoices(config: ConfigDto): { depth: number; label: string }[] {
  return config.hierarchy.issue.map((types, depth) => {
    const labels = types.map((name) => config.types[name]?.label ?? name);
    return {
      depth,
      label: labels.length > 2 ? `${labels[0]}…` : labels.join(' / '),
    };
  });
}
