import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearCachedStatus,
  pruneCachedStatus,
  readCachedStatus,
  withCachedRemoteHalf,
  writeCachedStatus,
} from '$features/drawer/remote/status-cache.js';
import type { RemoteStatusReport } from '$shared';

/**
 * LP-599 — the Sync tab checked the tracker on every open, and the count it
 * showed afterwards was replaced seconds later by a much larger one. The two
 * numbers are two *definitions*: the full three-way merge says what a sync
 * would write, the local half says only "differs from its base snapshot",
 * which on the board this came from was 5 against 48.
 *
 * `withCachedRemoteHalf` is where that is settled, so these are the rails:
 * the full answer wins for every bucket that needed the tracker, and the
 * fresh local read may only ever take work *away* from it.
 */

function report(over: Partial<RemoteStatusReport> = {}): RemoteStatusReport {
  return {
    remote: {
      name: 'upstream',
      provider: 'github',
      target: 'acme/payments',
      scope: null,
      inScope: 3,
      mirrored: 1,
      lastSync: null,
    },
    ahead: [],
    blocked: [],
    behind: [],
    conflicted: [],
    unlinked: [],
    incoming: [],
    orphaned: [],
    decoupled: [],
    unreadable: [],
    failed: [],
    ...over,
  };
}

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

describe('withCachedRemoteHalf', () => {
  it('keeps the checked count rather than the local half’s larger one', () => {
    // The shape of the reported bug: the tracker read said one document is
    // pending; the local half says nine differ from their base snapshot,
    // because a stale base and a field the remote does not carry both count
    // there. The panel must go on showing 1.
    const local = report({ ahead: ['LP-1', 'LP-2', 'LP-3', 'LP-4', 'LP-5', 'LP-6', 'LP-7', 'LP-8', 'LP-9'] });
    const cached = report({ ahead: ['LP-4'], remoteRead: 40 });

    const merged = withCachedRemoteHalf(local, cached);

    expect(merged.ahead).toEqual(['LP-4']);
    expect(merged.remoteRead).toBe(40);
  });

  it('takes the patch-dependent buckets from the check and the disk facts from the local read', () => {
    const local = report({ ahead: ['LP-1'], unlinked: ['LP-9'], orphaned: ['LP-8'] });
    const cached = report({
      ahead: ['LP-1'],
      behind: ['LP-2'],
      conflicted: ['LP-3'],
      incoming: [{ remoteId: 'R1', remoteKey: 'acme#1', remoteUrl: '', title: 'New one' }],
      unlinked: ['LP-STALE'],
    });

    const merged = withCachedRemoteHalf(local, cached);

    // Only the tracker can answer these three.
    expect(merged.behind).toEqual(['LP-2']);
    expect(merged.conflicted).toEqual(['LP-3']);
    expect(merged.incoming).toEqual(cached.incoming);
    // These are on disk, so the fresh read is the current answer.
    expect(merged.unlinked).toEqual(['LP-9']);
    expect(merged.orphaned).toEqual(['LP-8']);
  });

  it('drops a document that no longer differs from its base — a push heals the count', () => {
    // `full.ahead` is always a subset of `local.ahead`, so a document missing
    // from the local read has been pushed or reverted since the check.
    const cached = report({
      ahead: ['LP-1', 'LP-2'],
      blocked: [{ localId: 'LP-2', fields: [{ field: 'assignee', reason: 'no account' }] }],
    });
    const local = report({ ahead: ['LP-2'] });

    const merged = withCachedRemoteHalf(local, cached);

    expect(merged.ahead).toEqual(['LP-2']);
    // `blocked` is a subset of `ahead`, so it follows it.
    expect(merged.blocked.map((entry) => entry.localId)).toEqual(['LP-2']);
  });

  it('never adds a local edit made since the check to the checked count', () => {
    // Whether a fresh local edit is a push, a conflict or something both
    // sides already agree on is exactly the question only the tracker can
    // answer — and guessing "push" is what put the larger number on screen.
    const cached = report({ ahead: ['LP-1'] });
    const local = report({ ahead: ['LP-1', 'LP-7'] });

    expect(withCachedRemoteHalf(local, cached).ahead).toEqual(['LP-1']);
  });

  it('drops the local half’s "the remote was not read" note, which no longer applies', () => {
    const local = report({ remoteMissing: 'the remote was not read — this is the local half' });
    const cached = report({ behind: ['LP-2'] });

    expect(withCachedRemoteHalf(local, cached).remoteMissing).toBeUndefined();
  });

  it('carries verbose field detail from the check', () => {
    const local = report({ ahead: ['LP-1'] });
    const cached = report({
      ahead: ['LP-1'],
      fields: { 'LP-1': [{ field: 'status', local: 'a', remote: 'b', base: 'a', outcome: 'push' }] },
    });

    expect(withCachedRemoteHalf(local, cached).fields).toEqual(cached.fields);
  });
});

describe('pruneCachedStatus', () => {
  it('takes the documents a run settled out of every bucket', () => {
    const cached = report({
      ahead: ['LP-1', 'LP-2'],
      blocked: [{ localId: 'LP-2', fields: [{ field: 'assignee', reason: 'no account' }] }],
      behind: ['LP-3'],
      conflicted: ['LP-4'],
      fields: { 'LP-1': [{ field: 'title', local: 'a', remote: 'a', base: 'a', outcome: 'push' }] },
    });

    const pruned = pruneCachedStatus(cached, ['LP-1', 'LP-3']);

    expect(pruned.ahead).toEqual(['LP-2']);
    expect(pruned.behind).toEqual([]);
    expect(pruned.conflicted).toEqual(['LP-4']);
    expect(pruned.fields).toEqual({});
    // Untouched documents keep their explanation.
    expect(pruned.blocked.map((entry) => entry.localId)).toEqual(['LP-2']);
  });

  it('is the same report when a run touched nothing', () => {
    const cached = report({ ahead: ['LP-1'] });
    expect(pruneCachedStatus(cached, [])).toBe(cached);
  });
});

describe('readCachedStatus / writeCachedStatus / clearCachedStatus', () => {
  beforeEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = fakeStorage();
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it('round-trips a report with its checked-at stamp', () => {
    expect(readCachedStatus('upstream')).toBeNull();

    writeCachedStatus('upstream', report({ ahead: ['LP-1'] }), '2026-09-20T12:00:00Z');

    const cached = readCachedStatus('upstream');
    expect(cached?.report.ahead).toEqual(['LP-1']);
    expect(cached?.checkedAt).toBe('2026-09-20T12:00:00Z');
  });

  it('keeps remotes apart, so one mirror cannot answer for another', () => {
    writeCachedStatus('upstream', report({ ahead: ['LP-1'] }));
    writeCachedStatus('jira', report({ ahead: ['LP-2'] }));

    expect(readCachedStatus('upstream')?.report.ahead).toEqual(['LP-1']);
    expect(readCachedStatus('jira')?.report.ahead).toEqual(['LP-2']);
  });

  it('refuses an incremental report, because absence from one proves nothing', () => {
    writeCachedStatus('upstream', report({ ahead: ['LP-1'], incremental: true }));
    expect(readCachedStatus('upstream')).toBeNull();
  });

  it('forgets a cache once cleared', () => {
    writeCachedStatus('upstream', report());
    clearCachedStatus('upstream');
    expect(readCachedStatus('upstream')).toBeNull();
  });

  it('reads back nothing rather than throwing when storage holds garbage', () => {
    localStorage.setItem('lpm:remote-status:v1:upstream', '{not json');
    expect(readCachedStatus('upstream')).toBeNull();
  });

  it('reads back nothing when storage is not reachable at all', () => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
    expect(readCachedStatus('upstream')).toBeNull();
    // And writing does not throw either — the next open just pays for a live
    // check again, which is the same as a first-ever open.
    expect(() => writeCachedStatus('upstream', report())).not.toThrow();
  });
});
