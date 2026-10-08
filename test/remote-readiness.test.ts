import { afterAll, describe, expect, it } from 'vitest';
import { createPeriod, createResource, type BoardPaths } from '../src/core/index.js';
import { planReadiness, type ReadinessLive } from '../src/remote/readiness.js';
import { findProvider } from '../src/remote/registry.js';
import type { NativeSprint, RemoteUser } from '../src/remote/provider.js';
import type { OpenedRemote } from '../src/remote/remotes.js';
import type { RemoteReadinessReport } from '../src/shared/remote-readiness.js';
import { boardPath, cleanupBoards, makeBoard, reload, writeRawIssue } from './helpers.js';

/**
 * The pre-push readiness check — what will not land the way the board says.
 *
 * The live half arrives as data, so every path is driven without a network:
 * a remote that answered, one that could not be asked, one with no accounts at
 * all. The cases are the ones that actually file work wrongly — a person with
 * no account, an account the project does not have, a pool, a sprint nobody
 * filed — and the two that are the board's own fault rather than the mapping's.
 */

afterAll(cleanupBoards);

const MAPPING = {
  types: {
    program: { remote: 'program' },
    epic: { remote: 'epic' },
    feature: { remote: 'feature' },
    user_story: { remote: 'story' },
    bug: { remote: 'bug' },
    test: { remote: 'test' },
    review: { remote: 'review' },
    research: { remote: 'research' },
    sub_task: { remote: 'sub-task' },
  },
  statuses: {
    backlog: { remote: ['Backlog'], closed: false },
    ready: { remote: ['Ready'], closed: false },
    in_progress: { remote: ['In Progress'], closed: false },
    in_review: { remote: ['In Review'], closed: false },
    done: { remote: ['Done'], closed: true },
  },
  attributes: { priority: 'Priority' },
  accounts: { via: 'email' },
  periods: { container: 'sprint' },
};

function remoteWith(mapping: Record<string, unknown> = MAPPING): OpenedRemote {
  return {
    name: 'jira',
    provider: findProvider('jira')!,
    direction: 'both',
    on_delete: 'unlink',
    conflict: 'manual',
    fields: {},
    encoding: 'block',
    comments: 'push',
    connection: { site: 'https://acme.atlassian.net', project: 'PAY' },
    mapping,
  };
}

function issue(
  paths: BoardPaths,
  id: string,
  fields: { assignee?: string; period?: string; status?: string } = {},
): void {
  const lines = [`id: ${id}`, 'type: user_story', `title: ${id}`, `status: ${fields.status ?? 'backlog'}`];
  if (fields.assignee) lines.push(`assignee: ${fields.assignee}`);
  if (fields.period) lines.push(`period: ${fields.period}`);
  writeRawIssue(boardPath(paths, id), `---\n${lines.join('\n')}\n---\n`);
}

/** A sprint on the timeline. The scrum template nests one inside an increment. */
function makeSprint(paths: BoardPaths, title = 'Sprint 3'): string {
  const increment = createPeriod(reload(paths), {
    type: 'increment',
    title: 'PI 1',
    starts: '2026-07-01',
    ends: '2026-12-31',
  });
  const sprint = createPeriod(reload(paths), {
    type: 'sprint',
    title,
    starts: '2026-09-01',
    ends: '2026-09-14',
    parentId: increment.id,
  });
  return sprint.id;
}

function live(over: Partial<ReadinessLive> = {}): ReadinessLive {
  return { users: null, periods: null, ...over };
}

function user(id: string, name: string, email?: string): RemoteUser {
  return { id, name, ...(email ? { email } : {}) };
}

function sprint(name: string): NativeSprint {
  return { id: '1', name, state: 'active' };
}

function check(
  paths: BoardPaths,
  liveHalf: ReadinessLive,
  options: { only?: string[]; mapping?: Record<string, unknown> } = {},
): RemoteReadinessReport {
  return planReadiness({
    board: reload(paths),
    remote: remoteWith(options.mapping ?? MAPPING),
    live: liveHalf,
    ...(options.only ? { only: options.only } : {}),
  });
}

const finding = (report: RemoteReadinessReport, key: string) =>
  report.findings.find((entry) => entry.key === key);

// ---------------------------------------------------------------------------

describe('readiness', () => {
  it('says nothing when every assignee and period can land', () => {
    const paths = makeBoard('scrum', 'LP');
    createResource(reload(paths), { type: 'person', title: 'Ada Lovelace', attributes: { email: 'ada@acme.com' } });
    const sprintId = makeSprint(paths);
    const ada = reload(paths).resources.find((resource) => resource.title === 'Ada Lovelace')!;
    issue(paths, 'LP-1', { assignee: ada.id, period: sprintId });

    const report = check(paths, live({ users: [user('acct-1', 'Ada Lovelace', 'ada@acme.com')], periods: [sprint('Sprint 3')] }));

    expect(report.findings).toEqual([]);
    expect(report.blocked).toBe(false);
    expect(report.documents).toBe(1);
  });

  it('reports a person with no account, and offers the remote people who match', () => {
    const paths = makeBoard('scrum', 'LP');
    createResource(reload(paths), { type: 'person', title: 'Ada Lovelace' });
    const ada = reload(paths).resources.find((resource) => resource.title === 'Ada Lovelace')!;
    issue(paths, 'LP-1', { assignee: ada.id });
    issue(paths, 'LP-2', { assignee: ada.id });

    const report = check(
      paths,
      live({ users: [user('acct-1', 'Ada Lovelace', 'ada@acme.com'), user('acct-2', 'Someone Else', 'else@acme.com')] }),
    );

    const entry = finding(report, `assignee:${ada.id}`)!;
    expect(entry.code).toBe('assignee_no_account');
    expect(entry.severity).toBe('degrades');
    expect(entry.count).toBe(2);
    expect(entry.documents).toEqual(['LP-1', 'LP-2']);
    // The fix names the attribute to write and the one person whose display
    // name matches — never everybody on the instance.
    expect(entry.fix).toEqual({
      kind: 'link_account',
      resourceId: ada.id,
      resourceTitle: 'Ada Lovelace',
      via: 'email',
      candidates: [{ value: 'ada@acme.com', label: 'Ada Lovelace · ada@acme.com' }],
    });
  });

  it('reports an account the project does not have', () => {
    const paths = makeBoard('scrum', 'LP');
    createResource(reload(paths), { type: 'person', title: 'Ada Lovelace', attributes: { email: 'ada@old.example' } });
    const ada = reload(paths).resources.find((resource) => resource.title === 'Ada Lovelace')!;
    issue(paths, 'LP-1', { assignee: ada.id });

    const report = check(paths, live({ users: [user('acct-1', 'Ada Lovelace', 'ada@acme.com')] }));

    const entry = finding(report, `assignee:${ada.id}`)!;
    expect(entry.code).toBe('assignee_unknown');
    expect(entry.title).toContain('ada@old.example');
    // The same person under the address the project does have, as the fix.
    expect(entry.fix).toMatchObject({ kind: 'link_account', candidates: [{ value: 'ada@acme.com' }] });
  });

  it('never claims an account is unknown when the remote was not asked', () => {
    const paths = makeBoard('scrum', 'LP');
    createResource(reload(paths), { type: 'person', title: 'Ada Lovelace', attributes: { email: 'ada@old.example' } });
    const ada = reload(paths).resources.find((resource) => resource.title === 'Ada Lovelace')!;
    issue(paths, 'LP-1', { assignee: ada.id });

    // An absent listing is not evidence that nobody is there — the same rule
    // the pull's gone pass keeps about a partial listing.
    const report = check(paths, live({ users: null }));

    expect(report.findings).toEqual([]);
    expect(report.askedUsers).toBe(false);
  });

  it('prefers an email match over a name match, and marks it as one', () => {
    const paths = makeBoard('scrum', 'LP');
    // The account attribute is the Jira account id here, so the roster's email
    // is a *fact about the person* rather than the value being written — which
    // is exactly what makes it the better evidence of who they are.
    createResource(reload(paths), {
      type: 'person',
      title: 'A. Lovelace',
      attributes: { email: 'ada@acme.com' },
    });
    const ada = reload(paths).resources.find((resource) => resource.title === 'A. Lovelace')!;
    issue(paths, 'LP-1', { assignee: ada.id });

    const report = check(paths, live({ users: [user('acct-9', 'A. Lovelace'), user('acct-1', 'Ada L', 'ada@acme.com')] }), {
      mapping: { ...MAPPING, accounts: { via: 'jira_account_id' } },
    });

    const entry = finding(report, `assignee:${ada.id}`)!;
    expect(entry.fix).toMatchObject({
      candidates: [
        { value: 'acct-1', exact: true },
        { value: 'acct-9' },
      ],
    });
  });

  it('reports a pool once, and offers no fix for it', () => {
    const paths = makeBoard('scrum', 'LP');
    const pool = reload(paths).resources.find((resource) => resource.type === 'role');
    if (!pool) return; // the template declares pools; nothing to assert without one
    issue(paths, 'LP-1', { assignee: pool.id });
    issue(paths, 'LP-2', { assignee: pool.id });

    const report = check(paths, live({ users: [] }));

    const entry = finding(report, `assignee:${pool.id}`)!;
    expect(entry.code).toBe('assignee_pool');
    expect(entry.count).toBe(2);
    // Filing it unassigned with a `pool:` label is the design, not a defect —
    // so it is explained and never offered as something to repair.
    expect(entry.fix).toBeUndefined();
    expect(entry.ignored).toContain('pool:');
  });

  it('blocks on an assignee the roster has lost, and offers to clear it', () => {
    const paths = makeBoard('scrum', 'LP');
    issue(paths, 'LP-1', { assignee: 'RS-99' });

    const report = check(paths, live({ users: [] }));

    const entry = finding(report, 'assignee:RS-99')!;
    expect(entry.code).toBe('assignee_off_roster');
    expect(entry.severity).toBe('blocks');
    expect(report.blocked).toBe(true);
    expect(entry.fix).toEqual({ kind: 'unassign', issueIds: ['LP-1'] });
  });

  it('reports a period the remote has not got, and offers to file it', () => {
    const paths = makeBoard('scrum', 'LP');
    const sprintId = makeSprint(paths);
    issue(paths, 'LP-1', { period: sprintId });

    const report = check(paths, live({ periods: [sprint('Sprint 1')] }));

    const entry = finding(report, `period:${sprintId}`)!;
    expect(entry.code).toBe('period_not_filed');
    expect(entry.severity).toBe('degrades');
    expect(entry.fix).toEqual({ kind: 'file_period', periodId: sprintId, periodTitle: 'Sprint 3' });
    expect(entry.ignored).toContain('unscheduled');
  });

  it('says nothing about a period the remote already holds', () => {
    const paths = makeBoard('scrum', 'LP');
    const sprintId = makeSprint(paths);
    issue(paths, 'LP-1', { period: sprintId });

    expect(check(paths, live({ periods: [sprint('Sprint 3')] })).findings).toEqual([]);
  });

  it('never reports a period level the remote degrades', () => {
    const paths = makeBoard('scrum', 'LP');
    createPeriod(reload(paths), { type: 'increment', title: 'PI 1', starts: '2026-07-01', ends: '2026-12-31' });
    const pi = reload(paths).periods.find((period) => period.title === 'PI 1')!;
    issue(paths, 'LP-1', { period: pi.id });

    // The increment rides the managed block: there is no twin for it to miss.
    expect(check(paths, live({ periods: [] })).findings).toEqual([]);
  });

  it('looks only at the documents the push will act on', () => {
    const paths = makeBoard('scrum', 'LP');
    issue(paths, 'LP-1', { assignee: 'RS-99' });
    issue(paths, 'LP-2');

    const report = check(paths, live({ users: [] }), { only: ['LP-2'] });

    expect(report.documents).toBe(1);
    expect(report.findings).toEqual([]);
  });

  it('puts what blocks first', () => {
    const paths = makeBoard('scrum', 'LP');
    const sprintId = makeSprint(paths);
    issue(paths, 'LP-1', { period: sprintId });
    issue(paths, 'LP-2', { assignee: 'RS-99' });

    const report = check(paths, live({ users: [], periods: [] }));

    expect(report.findings.map((entry) => entry.severity)).toEqual(['blocks', 'degrades']);
  });

  it('reports why the remote could not be asked rather than reporting nothing', () => {
    const paths = makeBoard('scrum', 'LP');
    issue(paths, 'LP-1');

    const report = check(paths, live({ unreachable: 'No credential for remote "jira"' }));

    expect(report.unreachable).toContain('No credential');
    expect(report.askedUsers).toBe(false);
    expect(report.askedPeriods).toBe(false);
  });
});
