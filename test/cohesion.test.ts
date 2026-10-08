import { describe, expect, it } from 'vitest';
import type { CohesionLookup, ContainerProgress } from '../src/shared/cohesion.js';
import { compareProgress, containerProgress, progressComparator } from '../src/shared/cohesion.js';

/**
 * The pure rule behind "stay inside the feature that is already moving".
 *
 * The engine's own ordering is exercised against a real board in
 * `test/tasks.test.ts`; this file drives the rule itself, where a board can be
 * stated in one line and the awkward shapes (a lopsided tree, a container of
 * containers, a parent loop somebody merged in) are cheap to write down.
 */

type Status = 'todo' | 'doing' | 'done';

interface Node {
  id: string;
  parentId: string | null;
  status: Status;
}

/**
 * A board as a list of `id<parent:status` entries, where a node with children
 * is a container and a leaf is a work unit — the default rule, before any type
 * is declared atomic.
 */
function boardOf(spec: string[]): CohesionLookup {
  const nodes: Node[] = spec.map((entry) => {
    const [id = '', rest = ''] = entry.split('<');
    const [parentId = '', status = 'todo'] = rest.split(':');
    return { id, parentId: parentId || null, status: status as Status };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const list = children.get(node.parentId);
    if (list) list.push(node.id);
    else children.set(node.parentId, [node.id]);
  }
  return {
    parentOf: (id) => byId.get(id)?.parentId ?? null,
    childIdsOf: (id) => children.get(id) ?? [],
    isWorkUnit: (id) => (children.get(id) ?? []).length === 0,
    isTerminal: (id) => byId.get(id)?.status === 'done',
    isActive: (id) => byId.get(id)?.status === 'doing',
  };
}

const progress = (total: number, done: number, active = 0): ContainerProgress => ({
  total,
  done,
  active,
});

describe('how far the work inside a container has got', () => {
  it('counts the work units at any depth and none of the containers', () => {
    const board = boardOf([
      'E',
      'F1<E',
      'S1<F1:done',
      'S2<F1:doing',
      'F2<E',
      'S3<F2',
      'Loose<E:done',
    ]);

    // Four units under the epic — the two features are the names of the work,
    // not work of their own, and counting them would count it all twice.
    expect(containerProgress('E', board)).toEqual(progress(4, 2, 1));
    expect(containerProgress('F1', board)).toEqual(progress(2, 1, 1));
    expect(containerProgress('F2', board)).toEqual(progress(1, 0));
  });

  it('reports nothing for a work unit, which has no work inside it', () => {
    expect(containerProgress('S1', boardOf(['F', 'S1<F', 'S2<F']))).toEqual(progress(0, 0));
  });

  it('stops at a unit rather than counting what is inside it', () => {
    // A board that declares its stories atomic: the sub-tasks are the story's
    // checklist, so the feature holds one piece of work and not three.
    const board: CohesionLookup = {
      ...boardOf(['F', 'S<F', 'T1<S:done', 'T2<S:done']),
      isWorkUnit: (id) => id === 'S',
    };
    expect(containerProgress('F', board)).toEqual(progress(1, 0));
  });

  it('terminates on a parent loop instead of hanging the caller', () => {
    const board = boardOf(['A<B', 'B<A']);
    expect(() => containerProgress('A', board)).not.toThrow();
    expect(containerProgress('A', board)).toEqual(progress(0, 0));
  });
});

describe('which container a queue should stay inside', () => {
  const first = (a: ContainerProgress, b: ContainerProgress): 'a' | 'b' | 'tie' => {
    const order = compareProgress(a, b);
    // A comparator a sort can rely on: reversing the arguments reverses it.
    expect(Math.sign(compareProgress(b, a)) + Math.sign(order)).toBe(0);
    return order === 0 ? 'tie' : order < 0 ? 'a' : 'b';
  };

  it('prefers a container somebody has already finished work in', () => {
    expect(first(progress(3, 1), progress(3, 0))).toBe('a');
  });

  it('prefers work in flight over work merely further along', () => {
    // Somebody is inside the second container right now; opening a third front
    // is the thing this rule exists to stop.
    expect(first(progress(4, 3), progress(4, 0, 1))).toBe('b');
  });

  it('measures completion as a share, so a big container has no advantage', () => {
    // Ten units with three finished is a container barely begun; two with one
    // finished is a container half built.
    expect(first(progress(10, 3), progress(2, 1))).toBe('b');
  });

  it('treats an untouched container and an empty one alike', () => {
    expect(first(progress(5, 0), progress(0, 0))).toBe('tie');
  });

  it('ties when two containers are equally far along', () => {
    expect(first(progress(2, 1), progress(4, 2))).toBe('tie');
  });
});

describe('ordering two issues by the plan around them', () => {
  const order = (lookup: CohesionLookup) => {
    const compare = progressComparator(lookup);
    return (a: string, b: string): 'a' | 'b' | 'tie' => {
      const result = compare(a, b);
      // A comparator a sort can rely on: reversing the arguments reverses it.
      expect(Math.sign(compare(b, a)) + Math.sign(result)).toBe(0);
      return result === 0 ? 'tie' : result < 0 ? 'a' : 'b';
    };
  };

  it('offers the story in the feature that is already under way', () => {
    const compare = order(boardOf(['F1', 'S1<F1:done', 'S2<F1', 'F2', 'S3<F2', 'S4<F2']));
    expect(compare('S2', 'S3')).toBe('a');
  });

  it('leaves two stories in the same feature to the caller to separate', () => {
    const compare = order(boardOf(['F1', 'S1<F1:done', 'S2<F1', 'S3<F1']));
    expect(compare('S2', 'S3')).toBe('tie');
  });

  it('decides at the outermost level the two do not share', () => {
    // E1 is the epic under way. Its untouched feature still comes before the
    // half-finished feature of an epic nobody has started: the epics are the
    // level at which the two stories are alternatives at all, so the feature
    // level — which would have answered the other way — is never reached.
    const compare = order(
      boardOf([
        'E1',
        'F1<E1',
        'S1<F1:doing',
        'S5<F1',
        'F2<E1',
        'S2<F2',
        'E2',
        'F3<E2',
        'S3<F3:done',
        'S4<F3',
      ]),
    );
    expect(compare('S2', 'S4')).toBe('a');
    // Inside E1 the feature level does decide, and F1 is the one moving.
    expect(compare('S5', 'S2')).toBe('a');
  });

  it('separates two stories by their own feature when the epic is shared', () => {
    const compare = order(
      boardOf(['E', 'F1<E', 'S1<F1:doing', 'S2<F1', 'F2<E', 'S3<F2', 'S4<F2']),
    );
    expect(compare('S2', 'S3')).toBe('a');
  });

  it('weighs a story in a moving feature against a loose task beside it', () => {
    // The task is nobody's container: it has no work inside it, so the feature
    // that is under way is preferred, and an untouched feature would not be.
    const compare = order(boardOf(['E', 'F<E', 'S1<F:done', 'S2<F', 'Task<E']));
    expect(compare('S2', 'Task')).toBe('a');

    const cold = order(boardOf(['E', 'F<E', 'S1<F', 'S2<F', 'Task<E']));
    expect(cold('S2', 'Task')).toBe('tie');
  });

  it('says nothing about an issue and its own ancestor', () => {
    const compare = order(boardOf(['F', 'S1<F:done', 'S2<F']));
    expect(compare('F', 'S2')).toBe('tie');
    expect(compare('S2', 'S2')).toBe('tie');
  });

  it('reads the board as it stands each time it is built', () => {
    const started = boardOf(['F1', 'S1<F1:done', 'S2<F1', 'F2', 'S3<F2']);
    expect(order(started)('S2', 'S3')).toBe('a');

    // The same two features with the finished story reopened: nothing is under
    // way any more, so the rule has nothing to say.
    const cold = boardOf(['F1', 'S1<F1', 'S2<F1', 'F2', 'S3<F2']);
    expect(order(cold)('S2', 'S3')).toBe('tie');
  });

  it('terminates on a parent loop instead of hanging the caller', () => {
    const board = boardOf(['A<B', 'B<A', 'C']);
    expect(order(board)('A', 'C')).toBe('tie');
  });
});
