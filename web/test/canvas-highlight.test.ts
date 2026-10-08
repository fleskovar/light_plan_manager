import { describe, expect, it } from 'vitest';
import { CanvasGraph } from '$features/canvas/graph.svelte.js';
import type { GraphSource } from '$features/canvas/source.js';
import { Selection } from '$lib/workspace/selection.svelte.js';
import type { NodeLayout, TypeDisplay } from '$shared';
import { config, sampleBoard } from './fixtures.js';

/**
 * `relatedTo` decides *what* is one hop from the selection; this is the step
 * that writes the answer onto SvelteFlow's arrays, where `DependencyEdge`
 * reads `data.related` to draw the colour and the travelling dash. It was the
 * one link in that chain nothing covered, so a selection that produced the
 * right `Highlight` and never reached an edge looked exactly like a working
 * canvas until somebody clicked a node.
 */
const members = ['F1', 'F2', 'S1', 'S2', 'S3', 'S4'];

function source(nodes = sampleBoard()): GraphSource & { selection: Selection } {
  const layout: Record<string, NodeLayout> = {};
  const collapsed = new Set<string>();
  return {
    ready: true,
    nodes,
    config,
    members,
    layout,
    display: {} as Record<string, TypeDisplay>,
    selection: new Selection(),
    isCollapsed: (id) => collapsed.has(id),
    toggleCollapsed: (id) => {
      if (!collapsed.delete(id)) collapsed.add(id);
    },
    setLayout: (id, next) => {
      layout[id] = { ...(layout[id] ?? { x: 0, y: 0 }), ...next };
    },
  };
}

/** A graph already published, so the flow arrays exist to be highlighted. */
function graphOf(nodes = sampleBoard()): { graph: CanvasGraph; selection: Selection } {
  const view = source(nodes);
  const graph = new CanvasGraph(view);
  graph.sync();
  return { graph, selection: view.selection };
}

/** The same board with S2 stopped, so the edge out of it is drawn red. */
function withFlag(): ReturnType<typeof sampleBoard> {
  const nodes = sampleBoard();
  const story = nodes.S2;
  if (story?.kind === 'issue') story.flag = 'blocked';
  return nodes;
}

const flag = (
  graph: CanvasGraph,
  id: string,
  key: 'related' | 'faded' | 'stalled',
): boolean =>
  Boolean((graph.edges.find((edge) => edge.id === id)?.data as Record<string, unknown>)?.[key]);

describe('CanvasGraph highlighting', () => {
  it('publishes edges with the highlight flags off when nothing is selected', () => {
    const { graph } = graphOf();

    expect(graph.edges.length).toBeGreaterThan(0);
    for (const edge of graph.edges) {
      expect(flag(graph, edge.id, 'related')).toBe(false);
      expect(flag(graph, edge.id, 'faded')).toBe(false);
    }
  });

  // The reported symptom: click a node, and the edges around it neither change
  // colour nor animate. Both come from one flag on one edge.
  it('marks the edges touching a selected node as related', () => {
    const { graph, selection } = graphOf();
    selection.set(['S2']);
    graph.syncSelection();

    expect(flag(graph, 'S1->S2', 'related')).toBe(true);
    expect(flag(graph, 'S2->S3', 'related')).toBe(true);
  });

  it('fades every edge the selection does not touch', () => {
    const { graph, selection } = graphOf();
    selection.set(['S2']);
    graph.syncSelection();

    expect(flag(graph, 'S3->S4', 'related')).toBe(false);
    expect(flag(graph, 'S3->S4', 'faded')).toBe(true);
    // A related edge is never also faded — that would draw it back at 25%.
    expect(flag(graph, 'S1->S2', 'faded')).toBe(false);
  });

  it('marks the neighbours as related, and never the selected node itself', () => {
    const { graph, selection } = graphOf();
    selection.set(['S2']);
    graph.syncSelection();

    const related = (id: string): boolean =>
      Boolean((graph.nodes.find((node) => node.id === id)?.data as Record<string, unknown>)?.related);
    expect(related('S1')).toBe(true);
    expect(related('S3')).toBe(true);
    expect(related('S2')).toBe(false);
  });

  it('clears the flags again when the selection is dropped', () => {
    const { graph, selection } = graphOf();
    selection.set(['S2']);
    graph.syncSelection();
    selection.clear();
    graph.syncSelection();

    for (const edge of graph.edges) {
      expect(flag(graph, edge.id, 'related')).toBe(false);
      expect(flag(graph, edge.id, 'faded')).toBe(false);
    }
  });

  // A rebuild goes through `#publish`, which re-derives the flags. Losing them
  // there is the version of this bug that only shows after an edit.
  it('keeps the flags across a rebuild while the selection stands', () => {
    const { graph, selection } = graphOf();
    selection.set(['S2']);
    graph.syncSelection();
    graph.sync();

    expect(flag(graph, 'S1->S2', 'related')).toBe(true);
    expect(flag(graph, 'S3->S4', 'faded')).toBe(true);
  });

  // `toFlowEdge` builds the tone and the animation; `refreshHighlights` writes
  // the highlight beside them. A spread that dropped either would take the
  // status colour off every edge the moment anything was selected.
  it('leaves the tone and the in-progress pulse alone', () => {
    const { graph, selection } = graphOf();
    const before = graph.edges.find((edge) => edge.id === 'S1->S2')!.data as Record<string, unknown>;
    expect(before.tone).toBe('active');
    expect(before.animated).toBe(true);

    selection.set(['S2']);
    graph.syncSelection();

    const after = graph.edges.find((edge) => edge.id === 'S1->S2')!.data as Record<string, unknown>;
    expect(after.tone).toBe('active');
    expect(after.animated).toBe(true);
  });
});

/**
 * A flagged blocker paints every edge leaving it red with nothing selected —
 * which only works if `stalled` reaches the flow arrays and survives every
 * later rewrite of an edge's data.
 */
describe('stalled edges', () => {
  it('reaches the published edges with nothing selected', () => {
    const { graph } = graphOf(withFlag());

    expect(flag(graph, 'S2->S3', 'stalled')).toBe(true);
    expect(flag(graph, 'S1->S2', 'stalled')).toBe(false);
    // The point of the feature: no click was needed to get there.
    expect(flag(graph, 'S2->S3', 'related')).toBe(false);
  });

  it('survives a highlight pass, whichever end is selected', () => {
    const { graph, selection } = graphOf(withFlag());
    selection.set(['S3']);
    graph.syncSelection();

    expect(flag(graph, 'S2->S3', 'stalled')).toBe(true);
    expect(flag(graph, 'S2->S3', 'related')).toBe(true);
    // And on an edge the selection pushed to the back.
    expect(flag(graph, 'S1->S2', 'faded')).toBe(true);
  });

  it('survives a rebuild', () => {
    const { graph } = graphOf(withFlag());
    graph.arrange();

    expect(flag(graph, 'S2->S3', 'stalled')).toBe(true);
  });
});
