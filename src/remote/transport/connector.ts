/**
 * The transport contract (LP-293): send a described request, page a described
 * collection, and report the transport's own failure.
 *
 * This folder is the "carrier" half of the plug-and-play split (LP-246). It
 * knows about HTTP, GraphQL, tokens and processes — and nothing at all about
 * boards, issues, documents or `.lpm`. A provider (the "translator" half)
 * describes what it wants in these terms and hands it to whichever connector
 * the config chose, so the same provider runs over REST, GraphQL, a shelling-
 * out `gh` connector, or the fake one tests use (LP-299).
 *
 * That boundary is what makes the test suite run offline and a provider
 * compile with no network access. It is enforced, not hoped for:
 * `test/remote-transport-isolation.test.ts` fails if any file in this folder
 * imports `src/core` or `src/shared`.
 */

/** The transport families a provider can require of a connector. */
export const CONNECTOR_KINDS = ['rest', 'graphql', 'process', 'memory'] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

/** HTTP verbs, in transport vocabulary. */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * How `paginate` walks the collection a request returns. Transport vocabulary
 * only — cursors, Link headers, GraphQL pageInfo — never a board concept.
 *
 * `paginate` yields the decoded body of each page (the same shape `request`
 * returns), leaving item extraction to the caller, which is the one party
 * that knows its own response shape.
 */
export type PaginationSpec =
  | {
      /** REST: the next cursor is read from a field of the response body. */
      readonly kind: 'cursor';
      /** Query parameter the server reads the cursor from. */
      readonly cursorParam: string;
      /** JSON path to the next cursor in the response body. */
      readonly nextCursorPath: readonly string[];
    }
  | {
      /** REST: the next page's URL comes from a `rel="next"` Link header. */
      readonly kind: 'link';
    }
  | {
      /** GraphQL: `pageInfo` cursors. */
      readonly kind: 'graphql';
      /** Variable name the cursor (`after`) is written into. */
      readonly cursorVariable: string;
      /** Variable name the page size (`first`) is written into. */
      readonly pageSizeVariable: string;
      /** How many records each page asks for. */
      readonly pageSize: number;
      /** JSON path to the `pageInfo` object (`hasNextPage`, `endCursor`). */
      readonly pageInfoPath: readonly string[];
    };

/**
 * One request, described in transport vocabulary. There is no board word
 * anywhere in it — a provider's translator turns a board op into this, and the
 * connector turns this into the platform's own call.
 */
export interface RemoteRequest {
  readonly method: HttpMethod;
  /**
   * The path or endpoint, relative to the connector's base. A REST connector
   * may also receive an absolute URL (a Link-header target); an absolute URL
   * is used as-is.
   */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly headers?: Readonly<Record<string, string>>;
  /** JSON-serializable body; `undefined` sends none. */
  readonly body?: unknown;
  /** Per-request timeout, overriding the connector's default. */
  readonly timeoutMs?: number;
  /** Aborts this request — and every page of a `paginate` walk. */
  readonly signal?: AbortSignal;
  /**
   * What the request is doing, in transport vocabulary ("create issue",
   * "fetch the issue list"). Carried into a `RemoteError` so a failure names
   * the action it interrupted; defaults to `METHOD path` when absent.
   */
  readonly purpose?: string;
  /** How `paginate` pages the collection; absent means a single page. */
  readonly pagination?: PaginationSpec;
  /**
   * A client-chosen key the platform deduplicates on, so a non-idempotent
   * write (a POST) can be re-sent without filing a duplicate. The REST and
   * GraphQL connectors send it as the `Idempotency-Key` header; a provider
   * whose platform uses another header name sets it via `headers` instead.
   * When present, a retry decorator may re-send a write it would otherwise
   * refuse (LP-297).
   */
  readonly idempotencyKey?: string;
}

/** One response, decoded. */
export interface RemoteResponse<T> {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Readonly<Record<string, string>>;
  /** The decoded body, or `null` when the response carries none (204, empty). */
  readonly body: T | null;
}

/**
 * A live transport. Narrow on purpose (LP-246): everything above it — auth
 * headers, retry policy, budget — is a decorator over this interface rather
 * than a flag on it, so a provider cannot accidentally bypass the rate
 * limiter.
 */
export interface Connector {
  /** Which transport family this is, so a provider can refuse a mismatch. */
  readonly kind: ConnectorKind;
  /** Send one request, decode the response, and throw `RemoteError` on failure. */
  request<T>(req: RemoteRequest): Promise<RemoteResponse<T>>;
  /** Walk every page of a described collection, yielding each page's decoded body. */
  paginate<T>(req: RemoteRequest): AsyncIterable<T>;
  /** Release anything the connector holds. A no-op for fetch and process transports. */
  close(): Promise<void>;
}
