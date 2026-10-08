import { describe, expect, it } from 'vitest';
import {
  RemoteState,
  defaultCandidates,
  type RemoteApi,
  type RemoteHost,
} from '$features/drawer/remote/remote.svelte.js';
import type {
  ReadinessFinding,
  ReadinessFixRequest,
  RemoteReadinessReport,
  RemoteStatusReport,
  RemoteSummaryDto,
  RemoteSyncRequestDto,
} from '$shared';

/**
 * The pre-push gate: what a push is about to get wrong, and what the three
 * answers actually do.
 *
 * Driven entirely through the state machine, with the server behind a fake —
 * what matters here is that the question is asked *before* anything is
 * written, that each answer has the effect it claims, and that cancelling
 * leaves both sides untouched.
 */

function statusReport(): RemoteStatusReport {
  return {
    remote: {
      name: 'upstream',
      provider: 'jira',
      target: 'PAY',
      scope: null,
      inScope: 1,
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
    links: { 'LP-1': { remoteId: 'I_1', remoteKey: 'PAY-1', remoteUrl: '' } },
  };
}

function readinessReport(findings: ReadinessFinding[]): RemoteReadinessReport {
  return {
    remote: { name: 'upstream', provider: 'jira', target: 'PAY' },
    findings,
    documents: 2,
    blocked: findings.some((finding) => finding.severity === 'blocks'),
    askedUsers: true,
    askedPeriods: true,
  };
}

const NO_ACCOUNT: ReadinessFinding = {
  key: 'assignee:RS-1',
  code: 'assignee_no_account',
  severity: 'degrades',
  title: 'Ada Lovelace has no Jira account on file',
  detail: 'no "email" attribute value',
  ignored: 'Filed unassigned.',
  documents: ['LP-1', 'LP-2'],
  count: 2,
  fix: {
    kind: 'link_account',
    resourceId: 'RS-1',
    resourceTitle: 'Ada Lovelace',
    via: 'email',
    candidates: [
      { value: 'ada@acme.com', label: 'Ada Lovelace', exact: true },
      { value: 'a.l@acme.com', label: 'A. L' },
    ],
  },
};

const MISSING_SPRINT: ReadinessFinding = {
  key: 'period:TL-3',
  code: 'period_not_filed',
  severity: 'degrades',
  title: 'Sprint 3 has not been filed on Jira',
  detail: 'The target holds no period of that name.',
  ignored: 'Filed unscheduled.',
  documents: ['LP-1'],
  count: 1,
  fix: { kind: 'file_period', periodId: 'TL-3', periodTitle: 'Sprint 3' },
};

const OFF_ROSTER: ReadinessFinding = {
  key: 'assignee:RS-99',
  code: 'assignee_off_roster',
  severity: 'blocks',
  title: 'RS-99 is assigned work but is not on the roster',
  detail: 'The board names an assignee it no longer has.',
  ignored: 'Not offered.',
  documents: ['LP-9'],
  count: 1,
  fix: { kind: 'unassign', issueIds: ['LP-9'] },
};

interface Recording {
  bodies: RemoteSyncRequestDto[];
  fixes: ReadinessFixRequest[];
  asks: Array<{ only?: string[] }>;
  refreshed: number;
}

function harness(findings: ReadinessFinding[]): { state: RemoteState; recording: Recording } {
  const recording: Recording = { bodies: [], fixes: [], asks: [], refreshed: 0 };

  const api: RemoteApi = {
    listRemotes: async () => [
      { name: 'upstream', provider: 'jira', direction: 'both', target: 'PAY', lastSync: null },
    ] satisfies RemoteSummaryDto[],
    remoteStatus: async () => statusReport(),
    remoteCoverage: async () => ({
      remote: { name: 'upstream', provider: 'jira', target: 'PAY' },
      mirrored: 1,
      total: 2,
      gaps: [],
      groups: [],
      decoupled: [],
      outOfScope: [],
      filesPeriods: true,
    }),
    remoteReadiness: async (_name, body) => {
      recording.asks.push({ ...(body?.only ? { only: body.only } : {}) });
      return readinessReport(findings);
    },
    remoteReadinessFix: async (_name, body) => {
      recording.fixes.push(...body.fixes);
      return { changed: body.fixes.map((fix) => fix.kind) };
    },
    remotePreview: async () => ({
      remoteName: 'upstream',
      direction: 'push',
      preflight: [],
      preflightBlocked: false,
      renders: [],
    }),
    remoteSync: async (_name, body) => {
      recording.bodies.push(body);
    },
    remoteConflict: async () => {
      throw new Error('no conflict');
    },
    resolve: async () => ({ remoteName: 'upstream', localId: 'LP-1', fields: {} }),
  };

  const host: RemoteHost = {
    setSyncBadges: () => {},
    select: () => {},
    titleOf: (id: string) => id,
    notify: () => {},
    report: () => {},
    dirty: () => false,
    refresh: async () => {
      recording.refreshed += 1;
    },
    push: async () => {},
  };

  const state = new RemoteState(api, host);
  state.enabled = true;
  return { state, recording };
}

async function ready(findings: ReadinessFinding[]) {
  const { state, recording } = harness(findings);
  await state.load();
  recording.asks.length = 0;
  return { state, recording };
}

// ---------------------------------------------------------------------------

describe('the readiness gate', () => {
  it('asks before a push writes, and holds the run back', async () => {
    const { state, recording } = await ready([NO_ACCOUNT]);

    await state.pushDocuments(['LP-1', 'LP-2']);

    expect(recording.asks).toEqual([{ only: ['LP-1', 'LP-2'] }]);
    expect(state.readiness?.findings).toHaveLength(1);
    // Nothing was written: asking after the fact is what this replaces.
    expect(recording.bodies).toEqual([]);
    expect(state.syncing).toBe(false);
  });

  it('pushes straight through when nothing was found', async () => {
    const { state, recording } = await ready([]);

    await state.pushDocuments(['LP-1']);

    expect(state.readiness).toBeNull();
    expect(recording.bodies).toHaveLength(1);
  });

  it('leaving a finding alone pushes it as it stands', async () => {
    const { state, recording } = await ready([NO_ACCOUNT]);
    await state.pushDocuments(['LP-1']);

    await state.proceedReadiness();

    // Ignore is the default, and it writes nothing to the board.
    expect(recording.fixes).toEqual([]);
    expect(recording.bodies).toEqual([{ direction: 'push', only: ['LP-1'], yes: true }]);
    expect(state.readiness).toBeNull();
  });

  it('fixing an account writes it to the roster before the push runs', async () => {
    const { state, recording } = await ready([NO_ACCOUNT]);
    await state.pushDocuments(['LP-1']);

    state.chooseReadiness('assignee:RS-1', 'fix');
    await state.proceedReadiness();

    // The exact match is pre-selected, so answering is one click.
    expect(recording.fixes).toEqual([
      { kind: 'link_account', resourceId: 'RS-1', via: 'email', value: 'ada@acme.com' },
    ]);
    // And the working copy is re-read before the push replays anything.
    expect(recording.refreshed).toBeGreaterThan(0);
    expect(recording.bodies).toHaveLength(1);
  });

  it('writes the candidate somebody chose, not the one suggested', async () => {
    const { state, recording } = await ready([NO_ACCOUNT]);
    await state.pushDocuments(['LP-1']);

    state.chooseReadiness('assignee:RS-1', 'fix');
    state.chooseCandidate('assignee:RS-1', 'a.l@acme.com');
    await state.proceedReadiness();

    expect(recording.fixes[0]).toMatchObject({ value: 'a.l@acme.com' });
  });

  it('filing a period widens the push instead of editing the board', async () => {
    const { state, recording } = await ready([MISSING_SPRINT]);
    await state.pushDocuments(['LP-1']);

    state.chooseReadiness('period:TL-3', 'fix');
    await state.proceedReadiness();

    // A period is not a board edit: it travels in the selection, and the
    // server routes it to `periods` the way `lpm remote push TL-3` does.
    expect(recording.fixes).toEqual([]);
    expect(recording.bodies).toEqual([
      { direction: 'push', only: ['LP-1', 'TL-3'], yes: true },
    ]);
  });

  it('refuses to push while something that blocks is unanswered', async () => {
    const { state, recording } = await ready([OFF_ROSTER]);
    await state.pushDocuments(['LP-9']);

    expect(state.readinessBlocked).toBe(true);
    await state.proceedReadiness();
    expect(recording.bodies).toEqual([]);

    state.chooseReadiness('assignee:RS-99', 'fix');
    expect(state.readinessBlocked).toBe(false);
    await state.proceedReadiness();
    expect(recording.bodies).toHaveLength(1);
    expect(recording.fixes).toEqual([{ kind: 'unassign', issueIds: ['LP-9'] }]);
  });

  it('cancelling writes nothing anywhere', async () => {
    const { state, recording } = await ready([NO_ACCOUNT]);
    await state.pushDocuments(['LP-1']);
    state.chooseReadiness('assignee:RS-1', 'fix');

    state.dismissReadiness();

    expect(state.readiness).toBeNull();
    expect(recording.fixes).toEqual([]);
    expect(recording.bodies).toEqual([]);
  });

  it('does not gate a pull', async () => {
    const { state, recording } = await ready([NO_ACCOUNT]);

    await state.pullDocuments(['LP-1']);

    // A pull writes nothing upstream, so there is nothing to check first.
    expect(recording.asks).toEqual([]);
    expect(recording.bodies).toHaveLength(1);
  });

  it('asks again on the next push, because the board has moved', async () => {
    const { state, recording } = await ready([NO_ACCOUNT]);
    await state.pushDocuments(['LP-1']);
    await state.proceedReadiness();

    await state.pushDocuments(['LP-2']);

    expect(recording.asks).toHaveLength(2);
  });

  it('pre-selects the best candidate, and none when nothing matched', () => {
    expect(defaultCandidates([NO_ACCOUNT])).toEqual({ 'assignee:RS-1': 'ada@acme.com' });
    const unmatched: ReadinessFinding = {
      ...NO_ACCOUNT,
      fix: { kind: 'link_account', resourceId: 'RS-1', resourceTitle: 'Ada', via: 'email', candidates: [] },
    };
    // A wrong account is worse than none: the work lands on somebody.
    expect(defaultCandidates([unmatched])).toEqual({});
  });
});
