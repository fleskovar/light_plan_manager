import type { ConfigDto, IssueDto, NodeDto, SyncBadge, TypeDisplay } from '$shared';
import { isDerivedFlag, plansWithPeriods } from '$shared';
import type { Placement } from '$lib/board/periods.js';
import { currentPeriodIds, placementOf, todayIso } from '$lib/board/periods.js';
import type { StatusTone } from '$lib/board/selectors.js';
import { statusTone } from '$lib/board/selectors.js';
import type { WorkingNodes } from '$lib/board/working.js';
import { NODE_HEIGHT, NODE_WIDTH } from './constants.js';
import type { GraphInput, LineageBadge, VisibleTree } from './visibleTree.js';

/**
 * Turning the visible tree into canvas nodes — position-agnostic, geometry-ready.
 *
 * Every node gets its data payload, its size defaults, and its position origin.
 * Placement, layout, and sizing are the canvas's job; this module only decides
 * what *kind* of node it is and what its data card carries.
 */

export interface CanvasNodeData extends Record<string, unknown> {
  node: NodeDto;
  typeLabel: string;
  tone: StatusTone;
  /** Has children in the view, so it is drawn as a subflow. */
  group: boolean;
  /** Has children in the view whether or not they are showing. */
  collapsible: boolean;
  collapsed: boolean;
  /** Children that exist on the board but are not in the view. */
  hiddenChildren: number;
  assigneeLabel: string | null;
  effort: number | null;
  /**
   * Why work on this issue has stopped, or null. Drawn in red and louder than
   * anything else on the node, because it is the one thing on a board that is
   * addressed to whoever is reading it rather than to whoever is doing the work.
   */
  flag: string | null;
  /**
   * A flag somewhere inside a collapsed or badged node. A node standing in for
   * its contents has to stand in for their flags too, or folding a feature would
   * hide the fact that a story inside it is stuck.
   */
  flaggedInside: number;
  /**
   * The period chain this issue is scheduled in, and whether that period is
   * running today. Null when nothing schedules it.
   */
  schedule: Placement | null;
  /**
   * Registry views only: this is the template somebody instantiates, rather
   * than one of the documents it produces. The one distinction the registry
   * adds to the canvas, and the id `lpm template apply` takes.
   */
  templateRoot: boolean;
  /** Registry views only: what the template is for, as the listing shows it. */
  templateDescription: string;
  /**
   * The badged ancestors this node stands under, outermost first — the levels
   * the view draws as a label rather than as a box around it.
   */
  lineage: LineageBadge[];
  /**
   * How small this node may be dragged: a readable minimum for a leaf, and for
   * a subflow the extent of its children. Filled in by `fitGroups`, which is
   * the only place that knows it, and carried on the data because SvelteFlow
   * builds the node components itself.
   */
  minWidth?: number;
  minHeight?: number;
  /**
   * One hop from the selection: a neighbour of the selected node, or an end of
   * the selected edge. Set by `CanvasGraph.refreshHighlights`, not by
   * `buildGraph` — it changes on every click and must not cost a rebuild.
   */
  related?: boolean;
  /**
   * The sync state this issue is in against the remote driving the canvas:
   * `ahead`, `behind`, `conflicted` or `unlinked`. Undefined means in sync
   * (or no remote read), and the node carries no mark. A different axis from
   * status — drawn as a corner mark, never as a fill.
   */
  sync?: SyncBadge;
}

export interface CanvasNode {
  id: string;
  type: 'issue' | 'group';
  data: CanvasNodeData;
  position: { x: number; y: number };
  parentId?: string;
  width: number;
  height: number;
  /** The floor `fitGroups` worked out for this node; see `CanvasNodeData`. */
  minWidth: number;
  minHeight: number;
  /** Depth in the visible tree, used only to stack z-indexes predictably. */
  level: number;
}

function assigneeLabel(nodes: WorkingNodes, issue: IssueDto): string | null {
  if (!issue.assignee) return null;
  return nodes[issue.assignee]?.title ?? issue.assignee;
}

function effortOf(config: ConfigDto, node: NodeDto): number | null {
  if (!config.effortAttribute) return null;
  const value = node.attributes[config.effortAttribute];
  return typeof value === 'number' ? value : null;
}

/**
 * Flagged issues this node is standing in for.
 *
 * `representative` already answers "which drawn node speaks for this one?" for
 * every member — that is how a dependency inside a collapsed feature becomes an
 * edge on the feature — so the same map is what makes a fold honest about the
 * work stuck inside it.
 */
function countFlaggedInside(input: GraphInput, tree: VisibleTree, id: string): number {
  let count = 0;
  for (const node of Object.values(input.nodes)) {
    if (node.kind !== 'issue' || !node.flag || node.id === id) continue;
    // Containers folded away in here carry the rolled-up flag of the same
    // stopped work, so counting them would report one stall several times.
    // @see src/shared/flag-rollup.ts
    if (isDerivedFlag(node.flag)) continue;
    if (tree.representative.get(node.id) === id) count += 1;
  }
  return count;
}

function countHiddenChildren(input: GraphInput, tree: VisibleTree, id: string): number {
  return Object.values(input.nodes).filter(
    (node) =>
      node.parentId === id &&
      !tree.visible.has(node.id) &&
      !tree.isBadged(node.id),
  ).length;
}

export function buildNodes(input: GraphInput, tree: VisibleTree): CanvasNode[] {
  const current = currentPeriodIds(input.nodes, input.today ?? todayIso());
  // A board working as one queue draws no period badge: everything is in the
  // one run, and the period each issue keeps is for when the board switches back.
  const scheduled = plansWithPeriods(input.config);

  const levelOf = (id: string): number => {
    let level = 0;
    let parent = tree.parentOf.get(id) ?? null;
    while (parent) {
      level += 1;
      parent = tree.parentOf.get(parent) ?? null;
    }
    return level;
  };

  return [...tree.visible].map((id) => {
    const node = input.nodes[id]!;
    const children = tree.childrenOf.get(id) ?? [];
    const group = children.length > 0;
    return {
      id,
      type: group ? 'group' : 'issue',
      parentId: tree.parentOf.get(id) ?? undefined,
      position: { x: 0, y: 0 },
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      minWidth: NODE_WIDTH,
      minHeight: NODE_HEIGHT,
      level: levelOf(id),
      data: {
        node,
        typeLabel: input.config.types[node.type]?.label ?? node.type,
        tone: node.kind === 'issue' ? statusTone(input.config, node.status) : 'todo',
        group,
        collapsible: (tree.memberChildrenOf.get(id) ?? []).length > 0,
        collapsed: input.isCollapsed(id),
        hiddenChildren: countHiddenChildren(input, tree, id),
        lineage: (tree.lineageOf.get(id) ?? []).map((ancestorId) => {
          const ancestor = input.nodes[ancestorId];
          return {
            id: ancestorId,
            title: ancestor?.title ?? ancestorId,
            typeLabel: input.config.types[ancestor?.type ?? '']?.label ?? '',
          };
        }),
        assigneeLabel: node.kind === 'issue' ? assigneeLabel(input.nodes, node) : null,
        effort: effortOf(input.config, node),
        flag: node.kind === 'issue' ? node.flag : null,
        flaggedInside: countFlaggedInside(input, tree, id),
        schedule: scheduled ? placementOf(input.nodes, node, current) : null,
        templateRoot: node.kind === 'template' && node.root,
        templateDescription: node.kind === 'template' ? node.description : '',
        ...(node.kind === 'issue' && input.syncBadges?.[id]
          ? { sync: input.syncBadges[id] }
          : {}),
      },
    } satisfies CanvasNode;
  });
}
