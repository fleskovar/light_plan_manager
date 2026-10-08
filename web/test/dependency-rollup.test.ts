import { describe, expect, it } from 'vitest';
import { neighbours } from '$lib/board/links.js';
import { dependencyRollups, rolledUpNeighbours } from '$lib/board/selectors.js';
import type { WorkingNodes } from '$lib/board/working.js';
import { board, issue, template } from './fixtures.js';

/**
 * The containers a dependency puts in order, read off the working copy.
 *
 * The rule itself lives in `$shared/dependency-rollup.ts` and is tested against
 * a real board in `test/dependency-rollup.test.ts`. What is checked here is the
 * part that is genuinely this app's: that the browser reads the same answer off
 * the working copy, unpushed edits included, and that the panel is handed it.
 */

/**
 * program P1
 *   epic E1                epic E2
 *     feature F1             feature F2
 *       story S1, S2           story S3
 */
function makeNodes(extra: Partial<Record<string, string[]>> = {}): WorkingNodes {
  return board(
    issue('P1', 'program', null),
    issue('E1', 'epic', 'P1'),
    issue('F1', 'feature', 'E1'),
    issue('S1', 'user_story', 'F1', { dependsOn: extra.S1 ?? [] }),
    issue('S2', 'user_story', 'F1', { dependsOn: extra.S2 ?? [] }),
    issue('E2', 'epic', 'P1'),
    issue('F2', 'feature', 'E2'),
    issue('S3', 'user_story', 'F2', { dependsOn: extra.S3 ?? [] }),
  );
}

const pairs = (rolled: { from: string; to: string }[]): string[] =>
  rolled.map((entry) => `${entry.from}->${entry.to}`);

describe('dependencyRollups', () => {
  it('puts the features and the epics in order behind one story dependency', () => {
    expect(pairs(dependencyRollups(makeNodes({ S1: ['S3'] })))).toEqual(['F1->F2', 'E1->E2']);
  });

  it('reads nothing off a board with no dependencies', () => {
    expect(dependencyRollups(makeNodes())).toEqual([]);
  });

  it('orders nothing above two stories in the same feature', () => {
    expect(dependencyRollups(makeNodes({ S2: ['S1'] }))).toEqual([]);
  });

  it('ignores a dependency on an id the working copy does not have', () => {
    // A pending change can name a document the board no longer has.
    expect(dependencyRollups(makeNodes({ S1: ['GONE'] }))).toEqual([]);
  });

  it('sees an edit nobody has pushed yet', () => {
    // The whole reason this is computed in the browser rather than read off a
    // DTO: the canvas and the panel are honest before Push.
    const nodes = makeNodes();
    const edited = { ...nodes, S1: { ...nodes.S1, dependsOn: ['S3'] } } as WorkingNodes;
    expect(pairs(dependencyRollups(edited))).toEqual(['F1->F2', 'E1->E2']);
  });
});

describe('rolledUpNeighbours', () => {
  it('answers from both ends of the reflection', () => {
    const nodes = makeNodes({ S1: ['S3'] });
    expect(rolledUpNeighbours(nodes, 'F1')).toEqual({ blockedBy: ['F2'], blocks: [] });
    expect(rolledUpNeighbours(nodes, 'F2')).toEqual({ blockedBy: [], blocks: ['F1'] });
  });

  it('says nothing about the stories the dependency is written on', () => {
    const nodes = makeNodes({ S1: ['S3'] });
    expect(rolledUpNeighbours(nodes, 'S1')).toEqual({ blockedBy: [], blocks: [] });
  });
});

describe('neighbours', () => {
  it('hands the panel the written links and the reflected ones apart', () => {
    const nodes = makeNodes({ S1: ['S3'] });
    expect(neighbours(nodes, 'F1')).toEqual({
      upstream: [],
      downstream: [],
      rolledUpUpstream: ['F2'],
      rolledUpDownstream: [],
    });
    expect(neighbours(nodes, 'S1')).toEqual({
      upstream: ['S3'],
      downstream: [],
      rolledUpUpstream: [],
      rolledUpDownstream: [],
    });
  });

  it('reflects nothing in the registry, which is a shape rather than a plan', () => {
    const nodes = board(
      template('T1', 'feature', null),
      template('T2', 'user_story', 'T1'),
      template('T3', 'feature', null, { dependsOn: ['T1'] }),
    );
    expect(neighbours(nodes, 'T3')).toEqual({
      upstream: ['T1'],
      downstream: [],
      rolledUpUpstream: [],
      rolledUpDownstream: [],
    });
  });
});
