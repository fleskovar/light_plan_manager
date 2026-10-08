/**
 * LP-297 — retry, rate-limit waits and backoff over the `Connector` contract,
 * driven entirely offline with a scripted `fetch` and an injected `sleep` that
 * records delays instead of sleeping through them.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NonIdempotentWriteError,
  RemoteError,
  backoffDelay,
  isIdempotent,
  restConnector,
  withRetry,
  type HttpMethod,
  type Sleep,
} from '../src/remote/transport/index.js';

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

function recordingSleep(): { sleep: Sleep; delays: number[] } {
  const delays: number[] = [];
  const sleep: Sleep = async (ms) => {
    delays.push(ms);
  };
  return { sleep, delays };
}

function baseConnector(fetchImpl: typeof fetch) {
  return restConnector({ baseUrl: 'https://api.example.com', fetch: fetchImpl });
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('isIdempotent', () => {
  it('treats GET, PUT and DELETE as safe to re-send', () => {
    for (const method of ['GET', 'PUT', 'DELETE'] as const) {
      expect(isIdempotent({ method: method as HttpMethod, path: '/x' })).toBe(true);
    }
  });

  it('treats POST and PATCH as unsafe without a key', () => {
    expect(isIdempotent({ method: 'POST', path: '/x' })).toBe(false);
    expect(isIdempotent({ method: 'PATCH', path: '/x' })).toBe(false);
  });

  it('treats a write carrying an idempotency key as safe', () => {
    expect(isIdempotent({ method: 'POST', path: '/x', idempotencyKey: 'k-1' })).toBe(true);
    expect(isIdempotent({ method: 'POST', path: '/x', idempotencyKey: '' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// backoffDelay
// ---------------------------------------------------------------------------

describe('backoffDelay', () => {
  it('doubles per attempt and respects the cap', () => {
    expect(backoffDelay(1, 250, 10_000, 0)).toBe(250);
    expect(backoffDelay(2, 250, 10_000, 0)).toBe(500);
    expect(backoffDelay(3, 250, 10_000, 0)).toBe(1000);
    expect(backoffDelay(10, 250, 2000, 0)).toBe(2000); // capped
  });

  it('applies centred jitter around the raw delay', () => {
    // random() → 1 gives the top of the jitter range, → 0 the bottom, → 0.5 none.
    expect(backoffDelay(1, 250, 10_000, 0.5, () => 1)).toBe(375); // 250 + 125
    expect(backoffDelay(1, 250, 10_000, 0.5, () => 0)).toBe(125); // 250 - 125
    expect(backoffDelay(1, 250, 10_000, 0.5, () => 0.5)).toBe(250);
  });
});

// ---------------------------------------------------------------------------
// Retrying idempotent requests
// ---------------------------------------------------------------------------

describe('withRetry on idempotent requests', () => {
  it('retries a 5xx with exponential backoff, then succeeds', async () => {
    const { fetch, calls } = fetchWith(
      new Response('boom', { status: 500 }),
      jsonResponse({ ok: true }),
    );
    const { sleep, delays } = recordingSleep();
    const connector = withRetry(baseConnector(fetch), { sleep, jitter: 0, baseDelayMs: 250 });

    const response = await connector.request({ method: 'GET', path: '/x' });

    expect(response.body).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(delays).toEqual([250]);
  });

  it('gives up after the cap and surfaces the last failure', async () => {
    const { fetch, calls } = fetchWith(
      new Response('boom', { status: 500 }),
      new Response('boom', { status: 500 }),
      new Response('boom', { status: 500 }),
    );
    const { sleep, delays } = recordingSleep();
    const connector = withRetry(baseConnector(fetch), {
      sleep,
      jitter: 0,
      baseDelayMs: 250,
      maxAttempts: 3,
    });

    const error = await connector.request({ method: 'GET', path: '/x' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RemoteError);
    expect((error as RemoteError).retryable).toBe(true);
    expect(calls).toHaveLength(3);
    expect(delays).toEqual([250, 500]); // two waits, before attempts 2 and 3
  });

  it('retries a network blip', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return jsonResponse({ ok: true });
    };
    const { sleep, delays } = recordingSleep();
    const connector = withRetry(baseConnector(fetchImpl), { sleep, jitter: 0 });

    const response = await connector.request({ method: 'GET', path: '/x' });

    expect(response.body).toEqual({ ok: true });
    expect(delays).toEqual([250]);
  });

  it('does not retry a 4xx that is not a rate limit', async () => {
    const { fetch, calls } = fetchWith(jsonResponse({ message: 'Validation failed' }, 422));
    const { sleep, delays } = recordingSleep();
    const connector = withRetry(baseConnector(fetch), { sleep, jitter: 0 });

    const error = await connector.request({ method: 'GET', path: '/x' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RemoteError);
    expect((error as RemoteError).retryable).toBe(false);
    expect(calls).toHaveLength(1);
    expect(delays).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The dangerous case: non-idempotent writes
// ---------------------------------------------------------------------------

describe('withRetry on non-idempotent writes', () => {
  it('refuses to re-send a POST that failed with a 5xx, and says why', async () => {
    const { fetch, calls } = fetchWith(new Response('boom', { status: 500 }));
    const { sleep, delays } = recordingSleep();
    const connector = withRetry(baseConnector(fetch), { sleep, jitter: 0 });

    const error = await connector
      .request({ method: 'POST', path: '/issues', purpose: 'create issue', body: { title: 'x' } })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NonIdempotentWriteError);
    expect(error).toBeInstanceOf(RemoteError);
    expect((error as RemoteError).retryable).toBe(false);
    expect((error as RemoteError).message).toContain('not idempotent');
    expect((error as RemoteError).hints()).toContain(
      'the write may already have been applied — check the remote before re-running',
    );
    expect(calls).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it('re-sends a POST that carries an idempotency key, and sends the header', async () => {
    const { fetch, calls } = fetchWith(
      new Response('boom', { status: 500 }),
      jsonResponse({ number: 7 }),
    );
    const { sleep, delays } = recordingSleep();
    const connector = withRetry(baseConnector(fetch), { sleep, jitter: 0 });

    const response = await connector.request({
      method: 'POST',
      path: '/issues',
      idempotencyKey: 'k-1',
      body: { title: 'x' },
    });

    expect(response.body).toEqual({ number: 7 });
    expect(calls).toHaveLength(2);
    expect(delays).toEqual([250]);
    const sentHeaders = calls[0]!.init.headers as Record<string, string>;
    expect(sentHeaders['idempotency-key']).toBe('k-1');
  });

  it('still refuses a write whose key platform rejects (no retry on 422)', async () => {
    const { fetch, calls } = fetchWith(jsonResponse({ message: 'bad' }, 422));
    const { sleep, delays } = recordingSleep();
    const connector = withRetry(baseConnector(fetch), { sleep, jitter: 0 });

    const error = await connector
      .request({ method: 'POST', path: '/issues', idempotencyKey: 'k-1', body: {} })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RemoteError);
    expect(error).not.toBeInstanceOf(NonIdempotentWriteError);
    expect(calls).toHaveLength(1);
    expect(delays).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rate limits: wait out the reset, whatever the method
// ---------------------------------------------------------------------------

describe('withRetry on rate limits', () => {
  it('waits out a Retry-After reset then re-sends, even for a POST', async () => {
    const { fetch, calls } = fetchWith(
      new Response('rate limited', { status: 429, headers: { 'retry-after': '30' } }),
      jsonResponse({ number: 3 }),
    );
    const { sleep, delays } = recordingSleep();
    const waits: Array<{ reason: string; ms: number }> = [];
    const connector = withRetry(baseConnector(fetch), {
      sleep,
      jitter: 0,
      onWait: (wait) => waits.push({ reason: wait.reason, ms: wait.ms }),
    });

    const response = await connector.request({
      method: 'POST',
      path: '/issues',
      purpose: 'create issue',
      body: { title: 'x' },
    });

    expect(response.body).toEqual({ number: 3 });
    expect(calls).toHaveLength(2);
    expect(delays).toEqual([30_000]);
    expect(waits).toEqual([{ reason: 'rate_limit', ms: 30_000 }]);
  });

  it('reports a long wait through onWait but not a short backoff', async () => {
    const { fetch } = fetchWith(
      new Response('boom', { status: 500 }),
      new Response('rate limited', { status: 429, headers: { 'retry-after': '30' } }),
      jsonResponse({ ok: true }),
    );
    const { sleep } = recordingSleep();
    const waits: Array<{ reason: string; ms: number }> = [];
    const retries: number[] = [];
    const connector = withRetry(baseConnector(fetch), {
      sleep,
      jitter: 0,
      baseDelayMs: 250,
      onWait: (wait) => waits.push({ reason: wait.reason, ms: wait.ms }),
      onRetry: (attempt) => retries.push(attempt.attempt),
    });

    await connector.request({ method: 'GET', path: '/x' });

    // Two retries happened (attempt 1 for the 500, attempt 2 for the 429)…
    expect(retries).toEqual([1, 2]);
    // …but only the 30s rate-limit wait exceeded the "few seconds" threshold.
    expect(waits).toEqual([{ reason: 'rate_limit', ms: 30_000 }]);
  });

  it('uses the configured fallback when the transport gave no reset', async () => {
    const { fetch, calls } = fetchWith(
      new Response('limited', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
      jsonResponse({ ok: true }),
    );
    const { sleep, delays } = recordingSleep();
    const connector = withRetry(baseConnector(fetch), {
      sleep,
      jitter: 0,
      rateLimitWaitMs: 5_000,
    });

    const response = await connector.request({ method: 'GET', path: '/x' });

    expect(response.body).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(delays).toEqual([5_000]);
  });
});

// ---------------------------------------------------------------------------
// Pagination goes through the retry
// ---------------------------------------------------------------------------

describe('withRetry covers paginate', () => {
  it('retries each page of a paginated walk', async () => {
    const { fetch, calls } = fetchWith(
      new Response('boom', { status: 500 }),
      jsonResponse({ items: [1] }, 200, {
        link: '<https://api.example.com/x?page=2>; rel="next"',
      }),
      jsonResponse({ items: [2] }),
    );
    const { sleep, delays } = recordingSleep();
    const connector = withRetry(baseConnector(fetch), { sleep, jitter: 0, baseDelayMs: 250 });

    const pages: unknown[] = [];
    for await (const page of connector.paginate({
      method: 'GET',
      path: '/x',
      pagination: { kind: 'link' },
    })) {
      pages.push(page);
    }

    // First page failed once (500) then succeeded; second page succeeded.
    expect(pages).toEqual([{ items: [1] }, { items: [2] }]);
    expect(calls).toHaveLength(3);
    expect(delays).toEqual([250]);
  });
});
