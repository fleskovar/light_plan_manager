import { afterAll, describe, expect, it } from 'vitest';
import type { BoardPaths, LoadedBoard } from '../src/core/index.js';
import {
  blockersOf,
  createIssue,
  dependencyRollups,
  findIssue,
  linkIssue,
  rolledUpDependenciesOf,
  rolledUpDependentsOf,
  rollupsForEdges,
} from '../src/core/index.js';
import type { DependencyEdge, HierarchyLookup } from '../src/shared/index.js';
import { rollUpDependencies, rollUpDependency } from '../src/shared/index.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterAll(cleanupBoards);

/** A hierarchy as a child -> parent map, which is all the rule reads. */
function tree(parents: Record<string, string | null>): HierarchyLookup {
  return { parentOf: (id) => parents[id] ?? null };
}

/** `A->B` for each reflected pair, in the order they were reported. */
const pairs = (rolled: { from: string; to: string }[]): string[] =>
  rolled.map((entry) => `${entry.from}->${entry.to}`);

describe('rollUpDependency', () => {
  // program P
  //   epic E1              epic E2
  //     feature F1           feature F2
  //       story A1, A2         story B1, B2
  const board = tree({
    E1: 'P',
    E2: 'P',
    F1: 'E1',
    F2: 'E2',
    A1: 'F1',
    A2: 'F1',
    B1: 'F2',
    B2: 'F2',
  });

  it('reflects a story dependency onto every container above it, nearest first', () => {
    expect(pairs(rollUpDependency({ from: 'A1', to: 'B1' }, board))).toEqual([
      'F1->F2',
      'E1->E2',
    ]);
  });

  it('stops at the common parent', () => {
    // Two stories in one feature order nothing: the feature would wait on
    // itself, which is not a fact anybody can act on.
    const sameFeature = tree({ F1: 'E1', A1: 'F1', A2: 'F1' });
    expect(rollUpDependency({ from: 'A1', to: 'A2' }, sameFeature)).toEqual([]);
  });

  it('numbers the levels from the common parent downward', () => {
    const rolled = rollUpDependency({ from: 'A1', to: 'B1' }, board);
    expect(rolled.map((entry) => entry.level)).toEqual([1, 0]);
  });

  it('names the written dependency each pair reflects', () => {
    const rolled = rollUpDependency({ from: 'A1', to: 'B1' }, board);
    expect(rolled.every((entry) => entry.source === 'A1' && entry.target === 'B1')).toBe(true);
  });

  it('pairs the two chains from the common parent, not from the two ends', () => {
    // A1 sits two levels below the root; the feature it waits on sits one.
    // Pairing from the top keeps the epics together, and F1 reports the
    // feature it waits on rather than nothing.
    const uneven = tree({ E1: null, E2: null, F1: 'E1', F2: 'E2', A1: 'F1' });
    expect(pairs(rollUpDependency({ from: 'A1', to: 'F2' }, uneven))).toEqual([
      'F1->F2',
      'E1->E2',
    ]);
  });

  it('reflects across separate roots, which share no parent at all', () => {
    const roots = tree({ E1: null, E2: null, A1: 'E1', B1: 'E2' });
    expect(pairs(rollUpDependency({ from: 'A1', to: 'B1' }, roots))).toEqual(['E1->E2']);
  });

  it('reflects nothing when one end contains the other', () => {
    // Both directions: an issue cannot be made to wait on the container it is
    // part of, and a container cannot be made to wait on its own contents.
    expect(rollUpDependency({ from: 'A1', to: 'E1' }, board)).toEqual([]);
    expect(rollUpDependency({ from: 'E1', to: 'A1' }, board)).toEqual([]);
  });

  it('reflects nothing for an edge onto itself', () => {
    expect(rollUpDependency({ from: 'A1', to: 'A1' }, board)).toEqual([]);
  });

  it('terminates on a parent loop a hand-edited board can produce', () => {
    const looped = tree({ X: 'Y', Y: 'X' });
    expect(() => rollUpDependency({ from: 'X', to: 'Y' }, looped)).not.toThrow();
  });
});

describe('rollUpDependencies', () => {
  const board = tree({
    E1: 'P',
    E2: 'P',
    F1: 'E1',
    F2: 'E2',
    A1: 'F1',
    A2: 'F1',
    B1: 'F2',
    B2: 'F2',
  });

  it('reports each pair once however many dependencies stand behind it', () => {
    const edges: DependencyEdge[] = [
      { from: 'A1', to: 'B1' },
      { from: 'A2', to: 'B2' },
    ];
    expect(pairs(rollUpDependencies(edges, board))).toEqual(['F1->F2', 'E1->E2']);
  });

  it('leaves out a pair the containers already declare themselves', () => {
    const edges: DependencyEdge[] = [
      { from: 'A1', to: 'B1' },
      { from: 'F1', to: 'F2' },
    ];
    // F1->F2 is F1's own dependency; only the epics are reflected.
    expect(pairs(rollUpDependencies(edges, board))).toEqual(['E1->E2']);
  });

  it('reflects both directions between two containers without complaint', () => {
    // Perfectly ordinary: one story in each feature waits on one in the other.
    // Reflected edges are read and never gated, so a loop among them is a fact
    // about the plan rather than a stall the cycle check has to refuse.
    const edges: DependencyEdge[] = [
      { from: 'A1', to: 'B1' },
      { from: 'B2', to: 'A2' },
    ];
    expect(pairs(rollUpDependencies(edges, board))).toEqual([
      'F1->F2',
      'E1->E2',
      'F2->F1',
      'E2->E1',
    ]);
  });
});

/**
 * program LP-1
 *   epic LP-2                epic LP-5
 *     feature LP-3             feature LP-6
 *       story LP-4               story LP-7
 *       story LP-8
 */
function seed(): BoardPaths {
  const paths = makeBoard('scrum', 'LP');
  createIssue(reload(paths), { type: 'program', title: 'Payments platform' });
  createIssue(reload(paths), { type: 'epic', title: 'Checkout', parentId: 'LP-1' });
  createIssue(reload(paths), { type: 'feature', title: 'Guest flow', parentId: 'LP-2' });
  createIssue(reload(paths), { type: 'user_story', title: 'Guest checkout', parentId: 'LP-3' });
  createIssue(reload(paths), { type: 'epic', title: 'Accounts', parentId: 'LP-1' });
  createIssue(reload(paths), { type: 'feature', title: 'Sign-up', parentId: 'LP-5' });
  createIssue(reload(paths), { type: 'user_story', title: 'Email sign-up', parentId: 'LP-6' });
  createIssue(reload(paths), { type: 'user_story', title: 'Guest receipt', parentId: 'LP-3' });
  return paths;
}

function link(paths: BoardPaths, id: string, dependsOn: string): LoadedBoard {
  const board = reload(paths);
  linkIssue(board, findIssue(board, id)!, { dependsOn: [dependsOn] });
  return reload(paths);
}

describe('dependencyRollups', () => {
  it('puts the features and the epics in order behind one story dependency', () => {
    const board = link(seed(), 'LP-4', 'LP-7');
    expect(pairs(dependencyRollups(board))).toEqual(['LP-3->LP-6', 'LP-2->LP-5']);
  });

  it('resolves both documents so a caller can print their titles', () => {
    const board = link(seed(), 'LP-4', 'LP-7');
    const [nearest] = dependencyRollups(board);
    expect(nearest?.issue.title).toBe('Guest flow');
    expect(nearest?.blocker.title).toBe('Sign-up');
  });

  it('reads nothing off a board with no dependencies', () => {
    expect(dependencyRollups(reload(seed()))).toEqual([]);
  });

  it('ignores a dependency on an id the board does not have', () => {
    const paths = seed();
    const board = reload(paths);
    const issue = findIssue(board, 'LP-4')!;
    // Written onto the handle: `link` refuses an unknown id, and a dangling
    // reference is what a merge or a hand edit leaves behind.
    issue.depends_on.push('LP-999');
    expect(dependencyRollups(board)).toEqual([]);
  });

  it('answers from both ends of the reflection', () => {
    const board = link(seed(), 'LP-4', 'LP-7');
    expect(pairs(rolledUpDependenciesOf(board, 'LP-3'))).toEqual(['LP-3->LP-6']);
    expect(pairs(rolledUpDependentsOf(board, 'LP-6'))).toEqual(['LP-3->LP-6']);
    expect(rolledUpDependenciesOf(board, 'LP-6')).toEqual([]);
  });

  it('writes nothing to the containers it puts in order', () => {
    const board = link(seed(), 'LP-4', 'LP-7');
    expect(findIssue(board, 'LP-3')!.depends_on).toEqual([]);
    expect(findIssue(board, 'LP-2')!.depends_on).toEqual([]);
  });

  it('does not block the other work inside the feature', () => {
    // The whole reason the reflection is derived rather than written: a stored
    // dependency on LP-3 would be inherited by every story in it.
    const board = link(seed(), 'LP-4', 'LP-7');
    expect(blockersOf(board, findIssue(board, 'LP-4')!).map((one) => one.id)).toEqual(['LP-7']);
    expect(blockersOf(board, findIssue(board, 'LP-8')!)).toEqual([]);
  });
});

describe('rollupsForEdges', () => {
  it('says what one new dependency would put in order', () => {
    const board = reload(seed());
    expect(pairs(rollupsForEdges(board, [{ from: 'LP-4', to: 'LP-7' }]))).toEqual([
      'LP-3->LP-6',
      'LP-2->LP-5',
    ]);
  });

  it('leaves out a pair the board already declares', () => {
    const paths = seed();
    link(paths, 'LP-3', 'LP-6');
    const board = reload(paths);
    expect(pairs(rollupsForEdges(board, [{ from: 'LP-4', to: 'LP-7' }]))).toEqual(['LP-2->LP-5']);
  });

  it('says nothing for a dependency inside one container', () => {
    const board = reload(seed());
    expect(rollupsForEdges(board, [{ from: 'LP-4', to: 'LP-8' }])).toEqual([]);
  });
});
