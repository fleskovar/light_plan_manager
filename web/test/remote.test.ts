import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RemoteState as GatedRemoteState,
  formatLastSync,
  formatLastSyncExact,
  formatValue,
  summarizeSync,
  type RemoteApi,
  type RemoteHost,
} from '$features/drawer/remote/remote.svelte.js';
import { readCachedStatus, writeCachedStatus } from '$features/drawer/remote/status-cache.js';
import type {
  ReadinessFinding,
  ReadinessFixRequest,
  RemoteConflictDto,
  RemoteCoverageReport,
  RemoteReadinessReport,
  RemoteResolveRequestDto,
  RemoteStatusReport,
  RemoteSummaryDto,
  RemoteSyncEventDto,
  RemoteSyncRequestDto,
  RemoteSyncResultDto,
} from '$shared';

/**
 * The state as `lpm ui --experimental` runs it. Every case below is about the
 * tracker panel itself, so it starts switched on; what happens while it is off
 * is its own `describe` at the end.
 */
class RemoteState extends GatedRemoteState {
  constructor(api: RemoteApi, host: RemoteHost) {
    super(api, host);
    this.enabled = true;
  }
}

/**
 * LP-345 — the remote panel's state machine, without a DOM or a server.
 *
 * The `RemoteApi` and `RemoteHost` seams are fakes, so every path — loading the
 * remotes, deriving the per-node badges, selecting a drift bucket, previewing
 * and streaming a sync — is driven without `fetch` or a component.
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

function coverage(over: Partial<RemoteCoverageReport> = {}): RemoteCoverageReport {
  return {
    remote: { name: 'upstream', provider: 'github', target: 'acme/payments' },
    mirrored: 0,
    total: 0,
    gaps: [],
    groups: [],
    decoupled: [],
    outOfScope: [],
    filesPeriods: false,
    ...over,
  };
}

function readiness(findings: ReadinessFinding[] = []): RemoteReadinessReport {
  return {
    remote: { name: 'upstream', provider: 'github', target: 'acme/payments' },
    findings,
    documents: findings.length,
    blocked: findings.some((finding) => finding.severity === 'blocks'),
    askedUsers: true,
    askedPeriods: true,
  };
}

function summary(name: string): RemoteSummaryDto {
  return { name, provider: 'github', direction: 'both', target: 'acme/payments', lastSync: null };
}

function syncResult(over: Partial<RemoteSyncResultDto> = {}): RemoteSyncResultDto {
  return {
    remoteName: 'upstream',
    direction: 'push',
    preflight: [],
    preflightBlocked: false,
    pullConflicts: { conflicts: [], fieldConflicts: [] },
    ...over,
  };
}

function fakeApi(
  remotes: RemoteSummaryDto[],
  reports: Record<string, RemoteStatusReport>,
  onSync?: (onEvent: (event: RemoteSyncEventDto) => void) => void,
  opts: {
    conflict?: (id: string) => RemoteConflictDto | null;
    onResolve?: (body: RemoteResolveRequestDto) => void;
    /** Every sync body, so a test can assert what a button actually asked for. */
    bodies?: RemoteSyncRequestDto[];
    /** Every status read, so a test can assert which half was asked for. */
    statusReads?: Array<{ name: string; local: boolean }>;
    /** Take the status read over — for the slow half, and for failures. */
    onStatus?: (
      name: string,
      options?: { local?: boolean; verbose?: boolean; signal?: AbortSignal },
    ) => Promise<RemoteStatusReport>;
    /** The readiness answer every push is gated on; clear by default. */
    readiness?: RemoteReadinessReport;
    /** Every readiness question asked, so a test can assert the push asked. */
    readinessAsks?: Array<{ name: string; only?: string[] }>;
    /** Every fix applied, so a test can assert what a choice actually wrote. */
    appliedFixes?: ReadinessFixRequest[];
    /** Coverage reports by remote name; an empty one when none is given. */
    coverage?: Record<string, RemoteCoverageReport>;
    /** How many times coverage was read, so a test can assert it is refreshed. */
    coverageReads?: string[];
  } = {},
): RemoteApi {
  return {
    listRemotes: async () => remotes,
    remoteStatus: async (name, options) => {
      opts.statusReads?.push({ name, local: options?.local === true });
      if (opts.onStatus) return opts.onStatus(name, options);
      return reports[name]!;
    },
    remoteReadiness: async (name, request) => {
      opts.readinessAsks?.push({ name, only: request?.only });
      return opts.readiness ?? readiness();
    },
    remoteReadinessFix: async (_name, request) => {
      opts.appliedFixes?.push(...request.fixes);
      return { changed: request.fixes.map((fix) => fix.kind) };
    },
    remoteCoverage: async (name) => {
      opts.coverageReads?.push(name);
      return opts.coverage?.[name] ?? coverage();
    },
    remotePreview: async () => ({
      remoteName: 'upstream',
      direction: 'push',
      preflight: [],
      preflightBlocked: false,
      renders: [],
    }),
    remoteSync: async (_name, body, onEvent) => {
      opts.bodies?.push(body);
      onSync?.(onEvent);
    },
    remoteConflict: async (_name, id) => {
      const detail = opts.conflict?.(id);
      if (!detail) throw new Error(`no conflict for ${id}`);
      return detail;
    },
    resolve: async (name, body) => {
      opts.onResolve?.(body);
      return { remoteName: name, localId: body.id, fields: body.fields ?? {} };
    },
  };
}

interface HostRecording {
  badges: Array<Record<string, string>>;
  selected: string[][];
  notices: Array<{ level: string; message: string }>;
  refreshed: number;
  pushed: number;
}

function fakeHost(over: { dirty?: boolean } = {}): { host: RemoteHost; recording: HostRecording } {
  const recording: HostRecording = { badges: [], selected: [], notices: [], refreshed: 0, pushed: 0 };
  const host: RemoteHost = {
    setSyncBadges: (badges) => recording.badges.push({ ...badges }),
    select: (ids) => recording.selected.push(ids),
    // The board's own titles; the id is the honest fallback for a document the
    // board does not have, which is what an orphaned link is.
    titleOf: (id) => `Title of ${id}`,
    notify: (level, message) => recording.notices.push({ level, message }),
    report: () => {},
    dirty: () => over.dirty ?? false,
    refresh: async () => {
      recording.refreshed += 1;
    },
    push: async () => {
      recording.pushed += 1;
    },
  };
  return { host, recording };
}

describe('summarizeSync', () => {
  it('names what a pull and a push did, and nothing they did not', () => {
    expect(
      summarizeSync(
        syncResult({
          direction: 'both',
          pull: { applied: 2, linked: 1, unlinked: 0, decoupled: 0, appendedComments: 0, failures: [] },
          push: { created: 1, updated: 3, skipped: 0, conflicted: 0, failed: 0, conflictedOps: [], failedOps: [] },
        }),
      ),
    ).toBe('pulled 2 applied, 1 linked — pushed 1 created, 3 updated');
  });

  it('says an unreachable remote rather than pretending a pull happened', () => {
    expect(summarizeSync(syncResult({ unreachable: 'no credential' }))).toBe('remote unreachable');
  });

  it('says nothing to do for an empty run', () => {
    expect(summarizeSync(syncResult())).toBe('Nothing to do');
  });

  it('counts the conflicts a run left for a human', () => {
    expect(
      summarizeSync(
        syncResult({
          pullConflicts: { conflicts: [{ localId: 'LP-1', remoteId: 'R1', reason: 'x' }], fieldConflicts: [{ localId: 'LP-2', remoteId: 'R2', field: 'title', local: 'a', remote: 'b' }] },
        }),
      ),
    ).toBe('2 conflicts left to resolve');
  });
});

describe('formatValue', () => {
  it('renders a blank as an em dash and clamps a long string', () => {
    expect(formatValue(null)).toBe('—');
    expect(formatValue('')).toBe('—');
    expect(formatValue('x'.repeat(80))).toHaveLength(60);
  });

  it('inlines arrays and objects', () => {
    expect(formatValue(['a', 'b'])).toBe('[a, b]');
    expect(formatValue({ a: 1 })).toBe('{"a":1}');
  });
});

describe('formatLastSync', () => {
  // A fixed "now", so the relative wording is asserted rather than the clock.
  const now = Date.parse('2026-09-19T12:00:00Z');

  it('says so plainly when there is no stamp', () => {
    expect(formatLastSync(null, now)).toBe('never synced');
    expect(formatLastSyncExact(null)).toBe('Never synced');
  });

  it('passes through a stamp it cannot parse', () => {
    expect(formatLastSync('not-a-date', now)).toBe('not-a-date');
  });

  it('reads relatively, because a toolbar is read at a glance', () => {
    // `13/09/2026, 15:34:58` makes a reader do date arithmetic to answer "is
    // this stale?", which is the only question the stamp is there for.
    expect(formatLastSync('2026-09-19T11:59:40Z', now)).toBe('just now');
    expect(formatLastSync('2026-09-19T11:30:00Z', now)).toBe('30m ago');
    expect(formatLastSync('2026-09-19T06:00:00Z', now)).toBe('6h ago');
    expect(formatLastSync('2026-09-13T12:00:00Z', now)).toBe('6d ago');
  });

  it('falls back to a date once relative stops meaning anything', () => {
    // Past a month "47d ago" is harder to read than the date itself.
    expect(formatLastSync('2026-01-05T12:00:00Z', now)).toBe(
      new Date('2026-01-05T12:00:00Z').toLocaleDateString(),
    );
  });

  it('keeps the exact moment one hover away', () => {
    expect(formatLastSyncExact('2026-09-13T12:00:00Z')).toContain('Last synced');
  });
});

describe('RemoteState', () => {
  it('loads remotes, reads their reports and publishes only the drift badges', async () => {
    const { host, recording } = fakeHost();
    const state = new RemoteState(
      fakeApi([summary('upstream')], {
        upstream: report({ ahead: ['LP-1'], unlinked: ['LP-2'], conflicted: ['LP-3'] }),
      }),
      host,
    );

    await state.load();

    expect(state.remotes).toEqual([summary('upstream')]);
    expect(state.selected).toBe('upstream');
    expect(state.badgeRemote).toBe('upstream');
    // in-sync is the absence of a mark, so it is never written.
    expect(recording.badges.at(-1)).toEqual({ 'LP-1': 'ahead', 'LP-2': 'unlinked', 'LP-3': 'conflicted' });
  });

  it('derives the badge one node carries, with conflicted winning', async () => {
    const { host } = fakeHost();
    const state = new RemoteState(
      fakeApi([summary('upstream')], {
        upstream: report({ ahead: ['LP-1'], conflicted: ['LP-1'] }),
      }),
      host,
    );
    await state.load();

    expect(state.badgeOf('LP-1')).toBe('conflicted');
    expect(state.badgeOf('LP-9')).toBe('in-sync');
  });

  it('reports counts and selects a bucket on the canvas', async () => {
    const { host, recording } = fakeHost();
    const state = new RemoteState(
      fakeApi([summary('upstream')], {
        upstream: report({ ahead: ['LP-1', 'LP-2'] }),
      }),
      host,
    );
    await state.load();

    expect(state.countOf('ahead')).toBe(2);
    expect(state.idsOf('ahead')).toEqual(['LP-1', 'LP-2']);

    state.selectBucket('ahead');
    expect(recording.selected).toEqual([['LP-1', 'LP-2']]);
  });

  it('switches the badge remote when another remote is selected', async () => {
    const { host, recording } = fakeHost();
    const state = new RemoteState(
      fakeApi([summary('upstream'), summary('mirror')], {
        upstream: report({ ahead: ['LP-1'] }),
        mirror: report({ unlinked: ['LP-2'] }),
      }),
      host,
    );
    await state.load();

    state.select('mirror');
    expect(state.badgeOf('LP-2')).toBe('unlinked');
    expect(recording.badges.at(-1)).toEqual({ 'LP-2': 'unlinked' });
  });

  it('holds a preview without writing', async () => {
    const { host } = fakeHost();
    const state = new RemoteState(fakeApi([summary('upstream')], {}), host);

    const ok = await state.preview('upstream');

    expect(ok).toBe(true);
    expect(state.previewResult?.remoteName).toBe('upstream');
    expect(state.previewResult?.renders).toEqual([]);
  });

  it('streams a push: progress, then the result, then a summary notice', async () => {
    const { host, recording } = fakeHost();
    const bodies: RemoteSyncRequestDto[] = [];
    const state = new RemoteState(
      fakeApi([summary('upstream')], { upstream: report() }, (onEvent) => {
        onEvent({ type: 'progress', index: 1, total: 2, kind: 'create', localId: 'LP-1' });
        onEvent({
          type: 'done',
          result: syncResult({ push: { created: 1, updated: 0, skipped: 0, conflicted: 0, failed: 0, conflictedOps: [], failedOps: [] } }),
        });
      }, { bodies }),
      host,
    );

    await state.push('upstream');

    expect(bodies).toEqual([{ direction: 'push', yes: true }]);
    expect(state.syncResult?.push?.created).toBe(1);
    expect(recording.notices.some((notice) => notice.message === 'pushed 1 created')).toBe(true);
    // The drift report is re-read after the run, so badges follow the push.
    expect(state.reports['upstream']).toBeDefined();
  });

  it('streams a pull the same way, skipping the readiness gate', async () => {
    const { host } = fakeHost();
    const bodies: RemoteSyncRequestDto[] = [];
    const readinessAsks: Array<{ name: string; only?: string[] }> = [];
    const state = new RemoteState(
      fakeApi([summary('upstream')], { upstream: report() }, (onEvent) => {
        onEvent({
          type: 'done',
          result: syncResult({ direction: 'pull', pull: { applied: 2, linked: 0, unlinked: 0, decoupled: 0, appendedComments: 0, failures: [] } }),
        });
      }, { bodies, readinessAsks }),
      host,
    );

    await state.pull('upstream');

    expect(bodies).toEqual([{ direction: 'pull', yes: true }]);
    expect(readinessAsks).toEqual([]);
    expect(state.syncResult?.pull?.applied).toBe(2);
  });

  it('refuses to push a dirty view and offers push-first', async () => {
    const { host, recording } = fakeHost({ dirty: true });
    let synced = false;
    const state = new RemoteState(
      fakeApi([summary('upstream')], { upstream: report() }, () => {
        synced = true;
      }),
      host,
    );

    expect(state.syncBlocked).toBe(true);

    await state.push('upstream');
    expect(synced).toBe(false);
    expect(recording.notices.at(-1)?.message).toContain('Push your edits');

    await state.pushFirst();
    expect(recording.pushed).toBe(1);
  });

  it('refuses to pull over a dirty view too — the two queues are never merged', async () => {
    const { host } = fakeHost({ dirty: true });
    let synced = false;
    const state = new RemoteState(
      fakeApi([summary('upstream')], { upstream: report() }, () => {
        synced = true;
      }),
      host,
    );

    await state.pull('upstream');
    expect(synced).toBe(false);
  });

  it('refreshes the working copy after a successful push', async () => {
    const { host, recording } = fakeHost();
    const state = new RemoteState(
      fakeApi([summary('upstream')], { upstream: report() }, (onEvent) => {
        onEvent({ type: 'done', result: syncResult() });
      }),
      host,
    );

    await state.push('upstream');
    expect(recording.refreshed).toBe(1);
  });

  it('loads one document conflict and records a per-field choice offline', async () => {
    const { host } = fakeHost();
    let resolved: RemoteResolveRequestDto | undefined;
    const state = new RemoteState(
      fakeApi(
        [summary('upstream')],
        { upstream: report({ conflicted: ['LP-1'] }) },
        undefined,
        {
          conflict: (id) =>
            id === 'LP-1'
              ? {
                  remoteName: 'upstream',
                  localId: 'LP-1',
                  remoteId: 'R1',
                  remoteKey: 'acme/payments#1',
                  remoteUrl: 'https://github.com/acme/payments/issues/1',
                  fields: [{ field: 'title', local: 'local title', remote: 'remote title' }],
                }
              : null,
          onResolve: (body) => {
            resolved = body;
          },
        },
      ),
      host,
    );
    await state.load();

    await state.loadConflict('LP-1');
    expect(state.conflictDetail?.fields).toHaveLength(1);
    expect(state.conflictDetail?.remoteUrl).toBe('https://github.com/acme/payments/issues/1');

    await state.chooseField('title', 'local');
    expect(resolved).toEqual({ id: 'LP-1', fields: { title: 'local' } });
  });
  // -- pushing and pulling one document -------------------------------------

  /** A state machine with its report already read, plus the bodies it sends. */
  async function loaded(over: Partial<RemoteStatusReport> = {}, dirty = false) {
    const { host, recording } = fakeHost({ dirty });
    const bodies: RemoteSyncRequestDto[] = [];
    const state = new RemoteState(
      fakeApi(
        [summary('upstream')],
        { upstream: report(over) },
        (onEvent) => onEvent({ type: 'done', result: syncResult() }),
        { bodies },
      ),
      host,
    );
    await state.load();
    return { state, bodies, recording };
  }

  it('pushes one document as a selection, never as a scope', async () => {
    // `only` acts on exactly what it names; `scope` would expand to the whole
    // subtree under it. Sending the wrong one is how "push this story" becomes
    // "push this feature and everything in it".
    const { state, bodies } = await loaded();

    await state.pushDocument('LP-2');

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ direction: 'push', only: ['LP-2'], yes: true });
    expect(bodies[0]!.scope).toBeUndefined();
  });

  it('pushes the subtree when children are asked for, and then names a root', async () => {
    const { state, bodies } = await loaded();

    await state.pushDocument('LP-2', { children: true });

    expect(bodies[0]).toMatchObject({ direction: 'push', scope: 'LP-2', yes: true });
    expect(bodies[0]!.only).toBeUndefined();
  });

  it('pulls a document by its twin, so the run is targeted rather than scoped', async () => {
    // A targeted pull is partial: it says nothing about twins it did not look
    // for. A one-document *scope* would instead be a complete listing of a
    // one-document world, where one missing twin is 100% of it and the bulk
    // guard declines the pull outright.
    const { state, bodies } = await loaded({
      links: { 'LP-2': { remoteId: '42', remoteKey: 'PAY-42', remoteUrl: '' } },
    });

    await state.pullDocument('LP-2');

    expect(bodies[0]).toMatchObject({ direction: 'pull', pullIds: ['42'], yes: true });
    expect(bodies[0]!.scope).toBeUndefined();
  });

  it('pulls nothing for a document with no twin', async () => {
    // Not a smaller pull — nothing to pull. Sending an empty `pullIds` would
    // read as "pull everything".
    const { state, bodies } = await loaded();

    await state.pullDocument('LP-2');

    expect(bodies).toEqual([]);
  });

  it('pushes a multi-selection as one run naming exactly those documents', async () => {
    const { state, bodies } = await loaded();

    await state.pushDocuments(['LP-2', 'LP-3']);

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ direction: 'push', only: ['LP-2', 'LP-3'] });
  });

  it('pulls a multi-selection by the twins it can find', async () => {
    const { state, bodies } = await loaded({
      links: {
        'LP-2': { remoteId: '42', remoteKey: 'PAY-42', remoteUrl: '' },
        'LP-3': { remoteId: '43', remoteKey: 'PAY-43', remoteUrl: '' },
      },
    });

    await state.pullDocuments(['LP-2', 'LP-3', 'LP-9']);

    expect(bodies[0]).toMatchObject({ pullIds: ['42', '43'] });
  });

  it('refuses a per-document push over a dirty view, exactly as Sync does', async () => {
    // The per-document buttons go through the same runner, so they cannot
    // quietly skip a guard the Sync button honours.
    const { state, bodies, recording } = await loaded({}, true);

    await state.pushDocument('LP-2');

    expect(bodies).toEqual([]);
    expect(recording.notices.at(-1)?.message).toContain('Push your edits');
  });

  it('refreshes the board after a document push, like any other run', async () => {
    const { state, recording } = await loaded();

    await state.pushDocument('LP-2');

    expect(recording.refreshed).toBe(1);
  });

  it('reports one document’s twin and which way it has drifted', async () => {
    const { state } = await loaded({
      ahead: ['LP-2'],
      links: { 'LP-2': { remoteId: '42', remoteKey: 'PAY-42', remoteUrl: 'https://x/PAY-42' } },
    });

    expect(state.documentRemote('LP-2')).toEqual({
      remoteName: 'upstream',
      link: { remoteId: '42', remoteKey: 'PAY-42', remoteUrl: 'https://x/PAY-42' },
      ahead: true,
      behind: false,
      conflicted: false,
    });
  });

  it('reports a document with no twin as unlinked rather than as missing', async () => {
    const { state } = await loaded();
    expect(state.documentRemote('LP-9')).toEqual({
      remoteName: 'upstream',
      link: null,
      ahead: false,
      behind: false,
      conflicted: false,
    });
  });

  it('says nothing at all until a report has been read', () => {
    // The panel shows no section rather than claiming "not mirrored" about a
    // document nobody has asked the remote about yet.
    const { host } = fakeHost();
    const state = new RemoteState(fakeApi([summary('upstream')], {}), host);
    expect(state.documentRemote('LP-2')).toBeNull();
  });

  it('does nothing when no remote is being watched', async () => {
    const { state, bodies } = await loaded();
    state.badgeRemote = null;

    await state.pushDocument('LP-2');
    await state.pullDocument('LP-2');

    expect(bodies).toEqual([]);
  });
});

describe('RemoteState.reportPending', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('says the report is on its way, rather than that nothing is mirrored', async () => {
    // Against a real tracker the report reads every twin and took two minutes
    // on a 537-issue project. For all of that time `documentRemote` is null,
    // and a panel that showed nothing told people the document had no twin.
    let answer: ((report: RemoteStatusReport) => void) | undefined;
    const api: RemoteApi = {
      ...fakeApi([summary('upstream')], {}),
      remoteStatus: () =>
        new Promise<RemoteStatusReport>((resolve) => {
          answer = resolve;
        }),
    };
    const { host } = fakeHost();
    const state = new RemoteState(api, host);

    expect(state.reportPending, 'no remote chosen yet: nothing is pending').toBe(false);

    const loading = state.load();
    for (let i = 0; i < 20 && answer === undefined; i += 1) await tick();

    expect(state.reportPending).toBe(true);
    expect(state.documentRemote('LP-2')).toBeNull();

    answer!(report());
    await loading;

    expect(state.reportPending).toBe(false);
    expect(state.documentRemote('LP-2')).not.toBeNull();
  });
});

describe('RemoteState.refreshRemotes', () => {
  it('shows a newly connected remote even while a slow drift report holds load() busy', async () => {
    const remotes = [summary('upstream')];
    const { host } = fakeHost();
    const api: RemoteApi = {
      ...fakeApi(remotes, { upstream: report(), fresh: report() }),
      listRemotes: async () => [...remotes],
      // The upstream report never answers: a large tracker, still being read.
      remoteStatus: (name) =>
        name === 'upstream' ? new Promise<RemoteStatusReport>(() => {}) : Promise.resolve(report()),
    };
    const state = new RemoteState(api, host);
    void state.load();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.loading).toBe(true);

    remotes.push(summary('fresh'));
    // The gap this exists for: load() refuses to start while one is running.
    await state.load();
    expect(state.remotes.map((remote) => remote.name)).toEqual(['upstream']);

    await state.refreshRemotes('fresh');
    expect(state.remotes.map((remote) => remote.name)).toEqual(['upstream', 'fresh']);
    expect(state.selected).toBe('fresh');
  });

  it('moves the selection off a remote that was removed, and forgets its report', async () => {
    const remotes = [summary('a'), summary('b')];
    const { host } = fakeHost();
    const state = new RemoteState(
      { ...fakeApi(remotes, { a: report(), b: report() }), listRemotes: async () => [...remotes] },
      host,
    );
    await state.load();
    state.select('b');
    await new Promise((resolve) => setTimeout(resolve, 0));

    remotes.splice(1, 1);
    await state.refreshRemotes();

    expect(state.selected).toBe('a');
    expect(state.reports.b).toBeUndefined();
  });
});

describe('RemoteState coverage', () => {
  /** A report with one missing story under a mirrored feature and one sprint. */
  function gapReport(): RemoteCoverageReport {
    return coverage({
      mirrored: 2,
      total: 4,
      gaps: [
        {
          id: 'LP-4',
          kind: 'issue',
          type: 'user_story',
          title: 'Retry the webhook',
          reasons: [{ relation: 'child', anchors: ['LP-2'], count: 1 }],
        },
        {
          id: 'TL-3',
          kind: 'period',
          type: 'sprint',
          title: 'Sprint 3',
          reasons: [{ relation: 'period', anchors: ['LP-3'], count: 1 }],
        },
      ],
      groups: [
        { relation: 'child', ids: ['LP-4'] },
        { relation: 'period', ids: ['TL-3'] },
      ],
      filesPeriods: true,
    });
  }

  it('reads coverage with the remote list, without waiting for the drift report', async () => {
    const { host } = fakeHost();
    const reads: string[] = [];
    const state = new RemoteState(
      fakeApi([summary('upstream')], { upstream: report() }, undefined, {
        coverage: { upstream: gapReport() },
        coverageReads: reads,
      }),
      host,
    );

    await state.load();

    expect(reads).toContain('upstream');
    expect(state.coverageReport?.gaps.map((gap) => gap.id)).toEqual(['LP-4', 'TL-3']);
  });

  it('answers what is missing around one document', async () => {
    const { host } = fakeHost();
    const state = new RemoteState(
      fakeApi([summary('upstream')], { upstream: report() }, undefined, {
        coverage: { upstream: gapReport() },
      }),
      host,
    );
    await state.load();

    expect(state.gapsFor('LP-2').map((gap) => gap.id)).toEqual(['LP-4']);
    expect(state.gapsFor('LP-3').map((gap) => gap.id)).toEqual(['TL-3']);
    expect(state.gapsFor('LP-9')).toEqual([]);
  });

  it('pushes the ticked gaps as a selection, not as a scope', async () => {
    const { host } = fakeHost();
    const bodies: RemoteSyncRequestDto[] = [];
    const state = new RemoteState(
      fakeApi([summary('upstream')], { upstream: report() }, undefined, {
        coverage: { upstream: gapReport() },
        bodies,
      }),
      host,
    );
    await state.load();

    state.pick('LP-4');
    state.pickGroup('period');
    expect(state.pickedIds).toEqual(['LP-4', 'TL-3']);

    await state.pushPicked();

    // `only` acts on exactly what it names; `scope` would have told the
    // planner every other twin had left the mirror.
    expect(bodies).toEqual([{ direction: 'push', only: ['LP-4', 'TL-3'], yes: true }]);
    expect(state.pickedIds).toEqual([]);
  });

  it('does nothing when nothing is ticked', async () => {
    const { host } = fakeHost();
    const bodies: RemoteSyncRequestDto[] = [];
    const state = new RemoteState(
      fakeApi([summary('upstream')], { upstream: report() }, undefined, {
        coverage: { upstream: gapReport() },
        bodies,
      }),
      host,
    );
    await state.load();

    await state.pushPicked();

    expect(bodies).toEqual([]);
  });

  it('re-reads coverage after a sync, because the gaps just filed are gone', async () => {
    const { host } = fakeHost();
    const reads: string[] = [];
    const state = new RemoteState(
      fakeApi([summary('upstream')], { upstream: report() }, undefined, {
        coverage: { upstream: gapReport() },
        coverageReads: reads,
      }),
      host,
    );
    await state.load();
    const before = reads.length;

    await state.pushDocuments(['LP-4']);

    expect(reads.length).toBe(before + 1);
  });

  it('forgets a tick once the document is no longer a gap', async () => {
    const { host } = fakeHost();
    let current = gapReport();
    const api = fakeApi([summary('upstream')], { upstream: report() });
    const state = new RemoteState({ ...api, remoteCoverage: async () => current }, host);
    await state.load();

    state.pick('LP-4');
    expect(state.pickedIds).toEqual(['LP-4']);

    // The next read comes back without it — it was pushed.
    current = coverage({ gaps: [], groups: [] });
    await state.loadCoverage('upstream');

    expect(state.pickedIds).toEqual([]);
  });

  it('drops ticks when the panel switches remote', async () => {
    const { host } = fakeHost();
    const state = new RemoteState(
      fakeApi([summary('upstream'), summary('mirror')], {
        upstream: report(),
        mirror: report(),
      }, undefined, {
        coverage: { upstream: gapReport(), mirror: coverage() },
      }),
      host,
    );
    await state.load();
    state.pick('LP-4');

    state.select('mirror');

    // A document belongs to one remote; ticks taken against one must never be
    // pushed at another.
    expect(state.pickedIds).toEqual([]);
  });

  it('shows the ticked gaps on the canvas', async () => {
    const { host, recording } = fakeHost();
    const state = new RemoteState(
      fakeApi([summary('upstream')], { upstream: report() }, undefined, {
        coverage: { upstream: gapReport() },
      }),
      host,
    );
    await state.load();
    state.pick('TL-3');

    state.selectPicked();

    expect(recording.selected.at(-1)).toEqual(['TL-3']);
  });
});

describe('RemoteState drift tiles', () => {
  it('leads on what a sync will write, not on what cannot land', async () => {
    const { host } = fakeHost();
    // The shape of the real board: many documents ahead, almost all of them on a
    // field the tracker cannot accept.
    const many = Array.from({ length: 12 }, (_, i) => `LP-${i + 1}`);
    const state = new RemoteState(
      fakeApi([summary('upstream')], {
        upstream: report({
          ahead: many,
          blocked: many.slice(0, 10).map((localId) => ({
            localId,
            fields: [{ field: 'assignee', reason: 'a pool cannot be assigned here' }],
          })),
        }),
      }),
      host,
    );
    await state.load();
    // The tiles and the table are about what a sync would do, which only the
    // tracker can say: until it has been read they are `—` and empty.
    await state.checkDrift('upstream');

    const pending = state.primaryTiles.find((tile) => tile.id === 'pending');
    const blocked = state.secondaryTiles.find((tile) => tile.id === 'blocked');
    // The headline is the 2 somebody can act on, not the 12.
    expect(pending?.count).toBe(2);
    // And the blocked tile counts **causes**, not documents: ten documents held
    // back by one missing account value is one thing to fix, and showing "10"
    // reads as ten problems. The document count is in the hint and on the rows.
    expect(blocked?.label).toBe('to fix');
    expect(blocked?.count).toBe(1);
    expect(blocked?.hint).toContain('10 edits');
    // The honest totals are still underneath, for anything that needs them.
    expect(state.countOf('ahead')).toBe(12);
    expect(state.countOf('pending') + state.countOf('blocked')).toBe(state.countOf('ahead'));
  });

  it('folds an update and an adoption into one "to pull", and rows keep them apart', async () => {
    const { host } = fakeHost();
    const incoming = [
      { remoteId: '9', remoteKey: 'SCRUM-9', remoteUrl: '', title: 'New upstream' },
    ];
    const full = report({
      behind: ['LP-1'],
      incoming,
      fields: { 'LP-1': [{ field: 'status', local: 'ready', remote: 'done', base: 'ready', outcome: 'pull' }] },
    });
    const state = new RemoteState(
      fakeApi([summary('upstream')], { upstream: full }, undefined, {
        onStatus: async (_name, options) => (options?.local === true ? report() : full),
      }),
      host,
    );
    await state.load();

    // Before the tracker is read it is not known, and an em dash is honest where
    // a 0 would be a claim.
    expect(state.primaryTiles.find((t) => t.id === 'behind')?.count).toBeNull();

    await state.checkDrift('upstream');

    // One number, because the answer to both is "pull": a document the tracker
    // edited and an issue the board has never had are both work coming down.
    expect(state.primaryTiles.find((t) => t.id === 'behind')?.label).toBe('to pull');
    expect(state.primaryTiles.find((t) => t.id === 'behind')?.count).toBe(2);

    // The rows are where the difference lives, because the actions differ: one
    // updates a document that exists on both sides, the other creates one.
    const rows = state.changeRows;
    expect(rows.map((row) => row.direction)).toEqual(['pull', 'create']);
    expect(rows[0]).toMatchObject({ localId: 'LP-1', direction: 'pull' });
    expect(rows[0]!.fields).toEqual([{ field: 'status', local: 'ready', remote: 'done' }]);
    expect(rows[1]).toMatchObject({ localId: null, remoteKey: 'SCRUM-9', direction: 'create' });
  });

  it('asks for the field detail, or the table would have nothing to show', async () => {
    const { host } = fakeHost();
    const verbose: Array<boolean | undefined> = [];
    const state = new RemoteState(
      fakeApi([summary('upstream')], { upstream: report() }, undefined, {
        onStatus: async (_name, options) => {
          verbose.push(options?.verbose);
          return report();
        },
      }),
      host,
    );
    await state.load();
    await state.checkDrift('upstream');

    // The local half needs none (it has no remote side to detail); the tracker
    // read asks for it, because "3 to push" and nothing about *what* is the
    // report this table exists to replace.
    expect(verbose).toEqual([undefined, true]);
  });

  it('lists a conflict, a push and a pull in the order a reader acts on them', async () => {
    const { host } = fakeHost();
    const full = report({
      ahead: ['LP-2'],
      behind: ['LP-3'],
      conflicted: ['LP-1'],
      fields: {
        'LP-1': [{ field: 'title', local: 'Mine', remote: 'Theirs', base: 'Was', outcome: 'conflict' }],
        'LP-2': [{ field: 'title', local: 'Renamed', remote: 'Was', base: 'Was', outcome: 'push' }],
        'LP-3': [{ field: 'status', local: 'ready', remote: 'done', base: 'ready', outcome: 'pull' }],
      },
    });
    const state = new RemoteState(
      fakeApi([summary('upstream')], { upstream: full }, undefined, {
        onStatus: async () => full,
      }),
      host,
    );
    await state.load();
    await state.checkDrift('upstream');

    // Conflicts first: they are the only ones nothing but a person can settle.
    expect(state.changeRows.map((row) => [row.localId, row.direction])).toEqual([
      ['LP-1', 'conflict'],
      ['LP-3', 'pull'],
      ['LP-2', 'push'],
    ]);
    // And the title comes from the board, not the id.
    expect(state.changeRows[0]!.title).toBe('Title of LP-1');
  });

  it('puts blocked rows last, so a first page is work somebody can do', async () => {
    const { host } = fakeHost();
    // The shape of the real board: a handful of real edits behind hundreds of
    // documents that can never be written. Sorted by id inside `push`, the first
    // page was 40 rows of "cannot be written" and not one actionable thing.
    const blockedIds = ['LP-100', 'LP-101', 'LP-102'];
    const full = report({
      ahead: [...blockedIds, 'LP-900'],
      blocked: blockedIds.map((localId) => ({
        localId,
        fields: [{ field: 'assignee', reason: 'a pool cannot be assigned here' }],
      })),
      behind: ['LP-500'],
      fields: {
        'LP-900': [{ field: 'title', local: 'New', remote: 'Old', base: 'Old', outcome: 'push' }],
        'LP-500': [{ field: 'status', local: 'ready', remote: 'done', base: 'ready', outcome: 'pull' }],
        ...Object.fromEntries(
          blockedIds.map((id) => [
            id,
            [{ field: 'assignee', local: 'RS-1', remote: null, base: null, outcome: 'push' }],
          ]),
        ),
      },
    });
    const state = new RemoteState(
      fakeApi([summary('upstream')], { upstream: full }, undefined, { onStatus: async () => full }),
      host,
    );
    await state.load();
    await state.checkDrift('upstream');

    const rows = state.changeRows;
    // **A sync will not write the blocked three, so they are not in a list of
    // what a sync would do.** They are not lost — `blockedGroups` holds them,
    // grouped by the cause they share, which is the only form in which
    // hundreds of them is readable. Leaving them here is what buried the five
    // documents somebody clicked "to push" to find among 435 rows.
    expect(rows.map((row) => row.localId)).toEqual(['LP-500', 'LP-900']);
    expect(rows.every((row) => !row.blocked)).toBe(true);
    expect(state.blockedGroups.flatMap((group) => group.localIds)).toEqual([
      'LP-100',
      'LP-101',
      'LP-102',
    ]);
  });

  it('narrows the table to the tile somebody clicked, and back again', async () => {
    const { host } = fakeHost();
    const full = report({
      ahead: ['LP-900'],
      behind: ['LP-500'],
      conflicted: ['LP-700'],
      fields: {
        'LP-900': [{ field: 'title', local: 'New', remote: 'Old', base: 'Old', outcome: 'push' }],
        'LP-500': [{ field: 'status', local: 'ready', remote: 'done', base: 'ready', outcome: 'pull' }],
        'LP-700': [{ field: 'title', local: 'Here', remote: 'There', base: 'Was', outcome: 'conflict' }],
      },
    });
    const state = new RemoteState(
      fakeApi([summary('upstream')], { upstream: full }, undefined, { onStatus: async () => full }),
      host,
    );
    await state.load();
    await state.checkDrift('upstream');
    expect(state.changeRows).toHaveLength(3);

    // Selecting the ids on the canvas cannot answer "which five?" — a view
    // holds a few dozen nodes and these are usually not among them. Narrowing
    // the table can, so that is what a tile does.
    state.focusChanges('pending');
    expect(state.changeRows.map((row) => row.localId)).toEqual(['LP-900']);
    expect(state.changeTotal).toBe(3);

    state.focusChanges('behind');
    expect(state.changeRows.map((row) => row.localId)).toEqual(['LP-500']);

    // The same click asks and un-asks.
    state.focusChanges('behind');
    expect(state.changeFilter).toBeNull();
    expect(state.changeRows).toHaveLength(3);
  });

  it('counts an incoming issue as something to pull', async () => {
    const { host } = fakeHost();
    const full = report({
      incoming: [
        { remoteId: 'I_9', remoteKey: 'PAY-9', remoteUrl: '', title: 'Filed upstream' },
      ],
    });
    const state = new RemoteState(
      fakeApi([summary('upstream')], { upstream: full }, undefined, { onStatus: async () => full }),
      host,
    );
    await state.load();
    await state.checkDrift('upstream');

    state.focusChanges('behind');
    // A tracker issue with no document here is a pull as much as a changed
    // twin is: the tile counts it, so the filter behind the tile must too.
    expect(state.changeRows.map((row) => row.direction)).toEqual(['create']);
  });

  it('gives a document that moved both ways a row in each direction', async () => {
    const { host } = fakeHost();
    const full = report({
      ahead: ['LP-1'],
      behind: ['LP-1'],
      fields: {
        'LP-1': [
          { field: 'title', local: 'Renamed here', remote: 'Old', base: 'Old', outcome: 'push' },
          { field: 'status', local: 'ready', remote: 'done', base: 'ready', outcome: 'pull' },
        ],
      },
    });
    const state = new RemoteState(
      fakeApi([summary('upstream')], { upstream: full }, undefined, { onStatus: async () => full }),
      host,
    );
    await state.load();
    await state.checkDrift('upstream');

    // It genuinely has work to do in both directions, so hiding either would be
    // a lie about one of them.
    const rows = state.changeRows.filter((row) => row.localId === 'LP-1');
    expect(rows.map((row) => row.direction)).toEqual(['pull', 'push']);
    expect(rows.find((r) => r.direction === 'push')!.fields[0]!.field).toBe('title');
    expect(rows.find((r) => r.direction === 'pull')!.fields[0]!.field).toBe('status');
  });

  it('explains each blocked document', async () => {
    const { host } = fakeHost();
    const state = new RemoteState(
      fakeApi([summary('upstream')], {
        upstream: report({
          ahead: ['LP-1'],
          blocked: [
            { localId: 'LP-1', fields: [{ field: 'assignee', reason: 'no email attribute' }] },
          ],
        }),
      }),
      host,
    );
    await state.load();

    expect(state.blockedReasons.get('LP-1')).toBe('assignee: no email attribute');
  });
});

describe('RemoteState blockedGroups', () => {
  const blocked = (localId: string, reason: string, remedy?: string) => ({
    localId,
    fields: [{ field: 'assignee', reason, ...(remedy !== undefined ? { remedy } : {}) }],
  });

  it('groups hundreds of documents into the handful of causes behind them', async () => {
    const { host } = fakeHost();
    const pool = 'Engine Developer is a pool';
    const noEmail = 'Ada has no "email" value';
    const full = report({
      ahead: ['LP-1', 'LP-2', 'LP-3', 'LP-4'],
      blocked: [
        blocked('LP-1', noEmail, 'Set "email" on RS-8.'),
        blocked('LP-2', pool, 'Assign a named person instead.'),
        blocked('LP-3', noEmail, 'Set "email" on RS-8.'),
        blocked('LP-4', noEmail, 'Set "email" on RS-8.'),
      ],
    });
    const state = new RemoteState(
      fakeApi([summary('upstream')], { upstream: full }, undefined, { onStatus: async () => full }),
      host,
    );
    await state.load();

    const groups = state.blockedGroups;
    // Four documents, two causes — which is the whole point: the same sentence
    // repeated per document is not a report anybody can act on.
    expect(groups).toHaveLength(2);
    // Biggest first: it is the one worth fixing.
    expect(groups[0]).toMatchObject({ reason: noEmail, remedy: 'Set "email" on RS-8.' });
    expect(groups[0]!.localIds).toEqual(['LP-1', 'LP-3', 'LP-4']);
    expect(groups[1]!.localIds).toEqual(['LP-2']);
  });

  it('carries a cause with no remedy rather than inventing one', async () => {
    const { host } = fakeHost();
    const full = report({
      ahead: ['LP-1'],
      blocked: [blocked('LP-1', 'story_points must be an integer')],
    });
    const state = new RemoteState(
      fakeApi([summary('upstream')], { upstream: full }, undefined, { onStatus: async () => full }),
      host,
    );
    await state.load();

    // A reader can tell "nothing to suggest" from "somebody forgot to write one".
    expect(state.blockedGroups[0]?.remedy).toBeUndefined();
  });

  it('is empty when nothing is blocked', async () => {
    const { host } = fakeHost();
    const state = new RemoteState(
      fakeApi([summary('upstream')], { upstream: report({ ahead: ['LP-1'] }) }),
      host,
    );
    await state.load();
    expect(state.blockedGroups).toEqual([]);
  });

  it('shows a whole cause on the canvas in one click', async () => {
    const { host, recording } = fakeHost();
    const full = report({
      ahead: ['LP-1', 'LP-2'],
      blocked: [blocked('LP-1', 'a pool'), blocked('LP-2', 'a pool')],
    });
    const state = new RemoteState(
      fakeApi([summary('upstream')], { upstream: full }, undefined, { onStatus: async () => full }),
      host,
    );
    await state.load();

    state.selectDocuments(state.blockedGroups[0]!.localIds);

    expect(recording.selected.at(-1)).toEqual(['LP-1', 'LP-2']);
  });
});

describe('RemoteState autoCheck', () => {
  it('reads the tracker for the selected remote, so opening a view is enough', async () => {
    const { host } = fakeHost();
    const statusReads: Array<{ name: string; local: boolean }> = [];
    const state = new RemoteState(
      fakeApi([summary('upstream')], { upstream: report() }, undefined, { statusReads }),
      host,
    );
    await state.load();
    expect(state.hasDrift('upstream')).toBe(false);

    await state.autoCheck();

    expect(statusReads).toEqual([
      { name: 'upstream', local: true },
      { name: 'upstream', local: false },
    ]);
    expect(state.hasDrift('upstream')).toBe(true);
  });

  it('reads only the selected remote, not every mirror on the board', async () => {
    const { host } = fakeHost();
    const statusReads: Array<{ name: string; local: boolean }> = [];
    const state = new RemoteState(
      fakeApi([summary('upstream'), summary('mirror')], {
        upstream: report(),
        mirror: report(),
      }, undefined, { statusReads }),
      host,
    );
    await state.load();

    await state.autoCheck();

    // Two local halves (they cost nothing) and exactly one tracker read: five
    // mirrors would otherwise be five trackers' worth of latency on open.
    expect(statusReads.filter((read) => !read.local)).toEqual([
      { name: 'upstream', local: false },
    ]);
  });

  it('does it once, so switching tabs does not re-read', async () => {
    const { host } = fakeHost();
    const statusReads: Array<{ name: string; local: boolean }> = [];
    const state = new RemoteState(
      fakeApi([summary('upstream')], { upstream: report() }, undefined, { statusReads }),
      host,
    );
    await state.load();

    await state.autoCheck();
    await state.autoCheck();
    await state.autoCheck();

    expect(statusReads.filter((read) => !read.local)).toHaveLength(1);
  });

  it('does not retry a failed read, which would be a request loop', async () => {
    const { host } = fakeHost();
    let tracker = 0;
    const state = new RemoteState(
      fakeApi([summary('upstream')], { upstream: report() }, undefined, {
        onStatus: async (_name, options) => {
          if (options?.local === true) return report();
          tracker += 1;
          throw new Error('Jira answered 401');
        },
      }),
      host,
    );
    await state.load();

    await state.autoCheck();
    await state.autoCheck();

    // One bad credential must not become one request per tab change. Pressing
    // Try again (`checkDrift`) is still how a reader retries.
    expect(tracker).toBe(1);
    expect(state.driftState['upstream']).toBe('failed');
  });

  it('does nothing when no remote is selected', async () => {
    const { host } = fakeHost();
    const statusReads: Array<{ name: string; local: boolean }> = [];
    const state = new RemoteState(fakeApi([], {}, undefined, { statusReads }), host);
    await state.load();

    await state.autoCheck();

    expect(statusReads).toEqual([]);
  });
});

describe('RemoteState incoming', () => {
  const arrived = [
    {
      remoteId: '2',
      remoteKey: 'SCRUM-901',
      remoteUrl: 'https://example.atlassian.net/browse/SCRUM-901',
      title: 'Paginate the query API',
      parentLocalId: 'LP-1',
    },
    {
      remoteId: '3',
      remoteKey: 'SCRUM-902',
      remoteUrl: '',
      title: 'Cache the board load',
    },
  ];

  it('is empty until the tracker has been read, which is not the same as empty', async () => {
    const { host } = fakeHost();
    const state = new RemoteState(
      fakeApi([summary('upstream')], { upstream: report({ incoming: arrived }) }, undefined, {
        // The local half knows nothing about the tracker, so it carries no
        // incoming work however much of it there is upstream.
        onStatus: async (_name, options) =>
          options?.local === true ? report() : report({ incoming: arrived }),
      }),
      host,
    );

    await state.load();
    expect(state.incoming).toEqual([]);
    expect(state.hasDrift('upstream')).toBe(false);

    await state.checkDrift('upstream');
    expect(state.incoming).toHaveLength(2);
    expect(state.hasDrift('upstream')).toBe(true);
  });

  it('adopts everything incoming as one targeted pull', async () => {
    const { host } = fakeHost();
    const bodies: RemoteSyncRequestDto[] = [];
    const state = new RemoteState(
      fakeApi(
        [summary('upstream')],
        { upstream: report({ incoming: arrived }) },
        (onEvent) => onEvent({ type: 'done', result: syncResult({ direction: 'pull' }) }),
        { bodies },
      ),
      host,
    );
    await state.load();

    await state.pullIncoming('upstream');

    // Targeted by **remote** id, which is what makes the run partial: these
    // issues have no twin, so a run that read absence as deletion would be
    // reasoning about the whole tracker from the few things somebody ticked.
    expect(bodies).toEqual([
      { direction: 'pull', pullIds: ['2', '3'], yes: true },
    ]);
  });

  it('adopts one when one is named', async () => {
    const { host } = fakeHost();
    const bodies: RemoteSyncRequestDto[] = [];
    const state = new RemoteState(
      fakeApi(
        [summary('upstream')],
        { upstream: report({ incoming: arrived }) },
        (onEvent) => onEvent({ type: 'done', result: syncResult({ direction: 'pull' }) }),
        { bodies },
      ),
      host,
    );
    await state.load();

    await state.pullIncoming('upstream', ['3']);

    expect(bodies).toEqual([{ direction: 'pull', pullIds: ['3'], yes: true }]);
  });

  it('is not gated by the readiness check, because a pull writes nothing upstream', async () => {
    const { host } = fakeHost();
    const readinessAsks: Array<{ name: string; only?: string[] }> = [];
    const state = new RemoteState(
      fakeApi(
        [summary('upstream')],
        { upstream: report({ incoming: arrived }) },
        (onEvent) => onEvent({ type: 'done', result: syncResult({ direction: 'pull' }) }),
        { readinessAsks },
      ),
      host,
    );
    await state.load();

    await state.pullIncoming('upstream');

    expect(readinessAsks).toEqual([]);
  });

  it('does nothing at all when there is nothing incoming', async () => {
    const { host } = fakeHost();
    const bodies: RemoteSyncRequestDto[] = [];
    const state = new RemoteState(
      fakeApi([summary('upstream')], { upstream: report() }, undefined, { bodies }),
      host,
    );
    await state.load();

    await state.pullIncoming('upstream');

    expect(bodies).toEqual([]);
  });

  it('carries the size of the remote read, so "in sync" can be weighed', async () => {
    const { host } = fakeHost();
    const state = new RemoteState(
      fakeApi([summary('upstream')], { upstream: report({ remoteRead: 537 }) }, undefined, {
        onStatus: async (_name, options) =>
          options?.local === true ? report() : report({ remoteRead: 537 }),
      }),
      host,
    );
    await state.load();
    // The local half read no tracker, so it has no size to report.
    expect(state.remoteRead).toBeNull();

    await state.checkDrift('upstream');
    expect(state.remoteRead).toBe(537);
  });
});

describe('RemoteState drift', () => {
  it('reads only the local half on load', async () => {
    const { host } = fakeHost();
    const statusReads: Array<{ name: string; local: boolean }> = [];
    const state = new RemoteState(
      fakeApi([summary('upstream')], { upstream: report({ ahead: ['LP-1'] }) }, undefined, {
        statusReads,
      }),
      host,
    );

    await state.load();

    // One request per twin is minutes on a real mirror, so opening the board
    // must never do it: the local half answers from the board and the links.
    expect(statusReads).toEqual([{ name: 'upstream', local: true }]);
    expect(state.hasDrift('upstream')).toBe(false);
    expect(state.report?.ahead).toEqual(['LP-1']);
  });

  it('goes out to the tracker only when asked, and says so afterwards', async () => {
    const { host } = fakeHost();
    const statusReads: Array<{ name: string; local: boolean }> = [];
    const state = new RemoteState(
      fakeApi([summary('upstream')], { upstream: report({ behind: ['LP-2'] }) }, undefined, {
        statusReads,
      }),
      host,
    );
    await state.load();

    await state.checkDrift('upstream');

    expect(statusReads).toEqual([
      { name: 'upstream', local: true },
      { name: 'upstream', local: false },
    ]);
    expect(state.hasDrift('upstream')).toBe(true);
    expect(state.driftState['upstream']).toBe('idle');
  });

  it('keeps the failure on screen rather than only in a notice', async () => {
    const { host } = fakeHost();
    const state = new RemoteState(
      fakeApi([summary('upstream')], { upstream: report() }, undefined, {
        onStatus: async (_name, options) => {
          if (options?.local === true) return report();
          throw new Error('Jira answered 401');
        },
      }),
      host,
    );
    await state.load();

    await state.checkDrift('upstream');

    // A notice is gone in seconds; "the tab shows nothing and says nothing" is
    // what this answers.
    expect(state.driftState['upstream']).toBe('failed');
    expect(state.driftError['upstream']).toContain('401');
    expect(state.hasDrift('upstream')).toBe(false);
  });

  it('can be given up on, leaving the local report standing', async () => {
    const { host } = fakeHost();
    const state = new RemoteState(
      fakeApi([summary('upstream')], { upstream: report({ ahead: ['LP-1'] }) }, undefined, {
        onStatus: async (_name, options) => {
          if (options?.local === true) return report({ ahead: ['LP-1'] });
          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          });
        },
      }),
      host,
    );
    await state.load();

    const running = state.checkDrift('upstream');
    expect(state.driftState['upstream']).toBe('reading');
    state.cancelDrift('upstream');
    await running;

    // Stopping is not a failure, and what was already known is still known.
    expect(state.driftState['upstream']).toBe('idle');
    expect(state.driftError['upstream']).toBe('');
    expect(state.report?.ahead).toEqual(['LP-1']);
  });

  it('refuses to start a second read while one is running', async () => {
    const { host } = fakeHost();
    let calls = 0;
    const state = new RemoteState(
      fakeApi([summary('upstream')], { upstream: report() }, undefined, {
        onStatus: async (_name, options) => {
          if (options?.local === true) return report();
          calls += 1;
          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          });
        },
      }),
      host,
    );
    await state.load();

    const first = state.checkDrift('upstream');
    await state.checkDrift('upstream');
    expect(calls).toBe(1);
    state.cancelDrift('upstream');
    await first;
  });

  it('re-reads the local half after a sync, never the tracker', async () => {
    const { host } = fakeHost();
    const statusReads: Array<{ name: string; local: boolean }> = [];
    const state = new RemoteState(
      fakeApi([summary('upstream')], { upstream: report() }, undefined, { statusReads }),
      host,
    );
    await state.load();
    statusReads.length = 0;

    await state.pushDocuments(['LP-1']);

    // The run has just said what it wrote; fetching every twin again to find
    // that out is two minutes of requests nobody asked for.
    expect(statusReads).toEqual([{ name: 'upstream', local: true }]);
  });
});

/**
 * LP-599 — "it said 5 to push, then went back to 48 a few seconds later".
 *
 * Two definitions of one word: the tracker read reports what a sync would
 * actually write, the local half only what differs from its base snapshot,
 * and the second is much larger (5 against 48 on the board this came from).
 * Anything that re-read the local half — the board poll, a sync, resolving a
 * conflict, switching remote — used to replace the checked answer with it.
 *
 * **These run with no `localStorage` at all** (vitest here has no DOM), which
 * is the point: the checked answer has to survive the next five seconds from
 * memory. The cache only has to make it survive a reload.
 */
describe('RemoteState after a check', () => {
  const many = ['LP-1', 'LP-2', 'LP-3', 'LP-4', 'LP-5', 'LP-6', 'LP-7', 'LP-8'];

  /** A remote whose local half is much larger than what a sync would write. */
  function twoHalves(onSync?: (onEvent: (event: RemoteSyncEventDto) => void) => void): RemoteApi {
    return fakeApi([summary('upstream')], {}, onSync, {
      onStatus: async (_name, options) =>
        options?.local === true
          ? report({ ahead: many })
          : report({ ahead: ['LP-4'], behind: ['LP-9'], remoteRead: 40 }),
    });
  }

  it('does not let a re-read of the local half widen the checked count', async () => {
    const { host } = fakeHost();
    const state = new RemoteState(twoHalves(), host);

    await state.load();
    // Before any check, the local half is all there is — and it is the bigger
    // of the two numbers, which is why it must never come back afterwards.
    expect(state.countOf('pending')).toBe(8);

    await state.checkDrift('upstream');
    expect(state.countOf('pending')).toBe(1);

    // The board poll re-reads the local half every few seconds.
    await state.loadStatus('upstream');
    expect(state.countOf('pending')).toBe(1);
    expect(state.countOf('behind')).toBe(1);
    expect(state.hasDrift('upstream')).toBe(true);

    // And a whole second bootstrap — which is what the snapshot-dependent
    // effect in `Workspace.svelte` was firing on every pull.
    await state.load();
    expect(state.countOf('pending')).toBe(1);
    expect(state.hasDrift('upstream')).toBe(true);
  });

  it('keeps the checked answer when a conflict resolution re-reads the board', async () => {
    const { host } = fakeHost();
    const state = new RemoteState(
      fakeApi([summary('upstream')], {}, undefined, {
        conflict: () => ({
          remoteName: 'upstream',
          localId: 'LP-4',
          remoteId: 'R4',
          remoteKey: 'acme#4',
          remoteUrl: 'https://example.invalid/4',
          fields: [],
        }),
        onStatus: async (_name, options) =>
          options?.local === true
            ? report({ ahead: many })
            : report({ ahead: ['LP-4'], conflicted: ['LP-4'] }),
      }),
      host,
    );
    await state.load();
    await state.checkDrift('upstream');

    await state.chooseField('title', 'local');

    expect(state.countOf('pending')).toBe(1);
    expect(state.countOf('conflicted')).toBe(1);
  });

  it('takes what a sync settled out of the answer, rather than falling back to the local half', async () => {
    const { host } = fakeHost();
    const state = new RemoteState(
      twoHalves((onEvent) => {
        onEvent({ type: 'progress', index: 1, total: 1, kind: 'update', localId: 'LP-4' });
        onEvent({
          type: 'done',
          result: syncResult({
            push: { created: 0, updated: 1, skipped: 0, conflicted: 0, failed: 0, conflictedOps: [], failedOps: [] },
          }),
        });
      }),
      host,
    );
    await state.load();
    await state.checkDrift('upstream');
    expect(state.countOf('pending')).toBe(1);

    await state.push('upstream');

    // The document the run wrote is gone, the count did not jump to the local
    // half's eight, and what the tracker said about LP-9 still stands.
    expect(state.countOf('pending')).toBe(0);
    expect(state.countOf('behind')).toBe(1);
    expect(state.hasDrift('upstream')).toBe(true);
  });

  it('takes a pulled document out of "to pull" without asking the tracker again', async () => {
    const { host } = fakeHost();
    const statusReads: Array<{ name: string; local: boolean }> = [];
    const state = new RemoteState(
      fakeApi(
        [summary('upstream')],
        {},
        (onEvent) => {
          onEvent({ type: 'progress', index: 1, total: 1, kind: 'update', localId: 'LP-9' });
          onEvent({ type: 'done', result: syncResult({ direction: 'pull' }) });
        },
        {
          statusReads,
          onStatus: async (_name, options) =>
            options?.local === true ? report({ ahead: many }) : report({ behind: ['LP-9'] }),
        },
      ),
      host,
    );
    await state.load();
    await state.checkDrift('upstream');
    expect(state.countOf('behind')).toBe(1);
    statusReads.length = 0;

    await state.pull('upstream');

    expect(state.countOf('behind')).toBe(0);
    // Only the local half was re-read; the run itself said what it applied.
    expect(statusReads).toEqual([{ name: 'upstream', local: true }]);
  });
});

/**
 * The same story one session later: what `localStorage` adds is that a
 * *reload* starts from the last check instead of from the tracker.
 */
describe('RemoteState status cache', () => {
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

  beforeEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = fakeStorage();
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it('opens already "checked" from a cached full report, without a live read', async () => {
    writeCachedStatus(
      'upstream',
      report({ ahead: ['LP-1'], behind: ['LP-2'], remoteRead: 40 }),
      '2026-09-19T12:00:00Z',
    );
    const statusReads: Array<{ name: string; local: boolean }> = [];
    const { host } = fakeHost();
    // A second `RemoteState` is a second page load: nothing here carries
    // over except what `load()` reads back from the (fake) `localStorage`.
    const state = new RemoteState(
      fakeApi([summary('upstream')], { upstream: report({ ahead: ['LP-1'] }) }, undefined, {
        statusReads,
      }),
      host,
    );

    await state.load();
    await state.autoCheck();

    // The local half was read (cheap, no credential); the tracker never was.
    expect(statusReads).toEqual([{ name: 'upstream', local: true }]);
    expect(state.hasDrift('upstream')).toBe(true);
    expect(state.countOf('behind')).toBe(1);
    expect(state.remoteRead).toBe(40);
    expect(state.driftCachedAt['upstream']).toBe('2026-09-19T12:00:00Z');
  });

  it('writes the cache after a live check, so the next open can reuse it', async () => {
    const { host } = fakeHost();
    const state = new RemoteState(
      fakeApi([summary('upstream')], { upstream: report({ behind: ['LP-2'] }) }),
      host,
    );
    await state.load();

    await state.checkDrift('upstream');

    const cached = readCachedStatus('upstream');
    expect(cached?.report.behind).toEqual(['LP-2']);
    expect(state.driftCachedAt['upstream']).toBe(cached?.checkedAt);
  });

  it('prunes what a sync settled from the stored report, and keeps the rest of it', async () => {
    writeCachedStatus(
      'upstream',
      report({ ahead: ['LP-1'], behind: ['LP-2'] }),
      '2026-09-19T12:00:00Z',
    );
    const { host } = fakeHost();
    const state = new RemoteState(
      fakeApi([summary('upstream')], { upstream: report({ ahead: ['LP-1'] }) }, (onEvent) => {
        onEvent({ type: 'progress', index: 1, total: 1, kind: 'update', localId: 'LP-1' });
        onEvent({ type: 'done', result: syncResult() });
      }),
      host,
    );
    await state.load();
    expect(state.hasDrift('upstream')).toBe(true);

    await state.push('upstream');

    // Clearing the cache outright was the first attempt, and it sent the
    // count back to the local half's — the very bug this exists to stop. The
    // stored report survives with the pushed document taken out of it.
    const cached = readCachedStatus('upstream');
    expect(cached?.report.ahead).toEqual([]);
    expect(cached?.report.behind).toEqual(['LP-2']);
    expect(state.hasDrift('upstream')).toBe(true);
  });

  it("drops a remote's cache once it is removed", async () => {
    writeCachedStatus('upstream', report({ behind: ['LP-2'] }));
    const { host } = fakeHost();
    const remotes = [summary('upstream')];
    const state = new RemoteState(fakeApi(remotes, { upstream: report() }), host);
    await state.load();
    expect(readCachedStatus('upstream')).not.toBeNull();

    remotes.length = 0;
    await state.refreshRemotes();

    expect(readCachedStatus('upstream')).toBeNull();
  });
});

describe('RemoteState without --experimental', () => {
  /**
   * `lpm ui` without `--experimental` registers no tracker route, so the state
   * must not ask for one — and, asking for nothing, it leaves every surface
   * that reads it (the Sync tab's tracker panel, the canvas badges and menu
   * entries, the side panel) with nothing to draw.
   */
  it('asks the server nothing and selects, badges and reports nothing', async () => {
    const calls: string[] = [];
    const inner = fakeApi([summary('upstream')], { upstream: report({ ahead: ['LP-1'] }) });
    const api = new Proxy(inner, {
      get: (target, key: string) => {
        const value = target[key as keyof RemoteApi];
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          calls.push(key);
          return (value as (...a: unknown[]) => unknown)(...args);
        };
      },
    });
    const { host, recording } = fakeHost();
    const state = new GatedRemoteState(api, host);

    expect(state.enabled).toBe(false);
    await state.load();
    await state.refreshRemotes('upstream');
    await state.loadStatus('upstream');
    await state.loadCoverage('upstream');
    await state.autoCheck();

    expect(calls).toEqual([]);
    expect(state.remotes).toEqual([]);
    expect(state.selected).toBeNull();
    expect(state.badgeRemote).toBeNull();
    expect(state.reportPending).toBe(false);
    expect(state.documentRemote('LP-1')).toBeNull();
    expect(recording.badges).toEqual([]);
  });
});
