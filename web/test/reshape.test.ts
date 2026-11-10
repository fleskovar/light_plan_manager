import { describe, expect, it } from 'vitest';
import type { NodeLayout } from '$shared';
import { Selection } from '$lib/workspace/selection.svelte.js';
import { dragKindOf } from '$features/canvas/Canvas.svelte.js';
import { CanvasGraph } from '$features/canvas/graph.svelte.js';
import { GROUP_HEADER, GROUP_PADDING, NODE_HEIGHT, NODE_WIDTH } from '$features/canvas/model.js';
import { PUSH_GAP, reshape, separation, type Box } from '$features/canvas/reshape.js';
import type { GraphSource } from '$features/canvas/source.js';
import { config, sampleBoard } from './fixtures.js';

/**
 * Push and grow.
 *
 * A plain drag or a resize on the canvas pushes the nodes that it meets and
 * grows the frames around the node. The constants in these cases:
 * `PUSH_GAP` = 24, `GROUP_PADDING` = 24 and `GROUP_HEADER` = 64.
 */
const box = (id: string, x: number, y: number, width = 100, height = 50, parentId?: string): Box => ({
  id,
  parentId,
  position: { x, y },
  width,
  height,
});

const byId = (boxes: Box[]) => new Map(boxes.map((entry) => [entry.id, entry]));

const moveTo = (boxes: Box[], id: string, x: number, y: number): Box[] =>
  boxes.map((entry) => (entry.id === id ? { ...entry, position: { x, y } } : entry));

describe('constants', () => {
  it('has the values that the cases below are computed with', () => {
    expect([PUSH_GAP, GROUP_PADDING, GROUP_HEADER]).toEqual([24, 24, 64]);
  });
});

describe('separation', () => {
  it('moves the other box along the shortest of the four directions', () => {
    // The mover spans x 100..200. The other box starts at x 180.
    // Right: 200 + 24 - 180 = 44. Down and up: 74. Left: 204.
    expect(separation(box('A', 100, 64), box('B', 180, 64))).toEqual({ x: 44, y: 0 });
  });

  it('returns null for a box that is PUSH_GAP or more away', () => {
    expect(separation(box('A', 0, 0), box('B', 124, 0))).toBeNull();
    expect(separation(box('A', 0, 0), box('B', 123, 0))).toEqual({ x: 1, y: 0 });
  });
});

describe('reshape', () => {
  // Frame F at (0, 0), 400 x 300, holds A at (24, 64) and B at (180, 64).
  // Frame G sits to the right of F at (440, 0).
  const start = [
    box('F', 0, 0, 400, 300),
    box('A', 24, 64, 100, 50, 'F'),
    box('B', 250, 64, 100, 50, 'F'),
    box('G', 440, 0, 400, 300),
  ];

  it('changes nothing when the held node meets nothing and stays inside its frame', () => {
    const result = reshape(moveTo(start, 'A', 24, 200), new Set(['A']));
    expect(result).toEqual(moveTo(start, 'A', 24, 200));
  });

  it('grows the frame to the right and down to GROUP_PADDING past the child', () => {
    // A at (30, 300) reaches y 350, so F is 350 + 24 = 374 high.
    const result = byId(reshape(moveTo(start, 'A', 30, 300), new Set(['A'])));
    expect(result.get('F')).toMatchObject({ position: { x: 0, y: 0 }, width: 400, height: 374 });
  });

  it('grows the frame to the left and moves its children back, so no child moves on screen', () => {
    // A at x -50 is 74 short of GROUP_PADDING. F moves 74 left and is 74 wider.
    const result = byId(reshape(moveTo(start, 'A', -50, 64), new Set(['A'])));
    expect(result.get('F')).toMatchObject({ position: { x: -74, y: 0 }, width: 474 });
    expect(result.get('A')!.position).toEqual({ x: 24, y: 64 });
    expect(result.get('B')!.position).toEqual({ x: 324, y: 64 });
    // On screen: A at -74 + 24 = -50, and B at -74 + 324 = 250, where it was.
  });

  it('grows the frame up to GROUP_HEADER above its first child', () => {
    // A at y 10 is 54 short of GROUP_HEADER.
    const result = byId(reshape(moveTo(start, 'A', 24, 10), new Set(['A'])));
    expect(result.get('F')).toMatchObject({ position: { x: 0, y: -54 }, height: 354 });
    expect(result.get('A')!.position).toEqual({ x: 24, y: 64 });
  });

  it('pushes a sibling that the held node overlaps, to PUSH_GAP from it', () => {
    // A spans x 200..300 and meets B at x 250. Right: 300 + 24 - 250 = 74.
    const result = byId(reshape(moveTo(start, 'A', 200, 64), new Set(['A'])));
    expect(result.get('B')!.position).toEqual({ x: 324, y: 64 });
  });

  it('pushes the next frame when a frame grows into it', () => {
    // A at x 330 reaches 430, so F is 454 wide and spans 0..454.
    // G at x 440 is 454 + 24 - 440 = 38 too close, and moves to x 478.
    // B is pushed first: A spans 330..430 and B at 250 moves left to 206.
    const result = byId(reshape(moveTo(start, 'A', 330, 64), new Set(['A'])));
    expect(result.get('B')!.position).toEqual({ x: 206, y: 64 });
    expect(result.get('F')!.width).toBe(454);
    expect(result.get('G')!.position).toEqual({ x: 478, y: 0 });
  });

  it('passes a push on to the next sibling', () => {
    const row = [
      box('A', 0, 0),
      box('B', 124, 0),
      box('C', 248, 0),
    ];
    // A moves 10 right. B moves to 10 + 124 = 134, and C to 258.
    const result = byId(reshape(moveTo(row, 'A', 10, 0), new Set(['A'])));
    expect(result.get('B')!.position.x).toBe(134);
    expect(result.get('C')!.position.x).toBe(258);
  });

  it('never moves a held node, even when two held nodes overlap', () => {
    const both = [box('A', 0, 0), box('B', 50, 0)];
    expect(reshape(both, new Set(['A', 'B']))).toEqual(both);
  });

  it('never makes a frame smaller', () => {
    const result = byId(reshape(moveTo(start, 'A', 100, 100), new Set(['A'])));
    expect(result.get('F')).toMatchObject({ position: { x: 0, y: 0 }, width: 400, height: 300 });
  });

  it('does not change the boxes that it receives', () => {
    const copy = structuredClone(start);
    reshape(moveTo(start, 'A', 330, 64), new Set(['A']));
    expect(start).toEqual(copy);
  });
});

describe('dragKindOf', () => {
  it('gives a plain drag the push and grow, and an Alt drag the changes to the board', () => {
    expect(dragKindOf({ altKey: false })).toBe('reshape');
    expect(dragKindOf({ altKey: true })).toBe('structure');
  });
});

describe('CanvasGraph push and grow', () => {
  // F1 is drawn at the top level, because E is not in the view.
  // S1 and S2 are its children, side by side.
  function setup() {
    const layout: Record<string, NodeLayout> = {
      F1: { x: 0, y: 0 },
      S1: { x: 24, y: 64 },
      S2: { x: 338, y: 64 },
    };
    const source: GraphSource = {
      ready: true,
      nodes: sampleBoard(),
      config,
      members: ['F1', 'S1', 'S2'],
      layout,
      display: {},
      selection: new Selection(),
      isCollapsed: () => false,
      toggleCollapsed: () => {},
      setLayout: (id, next) => {
        layout[id] = { ...(layout[id] ?? { x: 0, y: 0 }), ...next };
      },
    };
    const graph = new CanvasGraph(source);
    graph.sync();
    const node = (id: string) => graph.nodes.find((entry) => entry.id === id)!;
    return { graph, layout, node };
  }

  it('draws children without the extent parent, so a plain drag can leave the frame', () => {
    const { node } = setup();
    expect(node('S1').extent).toBeUndefined();
  });

  it('grows the frame down while a child is dragged below it', () => {
    const { graph, node } = setup();
    graph.beginReshape();
    graph.reshapeDrag([{ id: 'S1', position: { x: 24, y: 300 } }]);
    expect(node('F1').height).toBe(300 + NODE_HEIGHT + GROUP_PADDING);
  });

  it('pushes a sibling while a child is dragged into it', () => {
    const { graph, node } = setup();
    graph.beginReshape();
    // S1 spans x 200..464 and meets S2 at x 338. Down is the shortest push:
    // 64 + 96 + 24 - 64 = 120.
    graph.reshapeDrag([{ id: 'S1', position: { x: 200, y: 64 } }]);
    expect(node('S2').position).toEqual({ x: 338, y: 64 + NODE_HEIGHT + PUSH_GAP });
  });

  it('keeps a child under the pointer when the frame grows to the left', () => {
    const { graph, node } = setup();
    graph.beginReshape();
    graph.reshapeDrag([{ id: 'S1', position: { x: -100, y: 64 } }]);
    expect(node('F1').position).toEqual({ x: -124, y: 0 });
    expect(node('S1').position).toEqual({ x: 24, y: 64 });

    // SvelteFlow now measures S1 from the frame at x -124. The pointer has
    // not moved, so it reports x 24, and nothing changes.
    graph.reshapeDrag([{ id: 'S1', position: { x: 24, y: 64 } }]);
    expect(node('F1').position).toEqual({ x: -124, y: 0 });
    expect(node('S2').position).toEqual({ x: 338 + 124, y: 64 });
  });

  it('puts the frame and the siblings back when the child returns during the same drag', () => {
    const { graph, node } = setup();
    graph.beginReshape();
    graph.reshapeDrag([{ id: 'S1', position: { x: -100, y: 64 } }]);
    // Back at screen x 24, which is 148 from the frame at x -124.
    graph.reshapeDrag([{ id: 'S1', position: { x: 148, y: 64 } }]);
    expect(node('F1').position).toEqual({ x: 0, y: 0 });
    expect(node('S1').position).toEqual({ x: 24, y: 64 });
    expect(node('S2').position).toEqual({ x: 338, y: 64 });
  });

  it('saves the positions at the end of a drag, and leaves the frame size to fitGroups', () => {
    const { graph, layout } = setup();
    graph.beginReshape();
    graph.reshapeDrag([{ id: 'S1', position: { x: -100, y: 64 } }]);
    graph.endReshape();
    expect(layout.F1).toEqual({ x: -124, y: 0 });
    expect(layout.S2).toEqual({ x: 462, y: 64 });
    expect(layout.F1!.width).toBeUndefined();
  });

  it('saves the position of the dragged child that the last grow gave it', () => {
    const { graph, layout } = setup();
    graph.beginReshape();
    graph.reshapeDrag([{ id: 'S1', position: { x: -100, y: 64 } }]);
    // At the end of a drag, SvelteFlow writes back the position that it
    // measured before the frame grew: x -100 from the frame at its old place.
    graph.nodes = graph.nodes.map((entry) =>
      entry.id === 'S1' ? { ...entry, position: { x: -100, y: 64 } } : entry,
    );
    graph.endReshape();
    expect(layout.S1).toEqual({ x: 24, y: 64 });
  });

  it('puts everything back when the drag is cancelled', () => {
    const { graph, node, layout } = setup();
    graph.beginReshape();
    graph.reshapeDrag([{ id: 'S1', position: { x: 200, y: 64 } }]);
    graph.cancelReshape();
    expect(node('S2').position).toEqual({ x: 338, y: 64 });
    expect(layout.S2).toEqual({ x: 338, y: 64 });
  });

  it('pushes and grows during a resize, and saves the size at the end', () => {
    const { graph, node, layout } = setup();
    graph.beginReshape();
    // S1 grows to 400 wide and now spans x 24..424, into S2 at x 338.
    graph.reshapeResize('S1', { x: 24, y: 64, width: 400, height: NODE_HEIGHT });
    expect(node('S2').position.x).toBe(424 + PUSH_GAP);
    graph.endResize('S1', { width: 400, height: NODE_HEIGHT });
    expect(layout.S1).toMatchObject({ x: 24, y: 64, width: 400, height: NODE_HEIGHT });
    expect(layout.S2).toMatchObject({ x: 448, y: 64 });
  });

  it('does nothing without a gesture', () => {
    const { graph, node } = setup();
    graph.reshapeDrag([{ id: 'S1', position: { x: 200, y: 64 } }]);
    expect(node('S2').position).toEqual({ x: 338, y: 64 });
  });

  it('clamps the children for an Alt drag, and lets them out after it', () => {
    const { graph, node } = setup();
    graph.clampToParents(true);
    expect(node('S1').extent).toBe('parent');
    expect(node('F1').extent).toBeUndefined();
    graph.clampToParents(false);
    expect(node('S1').extent).toBeUndefined();
  });

  it('measures a node with the default size when SvelteFlow has not measured it', () => {
    const { node } = setup();
    expect(node('S1').width).toBe(NODE_WIDTH);
  });
});
