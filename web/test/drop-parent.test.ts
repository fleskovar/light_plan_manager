import { describe, expect, it } from 'vitest';
import type { TypeDisplay } from '$shared';
import { dropParent } from '$features/canvas/Canvas.svelte.js';
import { buildGraph } from '$features/canvas/model.js';
import { board, config, issue, sampleBoard } from './fixtures.js';

/**
 * Which drops on the canvas change a parent.
 *
 * The board: P (program) > E (epic) > F1, F2 (features) > S1..S4 (stories),
 * plus a second epic E2 > F3 > S5. Each case builds the graph that the canvas
 * draws, then asks `dropParent` what a drop of one node onto another means.
 */
const nodes = board(
  ...Object.values(sampleBoard()),
  issue('E2', 'epic', 'P'),
  issue('F3', 'feature', 'E2'),
  issue('S5', 'user_story', 'F3'),
);

function canvas(
  members: string[],
  options: { scope?: string; display?: Record<string, TypeDisplay> } = {},
) {
  const graph = buildGraph({
    nodes,
    config,
    members,
    isCollapsed: () => false,
    scope: options.scope ?? null,
    display: options.display,
  });
  const drawn = new Set(graph.nodes.map((node) => node.id));
  const frameOf = (id: string) => graph.nodes.find((node) => node.id === id)?.parentId;
  const drop = (id: string, targetId: string | null) =>
    dropParent({
      parentId: nodes[id]?.parentId ?? null,
      targetId,
      drawn,
      scope: options.scope ?? null,
    });
  return { drawn, frameOf, drop };
}

describe('dropParent', () => {
  describe('a story whose parents the view hides', () => {
    // The view holds epic E with its children, and story S5 from epic E2.
    // F3 and E2 are not in the view.
    const view = canvas(['E', 'F1', 'F2', 'S1', 'S2', 'S3', 'S4', 'S5']);

    it('draws the story at the top level', () => {
      expect(view.drawn.has('F3')).toBe(false);
      expect(view.frameOf('S5')).toBeUndefined();
    });

    it('only moves the story when it is dropped on the frame of another epic', () => {
      expect(view.drop('S5', 'E')).toBeNull();
    });

    it('only moves the story when it is dropped on a feature or a story', () => {
      expect(view.drop('S5', 'F1')).toBeNull();
      expect(view.drop('S5', 'S1')).toBeNull();
    });

    it('only moves the story when it is dropped on the empty canvas', () => {
      expect(view.drop('S5', null)).toBeNull();
    });
  });

  describe('a story whose parent the view shows', () => {
    const view = canvas(['E', 'F1', 'F2', 'S1', 'S2', 'S3', 'S4']);

    it('changes the parent when the story is dropped on another feature', () => {
      expect(view.drop('S1', 'F2')).toBe('F2');
    });

    it('changes the parent when the story is dropped on the epic', () => {
      expect(view.drop('S1', 'E')).toBe('E');
    });

    it('only moves the story when it is dropped inside its own feature', () => {
      expect(view.drop('S1', 'F1')).toBeNull();
      expect(view.drop('S1', null)).toBeNull();
    });
  });

  describe('a story whose parent the view draws as a badge', () => {
    // Features are badges, so S1 is drawn inside the frame of E.
    const view = canvas(['E', 'F1', 'F2', 'S1', 'S2', 'S3', 'S4'], {
      display: { feature: 'badge' },
    });

    it('draws the story inside the frame of the epic', () => {
      expect(view.drawn.has('F1')).toBe(false);
      expect(view.frameOf('S1')).toBe('E');
    });

    it('only moves the story when it is dropped inside the frame of the epic', () => {
      expect(view.drop('S1', 'E')).toBeNull();
    });
  });

  describe('edit mode with an active item', () => {
    // E is the active item. F1 and F2 are drawn at the top level, without E.
    const view = canvas(['E', 'F1', 'F2', 'S1', 'S2', 'S3', 'S4'], { scope: 'E' });

    it('treats the active item as a parent that the canvas shows', () => {
      expect(view.drawn.has('E')).toBe(false);
      expect(view.drop('F1', 'F2')).toBe('F2');
    });
  });

  describe('a node at the top of the board', () => {
    const view = canvas(['P', 'E', 'E2']);

    it('changes the parent when the node is dropped on another node', () => {
      expect(view.drop('P', 'E2')).toBe('E2');
    });
  });
});
