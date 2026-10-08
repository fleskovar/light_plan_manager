/**
 * Recorded traffic fixtures (LP-301): capture what a real tracker actually
 * returns, scrub every secret on the way in, and replay the capture offline.
 *
 * This is the third leg of the plug-and-play test story (LP-292), beside the
 * in-memory tracker (LP-299) and the conformance suite (LP-300). The tracker
 * tests the *algorithm*; a recording tests the *parsing* against reality —
 * the exact response shapes, status codes and error bodies a real platform
 * sent, not the author's reading of the docs.
 *
 * Two connectors, one file format:
 *
 *   - `recordingConnector` wraps a transport `Connector` and records every
 *     request/response exchange, scrubbed, into a session. It is a no-op
 *     unless `LPM_RECORD=1` (or `enabled: true`), and it flushes the session
 *     to `<directory>/<provider>/recording.json` on `close()`.
 *   - `replayConnector` reads that file and serves the recorded responses. An
 *     unmatched request fails loudly (`UnmatchedReplayRequestError`) rather
 *     than falling through to the network — a silent network fallback would
 *     make the offline promise meaningless.
 *
 * Scrubbing is the same rule as the output redactor (LP-296) plus two shapes a
 * recording adds over a log line: **emails** and **account ids**. A recording
 * is committed to the repo, so it must be clean by construction — the marker is
 * `***`, replacement never omission, and a test
 * (`test/remote-fixtures.test.ts`) asserts every committed fixture is already
 * clean.
 *
 * A recording carries a `captured_at` date because recordings age silently:
 * they keep passing after the platform changes. The live suite (LP-301,
 * `LPM_LIVE=1`) is the thing that catches that drift — run it deliberately,
 * never by accident.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactHeaders, redactText, redactor, REDACTED } from './redact.js';
import type {
  Connector,
  ConnectorKind,
  RemoteRequest,
  RemoteResponse,
} from './transport/connector.js';
import { RemoteError, type RemoteApiCode, type RemoteErrorKind } from './transport/error.js';
import { nextLink, readPath } from './transport/http.js';

// ---------------------------------------------------------------------------
// The recording format
// ---------------------------------------------------------------------------

/** One recorded request, in transport vocabulary, scrubbed. */
export interface RecordedRequest {
  method: string;
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
  purpose?: string;
  idempotencyKey?: string;
}

/** One recorded response. `body` is `null` for a 204 or an empty body. */
export interface RecordedResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: unknown;
}

/** One recorded failure, carrying everything `RemoteError` needs to be rethrown. */
export interface RecordedError {
  kind: RemoteErrorKind;
  status: number | null;
  code: RemoteApiCode | null;
  retryable: boolean;
  retryAfterMs: number | null;
  purpose: string;
  providerMessage: string | null;
  detail: string;
}

/** One exchange: a request and either the response it got or the error it raised. */
export type RecordedExchange =
  | { request: RecordedRequest; response: RecordedResponse }
  | { request: RecordedRequest; error: RecordedError };

/** A recording session: provenance plus the ordered exchange transcript. */
export interface RecordedSession {
  /** Provider the recording was taken against, e.g. `github`. */
  provider: string;
  /** Transport family the recording came from; replay reports the same `kind`. */
  kind: ConnectorKind;
  /** ISO capture timestamp. Recordings age silently; this says how old this one is. */
  captured_at: string;
  /** Human-readable capture date (`YYYY-MM-DD`). */
  captured_date: string;
  /** The connector's base URL, when known (provenance, never used for matching). */
  base_url?: string;
  /** A provenance note, e.g. how the recording was taken. */
  note?: string;
  exchanges: RecordedExchange[];
}

// ---------------------------------------------------------------------------
// Scrubbing
// ---------------------------------------------------------------------------

/** What `scrub*` replaces. */
export interface ScrubOptions {
  /** Secret values to redact (raw and percent-encoded). */
  secrets?: readonly string[];
  /** Account ids / repo owners to scrub out of text and URLs. */
  accounts?: readonly string[];
}

/** Header names that carry a secret by definition, redacted whole whatever the value. */
const SECRET_HEADER_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'apikey',
  'cookie',
  'set-cookie',
]);

/** An email address — the one shape a recording must never keep. */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/**
 * Scrub one string: secrets first (raw and percent-encoded, exactly as the
 * output redactor does), then emails, then account ids. The order means a
 * secret wins over any account id it happens to contain.
 */
export function scrubText(text: string, options: ScrubOptions = {}): string {
  let out = redactText(text, options.secrets ?? []);
  out = out.replace(EMAIL_RE, REDACTED);
  for (const account of options.accounts ?? []) {
    if (account.length === 0) continue;
    out = out.split(account).join(REDACTED);
  }
  return out;
}

/** Scrub a value recursively: strings directly, arrays and objects element-wise. */
export function scrubValue(value: unknown, options: ScrubOptions = {}): unknown {
  if (typeof value === 'string') return scrubText(value, options);
  if (Array.isArray(value)) return value.map((entry) => scrubValue(entry, options));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = scrubValue(entry, options);
    return out;
  }
  return value;
}

/**
 * Scrub a headers record. A header whose *value* carries a secret, or whose
 * *name* is a secret header (`Authorization`, `X-Api-Key`, …), becomes
 * `REDACTED` whole; the rest are scrubbed for emails and account ids. Header
 * names are fixed vocabulary and are never touched.
 */
export function scrubHeaders(
  headers: Readonly<Record<string, string>> | undefined,
  options: ScrubOptions = {},
): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  const redacted = redactHeaders(headers, options.secrets ?? []);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(redacted)) {
    out[name] = SECRET_HEADER_NAMES.has(name.toLowerCase()) ? REDACTED : scrubText(value, options);
  }
  return out;
}

function scrubRecordedRequest(request: RecordedRequest, options: ScrubOptions): RecordedRequest {
  return {
    method: request.method,
    path: scrubText(request.path, options),
    query:
      request.query === undefined
        ? undefined
        : (scrubValue(request.query, options) as Record<string, string>),
    headers: scrubHeaders(request.headers, options),
    body: request.body === undefined ? undefined : scrubValue(request.body, options),
    purpose: request.purpose === undefined ? undefined : scrubText(request.purpose, options),
    idempotencyKey:
      request.idempotencyKey === undefined
        ? undefined
        : scrubText(request.idempotencyKey, options),
  };
}

function scrubRecordedResponse(response: RecordedResponse, options: ScrubOptions): RecordedResponse {
  return {
    status: response.status,
    ok: response.ok,
    headers: scrubHeaders(response.headers, options) ?? {},
    body: scrubValue(response.body, options),
  };
}

function scrubRecordedError(error: RecordedError, options: ScrubOptions): RecordedError {
  return {
    kind: error.kind,
    status: error.status,
    code: error.code,
    retryable: error.retryable,
    retryAfterMs: error.retryAfterMs,
    purpose: scrubText(error.purpose, options),
    providerMessage:
      error.providerMessage === null ? null : scrubText(error.providerMessage, options),
    detail: scrubText(error.detail, options),
  };
}

function scrubExchange(exchange: RecordedExchange, options: ScrubOptions): RecordedExchange {
  const request = scrubRecordedRequest(exchange.request, options);
  if ('error' in exchange) return { request, error: scrubRecordedError(exchange.error, options) };
  return { request, response: scrubRecordedResponse(exchange.response, options) };
}

/**
 * Scrub a whole session's exchanges. The provenance header (provider, dates,
 * base URL, note) is left alone — it is documentation, not traffic. Used by
 * the clean-fixtures test to assert a committed recording is already clean:
 * scrubbing it again must change nothing.
 */
export function scrubSession(session: RecordedSession, options: ScrubOptions = {}): RecordedSession {
  return { ...session, exchanges: session.exchanges.map((e) => scrubExchange(e, options)) };
}

// ---------------------------------------------------------------------------
// Session I/O
// ---------------------------------------------------------------------------

/** The file a provider's recording lives in, under `<directory>/<provider>/`. */
export function sessionFileName(directory: string, provider: string): string {
  return join(directory, provider, 'recording.json');
}

/** Write a session to `<directory>/<provider>/recording.json`, creating the folder. */
export function writeSession(session: RecordedSession, directory: string): string {
  const file = sessionFileName(directory, session.provider);
  mkdirSync(join(directory, session.provider), { recursive: true });
  writeFileSync(file, `${JSON.stringify(session, null, 2)}\n`);
  return file;
}

/** Read a recording session, failing loudly when the file is missing or malformed. */
export function readSession(file: string): RecordedSession {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`replay: cannot read fixture ${file}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`replay: fixture ${file} is not valid JSON: ${(error as Error).message}`);
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as Record<string, unknown>)['exchanges'])
  ) {
    throw new Error(`replay: fixture ${file} has no exchanges — re-record with LPM_RECORD=1`);
  }
  return parsed as RecordedSession;
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

export interface RecordingOptions extends ScrubOptions {
  /** Directory the `<provider>/recording.json` is written under. Defaults to
   * `test/fixtures/remote`, the path the story (LP-301) names — pass an
   * explicit directory in tests so committed fixtures are never overwritten. */
  directory?: string;
  /** Provider name, e.g. `github`. */
  provider: string;
  /** Record only when true; defaults to `LPM_RECORD === '1'`. */
  enabled?: boolean;
  /** The connector's base URL, recorded for provenance only. */
  baseUrl?: string;
  /** A provenance note written into the session. */
  note?: string;
  /** Injectable clock for the capture date (tests). */
  now?: () => Date;
}

/** The directory a recording lands in when the caller does not name one (LP-301). */
export const DEFAULT_FIXTURES_DIRECTORY = 'test/fixtures/remote';

/** The query as it is matched and recorded: `undefined` dropped, numbers stringified. */
function normalizeQuery(
  query?: Readonly<Record<string, string | number | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (query === undefined) return out;
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) out[key] = String(value);
  }
  return out;
}

function rawRequest(req: RemoteRequest): RecordedRequest {
  return {
    method: req.method,
    path: req.path,
    query: req.query === undefined ? undefined : normalizeQuery(req.query),
    headers: req.headers === undefined ? undefined : { ...req.headers },
    body: req.body,
    purpose: req.purpose,
    idempotencyKey: req.idempotencyKey,
  };
}

function rawResponse(response: RemoteResponse<unknown>): RecordedResponse {
  return {
    status: response.status,
    ok: response.ok,
    headers: { ...response.headers },
    body: response.body,
  };
}

function rawError(error: RemoteError): RecordedError {
  return {
    kind: error.kind,
    status: error.status,
    code: error.code,
    retryable: error.retryable,
    retryAfterMs: error.retryAfterMs,
    purpose: error.purpose,
    providerMessage: error.providerMessage,
    detail: error.detail,
  };
}

/**
 * Wrap a transport `Connector` so every request — and every page of a
 * `paginate` walk, because REST and GraphQL page through their own `request`
 * — is recorded, scrubbed, and flushed to disk on `close()`.
 *
 * Off unless `LPM_RECORD=1` (or `enabled: true`): production and the default
 * test run stay untouched, so recording is deliberate, exactly as the live
 * suite is. The process-wide redactor's registered secrets are scrubbed in
 * addition to any `secrets` passed explicitly, so a connector built through
 * `buildConnector` (which registers its resolved credentials) is covered
 * without the caller re-listing them.
 */
export function recordingConnector(inner: Connector, options: RecordingOptions): Connector {
  const enabled = options.enabled ?? process.env.LPM_RECORD === '1';
  if (!enabled) return inner;

  const directory = options.directory ?? DEFAULT_FIXTURES_DIRECTORY;
  const secrets = [...(options.secrets ?? []), ...redactor.secrets()];
  const accounts = options.accounts ?? [];
  const scrub: ScrubOptions = { secrets, accounts };
  const exchanges: RecordedExchange[] = [];

  async function request<T>(req: RemoteRequest): Promise<RemoteResponse<T>> {
    try {
      const response = await inner.request<T>(req);
      exchanges.push({
        request: scrubRecordedRequest(rawRequest(req), scrub),
        response: scrubRecordedResponse(rawResponse(response), scrub),
      });
      return response;
    } catch (error) {
      if (error instanceof RemoteError) {
        exchanges.push({
          request: scrubRecordedRequest(rawRequest(req), scrub),
          error: scrubRecordedError(rawError(error), scrub),
        });
      }
      throw error;
    }
  }

  return {
    ...inner,
    request,
    async close() {
      await inner.close();
      const now = options.now?.() ?? new Date();
      const session: RecordedSession = {
        provider: options.provider,
        kind: inner.kind,
        captured_at: now.toISOString(),
        captured_date: now.toISOString().slice(0, 10),
        ...(options.baseUrl !== undefined ? { base_url: options.baseUrl } : {}),
        ...(options.note !== undefined ? { note: options.note } : {}),
        exchanges,
      };
      writeSession(session, directory);
    },
  };
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/** A replay request matched nothing in the recording — the offline promise holds. */
export class UnmatchedReplayRequestError extends Error {
  readonly request: RemoteRequest;
  readonly file: string;

  constructor(request: RemoteRequest, file: string, expected?: RecordedRequest) {
    const got = `${request.method} ${request.path}`;
    const want = expected === undefined ? 'no exchange' : `${expected.method} ${expected.path}`;
    super(
      `replay: ${got} did not match the next recorded exchange (${want}) in ${file} — re-record with LPM_RECORD=1`,
    );
    this.name = 'UnmatchedReplayRequestError';
    this.request = request;
    this.file = file;
  }
}

function sameQuery(a: Record<string, string>, b: Record<string, string>): boolean {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i += 1) {
    const key = keysA[i]!;
    if (key !== keysB[i] || a[key] !== b[key]) return false;
  }
  return true;
}

function matches(req: RemoteRequest, recorded: RecordedRequest): boolean {
  if (req.method !== recorded.method) return false;
  if (req.path !== recorded.path) return false;
  return sameQuery(normalizeQuery(req.query), recorded.query ?? {});
}

/** Read `pageInfo` from a decoded GraphQL body, exactly as the GraphQL connector does. */
function pageInfoOf(
  body: unknown,
  path: readonly string[],
): { hasNextPage: boolean; endCursor: string | null } {
  const raw = readPath(body, path);
  const value = raw as { hasNextPage?: unknown; endCursor?: unknown } | null | undefined;
  return {
    hasNextPage: value?.hasNextPage === true,
    endCursor: typeof value?.endCursor === 'string' ? value.endCursor : null,
  };
}

function remoteErrorOf(recorded: RecordedError): RemoteError {
  return new RemoteError({
    kind: recorded.kind,
    status: recorded.status,
    code: recorded.code,
    retryable: recorded.retryable,
    retryAfterMs: recorded.retryAfterMs,
    purpose: recorded.purpose,
    providerMessage: recorded.providerMessage,
    detail: recorded.detail,
  });
}

export interface ReplayOptions {
  /** Path to the recording JSON file. */
  file: string;
}

/**
 * A `Connector` that serves a recording instead of talking to a network.
 *
 * Replay is a faithful transcript: each `request()` must match the *next*
 * recorded exchange (method, path and query), or it fails loudly — there is
 * no fall-through to the network, because a replay that silently degrades to
 * live traffic would reintroduce exactly the flakiness and tokens the fixture
 * exists to remove. A recorded failure is rethrown as a `RemoteError`, so a
 * replay can exercise the error paths too. `paginate` walks the recording the
 * same way a live connector walks a collection (Link header / cursor), each
 * page served by `request`.
 */
export function replayConnector(options: ReplayOptions): Connector {
  const session = readSession(options.file);
  const exchanges = session.exchanges;
  let next = 0;

  async function request<T>(req: RemoteRequest): Promise<RemoteResponse<T>> {
    const exchange = exchanges[next];
    if (exchange === undefined || !matches(req, exchange.request)) {
      throw new UnmatchedReplayRequestError(req, options.file, exchange?.request);
    }
    next += 1;
    if ('error' in exchange) throw remoteErrorOf(exchange.error);
    const response = exchange.response;
    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      body: response.body as T | null,
    };
  }

  async function* paginate<T>(req: RemoteRequest): AsyncGenerator<T> {
    const spec = req.pagination;

    // No spec: the collection is one page.
    if (spec === undefined) {
      const response = await request<T>(req);
      if (response.body !== null) yield response.body;
      return;
    }

    // GraphQL: drive `pageInfo` cursors, exactly as the GraphQL connector does.
    if (spec.kind === 'graphql') {
      const body = req.body as
        | { query?: unknown; variables?: Record<string, unknown> }
        | null
        | undefined;
      const query = typeof body?.query === 'string' ? body.query : '';
      const variables: Record<string, unknown> = { ...(body?.variables ?? {}) };
      variables[spec.pageSizeVariable] = spec.pageSize;
      for (;;) {
        const current: RemoteRequest = {
          ...req,
          method: 'POST',
          query: undefined,
          body: { query, variables },
        };
        const response = await request<T>(current);
        if (response.body !== null) yield response.body;

        const pageInfo = pageInfoOf(response.body, spec.pageInfoPath);
        if (!pageInfo.hasNextPage || pageInfo.endCursor === null) return;
        variables[spec.cursorVariable] = pageInfo.endCursor;
      }
    }

    // REST: follow a Link header or a cursor, each page served by `request`.
    let current: RemoteRequest = req;
    for (;;) {
      const response = await request<T>(current);
      if (response.body !== null) yield response.body;

      if (spec.kind === 'link') {
        const nextUrl = nextLink(response.headers);
        if (nextUrl === null) return;
        current = { ...req, path: nextUrl, query: undefined };
      } else {
        const cursor = readPath(response.body, spec.nextCursorPath);
        if (cursor === null || cursor === undefined || cursor === '') return;
        current = { ...req, query: { ...req.query, [spec.cursorParam]: String(cursor) } };
      }
    }
  }

  return {
    kind: session.kind,
    request,
    paginate,
    async close() {},
  };
}
