import type { ConfigDto, IssueDto, NodeDto, SyncBadge, TypeDisplay } from '$shared';
import type { WorkingNodes } from '$lib/board/working.js';

/**
 * Turning the working board into a graph: the visible tree.
 *
 * Two things take a node off the canvas, and they are opposites. **Collapsing**
 * hides what is *inside* a node, and the node stands in for it. **Badging** a
 * level hides the node itself and keeps its children, which are hoisted to
 * whatever is drawn above and carry its id as a badge — that is how a
 * four-level board becomes a graph of the stories that actually depend on each
 * other, still labelled with the feature each one belongs to.
 *
 * A badged issue with nothing under it to carry the badge is drawn anyway.
 * Otherwise it would simply vanish, and a view is not allowed to lose work.
 */

/** A parent the canvas draws on its children instead of drawing it as a node. */
export interface LineageBadge {
  id: string;
  title: string;
  typeLabel: string;
}

export interface VisibleTree {
  /** Ids drawn on the canvas. */
  visible: Set<string>;
  /** Visible id -> its visible parent, if any. */
  parentOf: Map<string, string | null>;
  /** Visible id -> its visible children. */
  childrenOf: Map<string, string[]>;
  /** Drawn id -> the drawn nodes it holds, collapsed or not. */
  memberChildrenOf: Map<string, string[]>;
  /** Any member id -> the visible node that stands for it. */
  representative: Map<string, string>;
  /** Visible id -> the badged ancestors it carries, outermost first. */
  lineageOf: Map<string, string[]>;
  /** True for a type the view draws as a badge rather than as a node. */
  isBadged: (id: string) => boolean;
}

export interface GraphInput {
  nodes: WorkingNodes;
  config: ConfigDto;
  members: string[];
  isCollapsed: (id: string) => boolean;
  today?: string;
  display?: Record<string, TypeDisplay>;
  /** Per-node sync badge, when a remote's drift report has been read. */
  syncBadges?: Readonly<Record<string, SyncBadge>>;
}

/** The member ancestors of `id`, nearest first. */
export function memberAncestors(nodes: WorkingNodes, members: Set<string>, id: string): string[] {
  const chain: string[] = [];
  const seen = new Set([id]);
  let current = nodes[id]?.parentId ?? null;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (members.has(current)) chain.push(current);
    current = nodes[current]?.parentId ?? null;
  }
  return chain;
}

/** Every ancestor of `id` on the board, nearest first, member or not. */
export function ancestorIds(nodes: WorkingNodes, id: string): string[] {
  const chain: string[] = [];
  const seen = new Set([id]);
  let current = nodes[id]?.parentId ?? null;
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = nodes[current]?.parentId ?? null;
  }
  return chain;
}

/**
 * Work out what is on screen.
 *
 * Collapsing and badging are opposites, and this function owns both.  See the
 * module doc comment for the design; the implementation is a single pass over
 * the members that records what is visible, what stands in for what, and which
 * ancestors each visible node carries as a badge.
 */
export function visibleTree(input: GraphInput): VisibleTree {
  const members = new Set(input.members.filter((id) => input.nodes[id]));
  const display = input.display ?? {};
  const badgedType = (id: string): boolean => display[input.nodes[id]?.type ?? ''] === 'badge';

  // Member children by nearest member ancestor.
  const nested = new Map<string, string[]>();
  for (const id of members) {
    const parent = memberAncestors(input.nodes, members, id)[0];
    if (parent) nested.set(parent, [...(nested.get(parent) ?? []), id]);
  }

  const carrying = new Map<string, boolean>();
  const carries = (id: string): boolean => {
    const known = carrying.get(id);
    if (known !== undefined) return known;
    carrying.set(id, false); // guards a parent cycle in a hand-edited board
    const answer = (nested.get(id) ?? []).some((child) => !badgedType(child) || carries(child));
    carrying.set(id, answer);
    return answer;
  };

  const drawn = (id: string): boolean => !badgedType(id) || !carries(id);

  const visible = new Set<string>();
  const parentOf = new Map<string, string | null>();
  const memberChildrenOf = new Map<string, string[]>();
  const representative = new Map<string, string>();
  const lineageOf = new Map<string, string[]>();

  for (const id of members) {
    const ancestors = memberAncestors(input.nodes, members, id).filter(drawn);
    const parent = ancestors[0] ?? null;
    if (drawn(id) && parent) {
      memberChildrenOf.set(parent, [...(memberChildrenOf.get(parent) ?? []), id]);
    }

    // The outermost collapsed ancestor swallows everything below it.
    const collapsedAt = ancestors.filter((ancestor) => input.isCollapsed(ancestor)).at(-1);
    if (collapsedAt) {
      representative.set(id, collapsedAt);
      continue;
    }
    if (!drawn(id)) {
      if (parent) representative.set(id, parent);
      continue;
    }
    visible.add(id);
    representative.set(id, id);
    parentOf.set(id, parent);

    // Badged ancestors between here and the node above.
    const lineage: string[] = [];
    for (const ancestor of ancestorIds(input.nodes, id)) {
      if (members.has(ancestor) && drawn(ancestor)) break;
      if (badgedType(ancestor)) lineage.unshift(ancestor);
    }
    if (lineage.length) lineageOf.set(id, lineage);
  }

  const childrenOf = new Map<string, string[]>();
  for (const id of visible) {
    const parent = parentOf.get(id) ?? null;
    if (parent) childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), id]);
  }

  return {
    visible,
    parentOf,
    childrenOf,
    memberChildrenOf,
    representative,
    lineageOf,
    isBadged: badgedType,
  };
}
