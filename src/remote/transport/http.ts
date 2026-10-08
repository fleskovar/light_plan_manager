/**
 * The shared HTTP plumbing the REST and GraphQL connectors sit on. Internal to
 * this folder — `index.ts` does not re-export it — so both connectors wrap a
 * failed fetch the same way and neither can drift into a raw `TypeError`.
 */

import type { RemoteRequest, RemoteResponse } from './connector.js';
import {
  classifyStatus,
  providerMessageOf,
  RemoteError,
  type CredentialRef,
} from './error.js';

/** Every request carries a timeout; this is the one when neither side set one. */
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface HttpOptions {
  readonly baseUrl: string;
  readonly fetchImpl: typeof fetch;
  readonly defaultHeaders: Readonly<Record<string, string>>;
  readonly defaultTimeoutMs: number;
  /** The credential these requests authenticate with, named for a 401's message. */
  readonly credential?: CredentialRef | null;
}

/** `baseUrl` + `path` + `query`, unless `path` is already absolute (Link header). */
export function buildUrl(baseUrl: string, req: RemoteRequest): string {
  const target = /^https?:\/\//.test(req.path) ? req.path : `${baseUrl}${req.path}`;
  if (!req.query) return target;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (value !== undefined) query.set(key, String(value));
  }
  return query.size > 0 ? `${target}?${query.toString()}` : target;
}

function hasHeader(headers: Readonly<Record<string, string>>, name: string): boolean {
  return readHeader(headers, name) !== undefined;
}

/** Read a header case-insensitively; `undefined` when absent. */
export function readHeader(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

/** Default headers, overridden by per-request headers, plus JSON when a body is sent. */
export function mergedHeaders(
  defaultHeaders: Readonly<Record<string, string>>,
  req: RemoteRequest,
): Record<string, string> {
  const merged: Record<string, string> = { ...defaultHeaders, ...req.headers };
  if (req.body !== undefined && !hasHeader(merged, 'content-type')) {
    merged['content-type'] = 'application/json';
  }
  if (req.idempotencyKey !== undefined && !hasHeader(merged, 'idempotency-key')) {
    merged['idempotency-key'] = req.idempotencyKey;
  }
  return merged;
}

/** The user's signal plus the timeout signal, combined into one when both exist. */
export function effectiveSignal(
  req: RemoteRequest,
  defaultTimeoutMs: number,
): AbortSignal | undefined {
  const timeoutMs = req.timeoutMs ?? defaultTimeoutMs;
  const signals: AbortSignal[] = [];
  if (req.signal) signals.push(req.signal);
  if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

/** What the request was doing, as a phrase a failure message can carry. */
export function purposeOf(req: RemoteRequest): string {
  return req.purpose ?? `${req.method} ${req.path}`;
}

/** A failed `fetch` becomes a typed error, distinguished abort vs timeout vs network. */
export function fetchErrorOf(error: unknown, req: RemoteRequest): RemoteError {
  const name = error instanceof Error ? error.name : undefined;
  if (name === 'AbortError' || name === 'TimeoutError') {
    // A timeout is worth retrying; a caller aborting (Ctrl-C) is not.
    const userAborted = req.signal?.aborted ?? false;
    return new RemoteError({
      kind: userAborted ? 'abort' : 'timeout',
      status: null,
      retryable: !userAborted,
      purpose: purposeOf(req),
      cause: error,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new RemoteError({
    kind: 'network',
    status: null,
    retryable: true,
    purpose: purposeOf(req),
    detail: message,
    cause: error,
  });
}

/** Response headers as a plain record. */
export function headersOf(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

/** Decode a body as JSON when it parses, raw text when it does not, `null` when empty. */
export function decodeBody<T>(text: string): T | null {
  if (text === '') return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

/**
 * How long to wait until the rate limit resets, in milliseconds: a
 * `Retry-After` delta-seconds value, or GitHub's `x-ratelimit-reset` epoch
 * (seconds) read as a duration from `now`. `null` when neither is present or
 * parseable. An HTTP-date `Retry-After` is left alone (rare, and not worth a
 * date parser here).
 */
export function retryAfterMs(
  headers: Readonly<Record<string, string>>,
  now: number = Date.now(),
): number | null {
  const retryAfter = readHeader(headers, 'retry-after');
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  }
  const reset = readHeader(headers, 'x-ratelimit-reset');
  if (reset !== undefined) {
    const epochSeconds = Number(reset);
    if (Number.isFinite(epochSeconds) && epochSeconds > 0) {
      return Math.max(0, Math.ceil(epochSeconds * 1000 - now));
    }
  }
  return null;
}

/** GitHub's rate-limit signal: the request was refused because the quota is spent. */
function rateLimitExhausted(headers: Readonly<Record<string, string>>): boolean {
  return readHeader(headers, 'x-ratelimit-remaining') === '0';
}

/** Walk a JSON path; `undefined` when the path does not exist. */
export function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** The absolute URL of the `rel="next"` Link entry, or null when there is none. */
export function nextLink(headers: Readonly<Record<string, string>>): string | null {
  const linkHeader = headers['link'];
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const segments = part.split(';');
    const url = segments[0]?.trim();
    const rel = segments
      .map((segment) => segment.trim())
      .find((segment) => segment.toLowerCase().startsWith('rel='));
    if (url && rel && /rel="?next"?/i.test(rel)) {
      return url.slice(1, -1); // strip the surrounding `<` `>`
    }
  }
  return null;
}

/** One request over HTTP: fetch, wrap failures, throw on a non-ok status. */
export async function requestViaHttp<T>(
  options: HttpOptions,
  req: RemoteRequest,
): Promise<RemoteResponse<T>> {
  let response: Response;
  try {
    response = await options.fetchImpl(buildUrl(options.baseUrl, req), {
      method: req.method,
      headers: mergedHeaders(options.defaultHeaders, req),
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: effectiveSignal(req, options.defaultTimeoutMs),
    });
  } catch (error) {
    throw fetchErrorOf(error, req);
  }

  const headers = headersOf(response);
  const text = await response.text();
  const body = decodeBody<T>(text);

  if (!response.ok) {
    const retryAfter = retryAfterMs(headers);
    const classification = classifyStatus(
      response.status,
      retryAfter,
      rateLimitExhausted(headers),
    );
    throw new RemoteError({
      kind: 'api',
      status: response.status,
      code: classification.code,
      retryable: classification.retryable,
      retryAfterMs: retryAfter,
      purpose: purposeOf(req),
      providerMessage: providerMessageOf(body),
      // Only a 401 names the credential; elsewhere it would be noise.
      credential: classification.code === 'auth' ? (options.credential ?? null) : null,
      detail: text,
    });
  }

  return { status: response.status, ok: true, headers, body };
}
