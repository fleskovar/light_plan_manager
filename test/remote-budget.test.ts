/**
 * LP-297 — the request budget: stops a runaway sync before it exhausts a
 * shared token, and accounts for GraphQL point costs rather than just request
 * counts. Driven offline with a scripted `fetch`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BudgetExhaustedError,
  costOfResponse,
  graphqlConnector,
  restConnector,
  withBudget,
  withRetry,
  type BudgetSpend,
  type Sleep,
} from '../src/remote/transport/index.js';
import { toBoardError } from '../src/remote/transport-error.js';

afterEach(() => {
  vi.restoreAllMocks();
});

interface FetchCall {
  url: string;
  init: RequestInit;
}

function fetchWith(...responses: Response[]): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let index = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init ?? {} });
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return response!.clone();
  };
  return { fetch: fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function noSleep(): Sleep {
  return async () => {};
}

// ---------------------------------------------------------------------------
// costOfResponse
// ---------------------------------------------------------------------------

describe('costOfResponse', () => {
  it('reads the GraphQL point cost when the connector is GraphQL', () => {
    expect(costOfResponse('graphql', { 'x-ratelimit-cost': '50' })).toBe(50);
    expect(costOfResponse('graphql', {})).toBe(1);
  });

  it('counts one request per call for REST and process, whatever the headers', () => {
    expect(costOfResponse('rest', { 'x-ratelimit-cost': '50' })).toBe(1);
    expect(costOfResponse('process', { 'x-ratelimit-cost': '50' })).toBe(1);
    expect(costOfResponse('memory', {})).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------------

describe('withBudget', () => {
  it('lets requests through until the limit, then refuses with how far it got', async () => {
    const { fetch, calls } = fetchWith(jsonResponse({ ok: true }));
    const spends: BudgetSpend[] = [];
    const connector = withBudget(
      restConnector({ baseUrl: 'https://api.example.com', fetch }),
      { limit: 2, onSpend: (spend) => spends.push(spend) },
    );

    await connector.request({ method: 'GET', path: '/a' });
    await connector.request({ method: 'GET', path: '/b' });
    const error = await connector.request({ method: 'GET', path: '/c' }).catch((e: unknown) => e);

    expect(calls).toHaveLength(2); // the third request never reached fetch
    expect(error).toBeInstanceOf(BudgetExhaustedError);
    expect((error as BudgetExhaustedError).consumed).toBe(2);
    expect((error as BudgetExhaustedError).limit).toBe(2);
    expect((error as BudgetExhaustedError).message).toContain('2 of 2');
    expect(spends.map((s) => s.consumed)).toEqual([1, 2]);
  });

  it('accounts for GraphQL point costs, not request counts', async () => {
    const { fetch, calls } = fetchWith(
      jsonResponse({ data: {} }, 200, { 'x-ratelimit-cost': '50' }),
      jsonResponse({ data: {} }, 200, { 'x-ratelimit-cost': '50' }),
    );
    const connector = withBudget(
      graphqlConnector({ baseUrl: 'https://api.example.com/graphql', fetch }),
      { limit: 100 },
    );

    await connector.request({ method: 'POST', path: '/graphql', body: { query: '{ viewer { login } }' } });
    await connector.request({ method: 'POST', path: '/graphql', body: { query: '{ viewer { login } }' } });
    const error = await connector
      .request({ method: 'POST', path: '/graphql', body: { query: '{ viewer { login } }' } })
      .catch((e: unknown) => e);

    expect(calls).toHaveLength(2); // 100 points of budget bought two 50-point queries
    expect((error as BudgetExhaustedError).consumed).toBe(100);
  });

  it('allows one request whose cost exceeds what is left, then refuses the next', async () => {
    const { fetch, calls } = fetchWith(
      jsonResponse({ data: {} }, 200, { 'x-ratelimit-cost': '100' }),
    );
    const connector = withBudget(
      graphqlConnector({ baseUrl: 'https://api.example.com/graphql', fetch }),
      { limit: 50 },
    );

    await connector.request({ method: 'POST', path: '/graphql', body: { query: '{ viewer { login } }' } });
    const error = await connector
      .request({ method: 'POST', path: '/graphql', body: { query: '{ viewer { login } }' } })
      .catch((e: unknown) => e);

    expect(calls).toHaveLength(1);
    expect((error as BudgetExhaustedError).consumed).toBe(100);
    expect((error as BudgetExhaustedError).limit).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Composition: retry outside budget, so each attempt is charged
// ---------------------------------------------------------------------------

describe('withRetry(withBudget(…))', () => {
  it('does not retry a budget exhaustion (it is not a RemoteError)', async () => {
    const { fetch, calls } = fetchWith(jsonResponse({ ok: true }));
    const { sleep } = { sleep: noSleep() };
    const connector = withRetry(
      withBudget(restConnector({ baseUrl: 'https://api.example.com', fetch }), { limit: 0 }),
      { sleep },
    );

    const error = await connector.request({ method: 'GET', path: '/x' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BudgetExhaustedError);
    expect(calls).toHaveLength(0);
  });

  it('charges each successful attempt of a retried request', async () => {
    const { fetch, calls } = fetchWith(
      new Response('boom', { status: 500 }),
      jsonResponse({ ok: true }),
    );
    const spends: BudgetSpend[] = [];
    const connector = withRetry(
      withBudget(restConnector({ baseUrl: 'https://api.example.com', fetch }), {
        limit: 5,
        onSpend: (spend) => spends.push(spend),
      }),
      { sleep: noSleep(), jitter: 0 },
    );

    await connector.request({ method: 'GET', path: '/x' });

    expect(calls).toHaveLength(2);
    // The failed attempt is not charged; the one success is.
    expect(spends.map((s) => s.consumed)).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// The BoardError seam understands the budget error
// ---------------------------------------------------------------------------

describe('toBoardError wraps a BudgetExhaustedError', () => {
  it('carries the headline and the "how far" hint', () => {
    const error = new BudgetExhaustedError(47, 50, 'push issues');
    const board = toBoardError(error, 'github');
    expect(board.message).toBe(
      'remote "github": request budget exhausted while push issues: 47 of 50 units already spent',
    );
    expect(board.details).toEqual([
      '47 of 50 request units were spent before the budget stopped the sync',
    ]);
  });
});
