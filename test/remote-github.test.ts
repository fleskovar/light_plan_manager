import { afterEach, describe, expect, it, vi } from 'vitest';
import { githubConfigSchema } from '../src/remote/providers/github/config.js';
import {
  describeRequest,
  fieldsFromRecord,
} from '../src/remote/providers/github/translator.js';
import { githubConnector } from '../src/remote/providers/github/connector.js';
import { labelClaim } from '../src/remote/labels.js';
import { memoryConnector } from './support/memory-tracker.js';
import type { Roster } from '../src/remote/accounts.js';
import type { AttributeDefs } from '../src/remote/provider.js';
import type { PeriodIndex } from '../src/remote/periods.js';

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

const CONNECTION = { repo: 'acme/payments', token: 'secret' };

const FULL_MAPPING = {
  types: {
    epic: { remote: 'epic' },
    user_story: { remote: 'story' },
  },
  statuses: {
    backlog: { remote: ['Backlog'], closed: false },
    in_progress: { remote: ['In Progress'], closed: false },
    done: { remote: ['Done'], closed: true },
  },
  attributes: { story_points: 'Points', priority: 'Priority' },
  accounts: { via: 'github' },
};

// The board-side attribute definitions the coercion reads: `story_points` is an
// int (so a label value parses back to a number), `priority` an enum.
const ATTRS: AttributeDefs = {
  story_points: { type: 'int' },
  priority: { type: 'enum', values: ['critical', 'high', 'medium', 'low'] },
};

// A roster: a person with a github login, a person with none, and a pool.
const ROSTER: Roster = new Map([
  ['RS-1', { id: 'RS-1', title: 'Frank', generic: false, attributes: { github: 'frank' } }],
  ['RS-2', { id: 'RS-2', title: 'Grace', generic: false, attributes: { github: '' } }],
  ['RS-3', { id: 'RS-3', title: 'Backend Pool', generic: true, attributes: {} }],
]);

// A timeline: an increment holding one sprint, the sprint mapped to milestones.
const PERIODS: PeriodIndex = new Map([
  ['TL-1', { id: 'TL-1', title: 'PI-1', type: 'increment', parentId: null, starts: '2026-01-01', ends: '2026-03-31' }],
  ['TL-2', { id: 'TL-2', title: 'Sprint 1', type: 'sprint', parentId: 'TL-1', starts: '2026-01-01', ends: '2026-01-14' }],
]);

const PERIOD_MAPPING = {
  types: FULL_MAPPING.types,
  statuses: FULL_MAPPING.statuses,
  attributes: {},
  periods: { container: 'sprint' },
};

describe('githubConfigSchema', () => {
  it('accepts a full declaration', () => {
    const result = githubConfigSchema.safeParse({
      connection: CONNECTION,
      mapping: FULL_MAPPING,
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty mapping and fills in the sub-maps', () => {
    const result = githubConfigSchema.safeParse({ connection: CONNECTION, mapping: {} });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.mapping).toEqual({ types: {}, statuses: {}, attributes: {}, fields: {}, status_precedence: 'issue' });
  });

  it('requires connection.repo', () => {
    const result = githubConfigSchema.safeParse({ connection: {}, mapping: {} });
    expect(result.success).toBe(false);
  });

  it('accepts a periods mapping naming the container level', () => {
    const result = githubConfigSchema.safeParse({
      connection: CONNECTION,
      mapping: { periods: { container: 'sprint' } },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.mapping.periods).toEqual({ container: 'sprint' });
  });

  it('rejects a repo that is not owner/repo', () => {
    const result = githubConfigSchema.safeParse({
      connection: { repo: 'not-a-repo' },
      mapping: {},
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Translator: push (board op → request description)
// ---------------------------------------------------------------------------

describe('describeRequest', () => {
  const fields = {
    title: 'Ship the registry',
    body: 'One folder, one line.',
    type: 'user_story',
    status: 'in_progress',
    attributes: { story_points: 3, priority: 'high' },
  };

  it('carries title, body and the mapped labels for a create', () => {
    const { request, problems } = describeRequest(
      { kind: 'create', localId: 'LP-9', fields },
      FULL_MAPPING,
      ATTRS,
    );
    expect(request).toEqual({
      kind: 'create',
      title: 'Ship the registry',
      body: 'One folder, one line.',
      labels: ['story', 'In Progress', 'Points:3', 'Priority:high'],
      labelClaim: {
        exact: new Set(['epic', 'story', 'Backlog', 'In Progress', 'Done']),
        prefixes: ['Points:', 'Priority:', 'pool:'],
      },
      state: 'open',
    });
    expect(problems).toEqual([]);
  });

  it('closes the remote issue for a terminal status', () => {
    const { request } = describeRequest(
      { kind: 'update', localId: 'LP-9', remoteId: '42', fields: { ...fields, status: 'done' } },
      FULL_MAPPING,
      ATTRS,
    );
    expect(request.labels).toContain('Done');
    expect(request.state).toBe('closed');
  });

  it('reopens the remote issue when a card moves out of a terminal status', () => {
    const { request } = describeRequest(
      { kind: 'update', localId: 'LP-9', remoteId: '42', fields: { ...fields, status: 'backlog' } },
      FULL_MAPPING,
      ATTRS,
    );
    expect(request.state).toBe('open');
  });

  it('omits the state when the status has no mapping', () => {
    const { request } = describeRequest(
      { kind: 'create', localId: 'LP-9', fields: { ...fields, status: 'mystery' } },
      FULL_MAPPING,
      ATTRS,
    );
    expect(request.state).toBeUndefined();
  });

  it('omits the state when the mapping does not declare closed or open', () => {
    const mapping = {
      statuses: {
        backlog: { remote: ['Backlog'] },
        in_progress: { remote: ['In Progress'] },
        done: { remote: ['Done'], closed: true },
      },
    };
    const { request } = describeRequest(
      { kind: 'update', localId: 'LP-9', remoteId: '42', fields: { ...fields, status: 'backlog' } },
      mapping,
      ATTRS,
    );
    expect(request.labels).toContain('Backlog');
    expect(request.state).toBeUndefined();
  });

  it('carries kind only for a delete', () => {
    const { request, problems } = describeRequest(
      { kind: 'delete', localId: 'LP-9', remoteId: '42' },
      FULL_MAPPING,
      ATTRS,
    );
    expect(request).toEqual({ kind: 'delete' });
    expect(problems).toEqual([]);
  });

  it('omits labels the mapping does not declare', () => {
    const { request } = describeRequest(
      {
        kind: 'update',
        localId: 'LP-9',
        remoteId: '42',
        fields: { ...fields, type: 'mystery', status: 'mystery' },
      },
      FULL_MAPPING,
      ATTRS,
    );
    expect(request.labels).toEqual(['Points:3', 'Priority:high']);
  });

  it('skips attribute values that are empty', () => {
    const { request } = describeRequest(
      {
        kind: 'create',
        localId: 'LP-9',
        fields: { ...fields, attributes: { story_points: 3, priority: '' } },
      },
      FULL_MAPPING,
      ATTRS,
    );
    expect(request.labels).not.toContain('Priority:');
  });

  it('coerces an int attribute back to its number form through the label', () => {
    // The label carries text; the coercion round-trips it, so a push renders
    // `3` (not `"3"`) and the pull below recovers the number.
    const { request } = describeRequest(
      { kind: 'create', localId: 'LP-9', fields: { ...fields, attributes: { story_points: 8 } } },
      FULL_MAPPING,
      ATTRS,
    );
    expect(request.labels).toContain('Points:8');
  });

  it('omits and reports an attribute value that will not coerce', () => {
    const { request, problems } = describeRequest(
      {
        kind: 'create',
        localId: 'LP-9',
        fields: { ...fields, attributes: { story_points: 'lots', priority: 'high' } },
      },
      FULL_MAPPING,
      ATTRS,
    );
    expect(request.labels).not.toContain('Points:lots');
    expect(request.labels).toContain('Priority:high');
    expect(problems).toEqual([
      { attribute: 'story_points', direction: 'push', reason: 'expected an integer, got string' },
    ]);
  });

  it('writes one label per item for an array attribute mapped to labels', () => {
    const mapping = { attributes: { labels: 'Tag' } };
    const attrs: AttributeDefs = { labels: { type: 'array' } };
    const { request, problems } = describeRequest(
      {
        kind: 'create',
        localId: 'LP-9',
        fields: { ...fields, type: 'mystery', status: 'mystery', attributes: { labels: ['a', 'b'] } },
      },
      mapping,
      attrs,
    );
    expect(request.labels).toEqual(['Tag:a', 'Tag:b']);
    expect(problems).toEqual([]);
  });

  it('assigns a person with a github login to that login', () => {
    const { request, resourceGaps } = describeRequest(
      { kind: 'create', localId: 'LP-9', fields: { ...fields, assignee: 'RS-1' } },
      FULL_MAPPING,
      ATTRS,
      ROSTER,
    );
    expect(request.assignee).toBe('frank');
    expect(resourceGaps).toEqual([]);
  });

  it('pushes a person with no github value unassigned and reports the gap', () => {
    const { request, resourceGaps } = describeRequest(
      { kind: 'update', localId: 'LP-9', remoteId: '42', fields: { ...fields, assignee: 'RS-2' } },
      FULL_MAPPING,
      ATTRS,
      ROSTER,
    );
    expect(request.assignee).toBeNull();
    expect(resourceGaps).toEqual([
      { resourceId: 'RS-2', resourceTitle: 'Grace', reason: 'no "github" attribute value' },
    ]);
  });

  it('pushes a generic pool unassigned, carrying a label naming the pool', () => {
    const { request, resourceGaps } = describeRequest(
      { kind: 'create', localId: 'LP-9', fields: { ...fields, assignee: 'RS-3' } },
      FULL_MAPPING,
      ATTRS,
      ROSTER,
    );
    expect(request.assignee).toBeNull();
    expect(request.labels).toContain('pool:RS-3');
    expect(resourceGaps).toEqual([]);
  });

  it('leaves the remote assignee untouched when the op carries none', () => {
    const { request } = describeRequest(
      { kind: 'create', localId: 'LP-9', fields },
      FULL_MAPPING,
      ATTRS,
      ROSTER,
    );
    expect(request.assignee).toBeUndefined();
  });

  it('maps a sprint to the milestone and its increment to a degraded level', () => {
    const { request, periodGaps } = describeRequest(
      { kind: 'create', localId: 'LP-9', fields: { ...fields, period: 'TL-2' } },
      PERIOD_MAPPING,
      ATTRS,
      ROSTER,
      PERIODS,
    );
    expect(request.period).toEqual({
      name: 'Sprint 1',
      starts: '2026-01-01',
      ends: '2026-01-14',
    });
    // The increment rides the managed block, never a label (LP-313).
    expect(request.degradedPeriods).toEqual([{ type: 'increment', name: 'PI-1' }]);
    expect(request.labels).not.toContain('increment:PI-1');
    expect(periodGaps).toEqual([]);
  });

  it('clears the milestone for an issue in a degraded period level', () => {
    const { request } = describeRequest(
      { kind: 'update', localId: 'LP-9', remoteId: '42', fields: { ...fields, period: 'TL-1' } },
      PERIOD_MAPPING,
      ATTRS,
      ROSTER,
      PERIODS,
    );
    expect(request.period).toBeNull();
    expect(request.degradedPeriods).toEqual([{ type: 'increment', name: 'PI-1' }]);
    expect(request.labels).not.toContain('increment:PI-1');
  });

  it('leaves the milestone untouched when the op carries no period', () => {
    const { request } = describeRequest(
      { kind: 'create', localId: 'LP-9', fields },
      PERIOD_MAPPING,
      ATTRS,
      ROSTER,
      PERIODS,
    );
    expect(request.period).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Translator: pull (remote record → board fields)
// ---------------------------------------------------------------------------

describe('fieldsFromRecord', () => {
  const record = {
    title: 'Ship the registry',
    body: 'One folder, one line.',
    labels: [{ name: 'story' }, { name: 'In Progress' }, { name: 'Points:3' }],
    assignee: { login: 'frank' },
  };

  it('recovers title, body, type, status, attributes and assignee', () => {
    const { patch, problems, unknownAccounts } = fieldsFromRecord(
      record,
      FULL_MAPPING,
      ATTRS,
      ROSTER,
    );
    expect(patch).toEqual({
      title: 'Ship the registry',
      body: 'One folder, one line.',
      type: 'user_story',
      status: 'in_progress',
      assignee: 'RS-1',
      attributes: { story_points: 3 },
    });
    expect(problems).toEqual([]);
    expect(unknownAccounts).toEqual([]);
  });

  it('restores a pool assignment from its pool label', () => {
    const { patch, unknownAccounts } = fieldsFromRecord(
      { labels: ['story', 'pool:RS-3'] },
      FULL_MAPPING,
      ATTRS,
      ROSTER,
    );
    expect(patch.assignee).toBe('RS-3');
    expect(unknownAccounts).toEqual([]);
  });

  it('reports a remote assignee on no roster, without inventing a resource', () => {
    const { patch, unknownAccounts } = fieldsFromRecord(
      { labels: ['story'], assignee: { login: 'stranger' } },
      FULL_MAPPING,
      ATTRS,
      ROSTER,
    );
    expect(patch.assignee).toBeUndefined();
    expect(unknownAccounts).toEqual([
      {
        account: 'stranger',
        suggestion: 'lpm new person --set github="stranger"',
      },
    ]);
  });

  it('clears the local assignee when the remote issue is unassigned', () => {
    const { patch } = fieldsFromRecord(
      { labels: ['story'], assignee: null },
      FULL_MAPPING,
      ATTRS,
      ROSTER,
    );
    expect(patch.assignee).toBeNull();
  });

  it('leaves the type absent when two board types share a label', () => {
    const ambiguous = {
      types: {
        feature: { remote: 'epic' },
        epic: { remote: 'epic' },
      },
    };
    const { patch } = fieldsFromRecord({ labels: ['epic'] }, ambiguous, ATTRS);
    expect(patch.type).toBeUndefined();
  });

  it('leaves the type absent when no mapping matches', () => {
    const { patch } = fieldsFromRecord({ labels: ['misc'] }, FULL_MAPPING, ATTRS);
    expect(patch.type).toBeUndefined();
    expect(patch.status).toBeUndefined();
  });

  it('leaves the status absent when the observed states map to nothing', () => {
    const { patch } = fieldsFromRecord({ labels: ['misc', 'story'] }, FULL_MAPPING, ATTRS);
    expect(patch.type).toBe('user_story');
    expect(patch.status).toBeUndefined();
  });

  it('resolves several remote states to the one board status that claims them', () => {
    const mapping = {
      statuses: {
        done: { remote: ['Done', "Won't Fix", 'Duplicate'], push: 'Done', closed: true },
      },
    };
    const { patch } = fieldsFromRecord({ labels: ['Duplicate'] }, mapping, ATTRS);
    expect(patch.status).toBe('done');
  });

  it('leaves the status absent when several board statuses each claim a state', () => {
    const mapping = {
      statuses: {
        in_review: { remote: ['Review'] },
        in_progress: { remote: ['In Progress'] },
      },
    };
    const { patch } = fieldsFromRecord({ labels: ['Review', 'In Progress'] }, mapping, ATTRS);
    expect(patch.status).toBeUndefined();
  });

  it('accepts labels given as plain strings', () => {
    const { patch } = fieldsFromRecord({ labels: ['story'] }, FULL_MAPPING, ATTRS);
    expect(patch.type).toBe('user_story');
  });

  it('reports and leaves alone a remote value that will not coerce back', () => {
    const { patch, problems } = fieldsFromRecord(
      { labels: ['story', 'Points:free-text'] },
      FULL_MAPPING,
      ATTRS,
    );
    expect(patch.attributes).toBeUndefined();
    expect(problems).toEqual([
      { attribute: 'story_points', direction: 'pull', reason: 'expected an integer, got string' },
    ]);
  });

  it('reports an enum value with no matching option, with the option list', () => {
    const { patch, problems } = fieldsFromRecord(
      { labels: ['story', 'Priority:urgent'] },
      FULL_MAPPING,
      ATTRS,
    );
    expect(patch.attributes).toBeUndefined();
    expect(problems).toEqual([
      {
        attribute: 'priority',
        direction: 'pull',
        reason: '"urgent" is not one of [critical, high, medium, low]',
        options: ['critical', 'high', 'medium', 'low'],
      },
    ]);
  });

  it('round-trips an array attribute through labels, ignoring labels it does not claim', () => {
    const mapping = { attributes: { labels: 'Tag' } };
    const attrs: AttributeDefs = { labels: { type: 'array' } };
    const { patch, problems } = fieldsFromRecord(
      { labels: ['Tag:a', 'triage:keep-me', 'Tag:b', 'story'] },
      mapping,
      attrs,
    );
    expect(patch.attributes).toEqual({ labels: ['a', 'b'] });
    expect(problems).toEqual([]);
  });

  it('recovers the period from the milestone and its due date', () => {
    const { patch, period } = fieldsFromRecord(
      {
        labels: ['story'],
        milestone: { title: 'Sprint 1', due_on: '2026-01-14' },
        body: 'One folder, one line.\n\n<!-- lpm:begin -->\n| light-plan | |\n| --- | --- |\n| period:increment | PI-1 |\n<!-- lpm:end -->',
      },
      PERIOD_MAPPING,
      ATTRS,
      ROSTER,
      PERIODS,
    );
    expect(patch.period).toBe('TL-2');
    expect(period).toMatchObject({ periodId: 'TL-2', ends: '2026-01-14' });
    // The degraded level rides back out of the managed block (LP-313).
    expect(period?.degraded).toEqual([{ type: 'increment', name: 'PI-1' }]);
  });

  it('reports a milestone matching no local period, never inventing one', () => {
    const { patch, period } = fieldsFromRecord(
      { labels: [], milestone: { title: 'Sprint 99' } },
      PERIOD_MAPPING,
      ATTRS,
      ROSTER,
      PERIODS,
    );
    expect(patch.period).toBeUndefined();
    expect(period?.unresolved).toBe('unmapped');
    expect(period?.missing?.containerName).toBe('Sprint 99');
  });

  it('leaves the period absent when the remote has no milestone', () => {
    const { patch, period } = fieldsFromRecord(
      { labels: ['story'] },
      PERIOD_MAPPING,
      ATTRS,
      ROSTER,
      PERIODS,
    );
    expect(patch.period).toBeUndefined();
    expect(period?.periodId).toBeUndefined();
    expect(period?.degraded).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Connector factory
// ---------------------------------------------------------------------------

describe('githubConnector', () => {
  it('builds a connector with the executor-facing operations', () => {
    const connector = githubConnector(CONNECTION);
    expect(connector.name).toBe('github');
    expect(typeof connector.create).toBe('function');
    expect(typeof connector.update).toBe('function');
    expect(typeof connector.delete).toBe('function');
    expect(typeof connector.get).toBe('function');
    expect(typeof connector.list).toBe('function');
    expect(typeof connector.resolve).toBe('function');
    expect(typeof connector.probe).toBe('function');
    expect(typeof connector.reachable).toBe('function');
    expect(typeof connector.comment).toBe('function');
    expect(typeof connector.editComment).toBe('function');
    expect(typeof connector.deleteComment).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Connector create / update (LP-307) — a stubbed fetch, no network
// ---------------------------------------------------------------------------

describe('githubConnector create and update', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(answer: { status: number; body?: unknown }) {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      requests.push({ url, method, body });
      return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
        status: answer.status,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    return requests;
  }

  const ISSUE = {
    number: 418,
    node_id: 'I_kwDOBm4S5s5',
    title: 'Ship the registry',
    body: 'One folder, one line.',
    html_url: 'https://github.com/acme/payments/issues/418',
    updated_at: '2026-09-04T11:19:57Z',
    labels: [{ name: 'story' }],
  };

  it('creates an issue with title and body, returning number, node id and URL', async () => {
    const requests = stubFetch({ status: 201, body: ISSUE });

    const connector = githubConnector(CONNECTION);
    const result = await connector.create({
      kind: 'create',
      title: 'Ship the registry',
      body: 'One folder, one line.',
      labels: ['story'],
    });

    expect(result.remoteId).toBe('418');
    expect(result.nodeId).toBe('I_kwDOBm4S5s5');
    expect(result.remoteUrl).toBe('https://github.com/acme/payments/issues/418');
    expect(requests[0]).toMatchObject({
      url: 'https://api.github.com/repos/acme/payments/issues',
      method: 'POST',
    });
    // The body crosses unchanged — markdown on both sides, no conversion, no
    // reflow (LP-307).
    expect(requests[0]!.body).toEqual({
      title: 'Ship the registry',
      body: 'One folder, one line.',
      labels: ['story'],
    });
  });

  it('patches only the fields the request carries, leaving unchanged fields off the wire', async () => {
    const requests = stubFetch({ status: 200, body: ISSUE });

    const connector = githubConnector(CONNECTION);
    const result = await connector.update('418', { kind: 'update', title: 'Renamed' });

    expect(result.remoteId).toBe('418');
    expect(requests[0]).toMatchObject({
      url: 'https://api.github.com/repos/acme/payments/issues/418',
      method: 'PATCH',
    });
    // body, labels, state and assignees are all absent from the request, so
    // none of them is sent — an unchanged field must not travel (LP-307).
    expect(requests[0]!.body).toEqual({ title: 'Renamed' });
  });
});

// ---------------------------------------------------------------------------
// Connector list (LP-315) — a stubbed fetch: paging, PR filtering, cursor
// ---------------------------------------------------------------------------

describe('githubConnector list', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Stub `fetch`, serving one page per request, with an optional `Link` header. */
  function stubPages(pages: Array<{ body: unknown; link?: string }>) {
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      const page = pages[requests.length - 1]!;
      return new Response(JSON.stringify(page.body), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...(page.link ? { link: page.link } : {}),
        },
      });
    });
    return requests;
  }

  const PR = { url: 'https://api.github.com/repos/acme/payments/pulls/2' };

  it('pages through every page, sorted, and filters out pull requests', async () => {
    const requests = stubPages([
      {
        body: [
          { number: 1, title: 'Issue one', updated_at: '2026-01-01T00:00:00Z' },
          { number: 2, title: 'Bump lodash', updated_at: '2026-01-04T00:00:00Z', pull_request: PR },
        ],
        link: '<https://api.github.com/repos/acme/payments/issues?page=2>; rel="next"',
      },
      {
        body: [{ number: 3, title: 'Issue three', updated_at: '2026-01-03T00:00:00Z' }],
      },
    ]);

    const connector = githubConnector(CONNECTION);
    const page = await connector.list({ cursor: '2025-12-31T00:00:00Z' });

    // The PR is dropped, and its timestamp does not become the cursor.
    expect(page.records.map((record) => String(record.number))).toEqual(['1', '3']);
    expect(page.cursor).toBe('2026-01-03T00:00:00Z');

    // The first request sorts by `updated` ascending and filters by `since`;
    // the second follows the Link header's absolute next-page URL.
    expect(requests).toHaveLength(2);
    const first = new URL(requests[0]!);
    expect(first.searchParams.get('sort')).toBe('updated');
    expect(first.searchParams.get('direction')).toBe('asc');
    expect(first.searchParams.get('since')).toBe('2025-12-31T00:00:00Z');
    expect(requests[1]).toBe('https://api.github.com/repos/acme/payments/issues?page=2');
  });

  it('omits the since filter when there is no stored cursor', async () => {
    const requests = stubPages([{ body: [] }]);

    const connector = githubConnector(CONNECTION);
    const page = await connector.list();

    expect(page.records).toEqual([]);
    expect(page.cursor).toBeNull();
    const first = new URL(requests[0]!);
    expect(first.searchParams.has('since')).toBe(false);
    expect(first.searchParams.get('sort')).toBe('updated');
  });
});

// ---------------------------------------------------------------------------
// Connector comment methods (LP-278) — a stubbed fetch, no network
// ---------------------------------------------------------------------------

describe('githubConnector comments', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Stub `fetch`, recording every request and answering with `status`/`body`. */
  function stubFetch(answers: Array<{ status: number; body?: unknown }>) {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      requests.push({ url, method, body });
      const answer = answers[requests.length - 1]!;
      return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
        status: answer.status,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    return requests;
  }

  it('posts a comment and returns its id', async () => {
    const requests = stubFetch([
      {
        status: 201,
        body: { id: 9001, html_url: 'https://github.com/acme/payments/issues/1#issuecomment-9001', updated_at: '2026-01-01T00:00:00Z' },
      },
    ]);

    const connector = githubConnector(CONNECTION);
    const result = await connector.comment!('1', 'the block');

    expect(result.commentId).toBe('9001');
    expect(result.remoteId).toBe('1');
    expect(requests[0]).toMatchObject({
      url: 'https://api.github.com/repos/acme/payments/issues/1/comments',
      method: 'POST',
    });
    expect(requests[0]!.body).toEqual({ body: 'the block' });
  });

  it('edits a comment in place by its id', async () => {
    const requests = stubFetch([{ status: 200, body: { id: 9001 } }]);

    const connector = githubConnector(CONNECTION);
    const result = await connector.editComment!('1', '9001', 'new block');

    expect(result.commentId).toBe('9001');
    expect(requests[0]).toMatchObject({
      url: 'https://api.github.com/repos/acme/payments/issues/comments/9001',
      method: 'PATCH',
    });
    expect(requests[0]!.body).toEqual({ body: 'new block' });
  });

  it('deletes a comment, returning its id for the repost bookkeeping', async () => {
    const requests = stubFetch([{ status: 204 }]);

    const connector = githubConnector(CONNECTION);
    const result = await connector.deleteComment!('1', '9001');

    expect(result.commentId).toBe('9001');
    expect(result.remoteId).toBe('1');
    expect(requests[0]).toMatchObject({
      url: 'https://api.github.com/repos/acme/payments/issues/comments/9001',
      method: 'DELETE',
    });
  });
});

// ---------------------------------------------------------------------------
// Connector reachability probe (LP-364) — a stubbed fetch, no network
// ---------------------------------------------------------------------------

describe('githubConnector resolve (LP-367)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('turns <repo>#<number> into the issue, returning a create-shaped result', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      requests.push(String(input));
      return new Response(
        JSON.stringify({
          number: 418,
          title: 'Ship the registry',
          body: 'One folder, one line.',
          html_url: 'https://github.com/acme/payments/issues/418',
          updated_at: '2026-09-04T11:19:57Z',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const connector = githubConnector(CONNECTION);
    const result = await connector.resolve!('acme/payments#418');

    expect(result).toMatchObject({
      remoteId: '418',
      remoteKey: 'acme/payments#418',
      remoteUrl: 'https://github.com/acme/payments/issues/418',
      remoteRev: '2026-09-04T11:19:57Z',
    });
    expect(result!.record).toMatchObject({ number: 418, title: 'Ship the registry' });
    expect(requests[0]).toBe('https://api.github.com/repos/acme/payments/issues/418');
  });

  it('accepts a bare issue number as the key', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ number: 7, title: 'T', body: '', html_url: 'https://github.com/acme/payments/issues/7', updated_at: 't' }), {
        status: 200,
      }),
    );

    const connector = githubConnector(CONNECTION);
    const result = await connector.resolve!('7');
    expect(result!.remoteId).toBe('7');
    expect(result!.remoteKey).toBe('acme/payments#7');
  });

  it('returns null when the issue 404s', async () => {
    vi.stubGlobal('fetch', async () => new Response('Not Found', { status: 404 }));

    const connector = githubConnector(CONNECTION);
    expect(await connector.resolve!('acme/payments#999')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Connector reachability probe (LP-364) — a stubbed fetch, no network
// ---------------------------------------------------------------------------

describe('githubConnector reachable (LP-364)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports reachable with the status when the repo answers 200', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 200 }));

    const result = await githubConnector(CONNECTION).reachable!();

    expect(result.reachable).toBe(true);
    expect(result.evidence).toBe('GET /repos/acme/payments → 200');
  });

  it('reports unreachable with the evidence when the repo 404s', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response('Not Found', { status: 404 }),
    );

    const result = await githubConnector(CONNECTION).reachable!();

    expect(result.reachable).toBe(false);
    expect(result.evidence).toBe('GET /repos/acme/payments → 404: Not Found');
  });

  it('reports unreachable with the failure message when the request throws', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });

    const result = await githubConnector(CONNECTION).reachable!();

    expect(result.reachable).toBe(false);
    expect(result.evidence).toContain('ECONNREFUSED');
  });
});

// ---------------------------------------------------------------------------
// Connector label reconciliation and assignee failures (LP-308) — stubbed fetch
// ---------------------------------------------------------------------------

describe('githubConnector label reconciliation (LP-308)', () => {
  afterEach(() => vi.unstubAllGlobals());

  const CLAIM = labelClaim(
    ['story', 'Backlog', 'In Progress', 'Done'],
    ['Points:', 'Priority:', 'pool:'],
  );

  it('adds and removes only the claimed labels; triage labels survive', async () => {
    const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      requests.push({ url, method, body });
      if (method === 'GET') {
        return new Response(
          JSON.stringify({
            number: 418,
            title: 'Ship the registry',
            labels: [
              { name: 'story' },
              { name: 'Backlog' },
              { name: 'needs-triage' },
              { name: 'team:frontend' },
            ],
            html_url: 'https://github.com/acme/payments/issues/418',
            updated_at: '2026-09-04T11:19:57Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          number: 418,
          title: 'Ship the registry',
          labels: (body?.labels ?? []).map((name: string) => ({ name })),
          html_url: 'https://github.com/acme/payments/issues/418',
          updated_at: '2026-09-04T11:19:57Z',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const connector = githubConnector(CONNECTION);
    await connector.update('418', {
      kind: 'update',
      labels: ['story', 'In Progress', 'Points:3'],
      labelClaim: CLAIM,
    });

    // Backlog (claimed, no longer desired) is removed; the two triage labels
    // are kept; In Progress and Points:3 are added.
    const patch = requests.find((r) => r.method === 'PATCH')!;
    expect(patch.body!.labels).toEqual([
      'needs-triage',
      'team:frontend',
      'story',
      'In Progress',
      'Points:3',
    ]);
    // The GET is what supplied the current labels.
    expect(requests.some((r) => r.method === 'GET')).toBe(true);
  });

  it('sends labels as-is when the request carries no claim', async () => {
    const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      return new Response(JSON.stringify({ number: 418 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const connector = githubConnector(CONNECTION);
    await connector.update('418', { kind: 'update', labels: ['story'] });

    expect(requests).toHaveLength(1); // no GET — nothing to reconcile against
    expect(requests[0]!.body!.labels).toEqual(['story']);
  });
});

describe('githubConnector assignee failures (LP-308)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('names the user and the issue when the repository refuses the assignment', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ message: 'Validation Failed' }), { status: 422 }),
    );

    const connector = githubConnector(CONNECTION);
    await expect(
      connector.update('418', { kind: 'update', assignee: 'stranger' }),
    ).rejects.toThrow('Cannot assign "stranger" on issue #418');
  });

  it('names the user when a create fails to assign them', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ message: 'Validation Failed' }), { status: 422 }),
    );

    const connector = githubConnector(CONNECTION);
    await expect(
      connector.create({ kind: 'create', title: 'T', assignee: 'stranger' }),
    ).rejects.toThrow('Cannot assign "stranger" on the new issue');
  });

  it('passes a non-assignee failure through unchanged', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ message: 'boom' }), { status: 500 }),
    );

    const connector = githubConnector(CONNECTION);
    await expect(
      connector.update('418', { kind: 'update', title: 'T' }),
    ).rejects.toThrow('GitHub PATCH');
  });
});

// ---------------------------------------------------------------------------
// Connector label list/create (LP-308) — against the in-memory tracker
// ---------------------------------------------------------------------------

describe('githubConnector labels against the memory tracker (LP-308)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lists seeded labels and creates a missing one', async () => {
    const tracker = memoryConnector({ repo: 'acme/payments', labels: ['story', 'Backlog'] });
    vi.stubGlobal('fetch', tracker.fetch);

    const connector = githubConnector(CONNECTION);
    expect(await connector.listLabels!()).toEqual(['Backlog', 'story']);

    await connector.createLabel!('Points:3', 'aabbcc');
    expect(tracker.labels()).toEqual(['Backlog', 'Points:3', 'story']);
  });
});

// ---------------------------------------------------------------------------
// Project status field (LP-312)
// ---------------------------------------------------------------------------

const PROJECT_MAPPING = {
  ...FULL_MAPPING,
  fields: { status: 'Status' },
};

describe('describeRequest — Project status field (LP-312)', () => {
  const fields = {
    title: 'Ship the registry',
    body: 'One folder, one line.',
    type: 'user_story',
    status: 'in_progress',
    attributes: {},
  };

  it('carries the status label as the Project status value', () => {
    const { request } = describeRequest(
      { kind: 'update', localId: 'LP-9', remoteId: '42', fields: { ...fields, status: 'in_progress' } },
      PROJECT_MAPPING,
      ATTRS,
    );
    expect(request.projectStatus).toBe('In Progress');
  });

  it('omits the Project status when no status field is mapped', () => {
    const { request } = describeRequest(
      { kind: 'update', localId: 'LP-9', remoteId: '42', fields: { ...fields, status: 'in_progress' } },
      FULL_MAPPING,
      ATTRS,
    );
    expect(request.projectStatus).toBeUndefined();
  });
});

describe('fieldsFromRecord — Project status field (LP-312)', () => {
  it('recovers the status from the Project column', () => {
    const { patch, statusDiscrepancy } = fieldsFromRecord(
      { labels: ['story'], state: 'open', project_status: 'In Progress' },
      PROJECT_MAPPING,
      ATTRS,
    );
    expect(patch.status).toBe('in_progress');
    expect(statusDiscrepancy).toBeUndefined();
  });

  it('pulls a closed issue back as terminal even when the column was not moved (AC3)', () => {
    const { patch, statusDiscrepancy } = fieldsFromRecord(
      { labels: ['story'], state: 'closed', project_status: 'In Progress' },
      PROJECT_MAPPING,
      ATTRS,
    );
    expect(patch.status).toBe('done');
    expect(statusDiscrepancy).toEqual({
      column: 'In Progress',
      state: 'closed',
      took: 'issue',
      otherStatus: 'in_progress',
    });
  });

  it('lets the Project column win when the precedence says project (AC4)', () => {
    const { patch, statusDiscrepancy } = fieldsFromRecord(
      { labels: ['story'], state: 'closed', project_status: 'In Progress' },
      { ...PROJECT_MAPPING, status_precedence: 'project' },
      ATTRS,
    );
    expect(patch.status).toBe('in_progress');
    expect(statusDiscrepancy).toEqual({
      column: 'In Progress',
      state: 'closed',
      took: 'project',
      otherStatus: 'done',
    });
  });

  it('reports no discrepancy when the column and state agree', () => {
    const { patch, statusDiscrepancy } = fieldsFromRecord(
      { labels: ['story'], state: 'closed', project_status: 'Done' },
      PROJECT_MAPPING,
      ATTRS,
    );
    expect(patch.status).toBe('done');
    expect(statusDiscrepancy).toBeUndefined();
  });

  it('pulls a closed issue back as terminal even without a Project status field', () => {
    const { patch } = fieldsFromRecord(
      { labels: ['story', 'In Progress'], state: 'closed' },
      FULL_MAPPING,
      ATTRS,
    );
    expect(patch.status).toBe('done');
  });
});
