import { describe, expect, it } from 'vitest';
import { relatedTo } from '$features/canvas/highlight.js';

/** S1 -> S2 -> S3, with S4 hanging off S2. */
const edges = [
  { id: 'S1->S2', source: 'S1', target: 'S2' },
  { id: 'S2->S3', source: 'S2', target: 'S3' },
  { id: 'S2->S4', source: 'S2', target: 'S4' },
  { id: 'S5->S6', source: 'S5', target: 'S6' },
];

describe('relatedTo', () => {
  it('is empty when nothing is selected', () => {
    const related = relatedTo(edges, []);
    expect(related.nodes.size).toBe(0);
    expect(related.edges.size).toBe(0);
  });

  it('lights up both directions from a selected node, one hop only', () => {
    const related = relatedTo(edges, ['S2']);
    expect([...related.nodes].sort()).toEqual(['S1', 'S3', 'S4']);
    expect([...related.edges].sort()).toEqual(['S1->S2', 'S2->S3', 'S2->S4']);
  });

  it('leaves the selected node itself out — it is already drawn as selected', () => {
    expect(relatedTo(edges, ['S2']).nodes.has('S2')).toBe(false);
  });

  it('lights up both ends of a selected edge', () => {
    const related = relatedTo(edges, [], ['S5->S6']);
    expect([...related.nodes].sort()).toEqual(['S5', 'S6']);
    expect([...related.edges]).toEqual(['S5->S6']);
  });

  it('takes a selection of several nodes together', () => {
    const related = relatedTo(edges, ['S1', 'S5']);
    expect([...related.nodes].sort()).toEqual(['S2', 'S6']);
    expect([...related.edges].sort()).toEqual(['S1->S2', 'S5->S6']);
  });

  it('ignores an edge that touches nothing selected', () => {
    expect(relatedTo(edges, ['S1']).edges.has('S5->S6')).toBe(false);
  });
});
