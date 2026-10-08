import { describe, expect, it } from 'vitest';
import { applyChange, replay } from '$lib/board/working.js';
import { applyStatusRollup } from '$lib/board/rollup.js';
import { NodeIndexImpl } from '$lib/board/index.js';
import { board, config, issue, sampleBoard } from './fixtures.js';

/**
 * The screen has to agree with what the engine will do on push: closing the
 * last story in a feature closes the feature. @see src/shared/rollup.ts
 */

const statusOf = (nodes: ReturnType<typeof sampleBoard>, id: string): string =>
  (nodes[id] as { status: string }).status;

const finish = (id: string) =>
  ({ kind: 'update', id, nodeKind: 'issue', patch: { status: 'done' } }) as const;

describe('applyStatusRollup', () => {
  it('closes the containers when the last story is finished', () => {
    const nodes = board(
      issue('E', 'epic', null),
      issue('F', 'feature', 'E'),
      issue('S1', 'user_story', 'F', { status: 'done' }),
      issue('S2', 'user_story', 'F', { status: 'done' }),
    );
    expect(applyStatusRollup(nodes, 'S2', config)).toEqual(['F', 'E']);
    expect(statusOf(nodes, 'F')).toBe('done');
    expect(statusOf(nodes, 'E')).toBe('done');
  });

  it('leaves a container with open work alone', () => {
    const nodes = sampleBoard();
    expect(applyStatusRollup(nodes, 'S1', config)).toEqual([]);
    expect(statusOf(nodes, 'F1')).toBe('backlog');
  });

  it('agrees with itself whether or not an index is passed', () => {
    const withIndex = sampleBoard();
    const without = sampleBoard();
    (withIndex.S2 as { status: string }).status = 'done';
    (without.S2 as { status: string }).status = 'done';
    expect(applyStatusRollup(withIndex, 'S2', config, new NodeIndexImpl(withIndex))).toEqual(
      applyStatusRollup(without, 'S2', config),
    );
  });
});

describe('applyChange', () => {
  it('rolls the status up as an edit is queued', () => {
    const nodes = sampleBoard();
    applyChange(nodes, finish('S2'), config);
    expect(statusOf(nodes, 'F1')).toBe('done');
    // The other feature still has open work, so the epic stays open.
    expect(statusOf(nodes, 'E')).toBe('backlog');
  });

  it('reopens a container when work inside it is reopened', () => {
    const nodes = sampleBoard();
    applyChange(nodes, finish('S2'), config);
    applyChange(
      nodes,
      { kind: 'update', id: 'S1', nodeKind: 'issue', patch: { status: 'in_progress' } },
      config,
    );
    expect(statusOf(nodes, 'F1')).toBe('in_progress');
  });

  it('reopens a container when a new issue is created inside it', () => {
    const nodes = sampleBoard();
    applyChange(nodes, finish('S2'), config);
    applyChange(
      nodes,
      {
        kind: 'create',
        id: 'new:1',
        nodeKind: 'issue',
        patch: { type: 'user_story', title: 'One more', parentId: 'F1' },
      },
      config,
    );
    expect(statusOf(nodes, 'F1')).toBe('in_progress');
  });

  it('replays a queue to the same board the applier produced live', () => {
    const live = sampleBoard();
    applyChange(live, finish('S2'), config);
    const replayed = replay(Object.values(sampleBoard()), [finish('S2')], config);
    expect(replayed).toEqual(live);
  });
});
