/**
 * The one error every transport failure surfaces as (LP-289, LP-294): a status,
 * the provider's own message, what the request was for, and whether a retry is
 * sensible. Never a raw `TypeError: fetch failed` — a caller catching this
 * always has enough to tell a person what to do next.
 *
 * This is a *transport* error, not a second error protocol. It lives below the
 * board vocabulary on purpose (LP-293's isolation), so it is caught at the
 * `src/remote` boundary and wrapped into a `BoardError` whose hint list is the
 * lines `hints()` returns — see `toBoardError` in `src/remote/transport-error.ts`.
 */

/** The top-level category of a transport failure (a network failure ≠ an API rejection). */
export type RemoteErrorKind = 'api' | 'network' | 'abort' | 'timeout' | 'invalid';

/**
 * The finer reason an API rejection happened, so a 403 that is a rate limit and
 * a 403 that is a permission produce different messages — the single most
 * confusing failure on GitHub and Jira alike.
 */
export type RemoteApiCode =
  | 'auth'
  | 'rate_limit'
  | 'permission'
  | 'conflict'
  | 'not_found'
  | 'server'
  | 'client'
  | 'unknown';

/**
 * Which credential the remote rejected (a 401), and where its value comes from.
 * Transport vocabulary: the connector is *told* this when it is built and knows
 * nothing about `.lpm/config.yml` or how a resolver works.
 */
export interface CredentialRef {
  /** The credential's name, e.g. `GITHUB_TOKEN`. */
  readonly name: string;
  /** Where the value is resolved from, a phrase like `the environment` or `.lpm/credentials.json`. */
  readonly source: string;
}

export interface RemoteErrorInit {
  /** HTTP status, or `null` for a failure before any response (network, abort, timeout). */
  readonly status?: number | null;
  /** Defaults to `'api'`. */
  readonly kind?: RemoteErrorKind;
  /** The API rejection's reason; only meaningful when `kind` is `'api'`. */
  readonly code?: RemoteApiCode | null;
  /** Whether re-sending the request could plausibly succeed. */
  readonly retryable?: boolean;
  /** How long to wait before retrying, when the transport said so (`Retry-After`). */
  readonly retryAfterMs?: number | null;
  /** What the request was doing, e.g. `fetch the issue list`. */
  readonly purpose?: string;
  /** The provider's own words, extracted from the response body / process stderr. */
  readonly providerMessage?: string | null;
  /** The credential the remote asked for (a 401), and where it is resolved. */
  readonly credential?: CredentialRef | null;
  /** The raw response body / process stderr, for diagnostics. */
  readonly detail?: string;
  /** Overrides the computed headline, for a request refused before it was sent. */
  readonly message?: string;
  /** The underlying cause (a thrown `TypeError`, a spawn error, …). */
  readonly cause?: unknown;
}

/** `5000` → `5s`, `90_000` → `1m 30s`, `300` → `300ms`. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.ceil(ms)}ms`;
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

/** The one-line headline for a failure, distinct per kind and per API reason. */
function describe(init: RemoteErrorInit): string {
  const kind = init.kind ?? 'api';
  const code = kind === 'api' ? (init.code ?? 'unknown') : null;
  const purpose = init.purpose ? ` while ${init.purpose}` : '';
  const status = init.status ?? null;

  switch (kind) {
    case 'network':
      return `could not reach the remote${purpose}`;
    case 'abort':
      return `request aborted${purpose}`;
    case 'timeout':
      return `request timed out${purpose}`;
    case 'invalid':
      return `invalid request${purpose}`;
    default:
      switch (code) {
        case 'auth': {
          const credential = init.credential
            ? ` — the credential ${init.credential.name} (from ${init.credential.source}) was rejected`
            : ' — the remote rejected the credential';
          return `authentication failed${purpose}${credential}`;
        }
        case 'rate_limit':
          return `rate limited${purpose}`;
        case 'permission':
          return `permission denied${purpose}`;
        case 'conflict':
          return `conflict${purpose} — the remote changed since it was last read`;
        case 'not_found':
          return `not found${purpose}`;
        case 'server':
          return status !== null ? `the remote failed (HTTP ${status})${purpose}` : `the remote failed${purpose}`;
        case 'client':
          return status !== null
            ? `the remote rejected the request (HTTP ${status})${purpose}`
            : `the remote rejected the request${purpose}`;
        default:
          return status !== null ? `the remote answered HTTP ${status}${purpose}` : `the remote rejected the request${purpose}`;
      }
  }
}

export class RemoteError extends Error {
  readonly status: number | null;
  readonly kind: RemoteErrorKind;
  readonly code: RemoteApiCode | null;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  readonly purpose: string;
  readonly providerMessage: string | null;
  readonly credential: CredentialRef | null;
  readonly detail: string;

  constructor(init: RemoteErrorInit = {}) {
    super(init.message ?? describe(init), init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'RemoteError';
    this.status = init.status ?? null;
    this.kind = init.kind ?? 'api';
    this.code = this.kind === 'api' ? (init.code ?? 'unknown') : null;
    this.retryable = init.retryable ?? false;
    this.retryAfterMs = init.retryAfterMs ?? null;
    this.purpose = init.purpose ?? '';
    this.providerMessage = init.providerMessage ?? null;
    this.credential = init.credential ?? null;
    this.detail = init.detail ?? '';
  }

  /**
   * The actionable lines a `BoardError` renders as its hint list. Kept on the
   * transport error (not re-derived at the boundary) so the two cannot drift.
   */
  hints(): string[] {
    const lines: string[] = [];
    switch (this.kind) {
      case 'network':
        if (this.providerMessage) lines.push(this.providerMessage);
        if (this.retryable) lines.push('retrying may succeed');
        break;
      case 'timeout':
        lines.push('retrying may succeed');
        break;
      case 'abort':
      case 'invalid':
        break;
      case 'api':
      default:
        if (this.providerMessage) lines.push(`the remote said: ${this.providerMessage}`);
        if (this.retryAfterMs !== null) {
          lines.push(`retry in ${formatDuration(this.retryAfterMs)}`);
        } else if (this.retryable) {
          lines.push('retrying may succeed');
        } else if (this.code === 'permission') {
          lines.push('retrying will not help — the credential lacks the required scope');
        } else if (this.code === 'auth') {
          lines.push('retrying will not help — check the credential and its scope');
        } else if (this.code === 'client') {
          lines.push('retrying will not help — the request was rejected as invalid');
        } else if (this.code === 'conflict') {
          lines.push('the remote changed since it was read — pull and re-plan before pushing again');
        } else if (this.code === 'not_found') {
          lines.push('the resource may have been deleted or renamed');
        }
        break;
    }
    return lines;
  }
}

/**
 * Extract the provider's own message from a decoded response body. Handles the
 * common shapes — GitHub's `{ message }`, Jira's `{ errorMessages: [...] }`,
 * and a `{ error }` / `{ error: { message } }` — and falls back to the raw text
 * when the body is not JSON. `null` when the body has nothing to say.
 */
export function providerMessageOf(body: unknown): string | null {
  if (typeof body === 'string') {
    const trimmed = body.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (body !== null && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    const message = record['message'];
    if (typeof message === 'string' && message.trim() !== '') return message.trim();
    const errorMessages = record['errorMessages'];
    if (Array.isArray(errorMessages)) {
      const texts = errorMessages.filter(
        (entry): entry is string => typeof entry === 'string' && entry.trim() !== '',
      );
      if (texts.length > 0) return texts.join('; ');
    }
    const error = record['error'];
    if (typeof error === 'string' && error.trim() !== '') return error.trim();
    if (error !== null && typeof error === 'object') {
      const inner = (error as Record<string, unknown>)['message'];
      if (typeof inner === 'string' && inner.trim() !== '') return inner.trim();
    }
  }
  return null;
}

/**
 * Classify a non-2xx status into a reason and whether a retry is sensible.
 * `retryAfter` is the parsed `Retry-After` (milliseconds) and `rateLimited` a
 * secondary signal (GitHub's `x-ratelimit-remaining: 0`), both read off the
 * response headers by the caller.
 */
export function classifyStatus(
  status: number,
  retryAfter: number | null,
  rateLimited = false,
): { code: RemoteApiCode; retryable: boolean } {
  if (status === 401) return { code: 'auth', retryable: false };
  if (status === 403) {
    return retryAfter !== null || rateLimited
      ? { code: 'rate_limit', retryable: true }
      : { code: 'permission', retryable: false };
  }
  if (status === 404) return { code: 'not_found', retryable: false };
  if (status === 409) return { code: 'conflict', retryable: false };
  if (status === 429) return { code: 'rate_limit', retryable: true };
  if (status === 408 || status >= 500) return { code: 'server', retryable: true };
  if (status >= 400 && status < 500) return { code: 'client', retryable: false };
  return { code: 'unknown', retryable: false };
}
