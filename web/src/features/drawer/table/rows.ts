import type { NodeDto, NodeKind } from '$shared';
import { childrenOf, rootsOf } from '$lib/board/selectors.js';
import type { WorkingNodes } from '$lib/board/working.js';
import type { NodeIndex } from '$lib/board/index.js';

/**
 * Flattening a tree into table rows.
 *
 * The table shows the whole board rather than just the view, because that is
 * what makes it useful for comparing issues side by side and for finding the
 * one you meant to import. Collapsing is a property of the table, not of the
 * canvas — the same issue can be folded here and expanded there.
 *
 * ## Two independent concerns
 *
 * **Reachability** — who controls whether a subtree is visited at all.
 * Only two things reach into a subtree:
 * 1. The **twisty** (`isExpanded`): when open the walk descends, when
 *    closed the entire subtree is skipped — children are not even
 *    inspected by the filter.  A parent says "show my children" and the
 *    walk obeys.
 * 2. **Search** (`search`): text search forces every branch open so a
 *    match is never hidden behind a collapsed parent.
 *
 * **Visibility** — once a node is reached, should it appear in the
 * output?  Two predicates, both must pass:
 * 1. The **text search** matches the node's title, id or type.
 * 2. The **keep** callback (quick-filter + facets) accepts the node.
 *
 * An ancestor that fails both predicates is *still shown* when a
 * descendant passes, because a story must never float free of its
 * feature.
 */
export interface TableRow {
  node: NodeDto;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

export interface RowOptions {
  kind?: NodeKind;
  isExpanded: (id: string) => boolean;
  /** Full-text search across title, id and type.  Forces every branch
   *  open so matches are never hidden. */
  search?: string;
  /**
   * Optional predicate a node must satisfy (or have a descendant that
   * satisfies) before it appears in the table.  Only called for nodes
   * that are reached during the tree walk — collapsed subtrees are
   * skipped before the filter ever sees them.
   */
  keep?: (node: NodeDto) => boolean;
  /**
   * Sort comparator applied within each parent's children list.
   * Defaults to title-locale. Hierarchy is preserved — rows are sorted
   * at every level independently, never flattened.
   */
  compare?: (a: NodeDto, b: NodeDto) => number;
}

function matches(node: NodeDto, needle: string): boolean {
  return (
    node.title.toLowerCase().includes(needle) ||
    node.id.toLowerCase().includes(needle) ||
    node.type.toLowerCase().includes(needle)
  );
}

export function buildRows(
  nodes: WorkingNodes,
  options: RowOptions,
  index?: NodeIndex,
): TableRow[] {
  const kind = options.kind ?? 'issue';
  const needle = options.search?.trim().toLowerCase() ?? '';
  const byTitle = (a: NodeDto, b: NodeDto): number =>
    a.title.localeCompare(b.title);
  const compare = options.compare ?? byTitle;
  const keep = options.keep;

  const rows: TableRow[] = [];

  // Search forces every branch open — a text match must never be hidden
  // behind a collapsed parent.  Everything else respects the twisty.
  const searching = needle !== '';

  /**
   * Walk the issue tree depth-first, honouring the twisty.
   *
   * Returns `true` when this node (or a descendant reached during this
   * walk) passes every filter, so ancestors can decide to stay visible.
   */
  const walk = (node: NodeDto, depth: number): boolean => {
    // Copy before sorting: with an index, `childrenOf` hands back the index's
    // own array, and sorting in place would reorder it for every other reader.
    const children = [...childrenOf(nodes, node.id, index)].sort(compare);
    const expanded = searching || options.isExpanded(node.id);

    // ---- visibility predicates ---------------------------------------
    const selfPasses =
      (!needle || matches(node, needle)) && (!keep || keep(node));

    // ---- emit this row -----------------------------------------------
    const i = rows.length;
    rows.push({
      node,
      depth,
      hasChildren: children.length > 0,
      expanded,
    });

    // ---- recurse only when the twisty says so ------------------------
    let anyChildPasses = false;
    if (expanded) {
      for (const child of children) {
        if (walk(child, depth + 1)) {
          anyChildPasses = true;
        }
      }
    }

    // ---- keep this row when it or a descendant passes the filter -----
    const show = selfPasses || anyChildPasses;
    if (!show) rows.splice(i, 1);
    return show;
  };

  for (const root of [...rootsOf(nodes, kind, index)].sort(compare)) {
    walk(root, 0);
  }

  return rows;
}
