import type { CanvasEdge } from './model.js';

/**
 * What is one hop from what you clicked.
 *
 * A dependency graph is read by following it, so a selection is only half the
 * answer: the useful question is "and what does this one touch?". Selecting a
 * node lights up the issues immediately upstream and downstream of it and the
 * edges between them; selecting an edge lights up the two issues it joins. Both
 * end up in the same shape, which is why they are computed together.
 *
 * Edges here are the *visible* ones — a dependency that runs into a collapsed
 * subflow has already been rerouted onto the node standing in for it, so the
 * highlight follows what is on screen rather than what is in the documents.
 */
export interface Highlight {
  /** Nodes to draw as related: neighbours, and the ends of a selected edge. */
  nodes: Set<string>;
  /** Edges to draw as live: those touching the selection, and selected ones. */
  edges: Set<string>;
}

export const NO_HIGHLIGHT: Highlight = { nodes: new Set(), edges: new Set() };

export function relatedTo(
  edges: Pick<CanvasEdge, 'id' | 'source' | 'target'>[],
  selectedNodes: Iterable<string>,
  selectedEdges: Iterable<string> = [],
): Highlight {
  const nodes = new Set(selectedNodes);
  const chosen = new Set(selectedEdges);
  if (!nodes.size && !chosen.size) return { nodes: new Set(), edges: new Set() };

  const related: Highlight = { nodes: new Set(), edges: new Set() };

  for (const edge of edges) {
    const touchesSelection = nodes.has(edge.source) || nodes.has(edge.target);
    if (!touchesSelection && !chosen.has(edge.id)) continue;

    related.edges.add(edge.id);
    // The node at the other end is the interesting one; a selected node is
    // already drawn as selected and does not need to be drawn as related too.
    if (!nodes.has(edge.source)) related.nodes.add(edge.source);
    if (!nodes.has(edge.target)) related.nodes.add(edge.target);
  }

  return related;
}
