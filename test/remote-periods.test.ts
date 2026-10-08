import { describe, expect, it } from 'vitest';
import {
  degradedFromBlockFields,
  degradedLevels,
  degradedPeriodField,
  mapPeriodFromRemote,
  mapPeriodToRemote,
  normalizePeriodMapping,
  provisionForPeriod,
  resolvePeriodContainer,
  type PeriodIndex,
  type PeriodMapping,
  type PeriodObservation,
} from '../src/remote/periods.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// The story's period hierarchy: increment › sprint, the sprint mapped to the
// remote's container (a milestone, an iteration).
const MAPPING: PeriodMapping = { container: 'sprint', carrier: 'milestones' };

const PERIOD_HIERARCHY: string[][] = [['increment'], ['sprint']];

const INDEX: PeriodIndex = new Map([
  [
    'TL-1',
    { id: 'TL-1', title: 'PI-1', type: 'increment', parentId: null, starts: '2026-01-01', ends: '2026-03-31' },
  ],
  [
    'TL-2',
    { id: 'TL-2', title: 'Sprint 1', type: 'sprint', parentId: 'TL-1', starts: '2026-01-01', ends: '2026-01-14' },
  ],
  [
    'TL-3',
    { id: 'TL-3', title: 'Sprint 2', type: 'sprint', parentId: 'TL-1', starts: '2026-01-15', ends: '2026-01-28' },
  ],
]);

// A second increment with its own "Sprint 1", for the ambiguity case.
const AMBIGUOUS: PeriodIndex = new Map([
  ['TL-1', { id: 'TL-1', title: 'PI-1', type: 'increment', parentId: null }],
  ['TL-2', { id: 'TL-2', title: 'Sprint 1', type: 'sprint', parentId: 'TL-1' }],
  ['TL-4', { id: 'TL-4', title: 'PI-2', type: 'increment', parentId: null }],
  ['TL-5', { id: 'TL-5', title: 'Sprint 1', type: 'sprint', parentId: 'TL-4' }],
]);

// ---------------------------------------------------------------------------
// normalizePeriodMapping
// ---------------------------------------------------------------------------

describe('normalizePeriodMapping', () => {
  it('reads the container level, defaulting the carrier to milestones', () => {
    expect(normalizePeriodMapping({ container: 'sprint' })).toEqual({
      container: 'sprint',
      carrier: 'milestones',
    });
  });

  it('reads an explicit iteration carrier', () => {
    expect(normalizePeriodMapping({ container: 'sprint', carrier: 'iteration' })).toEqual({
      container: 'sprint',
      carrier: 'iteration',
    });
    expect(normalizePeriodMapping({ container: 'sprint', carrier: 'sprint' })).toEqual({
      container: 'sprint',
      carrier: 'sprint',
    });
  });

  it('accepts the shorthand spelling, naming only the carrier', () => {
    expect(normalizePeriodMapping('milestones')).toEqual({ container: '', carrier: 'milestones' });
    expect(normalizePeriodMapping('iteration')).toEqual({ container: '', carrier: 'iteration' });
    expect(normalizePeriodMapping('sprint')).toEqual({ container: '', carrier: 'sprint' });
  });

  it('returns undefined when the block names nothing', () => {
    expect(normalizePeriodMapping(undefined)).toBeUndefined();
    expect(normalizePeriodMapping({})).toBeUndefined();
    expect(normalizePeriodMapping('cycles')).toBeUndefined();
  });
});

describe('resolvePeriodContainer', () => {
  it('fills the shorthand container with the deepest period level', () => {
    expect(resolvePeriodContainer({ container: '', carrier: 'iteration' }, PERIOD_HIERARCHY)).toEqual({
      container: 'sprint',
      carrier: 'iteration',
    });
  });

  it('leaves an explicit container alone', () => {
    expect(resolvePeriodContainer(MAPPING, PERIOD_HIERARCHY)).toEqual(MAPPING);
  });
});

// ---------------------------------------------------------------------------
// The degraded level's block convention
// ---------------------------------------------------------------------------

describe('degradedPeriodField', () => {
  it('names a degraded level by its period type', () => {
    expect(degradedPeriodField('increment')).toBe('period:increment');
  });
});

describe('degradedFromBlockFields', () => {
  it('reads degraded levels back out of parsed block fields', () => {
    const degraded = new Set(['increment']);
    expect(
      degradedFromBlockFields({ 'period:increment': 'PI-1', parent: 'LP-9' }, degraded),
    ).toEqual([{ type: 'increment', name: 'PI-1' }]);
  });

  it('ignores rows for types that are not degraded, and empty names', () => {
    const degraded = new Set(['increment']);
    expect(
      degradedFromBlockFields({ 'period:sprint': 'Sprint 1', 'period:increment': '' }, degraded),
    ).toEqual([]);
  });

  it('sorts the degraded levels deterministically', () => {
    const degraded = new Set(['quarter', 'increment']);
    expect(
      degradedFromBlockFields(
        { 'period:quarter': 'Q1', 'period:increment': 'PI-1' },
        degraded,
      ),
    ).toEqual([
      { type: 'increment', name: 'PI-1' },
      { type: 'quarter', name: 'Q1' },
    ]);
  });
});

describe('degradedLevels', () => {
  it('lists every period type but the container, in hierarchy order', () => {
    expect(degradedLevels(MAPPING, PERIOD_HIERARCHY)).toEqual(['increment']);
  });

  it('lists several degraded levels when the hierarchy is deeper', () => {
    expect(
      degradedLevels(
        { container: 'sprint', carrier: 'milestones' },
        [['quarter'], ['increment'], ['sprint']],
      ),
    ).toEqual(['quarter', 'increment']);
  });

  it('returns nothing for a single-level hierarchy where the only type maps', () => {
    expect(degradedLevels(MAPPING, [['sprint']])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mapPeriodToRemote — push direction
// ---------------------------------------------------------------------------

describe('mapPeriodToRemote', () => {
  it('maps a sprint to the container and its increment to a degraded level', () => {
    expect(mapPeriodToRemote(INDEX, MAPPING, 'TL-2')).toEqual({
      container: { name: 'Sprint 1', starts: '2026-01-01', ends: '2026-01-14' },
      degraded: [{ type: 'increment', name: 'PI-1' }],
    });
  });

  it('maps an issue scheduled directly in an increment to a degraded level only', () => {
    // The increment is a degraded level: no container, membership rides on the
    // managed block. This is the transversal cut's other half.
    expect(mapPeriodToRemote(INDEX, MAPPING, 'TL-1')).toEqual({
      degraded: [{ type: 'increment', name: 'PI-1' }],
    });
  });

  it('carries nothing for an unscheduled issue', () => {
    expect(mapPeriodToRemote(INDEX, MAPPING, null)).toEqual({ degraded: [] });
    expect(mapPeriodToRemote(INDEX, MAPPING, undefined)).toEqual({ degraded: [] });
  });

  it('carries the container dates but not a degraded level dates', () => {
    const push = mapPeriodToRemote(INDEX, MAPPING, 'TL-2');
    expect(push.container).toEqual({
      name: 'Sprint 1',
      starts: '2026-01-01',
      ends: '2026-01-14',
    });
    // The increment's dates (2026-01-01 → 2026-03-31) are not on the wire —
    // only its name, which is what a degraded level can carry.
    expect(push.degraded).toEqual([{ type: 'increment', name: 'PI-1' }]);
  });

  it('omits absent dates rather than inventing them', () => {
    const index: PeriodIndex = new Map([
      ['TL-9', { id: 'TL-9', title: 'Sprint 9', type: 'sprint', parentId: null }],
    ]);
    expect(mapPeriodToRemote(index, MAPPING, 'TL-9')).toEqual({
      container: { name: 'Sprint 9' },
      degraded: [],
    });
  });

  it('reports a period id that is not on the timeline', () => {
    expect(mapPeriodToRemote(INDEX, MAPPING, 'TL-99')).toEqual({
      degraded: [],
      gap: { periodId: 'TL-99', reason: 'not on the timeline' },
    });
  });

  it('sorts the degraded levels deterministically', () => {
    const index: PeriodIndex = new Map([
      ['TL-1', { id: 'TL-1', title: 'Q1', type: 'quarter', parentId: null }],
      ['TL-2', { id: 'TL-2', title: 'PI-1', type: 'increment', parentId: 'TL-1' }],
      ['TL-3', { id: 'TL-3', title: 'Sprint 1', type: 'sprint', parentId: 'TL-2' }],
    ]);
    const push = mapPeriodToRemote(index, MAPPING, 'TL-3');
    expect(push.degraded).toEqual([
      { type: 'increment', name: 'PI-1' },
      { type: 'quarter', name: 'Q1' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// provisionForPeriod — the story's second criterion
// ---------------------------------------------------------------------------

describe('provisionForPeriod', () => {
  it('describes the container provision would create for a mapped period', () => {
    expect(
      provisionForPeriod(
        { id: 'TL-2', title: 'Sprint 1', type: 'sprint', parentId: 'TL-1', starts: '2026-01-01', ends: '2026-01-14' },
        MAPPING,
      ),
    ).toEqual({ name: 'Sprint 1', starts: '2026-01-01', ends: '2026-01-14' });
  });

  it('returns nothing for a degraded level — it has no container to create', () => {
    expect(
      provisionForPeriod(
        { id: 'TL-1', title: 'PI-1', type: 'increment', parentId: null },
        MAPPING,
      ),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mapPeriodFromRemote — pull direction
// ---------------------------------------------------------------------------

function pull(observation: PeriodObservation) {
  return mapPeriodFromRemote(INDEX, MAPPING, observation);
}

describe('mapPeriodFromRemote', () => {
  it('resolves a container name to a local period and recovers the dates', () => {
    const result = pull({
      container: 'Sprint 1',
      ends: '2026-01-14',
      degraded: [{ type: 'increment', name: 'PI-1' }],
    });
    expect(result.periodId).toBe('TL-2');
    expect(result.unresolved).toBeUndefined();
    expect(result.starts).toBeUndefined();
    expect(result.ends).toBe('2026-01-14');
  });

  it('passes the degraded-level names back through', () => {
    const result = pull({ container: 'Sprint 1', degraded: [{ type: 'increment', name: 'PI-1' }] });
    expect(result.degraded).toEqual([{ type: 'increment', name: 'PI-1' }]);
  });

  it('returns no period when the remote carries no container', () => {
    const result = pull({ degraded: [{ type: 'increment', name: 'PI-1' }] });
    expect(result.periodId).toBeUndefined();
    expect(result.unresolved).toBeUndefined();
    expect(result.degraded).toEqual([{ type: 'increment', name: 'PI-1' }]);
  });

  it('reports a container name matching no local period, with a suggestion', () => {
    const result = pull({ container: 'Sprint 99', degraded: [] });
    expect(result.periodId).toBeUndefined();
    expect(result.unresolved).toBe('unmapped');
    expect(result.missing).toEqual({
      containerName: 'Sprint 99',
      suggestion: 'create a sprint titled "Sprint 99" locally, or provision "Sprint 99" on the remote',
    });
  });

  it('reports ambiguity when two mapped-level periods share the name', () => {
    const result = mapPeriodFromRemote(AMBIGUOUS, MAPPING, { container: 'Sprint 1', degraded: [] });
    expect(result.periodId).toBeUndefined();
    expect(result.unresolved).toBe('ambiguous');
    expect(result.candidates).toEqual(['TL-2', 'TL-5']);
  });

  it('matches only the mapped level — an increment name is not a container', () => {
    const result = pull({ container: 'PI-1', degraded: [] });
    expect(result.unresolved).toBe('unmapped');
    expect(result.missing?.containerName).toBe('PI-1');
  });
});
