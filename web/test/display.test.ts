import { describe, expect, it } from 'vitest';
import type { TypeDisplay } from '$shared';
import { buildGraph, visibleTree } from '$features/canvas/model.js';
import { board, config, issue } from './fixtures.js';

/**
 * program > epic > two features, each with two stories, chained
 * S1 -> S2 -> S3 -> S4. The whole thing is on the canvas.
 */
const nodes = () =>
  board(
    issue('P', 'program', null),
    issue('E', 'epic', 'P'),
    issue('F1', 'feature', 'E'),
    issue('F2', 'feature', 'E'),
    issue('S1', 'user_story', 'F1'),
    issue('S2', 'user_story', 'F1', { dependsOn: ['S1'] }),
    issue('S3', 'user_story', 'F2', { dependsOn: ['S2'] }),
    issue('S4', 'user_story', 'F2', { dependsOn: ['S3'] }),
  );

const ALL = ['P', 'E', 'F1', 'F2', 'S1', 'S2', 'S3', 'S4'];

const graphOf = (display: Record<string, TypeDisplay> = {}, members = ALL) =>
  buildGraph({ nodes: nodes(), config, members, isCollapsed: () => false, display });

const treeOf = (display: Record<string, TypeDisplay>, members = ALL) =>
  visibleTree({ nodes: nodes(), config, members, isCollapsed: () => false, display });

const drawn = (display: Record<string, TypeDisplay>, members = ALL): string[] =>
  graphOf(display, members)
    .nodes.map((node) => node.id)
    .sort();

const parentOf = (display: Record<string, TypeDisplay>, id: string): string | undefined =>
  graphOf(display).nodes.find((node) => node.id === id)?.parentId;

const lineageOf = (display: Record<string, TypeDisplay>, id: string): string[] =>
  (graphOf(display).nodes.find((node) => node.id === id)?.data.lineage ?? []).map(
    (entry) => entry.id,
  );

describe('drawing a level as badges', () => {
  it('takes those issues off the canvas', () => {
    expect(drawn({ feature: 'badge' })).toEqual(['E', 'P', 'S1', 'S2', 'S3', 'S4']);
  });

  it('hoists their children to whatever is drawn above', () => {
    expect(parentOf({}, 'S1')).toBe('F1');
    expect(parentOf({ feature: 'badge' }, 'S1')).toBe('E');
    // Two levels badged: the stories climb all the way to the programme.
    expect(parentOf({ feature: 'badge', epic: 'badge' }, 'S1')).toBe('P');
  });

  it('writes the badged parents onto the children, outermost first', () => {
    expect(lineageOf({ feature: 'badge' }, 'S1')).toEqual(['F1']);
    expect(lineageOf({ feature: 'badge', epic: 'badge' }, 'S1')).toEqual(['E', 'F1']);
    // A node whose parent is drawn as a node carries no badge.
    expect(lineageOf({ feature: 'badge' }, 'E')).toEqual([]);
  });

  it('labels a child whose parent was never imported', () => {
    // F1 is not a member, so it was never a node here — the badge is a label,
    // not a member of the view.
    expect(lineageOf({ feature: 'badge' }, 'S1')).toEqual(['F1']);
    expect(drawn({ feature: 'badge' }, ['E', 'S1', 'S2'])).toEqual(['E', 'S1', 'S2']);
  });

  it('leaves the graph itself alone', () => {
    expect(graphOf({ feature: 'badge' }).edges.map((edge) => edge.id).sort()).toEqual([
      'S1->S2',
      'S2->S3',
      'S3->S4',
    ]);
  });

  it('keeps a badged issue that has nothing to carry its badge', () => {
    // F2's stories are off the view, so badging features would erase it.
    const members = ['E', 'F1', 'F2', 'S1', 'S2'];
    expect(drawn({ feature: 'badge' }, members)).toEqual(['E', 'F2', 'S1', 'S2']);
  });

  it('rolls a badged issue’s own dependencies up to what is drawn', () => {
    const withEdges = board(
      issue('E', 'epic', null),
      issue('E2', 'epic', null),
      issue('F1', 'feature', 'E'),
      issue('F2', 'feature', 'E2', { dependsOn: ['F1'] }),
      issue('S1', 'user_story', 'F1'),
      issue('S2', 'user_story', 'F2'),
    );
    const graph = buildGraph({
      nodes: withEdges,
      config,
      members: ['E', 'E2', 'F1', 'F2', 'S1', 'S2'],
      isCollapsed: () => false,
      display: { feature: 'badge' },
    });
    // The features are gone, so the dependency between them shows between the
    // epics that hold them.
    expect(graph.edges.map((edge) => edge.id)).toEqual(['E->E2']);
  });

  it('does not count a badged child as one hidden from the view', () => {
    const data = (id: string) => graphOf({ feature: 'badge' }).nodes.find((n) => n.id === id)!.data;
    expect(data('E').hiddenChildren).toBe(0);
    // Its stories are right there, so the epic still folds.
    expect(data('E').collapsible).toBe(true);
  });

  it('still collapses a subflow with hoisted children inside it', () => {
    const tree = visibleTree({
      nodes: nodes(),
      config,
      members: ALL,
      isCollapsed: (id) => id === 'E',
      display: { feature: 'badge' },
    });
    expect([...tree.visible].sort()).toEqual(['E', 'P']);
    // Everything under the collapsed epic is represented by it.
    expect(tree.representative.get('S1')).toBe('E');
  });

  it('is the same picture as before when nothing is badged', () => {
    const tree = treeOf({});
    expect([...tree.visible].sort()).toEqual(ALL.slice().sort());
    expect(tree.lineageOf.size).toBe(0);
  });
});
