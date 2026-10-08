/**
 * Request budget (LP-297): a decorator that stops a runaway sync before it
 * exhausts a shared token, and says how far it got.
 *
 * A budget is a cap on the total cost of the requests a sync makes. For REST
 * and process connectors each request costs 1; for GraphQL the cost is the
 * point cost the server reports on each response (`x-ratelimit-cost`), so a
 * query worth 50 points spends 50, not 1. The budget is checked before a
 * request and charged after it succeeds — a single request whose cost exceeds
 * what is left is allowed to finish, because its cost is only known from the
 * response — and the *next* request is refused with `BudgetExhaustedError`. A
 * request the remote refused is not charged: the token was not consumed by it.
 */

import type { Connector, ConnectorKind, RemoteRequest, RemoteResponse } from './connector.js';
import { purposeOf, readHeader } from './http.js';

export interface BudgetOptions {
  /** Total cost units the sync may spend. */
  readonly limit: number;
  /**
   * The cost of one response, defaulting to `costOfResponse` (GraphQL point
   * costs, 1 otherwise). Overridable so a provider whose cost is reported
   * under another header can teach the budget to read it.
   */
  readonly costOf?: (kind: ConnectorKind, headers: Readonly<Record<string, string>>) => number;
  /** Called after each charged response, so the CLI/server can show progress. */
  readonly onSpend?: (spend: BudgetSpend) => void;
}

export interface BudgetSpend {
  readonly consumed: number;
  readonly limit: number;
  readonly cost: number;
  readonly purpose: string;
}

/** One response's cost: the GraphQL point cost when reported, else 1. */
export function costOfResponse(
  kind: ConnectorKind,
  headers: Readonly<Record<string, string>>,
): number {
  if (kind === 'graphql') {
    const raw = readHeader(headers, 'x-ratelimit-cost');
    if (raw !== undefined) {
      const cost = Number(raw);
      if (Number.isFinite(cost) && cost >= 0) return cost;
    }
  }
  return 1;
}

/** The budget is spent: the sync is stopped before the next request goes out. */
export class BudgetExhaustedError extends Error {
  readonly consumed: number;
  readonly limit: number;
  readonly purpose: string;

  constructor(consumed: number, limit: number, purpose: string) {
    super(`request budget exhausted while ${purpose}: ${consumed} of ${limit} units already spent`);
    this.name = 'BudgetExhaustedError';
    this.consumed = consumed;
    this.limit = limit;
    this.purpose = purpose;
  }

  hints(): string[] {
    return [
      `${this.consumed} of ${this.limit} request units were spent before the budget stopped the sync`,
    ];
  }
}

/**
 * Wrap a connector so each request spends from a shared budget and the next
 * request after it runs dry is refused. Compose outside `withRetry` so every
 * retry attempt is charged: `withRetry(withBudget(connector, budget), retry)`.
 */
export function withBudget(inner: Connector, options: BudgetOptions): Connector {
  const limit = options.limit;
  const costOf = options.costOf ?? costOfResponse;
  let consumed = 0;

  return {
    ...inner,
    async request<T>(req: RemoteRequest): Promise<RemoteResponse<T>> {
      if (consumed >= limit) {
        throw new BudgetExhaustedError(consumed, limit, purposeOf(req));
      }
      const response = await inner.request<T>(req);
      const cost = costOf(inner.kind, response.headers);
      consumed += cost;
      options.onSpend?.({ consumed, limit, cost, purpose: purposeOf(req) });
      return response;
    },
  };
}
