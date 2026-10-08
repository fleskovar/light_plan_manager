/**
 * LP-329 — resolve Jira accounts without assuming email search is allowed.
 *
 * Jira addresses an assignee by `accountId`, never by email or name. On a
 * privacy-restricted (GDPR-mode) instance the user search returns nothing for
 * an email query, so a board whose roster carries only emails cannot assign
 * anyone. This story's answer is two `mapping.accounts.via` modes:
 *
 *   - `via: email`            — the resource attribute holds an email; the
 *                               connector resolves it to an account id through
 *                               Jira's user search, and an empty search is
 *                               refused as the privacy-mode signature with the
 *                               `jira_account_id` alternative named;
 *   - `via: jira_account_id`  — the attribute holds the account id itself; it
 *                               is written directly and no search is made.
 *
 * On pull, the translator matches the assignee's `emailAddress` under
 * `via: email` and its `accountId` under any other `via`, so a person on the
 * roster is restored and an assignee nobody matches is reported — never
 * auto-created. The connector and translator are driven offline through a
 * stubbed `fetch`, exactly like `test/remote-jira.test.ts`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoardError } from '../src/core/errors.js';
import type { Roster } from '../src/remote/accounts.js';
import { jiraConnector } from '../src/remote/providers/jira/connector.js';
import { describeRequest, fieldsFromRecord } from '../src/remote/providers/jira/translator.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const SITE = 'https://acme.atlassian.net';
const CONNECTION = { site: SITE, project: 'PAY', email: 'me@acme.com', token: 'api-token' };

// The roster is rebuilt per test so the fixture is the canonical shape.
function roster(): Roster {
  return new Map([
    [
      'RS-1',
      {
        id: 'RS-1',
        title: 'Frank',
        generic: false,
        attributes: { email: 'frank@acme.com', jira_account_id: '5frank5' },
      },
    ],
    [
      'RS-2',
      {
        id: 'RS-2',
        title: 'Grace',
        generic: false,
        attributes: { email: 'grace@acme.com' },
      },
    ],
  ]);
}

/** A `BoardError`'s message plus its hints, flattened. */
function messageOf(error: unknown): string {
  return error instanceof BoardError ? `${error.message}\n${error.details.join('\n')}` : String(error);
}

/** A fetch stub capturing every call and answering the three Jira endpoints. */
function stubFetch(users: Array<Record<string, unknown>> = []) {
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> | undefined }> = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined });

    if (url.includes('/rest/api/3/user/search')) {
      return new Response(JSON.stringify(users), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (method === 'POST' && url.endsWith('/rest/api/3/issue')) {
      return new Response(JSON.stringify({ id: '10042', key: 'PAY-418', self: `${SITE}/rest/api/3/issue/10042` }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({ id: '10042', key: 'PAY-418', fields: { updated: '2026-09-01T00:00:00Z' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
  return { calls, fetch };
}

// ---------------------------------------------------------------------------
// Push: the connector resolves the assignee and writes it as `{ id: accountId }`
// ---------------------------------------------------------------------------

describe('jiraConnector: account resolution on push (LP-329)', () => {
  it('resolves an email assignee through the user search and writes its account id', async () => {
    const { calls, fetch } = stubFetch([
      { accountId: '5frank5', emailAddress: 'frank@acme.com', displayName: 'Frank' },
    ]);
    vi.stubGlobal('fetch', fetch);

    const connector = jiraConnector(CONNECTION, { accounts: { via: 'email' } });
    await connector.create({ kind: 'create', type: 'Story', title: 'A story', assignee: 'frank@acme.com' });

    const search = calls.find((call) => call.url.includes('/rest/api/3/user/search'))!;
    expect(search).toBeDefined();
    expect(new URL(search.url).searchParams.get('query')).toBe('frank@acme.com');

    const create = calls.find((call) => call.method === 'POST' && call.url.endsWith('/rest/api/3/issue'))!;
    expect(create.body!['fields']).toMatchObject({ assignee: { id: '5frank5' } });
  });

  it('refuses an email the search cannot resolve, naming privacy mode and the jira_account_id alternative', async () => {
    const { fetch } = stubFetch([]); // an empty search is the GDPR-mode signature
    vi.stubGlobal('fetch', fetch);

    const connector = jiraConnector(CONNECTION, { accounts: { via: 'email' } });
    const message = await (async () => {
      try {
        await connector.create({ kind: 'create', type: 'Story', title: 'A story', assignee: 'frank@acme.com' });
        return null;
      } catch (error) {
        return messageOf(error);
      }
    })();

    expect(message).toContain('privacy-restricted');
    expect(message).toContain('jira_account_id');
    // The refusal must never read as "this user does not exist".
    expect(message).not.toContain('user not found');
  });

  it('writes the account id directly under via: jira_account_id, making no search', async () => {
    const { calls, fetch } = stubFetch();
    vi.stubGlobal('fetch', fetch);

    const connector = jiraConnector(CONNECTION, { accounts: { via: 'jira_account_id' } });
    await connector.create({ kind: 'create', type: 'Story', title: 'A story', assignee: '5frank5' });

    expect(calls.some((call) => call.url.includes('/rest/api/3/user/search'))).toBe(false);
    const create = calls.find((call) => call.method === 'POST' && call.url.endsWith('/rest/api/3/issue'))!;
    expect(create.body!['fields']).toMatchObject({ assignee: { id: '5frank5' } });
  });

  it('writes assignee: null to unassign, and omits the field when the op carries none', async () => {
    const { calls, fetch } = stubFetch();
    vi.stubGlobal('fetch', fetch);

    const connector = jiraConnector(CONNECTION, { accounts: { via: 'jira_account_id' } });
    await connector.update('10042', { kind: 'update', type: 'Story', title: 'A story', assignee: null });
    await connector.update('10042', { kind: 'update', type: 'Story', title: 'A story' });

    const puts = calls.filter((call) => call.method === 'PUT' && call.url.includes('/rest/api/3/issue/'));
    expect(puts).toHaveLength(2);
    expect(puts[0]!.body!['fields']).toMatchObject({ assignee: null });
    expect(puts[1]!.body!['fields']).not.toHaveProperty('assignee');
  });
});

// ---------------------------------------------------------------------------
// Push: the translator resolves the `via` attribute into the request value
// ---------------------------------------------------------------------------

describe('jiraTranslator: account resolution on push (LP-329)', () => {
  const MAPPING = { types: { user_story: { remote: 'Story' } }, statuses: {} };

  it('carries the email attribute value as the assignee for the connector to resolve', () => {
    const { request, resourceGaps } = describeRequest(
      { kind: 'create', localId: 'LP-1', fields: { type: 'user_story', status: 'backlog', assignee: 'RS-1' } },
      { ...MAPPING, accounts: { via: 'email' } },
      {},
      roster(),
    );
    expect(request.assignee).toBe('frank@acme.com');
    expect(resourceGaps).toEqual([]);
  });

  it('carries the account id attribute value directly under via: jira_account_id', () => {
    const { request } = describeRequest(
      { kind: 'create', localId: 'LP-1', fields: { type: 'user_story', status: 'backlog', assignee: 'RS-1' } },
      { ...MAPPING, accounts: { via: 'jira_account_id' } },
      {},
      roster(),
    );
    expect(request.assignee).toBe('5frank5');
  });
});

// ---------------------------------------------------------------------------
// Pull: the translator restores the person, or reports an assignee never invents
// ---------------------------------------------------------------------------

describe('jiraTranslator: account resolution on pull (LP-329)', () => {
  it('restores the person whose email matches the assignee under via: email', () => {
    const { patch, unknownAccounts } = fieldsFromRecord(
      { fields: { assignee: { accountId: '5frank5', emailAddress: 'frank@acme.com' } } },
      { accounts: { via: 'email' } },
      {},
      roster(),
    );
    expect(patch.assignee).toBe('RS-1');
    expect(unknownAccounts).toEqual([]);
  });

  it('restores the person whose account id matches under via: jira_account_id', () => {
    const { patch } = fieldsFromRecord(
      { fields: { assignee: { accountId: '5frank5', emailAddress: 'frank@acme.com' } } },
      { accounts: { via: 'jira_account_id' } },
      {},
      roster(),
    );
    expect(patch.assignee).toBe('RS-1');
  });

  it('reports an assignee nobody on the roster matches, never inventing one', () => {
    const { patch, unknownAccounts } = fieldsFromRecord(
      { fields: { assignee: { accountId: 'stranger', emailAddress: 'stranger@acme.com' } } },
      { accounts: { via: 'jira_account_id' } },
      {},
      roster(),
    );
    expect(patch.assignee).toBeUndefined();
    expect(unknownAccounts).toEqual([
      { account: 'stranger', suggestion: 'lpm new person --set jira_account_id="stranger"' },
    ]);
  });

  it('treats a record with no assignee as explicitly unassigned', () => {
    const { patch } = fieldsFromRecord(
      { fields: {} },
      { accounts: { via: 'jira_account_id' } },
      {},
      roster(),
    );
    expect(patch.assignee).toBeNull();
  });
});
