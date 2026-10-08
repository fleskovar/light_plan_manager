/**
 * The REST connector: a `Connector` over Node's built-in `fetch`.
 *
 * No HTTP dependency is added — `fetch` is built into Node since 18 and
 * required at 20 by this package. The only global it reaches for is `fetch`,
 * injected so tests drive it with a fake and stay offline.
 */

import type { Connector, RemoteRequest } from './connector.js';
import type { CredentialRef } from './error.js';
import {
  DEFAULT_TIMEOUT_MS,
  nextLink,
  readPath,
  requestViaHttp,
  type HttpOptions,
} from './http.js';

export interface RestConnectorOptions {
  /** The API root every relative `path` is resolved against. */
  readonly baseUrl: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Headers sent on every request (auth lands here, via a decorator). */
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  /** The timeout when a request does not name one. */
  readonly defaultTimeoutMs?: number;
  /** The credential a 401's message names, and where its value comes from. */
  readonly credential?: CredentialRef;
}

export function restConnector(options: RestConnectorOptions): Connector {
  const http: HttpOptions = {
    baseUrl: options.baseUrl.replace(/\/+$/, ''),
    fetchImpl: options.fetch ?? fetch,
    defaultHeaders: options.defaultHeaders ?? {},
    defaultTimeoutMs: options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    credential: options.credential,
  };

  return {
    kind: 'rest',

    request<T>(req: RemoteRequest) {
      return requestViaHttp<T>(http, req);
    },

    async *paginate<T>(req: RemoteRequest): AsyncGenerator<T> {
      const spec = req.pagination;
      // No spec, or a spec another family owns: the collection is one page.
      if (spec === undefined || spec.kind === 'graphql') {
        const response = await this.request<T>(req);
        if (response.body !== null) yield response.body;
        return;
      }

      let current: RemoteRequest = req;
      for (;;) {
        const response = await this.request<T>(current);
        if (response.body !== null) yield response.body;

        if (spec.kind === 'link') {
          const next = nextLink(response.headers);
          if (next === null) return;
          current = { ...req, path: next, query: undefined };
        } else {
          const cursor = readPath(response.body, spec.nextCursorPath);
          if (cursor === null || cursor === undefined || cursor === '') return;
          current = {
            ...req,
            query: { ...req.query, [spec.cursorParam]: String(cursor) },
          };
        }
      }
    },

    // `fetch` holds no persistent connection; there is nothing to release.
    async close() {},
  };
}
