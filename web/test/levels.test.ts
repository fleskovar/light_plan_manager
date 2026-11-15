import { describe, expect, it } from 'vitest';
import type { NodeLayout } from '$shared';
import {
  clampLevel,
  hierarchyLevels,
  isFolded,
  levelKey,
  switchLevel,
} from '$lib/board/levels.js';
import { buildGraph } from '$features/canvas/model.js';
import { board, config, issue } from './fixtures.js';

/**
 * The detail level of the canvas.
 *
 * The board: program P > epic E > features F1, F2, F3 > stories.
 *
 * - S2 (in F1) waits on S1 (in F1). Both ends sit in F1.
 * - S3 (in F2) waits on S2 (in F1). F2 depends on F1 only through S3 and S2.
 * - S4 (in F2) waits on S1 (in F1). A second link from F1 to F2.
 * - F3 waits on F2 directly, and S5 (in F3) waits on S4 (in F2).
 *
 * In the fixture hierarchy the features sit at depth 2.
 */
const nodes = () =>
  board(
    issue('P', 'program', null),
    issue('E', 'epic', 'P'),
    issue('F1', 'feature', 'E'),
    issue('F2', 'feature', 'E'),
    issue('F3', 'feature', 'E', { dependsOn: ['F2'] }),
    issue('S1', 'user_story', 'F1'),
    issue('S2', 'user_story', 'F1', { dependsOn: ['S1'] }),
    issue('S3', 'user_story', 'F2', { dependsOn: ['S2'] }),
    issue('S4', 'user_story', 'F2', { dependsOn: ['S1'] }),
    issue('S5', 'user_story', 'F3', { dependsOn: ['S4'] }),
  );

const ALL = ['P', 'E', 'F1', 'F2', 'F3', 'S1', 'S2', 'S3', 'S4', 'S5'];
const FEATURES = 2;

/** The graph at `level`, with the `collapsed` keys of `layout` as overrides. */
function graphAt(level: number | null, layout: Record<string, NodeLayout> = {}) {
  const all = nodes();
  return buildGraph({
    nodes: all,
    config,
    members: ALL,
    isCollapsed: (id) => isFolded(layout[id], all[id]!.depth, level),
  });
}

const drawn = (graph: ReturnType<typeof graphAt>): string[] =>
  graph.nodes.map((node) => node.id).sort();

const edge = (graph: ReturnType<typeof graphAt>, id: string) =>
  graph.edges.find((entry) => entry.id === id);

describe('hierarchyLevels', () => {
  it('names each level, top first, with the members at that depth', () => {
    const levels = hierarchyLevels(config, 'issue', nodes(), ALL, {});
    expect(levels.map((level) => level.label)).toEqual([
      'Program',
      'Epic',
      'Feature',
      'User Story / Bug',
      'Sub-task',
    ]);
    expect(levels.map((level) => level.members)).toEqual([1, 1, 3, 5, 0]);
  });

  it('marks a level that the view draws as badges', () => {
    const levels = hierarchyLevels(config, 'issue', nodes(), ALL, { epic: 'badge' });
    expect(levels.map((level) => level.badged)).toEqual([false, true, false, false, false]);
  });

  it('leaves the registry folder out of the names', () => {
    const levels = hierarchyLevels(config, 'template', nodes(), [], {});
    expect(levels[0]!.label).toBe('Program');
    expect(levels[0]!.types).toEqual(['program']);
  });
});

describe('clampLevel', () => {
  it('keeps a level above the deepest one', () => {
    expect(clampLevel(0, 5)).toBe(0);
    expect(clampLevel(3, 5)).toBe(3);
  });

  it('gives null for the deepest level, for no level and for a bad value', () => {
    expect(clampLevel(4, 5)).toBeNull();
    expect(clampLevel(9, 5)).toBeNull();
    expect(clampLevel(undefined, 5)).toBeNull();
    expect(clampLevel(null, 5)).toBeNull();
    expect(clampLevel(-1, 5)).toBeNull();
    expect(clampLevel(1.5, 5)).toBeNull();
  });
});

describe('isFolded', () => {
  it('folds a node at the level or deeper', () => {
    expect(isFolded(undefined, 1, FEATURES)).toBe(false);
    expect(isFolded(undefined, 2, FEATURES)).toBe(true);
    expect(isFolded(undefined, 3, FEATURES)).toBe(true);
  });

  it('folds nothing without a level', () => {
    expect(isFolded(undefined, 2, null)).toBe(false);
  });

  it('lets the key collapsed of the node decide over the level', () => {
    expect(isFolded({ collapsed: false }, 2, FEATURES)).toBe(false);
    expect(isFolded({ collapsed: true }, 1, FEATURES)).toBe(true);
    expect(isFolded({ collapsed: true }, 1, null)).toBe(true);
  });
});

describe('the canvas at the feature level', () => {
  it('draws the features and folds the stories into them', () => {
    expect(drawn(graphAt(FEATURES))).toEqual(['E', 'F1', 'F2', 'F3', 'P']);
    const f2 = graphAt(FEATURES).nodes.find((node) => node.id === 'F2')!;
    expect(f2.data.collapsed).toBe(true);
    expect(f2.data.foldedInside).toBe(2);
  });

  it('draws an implied edge between two features whose stories depend on each other', () => {
    const f1f2 = edge(graphAt(FEATURES), 'F1->F2');
    expect(f1f2).toMatchObject({ aggregated: true, written: false });
    // S3 waits on S2 and S4 waits on S1: two dependencies, one edge.
    expect(f1f2!.links).toEqual([
      { from: 'S2', to: 'S3' },
      { from: 'S1', to: 'S4' },
    ]);
  });

  it('marks an edge as written when the two features depend on each other directly', () => {
    const f2f3 = edge(graphAt(FEATURES), 'F2->F3');
    expect(f2f3).toMatchObject({ aggregated: true, written: true });
    expect(f2f3!.links).toHaveLength(2);
  });

  it('draws nothing for a dependency inside one feature', () => {
    // S2 waits on S1, and both are in F1.
    expect(graphAt(FEATURES).edges.map((entry) => entry.id).sort()).toEqual([
      'F1->F2',
      'F2->F3',
    ]);
  });

  it('marks a leaf node at the level as not collapsed', () => {
    const graph = buildGraph({
      nodes: nodes(),
      config,
      members: ['F1'],
      isCollapsed: () => true,
    });
    expect(graph.nodes[0]!.data.collapsed).toBe(false);
  });

  it('opens one feature when its key collapsed is false', () => {
    const graph = graphAt(FEATURES, { F1: { x: 0, y: 0, collapsed: false } });
    expect(drawn(graph)).toEqual(['E', 'F1', 'F2', 'F3', 'P', 'S1', 'S2']);
    // The stories of F1 are drawn, so each edge starts at the story itself.
    expect(graph.edges.map((entry) => entry.id).sort()).toEqual([
      'F2->F3',
      'S1->F2',
      'S1->S2',
      'S2->F2',
    ]);
  });

  it('draws every edge between stories without a level', () => {
    const graph = graphAt(null);
    expect(graph.edges.every((entry) => entry.written && !entry.aggregated)).toBe(true);
  });
});

describe('switchLevel', () => {
  const layout: Record<string, NodeLayout> = {
    F1: { x: 10, y: 20, collapsed: true, width: 400 },
    F2: { x: 30, y: 40 },
  };

  it('stores the arrangement of the level it leaves', () => {
    const result = switchLevel(layout, {}, null, FEATURES);
    expect(result.levelLayouts[levelKey(null)]).toEqual({
      F1: { x: 10, y: 20, collapsed: true },
      F2: { x: 30, y: 40 },
    });
    expect(result.restored).toBe(false);
  });

  it('removes every collapsed key when the new level has no arrangement', () => {
    const result = switchLevel(layout, {}, null, FEATURES);
    expect(result.layout).toEqual({ F1: { x: 10, y: 20, width: 400 }, F2: { x: 30, y: 40 } });
  });

  it('restores the arrangement of a level visited before, and keeps the sizes', () => {
    const away = switchLevel(layout, {}, null, FEATURES);
    const moved = { ...away.layout, F1: { ...away.layout.F1!, x: 500 } };
    const back = switchLevel(moved, away.levelLayouts, FEATURES, null);

    expect(back.restored).toBe(true);
    expect(back.layout).toEqual(layout);
    // The live layout holds the restored level now, so its copy is gone.
    expect(Object.keys(back.levelLayouts)).toEqual([levelKey(FEATURES)]);
    expect(back.levelLayouts[levelKey(FEATURES)]!.F1).toEqual({ x: 500, y: 20 });
  });

  it('does not change its inputs', () => {
    const before = structuredClone(layout);
    switchLevel(layout, {}, null, FEATURES);
    expect(layout).toEqual(before);
  });
});
