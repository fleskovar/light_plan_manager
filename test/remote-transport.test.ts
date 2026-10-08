/**
 * LP-293 / LP-294 — the `Connector` contract and its three implementations,
 * driven entirely offline: a fake `fetch` for REST and GraphQL, a fake runner
 * for `gh`. No tokens, no network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoardError } from '../src/core/errors.js';
import { toBoardError } from '../src/remote/transport-error.js';
import type { Connector, ProcessRunner } from '../src/remote/transport/index.js';
import {
  RemoteError,
  ghConnector,
  graphqlConnector,
  restConnector,
} from '../src/remote/transport/index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fake fetch
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  init: RequestInit;
}

function fetchWith(...responses: Response[]): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let index = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init ?? {} });
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return response!;
  };
  return { fetch: fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

// ---------------------------------------------------------------------------
// The contract: kind, request, paginate, close
// ---------------------------------------------------------------------------

describe('the Connector contract', () => {
  const connectors: Array<[string, Connector]> = [
    ['rest', restConnector({ baseUrl: 'https://api.example.com', fetch: fetchWith().fetch })],
    ['graphql', graphqlConnector({ baseUrl: 'https://api.example.com/graphql', fetch: fetchWith().fetch })],
    ['gh', ghConnector({ runner: vi.fn<ProcessRunner>(async () => ({ stdout: '', stderr: '', exitCode: 0 })) })],
  ];

  it.each(connectors)('%s exposes request, paginate, close and a kind', (_name, connector) => {
    expect(typeof connector.request).toBe('function');
    expect(typeof connector.paginate).toBe('function');
    expect(typeof connector.close).toBe('function');
    expect(['rest', 'graphql', 'process', 'memory']).toContain(connector.kind);
  });

  it('reports the right kind per family', () => {
    expect(restConnector({ baseUrl: 'https://x' }).kind).toBe('rest');
    expect(graphqlConnector({ baseUrl: 'https://x' }).kind).toBe('graphql');
    expect(ghConnector().kind).toBe('process');
  });

  it('close resolves on every family', async () => {
    for (const [, connector] of connectors) {
      await expect(connector.close()).resolves.toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// REST connector
// ---------------------------------------------------------------------------

describe('restConnector.request', () => {
  it('sends method, path, query, headers and a JSON body', async () => {
    const { fetch, calls } = fetchWith(jsonResponse({ ok: true }));
    const connector = restConnector({
      baseUrl: 'https://api.example.com',
      fetch,
      defaultHeaders: { Authorization: 'Bearer token' },
    });

    const response = await connector.request<{ ok: boolean }>({
      method: 'POST',
      path: '/repos/acme/payments/issues',
      query: { per_page: 100 },
      headers: { Accept: 'application/vnd.github+json' },
      body: { title: 'Ship it' },
    });

    expect(response.status).toBe(200);
    expect(response.ok).toBe(true);
    expect(response.body).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.example.com/repos/acme/payments/issues?per_page=100');
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer token');
    expect(headers.Accept).toBe('application/vnd.github+json');
    expect(headers['content-type']).toBe('application/json');
    expect(calls[0]!.init.body).toBe(JSON.stringify({ title: 'Ship it' }));
  });

  it('returns null body for an empty response', async () => {
    const { fetch } = fetchWith(new Response(null, { status: 204 }));
    const connector = restConnector({ baseUrl: 'https://api.example.com', fetch });
    const response = await connector.request<unknown>({ method: 'DELETE', path: '/x/1' });
    expect(response.body).toBeNull();
  });

  it('honours the caller\'s AbortSignal', async () => {
    const controller = new AbortController();
    const received: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      received.push(init?.signal as AbortSignal);
      return jsonResponse({});
    };
    const connector = restConnector({ baseUrl: 'https://api.example.com', fetch: fetchImpl });
    await connector.request({ method: 'GET', path: '/x', signal: controller.signal });

    // The caller's signal is wired into the one fetch received; aborting it
    // aborts the request.
    expect(received[0]).toBeDefined();
    controller.abort();
    expect(received[0]!.aborted).toBe(true);
  });
});

describe('restConnector failures are typed', () => {
  it('wraps a fetch rejection as a retryable RemoteError, never a raw TypeError', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError('fetch failed');
    };
    const connector = restConnector({ baseUrl: 'https://api.example.com', fetch: fetchImpl });

    await expect(
      connector.request({ method: 'GET', path: '/x' }),
    ).rejects.toMatchObject({ name: 'RemoteError', status: null, retryable: true });
  });

  it('marks a 429 with Retry-After retryable and reads the wait', async () => {
    const { fetch } = fetchWith(
      new Response('rate limited', { status: 429, headers: { 'retry-after': '30' } }),
    );
    const connector = restConnector({ baseUrl: 'https://api.example.com', fetch });

    let caught: unknown;
    try {
      await connector.request({ method: 'GET', path: '/x' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RemoteError);
    expect((caught as RemoteError).status).toBe(429);
    expect((caught as RemoteError).retryable).toBe(true);
    expect((caught as RemoteError).retryAfterMs).toBe(30000);
  });

  it('tells a rate-limit 403 from a permission 403', async () => {
    const { fetch } = fetchWith(
      new Response('limit', { status: 403, headers: { 'retry-after': '1' } }),
      new Response('forbidden', { status: 403 }),
    );
    const connector = restConnector({ baseUrl: 'https://api.example.com', fetch });

    const rateLimit = await connector.request({ method: 'GET', path: '/a' }).catch((e) => e);
    const permission = await connector.request({ method: 'GET', path: '/b' }).catch((e) => e);

    expect(rateLimit).toBeInstanceOf(RemoteError);
    expect((rateLimit as RemoteError).retryable).toBe(true);
    expect(permission).toBeInstanceOf(RemoteError);
    expect((permission as RemoteError).retryable).toBe(false);
  });

  it('marks a 5xx retryable and a 4xx not', async () => {
    const { fetch } = fetchWith(new Response('boom', { status: 500 }), new Response('bad', { status: 422 }));
    const connector = restConnector({ baseUrl: 'https://api.example.com', fetch });

    const serverError = await connector.request({ method: 'GET', path: '/a' }).catch((e) => e);
    const clientError = await connector.request({ method: 'GET', path: '/b' }).catch((e) => e);

    expect((serverError as RemoteError).retryable).toBe(true);
    expect((serverError as RemoteError).status).toBe(500);
    expect((clientError as RemoteError).retryable).toBe(false);
  });

  it('classifies a 409 as a conflict, not a generic client rejection', async () => {
    const { fetch } = fetchWith(new Response('changed', { status: 409 }));
    const connector = restConnector({ baseUrl: 'https://api.example.com', fetch });

    const conflict = await connector.request({ method: 'GET', path: '/a' }).catch((e) => e);

    expect(conflict).toBeInstanceOf(RemoteError);
    expect((conflict as RemoteError).code).toBe('conflict');
    expect((conflict as RemoteError).retryable).toBe(false);
    expect((conflict as RemoteError).message).toContain('the remote changed since it was last read');
  });

  it('aborts a request that exceeds its timeout', async () => {
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      });
    const connector = restConnector({ baseUrl: 'https://api.example.com', fetch: fetchImpl });

    await expect(
      connector.request({ method: 'GET', path: '/slow', timeoutMs: 20 }),
    ).rejects.toMatchObject({ name: 'RemoteError', retryable: true });
  });
});

describe('restConnector.paginate', () => {
  it('yields a single page when no pagination spec is given', async () => {
    const { fetch } = fetchWith(jsonResponse({ items: [1, 2] }));
    const connector = restConnector({ baseUrl: 'https://api.example.com', fetch });

    const pages: unknown[] = [];
    for await (const page of connector.paginate({ method: 'GET', path: '/x' })) {
      pages.push(page);
    }
    expect(pages).toEqual([{ items: [1, 2] }]);
  });

  it('follows a rel="next" Link header across pages', async () => {
    const { fetch, calls } = fetchWith(
      jsonResponse({ items: [1] }, 200, {
        link: '<https://api.example.com/x?page=2>; rel="next"',
      }),
      jsonResponse({ items: [2] }),
    );
    const connector = restConnector({ baseUrl: 'https://api.example.com', fetch });

    const pages: unknown[] = [];
    for await (const page of connector.paginate({
      method: 'GET',
      path: '/x',
      pagination: { kind: 'link' },
    })) {
      pages.push(page);
    }

    expect(pages).toEqual([{ items: [1] }, { items: [2] }]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe('https://api.example.com/x?page=2');
  });

  it('drives a cursor field until it comes back empty', async () => {
    const { fetch, calls } = fetchWith(
      jsonResponse({ next: 'cursor-1', items: [1] }),
      jsonResponse({ next: null, items: [2] }),
    );
    const connector = restConnector({ baseUrl: 'https://api.example.com', fetch });

    const pages: unknown[] = [];
    for await (const page of connector.paginate({
      method: 'GET',
      path: '/x',
      pagination: { kind: 'cursor', cursorParam: 'after', nextCursorPath: ['next'] },
    })) {
      pages.push(page);
    }

    expect(pages).toEqual([{ next: 'cursor-1', items: [1] }, { next: null, items: [2] }]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe('https://api.example.com/x?after=cursor-1');
  });
});

// ---------------------------------------------------------------------------
// GraphQL connector
// ---------------------------------------------------------------------------

describe('graphqlConnector.request', () => {
  it('POSTs the document with JSON headers', async () => {
    const { fetch, calls } = fetchWith(jsonResponse({ data: { viewer: { login: 'frank' } } }));
    const connector = graphqlConnector({ baseUrl: 'https://api.example.com', fetch });

    const response = await connector.request<unknown>({
      method: 'GET', // GraphQL is always POSTed, whatever the caller wrote
      path: '/graphql',
      body: { query: 'query { viewer { login } }', variables: { n: 1 } },
    });

    expect(response.body).toEqual({ data: { viewer: { login: 'frank' } } });
    expect(calls[0]!.url).toBe('https://api.example.com/graphql');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>)['content-type']).toBe(
      'application/json',
    );
  });

  it('refuses a body without a string query', async () => {
    const connector = graphqlConnector({ baseUrl: 'https://api.example.com', fetch: fetchWith().fetch });
    await expect(
      connector.request({ method: 'POST', path: '/graphql', body: { notQuery: true } }),
    ).rejects.toMatchObject({ name: 'RemoteError', status: null });
  });
});

describe('graphqlConnector.paginate drives pageInfo cursors', () => {
  const ISSUES_PATH = ['data', 'repository', 'issues'] as const;

  function page(endCursor: string | null, hasNextPage: boolean, nodes: unknown[]): Response {
    return jsonResponse({
      data: {
        repository: {
          issues: { pageInfo: { hasNextPage, endCursor }, nodes },
        },
      },
    });
  }

  it('rewrites the cursor variable and stops when hasNextPage is false', async () => {
    const { fetch, calls } = fetchWith(
      page('cursor-1', true, [{ number: 1 }]),
      page('cursor-2', true, [{ number: 2 }]),
      page(null, false, [{ number: 3 }]),
    );
    const connector = graphqlConnector({ baseUrl: 'https://api.example.com', fetch });

    const pages: unknown[] = [];
    for await (const body of connector.paginate({
      method: 'POST',
      path: '/graphql',
      body: { query: 'query($first: Int, $after: String) { repository { issues(first: $first, after: $after) { pageInfo { hasNextPage endCursor } nodes { number } } } }' },
      pagination: {
        kind: 'graphql',
        cursorVariable: 'after',
        pageSizeVariable: 'first',
        pageSize: 10,
        pageInfoPath: [...ISSUES_PATH, 'pageInfo'],
      },
    })) {
      pages.push(body);
    }

    expect(pages).toHaveLength(3);
    expect(calls).toHaveLength(3);

    const bodies = calls.map((call) => JSON.parse(call.init.body as string) as { variables: Record<string, unknown> });
    expect(bodies[0]!.variables).toEqual({ first: 10 });
    expect(bodies[1]!.variables).toEqual({ first: 10, after: 'cursor-1' });
    expect(bodies[2]!.variables).toEqual({ first: 10, after: 'cursor-2' });
  });

  it('yields one page when no graphql pagination spec is given', async () => {
    const { fetch } = fetchWith(page(null, false, [{ number: 1 }]));
    const connector = graphqlConnector({ baseUrl: 'https://api.example.com', fetch });

    const pages: unknown[] = [];
    for await (const body of connector.paginate({
      method: 'POST',
      path: '/graphql',
      body: { query: 'query { repository { issues { nodes { number } } } }' },
    })) {
      pages.push(body);
    }
    expect(pages).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// gh connector (process)
// ---------------------------------------------------------------------------

describe('ghConnector', () => {
  it('shells a request out to `gh api`', async () => {
    const runner = vi.fn<ProcessRunner>(async () => ({ stdout: '{"number":1}', stderr: '', exitCode: 0 }));
    const connector = ghConnector({ runner });

    const response = await connector.request<{ number: number }>({
      method: 'POST',
      path: '/repos/acme/payments/issues',
      query: { per_page: 100 },
      headers: { Accept: 'application/vnd.github+json' },
      body: { title: 'Ship it' },
    });

    expect(response.body).toEqual({ number: 1 });
    expect(runner).toHaveBeenCalledTimes(1);
    const [command, args] = runner.mock.calls[0]!;
    expect(command).toBe('gh');
    expect(args).toEqual([
      'api',
      'repos/acme/payments/issues',
      '-X',
      'POST',
      '-f',
      'per_page=100',
      '-H',
      'Accept: application/vnd.github+json',
      '--input',
      '-',
      '-H',
      'Content-Type: application/json',
    ]);
  });

  it('sends the JSON body on stdin', async () => {
    const runner = vi.fn<ProcessRunner>(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const connector = ghConnector({ runner });
    await connector.request({ method: 'PATCH', path: '/repos/a/b/issues/1', body: { state: 'closed' } });
    expect(runner.mock.calls[0]![2].input).toBe(JSON.stringify({ state: 'closed' }));
  });

  it('surfaces a non-zero exit as a typed error with the stderr', async () => {
    const runner = vi.fn<ProcessRunner>(async () => ({ stdout: '', stderr: 'graphql error: not found', exitCode: 1 }));
    const connector = ghConnector({ runner });

    await expect(connector.request({ method: 'GET', path: '/repos/a/b/issues/9' })).rejects.toMatchObject({
      name: 'RemoteError',
      status: null,
      retryable: false,
      detail: 'graphql error: not found',
    });
  });

  it('reports a missing binary as a typed error', async () => {
    const runner = vi.fn<ProcessRunner>(async () => {
      const error = new Error('spawn gh ENOENT');
      (error as NodeJS.ErrnoException).code = 'ENOENT';
      throw error;
    });
    const connector = ghConnector({ runner });
    await expect(connector.request({ method: 'GET', path: '/repos/a/b' })).rejects.toMatchObject({
      name: 'RemoteError',
      status: null,
      retryable: false,
    });
  });

  it('appends --paginate when paging', async () => {
    const runner = vi.fn<ProcessRunner>(async () => ({ stdout: '[{"number":1},{"number":2}]', stderr: '', exitCode: 0 }));
    const connector = ghConnector({ runner });

    const pages: unknown[] = [];
    for await (const page of connector.paginate({ method: 'GET', path: '/repos/a/b/issues' })) {
      pages.push(page);
    }

    expect(pages).toEqual([[{ number: 1 }, { number: 2 }]]);
    expect(runner.mock.calls[0]![1].includes('--paginate')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LP-294 — typed, actionable transport errors
// ---------------------------------------------------------------------------

describe('RemoteError carries what a failure needs (LP-294)', () => {
  it('carries status, the provider message, the purpose and retryable for a non-2xx', async () => {
    const { fetch } = fetchWith(jsonResponse({ message: 'Validation failed' }, 422));
    const connector = restConnector({ baseUrl: 'https://api.example.com', fetch });

    const error = await connector
      .request({ method: 'POST', path: '/repos/a/b/issues', purpose: 'create issue', body: { title: 'x' } })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RemoteError);
    const typed = error as RemoteError;
    expect(typed.kind).toBe('api');
    expect(typed.code).toBe('client');
    expect(typed.status).toBe(422);
    expect(typed.providerMessage).toBe('Validation failed');
    expect(typed.purpose).toBe('create issue');
    expect(typed.retryable).toBe(false);
  });

  it('gives a rate-limit 403 and a permission 403 different messages', async () => {
    const { fetch } = fetchWith(
      jsonResponse({ message: 'API rate limit exceeded' }, 403, { 'retry-after': '30' }),
      jsonResponse({ message: 'Resource not accessible by integration' }, 403),
    );
    const connector = restConnector({ baseUrl: 'https://api.example.com', fetch });

    const rateLimited = await connector
      .request({ method: 'GET', path: '/a', purpose: 'fetch issues' })
      .catch((e: unknown) => e);
    const permission = await connector
      .request({ method: 'GET', path: '/b', purpose: 'fetch issues' })
      .catch((e: unknown) => e);

    expect((rateLimited as RemoteError).code).toBe('rate_limit');
    expect((permission as RemoteError).code).toBe('permission');
    expect((rateLimited as RemoteError).message).toContain('rate limited');
    expect((permission as RemoteError).message).toContain('permission denied');
    expect((rateLimited as RemoteError).message).not.toBe((permission as RemoteError).message);
    expect((rateLimited as RemoteError).retryable).toBe(true);
    expect((permission as RemoteError).retryable).toBe(false);
  });

  it('names the credential and how it is resolved for a 401', async () => {
    const { fetch } = fetchWith(jsonResponse({ message: 'Bad credentials' }, 401));
    const connector = restConnector({
      baseUrl: 'https://api.example.com',
      fetch,
      credential: { name: 'GITHUB_TOKEN', source: 'the environment' },
    });

    const error = await connector
      .request({ method: 'GET', path: '/repos/a/b', purpose: 'fetch issues' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RemoteError);
    const typed = error as RemoteError;
    expect(typed.code).toBe('auth');
    expect(typed.credential).toEqual({ name: 'GITHUB_TOKEN', source: 'the environment' });
    expect(typed.message).toContain('GITHUB_TOKEN');
    expect(typed.message).toContain('the environment');
    expect(typed.hints()).toContain('retrying will not help — check the credential and its scope');
  });

  it('still says authentication failed when no credential is named', async () => {
    const { fetch } = fetchWith(jsonResponse({ message: 'Bad credentials' }, 401));
    const connector = restConnector({ baseUrl: 'https://api.example.com', fetch });

    const error = await connector
      .request({ method: 'GET', path: '/repos/a/b', purpose: 'fetch issues' })
      .catch((e: unknown) => e);

    expect((error as RemoteError).code).toBe('auth');
    expect((error as RemoteError).message).toContain('authentication failed');
    expect((error as RemoteError).message).toContain('the remote rejected the credential');
  });

  it('distinguishes a network failure from an API rejection', async () => {
    const networkConnector = restConnector({
      baseUrl: 'https://api.example.com',
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    const networkError = await networkConnector
      .request({ method: 'GET', path: '/x', purpose: 'fetch issues' })
      .catch((e: unknown) => e);

    const { fetch } = fetchWith(jsonResponse({ message: 'boom' }, 500));
    const apiConnector = restConnector({ baseUrl: 'https://api.example.com', fetch });
    const apiError = await apiConnector
      .request({ method: 'GET', path: '/x', purpose: 'fetch issues' })
      .catch((e: unknown) => e);

    expect((networkError as RemoteError).kind).toBe('network');
    expect((networkError as RemoteError).status).toBeNull();
    expect((apiError as RemoteError).kind).toBe('api');
    expect((apiError as RemoteError).status).toBe(500);
    expect((networkError as RemoteError).message).not.toBe((apiError as RemoteError).message);
  });
});

describe('toBoardError renders a transport failure as a BoardError (LP-294)', () => {
  it('carries the headline and hint list on the BoardError', () => {
    const error = new RemoteError({
      kind: 'api',
      code: 'rate_limit',
      status: 403,
      retryable: true,
      retryAfterMs: 30_000,
      purpose: 'fetch issues',
      providerMessage: 'API rate limit exceeded',
    });

    const board = toBoardError(error, 'github');

    expect(board).toBeInstanceOf(BoardError);
    expect(board.message).toBe('remote "github": rate limited while fetch issues');
    expect(board.details).toEqual([
      'the remote said: API rate limit exceeded',
      'retry in 30s',
    ]);
  });

  it('leaves the remote name out when none is given', () => {
    const board = toBoardError(
      new RemoteError({ kind: 'network', purpose: 'fetch issues', retryable: true }),
    );
    expect(board.message).toBe('could not reach the remote while fetch issues');
    expect(board.details).toEqual(['retrying may succeed']);
  });
});
