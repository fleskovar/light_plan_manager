import { describe, expect, it } from 'vitest';
import {
  mapAssigneeFromRemote,
  mapAssigneeToRemote,
  normalizeAccountMapping,
  poolIdFromLabel,
  poolLabel,
  uniqueResourceGaps,
  type Roster,
} from '../src/remote/accounts.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACCOUNTS = { via: 'github' };

const ROSTER: Roster = new Map([
  ['RS-1', { id: 'RS-1', title: 'Frank', generic: false, attributes: { github: 'frank' } }],
  ['RS-2', { id: 'RS-2', title: 'Grace', generic: false, attributes: { github: '' } }],
  ['RS-3', { id: 'RS-3', title: 'Backend Pool', generic: true, attributes: {} }],
]);

// ---------------------------------------------------------------------------
// normalizeAccountMapping
// ---------------------------------------------------------------------------

describe('normalizeAccountMapping', () => {
  it('reads the via attribute', () => {
    expect(normalizeAccountMapping({ via: 'github' })).toEqual({ via: 'github' });
  });

  it('returns undefined when the block names no attribute', () => {
    expect(normalizeAccountMapping(undefined)).toBeUndefined();
    expect(normalizeAccountMapping({})).toBeUndefined();
    expect(normalizeAccountMapping({ via: '' })).toBeUndefined();
    expect(normalizeAccountMapping('github')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Pool label convention
// ---------------------------------------------------------------------------

describe('poolLabel', () => {
  it('names a pool by id, and the id reads back out', () => {
    expect(poolLabel('RS-3')).toBe('pool:RS-3');
    expect(poolIdFromLabel('pool:RS-3')).toBe('RS-3');
  });

  it('is undefined for labels that are not pool labels', () => {
    expect(poolIdFromLabel('story')).toBeUndefined();
    expect(poolIdFromLabel('pool:')).toBeUndefined();
    expect(poolIdFromLabel('Points:3')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mapAssigneeToRemote — push direction
// ---------------------------------------------------------------------------

describe('mapAssigneeToRemote', () => {
  it('resolves a person through the configured attribute', () => {
    expect(mapAssigneeToRemote(ROSTER, ACCOUNTS, 'RS-1')).toEqual({
      account: 'frank',
      labels: [],
    });
  });

  it('leaves an unassigned issue unassigned, with nothing to report', () => {
    expect(mapAssigneeToRemote(ROSTER, ACCOUNTS, null)).toEqual({ labels: [] });
    expect(mapAssigneeToRemote(ROSTER, ACCOUNTS, undefined)).toEqual({ labels: [] });
  });

  it('degrades a person with no attribute value to unassigned and reports the gap', () => {
    expect(mapAssigneeToRemote(ROSTER, ACCOUNTS, 'RS-2')).toEqual({
      labels: [],
      gap: { resourceId: 'RS-2', resourceTitle: 'Grace', reason: 'no "github" attribute value' },
    });
  });

  it('degrades a generic pool to unassigned plus a label naming the pool', () => {
    expect(mapAssigneeToRemote(ROSTER, ACCOUNTS, 'RS-3')).toEqual({
      labels: ['pool:RS-3'],
    });
  });

  it('reports an assignee id that is not on the roster', () => {
    expect(mapAssigneeToRemote(ROSTER, ACCOUNTS, 'RS-99')).toEqual({
      labels: [],
      gap: { resourceId: 'RS-99', resourceTitle: 'RS-99', reason: 'not on the roster' },
    });
  });

  it('reports every person as a gap when no account mapping is configured', () => {
    expect(mapAssigneeToRemote(ROSTER, undefined, 'RS-1')).toEqual({
      labels: [],
      gap: {
        resourceId: 'RS-1',
        resourceTitle: 'Frank',
        reason: 'no account mapping is configured (set mapping.accounts.via)',
      },
    });
  });
});

// ---------------------------------------------------------------------------
// uniqueResourceGaps — reported once per person
// ---------------------------------------------------------------------------

describe('uniqueResourceGaps', () => {
  it('dedupes by resource id, keeping first-seen order', () => {
    const gap = { resourceId: 'RS-2', resourceTitle: 'Grace', reason: 'no "github" attribute value' };
    const another = { resourceId: 'RS-9', resourceTitle: 'Zoe', reason: 'no "github" attribute value' };
    expect(uniqueResourceGaps([gap, another, gap, gap])).toEqual([gap, another]);
  });

  it('returns an empty list for no gaps', () => {
    expect(uniqueResourceGaps([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mapAssigneeFromRemote — pull direction
// ---------------------------------------------------------------------------

describe('mapAssigneeFromRemote', () => {
  it('restores a person when the account matches their attribute value', () => {
    expect(
      mapAssigneeFromRemote(ROSTER, ACCOUNTS, { account: 'frank', labels: ['story'] }),
    ).toEqual({ resourceId: 'RS-1' });
  });

  it('restores a pool from its pool label, even when an account is also present', () => {
    // The pool label is our own encoding and is authoritative for the local
    // assignee; a human-set login on the same issue does not override it.
    expect(
      mapAssigneeFromRemote(ROSTER, ACCOUNTS, { account: 'frank', labels: ['pool:RS-3'] }),
    ).toEqual({ resourceId: 'RS-3' });
  });

  it('treats no account and no pool label as explicitly unassigned', () => {
    expect(mapAssigneeFromRemote(ROSTER, ACCOUNTS, { labels: ['story'] })).toEqual({
      unassigned: true,
    });
  });

  it('reports an account nobody on the roster matches, with the fix command', () => {
    expect(
      mapAssigneeFromRemote(ROSTER, ACCOUNTS, { account: 'stranger', labels: ['story'] }),
    ).toEqual({
      unknown: {
        account: 'stranger',
        suggestion: 'lpm new person --set github="stranger"',
      },
    });
  });

  it('does not match a generic pool by account — a pool is not a person', () => {
    // The pool's attributes hold nothing named `github`, and even if they did,
    // a pool must never match an account.
    const withAttr: Roster = new Map([
      ['RS-3', { id: 'RS-3', title: 'Pool', generic: true, attributes: { github: 'frank' } }],
    ]);
    expect(
      mapAssigneeFromRemote(withAttr, ACCOUNTS, { account: 'frank', labels: [] }),
    ).toEqual({
      unknown: { account: 'frank', suggestion: 'lpm new person --set github="frank"' },
    });
  });

  it('reports an unknown account even when no mapping is configured, never inventing', () => {
    expect(
      mapAssigneeFromRemote(ROSTER, undefined, { account: 'frank', labels: [] }),
    ).toEqual({
      unknown: {
        account: 'frank',
        suggestion:
          'configure mapping.accounts.via, then create a person whose account is "frank"',
      },
    });
  });
});
