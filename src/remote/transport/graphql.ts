/**
 * The GraphQL connector: the same `Connector` contract, over POSTed GraphQL
 * documents. `paginate` drives `pageInfo` cursors — `endCursor` is written
 * into the cursor variable and the request re-sent until `hasNextPage` is
 * false.
 */

import type { Connector, RemoteRequest } from './connector.js';
import { RemoteError, type CredentialRef } from './error.js';
import {
  DEFAULT_TIMEOUT_MS,
  readPath,
  requestViaHttp,
  type HttpOptions,
} from './http.js';

export interface GraphqlConnectorOptions {
  /** The GraphQL endpoint; every request POSTs here. */
  readonly baseUrl: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Headers sent on every request. */
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly defaultTimeoutMs?: number;
  /** The credential a 401's message names, and where its value comes from. */
  readonly credential?: CredentialRef;
}

/** The body a GraphQL request carries: a document plus optional variables. */
export interface GraphqlBody {
  readonly query: string;
  readonly variables?: Record<string, unknown>;
}

interface PageInfo {
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

/** Require the request body to be a GraphQL document, or fail with a typed error. */
function requireGraphqlBody(req: RemoteRequest): GraphqlBody {
  const body = req.body;
  if (
    body === null ||
    body === undefined ||
    typeof body !== 'object' ||
    typeof (body as GraphqlBody).query !== 'string'
  ) {
    throw new RemoteError({
      kind: 'invalid',
      retryable: false,
      message: 'GraphQL request body must carry a string `query`',
    });
  }
  return body as GraphqlBody;
}

/** Read `pageInfo` from the decoded body at the requested path. */
function pageInfoOf(body: unknown, path: readonly string[]): PageInfo {
  const raw = readPath(body, path);
  const value = raw as { hasNextPage?: unknown; endCursor?: unknown } | null | undefined;
  return {
    hasNextPage: value?.hasNextPage === true,
    endCursor: typeof value?.endCursor === 'string' ? value.endCursor : null,
  };
}

export function graphqlConnector(options: GraphqlConnectorOptions): Connector {
  const http: HttpOptions = {
    baseUrl: options.baseUrl.replace(/\/+$/, ''),
    fetchImpl: options.fetch ?? fetch,
    defaultHeaders: { 'content-type': 'application/json', ...options.defaultHeaders },
    defaultTimeoutMs: options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    credential: options.credential,
  };

  return {
    kind: 'graphql',

    // `async`, so a body that fails validation rejects rather than throwing
    // synchronously — `request` returns a promise, whatever it finds.
    async request<T>(req: RemoteRequest) {
      requireGraphqlBody(req);
      return requestViaHttp<T>(http, { ...req, method: 'POST', query: undefined });
    },

    async *paginate<T>(req: RemoteRequest): AsyncGenerator<T> {
      const body = requireGraphqlBody(req);
      const spec = req.pagination;
      if (spec === undefined || spec.kind !== 'graphql') {
        // No cursor spec: the collection is one page.
        const response = await this.request<T>({ ...req, method: 'POST', query: undefined });
        if (response.body !== null) yield response.body;
        return;
      }

      const variables = { ...body.variables };
      variables[spec.pageSizeVariable] = spec.pageSize;

      for (;;) {
        const request: RemoteRequest = {
          ...req,
          method: 'POST',
          query: undefined,
          body: { query: body.query, variables },
        };
        const response = await this.request<T>(request);
        if (response.body !== null) yield response.body;

        const pageInfo = pageInfoOf(response.body, spec.pageInfoPath);
        if (!pageInfo.hasNextPage || pageInfo.endCursor === null) return;
        variables[spec.cursorVariable] = pageInfo.endCursor;
      }
    },

    // `fetch` holds no persistent connection; there is nothing to release.
    async close() {},
  };
}
