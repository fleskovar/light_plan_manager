import { describe, expect, it } from 'vitest';
import type { NodeDto } from '$shared';
import {
  RECENT_LIMIT,
  filterMatcher,
  foldToDepth,
  levelChoices,
  type QuickFilter,
} from '$features/drawer/table/filters.js';
import { buildRows } from '$features/drawer/table/rows.js';
import { board, config, issue } from './fixtures.js';

/**
 * A board with something in every state the quick filters ask about.
 * Timestamps are what the engine stamps: `created` once, `updated` on write.
 */
const sample = () =>
  board(
    issue('P', 'program', null),
    issue('E', 'epic', 'P'),
    issue('OLD', 'user_story', 'E', {
      status: 'done',
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-05T00:00:00.000Z',
    }),
    issue('SHIPPED', 'user_story', 'E', {
      status: 'done',
      created: '2026-02-01T00:00:00.000Z',
      updated: '2026-06-01T00:00:00.000Z',
    }),
    issue('DOING', 'user_story', 'E', {
      status: 'in_progress',
      created: '2026-03-01T00:00:00.000Z',
      updated: '2026-03-02T00:00:00.000Z',
    }),
    issue('FRESH', 'user_story', 'E', {
      status: 'backlog',
      created: '2026-07-01T00:00:00.000Z',
      updated: '2026-07-01T00:00:00.000Z',
    }),
  );

const match = (filter: QuickFilter, members: string[] = [], limit?: number): string[] => {
  const nodes = sample();
  const keep = filterMatcher(filter, {
    nodes,
    config,
    members: new Set(members),
    limit,
  });
  return Object.values(nodes)
    .filter((node) => !keep || keep(node))
    .map((node) => node.id)
    .sort();
};

describe('filterMatcher', () => {
  it('filters nothing at all for "all"', () => {
    expect(filterMatcher('all', { nodes: sample(), config, members: new Set() })).toBeUndefined();
  });

  it('finds work in an active status', () => {
    expect(match('active')).toEqual(['DOING']);
  });

  it('finds what finished most recently, newest first and capped', () => {
    expect(match('done')).toEqual(['OLD', 'SHIPPED']);
    // One at a time: the most recently *updated* terminal issue wins.
    expect(match('done', [], 1)).toEqual(['SHIPPED']);
  });

  it('finds what was created most recently', () => {
    expect(match('new', [], 2)).toEqual(['DOING', 'FRESH']);
  });

  it('finds what this view has on the canvas', () => {
    expect(match('canvas', ['E', 'DOING'])).toEqual(['DOING', 'E']);
  });

  it('caps a recent list at the documented limit by default', () => {
    expect(RECENT_LIMIT).toBeGreaterThan(0);
    expect(match('new').length).toBeLessThanOrEqual(RECENT_LIMIT);
  });
});

describe('the rows a filter produces', () => {
  const rowsFor = (
    filter: QuickFilter,
    expanded: (id: string) => boolean = () => true,
  ): string[] =>
    buildRows(sample(), {
      kind: 'issue',
      keep: filterMatcher(filter, { nodes: sample(), config, members: new Set() }),
      isExpanded: expanded,
    }).map((row) => row.node.id);

  it('keeps the ancestors of a match, so nothing floats free of its parent', () => {
    // DOING is deep; ancestors P and E ride along.
    expect(rowsFor('active')).toEqual(['P', 'E', 'DOING']);
  });

  it('finds a filter match deep in the tree when branches are open', () => {
    expect(rowsFor('new')).toContain('FRESH');
  });

  it('skips collapsed subtrees entirely — the filter never sees them', () => {
    // Everything folded: only the root P is reached, and P does not
    // match the 'active' filter, so nothing survives.
    expect(rowsFor('active', () => false)).toEqual([]);
  });

  it('does not force branches open merely because a filter was supplied', () => {
    // The bug this pins: `keep` being present used to mean "narrowing", and
    // narrowing forced every branch open — so with a filter always supplied
    // (the table composes quick filter + facets into one predicate) the
    // twisty could never fold anything.
    const rows = buildRows(sample(), {
      kind: 'issue',
      keep: () => true,
      isExpanded: (id) => id !== 'E',
    });
    expect(rows.map((row) => row.node.id)).toEqual(['P', 'E']);
    expect(rows.find((row) => row.node.id === 'E')?.expanded).toBe(false);
  });

  it('shows a collapsed root when it *does* match the filter', () => {
    // Fold everything at depth >= 1; P (depth 0) is still reached.
    const toggle = foldToDepth(sample(), 1);
    const expanded = (id: string) => !toggle[id];
    expect(rowsFor('canvas', expanded)).toEqual([]);

    // But when P is on the canvas, it shows even though children are hidden.
    const keep = filterMatcher('canvas', {
      nodes: sample(),
      config,
      members: new Set(['P']),
    });
    expect(
      buildRows(sample(), {
        kind: 'issue',
        keep,
        isExpanded: expanded,
      }).map((r) => r.node.id),
    ).toEqual(['P']);
  });
});

describe('folding to a level', () => {
  it('folds everything at that depth and below, and nothing above it', () => {
    const folded = foldToDepth(sample(), 1);
    expect(folded['P']).toBeUndefined();
    expect(folded['E']).toBe(true);
    expect(folded['DOING']).toBe(true);
  });

  it('offers one choice per level of the hierarchy', () => {
    const choices = levelChoices(config);
    expect(choices.map((choice) => choice.depth)).toEqual([0, 1, 2, 3, 4]);
    expect(choices[0]!.label).toBe('Program');
    // Several types share a level; the button names the first and says so.
    expect(choices[3]!.label).toBe('User Story / Bug');
  });
});
