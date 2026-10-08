/**
 * LP-326 — status changes are workflow transitions.
 *
 * The Jira connector does not *set* a status; it executes a transition, and
 * the transitions available depend on where the issue currently stands, on the
 * workflow, and on the acting user's permissions. This file asserts the story's
 * acceptance criteria, offline (global `fetch` stubbed, no tokens):
 *
 *   - a status change fetches the available transitions and executes the one
 *     reaching the target;
 *   - with no single hop, a path is computed from the workflow and executed
 *     only behind `transitions.multi_hop` — otherwise refused with the path;
 *   - a transition screen's required fields come from `transition_fields`, or
 *     the refusal names the fields;
 *   - an unreachable target lists the statuses that *are* reachable;
 *   - a permission failure is distinguished from a workflow failure.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoardError } from '../src/core/errors.js';
import { jiraConfigSchema } from '../src/remote/providers/jira/config.js';
import { jiraConnector } from '../src/remote/providers/jira/connector.js';
import { redactor } from '../src/remote/redact.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  redactor.clear();
});

const SITE = 'https://acme.atlassian.net';
const CONNECTION = { site: SITE, project: 'PAY', email: 'me@acme.com', token: 'api-token' };

function connection(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...CONNECTION, ...extra };
}

function messageOf(error: unknown): string {
  return error instanceof BoardError ? `${error.message}\n${error.details.join('\n')}` : String(error);
}

/** The issue `getIssue` returns: status, project id and issue type id. */
function issueRecord(status: string): Record<string, unknown> {
  return {
    id: '10042',
    key: 'PAY-1',
    fields: {
      updated: '2026-09-01T00:00:00Z',
      status: { id: '1', name: status },
      project: { id: '10001' },
      issuetype: { id: '10002' },
    },
  };
}

/** The workflow graph `readWorkflows` returns: Backlog → In Progress → Done. */
const WORKFLOW = {
  statuses: [
    { statusReference: 'SR-1', name: 'Backlog' },
    { statusReference: 'SR-2', name: 'In Progress' },
    { statusReference: 'SR-3', name: 'Done' },
  ],
  workflows: [
    {
      transitions: [
        { toStatusReference: 'SR-2', links: [{ fromStatusReference: 'SR-1' }] },
        { toStatusReference: 'SR-3', links: [{ fromStatusReference: 'SR-2' }] },
      ],
    },
  ],
};

/**
 * Stub `fetch` for the transition flow. `transitions` is the list (or a
 * function of the read number) each `getTransitions` returns; `workflow` /
 * `workflowStatus` answer `readWorkflows`; `issue` answers `getIssue`; and
 * every `doTransition` body is pushed onto `transitionBodies`.
 */
function stubTransitionFlow(opts: {
  transitions: Array<Record<string, unknown>> | ((read: number) => Array<Record<string, unknown>>);
  workflow?: Record<string, unknown>;
  workflowStatus?: number;
  issue?: Record<string, unknown>;
}): { transitionBodies: Array<Record<string, unknown>>; urls: string[] } {
  const transitionBodies: Array<Record<string, unknown>> = [];
  const urls: string[] = [];
  let reads = 0;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    urls.push(url);
    const body =
      init?.body && typeof init.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};

    if (method === 'GET' && /\/issue\/PAY-1\/transitions/.test(url)) {
      reads += 1;
      const transitions = typeof opts.transitions === 'function' ? opts.transitions(reads) : opts.transitions;
      return new Response(JSON.stringify({ transitions }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (method === 'POST' && /\/issue\/PAY-1\/transitions$/.test(url)) {
      transitionBodies.push(body);
      return new Response(null, { status: 204 });
    }
    if (method === 'GET' && /\/issue\/PAY-1(\?|$)/.test(url)) {
      return new Response(JSON.stringify(opts.issue ?? issueRecord('Backlog')), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (method === 'POST' && /\/workflows$/.test(url)) {
      return new Response(JSON.stringify(opts.workflow ?? WORKFLOW), {
        status: opts.workflowStatus ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  return { transitionBodies, urls };
}

describe('jiraConfigSchema: transition configuration (LP-326)', () => {
  it('accepts transitions.multi_hop and transition_fields', () => {
    const result = jiraConfigSchema.safeParse({
      connection: { site: SITE, project: 'PAY' },
      mapping: {
        transitions: { multi_hop: true },
        transition_fields: { resolution: 'Done' },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mapping.transitions).toEqual({ multi_hop: true });
      expect(result.data.mapping.transition_fields).toEqual({ resolution: 'Done' });
    }
  });

  it('defaults transitions and transition_fields to off/empty', () => {
    const result = jiraConfigSchema.safeParse({
      connection: { site: SITE, project: 'PAY' },
      mapping: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mapping.transitions).toEqual({});
      expect(result.data.mapping.transition_fields).toEqual({});
    }
  });
});

describe('jiraConnector: status changes are workflow transitions (LP-326)', () => {
  it('executes the single transition reaching the target', async () => {
    const flow = stubTransitionFlow({
      transitions: [{ id: '11', name: 'Start Progress', to: { id: '3', name: 'In Progress' } }],
    });

    const connector = jiraConnector(connection(), { transitions: {}, transition_fields: {} });
    await connector.update('PAY-1', { kind: 'update', state: 'In Progress' });

    expect(flow.transitionBodies).toEqual([{ transition: { id: '11' } }]);
    expect(
      flow.urls.some((url) => url.includes('transitions') && url.includes('expand=transitions.fields')),
    ).toBe(true);
  });

  it('satisfies a transition screen field from transition_fields', async () => {
    const flow = stubTransitionFlow({
      transitions: [
        {
          id: '21',
          name: 'Done',
          to: { id: '5', name: 'Done' },
          fields: { resolution: { required: true, name: 'Resolution' } },
        },
      ],
    });

    const connector = jiraConnector(connection(), { transition_fields: { resolution: 'Done' } });
    await connector.update('PAY-1', { kind: 'update', state: 'Done' });

    expect(flow.transitionBodies).toEqual([{ transition: { id: '21' }, fields: { resolution: 'Done' } }]);
  });

  it('refuses a transition whose required field config does not answer, naming the field', async () => {
    stubTransitionFlow({
      transitions: [
        {
          id: '21',
          name: 'Done',
          to: { id: '5', name: 'Done' },
          fields: { resolution: { required: true, name: 'Resolution' } },
        },
      ],
    });

    const connector = jiraConnector(connection(), { transition_fields: {} });
    const error = await (async () => {
      try {
        await connector.update('PAY-1', { kind: 'update', state: 'Done' });
        return null;
      } catch (err) {
        return err as BoardError;
      }
    })();

    const message = messageOf(error);
    expect(message).toContain('requires field resolution (Resolution)');
    expect(message).toContain('mapping.transition_fields.resolution');
    expect(message).not.toContain('Jira rejected the request'); // a workflow refusal, not a transport failure
  });

  it('computes a multi-hop path and refuses with it when multi_hop is off', async () => {
    const flow = stubTransitionFlow({
      transitions: [{ id: '11', name: 'Start Progress', to: { id: '3', name: 'In Progress' } }],
      issue: issueRecord('Backlog'),
    });

    const connector = jiraConnector(connection(), { transitions: {} });
    const error = await (async () => {
      try {
        await connector.update('PAY-1', { kind: 'update', state: 'Done' });
        return null;
      } catch (err) {
        return err as BoardError;
      }
    })();

    const message = messageOf(error);
    expect(message).toContain('needs 2 transitions');
    expect(message).toContain('Backlog → In Progress → Done');
    expect(message).toContain('mapping.transitions.multi_hop: true');
    expect(flow.transitionBodies).toEqual([]); // nothing executed
  });

  it('executes the path in order when multi_hop is enabled', async () => {
    // Read 1 (initial): only In Progress is available — no direct hop to Done.
    // Reads 2 and 3: the issue has moved, so Done is the next available hop.
    const flow = stubTransitionFlow({
      transitions: (read) =>
        read === 1
          ? [{ id: '11', name: 'Start Progress', to: { id: '3', name: 'In Progress' } }]
          : [{ id: '21', name: 'Done', to: { id: '5', name: 'Done' } }],
      issue: issueRecord('Backlog'),
    });

    const connector = jiraConnector(connection(), { transitions: { multi_hop: true } });
    await connector.update('PAY-1', { kind: 'update', state: 'Done' });

    expect(flow.transitionBodies).toEqual([{ transition: { id: '11' } }, { transition: { id: '21' } }]);
  });

  it('lists the reachable statuses when the target has no path', async () => {
    stubTransitionFlow({
      transitions: [{ id: '11', name: 'Start Progress', to: { id: '3', name: 'In Progress' } }],
      issue: issueRecord('Backlog'),
      workflow: {
        statuses: [
          { statusReference: 'SR-1', name: 'Backlog' },
          { statusReference: 'SR-2', name: 'In Progress' },
        ],
        workflows: [
          { transitions: [{ toStatusReference: 'SR-2', links: [{ fromStatusReference: 'SR-1' }] }] },
        ],
      },
    });

    const connector = jiraConnector(connection(), { transitions: { multi_hop: true } });
    const error = await (async () => {
      try {
        await connector.update('PAY-1', { kind: 'update', state: 'Done' });
        return null;
      } catch (err) {
        return err as BoardError;
      }
    })();

    const message = messageOf(error);
    expect(message).toContain('Cannot move PAY-1 to "Done"');
    expect(message).toContain('reachable statuses: In Progress');
  });

  it('distinguishes a workflow-read permission failure from a workflow failure', async () => {
    stubTransitionFlow({
      transitions: [{ id: '11', name: 'Start Progress', to: { id: '3', name: 'In Progress' } }],
      issue: issueRecord('Backlog'),
      workflowStatus: 403,
    });

    const connector = jiraConnector(connection(), { transitions: { multi_hop: true } });
    const error = await (async () => {
      try {
        await connector.update('PAY-1', { kind: 'update', state: 'Done' });
        return null;
      } catch (err) {
        return err as BoardError;
      }
    })();

    const message = messageOf(error);
    expect(message).toContain('cannot read the workflow');
    expect(message).toContain('reachable in one hop: In Progress');
    expect(message).toContain('View workflow');
    expect(message).not.toContain('reachable statuses:'); // one-hop list, not a graph reachability claim
  });

  it('distinguishes a transition permission failure (403) from a workflow failure', async () => {
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'GET' && /\/transitions/.test(url)) {
        return new Response(
          JSON.stringify({ transitions: [{ id: '11', name: 'Start Progress', to: { id: '3', name: 'In Progress' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      // The transition POST itself is refused — the token can see but not move.
      return new Response(
        JSON.stringify({ errorMessages: ['You do not have permission to transition this issue.'] }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const connector = jiraConnector(connection(), {});
    const error = await (async () => {
      try {
        await connector.update('PAY-1', { kind: 'update', state: 'In Progress' });
        return null;
      } catch (err) {
        return err as BoardError;
      }
    })();

    const message = messageOf(error);
    expect(message).toContain('permission denied');
    expect(message).not.toContain('Cannot move PAY-1'); // not a workflow refusal
  });
});
