import type { WorkingNodes } from '$lib/board/working.js';

/**
 * A view follows each branch that it shows whole.
 *
 * The table draws a Tree box on each row with children. The box is ticked when
 * the row and every document under it are members of the view. When a re-read
 * of the board brings a new document into such a branch, the document takes
 * the visibility of that branch: `arrivalsToShow` returns it, and the workspace
 * adds it to the members. A document arrives when its id is new, or when its
 * parent changed. MCP, the CLI and another window create documents this way.
 *
 * A branch with a hidden document in it is not shown whole, so a document that
 * arrives there stays off the canvas. The reader hid part of that branch, and
 * the view keeps that choice.
 *
 * A document that arrives under another arrival joins when its parent joins,
 * so a new feature with its stories comes in as one piece.
 */
export function arrivalsToShow(
  before: WorkingNodes,
  after: WorkingNodes,
  members: ReadonlySet<string>,
): string[] {
  // The first read of a view has nothing to compare with.
  if (!Object.keys(before).length) return [];

  const plannable = (kind: string): boolean => kind === 'issue' || kind === 'template';
  const arrivals = Object.values(after).filter(
    (node) =>
      plannable(node.kind) &&
      node.parentId !== null &&
      !members.has(node.id) &&
      (!before[node.id] || before[node.id]!.parentId !== node.parentId),
  );
  if (!arrivals.length) return [];

  const whole = shownWhole(before, members);

  // Parents first, so an arrival under an arrival sees whether its parent joined.
  const depthOf = (id: string): number => {
    let depth = 0;
    const seen = new Set<string>();
    let parent = after[id]?.parentId ?? null;
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      depth += 1;
      parent = after[parent]?.parentId ?? null;
    }
    return depth;
  };
  arrivals.sort((a, b) => depthOf(a.id) - depthOf(b.id));

  const joined = new Set<string>();
  for (const node of arrivals) {
    const parent = node.parentId!;
    if (whole.has(parent) || joined.has(parent)) joined.add(node.id);
  }
  return [...joined];
}

/** The ids whose document and every document under it, in `nodes`, are members. */
function shownWhole(nodes: WorkingNodes, members: ReadonlySet<string>): Set<string> {
  const children = new Map<string, string[]>();
  for (const node of Object.values(nodes)) {
    if (node.parentId) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node.id]);
  }
  const answers = new Map<string, boolean>();
  const isWhole = (id: string): boolean => {
    const known = answers.get(id);
    if (known !== undefined) return known;
    answers.set(id, false); // guards a parent cycle in a hand-edited board
    const answer = members.has(id) && (children.get(id) ?? []).every(isWhole);
    answers.set(id, answer);
    return answer;
  };
  const whole = new Set<string>();
  for (const id of members) if (isWhole(id)) whole.add(id);
  return whole;
}
