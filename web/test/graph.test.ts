import { describe, expect, it } from 'vitest';
import { GROUP_HEADER, GROUP_PADDING, buildGraph, visibleTree } from '$features/canvas/model.js';
import {
  MIN_LEAF_WIDTH,
  applyLayout,
  fitGroups,
  layoutGraph,
  placeNewNodes,
} from '$features/canvas/layout.js';
import { DERIVED_FLAG } from '$shared';
import { config, sampleBoard } from './fixtures.js';

const members = ['F1', 'F2', 'S1', 'S2', 'S3', 'S4'];

const graphOf = (collapsed: string[] = []) =>
  buildGraph({
    nodes: sampleBoard(),
    config,
    members,
    isCollapsed: (id) => collapsed.includes(id),
  });

describe('buildGraph', () => {
  it('nests a member under its nearest member ancestor', () => {
    const graph = graphOf();
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));

    expect(byId.get('S1')?.parentId).toBe('F1');
    // F1's own parents (E, P) are not in the view, so it sits at the top.
    expect(byId.get('F1')?.parentId).toBeUndefined();
    expect(byId.get('F1')?.type).toBe('group');
    expect(byId.get('S1')?.type).toBe('issue');
  });

  it('draws an edge per dependency between visible nodes', () => {
    const graph = graphOf();
    expect(graph.edges.map((edge) => edge.id).sort()).toEqual([
      'S1->S2',
      'S2->S3',
      'S3->S4',
    ]);
  });

  it('colours an edge by the downstream status and animates live work', () => {
    const edge = graphOf().edges.find((entry) => entry.id === 'S1->S2')!;
    expect(edge.tone).toBe('active');
    expect(edge.animated).toBe(true);
    expect(graphOf().edges.find((entry) => entry.id === 'S3->S4')!.animated).toBe(false);
  });

  it('hides the children of a collapsed subflow', () => {
    const graph = graphOf(['F1']);
    expect(graph.nodes.map((node) => node.id).sort()).toEqual(['F1', 'F2', 'S3', 'S4']);
    const f1 = graph.nodes.find((node) => node.id === 'F1')!;
    expect(f1.type).toBe('issue');
    expect(f1.data.collapsed).toBe(true);
    // Still offers a chevron, otherwise it could never be expanded again.
    expect(f1.data.collapsible).toBe(true);
  });

  it('reroutes the edges of hidden nodes onto the collapsed ancestor', () => {
    const graph = graphOf(['F1']);
    expect(graph.edges.map((edge) => edge.id).sort()).toEqual(['F1->S3', 'S3->S4']);
    const rerouted = graph.edges.find((edge) => edge.id === 'F1->S3')!;
    expect(rerouted.aggregated).toBe(true);
    // The real dependency is remembered, so the edge menu can still act on it.
    expect([rerouted.from, rerouted.to]).toEqual(['S2', 'S3']);
  });

  it('drops an edge whose two ends collapse into the same node', () => {
    // S1 -> S2 lives entirely inside F1.
    expect(graphOf(['F1']).edges.some((edge) => edge.source === edge.target)).toBe(false);
    expect(graphOf(['F1']).edges).toHaveLength(2);
  });

  it('counts children that exist on the board but are not in the view', () => {
    const graph = buildGraph({
      nodes: sampleBoard(),
      config,
      members: ['F1'],
      isCollapsed: () => false,
    });
    expect(graph.nodes[0]!.data.hiddenChildren).toBe(2);
    expect(graph.nodes[0]!.data.collapsible).toBe(false);
  });

  describe('flags', () => {
    const flagged = (collapsed: string[] = []) => {
      const nodes = sampleBoard();
      const story = nodes.S2;
      if (story?.kind === 'issue') story.flag = 'blocked';
      return buildGraph({ nodes, config, members, isCollapsed: (id) => collapsed.includes(id) });
    };

    it('carries the flag onto the node that has it', () => {
      const byId = new Map(flagged().nodes.map((node) => [node.id, node.data]));
      expect(byId.get('S2')!.flag).toBe('blocked');
      expect(byId.get('S1')!.flag).toBeNull();
      // The feature is not itself stuck, but it is standing in front of nothing
      // while its child is drawn beside it.
      expect(byId.get('F1')!.flaggedInside).toBe(0);
    });

    // The engine also rolls a flag up the documents themselves, so a container
    // folded away inside another carries `DERIVED_FLAG` for the same stopped
    // story the count is already reporting. Counting both would report one
    // stall as two.
    it('never counts a container carrying the rolled-up flag', () => {
      const nodes = sampleBoard();
      const story = nodes.S2;
      const feature = nodes.F1;
      if (story?.kind === 'issue') story.flag = 'blocked';
      if (feature?.kind === 'issue') feature.flag = DERIVED_FLAG;
      // The epic stands in for the feature *and* the story inside it.
      const graph = buildGraph({
        nodes,
        config,
        members: ['E', ...members],
        isCollapsed: (id) => id === 'E',
      });

      const byId = new Map(graph.nodes.map((node) => [node.id, node.data]));
      expect(byId.get('E')!.flaggedInside).toBe(1);
    });

    // A dependency written at feature level now shows red too: the container is
    // marked because work inside it stopped, and `stalled` reads the blocker it
    // was actually written against.
    it('stalls an edge whose blocker is a container the roll-up marked', () => {
      const nodes = sampleBoard();
      const feature = nodes.F1;
      const story = nodes.S3;
      if (feature?.kind === 'issue') feature.flag = DERIVED_FLAG;
      if (story?.kind === 'issue') story.dependsOn = ['F1'];
      const graph = buildGraph({ nodes, config, members, isCollapsed: () => false });

      expect(graph.edges.find((edge) => edge.id === 'F1->S3')!.stalled).toBe(true);
    });

    it('rolls a hidden flag up to whatever stands in for it', () => {
      // Folding a feature may hide detail; it may never hide the fact that work
      // inside it has stopped.
      const byId = new Map(flagged(['F1']).nodes.map((node) => [node.id, node.data]));
      expect(byId.get('F1')!.flag).toBeNull();
      expect(byId.get('F1')!.flaggedInside).toBe(1);
      expect(byId.get('S3')!.flaggedInside).toBe(0);
    });

    // Every edge leaving a flagged issue is drawn red without anybody clicking,
    // so the reach of one stalled ticket is legible from across the canvas.
    const stalled = (graph: { edges: { id: string; stalled: boolean }[] }): string[] =>
      graph.edges.filter((edge) => edge.stalled).map((edge) => edge.id).sort();

    it('marks the edges leaving a flagged blocker as stalled', () => {
      // S2 is flagged, and S3 waits on it.
      expect(stalled(flagged())).toEqual(['S2->S3']);
    });

    it('leaves the edge arriving *at* the flagged issue alone', () => {
      // S1 -> S2 is the work S2 waited for; it finished. Nothing behind that
      // line has stopped, and painting it red would double the red on screen
      // while halving what it means.
      expect(flagged().edges.find((edge) => edge.id === 'S1->S2')!.stalled).toBe(false);
    });

    it('marks nothing when nothing is flagged', () => {
      expect(stalled(graphOf())).toEqual([]);
    });

    it('follows the dependency, not the drawn node, through a collapse', () => {
      // S2 is inside the folded F1, so its edge to S3 is drawn from F1. The
      // flag is hidden; the fact that S3 is stuck behind it must not be.
      expect(stalled(flagged(['F1']))).toEqual(['F1->S3']);
    });

    it('stalls an aggregated edge when any dependency behind it is flagged', () => {
      const nodes = sampleBoard();
      const s1 = nodes.S1;
      const s3 = nodes.S3;
      if (s1?.kind === 'issue') s1.flag = 'help';
      // S3 now waits on both stories inside F1, which fold into one edge.
      if (s3?.kind === 'issue') s3.dependsOn = ['S1', 'S2'];
      const graph = buildGraph({ nodes, config, members, isCollapsed: (id) => id === 'F1' });

      const edge = graph.edges.find((entry) => entry.id === 'F1->S3')!;
      expect(edge.aggregated).toBe(true);
      expect(edge.stalled).toBe(true);
    });

    it('does not stall an aggregated edge when none of its dependencies is', () => {
      const nodes = sampleBoard();
      const s3 = nodes.S3;
      if (s3?.kind === 'issue') s3.dependsOn = ['S1', 'S2'];
      const graph = buildGraph({ nodes, config, members, isCollapsed: (id) => id === 'F1' });

      expect(graph.edges.find((entry) => entry.id === 'F1->S3')!.stalled).toBe(false);
    });
  });

  it('maps every member to the node standing in for it', () => {
    const tree = visibleTree({
      nodes: sampleBoard(),
      config,
      members,
      isCollapsed: (id) => id === 'F1',
    });
    expect(tree.representative.get('S1')).toBe('F1');
    expect(tree.representative.get('S3')).toBe('S3');
  });

  describe('sync badges', () => {
    it('carries a sync badge onto the node that has one, and nothing elsewhere', () => {
      const graph = buildGraph({
        nodes: sampleBoard(),
        config,
        members,
        isCollapsed: () => false,
        syncBadges: { S2: 'ahead', S4: 'conflicted' },
      });
      const byId = new Map(graph.nodes.map((node) => [node.id, node.data]));
      expect(byId.get('S2')!.sync).toBe('ahead');
      expect(byId.get('S4')!.sync).toBe('conflicted');
      // In sync, or no remote read — no mark.
      expect(byId.get('S1')!.sync).toBeUndefined();
    });

    it('never badges a non-issue node', () => {
      const nodes = sampleBoard();
      nodes['T1'] = {
        kind: 'period',
        id: 'T1',
        type: 'sprint',
        title: 'T1',
        body: '',
        squad: null,
        parentId: null,
        depth: 1,
        attributes: {},
        starts: '2026-08-01',
        ends: '2026-08-29',
      };
      const graph = buildGraph({
        nodes,
        config,
        members: ['T1', ...members],
        isCollapsed: () => false,
        syncBadges: { T1: 'unlinked' },
      });
      const period = graph.nodes.find((node) => node.id === 'T1')!;
      expect(period.data.sync).toBeUndefined();
    });
  });
});

describe('layoutGraph', () => {
  it('flows left to right along the dependencies', () => {
    const graph = graphOf();
    const { positions } = layoutGraph(graph.nodes, graph.edges);
    // Within F1, S2 depends on S1, so it must sit to its right.
    expect(positions.get('S2')!.x).toBeGreaterThan(positions.get('S1')!.x);
    // F1 comes before F2 because its contents block F2's contents.
    expect(positions.get('F2')!.x).toBeGreaterThan(positions.get('F1')!.x);
  });

  it('sizes a subflow to hold its children', () => {
    const graph = graphOf();
    const { sizes, positions } = layoutGraph(graph.nodes, graph.edges);
    const f1 = sizes.get('F1')!;
    const s2 = positions.get('S2')!;
    expect(f1.width).toBeGreaterThan(s2.x);
    expect(f1.height).toBeGreaterThan(s2.y);
    // Children start below the group header, never on top of its title.
    expect(positions.get('S1')!.y).toBeGreaterThanOrEqual(GROUP_HEADER);
  });

  it('gives a collapsed group no children to lay out', () => {
    const graph = graphOf(['F1', 'F2']);
    const { sizes } = layoutGraph(graph.nodes, graph.edges);
    expect(sizes.has('F1')).toBe(false);
  });

  it('leaves room for a node someone widened', () => {
    const graph = graphOf();
    const widened = graph.nodes.map((node) =>
      node.id === 'S1' ? { ...node, width: node.width * 2 } : node,
    );
    const before = layoutGraph(graph.nodes, graph.edges).positions.get('S2')!.x;
    const after = layoutGraph(widened, graph.edges).positions.get('S2')!.x;
    expect(after).toBeGreaterThan(before);
  });
});

describe('fitGroups', () => {
  const laid = (): ReturnType<typeof fitGroups> => {
    const graph = graphOf();
    return applyLayout(graph.nodes, layoutGraph(graph.nodes, graph.edges));
  };

  it('stretches a subflow in both directions to hold a child that moved', () => {
    const nodes = laid().map((node) =>
      node.id === 'S2' ? { ...node, position: { x: 900, y: 400 } } : node,
    );
    const f1 = fitGroups(nodes).find((node) => node.id === 'F1')!;
    const s2 = nodes.find((node) => node.id === 'S2')!;
    expect(f1.width).toBe(900 + s2.width + GROUP_PADDING);
    expect(f1.height).toBe(400 + s2.height + GROUP_PADDING);
  });

  it('treats a hand-dragged size as a floor, never as a ceiling', () => {
    const nodes = laid();
    const roomy = fitGroups(
      nodes.map((node) => (node.id === 'F1' ? { ...node, width: 4000, height: 3000 } : node)),
    ).find((node) => node.id === 'F1')!;
    expect([roomy.width, roomy.height]).toEqual([4000, 3000]);

    // Too small to hold the stories inside it: the contents win.
    const squeezed = fitGroups(
      nodes.map((node) => (node.id === 'F1' ? { ...node, width: 10, height: 10 } : node)),
    ).find((node) => node.id === 'F1')!;
    expect(squeezed.width).toBe(roomy.minWidth);
    expect(squeezed.height).toBe(roomy.minHeight);
  });

  it('reports how small each node may be dragged', () => {
    const fitted = fitGroups(laid());
    const leaf = fitted.find((node) => node.id === 'S1')!;
    const group = fitted.find((node) => node.id === 'F1')!;
    expect(leaf.minWidth).toBe(MIN_LEAF_WIDTH);
    expect(group.minWidth).toBeGreaterThan(leaf.width);
  });
});

describe('placeNewNodes', () => {
  it('flows the whole graph left to right when nothing has a place yet', () => {
    const graph = graphOf();
    const placed = placeNewNodes(graph.nodes, graph.edges, () => false);
    const at = (id: string) => placed.find((node) => node.id === id)!.position;
    expect(at('S2').x).toBeGreaterThan(at('S1').x);
    expect(at('F2').x).toBeGreaterThan(at('F1').x);
  });

  it('sets a new issue down past the ones already placed, and moves nothing', () => {
    const graph = graphOf();
    const settled = new Set(['F1', 'F2', 'S1', 'S2', 'S3']);
    const nodes = graph.nodes.map((node) =>
      node.id === 'S3' ? { ...node, position: { x: 500, y: GROUP_HEADER } } : node,
    );

    const placed = placeNewNodes(nodes, graph.edges, (id) => settled.has(id));
    const s3 = placed.find((node) => node.id === 'S3')!;
    const s4 = placed.find((node) => node.id === 'S4')!;

    // S3 was already placed, so it is exactly where it was.
    expect(s3.position).toEqual({ x: 500, y: GROUP_HEADER });
    // S4 is new, and lands clear of it inside the same feature.
    expect(s4.parentId).toBe('F2');
    expect(s4.position.x).toBeGreaterThan(s3.position.x + s3.width);
  });
});
