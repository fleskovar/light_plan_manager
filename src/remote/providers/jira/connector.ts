/**
 * The Jira Cloud connector — a live connection to one Cloud site, driven by the
 * executor (LP-490).
 *
 * Built from a validated `connection` block (`site`, `project`, `board`,
 * `email`, `token`, `tls_verify`). The HTTP and Basic Auth header construction
 * are owned by the wrapped client — `jira.js`, an optional *peer* dependency
 * (never installed with light-plan, because Jira sync is experimental) loaded through a computed specifier so the engine still
 * compiles and runs on a machine that never installed it (exactly the pattern
 * `runner/pi.ts` uses for the pi SDK). The client lives entirely inside this
 * file, behind the provider `Connector` contract (LP-289), so the retry/budget
 * decorators and the conformance suite see an ordinary connector and nothing
 * here leaks into the planners or core.
 *
 * TLS verification is **on by default and stays on**. A corporate MITM proxy
 * with a custom root CA is handled outside this file — `NODE_EXTRA_CA_CERTS`
 * or Node's `--use-system-ca` inject the root into the OS trust store that
 * Node's built-in `fetch` already verifies against. `tls_verify: false` is the
 * explicit, loud fallback: it warns on every build and is never the default.
 *
 * Three failure modes produce three different messages (LP-294's shapes):
 * a site that cannot be reached (DNS/TLS/non-Jira), an account email the site
 * rejects, and an API token the site rejects. The email-vs-token distinction
 * is a documented heuristic on Atlassian's 401 body — both are a 401, and the
 * message names the most likely fix for each.
 *
 * Server/Data Center is out of scope, consistent with the epic's Cloud-first
 * decision: a URL that answers but has no Cloud v3 API is reported as "not
 * supported" rather than as a confusing 401 or 404.
 */

import { BoardError } from '../../../core/errors.js';
import type {
  ConnectionCandidate,
  Connector,
  ConnectorResult,
  LinkKind,
  ReachabilityResult,
  ListProgress,
  RemotePage,
  RemoteRecord,
  RemoteRequest,
  RemoteUser,
} from '../../provider.js';
import { markdownToAdf } from '../../../shared/adf.js';
import type { RemoteVocabulary } from '../../reconcile.js';
import { normalizeAccountMapping } from '../../accounts.js';
import { normalizePeriodMapping } from '../../periods.js';
import type { JiraConnection } from './config.js';
import { parseFields, type JiraConnector, type JiraField } from './fields.js';
import {
  isClosedSprint,
  parseSprints,
  sprintByName,
  sprintFieldIdOf,
  type JiraSprint,
  type JiraSprintConnector,
} from './sprints.js';
import { hierarchyDepthOf, isSubtaskType, type JiraIssueType } from './types.js';

/** The non-literal specifier, so `tsc` does not require jira.js at build time. */
const JIRA_PACKAGE = 'jira.js';

/** The jira.js surface this connector uses, typed loosely over the real SDK. */
interface JiraCloudClient {
  issues: {
    createIssue(parameters: Record<string, unknown>): Promise<{ id: string; key: string; self: string }>;
    getIssue(parameters: { issueIdOrKey: string; fields?: string[] }): Promise<Record<string, unknown>>;
    editIssue(parameters: Record<string, unknown>): Promise<unknown>;
    deleteIssue(parameters: { issueIdOrKey: string }): Promise<unknown>;
    getTransitions(parameters: { issueIdOrKey: string; expand?: string }): Promise<{
      transitions?: JiraTransition[];
    }>;
    doTransition(parameters: Record<string, unknown>): Promise<unknown>;
    getCreateIssueMetaIssueTypes(parameters: { projectIdOrKey: string }): Promise<Record<string, unknown>>;
    getCreateIssueMetaIssueTypeId(parameters: {
      projectIdOrKey: string;
      issueTypeId: string;
    }): Promise<Record<string, unknown>>;
  };
  issueFields: {
    getFields(): Promise<unknown[]>;
    createCustomField(parameters: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  screens: {
    addFieldToDefaultScreen(parameters: { fieldId: string }): Promise<unknown>;
  };
  workflows: {
    readWorkflows(parameters: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  issueSearch: {
    searchAndReconsileIssuesUsingJqlPost(parameters: Record<string, unknown>): Promise<{
      issues?: Array<Record<string, unknown>>;
      nextPageToken?: string | null;
    }>;
  };
  issueComments: {
    addComment(parameters: Record<string, unknown>): Promise<{ id?: string }>;
    updateComment(parameters: Record<string, unknown>): Promise<{ id?: string }>;
    deleteComment(parameters: Record<string, unknown>): Promise<unknown>;
  };
  issueLinks: {
    linkIssues(parameters: Record<string, unknown>): Promise<unknown>;
    deleteIssueLink(parameters: { linkId: string }): Promise<unknown>;
  };
  myself: {
    getCurrentUser(): Promise<Record<string, unknown>>;
  };
  projects: {
    getProject(parameters: { projectIdOrKey: string; expand?: string }): Promise<Record<string, unknown>>;
    /**
     * The project's statuses, grouped by issue type — the one call that answers
     * "what are this project's workflow statuses called?" without needing the
     * workflow-read permission the multi-hop path needs.
     */
    getAllStatuses(parameters: { projectIdOrKey: string }): Promise<unknown>;
  };
  userSearch: {
    findUsers(parameters: {
      query?: string;
      username?: string;
      accountId?: string;
      maxResults?: number;
    }): Promise<Array<Record<string, unknown>>>;
    /**
     * The users who can be *assigned* work in one project — not every account
     * on the instance. That is the list a readiness check wants: an account
     * that exists but cannot be assigned in this project is a failed write
     * either way.
     */
    findAssignableUsers(parameters: {
      project?: string;
      query?: string;
      maxResults?: number;
      startAt?: number;
    }): Promise<Array<Record<string, unknown>>>;
  };
}

/** The jira.js Agile surface this connector uses (the `agile` client, LP-328). */
interface JiraAgileClient {
  board: {
    getAllBoards(parameters: {
      projectKeyOrId?: string;
      startAt?: number;
      maxResults?: number;
    }): Promise<{
      values?: Array<Record<string, unknown>>;
      isLast?: boolean;
    }>;
    getAllSprints(parameters: {
      boardId: number;
      startAt?: number;
      maxResults?: number;
      state?: string;
    }): Promise<{
      values?: Array<Record<string, unknown>>;
      isLast?: boolean;
      startAt?: number;
      maxResults?: number;
    }>;
  };
  sprint: {
    createSprint(parameters: {
      name: string;
      originBoardId?: number;
      startDate?: string;
      endDate?: string;
      goal?: string;
    }): Promise<Record<string, unknown>>;
  };
}

/** One workflow transition as `getTransitions` returns it (`transitions.fields` expanded). */
interface JiraTransition {
  id?: string;
  name?: string;
  to?: { id?: string; name?: string };
  /** The transition screen's fields, keyed by field key, when expanded. */
  fields?: Record<string, unknown>;
}

/** The slice of `readWorkflows` the multi-hop path is computed from. */
interface WorkflowReadResponse {
  statuses?: Array<{ statusReference?: string; name?: string }>;
  workflows?: Array<{
    transitions?: Array<{
      toStatusReference?: string;
      links?: Array<{ fromStatusReference?: string }>;
    }>;
  }>;
}

/** The status graph the multi-hop path walks (keys are lowercased names). */
interface WorkflowGraph {
  adjacency: Map<string, Set<string>>;
  /** Lowercased status name → the name the workflow wrote, for the report. */
  display: Map<string, string>;
}

/** One field a transition's screen requires, by field key and display name. */
interface RequiredField {
  key: string;
  name?: string;
}

/** The per-remote transition configuration a status change is applied with. */
interface TransitionOptions {
  multiHop: boolean;
  transitionFields: Record<string, unknown>;
}

/** A thrown jira.js error, described by its observable shape (status, body, code). */
interface JiraClientError {
  status?: number;
  statusText?: string;
  body?: unknown;
  code?: string;
  transient?: boolean;
  name?: string;
  message?: string;
}

/** The connection this connector talks to, after the resolver filled the secrets. */
interface ResolvedConnection {
  site: string;
  project: string;
  board?: string;
  email: string;
  token: string;
  tlsVerify: boolean;
}

/** Read a Jira issue's `fields.updated` (the revision marker), or null. */
function updatedOf(record: Record<string, unknown>): string | null {
  const fields = record['fields'];
  if (fields && typeof fields === 'object') {
    const updated = (fields as Record<string, unknown>)['updated'];
    if (typeof updated === 'string') return updated;
  }
  return null;
}

/** The messages a 401 body may carry, as plain strings. */
/**
 * A board period's dates are **inclusive calendar days** — "Sprint 1 runs from
 * the 31st through the 31st" is a one-day sprint, and a board may well have
 * one. A Jira sprint is a pair of *instants* and it requires the start to be
 * strictly before the end, so sending the bare dates makes an inclusive
 * one-day sprint into `start === end`, which Jira refuses outright
 * (`startDate: The start date of a sprint must be before the end date`).
 *
 * So the start is the beginning of its day and the end is the *end* of its
 * day. That is not a workaround for the refusal: it is what the board already
 * meant. Mapping an inclusive end date onto midnight would silently shorten
 * every sprint by a day, which is worse than the error.
 *
 * A value that already carries a time is passed through untouched — a caller
 * that has been explicit is not second-guessed.
 */
function sprintStart(date: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(date.trim()) ? `${date.trim()}T00:00:00.000Z` : date;
}

function sprintEnd(date: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(date.trim()) ? `${date.trim()}T23:59:59.000Z` : date;
}

/** A Jira issue key — `PAY-100`, `SCRUM-17` — as opposed to a numeric id. */
const ISSUE_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

/**
 * How to name a parent to Jira: `{ id }` for the numeric id, `{ key }` for the
 * human-facing key.
 *
 * Chosen by the shape of the value, because both reach this code. The executor
 * resolves a parent through the link store, which records Jira's **id**
 * (`10016`) — and sending that under `key` is rejected with "Please select
 * valid parent issue", a message that reads like a hierarchy problem and is
 * not one. A caller that adopted a twin by key (`lpm remote link`) has the key.
 * Neither should have to know which field the other uses.
 */
function parentRef(parent: string): Record<string, string> {
  return ISSUE_KEY_RE.test(parent) ? { key: parent } : { id: parent };
}

function errorMessagesOf(body: unknown): string[] {
  if (body === null || typeof body !== 'object') return [];
  const record = body as Record<string, unknown>;
  const out: string[] = [];

  const messages = record['errorMessages'];
  if (Array.isArray(messages)) {
    out.push(...messages.filter((entry): entry is string => typeof entry === 'string'));
  }

  // The field-keyed map — `{ errors: { originBoardId: "The board does not
  // support sprints" } }`. Jira uses it wherever the complaint is about one
  // field, which is most of the Agile API, and it sits beside an *empty*
  // `errorMessages`. Reading only the array threw the explanation away: a
  // sprint that could not be created reported no reason at all, under a hint
  // about issue types that had nothing to do with it. Jira's own words are the
  // most useful thing in the error, so they are never dropped.
  const errors = record['errors'];
  if (errors !== null && typeof errors === 'object' && !Array.isArray(errors)) {
    for (const [field, message] of Object.entries(errors as Record<string, unknown>)) {
      if (typeof message === 'string' && message !== '') out.push(`${field}: ${message}`);
    }
  }

  if (out.length === 0) {
    const message = record['message'];
    if (typeof message === 'string') out.push(message);
  }
  return out;
}

/**
 * True when the 401 body suggests the *email* is the problem rather than the
 * token: Atlassian's "Basic authentication with passwords is deprecated"
 * message (and its relatives) fire when the credentials are read as a password
 * pair, which is what a wrong account email looks like. A plain "invalid
 * credentials" blames the token. This is a documented heuristic — a 401 cannot
 * name the failing half, and the message names the most likely fix.
 */
function bodyBlamesEmail(body: unknown): boolean {
  return errorMessagesOf(body).some((message) => /password|username|email/i.test(message));
}

/**
 * True when Jira refused a write because the issue is a sub-task and the sprint
 * is not its to hold.
 *
 * **Jira owns a sub-task's sprint**: it is always the parent's, it cannot be
 * set, and it cannot be cleared either. That is not a permission or a bad
 * value, it is a field that does not belong to this issue type — the same kind
 * of rule as "an Epic cannot sit under an Epic", discovered the same way, by
 * being refused.
 *
 * It matters in the *clearing* direction most, which is the one nobody
 * predicts: light-plan sees a sprint on a twin whose board document has no
 * period, plans an update to take it off, and Jira refuses. Nothing about that
 * resolves by itself, so every push failed on the same thirteen sub-tasks for
 * ever.
 */
function isSubtaskSprintRefusal(error: unknown): boolean {
  const err = error as { status?: number; body?: unknown };
  if (err?.status !== 400) return false;
  return errorMessagesOf(err.body).some((message) =>
    /subtask.*cannot be associated to a sprint|cannot be associated to a sprint/i.test(message),
  );
}

/**
 * True when Jira refused a write because it was given an issue type for a
 * sub-task without the parent that must accompany it.
 *
 * The executor hands the translator the **whole document** on an update, not
 * just the diff, because a label-carrying provider derives its type and state
 * from it — so every Jira edit restates `issuetype` even when nothing about
 * the type changed. Jira tolerates that on a standard issue and refuses it on
 * a sub-task, where an `issuetype` in the body must be accompanied by a
 * `parent`. The result was a permanent failure on every sub-task with any
 * other field to write.
 */
function isSubtaskTypeRefusal(error: unknown): boolean {
  const err = error as { status?: number; body?: unknown };
  if (err?.status !== 400) return false;
  return errorMessagesOf(err.body).some((message) =>
    /sub-?task but parent issue key or id not specified/i.test(message),
  );
}

/**
 * Map a thrown jira.js error to a `BoardError` whose message and hints name the
 * fix — the one place the three failure modes (site, email, token) become three
 * different messages.
 */
function describeFailure(error: unknown, conn: ResolvedConnection, purpose: string): BoardError {
  const err = error as JiraClientError;

  // No HTTP status but a `code` / `transient`: the request never produced a
  // response — DNS, TLS, a reset socket. That is the "wrong site" case.
  if (err.status === undefined && err.code !== undefined) {
    const tls = /CERT|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(err.code);
    const hints = [
      `check connection.site — it must be your Cloud site (https://<org>.atlassian.net or a Cloud custom domain)`,
    ];
    if (tls) {
      hints.push(
        'a corporate proxy is intercepting TLS — inject its root CA with NODE_EXTRA_CA_CERTS=<file> or node --use-system-ca',
      );
      hints.push('do not set tls_verify: false except as a last resort');
    }
    return new BoardError(`cannot reach the Jira site at ${conn.site} while ${purpose}`, hints);
  }

  if (err.status === 401) {
    if (bodyBlamesEmail(err.body)) {
      return new BoardError(`the Jira account email was rejected at ${conn.site}`, [
        `check connection.email matches the account that owns the API token`,
        'the value must be an API token, not the account password',
        `resolve it with \${JIRA_EMAIL} or: lpm remote login`,
      ]);
    }
    return new BoardError(`the Jira API token was rejected at ${conn.site}`, [
      'revoke and regenerate it at https://id.atlassian.com/manage-profile/security/api-tokens',
      'store the new value with: lpm remote login <name>  (or ${JIRA_API_TOKEN})',
    ]);
  }

  if (err.status === 403) {
    return new BoardError(`Jira refused the request (permission denied) while ${purpose}`, [
      'the credential is valid but lacks the required project permission',
      'check the account has Browse/Create/Edit issues on the project',
    ]);
  }

  if (err.status === 400) {
    const messages = errorMessagesOf(err.body);
    const detail = messages.length > 0 ? `: ${messages.join('; ')}` : '';
    // The hints follow the *purpose*. A 400 while creating a sprint has
    // nothing to do with issue types or parents, and saying so sent somebody
    // looking at the wrong half of their config for an afternoon.
    if (/sprint/i.test(purpose)) {
      // When Jira explained itself, its words are the diagnosis: a guess
      // printed beside them is how somebody ends up debugging the wrong thing.
      // (A sprint name over 30 characters and a board that cannot hold created
      // sprints are both real, and they are not the same problem.) The
      // candidates are offered only when it said nothing at all.
      return new BoardError(
        `Jira refused the request while ${purpose}${detail}`,
        messages.length > 0
          ? ['that is Jira’s own message; the sprint was not created and the push carried on without it']
          : [
              'sprints can only be *created* on a company-managed Scrum board — a team-managed ("next-gen") project reports its board as type `simple`',
              'check connection.board names a Scrum board and that the account has Manage Sprints on it',
            ],
      );
    }
    return new BoardError(`Jira refused the request while ${purpose}${detail}`, [
      'a type that cannot sit under its parent, or a field Jira rejects, is refused rather than coerced',
      'check the issue type and its parent against the project\u2019s actual type scheme',
    ]);
  }

  if (err.status === 404) {
    const notCloud = !conn.site.includes('.atlassian.net');
    return new BoardError(`Jira answered 404 while ${purpose}`, [
      ...(notCloud
        ? [
            `the site ${conn.site} is not a *.atlassian.net Cloud site — if it is a Jira Server/Data Center instance, it is not supported (Cloud only)`,
          ]
        : ['the resource may have been deleted, or the account cannot see it']),
    ]);
  }

  if (err.status === 429) {
    return new BoardError(`Jira rate-limited the request while ${purpose}`, [
      'slow the sync down and retry — the remote said so',
    ]);
  }

  if (err.status !== undefined && err.status >= 500) {
    return new BoardError(`Jira failed (HTTP ${err.status}) while ${purpose}`, [
      'retrying may succeed',
    ]);
  }

  // A `BoardError` is already the legible, structured message (a workflow
  // refusal, a missing transition field) — pass it through, never rewrap it.
  if (error instanceof BoardError) return error;

  return new BoardError(`Jira rejected the request while ${purpose}`, [
    err.message ?? String(error),
  ]);
}

/** A Jira issue record → `ConnectorResult`, reading the post-write state. */
/** The workflow status name on a Jira issue record, or `''` when it carries none. */
function statusNameOf(record: Record<string, unknown>): string {
  const fields = (record['fields'] ?? {}) as Record<string, unknown>;
  const status = (fields['status'] ?? {}) as { name?: unknown };
  return typeof status.name === 'string' ? status.name : '';
}

function resultOf(record: Record<string, unknown>, site: string): ConnectorResult {
  const id = typeof record['id'] === 'string' ? record['id'] : String(record['id'] ?? '');
  const key = typeof record['key'] === 'string' ? record['key'] : '';
  const rev = updatedOf(record) ?? '';
  // The link records the *browse* URL a person opens, not the REST self link:
  // `https://<org>.atlassian.net/browse/PAY-418`.
  const browseUrl = key ? `${site}/browse/${key}` : '';
  return {
    remoteId: id,
    remoteKey: key || id,
    remoteUrl: browseUrl,
    remoteRev: rev,
    record,
  };
}

/** A Jira comment response → `ConnectorResult` (comment id rides along). */
function commentResult(comment: Record<string, unknown>, issueRemoteId: string, issueKey: string): ConnectorResult {
  const id = typeof comment['id'] === 'string' ? comment['id'] : String(comment['id'] ?? '');
  return {
    remoteId: issueRemoteId,
    remoteKey: issueKey,
    remoteUrl: '',
    remoteRev: '',
    commentId: id,
  };
}

/** The `issuelinks` entries a Jira record carries, or an empty list. */
function issueLinksOf(record: Record<string, unknown>): Array<Record<string, unknown>> {
  const fields = record['fields'];
  if (!fields || typeof fields !== 'object') return [];
  const links = (fields as Record<string, unknown>)['issuelinks'];
  if (!Array.isArray(links)) return [];
  return links.filter(
    (link): link is Record<string, unknown> => link !== null && typeof link === 'object',
  );
}

/** The name of an issue link's type (`Blocks`, `Relates`), or ''. */
function linkTypeNameOf(link: Record<string, unknown>): string {
  const type = link['type'];
  if (!type || typeof type !== 'object') return '';
  const name = (type as Record<string, unknown>)['name'];
  return typeof name === 'string' ? name : '';
}

/** The remote id of a link endpoint (`outwardIssue` / `inwardIssue`), or ''. */
function endpointIdOf(endpoint: unknown): string {
  if (!endpoint || typeof endpoint !== 'object') return '';
  const id = (endpoint as Record<string, unknown>)['id'];
  if (typeof id === 'string') return id;
  if (typeof id === 'number') return String(id);
  return '';
}

/** Case-insensitive, whitespace-tolerant status name equality. */
function nameMatches(a: unknown, b: string): boolean {
  return typeof a === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The transition reaching `target` in one hop, when the list has one. */
function singleHopTo(list: JiraTransition[], target: string): JiraTransition | undefined {
  return list.find((transition) => nameMatches(transition.to?.name, target));
}

/** The statuses one transition away, for the "reachable" report. */
function singleHopReachable(list: JiraTransition[]): string[] {
  const names = list
    .map((transition) => transition.to?.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
  return [...new Set(names)].sort();
}

/** The fields a transition's screen marks required, with their display names. */
function requiredFieldsOf(transition: JiraTransition): RequiredField[] {
  const fields = transition.fields ?? {};
  const required: RequiredField[] = [];
  for (const [key, meta] of Object.entries(fields)) {
    if (meta && typeof meta === 'object' && (meta as Record<string, unknown>)['required'] === true) {
      const name = (meta as Record<string, unknown>)['name'];
      required.push({ key, name: typeof name === 'string' ? name : undefined });
    }
  }
  return required;
}

/**
 * The `fields` body for a transition, answered from `transition_fields` in
 * config. Returns the fields to send plus the required fields config did not
 * answer — those are the ones a transition must refuse on rather than guess.
 */
function fieldsFor(transition: JiraTransition, configured: Record<string, unknown>): {
  fields?: Record<string, unknown>;
  missing: RequiredField[];
} {
  const missing: RequiredField[] = [];
  const fields: Record<string, unknown> = {};
  for (const field of requiredFieldsOf(transition)) {
    if (Object.prototype.hasOwnProperty.call(configured, field.key)) {
      fields[field.key] = configured[field.key];
    } else {
      missing.push(field);
    }
  }
  return { fields: Object.keys(fields).length > 0 ? fields : undefined, missing };
}

/** Build the workflow's status graph from a `readWorkflows` response. */
function workflowGraphOf(response: WorkflowReadResponse): WorkflowGraph {
  const nameOfRef = new Map<string, string>();
  for (const status of response.statuses ?? []) {
    if (typeof status.statusReference === 'string' && typeof status.name === 'string') {
      nameOfRef.set(status.statusReference, status.name);
    }
  }

  const adjacency = new Map<string, Set<string>>();
  const display = new Map<string, string>();
  const addEdge = (from: string, to: string) => {
    const fromKey = from.trim().toLowerCase();
    const toKey = to.trim().toLowerCase();
    if (fromKey === '' || toKey === '' || fromKey === toKey) return;
    display.set(fromKey, from);
    display.set(toKey, to);
    let set = adjacency.get(fromKey);
    if (!set) {
      set = new Set();
      adjacency.set(fromKey, set);
    }
    set.add(toKey);
  };

  for (const workflow of response.workflows ?? []) {
    for (const transition of workflow.transitions ?? []) {
      const toName =
        typeof transition.toStatusReference === 'string'
          ? nameOfRef.get(transition.toStatusReference)
          : undefined;
      if (!toName) continue;
      for (const link of transition.links ?? []) {
        const fromName =
          typeof link.fromStatusReference === 'string'
            ? nameOfRef.get(link.fromStatusReference)
            : undefined;
        if (fromName) addEdge(fromName, toName);
      }
    }
  }

  return { adjacency, display };
}

/**
 * A breadth-first path of status *names* from `fromName` to `toName` — the
 * intermediate statuses plus the target, never the starting status. `null`
 * when the workflow offers no path.
 */
function findPath(graph: WorkflowGraph, fromName: string, toName: string): string[] | null {
  const start = fromName.trim().toLowerCase();
  const goal = toName.trim().toLowerCase();
  if (start === goal) return [toName];
  const seen = new Set<string>([start]);
  const queue: Array<{ key: string; path: string[] }> = [{ key: start, path: [] }];
  while (queue.length > 0) {
    const { key, path } = queue.shift()!;
    for (const next of graph.adjacency.get(key) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      const nextPath = [...path, next];
      if (next === goal) return nextPath.map((k) => graph.display.get(k) ?? k);
      queue.push({ key: next, path: nextPath });
    }
  }
  return null;
}

/** Every status reachable from `fromName` by any number of transitions. */
function reachableNames(graph: WorkflowGraph, fromName: string): string[] {
  const start = fromName.trim().toLowerCase();
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const key = stack.pop()!;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const next of graph.adjacency.get(key) ?? []) {
      if (!seen.has(next)) stack.push(next);
    }
  }
  seen.delete(start);
  return [...seen].map((key) => graph.display.get(key) ?? key).sort();
}

function isPermissionDenied(error: unknown): boolean {
  return (error as JiraClientError | undefined)?.status === 403;
}

/** A transition screen's required field cannot be answered from config. */
function missingFieldsError(remoteId: string, target: string, missing: RequiredField[]): BoardError {
  const list = missing
    .map((field) => (field.name ? `${field.key} (${field.name})` : field.key))
    .join(', ');
  return new BoardError(
    `Cannot move ${remoteId} to "${target}": the transition requires ${missing.length === 1 ? 'field' : 'fields'} ${list}`,
    [
      ...missing.map((field) => `set mapping.transition_fields.${field.key} to the value the workflow expects`),
      'a transition screen field must come from config — it is never guessed',
    ],
  );
}

/** The target is reachable only through several transitions, and that is off. */
function multiHopRefusedError(remoteId: string, target: string, pathNames: string[]): BoardError {
  const hops = Math.max(0, pathNames.length - 1);
  return new BoardError(
    `Moving ${remoteId} to "${target}" needs ${hops} transition${hops === 1 ? '' : 's'}`,
    [
      `path: ${pathNames.join(' → ')}`,
      "multi-hop transitions fire automations, notify people and stamp resolutions — the decision is the operator's, not the sync's",
      'set mapping.transitions.multi_hop: true to execute this path automatically',
    ],
  );
}

/** The target has no path from where the issue stands. */
function unreachableError(remoteId: string, target: string, reachable: string[]): BoardError {
  return new BoardError(`Cannot move ${remoteId} to "${target}"`, [
    ...(reachable.length > 0
      ? [`reachable statuses: ${[...new Set(reachable)].join(', ')}`]
      : ["no statuses are reachable from the issue's current status"]),
    'a Jira status change is a workflow transition, and the target may be unreachable from where the issue stands',
  ]);
}

/** The credential can transition but not read the workflow to find a path. */
function workflowPermissionError(remoteId: string, target: string, reachable: string[]): BoardError {
  return new BoardError(
    `Cannot move ${remoteId} to "${target}": the credential cannot read the workflow to compute a path`,
    [
      ...(reachable.length > 0
        ? [`reachable in one hop: ${reachable.join(', ')}`]
        : ["no transitions are reachable from the issue's current status"]),
      'reading the workflow graph needs "View workflow" or "Administer projects" project permission',
      'grant the token that permission, or move the issue one status at a time',
    ],
  );
}

/**
 * Build a Jira connector from a validated connection block (and mapping, whose
 * `transitions` / `transition_fields` shape how a status change is applied).
 *
 * `site` and `project` are required (the schema enforces them); `email` and
 * `token` are the *resolved* secrets (the resolver filled them from the
 * credential chain before this is called); `tls_verify` defaults to on.
 */
export function jiraConnector(
  connection: Record<string, unknown>,
  mapping: Record<string, unknown> = {},
): Connector & JiraConnector & JiraSprintConnector {
  const raw = connection as unknown as JiraConnection;
  const mappingConfig = (mapping ?? {}) as {
    transitions?: { multi_hop?: boolean };
    transition_fields?: Record<string, unknown>;
  };
  const multiHop = mappingConfig.transitions?.multi_hop === true;
  const transitionFields = mappingConfig.transition_fields ?? {};
  // Which resource attribute carries the Jira account (LP-329). `email` is the
  // one value that needs a search: Jira addresses an assignee by account id,
  // so an email must be resolved through the user search before it can be
  // written. Any other attribute (a `jira_account_id` attribute) already holds
  // the account id and is written directly, with no search.
  const accountsVia = normalizeAccountMapping(mapping['accounts'])?.via;
  const conn: ResolvedConnection = {
    site: (raw.site ?? '').trim().replace(/\/+$/, ''),
    project: raw.project,
    board: raw.board,
    email: typeof raw.email === 'string' ? raw.email : '',
    token: typeof raw.token === 'string' ? raw.token : '',
    tlsVerify: raw.tls_verify !== false,
  };

  // TLS: verification stays on unless the operator explicitly disabled it, and
  // the disable is loud — every build of the connector, i.e. every run.
  if (!conn.tlsVerify) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    process.emitWarning(
      `Jira connection to ${conn.site}: TLS verification is DISABLED (connection.tls_verify: false). ` +
        'Traffic is not protected against interception. Prefer NODE_EXTRA_CA_CERTS=<file> or node --use-system-ca to trust your proxy root CA instead.',
    );
  }

  // The client is loaded lazily, on first use: a board that declares a Jira
  // remote but never syncs it pays nothing, and a missing jira.js surfaces as
  // the install-command message only when something actually talks to Jira.
  // The Cloud (v3) and Agile (software) surfaces share one build, so both are
  // memoized together behind one import (LP-328 needs the Agile sprint API).
  let clientsPromise: Promise<{ cloud: JiraCloudClient; agile: JiraAgileClient }> | undefined;

  function clients(): Promise<{ cloud: JiraCloudClient; agile: JiraAgileClient }> {
    clientsPromise ??= buildClients();
    return clientsPromise;
  }

  async function client(): Promise<JiraCloudClient> {
    return (await clients()).cloud;
  }

  async function agile(): Promise<JiraAgileClient> {
    return (await clients()).agile;
  }

  async function buildClients(): Promise<{ cloud: JiraCloudClient; agile: JiraAgileClient }> {
    let mod: unknown;
    try {
      mod = await import(JIRA_PACKAGE);
    } catch (error) {
      throw new BoardError('The Jira client (jira.js) is not available', [
        'Jira sync is experimental, so its client is not installed with light-plan.',
        'Run `lpm experimental on` to install it.',
        'Or install it beside light-plan yourself: npm install -g jira.js (a global install),',
        'npm install jira.js (a project), or npx -p light-plan -p jira.js lpm … (npx).',
        'It requires Node 22 or newer.',
        (error as Error).message,
      ]);
    }
    const { createCloudClient, createAgileClient } = mod as {
      createCloudClient(config: Record<string, unknown>): JiraCloudClient;
      createAgileClient(config: Record<string, unknown>): JiraAgileClient;
    };
    const config = {
      host: conn.site,
      auth: { type: 'basic', email: conn.email, apiToken: conn.token },
    };
    return { cloud: createCloudClient(config), agile: createAgileClient(config) };
  }

  /**
   * Every status name this project's issue types can be in, fetched once and
   * cached. Jira answers per issue type; the union is what the project has.
   */
  let projectStatusesPromise: Promise<string[]> | undefined;

  function projectStatuses(): Promise<string[]> {
    projectStatusesPromise ??= fetchProjectStatuses();
    return projectStatusesPromise;
  }

  async function fetchProjectStatuses(): Promise<string[]> {
    const c = await client();
    let raw: unknown;
    try {
      raw = await c.projects.getAllStatuses({ projectIdOrKey: conn.project });
    } catch (error) {
      throw describeFailure(error, conn, `reading the statuses of ${conn.project}`);
    }
    if (!Array.isArray(raw)) return [];
    const names = new Set<string>();
    for (const entry of raw) {
      if (entry === null || typeof entry !== 'object') continue;
      const statuses = (entry as Record<string, unknown>)['statuses'];
      if (!Array.isArray(statuses)) continue;
      for (const status of statuses) {
        if (status === null || typeof status !== 'object') continue;
        const name = (status as Record<string, unknown>)['name'];
        if (typeof name === 'string' && name !== '') names.add(name);
      }
    }
    return [...names];
  }

  /**
   * The project's issue types, fetched once per connector and cached — the
   * *actual* scheme the type mapping is validated against (LP-324). `probe`
   * and `create` share the one fetch; a board that never probes and never
   * creates a sub-task pays nothing.
   */
  let typeSchemePromise: Promise<JiraIssueType[]> | undefined;

  function typeScheme(): Promise<JiraIssueType[]> {
    typeSchemePromise ??= fetchTypeScheme();
    return typeSchemePromise;
  }

  async function fetchTypeScheme(): Promise<JiraIssueType[]> {
    const c = await client();
    try {
      const project = await c.projects.getProject({
        projectIdOrKey: conn.project,
        expand: 'issueTypes',
      });
      const raw = (project['issueTypes'] ?? []) as unknown;
      if (!Array.isArray(raw)) return [];
      const types: JiraIssueType[] = [];
      for (const entry of raw) {
        if (entry === null || typeof entry !== 'object') continue;
        const record = entry as Record<string, unknown>;
        const name = typeof record['name'] === 'string' ? record['name'] : '';
        if (name === '') continue;
        types.push({
          name,
          ...(typeof record['subtask'] === 'boolean' ? { subtask: record['subtask'] } : {}),
          ...(typeof record['hierarchyLevel'] === 'number'
            ? { hierarchyLevel: record['hierarchyLevel'] }
            : {}),
        });
      }
      return types;
    } catch (error) {
      throw describeFailure(error, conn, `reading the issue types of ${conn.project}`);
    }
  }

  /**
   * True when `typeName` names a sub-task type. Best-effort: when the scheme
   * cannot be read, this returns false and Jira's own refusal is surfaced — a
   * top-level sub-task is refused by Jira whether or not we saw it coming.
   */
  async function isSubtask(typeName: string): Promise<boolean> {
    try {
      const scheme = await typeScheme();
      return scheme.some((type) => type.name === typeName && isSubtaskType(type));
    } catch {
      return false;
    }
  }

  /**
   * The instance's custom fields, fetched once per connector and cached — the
   * list `mapping.attributes` names resolve against (LP-327). System fields
   * are dropped: the mapping carries only custom fields, so the cache stays
   * small and `validateFieldMapping`'s "it has:" list names only the fields a
   * mapping may point at.
   */
  let fieldsPromise: Promise<JiraField[]> | undefined;

  function fields(): Promise<JiraField[]> {
    fieldsPromise ??= fetchFields();
    return fieldsPromise;
  }

  async function fetchFields(): Promise<JiraField[]> {
    const c = await client();
    try {
      const raw = await c.issueFields.getFields();
      return parseFields(raw).filter((field) => field.custom);
    } catch (error) {
      throw describeFailure(error, conn, 'listing custom fields');
    }
  }

  // -- sprints (LP-328) ------------------------------------------------------

  // Jira's only native period container is a sprint, so a period mapping on
  // this connector *is* sprint mapping — the schema already stamps
  // `carrier: 'sprint'`, and reading `normalizePeriodMapping` here keeps the
  // connector correct even when a test builds it with the bare
  // `{ container }` spelling.
  const usesSprints = normalizePeriodMapping(mapping['periods']) !== undefined;

  /** The sprint custom field's per-instance id, discovered once and cached. */
  let sprintFieldIdPromise: Promise<string | undefined> | undefined;

  function sprintFieldId(): Promise<string | undefined> {
    sprintFieldIdPromise ??= fetchSprintFieldId();
    return sprintFieldIdPromise;
  }

  async function fetchSprintFieldId(): Promise<string | undefined> {
    try {
      return sprintFieldIdOf(await fields());
    } catch (error) {
      throw describeFailure(error, conn, 'finding the sprint field');
    }
  }

  /** The board's sprints (every state), fetched once per connector and cached. */
  let sprintsPromise: Promise<JiraSprint[]> | undefined;

  function sprints(): Promise<JiraSprint[]> {
    sprintsPromise ??= fetchSprints();
    return sprintsPromise;
  }

  async function fetchSprints(): Promise<JiraSprint[]> {
    if (conn.board === undefined) return [];
    const a = await agile();
    try {
      const out: JiraSprint[] = [];
      let startAt = 0;
      for (;;) {
        const page = await a.board.getAllSprints({
          boardId: Number(conn.board),
          startAt,
          maxResults: 50,
        });
        out.push(...parseSprints(page));
        const values = Array.isArray(page.values) ? page.values : [];
        if (page.isLast === true || values.length === 0) break;
        startAt += values.length;
      }
      return out;
    } catch (error) {
      throw describeFailure(error, conn, `listing sprints on board ${conn.board}`);
    }
  }

  /**
   * Which Agile board this project's sprints live on, asked of Jira rather than
   * of the person.
   *
   * `connection.board` is the one connection value a reader cannot reasonably
   * be expected to know: it is not the project key, it does not appear in the
   * project settings, and the usual way to find it is to open a board and read
   * a number out of the URL. The credential that can file an issue can also
   * list the project's boards, so setup asks Jira and writes the answer down.
   *
   * Returns nothing at all when the board id is already set, or when the
   * mapping carries no periods — there is nothing to discover in either case.
   * A failure is swallowed into an empty list: discovery is an offer, and the
   * push preflight is what actually holds the line.
   */
  async function discoverConnection(): Promise<ConnectionCandidate[]> {
    if (conn.board !== undefined && conn.board !== '') return [];
    if (mapping['periods'] === undefined) return [];
    try {
      const a = await agile();
      const page = await a.board.getAllBoards({ projectKeyOrId: conn.project, maxResults: 50 });
      const values = Array.isArray(page.values) ? page.values : [];
      return values.flatMap((entry) => {
        const id = entry['id'];
        if (typeof id !== 'number' && typeof id !== 'string') return [];
        const name = typeof entry['name'] === 'string' ? entry['name'] : `board ${String(id)}`;
        const kind = typeof entry['type'] === 'string' ? ` (${entry['type']})` : '';
        return [{ key: 'board', value: String(id), label: `${name}${kind}` }];
      });
    } catch {
      return [];
    }
  }

  /**
   * The sprint field value a create/update body should carry: `{ id }` to move
   * the issue into the sprint, `{ null }` to clear it, or `{}` when the
   * request carries no period.
   *
   * **A sprint that does not exist yet is not an error.** The board's timeline
   * and the board's work are pushed independently — file the stories today,
   * file the sprints when you are ready — so an issue scheduled into a sprint
   * Jira has not got is filed *unscheduled*, and `unwritten` says so. The
   * executor records the period as unset, and the push that files the sprint
   * writes the assignment. Refusing here would make the whole timeline a
   * precondition of filing a single story.
   *
   * A **closed** sprint is different and still refuses: the work cannot go
   * there at all, and pretending otherwise would lose the scheduling silently.
   * Unless the issue is *already* in it, which is a no-op rather than a move.
   */
  async function sprintFieldFor(
    request: RemoteRequest,
    remoteId?: string,
  ): Promise<{ fields: Record<string, unknown>; unwritten?: string }> {
    if (!usesSprints) return { fields: {} };
    if (request.period === undefined) return { fields: {} };

    const fieldId = await sprintFieldId();
    if (request.period === null) {
      // Clearing a sprint: without a field there is nothing to clear, and the
      // issue is already out of every sprint.
      return { fields: fieldId === undefined ? {} : { [fieldId]: null } };
    }

    // No board and no sprint field are both "this instance cannot hold the
    // schedule", which is the same situation as a sprint that does not exist:
    // file the work, say what was dropped, and let a later push carry it.
    if (conn.board === undefined || fieldId === undefined) {
      return { fields: {}, unwritten: 'period' };
    }

    const sprint = sprintByName(await sprints(), request.period.name);
    if (sprint === undefined) {
      return { fields: {}, unwritten: 'period' };
    }
    if (isClosedSprint(sprint)) {
      // Already sitting in this closed sprint? Then nothing moves, and a title
      // or body edit must not be refused for it. Only a genuine move into a
      // closed sprint is refused.
      if (remoteId !== undefined && (await currentSprintNameOf(remoteId, fieldId)) === sprint.name) {
        return { fields: {} };
      }
      throw new BoardError(`Cannot move work into sprint "${sprint.name}" — it is closed`, [
        'Closed sprints are read-only; move the issue into an active or future sprint, or reopen the sprint in Jira.',
      ]);
    }

    const numeric = Number(sprint.id);
    return { fields: { [fieldId]: Number.isNaN(numeric) ? sprint.id : numeric } };
  }

  /** Read a record's sprint field value into a `{ name, state, starts, ends }` observation. */
  function sprintObservationOf(record: RemoteRecord, fieldId: string): Record<string, unknown> | undefined {
    const fields = record['fields'];
    if (!fields || typeof fields !== 'object') return undefined;
    const value = (fields as Record<string, unknown>)[fieldId];
    if (value === null || value === undefined || typeof value !== 'object') return undefined;
    // Parallel sprints arrive as an array; take the first open one, else the
    // first — the sync refuses ambiguity rather than inventing a winner.
    const entries = Array.isArray(value) ? value : [value];
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object') continue;
      const sprint = entry as Record<string, unknown>;
      if (typeof sprint['name'] !== 'string') continue;
      const observation: Record<string, unknown> = { name: sprint['name'] };
      if (typeof sprint['state'] === 'string') observation.state = sprint['state'];
      if (typeof sprint['startDate'] === 'string') observation.starts = sprint['startDate'];
      if (typeof sprint['endDate'] === 'string') observation.ends = sprint['endDate'];
      return observation;
    }
    return undefined;
  }

  /** The name of the sprint an issue currently sits in, or `undefined`. */
  async function currentSprintNameOf(remoteId: string, fieldId: string): Promise<string | undefined> {
    const c = await client();
    try {
      const record = await c.issues.getIssue({ issueIdOrKey: remoteId });
      return sprintObservationOf(record as RemoteRecord, fieldId)?.['name'] as string | undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Add `sprint` (name + dates) to a record so the pull resolves the period.
   * Best-effort: no sprint field, no board, or no sprint on the issue simply
   * stays unenriched — the carrier has nothing to recover, which is the honest
   * answer rather than a failure.
   */
  async function enrichSprint(record: RemoteRecord | null): Promise<RemoteRecord | null> {
    if (record === null) return null;
    if (!usesSprints || conn.board === undefined) return record;
    try {
      const fieldId = await sprintFieldId();
      if (fieldId === undefined) return record;
      const observation = sprintObservationOf(record, fieldId);
      if (observation === undefined) return record;
      return { ...record, sprint: observation };
    } catch {
      // Enrichment never fails a read: a missing board or a permission loss on
      // the field list is not a missing issue.
      return record;
    }
  }

  /**
   * The create-screen field ids, keyed by issue type name, fetched once per
   * connector (LP-327). This is the metadata that answers "is this field
   * writable on a create of this type" before any write; the create screen
   * stands in for the edit screen too, since no issue exists to query
   * `editmeta` against and Jira's default screen scheme serves one screen for
   * both operations.
   */
  let createMetaPromise: Promise<Map<string, Set<string>>> | undefined;

  function createMeta(): Promise<Map<string, Set<string>>> {
    createMetaPromise ??= fetchCreateMeta();
    return createMetaPromise;
  }

  async function fetchCreateMeta(): Promise<Map<string, Set<string>>> {
    const c = await client();
    try {
      const page = await c.issues.getCreateIssueMetaIssueTypes({ projectIdOrKey: conn.project });
      const rawTypes = (page['issueTypes'] ?? []) as unknown;
      const map = new Map<string, Set<string>>();
      if (!Array.isArray(rawTypes)) return map;
      for (const entry of rawTypes) {
        if (entry === null || typeof entry !== 'object') continue;
        const record = entry as Record<string, unknown>;
        const id = record['id'];
        const name = record['name'];
        if (typeof id !== 'string' || typeof name !== 'string') continue;
        const fieldsPage = await c.issues.getCreateIssueMetaIssueTypeId({
          projectIdOrKey: conn.project,
          issueTypeId: id,
        });
        const rawFields = (fieldsPage['fields'] ?? []) as unknown;
        const set = new Set<string>();
        if (Array.isArray(rawFields)) {
          for (const rawField of rawFields) {
            if (rawField === null || typeof rawField !== 'object') continue;
            const fieldRecord = rawField as Record<string, unknown>;
            const fieldId = fieldRecord['fieldId'];
            const key = fieldRecord['key'];
            if (typeof fieldId === 'string') set.add(fieldId);
            if (typeof key === 'string') set.add(key);
          }
        }
        map.set(name, set);
      }
      return map;
    } catch (error) {
      throw describeFailure(error, conn, 'reading the create-screen metadata');
    }
  }

  /** Create a custom field (needs the Administer Jira global permission). */
  async function createField(name: string, typeKey: string, signal?: AbortSignal): Promise<{ id: string }> {
    const c = await client();
    try {
      const created = await c.issueFields.createCustomField({ name, type: typeKey });
      void signal;
      const id = typeof created['id'] === 'string' ? created['id'] : '';
      if (id === '') {
        throw new BoardError(`Jira created the field "${name}" but returned no id`, [
          'The field exists but its id could not be read; re-run discovery to pick it up.',
        ]);
      }
      return { id };
    } catch (error) {
      throw describeFailure(error, conn, `creating the custom field "${name}"`);
    }
  }

  /** Add a field to the default screen (needs the Administer Jira permission). */
  async function addFieldToScreen(fieldId: string, signal?: AbortSignal): Promise<void> {
    const c = await client();
    try {
      await c.screens.addFieldToDefaultScreen({ fieldId });
      void signal;
    } catch (error) {
      throw describeFailure(error, conn, `adding ${fieldId} to the screen`);
    }
  }

  /** A Jira issue read back as its own record shape, or null when gone/unseen. */
  async function get(remoteId: string): Promise<RemoteRecord | null> {
    const c = await client();
    try {
      const issue = await c.issues.getIssue({ issueIdOrKey: remoteId });
      return await enrichSprint(issue as RemoteRecord);
    } catch (error) {
      const err = error as JiraClientError;
      if (err.status === 404) return null;
      throw describeFailure(error, conn, `fetching issue ${remoteId}`);
    }
  }

  /** The fields of a request, in the shape `createIssue` / `editIssue` expect. */
  function fieldsOf(request: RemoteRequest): Record<string, unknown> {
    const fields: Record<string, unknown> = {
      project: { key: conn.project },
    };
    if (request.type !== undefined) fields['issuetype'] = { name: request.type };
    if (request.title !== undefined) fields['summary'] = request.title;
    // Jira Cloud's description is ADF, and this is the wire — the last place
    // the body is anybody's but Jira's. A string arrives from the translator
    // (prose) and from the executor (prose plus the managed block, composed in
    // markdown); an ADF document arrives from a caller that has already done
    // the conversion, and is passed through.
    if (request.body !== undefined) {
      fields['description'] =
        typeof request.body === 'string' ? markdownToAdf(request.body) : request.body;
    }
    if (request.labels !== undefined) fields['labels'] = request.labels;
    if (request.parent !== undefined && request.parent !== '') {
      fields['parent'] = parentRef(request.parent);
    }
    return fields;
  }

  /**
   * The `assignee` field value a create/update should carry (LP-329). Jira
   * addresses an assignee by account id, never by email or name, so:
   *
   *   - `request.assignee === null` (or an empty string, defensively) → the
   *     issue goes unassigned;
   *   - a non-empty value under `accounts.via: email` → resolved to an account
   *     id through Jira's user search;
   *   - a non-empty value under any other `via` (a `jira_account_id`
   *     attribute) → the account id itself, written directly with no search.
   *
   * `undefined` means the op does not carry an assignee, so the remote side is
   * left untouched.
   */
  async function assigneeFieldFor(request: RemoteRequest): Promise<Record<string, unknown>> {
    if (request.assignee === undefined) return {};
    if (request.assignee === null || request.assignee === '') {
      return { assignee: null };
    }
    return { assignee: { id: await resolveAccount(request.assignee) } };
  }

  /**
   * Turn a `mapping.accounts.via` value into the Jira account id it names.
   *
   * Only `via: email` searches: the value is an email address and Jira assigns
   * by account id, so the user search must find the id. An empty result is the
   * documented signature of a privacy-restricted (GDPR-mode) instance, where
   * email lookups are disabled — that is refused with the `jira_account_id`
   * alternative rather than reported as "user not found". Any other `via` is
   * already the account id and is returned as-is, no search made.
   */
  async function resolveAccount(value: string): Promise<string> {
    if (accountsVia !== 'email') return value;

    const c = await client();
    let users: Array<Record<string, unknown>>;
    try {
      users = (await c.userSearch.findUsers({ query: value })) as unknown as Array<
        Record<string, unknown>
      >;
    } catch (error) {
      throw describeFailure(error, conn, `resolving the Jira account for "${value}"`);
    }

    const needle = value.trim().toLowerCase();
    for (const user of users) {
      const email = user['emailAddress'];
      if (typeof email === 'string' && email.trim().toLowerCase() === needle) {
        const id = user['accountId'];
        if (typeof id === 'string' && id !== '') return id;
      }
    }

    throw new BoardError(`Cannot resolve "${value}" to a Jira account by email search`, [
      'the search returned no matching account, which is what a privacy-restricted (GDPR-mode) instance does for email lookups',
      'set mapping.accounts.via: jira_account_id and put each person\u2019s Jira account id in that attribute',
      'the connector then assigns by account id directly, with no search',
    ]);
  }

  /** Move the issue to `target` status, resolving transitions (single- or multi-hop). */
  async function transitionTo(
    c: JiraCloudClient,
    remoteId: string,
    target: string,
    current?: string,
  ): Promise<void> {
    // Already there is not a move. Jira workflows rarely define a transition
    // whose `to` is the status you are in, so asking for one falls through to
    // the multi-hop path and is refused — which would make every issue whose
    // mapped status *is* the workflow's first status fail on create.
    if (current !== undefined && current.trim().toLowerCase() === target.trim().toLowerCase()) {
      return;
    }
    const transitions = await c.issues.getTransitions({
      issueIdOrKey: remoteId,
      expand: 'transitions.fields',
    });
    const list = transitions.transitions ?? [];

    // One hop: the transition whose `to` status is the target.
    const single = singleHopTo(list, target);
    if (single) {
      const { fields, missing } = fieldsFor(single, transitionFields);
      if (missing.length > 0) throw missingFieldsError(remoteId, target, missing);
      await c.issues.doTransition({
        issueIdOrKey: remoteId,
        transition: { id: single.id },
        ...(fields ? { fields } : {}),
      });
      return;
    }

    // No single hop. A path is computed from the workflow, which needs a read
    // the transitioning permission does not imply — the two failures are
    // different, and the messages say so.
    const issue = await c.issues.getIssue({ issueIdOrKey: remoteId });
    const issueFields = (issue['fields'] ?? {}) as Record<string, unknown>;
    const status = (issueFields['status'] ?? {}) as { name?: unknown };
    const project = (issueFields['project'] ?? {}) as { id?: unknown };
    const issuetype = (issueFields['issuetype'] ?? {}) as { id?: unknown };
    const currentStatusName = typeof status.name === 'string' ? status.name : '';
    const projectId = project.id === undefined ? '' : String(project.id);
    const issueTypeId = issuetype.id === undefined ? '' : String(issuetype.id);
    if (projectId === '' || issueTypeId === '') {
      throw new BoardError(`Cannot compute a multi-hop path for ${remoteId} to "${target}"`, [
        'the issue record did not carry a project id or issue type id',
      ]);
    }

    let graph: WorkflowGraph;
    try {
      const response = await c.workflows.readWorkflows({
        projectAndIssueTypes: [{ projectId, issueTypeId }],
      });
      graph = workflowGraphOf(response as WorkflowReadResponse);
    } catch (error) {
      if (isPermissionDenied(error)) {
        throw workflowPermissionError(remoteId, target, singleHopReachable(list));
      }
      throw error;
    }

    const path = findPath(graph, currentStatusName, target);
    if (path === null) {
      const reachable = reachableNames(graph, currentStatusName);
      throw unreachableError(
        remoteId,
        target,
        reachable.length > 0 ? reachable : singleHopReachable(list),
      );
    }

    if (!multiHop) {
      throw multiHopRefusedError(remoteId, target, [currentStatusName, ...path]);
    }

    // Execute the path one status at a time. The first hop is reachable from
    // the transitions already fetched (`list`); each later hop re-reads the
    // transitions now available from the intermediate status the issue just
    // moved to — the graph says which statuses lead where, but transition ids
    // and required fields are per-status facts.
    let available = list;
    for (let i = 0; i < path.length; i++) {
      const next = path[i]!;
      const step = singleHopTo(available, next);
      if (!step) {
        throw new BoardError(`Cannot move ${remoteId} to "${target}"`, [
          `the workflow path says "${next}" follows, but no transition to it is available now`,
          'the issue may have moved, or a condition on the transition no longer holds',
        ]);
      }
      const { fields, missing } = fieldsFor(step, transitionFields);
      if (missing.length > 0) throw missingFieldsError(remoteId, next, missing);
      await c.issues.doTransition({
        issueIdOrKey: remoteId,
        transition: { id: step.id },
        ...(fields ? { fields } : {}),
      });
      if (i + 1 < path.length) {
        const refreshed = await c.issues.getTransitions({
          issueIdOrKey: remoteId,
          expand: 'transitions.fields',
        });
        available = refreshed.transitions ?? [];
      }
    }
  }

  return {
    name: 'jira',

    async create(request: RemoteRequest, signal?: AbortSignal): Promise<ConnectorResult> {
      const c = await client();
      try {
        // A sub-task must have a parent — Jira refuses a top-level sub-task, and
        // this local refusal names the rule before the round-trip (LP-324).
        if (
          (request.parent === undefined || request.parent === '') &&
          typeof request.type === 'string' &&
          (await isSubtask(request.type))
        ) {
          throw new BoardError(`Cannot file "${request.type}" without a parent`, [
            `${request.type} is a sub-task issue type — Jira requires a parent issue for it`,
            'place the issue under its parent before pushing, or map it to a standard type',
          ]);
        }

        const sprintField = await sprintFieldFor(request);
        const created = await c.issues.createIssue({
          fields: { ...fieldsOf(request), ...(await assigneeFieldFor(request)), ...sprintField.fields },
        });
        // **A created issue is in the workflow's first status, never the one
        // the board asked for**, because Jira has no way to set a status on
        // `POST /issue` — status moves only through a transition. So a create
        // has to do what `update` does, or a board of finished work arrives as
        // a project of "To Do" and *stays* that way: the base is recomputed
        // from the echo, Jira's first status usually maps back to more than one
        // board status (`backlog` and `ready` both claim "To Do"), the
        // ambiguous read leaves the local value standing, and both sides then
        // agree on a status the remote does not hold. No later push disagrees,
        // because there is nothing left to disagree with.
        // The post-write record: the create response carries id/key/self only,
        // so read the issue back to record the base from what Jira stored.
        let record = await c.issues.getIssue({ issueIdOrKey: created.id });
        if (request.state !== undefined && request.state !== '') {
          const before = statusNameOf(record);
          if (before !== request.state) {
            await transitionTo(c, created.id, request.state, before);
            // Read again: the base must record the status the issue ended in.
            record = await c.issues.getIssue({ issueIdOrKey: created.id });
          }
        }
        void signal;
        return {
          ...resultOf(record as Record<string, unknown>, conn.site),
          ...(sprintField.unwritten !== undefined ? { unwritten: [sprintField.unwritten] } : {}),
        };
      } catch (error) {
        throw describeFailure(error, conn, 'creating an issue');
      }
    },

    async update(remoteId: string, request: RemoteRequest, signal?: AbortSignal): Promise<ConnectorResult> {
      const c = await client();
      try {
        const sprintField = await sprintFieldFor(request, remoteId);
        const fields = { ...fieldsOf(request), ...(await assigneeFieldFor(request)), ...sprintField.fields };
        delete fields['project'];
        // Whether the sprint was actually written — `unwritten` has to report
        // the sprint Jira would not take, and that is only known after trying.
        let unwritten = sprintField.unwritten;
        if (Object.keys(fields).length > 0) {
          // **Jira validates one field at a time**, so recovering from a
          // refusal is a loop rather than a retry. Two of its rules are about
          // a field that was never this issue's to carry, and both surface
          // only once the earlier one is gone: drop the sprint and the next
          // attempt complains about the issue type. A single retry fixed the
          // first and failed on the second, which is how thirteen sub-tasks
          // went on failing after the sprint half was fixed.
          //
          // Anything not recognised is rethrown untouched, and the loop can
          // only ever shrink the request, so it terminates.
          const sprintKeys = Object.keys(sprintField.fields);
          let attempt = { ...fields };
          for (;;) {
            try {
              await c.issues.editIssue({ issueIdOrKey: remoteId, fields: attempt });
              break;
            } catch (error) {
              const next = { ...attempt };

              // A sub-task's sprint is its parent's: it can be neither set nor
              // cleared, so the field is reported unwritten rather than retried
              // for ever.
              if (isSubtaskSprintRefusal(error) && sprintKeys.some((key) => key in next)) {
                for (const key of sprintKeys) delete next[key];
                unwritten = 'period';
                attempt = next;
                continue;
              }

              // An `issuetype` restated on a sub-task: the executor hands the
              // translator the whole document, so every edit carries the type
              // even when nothing about it changed, and Jira wants a `parent`
              // beside it. Dropping it is only safe when the type is not
              // actually changing, so that is **checked** — a real retype fails
              // loudly with the reason instead of reporting a success that did
              // not happen.
              if (isSubtaskTypeRefusal(error) && next['issuetype'] !== undefined) {
                const current = await c.issues.getIssue({
                  issueIdOrKey: remoteId,
                  fields: ['issuetype'],
                });
                const currentType = ((current['fields'] ?? {}) as Record<string, unknown>)['issuetype'];
                const currentName =
                  currentType && typeof currentType === 'object'
                    ? (currentType as { name?: unknown }).name
                    : undefined;
                if (currentName !== request.type) {
                  throw new BoardError(`Cannot retype ${remoteId} to "${String(request.type)}"`, [
                    'Jira needs the parent issue in the same request when an issue type changes on a sub-task',
                    'move the document out of its parent first, or change the type in Jira',
                  ]);
                }
                delete next['issuetype'];
                attempt = next;
                continue;
              }

              throw error;
            }
          }
          // Everything the refusals removed is gone; nothing left to send is a
          // finished edit, not a failure.
        }
        if (request.state !== undefined && request.state !== '') {
          await transitionTo(c, remoteId, request.state);
        }
        const record = await c.issues.getIssue({ issueIdOrKey: remoteId });
        void signal;
        return {
          ...resultOf(record as Record<string, unknown>, conn.site),
          ...(unwritten !== undefined ? { unwritten: [unwritten] } : {}),
        };
      } catch (error) {
        throw describeFailure(error, conn, `updating issue ${remoteId}`);
      }
    },

    async delete(remoteId: string, signal?: AbortSignal): Promise<ConnectorResult> {
      const c = await client();
      try {
        await c.issues.deleteIssue({ issueIdOrKey: remoteId });
        void signal;
        // Jira deletes hard; there is no post-delete record to record.
        return { remoteId, remoteKey: remoteId, remoteUrl: '', remoteRev: '' };
      } catch (error) {
        throw describeFailure(error, conn, `deleting issue ${remoteId}`);
      }
    },

    get,

    async resolve(key: string): Promise<ConnectorResult | null> {
      // `PAY-123` (or a bare numeric id) → the live issue. Jira keys survive
      // lookups by id too, but the key is what a person pastes.
      const record = await get(key);
      if (record === null) return null;
      return resultOf(record as Record<string, unknown>, conn.site);
    },

    describe(record: RemoteRecord): { remoteKey: string; remoteUrl: string } {
      const result = resultOf(record as Record<string, unknown>, conn.site);
      return { remoteKey: result.remoteKey, remoteUrl: result.remoteUrl };
    },

    async list(opts?: { cursor?: string | null; onPage?: ListProgress }): Promise<RemotePage> {
      const c = await client();
      const jql =
        `project = ${conn.project}` +
        (opts?.cursor ? ` AND updated >= ${JSON.stringify(opts.cursor)}` : '') +
        ' ORDER BY updated ASC';
      try {
        // The sprint field rides the search explicitly when sprint mapping is
        // on and a board is configured: `*all` does not reliably include it,
        // exactly as with `issuelinks` (LP-325). Without a board there is
        // nothing to enrich, and the field is left out.
        let searchFields: string[] = ['*all', 'issuelinks'];
        if (usesSprints && conn.board !== undefined) {
          const fieldId = await sprintFieldId();
          if (fieldId !== undefined) searchFields = ['*all', 'issuelinks', fieldId];
        }

        const records: RemoteRecord[] = [];
        let pages = 0;
        let nextPageToken: string | null | undefined;
        do {
          const page = await c.issueSearch.searchAndReconsileIssuesUsingJqlPost({
            jql,
            maxResults: 50,
            // `*all` does not reliably include `issuelinks` on Cloud — the
            // field is named explicitly so the pull can read native links back
            // (LP-325).
            fields: searchFields,
            ...(nextPageToken ? { nextPageToken } : {}),
          });
          records.push(...(page.issues ?? []));
          pages += 1;
          opts?.onPage?.({ page: pages, records: records.length });
          nextPageToken = page.nextPageToken ?? undefined;
        } while (nextPageToken);

        let cursor: string | null = null;
        for (const record of records) {
          const updated = updatedOf(record as Record<string, unknown>);
          if (updated !== null && (cursor === null || updated > cursor)) cursor = updated;
        }
        const enriched: RemoteRecord[] = [];
        for (const record of records) {
          enriched.push((await enrichSprint(record as RemoteRecord)) ?? (record as RemoteRecord));
        }
        return { records: enriched, cursor };
      } catch (error) {
        throw describeFailure(error, conn, 'listing issues');
      }
    },

    async link(dependentRemoteId: string, dependencyRemoteId: string, signal?: AbortSignal, kind?: LinkKind): Promise<ConnectorResult> {
      const c = await client();
      try {
        if (kind === 'relates') {
          // `relates_to` → the native `Relates` link. Symmetric, so either
          // orientation holds the same meaning; the local issue is the outward
          // ("relates to") side for consistency with how it is read back.
          await c.issueLinks.linkIssues({
            outwardIssue: { id: dependentRemoteId },
            inwardIssue: { id: dependencyRemoteId },
            type: { name: 'Relates' },
          });
        } else {
          // `depends_on` → the dependent waits on the dependency, so the
          // dependency **blocks** the dependent.
          //
          // The field names invite the opposite arrangement, and it is wrong.
          // Measured against Jira Cloud: posting `{outwardIssue: A, inwardIssue: B}`
          // with type `Blocks` produces "**B** blocks A" — the *inward* issue
          // is the one that does the blocking. So the dependency goes in
          // `inwardIssue` and the dependent in `outwardIssue`.
          //
          // Reversed, this is silent: both sides link, the push reports
          // success, and every dependency on the board reaches Jira pointing
          // backwards — a plan that reads as its own mirror image to anybody
          // working in Jira.
          await c.issueLinks.linkIssues({
            outwardIssue: { id: dependentRemoteId },
            inwardIssue: { id: dependencyRemoteId },
            type: { name: 'Blocks' },
          });
        }
        void signal;
        return { remoteId: dependentRemoteId, remoteKey: dependentRemoteId, remoteUrl: '', remoteRev: '' };
      } catch (error) {
        throw describeFailure(error, conn, `linking ${dependentRemoteId} to ${dependencyRemoteId}`);
      }
    },

    async unlink(dependentRemoteId: string, dependencyRemoteId: string, signal?: AbortSignal, kind?: LinkKind): Promise<ConnectorResult> {
      // Jira links are removed by link id, which needs a read first: the
      // connector reads the issue's `issuelinks`, finds the link between the
      // two ids, and deletes it by id. A link already gone is a no-op —
      // unlinking is idempotent (LP-325).
      const c = await client();
      try {
        const typeName = kind === 'relates' ? 'Relates' : 'Blocks';
        const record = await c.issues.getIssue({ issueIdOrKey: dependentRemoteId, fields: ['issuelinks'] });
        // An `issuelinks` entry names only the *other* end — never both — so
        // matching on a pair matched nothing, and every unlink quietly did
        // nothing while reporting success. Read from the dependent's record,
        // the dependency is the issue named on the entry; for `Blocks` it is
        // specifically the `inwardIssue` ("this issue is blocked by that
        // one"), which is also what tells a `depends_on` edge apart from its
        // own reverse.
        const match = issueLinksOf(record as Record<string, unknown>).find((link) => {
          if (linkTypeNameOf(link) !== typeName) return false;
          if (kind === 'relates') {
            const other =
              link['inwardIssue'] !== undefined ? link['inwardIssue'] : link['outwardIssue'];
            return endpointIdOf(other) === dependencyRemoteId;
          }
          return endpointIdOf(link['inwardIssue']) === dependencyRemoteId;
        });
        if (match === undefined) {
          // Already gone — nothing to delete.
          return { remoteId: dependentRemoteId, remoteKey: dependentRemoteId, remoteUrl: '', remoteRev: '' };
        }
        const raw = match['id'];
        const linkId = typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : '';
        if (linkId === '') {
          throw new BoardError(`Cannot unlink ${dependentRemoteId} from ${dependencyRemoteId}`, [
            'the issue link carried no id to delete by',
          ]);
        }
        await c.issueLinks.deleteIssueLink({ linkId });
        void signal;
        return { remoteId: dependentRemoteId, remoteKey: dependentRemoteId, remoteUrl: '', remoteRev: '' };
      } catch (error) {
        throw describeFailure(error, conn, `unlinking ${dependentRemoteId} from ${dependencyRemoteId}`);
      }
    },

    async comment(remoteId: string, body: string, signal?: AbortSignal): Promise<ConnectorResult> {
      const c = await client();
      try {
        const comment = await c.issueComments.addComment({ issueIdOrKey: remoteId, body });
        void signal;
        return commentResult(comment as Record<string, unknown>, remoteId, remoteId);
      } catch (error) {
        throw describeFailure(error, conn, `commenting on ${remoteId}`);
      }
    },

    async editComment(remoteId: string, commentId: string, body: string, signal?: AbortSignal): Promise<ConnectorResult> {
      const c = await client();
      try {
        const comment = await c.issueComments.updateComment({ issueIdOrKey: remoteId, id: commentId, body });
        void signal;
        return commentResult(comment as Record<string, unknown>, remoteId, remoteId);
      } catch (error) {
        throw describeFailure(error, conn, `editing a comment on ${remoteId}`);
      }
    },

    async deleteComment(remoteId: string, commentId: string, signal?: AbortSignal): Promise<ConnectorResult> {
      const c = await client();
      try {
        await c.issueComments.deleteComment({ issueIdOrKey: remoteId, id: commentId });
        void signal;
        return commentResult({ id: commentId }, remoteId, remoteId);
      } catch (error) {
        throw describeFailure(error, conn, `deleting a comment on ${remoteId}`);
      }
    },

    /**
     * Answer a capability probe by name (LP-274). `hierarchy` reports the
     * project's native parent levels, detected from its issue types rather than
     * assumed (LP-324). `custom_fields` reports the value shapes Jira custom
     * fields can hold, in the provider's own schema vocabulary (LP-327) — the
     * name→id resolution itself is `fields()` / `preflightFields`'s job.
     */
    async probe(probeName: string): Promise<unknown> {
      if (probeName === 'hierarchy') {
        return hierarchyDepthOf(await typeScheme());
      }
      if (probeName === 'custom_fields') {
        return { valueTypes: ['string', 'number', 'date', 'datetime', 'option', 'array'] };
      }
      throw new BoardError(`The Jira connector does not answer probe "${probeName}"`, [
        'Only the "hierarchy" and "custom_fields" probes are implemented.',
      ]);
    },

    /** The project's issue types, for the preflight to validate the mapping against. */
    async issueTypes(): Promise<JiraIssueType[]> {
      return typeScheme();
    },

    /**
     * The project's own words: its issue types and every status any of its issue
     * types can reach (LP-537). `getAllStatuses` returns statuses *per issue
     * type*, so the set is the union — a status that only the Bug workflow has
     * is still a status this project has, and a mapping naming it is correct.
     *
     * Reading statuses needs only Browse Projects, unlike the workflow graph the
     * multi-hop transition path reads, so `lpm remote setup` works for the
     * ordinary syncing account.
     */
    async vocabulary(): Promise<RemoteVocabulary> {
      const types = (await typeScheme()).map((type) => type.name);
      return { types, statuses: await projectStatuses() };
    },

    /** The instance's custom fields, for discovery and preflight (LP-327). */
    fields,

    /** The create-screen field ids keyed by issue type, for the screen check (LP-327). */
    createMeta,

    /** Create a custom field, for `provision` (LP-327). */
    createField,

    /** Add a field to the default screen, for `provision` (LP-327). */
    addFieldToScreen,

    /**
     * The people this project can assign work to.
     *
     * `findAssignableUsers` rather than a plain user search: an account that
     * exists on the instance but is not assignable *here* is a failed write
     * either way, so listing it would be an answer that reads as reassuring
     * and is not. Paged, because a large site returns 50 at a time, and
     * `active` users only — a deactivated account is not somewhere work can
     * go. An instance that refuses the call (it needs Browse Users) reports
     * the refusal rather than an empty list, which would read as "nobody".
     */
    async listUsers(signal?: AbortSignal): Promise<RemoteUser[]> {
      void signal;
      const c = await client();
      const out: RemoteUser[] = [];
      const seen = new Set<string>();
      let startAt = 0;
      try {
        for (;;) {
          const page = await c.userSearch.findAssignableUsers({
            project: conn.project,
            maxResults: 50,
            startAt,
          });
          const users = Array.isArray(page) ? page : [];
          for (const user of users) {
            const id = user['accountId'];
            if (typeof id !== 'string' || id === '' || seen.has(id)) continue;
            if (user['active'] === false) continue;
            seen.add(id);
            const email = user['emailAddress'];
            out.push({
              id,
              name: typeof user['displayName'] === 'string' ? user['displayName'] : id,
              ...(typeof email === 'string' && email !== '' ? { email } : {}),
            });
          }
          if (users.length < 50) break;
          startAt += users.length;
        }
      } catch (error) {
        throw describeFailure(error, conn, `listing the users assignable in ${conn.project}`);
      }
      return out;
    },

    /** Every sprint on the configured Agile board, for `provision` (LP-328). */
    async listSprints(signal?: AbortSignal): Promise<JiraSprint[]> {
      void signal;
      return sprints();
    },

    /** Create a future sprint on the configured Agile board, for `provision` (LP-328). */
    async createSprint(
      name: string,
      starts?: string,
      ends?: string,
      signal?: AbortSignal,
    ): Promise<{ id: string }> {
      if (conn.board === undefined) {
        throw new BoardError(`Cannot create sprint "${name}": no Agile board id`, [
          'Sprints belong to an Agile board, not a project — set connection.board to the board id first.',
        ]);
      }
      const a = await agile();
      try {
        const created = await a.sprint.createSprint({
          name,
          originBoardId: Number(conn.board),
          ...(starts !== undefined ? { startDate: sprintStart(starts) } : {}),
          ...(ends !== undefined ? { endDate: sprintEnd(ends) } : {}),
        });
        void signal;
        const id = created['id'];
        if (typeof id !== 'string' && typeof id !== 'number') {
          throw new BoardError(`Jira created the sprint "${name}" but returned no id`, [
            'The sprint exists but its id could not be read; re-run provision to pick it up.',
          ]);
        }
        // **The sprint list is cached, so the cache has just gone stale.**
        // A push creates its prerequisites *before* it writes any issue,
        // precisely so the issues can be filed into them — but the lookup that
        // resolves a period to a sprint reads this cache, which was filled
        // while the sprint did not exist yet. Without this line the sprint is
        // created and then not found, every issue in it is filed unscheduled
        // with `unwritten: 'period'`, and the schedule only lands on the
        // *next* push. Self-healing hid it: the board was always one push
        // behind on its own timeline.
        sprintsPromise = undefined;
        return { id: String(id) };
      } catch (error) {
        throw describeFailure(error, conn, `creating the sprint "${name}"`);
      }
    },

    discoverConnection,

    /**
     * Move an existing twin under a new parent, or out from under one.
     *
     * Without this the executor could file a parent on *create* and never
     * change it afterwards: a `reparent` op was reported "skipped — connector
     * cannot move an existing issue to a native parent", so a board whose
     * carrier changed (or whose document was reparented locally) kept the
     * shape it was first filed with, for ever.
     *
     * `null` clears the parent, which is how a document that moved to a level
     * the block carries gets its native edge taken away rather than left stale.
     */
    async reparent(
      remoteId: string,
      parentRemoteId: string | null,
      signal?: AbortSignal,
    ): Promise<ConnectorResult> {
      const c = await client();
      try {
        await c.issues.editIssue({
          issueIdOrKey: remoteId,
          fields: { parent: parentRemoteId === null ? null : parentRef(parentRemoteId) },
        });
        const record = await c.issues.getIssue({ issueIdOrKey: remoteId });
        void signal;
        return resultOf(record as Record<string, unknown>, conn.site);
      } catch (error) {
        throw describeFailure(error, conn, `re-parenting issue ${remoteId}`);
      }
    },

    async reachable(): Promise<ReachabilityResult> {
      const c = await client();
      try {
        const project = await c.projects.getProject({ projectIdOrKey: conn.project });
        return {
          reachable: true,
          evidence: `GET /rest/api/3/project/${conn.project} → ${typeof project['key'] === 'string' ? `project ${project['key']} reachable` : '200'}`,
        };
      } catch (error) {
        const err = error as JiraClientError;
        if (err.status === 404) {
          return {
            reachable: false,
            evidence: `GET /rest/api/3/project/${conn.project} → 404`,
          };
        }
        if (err.status === undefined && err.code !== undefined) {
          return {
            reachable: false,
            evidence: `could not reach ${conn.site}: ${err.code ?? 'network error'}`,
          };
        }
        return {
          reachable: false,
          evidence: `GET /rest/api/3/project/${conn.project} → ${err.status ?? 'error'}`,
        };
      }
    },
  };
}
