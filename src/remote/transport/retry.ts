/**
 * Retry, rate-limit waits and backoff (LP-297): a decorator over the
 * `Connector` interface that makes a sync slow down instead of falling over.
 *
 * The rules live here, once, below the providers (LP-246), so a provider
 * cannot bypass them:
 *
 *   - A rate limit (429, or a 403 the transport classified as one) waits out
 *     the reset the transport reported (`Retry-After` or `x-ratelimit-reset`),
 *     then re-sends. A rate limit means the remote rejected the request
 *     *without* processing it, so this is safe even for a write.
 *   - A 5xx, timeout or network failure is retried with exponential backoff
 *     and jitter, capped — but only for an idempotent request (GET/PUT/DELETE)
 *     or one carrying an idempotency key. A write with no key is the
 *     dangerous case (LP-297's note): re-sending it can file a duplicate, so
 *     it is surfaced as `NonIdempotentWriteError` for a person to decide.
 *   - Every wait is injectable (`sleep`), so tests record delays instead of
 *     sleeping through them.
 */

import type { Connector, RemoteRequest, RemoteResponse } from './connector.js';
import { RemoteError } from './error.js';
import { purposeOf } from './http.js';

/** An injectable wait. The default sleeps for real; tests record the delay. */
export type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The methods re-sending cannot change the outcome of. POST and PATCH are not. */
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(['GET', 'PUT', 'DELETE']);

/** A request is safe to re-send when its method is idempotent or it carries a key. */
export function isIdempotent(req: RemoteRequest): boolean {
  return IDEMPOTENT_METHODS.has(req.method) || (req.idempotencyKey !== undefined && req.idempotencyKey !== '');
}

/** Why a retry is being scheduled. */
export type RetryReason = 'rate_limit' | 'backoff';

/** A retry that is about to happen, reported before the wait. */
export interface RetryAttempt {
  /** 1-based retry number: 1 is the first re-send, not the original call. */
  readonly attempt: number;
  readonly reason: RetryReason;
  readonly delayMs: number;
  readonly purpose: string;
  readonly error: RemoteError;
}

/** A wait the connector actually slept through, reported for notable waits only. */
export interface RetryWait {
  readonly reason: RetryReason;
  readonly ms: number;
  readonly attempt: number;
  readonly purpose: string;
}

export interface RetryOptions {
  /** Injectable wait; defaults to `setTimeout`. Tests record the delay. */
  readonly sleep?: Sleep;
  /** Total attempts per request, first call included. Defaults to 3. */
  readonly maxAttempts?: number;
  /** Backoff base: the delay of the first retry before jitter. Defaults to 250. */
  readonly baseDelayMs?: number;
  /** Backoff cap. Defaults to 10_000. */
  readonly maxDelayMs?: number;
  /**
   * Jitter as a fraction of the raw delay, applied ±. Defaults to 0.1; set 0
   * to disable (deterministic tests).
   */
  readonly jitter?: number;
  /** Injectable randomness, so jitter is testable. Defaults to `Math.random`. */
  readonly random?: () => number;
  /** The wait when the transport said "rate limited" but gave no reset. Defaults to 60_000. */
  readonly rateLimitWaitMs?: number;
  /**
   * Waits at or above this many milliseconds are reported through `onWait`;
   * shorter backoffs only go through `onRetry`. Defaults to 5_000 ("a few
   * seconds", LP-297).
   */
  readonly reportWaitThresholdMs?: number;
  /** Called every time a retry is scheduled, before the wait. */
  readonly onRetry?: (attempt: RetryAttempt) => void;
  /** Called when the connector waits long enough to be worth telling a person. */
  readonly onWait?: (wait: RetryWait) => void;
}

/**
 * A retryable failure on a write with no idempotency key. `withRetry` refuses
 * to re-send it — a duplicate is the one thing a backoff cannot undo — and
 * surfaces this instead so a person decides whether the remote actually
 * applied the write.
 */
export class NonIdempotentWriteError extends RemoteError {
  constructor(cause: RemoteError) {
    super({
      kind: cause.kind,
      status: cause.status,
      code: cause.code,
      retryable: false,
      purpose: cause.purpose,
      providerMessage: cause.providerMessage,
      detail: cause.detail,
      message: `the remote failed while ${cause.purpose}; the write was not retried because it is not idempotent — check the remote before re-running`,
      cause,
    });
    this.name = 'NonIdempotentWriteError';
  }

  override hints(): string[] {
    return [
      ...super.hints(),
      'the write may already have been applied — check the remote before re-running',
    ];
  }
}

/** The exponential backoff delay for one retry, with centred jitter. */
export function backoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitter: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempt - 1);
  const raw = Math.min(maxDelayMs, baseDelayMs * 2 ** exponent);
  if (jitter <= 0) return Math.round(raw);
  const spread = raw * jitter;
  const delta = (random() * 2 - 1) * spread;
  return Math.max(0, Math.round(raw + delta));
}

function shouldRetry(error: RemoteError, req: RemoteRequest): boolean {
  if (!error.retryable) return false;
  // A rate limit is always safe to re-send after waiting: the remote rejected
  // the request without processing it, so there is nothing to duplicate.
  if (error.code === 'rate_limit') return true;
  return isIdempotent(req);
}

/**
 * Wrap a connector so every request — and every page of a `paginate` walk,
 * because REST and GraphQL page through their own `request` — is retried
 * under the rules above. Compose inside `withBudget` so each retry attempt is
 * budgeted: `withRetry(withBudget(connector, budget), retry)`.
 */
export function withRetry(inner: Connector, options: RetryOptions = {}): Connector {
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 10_000;
  const jitter = options.jitter ?? 0.1;
  const random = options.random ?? Math.random;
  const rateLimitWaitMs = options.rateLimitWaitMs ?? 60_000;
  const reportWaitThresholdMs = options.reportWaitThresholdMs ?? 5_000;

  async function attempt<T>(req: RemoteRequest): Promise<RemoteResponse<T>> {
    let attemptNumber = 0;
    for (;;) {
      attemptNumber += 1;
      try {
        return await inner.request<T>(req);
      } catch (error) {
        if (!(error instanceof RemoteError)) throw error;
        if (!shouldRetry(error, req)) {
          throw error.retryable ? new NonIdempotentWriteError(error) : error;
        }
        if (attemptNumber >= maxAttempts) throw error;

        const reason: RetryReason = error.code === 'rate_limit' ? 'rate_limit' : 'backoff';
        const delayMs =
          reason === 'rate_limit'
            ? (error.retryAfterMs ?? rateLimitWaitMs)
            : backoffDelay(attemptNumber, baseDelayMs, maxDelayMs, jitter, random);

        options.onRetry?.({
          attempt: attemptNumber,
          reason,
          delayMs,
          purpose: purposeOf(req),
          error,
        });
        if (delayMs >= reportWaitThresholdMs) {
          options.onWait?.({
            reason,
            ms: delayMs,
            attempt: attemptNumber,
            purpose: purposeOf(req),
          });
        }
        await sleep(delayMs);
      }
    }
  }

  // Spread, not a new object: `paginate` stays the inner connector's method,
  // but calling it through this wrapper binds `this` to the wrapper — so a
  // `paginate` that pages through `this.request` re-sends each page through
  // the retrying `attempt` here, not the plain inner request.
  return {
    ...inner,
    request: attempt,
  };
}
