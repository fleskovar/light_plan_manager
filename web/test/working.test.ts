import { describe, expect, it } from 'vitest';
import type { Change } from '$shared';
import { appendChange, compactChanges, wouldCycle } from '$shared';
import { applyChange, replay } from '$lib/board/working.js';
import { criticalPath } from '$lib/board/critical-path.js';
import { statusTone } from '$lib/board/selectors.js';
import { config, sampleBoard } from './fixtures.js';

const nodesOf = () => Object.values(sampleBoard());

describe('applyChange', () => {
  it('creates a node with the type defaults filled in', () => {
    const nodes = sampleBoard();
    applyChange(
      nodes,
      { kind: 'create', id: 'new:1', nodeKind: 'issue', patch: { type: 'user_story', title: 'Fresh', parentId: 'F1' } },
      config,
    );
    expect(nodes['new:1']).toMatchObject({
      kind: 'issue',
      title: 'Fresh',
      status: 'backlog',
      parentId: 'F1',
      depth: 3,
      attributes: { story_points: null, priority: 'medium' },
    });
  });

  it('drops attributes the new type does not declare when retyping', () => {
    const nodes = sampleBoard();
    applyChange(
      nodes,
      { kind: 'update', id: 'S1', nodeKind: 'issue', patch: { type: 'bug' } },
      config,
    );
    expect(nodes.S1!.type).toBe('bug');
    // story_points is on both types, so its value survives; priority is not.
    expect(nodes.S1!.attributes).toEqual({ story_points: 3, severity: 'major' });
  });

  it('deletes descendants and detaches every reference', () => {
    const nodes = sampleBoard();
    applyChange(nodes, { kind: 'delete', id: 'F1', nodeKind: 'issue' }, config);
    expect(Object.keys(nodes).sort()).toEqual(['E', 'F2', 'P', 'S3', 'S4']);
    // S3 depended on S2, which went with F1.
    expect((nodes.S3 as { dependsOn: string[] }).dependsOn).toEqual([]);
  });

  it('unassigns issues when their resource is deleted', () => {
    const nodes = sampleBoard();
    (nodes.S1 as { assignee: string | null }).assignee = 'RS-1';
    applyChange(nodes, { kind: 'delete', id: 'RS-1', nodeKind: 'resource' }, config);
    expect((nodes.S1 as { assignee: string | null }).assignee).toBeNull();
  });

  it('follows the parent when a node is reparented', () => {
    const nodes = sampleBoard();
    applyChange(
      nodes,
      { kind: 'update', id: 'S1', nodeKind: 'issue', patch: { parentId: 'F2' } },
      config,
    );
    expect(nodes.S1!.parentId).toBe('F2');
    expect(nodes.S1!.depth).toBe(3);
  });
});

describe('replay', () => {
  it('rebuilds the working copy a saved view was left in', () => {
    const changes: Change[] = [
      { kind: 'create', id: 'new:1', nodeKind: 'issue', patch: { type: 'user_story', title: 'Queued', parentId: 'F2' } },
      { kind: 'update', id: 'S4', nodeKind: 'issue', patch: { status: 'done' } },
      { kind: 'delete', id: 'S3', nodeKind: 'issue' },
    ];
    const nodes = replay(nodesOf(), changes, config);
    expect(nodes['new:1']!.title).toBe('Queued');
    expect((nodes.S4 as { status: string }).status).toBe('done');
    expect(nodes.S3).toBeUndefined();
    expect((nodes.S4 as { dependsOn: string[] }).dependsOn).toEqual([]);
  });

  it('does not touch the snapshot it was built from', () => {
    const snapshot = nodesOf();
    replay(snapshot, [{ kind: 'update', id: 'S1', nodeKind: 'issue', patch: { title: 'Changed' } }], config);
    expect(snapshot.find((node) => node.id === 'S1')!.title).toBe('S1');
  });
});

describe('change compaction', () => {
  const update = (id: string, patch: Record<string, unknown>): Change => ({
    kind: 'update',
    id,
    nodeKind: 'issue',
    patch,
  });

  it('merges repeated edits to the same document', () => {
    const pending = [update('S1', { title: 'a' }), update('S1', { title: 'b' }), update('S2', { title: 'c' })].reduce(
      appendChange,
      [] as Change[],
    );
    expect(pending).toHaveLength(2);
    expect(pending[0]).toMatchObject({ id: 'S1', patch: { title: 'b' } });
  });

  it('merges attributes rather than replacing them', () => {
    const pending = [
      update('S1', { attributes: { story_points: 3 } }),
      update('S1', { attributes: { priority: 'high' } }),
    ].reduce(appendChange, [] as Change[]);
    const merged = pending[0]!;
    expect(merged.kind).toBe('update');
    expect(merged.kind !== 'delete' && merged.patch.attributes).toEqual({
      story_points: 3,
      priority: 'high',
    });
  });

  it('folds edits into the create they belong to', () => {
    const pending = compactChanges([
      { kind: 'create', id: 'new:1', nodeKind: 'issue', patch: { type: 'user_story', title: 'a' } },
      update('new:1', { title: 'b', status: 'done' }),
    ]);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      kind: 'create',
      patch: { type: 'user_story', title: 'b', status: 'done' },
    });
  });

  it('cancels a create that is deleted before it is pushed', () => {
    expect(
      compactChanges([
        { kind: 'create', id: 'new:1', nodeKind: 'issue', patch: { type: 'user_story' } },
        update('new:1', { title: 'b' }),
        { kind: 'delete', id: 'new:1', nodeKind: 'issue' },
      ]),
    ).toEqual([]);
  });

  it('drops edits to something that is being deleted', () => {
    const pending = compactChanges([
      update('S1', { title: 'b' }),
      { kind: 'delete', id: 'S1', nodeKind: 'issue' },
    ]);
    expect(pending).toEqual([{ kind: 'delete', id: 'S1', nodeKind: 'issue' }]);
  });
});

describe('wouldCycle', () => {
  it('spots a loop before the edge is queued', () => {
    // S4 -> S3 -> S2 -> S1 already; making S1 depend on S4 closes it.
    expect(wouldCycle({ config, nodes: sampleBoard() }, 'S1', 'S4')).not.toBeNull();
    expect(wouldCycle({ config, nodes: sampleBoard() }, 'S1', 'S1')).not.toBeNull();
  });

  it('allows an edge that leaves the graph acyclic', () => {
    expect(wouldCycle({ config, nodes: sampleBoard() }, 'S4', 'S1')).toBeNull();
  });
});

describe('statusTone', () => {
  it('reads the semantics the engine declares, then the name', () => {
    expect(statusTone(config, 'done')).toBe('done');
    expect(statusTone(config, 'in_progress')).toBe('active');
    expect(statusTone(config, 'blocked')).toBe('blocked');
    expect(statusTone(config, 'in_review')).toBe('review');
    expect(statusTone(config, 'backlog')).toBe('todo');
    expect(statusTone(config, 'nonsense')).toBe('todo');
  });
});

describe('criticalPath', () => {
  it('finds the longest chain weighted by effort', () => {
    const path = criticalPath(sampleBoard(), config);
    expect(path.chain).toEqual(['S1', 'S2', 'S3', 'S4']);
    expect(path.weight).toBe(18);
  });

  it('counts one per issue when the board measures no effort', () => {
    const path = criticalPath(sampleBoard(), { ...config, effortAttribute: '' });
    expect(path.weight).toBe(4);
  });

  it('stops rather than hanging on a cycle that reached disk', () => {
    const nodes = sampleBoard();
    (nodes.S1 as { dependsOn: string[] }).dependsOn = ['S4'];
    expect(() => criticalPath(nodes, config)).not.toThrow();
  });
});
