import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPeriod } from '../src/core/index.js';
import { preflightPush } from '../src/remote/preflight.js';
import { findProvider } from '../src/remote/registry.js';
import type { OpenedRemote } from '../src/remote/remotes.js';
import { githubConnector } from '../src/remote/providers/github/connector.js';
import {
  describeRequest,
  fieldsFromRecord,
} from '../src/remote/providers/github/translator.js';
import {
  planProjectIterationWrite,
  setProjectIteration,
} from '../src/remote/providers/github/project-iteration.js';
import type { ProjectGraphqlConnector, ProjectIds } from '../src/remote/providers/github/projects.js';
import type { AttributeDefs, RemoteRecord } from '../src/remote/provider.js';
import type { PeriodIndex } from '../src/remote/periods.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterEach(() => vi.unstubAllGlobals());
afterEach(cleanupBoards);

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const PERIODS: PeriodIndex = new Map([
  ['TL-1', { id: 'TL-1', title: 'PI-1', type: 'increment', parentId: null }],
  ['TL-2', { id: 'TL-2', title: 'Sprint 1', type: 'sprint', parentId: 'TL-1', starts: '2026-01-01', ends: '2026-01-14' }],
]);

const MAPPING = {
  types: { user_story: { remote: 'story' } },
  statuses: { in_progress: { remote: ['In Progress'], closed: false } },
  attributes: {},
};

const ATTRS: AttributeDefs = {};

const fields = { title: 'Ship it', body: 'One line.', type: 'user_story', status: 'in_progress', attributes: {} };

// ---------------------------------------------------------------------------
// Connector: the milestone carrier (AC1)
// ---------------------------------------------------------------------------

describe('githubConnector milestone carrier (LP-313)', () => {
  /** Stub `fetch`, routing by method + path, recording every request. */
  function stubFetch(routes: Record<string, { status: number; body?: unknown }>) {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      requests.push({ url, method, body });
      const key = `${method} ${url.split('?')[0]}`;
      const answer = routes[key];
      if (!answer) {
        return new Response(JSON.stringify({ message: `no route for ${key}` }), { status: 404 });
      }
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
    title: 'Ship it',
    body: 'One line.',
    html_url: 'https://github.com/acme/payments/issues/418',
    updated_at: '2026-09-04T11:19:57Z',
    labels: [{ name: 'story' }],
  };

  it('resolves the milestone by name and sets it on create', async () => {
    const requests = stubFetch({
      'GET https://api.github.com/repos/acme/payments/milestones': {
        status: 200,
        body: [{ number: 5, title: 'Sprint 1', due_on: '2026-01-14T00:00:00Z' }],
      },
      'POST https://api.github.com/repos/acme/payments/issues': { status: 201, body: ISSUE },
    });

    const connector = githubConnector({ repo: 'acme/payments' });
    await connector.create({
      kind: 'create',
      title: 'Ship it',
      body: 'One line.',
      labels: ['story'],
      period: { name: 'Sprint 1', ends: '2026-01-14' },
    });

    const post = requests.find((r) => r.method === 'POST' && r.url.includes('/issues'))!;
    expect(post.body).toMatchObject({ milestone: 5 });
    // No milestone was created — the existing one was reused.
    expect(requests.some((r) => r.url.includes('/milestones') && r.method === 'POST')).toBe(false);
  });

  it('provisions a missing milestone with its due date, then sets it', async () => {
    const requests = stubFetch({
      'GET https://api.github.com/repos/acme/payments/milestones': { status: 200, body: [] },
      'POST https://api.github.com/repos/acme/payments/milestones': {
        status: 201,
        body: { number: 9, title: 'Sprint 1', due_on: '2026-01-14T00:00:00Z' },
      },
      'POST https://api.github.com/repos/acme/payments/issues': { status: 201, body: ISSUE },
    });

    const connector = githubConnector({ repo: 'acme/payments' });
    await connector.create({
      kind: 'create',
      title: 'Ship it',
      labels: ['story'],
      period: { name: 'Sprint 1', ends: '2026-01-14' },
    });

    const milestonePost = requests.find((r) => r.url.includes('/milestones') && r.method === 'POST')!;
    expect(milestonePost.body).toEqual({ title: 'Sprint 1', due_on: '2026-01-14' });
    const issuePost = requests.find((r) => r.url.includes('/issues') && r.method === 'POST')!;
    expect(issuePost.body).toMatchObject({ milestone: 9 });
  });

  it('clears the milestone when the period is null', async () => {
    const requests = stubFetch({
      'PATCH https://api.github.com/repos/acme/payments/issues/418': { status: 200, body: ISSUE },
    });

    const connector = githubConnector({ repo: 'acme/payments' });
    await connector.update('418', { kind: 'update', period: null });

    const patch = requests.find((r) => r.method === 'PATCH')!;
    expect(patch.body).toMatchObject({ milestone: null });
  });

  it('leaves the milestone untouched when the request carries no period', async () => {
    const requests = stubFetch({
      'PATCH https://api.github.com/repos/acme/payments/issues/418': { status: 200, body: ISSUE },
    });

    const connector = githubConnector({ repo: 'acme/payments' });
    await connector.update('418', { kind: 'update', title: 'Renamed' });

    const patch = requests.find((r) => r.method === 'PATCH')!;
    expect(patch.body).not.toHaveProperty('milestone');
  });
});

// ---------------------------------------------------------------------------
// Translator: the iteration carrier (AC2 / AC4)
// ---------------------------------------------------------------------------

const ITERATION_MAPPING = {
  ...MAPPING,
  fields: { period: 'Sprint' },
  periods: { container: 'sprint', carrier: 'iteration' },
};

describe('describeRequest / fieldsFromRecord — iteration carrier (LP-313)', () => {
  it('carries the period as the container and the increment as a degraded level', () => {
    const { request } = describeRequest(
      { kind: 'create', localId: 'LP-9', fields: { ...fields, period: 'TL-2' } },
      ITERATION_MAPPING,
      ATTRS,
      new Map(),
      PERIODS,
    );
    expect(request.period).toEqual({ name: 'Sprint 1', starts: '2026-01-01', ends: '2026-01-14' });
    expect(request.degradedPeriods).toEqual([{ type: 'increment', name: 'PI-1' }]);
  });

  it('recovers the period from the iteration title', () => {
    const record: RemoteRecord = { labels: [{ name: 'story' }], project_iteration: 'Sprint 1' };
    const { patch, period } = fieldsFromRecord(record, ITERATION_MAPPING, ATTRS, new Map(), PERIODS);
    expect(patch.period).toBe('TL-2');
    expect(period).toMatchObject({ periodId: 'TL-2' });
  });

  it('reports an iteration title matching no local period, never inventing one', () => {
    const record: RemoteRecord = { labels: [{ name: 'story' }], project_iteration: 'Sprint 99' };
    const { patch, period } = fieldsFromRecord(record, ITERATION_MAPPING, ATTRS, new Map(), PERIODS);
    expect(patch.period).toBeUndefined();
    expect(period?.unresolved).toBe('unmapped');
    expect(period?.missing?.containerName).toBe('Sprint 99');
  });

  it('reads the milestone (not the iteration) when the carrier is milestones', () => {
    const milestoneRecord: RemoteRecord = {
      labels: [{ name: 'story' }],
      project_iteration: 'Sprint 99',
      milestone: { title: 'Sprint 1', due_on: '2026-01-14' },
    };
    const { patch } = fieldsFromRecord(
      milestoneRecord,
      { ...MAPPING, periods: { container: 'sprint' } },
      ATTRS,
      new Map(),
      PERIODS,
    );
    expect(patch.period).toBe('TL-2');
  });
});

// ---------------------------------------------------------------------------
// Project iteration write (AC2)
// ---------------------------------------------------------------------------

const IDS: ProjectIds = {
  project: { id: 'PVT_1', number: 7, title: 'Payments Board' },
  fields: {
    Sprint: {
      id: 'PVTF_sprint',
      name: 'Sprint',
      type: 'ITERATION',
      options: {},
      iterations: [
        { id: 'ITER_1', title: 'Sprint 1', startDate: '2026-01-01', duration: 14 },
        { id: 'ITER_2', title: 'Sprint 2', startDate: '2026-01-15', duration: 14 },
      ],
    },
  },
};

describe('planProjectIterationWrite', () => {
  it('resolves the iteration id by title', () => {
    expect(planProjectIterationWrite(IDS, 'Sprint', 'Sprint 2')).toEqual({
      field: 'Sprint',
      title: 'Sprint 2',
      iterationId: 'ITER_2',
      missingIteration: false,
    });
  });

  it('reports a title with no iteration', () => {
    expect(planProjectIterationWrite(IDS, 'Sprint', 'Sprint 99')).toEqual({
      field: 'Sprint',
      title: 'Sprint 99',
      missingIteration: true,
    });
  });
});

describe('setProjectIteration', () => {
  it('adds the issue to the Project and writes the iteration value', async () => {
    const calls: Array<{ query: string; variables?: Record<string, unknown> }> = [];
    const connector: ProjectGraphqlConnector = {
      name: 'github',
      async graphql(query: string, variables: Record<string, unknown> = {}) {
        calls.push({ query, variables });
        // findProjectItemId → no item; addProjectItem → an item id; the write → ok.
        if (query.includes('projectItems')) {
          return { data: { node: { projectItems: { nodes: [] } } } };
        }
        if (query.includes('addProjectV2ItemById')) {
          return { data: { addProjectV2ItemById: { item: { id: 'PVTI_1' } } } };
        }
        return { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_1' } } } };
      },
    };

    await setProjectIteration(connector, IDS, 'Sprint', 'I_kwDOBm4S5s5', 'Sprint 1');

    const write = calls.find((c) => c.query.includes('updateProjectV2ItemFieldValue'))!;
    expect(write.variables).toEqual({
      input: {
        projectId: 'PVT_1',
        itemId: 'PVTI_1',
        fieldId: 'PVTF_sprint',
        value: { iterationId: 'ITER_1' },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Preflight: iteration fixed-duration detection (the note)
// ---------------------------------------------------------------------------

function iterationRemote(): OpenedRemote {
  return {
    name: 'upstream',
    provider: findProvider('github')!,
    direction: 'both',
    on_delete: 'unlink',
    conflict: 'manual',
    fields: {},
    encoding: 'block',
    comments: 'push',
    connection: { repo: 'acme/payments' },
    mapping: {
      types: { user_story: { remote: 'story' } },
      statuses: {
        backlog: { remote: ['Backlog'], closed: false },
        done: { remote: ['Done'], closed: true },
      },
      attributes: {},
      periods: { container: 'sprint', carrier: 'iteration' },
      fields: { period: 'Sprint' },
    },
  };
}

describe('preflightPush — irregular sprints vs iteration fields (LP-313)', () => {
  it('warns when the mapped periods vary in length', () => {
    const paths = makeBoard('scrum', 'LP');
    const inc = createPeriod(reload(paths), {
      type: 'increment',
      title: 'PI-1',
      starts: '2026-01-01',
      ends: '2026-03-31',
    });
    createPeriod(reload(paths), {
      type: 'sprint',
      title: 'Sprint 1',
      starts: '2026-01-01',
      ends: '2026-01-14',
      parentId: inc.id,
    });
    createPeriod(reload(paths), {
      type: 'sprint',
      title: 'Sprint 2',
      starts: '2026-01-15',
      ends: '2026-02-04',
      parentId: inc.id,
    });

    const problems = preflightPush(reload(paths), iterationRemote());
    const warning = problems.find((p) => p.message.includes('vary in length'));
    expect(warning).toBeDefined();
    expect(warning!.message).toContain('13, 20 days');
  });

  it('is silent when the mapped periods share one duration', () => {
    const paths = makeBoard('scrum', 'LP');
    const inc = createPeriod(reload(paths), {
      type: 'increment',
      title: 'PI-1',
      starts: '2026-01-01',
      ends: '2026-03-31',
    });
    createPeriod(reload(paths), {
      type: 'sprint',
      title: 'Sprint 1',
      starts: '2026-01-01',
      ends: '2026-01-14',
      parentId: inc.id,
    });
    createPeriod(reload(paths), {
      type: 'sprint',
      title: 'Sprint 2',
      starts: '2026-01-15',
      ends: '2026-01-28',
      parentId: inc.id,
    });

    const problems = preflightPush(reload(paths), iterationRemote());
    expect(problems.find((p) => p.message.includes('vary in length'))).toBeUndefined();
  });
});
