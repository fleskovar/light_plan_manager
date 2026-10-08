/**
 * The in-memory tracker (LP-299): a `Connector` of kind `'memory'` that
 * simulates a remote issue tracker inside a test process.
 *
 * This is the fake the provider conformance suite (LP-300) runs every provider
 * against, so a provider is tested offline — no tokens, no network, no
 * flakiness. It implements the *whole* transport contract from LP-293
 * (`request`, `paginate`, `close`, and the `'memory'` kind reserved for it),
 * and answers the same request shapes a real connector does: the same
 * `RemoteRequest` in, the same `RemoteResponse` out, and the same `RemoteError`
 * on a non-2xx — classified through the exact `classifyStatus` the REST
 * connector uses, so a 403 that is a rate limit and a 403 that is a permission
 * produce different errors here too.
 *
 * Unlike `src/remote/transport/`, this file *does* know about boards — it
 * stores issues, custom fields, labels, assignees, comments and dependency
 * edges, because it is the stand-in for a tracker, not for a transport. That
 * is exactly why it lives in `test/support/` rather than in `src/`: it is a
 * test double, never shipped.
 *
 * Three properties are the point of the whole thing:
 *
 *   - **Awkward by default.** A write normalises markdown (CRLF → LF, a single
 *     trailing newline) and reorders labels (sorted, deduped). A fake that
 *     echoes back exactly what it was sent makes a round-trip test worthless;
 *     this one forces the sync to absorb the normalisation, which is what a
 *     real tracker does (LP-288).
 *   - **Its own clock.** `updated_at` is stamped from an injectable clock, and
 *     a `since` query filters by it. Tests move the clock to make time pass
 *     without sleeping.
 *   - **Failure and capability are data.** A test induces a 429, a 500, a
 *     permission error or a partial page with `failNext`; it configures the
 *     capability probes the provider will make so the degraded path is
 *     testable.
 */

import type {
  Connector,
  HttpMethod,
  RemoteRequest,
  RemoteResponse,
} from '../../src/remote/transport/connector.js';
import {
  classifyStatus,
  providerMessageOf,
  RemoteError,
} from '../../src/remote/transport/error.js';
import { nextLink, purposeOf, readPath, retryAfterMs } from '../../src/remote/transport/http.js';

// ---------------------------------------------------------------------------
// The stored model
// ---------------------------------------------------------------------------

/** One issue as the tracker holds it, before the wire shape. */
export interface StoredIssue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  /**
   * The Linear workflow state name, when the issue was written through the
   * Linear GraphQL surface. GitHub REST writes `state` instead and leaves
   * this absent.
   */
  workflowState?: string;
  /** The Linear estimate, when set through the GraphQL surface (LP-333). */
  estimate?: number | null;
  labels: string[];
  assignees: string[];
  /** Arbitrary custom fields, keyed by field name. */
  fields: Record<string, unknown>;
  /** The numbers of the issues this one depends on (its edges). */
  dependencies: number[];
  /** The numbers this issue is the source of a `related` relation with. */
  related?: number[];
  /** The Linear cycle this issue is scheduled into, when written through the GraphQL surface. */
  cycle?: { name: string; number?: number; startsAt?: string; endsAt?: string } | null;
  /** The number of this issue's native parent, or null at the root. */
  parent: number | null;
  /** The repository milestone number, or null when the issue sits in none. */
  milestone: number | null;
  created_at: string;
  updated_at: string;
}

/** One comment as the tracker holds it. */
export interface StoredComment {
  id: number;
  body: string;
  created_at: string;
  updated_at: string;
}

/** A wire record, in the provider's own shape — GitHub-flavoured here. */
export type TrackerRecord = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** The capability record a test configures; the fake's probes answer from it. */
export interface MemoryCapabilities {
  /**
   * `GET /orgs/:owner/issue-types` — an empty list reads as "no native types"
   * to a provider that probes it; a non-empty one as "native types present".
   * Defaults to `false`.
   */
  nativeTypes?: boolean;
  /**
   * `GET /orgs/:owner/issue-fields` — the custom-field value types the tracker
   * holds, or `null` for none. Defaults to `null`.
   */
  customFields?: { valueTypes: readonly string[] } | null;
  /**
   * Sub-issues (LP-309): when true, issue records carry a `parent` field and
   * the sub-issues endpoints answer, so a provider probing for the API reads
   * it as present. Defaults to `false` — a flat tracker.
   */
  subIssues?: boolean;
}

/** A failure a test induces: an HTTP status, or a page that ends mid-walk. */
export type Failure =
  | {
      readonly status: number;
      /** The provider's own words, carried on the `RemoteError`. */
      readonly message?: string;
      /** Seconds in a `Retry-After` header — what turns a 403 into a rate limit. */
      readonly retryAfterSeconds?: number;
    }
  | {
      /**
       * Serve the first page of a `paginate` walk, then fail the next page's
       * request with a 500 — the "you got a partial page, then the wire broke"
       * case that a retrying paginator must survive.
       */
      readonly kind: 'partial_page';
    };

/** A failure rule: the failure fires when the request matches `match`. */
export interface FailureRule {
  /** Defaults to matching every request. */
  readonly match?: (req: RemoteRequest) => boolean;
  readonly failure: Failure;
  /** How many times it fires before exhausting; defaults to 1. */
  times?: number;
}

/** An issue the tracker starts with, for "pull of a remote-only issue". */
export interface SeedIssue {
  number?: number;
  title: string;
  body?: string;
  state?: 'open' | 'closed';
  /** Linear workflow state name, for a seed written through the Linear surface. */
  workflowState?: string;
  /** Linear estimate, for a seed written through the Linear surface. */
  estimate?: number | null;
  labels?: string[];
  assignees?: string[];
  fields?: Record<string, unknown>;
  dependencies?: number[];
  /** The numbers this issue is the source of a `related` relation with. */
  related?: number[];
  /** The number of this issue's native parent, or null at the root. */
  parent?: number | null;
  /** The repository milestone number, or null when the issue sits in none. */
  milestone?: number | null;
  created_at?: string;
  updated_at?: string;
}

export interface MemoryConnectorOptions {
  /** The repo slug routes are matched against. Defaults to `acme/payments`. */
  repo?: string;
  /** The clock the tracker stamps `updated_at` from. Defaults to `Date.now`. */
  now?: () => number;
  /** Capability-probe answers. See `MemoryCapabilities`. */
  capabilities?: MemoryCapabilities;
  /** Failure rules, applied in order, one request at a time. */
  failures?: FailureRule[];
  /** Markdown normalisation on write. Defaults to CRLF→LF + one trailing newline. */
  normalizeMarkdown?: (body: string) => string;
  /** Label ordering on write. Defaults to sort + dedupe. */
  orderLabels?: (labels: string[]) => string[];
  /** Issues to preload. */
  seed?: SeedIssue[];
  /** Repository labels to preload, as names. */
  labels?: string[];
  /** The page size a list request uses when none is asked for. Defaults to 100. */
  perPage?: number;
}

/** The default markdown normalisation: CRLF → LF, exactly one trailing newline. */
export function normalizeMarkdown(body: string): string {
  const lf = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const trimmed = lf.replace(/\n+$/, '');
  return `${trimmed}\n`;
}

/** The default label ordering: sorted, deduped. */
export function orderLabels(labels: string[]): string[] {
  return [...new Set(labels)].sort();
}

// ---------------------------------------------------------------------------
// The factory
// ---------------------------------------------------------------------------

/** What `memoryConnector` returns: the transport contract plus inspection. */
export interface MemoryConnector extends Connector {
  readonly kind: 'memory';
  /** Every stored issue, keyed by number. */
  issues(): ReadonlyMap<number, StoredIssue>;
  /** The comments on one issue, in creation order. */
  comments(issueNumber: number): StoredComment[];
  /** The numbers an issue depends on. */
  dependencies(issueNumber: number): number[];
  /** The repository's label names, sorted. */
  labels(): string[];
  /** Every stored issue as a wire record, for a pull snapshot. */
  records(): TrackerRecord[];
  /** Every stored issue as a Linear-flavoured wire record, for a Linear pull snapshot. */
  linearRecords(): TrackerRecord[];
  /** Induce a one-shot failure on the next matching request. */
  failNext(failure: Failure, match?: (req: RemoteRequest) => boolean): void;
  /** Mutate one stored issue directly, as a human would on the remote. */
  mutateIssue(remoteId: string, patch: Partial<StoredIssue>): void;
  /** Hard-delete one stored issue directly, as a human would on the remote. */
  deleteIssue(remoteId: string): void;
  /** Pin the clock to a fixed time. */
  setNow(ms: number): void;
  /** Toggle the sub-issues capability after construction (LP-493 switch tests). */
  setSubIssues(enabled: boolean): void;
  /** Move the clock forward by `ms` from wherever it currently is. */
  advance(ms: number): void;
  /** Read the current clock. */
  now(): number;
  /**
   * The same tracker behind a `fetch`-shaped function, so a provider connector
   * that talks raw `fetch` (the GitHub one, today) can be pointed at it.
   * Returns a real `Response` for every status — it never throws for an HTTP
   * error, exactly like `fetch` — so a connector that special-cases a 404
   * keeps working.
   */
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

/** The decoded result of one dispatch, before it becomes a response or an error. */
interface DispatchResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

function ok(status: number): boolean {
  return status >= 200 && status < 300;
}

function isStatusFailure(f: Failure): f is Exclude<Failure, { kind: 'partial_page' }> {
  return 'status' in f;
}

/** Normalise an absolute or relative path, and split off any `?query`. */
function splitPath(raw: string): { path: string; query: Record<string, string> } {
  const [pathPart, queryPart] = raw.split('?');
  let path = pathPart ?? '';
  const match = /^https?:\/\/[^/]+(\/.*)$/.exec(path);
  if (match) path = match[1]!;
  if (!path.startsWith('/')) path = `/${path}`;
  const query: Record<string, string> = {};
  if (queryPart) {
    for (const [key, value] of new URLSearchParams(queryPart)) query[key] = value;
  }
  return { path, query };
}

/** Merge a path's query with `req.query`, stringifying numbers and dropping `undefined`. */
function mergeQuery(
  pathQuery: Record<string, string>,
  reqQuery?: Readonly<Record<string, string | number | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = { ...pathQuery };
  if (reqQuery) {
    for (const [key, value] of Object.entries(reqQuery)) {
      if (value !== undefined) out[key] = String(value);
    }
  }
  return out;
}

/** A `HeadersInit` record as a plain string map, whatever shape it arrived in. */
function normalizeHeaders(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const headers = init?.headers;
  if (headers === undefined) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      const key = entry[0];
      if (key !== undefined) out[key] = entry[1] ?? '';
    }
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    out[key] = typeof value === 'string' ? value : value.join(', ');
  }
  return out;
}

/** A route a request's method + path resolves to. */
type Route =
  | { kind: 'repo'; owner: string; name: string }
  | { kind: 'issues'; owner: string; name: string }
  | { kind: 'issue'; owner: string; name: string; number: number }
  | { kind: 'comments'; owner: string; name: string; number: number }
  | { kind: 'comment'; owner: string; name: string; commentId: number }
  | { kind: 'dependencies'; owner: string; name: string; number: number }
  | { kind: 'dependency'; owner: string; name: string; number: number; depNumber: number }
  | { kind: 'milestones'; owner: string; name: string }
  | { kind: 'sub-issues'; owner: string; name: string; number: number }
  | { kind: 'sub-issue'; owner: string; name: string; number: number }
  | { kind: 'issue-types'; owner: string }
  | { kind: 'issue-fields'; owner: string }
  | { kind: 'labels'; owner: string; name: string }
  | { kind: 'graphql' };

function routeOf(path: string): Route | null {
  const own = '([^/]+)';
  const num = '(\\d+)';
  let m: RegExpExecArray | null;

  m = new RegExp(`^/repos/${own}/${own}$`).exec(path);
  if (m) return { kind: 'repo', owner: m[1]!, name: m[2]! };

  m = new RegExp(`^/repos/${own}/${own}/issues$`).exec(path);
  if (m) return { kind: 'issues', owner: m[1]!, name: m[2]! };

  m = new RegExp(`^/repos/${own}/${own}/issues/${num}$`).exec(path);
  if (m) return { kind: 'issue', owner: m[1]!, name: m[2]!, number: Number(m[3]) };

  m = new RegExp(`^/repos/${own}/${own}/issues/${num}/comments$`).exec(path);
  if (m) return { kind: 'comments', owner: m[1]!, name: m[2]!, number: Number(m[3]) };

  m = new RegExp(`^/repos/${own}/${own}/issues/comments/${num}$`).exec(path);
  if (m) return { kind: 'comment', owner: m[1]!, name: m[2]!, commentId: Number(m[3]) };

  m = new RegExp(`^/repos/${own}/${own}/issues/${num}/dependencies$`).exec(path);
  if (m) return { kind: 'dependencies', owner: m[1]!, name: m[2]!, number: Number(m[3]) };

  m = new RegExp(`^/repos/${own}/${own}/issues/${num}/dependencies/${num}$`).exec(path);
  if (m) {
    return {
      kind: 'dependency',
      owner: m[1]!,
      name: m[2]!,
      number: Number(m[3]),
      depNumber: Number(m[4]),
    };
  }

  m = new RegExp(`^/repos/${own}/${own}/milestones$`).exec(path);
  if (m) return { kind: 'milestones', owner: m[1]!, name: m[2]! };

  m = new RegExp(`^/repos/${own}/${own}/issues/${num}/sub_issues$`).exec(path);
  if (m) return { kind: 'sub-issues', owner: m[1]!, name: m[2]!, number: Number(m[3]) };

  m = new RegExp(`^/repos/${own}/${own}/issues/${num}/sub_issue$`).exec(path);
  if (m) return { kind: 'sub-issue', owner: m[1]!, name: m[2]!, number: Number(m[3]) };

  m = new RegExp(`^/orgs/${own}/issue-types$`).exec(path);
  if (m) return { kind: 'issue-types', owner: m[1]! };

  m = new RegExp(`^/orgs/${own}/issue-fields$`).exec(path);
  if (m) return { kind: 'issue-fields', owner: m[1]! };

  m = new RegExp(`^/repos/${own}/${own}/labels$`).exec(path);
  if (m) return { kind: 'labels', owner: m[1]!, name: m[2]! };

  m = /^\/graphql$/.exec(path);
  if (m) return { kind: 'graphql' };

  return null;
}

export function memoryConnector(options: MemoryConnectorOptions = {}): MemoryConnector {
  const repo = options.repo ?? 'acme/payments';
  const normalize = options.normalizeMarkdown ?? normalizeMarkdown;
  const order = options.orderLabels ?? orderLabels;
  const perPage = options.perPage ?? 100;
  const capabilities = options.capabilities ?? {};
  let subIssues = capabilities.subIssues === true;

  const issues = new Map<number, StoredIssue>();
  const commentsByIssue = new Map<number, StoredComment[]>();
  /** The repository's milestones, keyed by number (GitHub's milestone carrier). */
  const milestones = new Map<
    number,
    { number: number; title: string; due_on: string | null }
  >();
  /** The repository's label list, independent of the issues that carry them. */
  const repoLabels = new Set<string>();
  let nextNumber = 1;
  let nextCommentId = 1;
  let nextMilestoneNumber = 1;

  // The clock: a pinned value wins over the injected function.
  const nowFn = options.now ?? (() => Date.now());
  let pinned: number | null = null;
  const now = (): number => (pinned ?? nowFn());

  // Failure rules, mutable so `times` can be consumed.
  const rules: Array<{ match: (req: RemoteRequest) => boolean; failure: Failure; times: number | null }> =
    (options.failures ?? []).map((rule) => ({
      match: rule.match ?? (() => true),
      failure: rule.failure,
      times: rule.times ?? 1,
    }));

  // A collection whose list walk was poisoned by a `partial_page` failure: the
  // next follow-up page request fails with a 500, so a paginator sees a
  // partial collection and an error instead of a silently truncated one.
  const partialPoisoned = new Set<string>();

  function consumeFailure(
    req: RemoteRequest,
    kind: 'status' | 'partial_page',
  ): Failure | null {
    for (const rule of rules) {
      if (rule.times !== null && rule.times <= 0) continue;
      const wanted = kind === 'status' ? isStatusFailure(rule.failure) : !isStatusFailure(rule.failure);
      if (!wanted) continue;
      if (!rule.match(req)) continue;
      if (rule.times !== null) rule.times -= 1;
      return rule.failure;
    }
    return null;
  }

  // -- wire shapes ----------------------------------------------------------

  /** The milestone object a record carries, or null when the issue sits in none. */
  function milestoneRecord(number: number | null): Record<string, unknown> | null {
    if (number === null) return null;
    const milestone = milestones.get(number);
    if (!milestone) return null;
    return { number: milestone.number, title: milestone.title, due_on: milestone.due_on };
  }

  function issueRecord(issue: StoredIssue): TrackerRecord {
    const record: TrackerRecord = {
      id: issue.number,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((name) => ({ name })),
      assignees: issue.assignees.map((login) => ({ login })),
      assignee: issue.assignees[0] ? { login: issue.assignees[0] } : null,
      fields: issue.fields,
      dependencies: issue.dependencies.map(String),
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      html_url: `https://tracker.invalid/repos/${repo}/issues/${issue.number}`,
      milestone: milestoneRecord(issue.milestone),
    };
    // The `parent` field is GitHub's live signal that sub-issues exist
    // (LP-309); it is present only when the tracker declares the capability.
    if (subIssues) record['parent'] = issue.parent;
    return record;
  }

  /** A Linear-flavoured wire record, as the GraphQL surface returns it. */
  function linearIssueRecord(issue: StoredIssue): TrackerRecord {
    const stateName = issue.workflowState ?? 'Backlog';
    const record: TrackerRecord = {
      id: String(issue.number),
      identifier: `LIN-${issue.number}`,
      title: issue.title,
      description: issue.body,
      state: { id: stateName, name: stateName, type: 'unstarted' },
      labels: issue.labels.map((name) => ({ id: name, name })),
      assignee:
        issue.assignees[0] !== undefined
          ? { id: issue.assignees[0], name: issue.assignees[0], email: issue.assignees[0] }
          : null,
      estimate: issue.estimate ?? null,
      priority: null,
      parent: issue.parent !== null ? { id: String(issue.parent) } : null,
      relations: {
        nodes: [
          // `relations` is the source side: this issue blocks everything that
          // depends on it, and relates to everything it names.
          ...[...issues.values()]
            .filter((other) => other.dependencies.includes(issue.number))
            .map((other) => ({
              id: `rel-${issue.number}-blocks-${other.number}`,
              type: 'blocks',
              issue: { id: String(issue.number) },
              relatedIssue: { id: String(other.number) },
            })),
          ...(issue.related ?? []).map((target) => ({
            id: `rel-${issue.number}-related-${target}`,
            type: 'related',
            issue: { id: String(issue.number) },
            relatedIssue: { id: String(target) },
          })),
        ],
      },
      inverseRelations: {
        nodes: [
          // `inverseRelations` is the target side: everything that blocks this
          // issue, and everything that relates to it.
          ...issue.dependencies.map((blocker) => ({
            id: `rel-${blocker}-blocks-${issue.number}`,
            type: 'blocks',
            issue: { id: String(blocker) },
            relatedIssue: { id: String(issue.number) },
          })),
          ...[...issues.values()]
            .filter((other) => (other.related ?? []).includes(issue.number))
            .map((other) => ({
              id: `rel-${other.number}-related-${issue.number}`,
              type: 'related',
              issue: { id: String(other.number) },
              relatedIssue: { id: String(issue.number) },
            })),
        ],
      },
      cycle: issue.cycle ?? null,
      updatedAt: issue.updated_at,
      url: `https://linear.app/acme/issue/LIN-${issue.number}`,
    };
    return record;
  }

  function commentRecord(issueNumber: number, comment: StoredComment): TrackerRecord {
    return {
      id: comment.id,
      body: comment.body,
      created_at: comment.created_at,
      updated_at: comment.updated_at,
      html_url: `https://tracker.invalid/repos/${repo}/issues/${issueNumber}#issuecomment-${comment.id}`,
    };
  }

  function touch(issue: StoredIssue): void {
    issue.updated_at = new Date(now()).toISOString();
  }

  // -- request helpers --------------------------------------------------------

  function notAllowed(method: HttpMethod): DispatchResult {
    return { status: 405, headers: {}, body: { message: `${method} not allowed here` } };
  }

  function notFound(what: string): DispatchResult {
    return { status: 404, headers: {}, body: { message: `${what} not found` } };
  }

  interface CommentLocation {
    issueNumber: number;
    comment: StoredComment;
  }

  function findComment(commentId: number): CommentLocation | null {
    for (const [issueNumber, list] of commentsByIssue) {
      const comment = list.find((c) => c.id === commentId);
      if (comment) return { issueNumber, comment };
    }
    return null;
  }

  /** The request body as a plain object (empty when none). */
  function readBody(req: RemoteRequest): { body: Record<string, unknown> } {
    const value = req.body;
    if (value === null || value === undefined) return { body: {} };
    if (typeof value === 'object') return { body: value as Record<string, unknown> };
    return { body: {} };
  }

  function stringField(body: Record<string, unknown>, key: string): string | undefined {
    const value = body[key];
    return typeof value === 'string' ? value : undefined;
  }

  function stringArray(body: Record<string, unknown>, key: string): string[] | undefined {
    const value = body[key];
    if (!Array.isArray(value)) return undefined;
    return value
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (
          entry &&
          typeof entry === 'object' &&
          typeof (entry as { login?: unknown }).login === 'string'
        ) {
          return (entry as { login: string }).login;
        }
        return '';
      })
      .filter((entry) => entry.length > 0);
  }

  // -- create / update / list ---------------------------------------------------

  function create(req: RemoteRequest): DispatchResult {
    const { body } = readBody(req);
    const title = stringField(body, 'title') ?? '';
    const number = nextNumber++;
    const at = new Date(now()).toISOString();
    const milestone = typeof body.milestone === 'number' ? body.milestone : null;
    const issue: StoredIssue = {
      number,
      title,
      body: normalize(stringField(body, 'body') ?? ''),
      state: 'open',
      labels: order(stringArray(body, 'labels') ?? []),
      assignees: stringArray(body, 'assignees') ?? [],
      fields: (body.fields as Record<string, unknown> | undefined) ?? {},
      dependencies: [],
      parent: null,
      milestone,
      created_at: at,
      updated_at: at,
    };
    issues.set(number, issue);
    return { status: 201, headers: {}, body: issueRecord(issue) };
  }

  function update(req: RemoteRequest, issue: StoredIssue): DispatchResult {
    const { body } = readBody(req);
    const title = stringField(body, 'title');
    const nextBody = stringField(body, 'body');
    const state = stringField(body, 'state');
    const labels = stringArray(body, 'labels');
    const assignees = stringArray(body, 'assignees');
    const fields = body.fields as Record<string, unknown> | undefined;
    const milestone = body.milestone;

    if (title !== undefined) issue.title = title;
    if (nextBody !== undefined) issue.body = normalize(nextBody);
    if (state === 'open' || state === 'closed') issue.state = state;
    if (labels !== undefined) issue.labels = order(labels);
    if (assignees !== undefined) issue.assignees = assignees;
    if (fields !== undefined) issue.fields = fields;
    if (milestone === null) issue.milestone = null;
    else if (typeof milestone === 'number') issue.milestone = milestone;
    touch(issue);
    return { status: 200, headers: {}, body: issueRecord(issue) };
  }

  function list(req: RemoteRequest, query: Record<string, string>, repoKey: string): DispatchResult {
    const spec = req.pagination;
    const pageNumber = pageNumberOf(req, query);

    // A `partial_page` failure poisons the *next* page of the same collection:
    // page one served normally, the follow-up request fails with a 500.
    if (pageNumber > 1 && partialPoisoned.has(repoKey)) {
      partialPoisoned.delete(repoKey);
      return { status: 500, headers: {}, body: { message: 'connection dropped mid-page' } };
    }

    const state = query.state ?? 'open';
    const since = query.since;
    const size = Number(query.per_page ?? perPage);
    const pageSize = Number.isFinite(size) && size > 0 ? size : perPage;

    let filtered = [...issues.values()];
    if (state === 'open' || state === 'closed') filtered = filtered.filter((i) => i.state === state);
    if (since !== undefined && since !== '') {
      filtered = filtered.filter((i) => i.updated_at >= since);
    }
    filtered.sort((a, b) => a.number - b.number);

    const start = (pageNumber - 1) * pageSize;
    const slice = filtered.slice(start, start + pageSize);
    const hasMore = start + slice.length < filtered.length;
    const records = slice.map(issueRecord);

    // A `partial_page` failure matched *this* page poisons the next one.
    if (consumeFailure(req, 'partial_page') !== null) partialPoisoned.add(repoKey);

    // No pagination spec: a single bare array, the shape a raw list returns.
    if (spec === undefined || spec.kind === 'graphql') {
      return { status: 200, headers: {}, body: records };
    }

    // Cursor spec: the body carries the items plus the next cursor at the
    // path the caller named.
    if (spec.kind === 'cursor') {
      const body: Record<string, unknown> = { items: records };
      placeAtPath(body, spec.nextCursorPath, hasMore ? String(pageNumber + 1) : null);
      return { status: 200, headers: {}, body };
    }

    // Link spec: a `rel="next"` header points at the next page.
    const headers: Record<string, string> = {};
    if (hasMore) {
      headers['link'] = `<https://tracker.invalid/repos/${repoKey}/issues?page=${pageNumber + 1}>; rel="next"`;
    }
    return { status: 200, headers, body: records };
  }

  function pageNumberOf(req: RemoteRequest, query: Record<string, string>): number {
    const spec = req.pagination;
    const fromPage = Number(query.page);
    if (Number.isFinite(fromPage) && fromPage > 0) return fromPage;
    if (spec !== undefined && spec.kind === 'cursor') {
      const cursor = query[spec.cursorParam];
      const n = Number(cursor);
      if (cursor !== undefined && cursor !== '' && Number.isFinite(n) && n > 0) return n;
    }
    return 1;
  }

  function addComment(req: RemoteRequest, issueNumber: number): DispatchResult {
    if (!issues.has(issueNumber)) return notFound(`issue #${issueNumber}`);
    const { body } = readBody(req);
    const at = new Date(now()).toISOString();
    const comment: StoredComment = {
      id: nextCommentId++,
      body: stringField(body, 'body') ?? '',
      created_at: at,
      updated_at: at,
    };
    const list = commentsByIssue.get(issueNumber) ?? [];
    list.push(comment);
    commentsByIssue.set(issueNumber, list);
    return { status: 201, headers: {}, body: commentRecord(issueNumber, comment) };
  }

  // -- dispatch -------------------------------------------------------------

  /**
   * Serve the Linear GraphQL surface — the same shared store, addressed the
   * way Linear addresses it. Operation names are matched, not the full
   * document, so the connector and this fake agree on the handful of
   * operations the conformance suite exercises. Numeric ids stand in for
   * Linear's UUIDs; state / label names stand in for their ids (the real
   * resolution is LP-333 / LP-334's).
   */
  function linearGraphql(query: string, variables: Record<string, unknown>): DispatchResult {
    const opMatch = /(?:mutation|query)\s+([A-Za-z0-9_]+)/.exec(query);
    const op = opMatch ? opMatch[1]! : '';
    const input = (variables['input'] ?? {}) as Record<string, unknown>;
    const readString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
    const readEstimate = (v: unknown): number | null | undefined => {
      if (v === null) return null;
      return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    };
    const gqlData = (data: Record<string, unknown>): DispatchResult => ({
      status: 200,
      headers: {},
      body: { data },
    });

    switch (op) {
      case 'IssueCreate': {
        const number = nextNumber++;
        const at = new Date(now()).toISOString();
        const assigneeId = readString(input['assigneeId']);
        const parentId = readString(input['parentId']);
        const cycleId = readString(input['cycleId']);
        const labelIds = Array.isArray(input['labelIds'])
          ? input['labelIds'].filter((v): v is string => typeof v === 'string')
          : [];
        const issue: StoredIssue = {
          number,
          title: readString(input['title']) ?? '',
          body: normalize(readString(input['description']) ?? ''),
          state: 'open',
          workflowState: readString(input['stateId']) ?? 'Backlog',
          estimate: readEstimate(input['estimate']),
          labels: order(labelIds),
          assignees: assigneeId ? [assigneeId] : [],
          fields: {},
          dependencies: [],
          related: [],
          parent: parentId ? Number(parentId) : null,
          milestone: null,
          cycle: cycleId ? { name: cycleId } : null,
          created_at: at,
          updated_at: at,
        };
        issues.set(number, issue);
        return gqlData({ issueCreate: { success: true, issue: linearIssueRecord(issue) } });
      }

      case 'IssueUpdate': {
        const issue = issues.get(Number(readString(variables['id'])));
        if (!issue) return gqlData({ issueUpdate: { success: false, issue: null } });
        if (input['title'] !== undefined) issue.title = readString(input['title']) ?? issue.title;
        if (input['description'] !== undefined) {
          issue.body = normalize(readString(input['description']) ?? '');
        }
        if (input['stateId'] !== undefined) {
          issue.workflowState = readString(input['stateId']);
        }
        if (input['estimate'] !== undefined) {
          issue.estimate = readEstimate(input['estimate']);
        }
        if (input['labelIds'] !== undefined) {
          const labelIds = Array.isArray(input['labelIds'])
            ? input['labelIds'].filter((v): v is string => typeof v === 'string')
            : [];
          issue.labels = order(labelIds);
        }
        if (input['assigneeId'] !== undefined) {
          const assigneeId = readString(input['assigneeId']);
          issue.assignees = assigneeId ? [assigneeId] : [];
        }
        if (input['parentId'] !== undefined) {
          const parentId = readString(input['parentId']);
          issue.parent = parentId ? Number(parentId) : null;
        }
        if (input['cycleId'] !== undefined) {
          const cycleId = readString(input['cycleId']);
          issue.cycle = cycleId ? { name: cycleId } : null;
        }
        touch(issue);
        return gqlData({ issueUpdate: { success: true, issue: linearIssueRecord(issue) } });
      }

      case 'IssueDelete': {
        const number = Number(readString(variables['id']));
        issues.delete(number);
        commentsByIssue.delete(number);
        return gqlData({ issueDelete: { success: true } });
      }

      case 'Issue': {
        const issue = issues.get(Number(readString(variables['id'])));
        return gqlData({ issue: issue ? linearIssueRecord(issue) : null });
      }

      case 'Issues': {
        const filter = (variables['filter'] ?? {}) as Record<string, unknown>;
        const updatedAt = filter['updatedAt'] as Record<string, unknown> | undefined;
        const gte = typeof updatedAt?.['gte'] === 'string' ? updatedAt['gte'] : undefined;
        const first = typeof variables['first'] === 'number' ? variables['first'] : 50;
        const after = readString(variables['after']);
        let list = [...issues.values()].sort((a, b) => a.number - b.number);
        if (gte !== undefined) list = list.filter((i) => i.updated_at >= gte);
        const pageNumber = after ? Number(after) : 1;
        const start = (pageNumber - 1) * first;
        const slice = list.slice(start, start + first);
        const hasMore = start + slice.length < list.length;
        return gqlData({
          issues: {
            nodes: slice.map(linearIssueRecord),
            pageInfo: { hasNextPage: hasMore, endCursor: hasMore ? String(pageNumber + 1) : null },
          },
        });
      }

      case 'IssueRelationCreate': {
        const issueId = Number(readString(input['issueId']));
        const relatedId = Number(readString(input['relatedIssueId']));
        const type = readString(input['type']);
        if (type === 'blocks' && Number.isFinite(relatedId)) {
          // `issueId` blocks `relatedIssueId` (LP-334): the blocked issue
          // depends on the blocker.
          const blocked = issues.get(relatedId);
          if (blocked && !blocked.dependencies.includes(issueId)) {
            blocked.dependencies.push(issueId);
            touch(blocked);
          }
        } else if (type === 'related' && Number.isFinite(relatedId)) {
          const source = issues.get(issueId);
          if (source) {
            source.related = source.related ?? [];
            if (!source.related.includes(relatedId)) {
              source.related.push(relatedId);
              touch(source);
            }
          }
        }
        return gqlData({ issueRelationCreate: { success: true } });
      }

      case 'IssueRelationDelete': {
        const relationId = readString(variables['id']) ?? '';
        const blocks = /^rel-(\d+)-blocks-(\d+)$/.exec(relationId);
        const related = /^rel-(\d+)-related-(\d+)$/.exec(relationId);
        if (blocks) {
          const blocked = issues.get(Number(blocks[2]));
          if (blocked) {
            blocked.dependencies = blocked.dependencies.filter((n) => n !== Number(blocks[1]));
            touch(blocked);
          }
        } else if (related) {
          const source = issues.get(Number(related[1]));
          if (source) {
            source.related = (source.related ?? []).filter((n) => n !== Number(related[2]));
            touch(source);
          }
        }
        return gqlData({ issueRelationDelete: { success: true } });
      }

      case 'CommentCreate': {
        const issueNumber = Number(readString(input['issueId']));
        const issue = issues.get(issueNumber);
        if (!issue) return notFound(`issue #${issueNumber}`);
        const at = new Date(now()).toISOString();
        const comment: StoredComment = {
          id: nextCommentId++,
          body: readString(input['body']) ?? '',
          created_at: at,
          updated_at: at,
        };
        const list = commentsByIssue.get(issueNumber) ?? [];
        list.push(comment);
        commentsByIssue.set(issueNumber, list);
        return gqlData({ commentCreate: { success: true, comment: { id: String(comment.id) } } });
      }

      case 'CommentUpdate': {
        const commentId = Number(readString(variables['id']));
        const found = findComment(commentId);
        if (!found) return notFound(`comment #${commentId}`);
        if (input['body'] !== undefined) {
          found.comment.body = readString(input['body']) ?? found.comment.body;
        }
        found.comment.updated_at = new Date(now()).toISOString();
        return gqlData({ commentUpdate: { success: true } });
      }

      case 'CommentDelete': {
        const commentId = Number(readString(variables['id']));
        const found = findComment(commentId);
        if (!found) return notFound(`comment #${commentId}`);
        const list = commentsByIssue.get(found.issueNumber) ?? [];
        commentsByIssue.set(
          found.issueNumber,
          list.filter((c) => c.id !== commentId),
        );
        return gqlData({ commentDelete: { success: true } });
      }

      case 'Comments': {
        const issueNumber = Number(readString(variables['issueId']));
        const list = commentsByIssue.get(issueNumber) ?? [];
        return gqlData({
          issue: {
            comments: {
              nodes: list.map((comment) => ({
                id: String(comment.id),
                body: comment.body,
                createdAt: comment.created_at,
                user: { name: '' },
              })),
            },
          },
        });
      }

      case 'Team': {
        return gqlData({ team: { id: variables['id'], name: 'Acme' } });
      }

      default:
        return {
          status: 400,
          headers: {},
          body: { errors: [{ message: `unknown operation ${op}` }] },
        };
    }
  }

  async function dispatch(req: RemoteRequest): Promise<DispatchResult> {
    // Induced status failures fire before routing, exactly as a transport
    // would refuse the request before the server sees it.
    const statusFailure = consumeFailure(req, 'status');
    if (statusFailure && isStatusFailure(statusFailure)) {
      const headers: Record<string, string> = {};
      if (statusFailure.retryAfterSeconds !== undefined) {
        headers['retry-after'] = String(statusFailure.retryAfterSeconds);
      }
      return {
        status: statusFailure.status,
        headers,
        body: statusFailure.message !== undefined ? { message: statusFailure.message } : null,
      };
    }

    const { path, query: pathQuery } = splitPath(req.path);
    const query: Record<string, string> = mergeQuery(pathQuery, req.query);
    const routed = routeOf(path);
    const method = req.method;

    if (routed === null) {
      return { status: 404, headers: {}, body: { message: `no route for ${method} ${path}` } };
    }

    switch (routed.kind) {
      case 'repo':
        if (method !== 'GET') return notAllowed(method);
        return { status: 200, headers: {}, body: { full_name: `${routed.owner}/${routed.name}` } };

      case 'issues':
        if (method === 'POST') return create(req);
        if (method === 'GET') return list(req, query, `${routed.owner}/${routed.name}`);
        return notAllowed(method);

      case 'issue': {
        const issue = issues.get(routed.number);
        if (method === 'GET') {
          if (!issue) return notFound(`issue #${routed.number}`);
          return { status: 200, headers: {}, body: issueRecord(issue) };
        }
        if (method === 'PATCH') {
          if (!issue) return notFound(`issue #${routed.number}`);
          return update(req, issue);
        }
        if (method === 'DELETE') {
          if (!issue) return notFound(`issue #${routed.number}`);
          issues.delete(routed.number);
          commentsByIssue.delete(routed.number);
          return { status: 204, headers: {}, body: null };
        }
        return notAllowed(method);
      }

      case 'comments':
        if (method === 'POST') return addComment(req, routed.number);
        if (method === 'GET') {
          const list = commentsByIssue.get(routed.number) ?? [];
          return {
            status: 200,
            headers: {},
            body: list.map((c) => commentRecord(routed.number, c)),
          };
        }
        return notAllowed(method);

      case 'comment': {
        const found = findComment(routed.commentId);
        if (method === 'PATCH') {
          if (!found) return notFound(`comment #${routed.commentId}`);
          const { body } = readBody(req);
          const next = stringField(body, 'body');
          if (next !== undefined) found.comment.body = next;
          found.comment.updated_at = new Date(now()).toISOString();
          return {
            status: 200,
            headers: {},
            body: commentRecord(found.issueNumber, found.comment),
          };
        }
        if (method === 'DELETE') {
          if (!found) return notFound(`comment #${routed.commentId}`);
          const list = commentsByIssue.get(found.issueNumber) ?? [];
          commentsByIssue.set(
            found.issueNumber,
            list.filter((c) => c.id !== routed.commentId),
          );
          return { status: 204, headers: {}, body: null };
        }
        return notAllowed(method);
      }

      case 'dependencies': {
        const issue = issues.get(routed.number);
        if (!issue) return notFound(`issue #${routed.number}`);
        if (method === 'GET') {
          return { status: 200, headers: {}, body: { dependencies: issue.dependencies } };
        }
        if (method === 'POST') {
          const { body } = readBody(req);
          const incoming = (body.dependencies ?? body.dependsOn) as unknown;
          const added = Array.isArray(incoming)
            ? incoming.map((n) => Number(n)).filter((n) => Number.isFinite(n))
            : [];
          for (const n of added) if (!issue.dependencies.includes(n)) issue.dependencies.push(n);
          touch(issue);
          return { status: 200, headers: {}, body: issueRecord(issue) };
        }
        return notAllowed(method);
      }

      case 'dependency': {
        const issue = issues.get(routed.number);
        if (!issue) return notFound(`issue #${routed.number}`);
        if (method !== 'DELETE') return notAllowed(method);
        issue.dependencies = issue.dependencies.filter((n) => n !== routed.depNumber);
        touch(issue);
        return { status: 200, headers: {}, body: issueRecord(issue) };
      }

      case 'sub-issues': {
        const parent = issues.get(routed.number);
        if (!parent) return notFound(`issue #${routed.number}`);
        if (method === 'GET') {
          const subs = [...issues.values()].filter((i) => i.parent === routed.number);
          return { status: 200, headers: {}, body: subs.map(issueRecord) };
        }
        if (method === 'POST') {
          const { body } = readBody(req);
          const subId = Number((body as Record<string, unknown>)['sub_issue_id']);
          const sub = issues.get(subId);
          if (!sub) return notFound(`issue #${subId}`);
          sub.parent = routed.number;
          touch(sub);
          return { status: 201, headers: {}, body: issueRecord(sub) };
        }
        if (method === 'DELETE') {
          for (const sub of [...issues.values()].filter((i) => i.parent === routed.number)) {
            sub.parent = null;
            touch(sub);
          }
          return { status: 204, headers: {}, body: null };
        }
        return notAllowed(method);
      }

      case 'sub-issue': {
        // Clear one issue's native parent (LP-493): the GitHub `DELETE
        // /issues/:number/sub_issue` endpoint the connector's `reparent(null)`
        // calls. Idempotent — clearing an issue already at the root is a no-op.
        const issue = issues.get(routed.number);
        if (!issue) return notFound(`issue #${routed.number}`);
        if (method !== 'DELETE') return notAllowed(method);
        issue.parent = null;
        touch(issue);
        return { status: 200, headers: {}, body: issueRecord(issue) };
      }

      case 'issue-types': {
        if (method !== 'GET') return notAllowed(method);
        // A non-empty list is the live signal a provider's `native_types`
        // probe reads; the shape of the entries is the provider's business.
        const body = capabilities.nativeTypes === true ? [{ id: 'epic', name: 'Epic' }] : [];
        return { status: 200, headers: {}, body };
      }

      case 'issue-fields': {
        if (method !== 'GET') return notAllowed(method);
        const fields = capabilities.customFields;
        const body =
          fields && fields.valueTypes.length > 0
            ? fields.valueTypes.map((valueType) => ({
                id: valueType,
                name: valueType,
                value_type: valueType,
              }))
            : [];
        return { status: 200, headers: {}, body };
      }

      case 'labels': {
        if (method === 'GET') {
          return {
            status: 200,
            headers: {},
            body: [...repoLabels].sort().map((name) => ({ name, color: 'cccccc', description: null })),
          };
        }
        if (method === 'POST') {
          const { body } = readBody(req);
          const name = stringField(body, 'name');
          if (name !== undefined && name !== '') repoLabels.add(name);
          return { status: 201, headers: {}, body: { name: name ?? '' } };
        }
        return notAllowed(method);
      }

      case 'milestones': {
        if (method === 'GET') {
          // The GitHub REST milestone list: number, title and due date.
          const body = [...milestones.values()]
            .sort((a, b) => a.number - b.number)
            .map((m) => ({ number: m.number, title: m.title, due_on: m.due_on }));
          return { status: 200, headers: {}, body };
        }
        if (method === 'POST') {
          const { body } = readBody(req);
          const title = stringField(body, 'title') ?? '';
          const number = nextMilestoneNumber++;
          milestones.set(number, {
            number,
            title,
            due_on: stringField(body, 'due_on') ?? null,
          });
          return { status: 201, headers: {}, body: { number, title, due_on: milestones.get(number)!.due_on } };
        }
        return notAllowed(method);
      }

      case 'graphql': {
        if (method !== 'POST') return notAllowed(method);
        const { body } = readBody(req);
        const query = typeof body['query'] === 'string' ? body['query'] : '';
        const variables = (body['variables'] ?? {}) as Record<string, unknown>;
        return linearGraphql(query, variables);
      }
    }
  }

  // -- seed -------------------------------------------------------------------

  for (const name of options.labels ?? []) {
    if (name !== '') repoLabels.add(name);
  }

  for (const seed of options.seed ?? []) {
    const at = new Date(now()).toISOString();
    const number = seed.number ?? nextNumber++;
    nextNumber = Math.max(nextNumber, number + 1);
    issues.set(number, {
      number,
      title: seed.title,
      body: normalize(seed.body ?? ''),
      state: seed.state ?? 'open',
      labels: order(seed.labels ?? []),
      assignees: seed.assignees ?? [],
      fields: seed.fields ?? {},
      dependencies: seed.dependencies ?? [],
      parent: seed.parent ?? null,
      milestone: seed.milestone ?? null,
      workflowState: seed.workflowState,
      estimate: seed.estimate,
      created_at: seed.created_at ?? at,
      updated_at: seed.updated_at ?? at,
    });
  }

  // -- the transport contract ---------------------------------------------------

  function remoteErrorOf(req: RemoteRequest, res: DispatchResult): RemoteError {
    const retryAfter = retryAfterMs(res.headers);
    const classification = classifyStatus(
      res.status,
      retryAfter,
      res.headers['x-ratelimit-remaining'] === '0',
    );
    return new RemoteError({
      kind: 'api',
      status: res.status,
      code: classification.code,
      retryable: classification.retryable,
      retryAfterMs: retryAfter,
      purpose: purposeOf(req),
      providerMessage: providerMessageOf(res.body),
      detail: res.body === null ? '' : JSON.stringify(res.body),
    });
  }

  async function fetchAdapter(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = normalizeHeaders(init);
    let body: unknown;
    if (init?.body !== undefined && init.body !== null) {
      const text = typeof init.body === 'string' ? init.body : String(init.body);
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const { path, query } = splitPath(url);
    const req: RemoteRequest = {
      method: method as HttpMethod,
      path,
      query,
      headers,
      body,
      signal: init?.signal ?? undefined,
    };
    const res = await dispatch(req);
    return new Response(
      res.body === null || res.body === undefined ? null : JSON.stringify(res.body),
      { status: res.status, headers: res.headers },
    );
  }

  const connector: MemoryConnector = {
    kind: 'memory',

    async request<T>(req: RemoteRequest): Promise<RemoteResponse<T>> {
      const res = await dispatch(req);
      if (!ok(res.status)) throw remoteErrorOf(req, res);
      return { status: res.status, ok: true, headers: res.headers, body: res.body as T | null };
    },

    async *paginate<T>(req: RemoteRequest): AsyncGenerator<T> {
      const spec = req.pagination;
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
          current = { ...req, query: { ...req.query, [spec.cursorParam]: String(cursor) } };
        }
      }
    },

    async close() {},

    // -- inspection -----------------------------------------------------------

    issues() {
      return issues;
    },

    comments(issueNumber: number) {
      return commentsByIssue.get(issueNumber) ?? [];
    },

    dependencies(issueNumber: number) {
      return issues.get(issueNumber)?.dependencies ?? [];
    },

    labels() {
      return [...repoLabels].sort();
    },

    records() {
      return [...issues.values()].sort((a, b) => a.number - b.number).map(issueRecord);
    },

    linearRecords() {
      return [...issues.values()].sort((a, b) => a.number - b.number).map(linearIssueRecord);
    },

    failNext(failure: Failure, match?: (req: RemoteRequest) => boolean) {
      rules.push({ match: match ?? (() => true), failure, times: 1 });
    },

    mutateIssue(remoteId: string, patch: Partial<StoredIssue>) {
      const issue = issues.get(Number(remoteId));
      if (!issue) return;
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        (issue as unknown as Record<string, unknown>)[key] = value;
      }
      issue.updated_at = new Date(now()).toISOString();
    },

    deleteIssue(remoteId: string) {
      issues.delete(Number(remoteId));
      commentsByIssue.delete(Number(remoteId));
    },

    setNow(ms: number) {
      pinned = ms;
    },

    setSubIssues(enabled: boolean) {
      subIssues = enabled;
    },

    advance(ms: number) {
      pinned = now() + ms;
    },

    now() {
      return now();
    },

    fetch(input, init) {
      return fetchAdapter(input, init);
    },
  };

  return connector;
}

/** Place `value` at `path` inside a plain object, creating levels as needed. */
function placeAtPath(root: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let node: Record<string, unknown> = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i]!;
    const existing = node[key];
    if (existing === null || typeof existing !== 'object') {
      node[key] = {};
    }
    node = node[key] as Record<string, unknown>;
  }
  node[path[path.length - 1]!] = value;
}
