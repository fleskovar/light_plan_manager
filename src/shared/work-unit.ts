/**
 * The single definition of "what is a piece of work?", so the engine and the
 * browser cannot disagree about what counts.
 *
 * Both callers adapt their own data shapes to the minimal structural interface
 * declared here; neither imports anything from the other.
 *
 * See the doc comment on `isWorkUnit` for the rule itself.
 */

/** The minimal shape `isWorkUnit` needs from a node to walk its ancestors. */
export interface WorkUnitNode {
  id: string;
  parentId: string | null;
  type: string;
}

/**
 * The smallest thing the board hands out as work, and the one rule everything
 * that asks "what is a piece of work?" agrees on.
 *
 * By default that is a leaf: a feature is not a thing you pick up, it is the
 * name of the stories you do. A board moves the floor up by declaring an issue
 * type `atomic` — work of that type is taken whole, so a user story with
 * sub-tasks is offered as one unit and its sub-tasks are its checklist rather
 * than three separate tickets somebody could be handed on their own. Where
 * atomic types nest, the outermost one wins, because anything with an atomic
 * ancestor is already inside a unit.
 */
export function isWorkUnit(
  node: WorkUnitNode,
  isAtomicType: (type: string) => boolean,
  getParent: (id: string) => WorkUnitNode | undefined,
  hasChildren: boolean,
): boolean {
  // Atomic ancestor wins — this node is already inside somebody else's unit.
  const seen = new Set<string>([node.id]);
  let parentId = node.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = getParent(parentId);
    if (!parent) break;
    if (isAtomicType(parent.type)) return false;
    parentId = parent.parentId;
  }
  // Otherwise: this node itself is a unit if its type is atomic, or if it has
  // no children.
  return isAtomicType(node.type) || !hasChildren;
}

/**
 * Every node that the board would offer as one piece of work, in the order
 * given. The "has children" question is answered once, not once per node, so
 * the caller computes the set of parent ids and passes `isParent`.
 */
export function workUnits(
  nodes: WorkUnitNode[],
  isAtomicType: (type: string) => boolean,
  getParent: (id: string) => WorkUnitNode | undefined,
  isParent: (id: string) => boolean,
): WorkUnitNode[] {
  return nodes.filter((node) => isWorkUnit(node, isAtomicType, getParent, isParent(node.id)));
}
