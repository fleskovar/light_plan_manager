/**
 * The GitHub connector — a live connection to one repo, driven by the executor
 * (LP-490).
 *
 * Built from a validated `connection` block (`repo`, optional `token` and
 * `base_url`). All network I/O in the remote layer lives here, never in the
 * planners: `planPush` and `planPull` stay pure, and a dry-run shares their
 * code path because the executor is the only thing that ever calls this.
 *
 * GitHub cannot hard-delete an issue over the REST API, so `delete` closes the
 * issue instead — the degradation is documented here rather than silently
 * pretended away, and the capabilities of the provider say as much.
 *
 * `request.period` is applied to the configured carrier (LP-313): a
 * `milestones` carrier resolves the period's name to a repository milestone
 * (creating it when absent) and writes `milestone` on the issue; an
 * `iteration` carrier resolves the period's name to a Project iteration and
 * writes the Project field value. A `null` period clears the carrier.
 *
 * `request.parent` is applied as a native sub-issue where the account has the
 * API (LP-309): the issue is filed, then added to its parent through the
 * sub-issues endpoint. The executor only sets `parent` when the resolved
 * hierarchy encoding is `sub-issues` and the document sits within the native
 * depth; deeper parents ride the managed block instead (see `hierarchy.ts`).
 */

import { BoardError } from '../../../core/errors.js';
import { reconcileLabels } from '../../labels.js';
import { normalizePeriodMapping, type PeriodCarrier, type PeriodContainer } from '../../periods.js';
import { nextLink } from '../../transport/http.js';
import { githubNativeParentIdOf } from './hierarchy.js';
import type {
  Connector,
  ConnectorContext,
  ConnectorResult,
  ReachabilityResult,
  RemoteComment,
  ListProgress,
  RemotePage,
  RemoteRecord,
  RemoteRequest,
} from '../../provider.js';
import {
  findProjectItemId,
  projectStatusFieldOf,
  readProjectItemFieldValue,
  setProjectStatusField,
} from './project-status.js';
import {
  clearProjectIteration,
  projectIterationFieldOf,
  readProjectIteration,
  setProjectIteration,
} from './project-iteration.js';
import {
  resolveProjectIds,
  type ProjectGraphqlConnector,
} from './projects.js';

interface GithubConnection {
  repo: string;
  token?: string;
  base_url?: string;
}

const DEFAULT_BASE = 'https://api.github.com';

/**
 * A pull request is an issue carrying GitHub's `pull_request` marker — never a
 * story.  The Issues API returns both, and treating a PR as a story is the
 * classic GitHub integration bug (LP-315), invisible until a board fills with
 * "Bump lodash".
 */
function isPullRequest(record: RemoteRecord): boolean {
  const marker = record['pull_request'];
  return marker !== undefined && marker !== null;
}

/** Turn a GitHub API response body into a `ConnectorResult`. */
function resultOf(issue: RemoteRecord, repo: string): ConnectorResult {
  const number = issue.number;
  const id = typeof number === 'number' ? String(number) : String(number ?? '');
  const htmlUrl = typeof issue.html_url === 'string' ? issue.html_url : '';
  const updatedAt = typeof issue.updated_at === 'string' ? issue.updated_at : '';
  const nodeId = typeof issue.node_id === 'string' ? issue.node_id : undefined;
  return {
    remoteId: id,
    remoteKey: `${repo}#${id}`,
    remoteUrl: htmlUrl,
    remoteRev: updatedAt,
    // The GraphQL node id, recorded beside the number so a later GraphQL
    // story (sub-issues, Projects v2) can address the issue without a second
    // lookup (LP-307).
    ...(nodeId !== undefined ? { nodeId } : {}),
    // The full post-write issue, so the executor records the base from what
    // GitHub actually stored — not what we asked it to (LP-288).
    record: issue,
  };
}

/**
 * Turn a GitHub issue-comment response into a `ConnectorResult`.  `remoteId`
 * stays the issue id (the document the comment hangs off); the comment's own
 * id travels in `commentId`, which is what the executor records in the link
 * store so the next push edits rather than duplicates it (LP-278).
 */
function commentResult(
  comment: RemoteRecord,
  repo: string,
  issueRemoteId: string,
): ConnectorResult {
  const id = comment.id;
  const commentId = typeof id === 'number' ? String(id) : String(id ?? '');
  const htmlUrl = typeof comment.html_url === 'string' ? comment.html_url : '';
  const updatedAt = typeof comment.updated_at === 'string' ? comment.updated_at : '';
  return {
    remoteId: issueRemoteId,
    remoteKey: `${repo}#${issueRemoteId}`,
    remoteUrl: htmlUrl,
    remoteRev: updatedAt,
    commentId,
  };
}

/**
 * Build a GitHub connector from a validated connection block.
 *
 * `repo` is required (the schema enforces it); `token` authenticates when
 * present, and `base_url` points at a GitHub Enterprise host when set.
 */
export function githubConnector(
  connection: Record<string, unknown>,
  _mapping: Record<string, unknown> = {},
  context?: ConnectorContext,
): Connector {
  const conn = connection as unknown as GithubConnection;
  const mapping = _mapping;
  const base = conn.base_url ?? DEFAULT_BASE;
  const repo = conn.repo;

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'light-plan',
  };
  if (conn.token) headers.Authorization = `Bearer ${conn.token}`;

  async function call(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<RemoteRecord | null> {
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method,
        headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw new BoardError(`GitHub request failed: ${method} ${path}`, [
        (error as Error).message,
      ]);
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new BoardError(`GitHub ${method} ${path} failed (${response.status})`, [
        await response.text(),
      ]);
    }
    if (response.status === 204) return null;
    return (await response.json()) as RemoteRecord;
  }

  /**
   * One page of the issues listing: the records plus the absolute URL of the
   * next page from the `Link` header's `rel="next"`, or `null` on the last
   * page.  `url` is absolute — the first page is composed by the caller from
   * `base`, later pages arrive as absolute URLs GitHub returns.
   */
  async function callPage(url: string): Promise<{ records: RemoteRecord[]; next: string | null }> {
    let response: Response;
    try {
      response = await fetch(url, { method: 'GET', headers });
    } catch (error) {
      throw new BoardError(`GitHub request failed: GET ${url}`, [(error as Error).message]);
    }
    if (response.status === 404) return { records: [], next: null };
    if (!response.ok) {
      throw new BoardError(`GitHub GET ${url} failed (${response.status})`, [await response.text()]);
    }
    if (response.status === 204) return { records: [], next: null };
    const body = (await response.json()) as unknown;
    const records = Array.isArray(body) ? (body as RemoteRecord[]) : [];
    const next = nextLink(Object.fromEntries(response.headers.entries()));
    return { records, next };
  }

  /**
   * A probe read: "does this account have X?" 401/403/404/410 all answer
   * "no" — a permission loss or a plan without the feature is a capability
   * fact, not a failure — so this returns `null` where `call` would throw.
   */
  async function probeCall(path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, { method: 'GET', headers });
    } catch (error) {
      throw new BoardError(`GitHub probe failed: GET ${path}`, [(error as Error).message]);
    }
    if (
      response.status === 401 ||
      response.status === 403 ||
      response.status === 404 ||
      response.status === 410
    ) {
      return null;
    }
    if (!response.ok) {
      throw new BoardError(`GitHub probe GET ${path} failed (${response.status})`, [
        await response.text(),
      ]);
    }
    if (response.status === 204) return null;
    return await response.json();
  }

  /** Read an issue's labels as plain strings, or [] when the record has none. */
  function labelsOf(record: RemoteRecord | null): string[] {
    const labels = record?.labels;
    if (!Array.isArray(labels)) return [];
    return labels
      .map((label) => {
        if (typeof label === 'string') return label;
        if (label && typeof label === 'object') {
          const name = (label as { name?: unknown }).name;
          if (typeof name === 'string') return name;
        }
        return '';
      })
      .filter((label) => label.length > 0);
  }

  /** A write failure while assigning someone: name the user and the issue. */
  function assigneeFailure(
    error: unknown,
    where: string,
    assignee: string | null | undefined,
  ): BoardError {
    if (!assignee) {
      return error instanceof BoardError ? error : new BoardError(String(error));
    }
    return new BoardError(`Cannot assign "${assignee}" on ${where}`, [
      `GitHub refused the assignment: ${error instanceof Error ? error.message : String(error)}`,
      'The account may not be a collaborator on this repository.',
    ]);
  }

  /**
   * The GraphQL entry point, shared by the returned object's `graphql` method
   * and the Project status read/write (LP-312). The endpoint is
   * `https://api.github.com/graphql` (or `<host>/api/graphql` beside an
   * `/api/v3` Enterprise root); a 200 with an `errors` array is decoded and
   * returned, not thrown — a missing node is "not found" rather than a failure.
   */
  async function graphqlImpl(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const endpoint = base.endsWith('/api/v3')
      ? `${base.slice(0, -'/api/v3'.length)}/api/graphql`
      : `${base}/graphql`;
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
    } catch (error) {
      throw new BoardError(`GitHub GraphQL request failed: ${endpoint}`, [
        (error as Error).message,
      ]);
    }
    if (!response.ok) {
      throw new BoardError(`GitHub GraphQL request failed (${response.status})`, [
        await response.text(),
      ]);
    }
    return (await response.json()) as Record<string, unknown>;
  }

  /** The connector surface the Project helpers address the GraphQL API through. */
  const projectConnector: ProjectGraphqlConnector = { name: 'github', graphql: graphqlImpl };

  /** The resolver input built from the mapping and connection (LP-310). */
  const projectInput = (): {
    repo: string;
    project: number | string;
    fields: Record<string, string>;
  } => {
    const project = mapping['project'];
    if (project === undefined) {
      throw new BoardError('This remote declares no Project', [
        'Set mapping.project before syncing the Project status field.',
      ]);
    }
    const fields = (mapping['fields'] as Record<string, unknown> | undefined) ?? {};
    return {
      repo,
      project: project as number | string,
      fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, String(value)])),
    };
  };

  /** The board paths the Project ids cache lives under, or a `BoardError`. */
  function boardPaths() {
    if (context?.paths === undefined) {
      throw new BoardError('The connector has no board paths for the Project ids cache', [
        'Build the connector through `buildConnector`, which passes the board paths.',
      ]);
    }
    return context.paths;
  }

  /** Read the issue's node id (GraphQL-side) from its REST record. */
  function nodeIdOf(issue: RemoteRecord | null): string | undefined {
    const nodeId = issue && typeof issue === 'object' ? issue['node_id'] : undefined;
    return typeof nodeId === 'string' ? nodeId : undefined;
  }

  async function setProjectStatusImpl(
    remoteId: string,
    value: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const fieldName = projectStatusFieldOf(mapping);
    if (fieldName === undefined) return; // no Project status field — nothing to write
    const nodeId = nodeIdOf(await call('GET', `/repos/${repo}/issues/${remoteId}`, undefined, signal));
    if (nodeId === undefined) {
      throw new BoardError(`Cannot set the Project status for issue #${remoteId}: no node id`, [
        'The issue record did not carry a node_id, so the Project item cannot be addressed.',
      ]);
    }
    const input = projectInput();
    const resolved = await resolveProjectIds(
      projectConnector,
      input,
      boardPaths(),
      context?.remoteName ?? 'github',
    );
    await setProjectStatusField(projectConnector, resolved.ids, fieldName, nodeId, value);
  }

  async function readProjectStatusImpl(
    remoteId: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const fieldName = projectStatusFieldOf(mapping);
    if (fieldName === undefined) return undefined;
    const nodeId = nodeIdOf(await call('GET', `/repos/${repo}/issues/${remoteId}`, undefined, signal));
    if (nodeId === undefined) return undefined;
    const input = projectInput();
    const resolved = await resolveProjectIds(
      projectConnector,
      input,
      boardPaths(),
      context?.remoteName ?? 'github',
    );
    const fieldId = resolved.ids.fields[fieldName]?.id;
    if (fieldId === undefined) return undefined;
    const itemId = await findProjectItemId(projectConnector, resolved.ids.project.id, nodeId);
    if (itemId === null) return undefined;
    return readProjectItemFieldValue(projectConnector, itemId, fieldId);
  }

  // -- period carrier (LP-313) ------------------------------------------------

  /** The configured carrier, defaulting to milestones (never `sprint` here —
   * that carrier is Jira's). */
  function periodCarrier(): PeriodCarrier {
    const periodMapping = normalizePeriodMapping(mapping['periods']);
    return periodMapping?.carrier ?? 'milestones';
  }

  /**
   * Resolve a period's name to a repository milestone number, creating the
   * milestone (with its due date) when the repository does not have it.
   * Milestones are creatable over REST, so a missing one is provisioned rather
   * than refused — the same idempotent-by-construction "desired minus current"
   * behaviour `provision` follows.
   */
  async function milestoneNumberOf(container: PeriodContainer): Promise<number> {
    const response = await call('GET', `/repos/${repo}/milestones?state=all&per_page=100`);
    const milestones = Array.isArray(response) ? response : [];
    const match = milestones.find((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      return (entry as { title?: unknown }).title === container.name;
    });
    const number = match ? (match as { number?: unknown }).number : undefined;
    if (typeof number === 'number') return number;

    const created = await call('POST', `/repos/${repo}/milestones`, {
      title: container.name,
      ...(container.ends !== undefined ? { due_on: container.ends } : {}),
    });
    const createdNumber = created ? (created as { number?: unknown }).number : undefined;
    if (typeof createdNumber === 'number') return createdNumber;
    throw new BoardError(`Cannot create milestone "${container.name}" in ${repo}`, [
      'The repository refused the milestone; check the credential can create milestones.',
    ]);
  }

  /**
   * The `milestone` value for a REST create/update body: a number when the
   * period resolves to a milestone, `null` to clear, `undefined` to leave the
   * remote untouched. The `iteration` carrier never writes a REST milestone.
   */
  async function milestoneFieldFor(
    request: RemoteRequest,
  ): Promise<number | null | undefined> {
    if (periodCarrier() !== 'milestones') return undefined;
    if (request.period === undefined) return undefined;
    if (request.period === null) return null;
    return milestoneNumberOf(request.period);
  }

  /**
   * Write the period to a Project iteration field after the issue exists
   * (LP-313). The iteration carrier needs the issue's node id — which the REST
   * create/update response carries — so this runs after the REST write. A
   * `null` period clears the field; an absent period leaves it untouched.
   */
  async function applyIterationPeriod(
    request: RemoteRequest,
    issue: RemoteRecord | null,
    signal?: AbortSignal,
  ): Promise<void> {
    if (periodCarrier() !== 'iteration') return;
    if (request.period === undefined) return;
    const fieldName = projectIterationFieldOf(mapping);
    if (fieldName === undefined) return;
    const nodeId = nodeIdOf(issue);
    if (nodeId === undefined) {
      throw new BoardError('Cannot write the Project iteration: the issue record has no node id', [
        'The issue record did not carry a node_id, so the Project item cannot be addressed.',
      ]);
    }
    const resolved = await resolveProjectIds(
      projectConnector,
      projectInput(),
      boardPaths(),
      context?.remoteName ?? 'github',
    );
    if (request.period === null) {
      await clearProjectIteration(projectConnector, resolved.ids, fieldName, nodeId, signal);
    } else {
      await setProjectIteration(projectConnector, resolved.ids, fieldName, nodeId, request.period.name);
    }
  }

  /**
   * Best-effort: add the iteration title to a record as `project_iteration`,
   * for the pull to resolve (LP-313). A remote with no Project, or an issue
   * not in the Project, simply stays unenriched — the carrier has no value to
   * recover, which is the honest answer rather than a failure.
   */
  async function enrichIteration(
    record: RemoteRecord | null,
    signal?: AbortSignal,
  ): Promise<RemoteRecord | null> {
    if (record === null) return null;
    if (periodCarrier() !== 'iteration') return record;
    const fieldName = projectIterationFieldOf(mapping);
    if (fieldName === undefined) return record;
    const nodeId = nodeIdOf(record);
    if (nodeId === undefined) return record;
    try {
      const resolved = await resolveProjectIds(
        projectConnector,
        projectInput(),
        boardPaths(),
        context?.remoteName ?? 'github',
      );
      const fieldId = resolved.ids.fields[fieldName]?.id;
      if (fieldId === undefined) return record;
      const itemId = await findProjectItemId(projectConnector, resolved.ids.project.id, nodeId);
      if (itemId === null) return record;
      const title = await readProjectIteration(projectConnector, itemId, fieldId);
      if (title !== undefined) return { ...record, project_iteration: title };
    } catch {
      // Enrichment never fails a read: a missing Project is not a missing issue.
    }
    return record;
  }

  async function readProjectPeriodImpl(
    remoteId: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const fieldName = projectIterationFieldOf(mapping);
    if (fieldName === undefined) return undefined;
    if (periodCarrier() !== 'iteration') return undefined;
    const nodeId = nodeIdOf(await call('GET', `/repos/${repo}/issues/${remoteId}`, undefined, signal));
    if (nodeId === undefined) return undefined;
    const resolved = await resolveProjectIds(
      projectConnector,
      projectInput(),
      boardPaths(),
      context?.remoteName ?? 'github',
    );
    const fieldId = resolved.ids.fields[fieldName]?.id;
    if (fieldId === undefined) return undefined;
    const itemId = await findProjectItemId(projectConnector, resolved.ids.project.id, nodeId);
    if (itemId === null) return undefined;
    return readProjectIteration(projectConnector, itemId, fieldId);
  }

  return {
    name: 'github',

    async create(request: RemoteRequest, signal?: AbortSignal): Promise<ConnectorResult> {
      try {
        const milestone = await milestoneFieldFor(request);
        const issue = await call('POST', `/repos/${repo}/issues`, {
          title: request.title,
          body: request.body,
          labels: request.labels ?? [],
          // A new issue starts unassigned, so only a named account is sent.
          assignees: request.assignee ? [request.assignee] : undefined,
          ...(milestone !== undefined ? { milestone } : {}),
        }, signal);
        const result = resultOf(issue ?? {}, repo);
        // Native sub-issue parent (LP-309): the parent's number is the path,
        // the child's number the body.  Applied only when the executor set
        // `parent` — the `sub-issues` encoding within the native depth.
        if (request.parent !== undefined) {
          await call('POST', `/repos/${repo}/issues/${request.parent}/sub_issues`, {
            sub_issue_id: Number(result.remoteId),
          }, signal);
        }
        // Period carrier (LP-313): a milestone rode the POST body; an
        // iteration is written after the issue exists (its node id is in the
        // response).
        await applyIterationPeriod(request, issue ?? null, signal);
        // **A created issue is open, whatever status the board asked for.**
        // `POST /issues` takes no `state`, so a closed board document arrives
        // open and stays open: the base is recomputed from the echo, and where
        // the echo cannot be read back to a single board status the local
        // value stands — so both sides record agreement on a state the remote
        // does not hold, and no later push disagrees. Closing here is what
        // `update` already does one call later for a twin that exists.
        if (request.state === 'closed') {
          const closed = await call(
            'PATCH',
            `/repos/${repo}/issues/${result.remoteId}`,
            { state: 'closed' },
            signal,
          );
          return resultOf(closed ?? issue ?? {}, repo);
        }
        return result;
      } catch (error) {
        throw assigneeFailure(error, 'the new issue', request.assignee);
      }
    },

    async update(remoteId: string, request: RemoteRequest, signal?: AbortSignal): Promise<ConnectorResult> {
      try {
        // Reconcile labels against what the issue already carries (LP-308):
        // only the mapping's claimed labels are added or removed, so a human's
        // triage labels survive. Absent labels (or no claim) means the list is
        // sent as-is, the pre-reconciliation behaviour.
        let labels = request.labels;
        if (request.labels !== undefined && request.labelClaim !== undefined) {
          const current = await call('GET', `/repos/${repo}/issues/${remoteId}`, undefined, signal);
          labels = reconcileLabels(labelsOf(current), request.labels, request.labelClaim);
        }

        const milestone = await milestoneFieldFor(request);
        const issue = await call('PATCH', `/repos/${repo}/issues/${remoteId}`, {
          title: request.title,
          body: request.body,
          labels,
          state: request.state,
          // `assignees: []` clears, a non-empty string assigns, `undefined`
          // leaves the remote side untouched.
          assignees:
            request.assignee === undefined
              ? undefined
              : request.assignee === null
                ? []
                : [request.assignee],
          ...(milestone !== undefined ? { milestone } : {}),
        }, signal);
        // Period carrier (LP-313): an iteration is written after the REST
        // write, once the response carries the node id.
        await applyIterationPeriod(request, issue ?? null, signal);
        return resultOf(issue ?? {}, repo);
      } catch (error) {
        throw assigneeFailure(error, `issue #${remoteId}`, request.assignee);
      }
    },

    async reparent(remoteId: string, parentRemoteId: string | null, signal?: AbortSignal): Promise<ConnectorResult> {
      // Move an existing issue's native sub-issue parent (LP-493). Idempotent:
      // the issue's *native* parent is read first, so setting the parent it
      // already has, or clearing one it does not have, makes no write. The
      // block's `parent` row is a different carrier and is deliberately not
      // consulted — a labels→sub-issues migration still writes the native
      // edge even while the redundant block row is in place.
      const read = async (): Promise<RemoteRecord> =>
        (await call('GET', `/repos/${repo}/issues/${remoteId}`, undefined, signal)) ?? {};
      const current = await read();
      const nativeParent = githubNativeParentIdOf(current);

      if (parentRemoteId === null) {
        if (nativeParent === undefined) return resultOf(current, repo);
        await call('DELETE', `/repos/${repo}/issues/${remoteId}/sub_issue`, undefined, signal);
        return resultOf(await read(), repo);
      }

      if (nativeParent === parentRemoteId) return resultOf(current, repo);
      await call('POST', `/repos/${repo}/issues/${parentRemoteId}/sub_issues`, {
        sub_issue_id: Number(remoteId),
      }, signal);
      return resultOf(await read(), repo);
    },

    async delete(remoteId: string, signal?: AbortSignal): Promise<ConnectorResult> {
      // GitHub issues cannot be hard-deleted over REST; closing is the nearest
      // thing. The provider's capabilities record this degradation.
      const issue = await call('PATCH', `/repos/${repo}/issues/${remoteId}`, {
        state: 'closed',
      }, signal);
      return resultOf(issue ?? {}, repo);
    },

    async get(remoteId: string): Promise<RemoteRecord | null> {
      const record = await call('GET', `/repos/${repo}/issues/${remoteId}`);
      return enrichIteration(record);
    },

    async resolve(key: string): Promise<ConnectorResult | null> {
      // `acme/payments#418` → 418; a bare `418` is accepted too.  The number
      // is the remote id `get` addresses; the repo part is carried back in the
      // human-readable key so adoption records the same shape a create would.
      const remoteId = key.includes('#') ? key.slice(key.lastIndexOf('#') + 1) : key;
      const record = await call('GET', `/repos/${repo}/issues/${remoteId}`);
      if (record === null) return null;
      return resultOf(record, repo);
    },

    describe(record: RemoteRecord): { remoteKey: string; remoteUrl: string } {
      const result = resultOf(record, repo);
      return { remoteKey: result.remoteKey, remoteUrl: result.remoteUrl };
    },

    async list(opts?: { cursor?: string | null; onPage?: ListProgress }): Promise<RemotePage> {
      // Sorted by `updated` ascending, so the `since` cursor filters the
      // listing and the pages come back oldest-first; `per_page` is the API
      // maximum, and each page is followed through the `Link` header's
      // `rel="next"` until the listing is exhausted (LP-315).
      const params = new URLSearchParams({
        state: 'all',
        per_page: '100',
        sort: 'updated',
        direction: 'asc',
      });
      if (opts?.cursor) params.set('since', opts.cursor);

      // Page through the whole listing, dropping pull requests — the Issues
      // API returns them, and a PR is never a story (LP-315).
      const records: RemoteRecord[] = [];
      let url: string | null = `${base}/repos/${repo}/issues?${params.toString()}`;
      let pages = 0;
      while (url !== null) {
        const page = await callPage(url);
        for (const record of page.records) {
          if (isPullRequest(record)) continue;
          records.push(record);
        }
        pages += 1;
        opts?.onPage?.({ page: pages, records: records.length });
        url = page.next;
      }

      // The cursor is the newest `updated_at` seen, so the next pull asks only
      // for what changed after it.  Pull requests never contribute: a PR's
      // timestamp is not a story's.
      let cursor: string | null = null;
      for (const record of records) {
        if (typeof record.updated_at === 'string') {
          if (cursor === null || record.updated_at > cursor) cursor = record.updated_at;
        }
      }
      // Enrich each record with its iteration title when the carrier is an
      // iteration field (LP-313), so the pull resolves the period the way it
      // resolves a milestone off the REST record.
      const enriched: RemoteRecord[] = [];
      for (const record of records) {
        enriched.push((await enrichIteration(record)) ?? record);
      }
      return { records: enriched, cursor };
    },

    async probe(probeName: string): Promise<unknown> {
      const owner = repo.split('/')[0]!;
      switch (probeName) {
        case 'native_types': {
          // Org-level issue types, opt-in per repository. The presence of any
          // org issue type is the live signal; per-repo enablement is a
          // further check the LP-267 audit left unverified.
          const body = await probeCall(`/orgs/${owner}/issue-types`);
          return Array.isArray(body) && body.length > 0;
        }
        case 'custom_fields': {
          // Org issue fields carry `value_type` names (`text`, `date`,
          // `single_select`, `multi_select`, `number`). No endpoint, or none
          // listed, means the account has no custom fields.
          const body = await probeCall(`/orgs/${owner}/issue-fields`);
          if (!Array.isArray(body) || body.length === 0) return null;
          const valueTypes = new Set<string>();
          for (const field of body) {
            if (
              field &&
              typeof field === 'object' &&
              typeof (field as { value_type?: unknown }).value_type === 'string'
            ) {
              valueTypes.add((field as { value_type: string }).value_type);
            }
          }
          return valueTypes.size > 0 ? { valueTypes: [...valueTypes].sort() } : null;
        }
        case 'sub_issues': {
          // Sub-issues vary by plan and rollout and there is no org-level
          // "does this account have sub-issues" endpoint — the live signal is
          // the `parent` field GitHub adds to an issue payload only where the
          // account has the API. List one issue and ask whether its record
          // exposes the relationship; a listing with no issues (or no parent
          // field) reads conservatively as "flat" — an empty board has no
          // hierarchy to encode anyway.
          const body = await probeCall(`/repos/${repo}/issues?state=all&per_page=1`);
          const records = Array.isArray(body) ? body : [];
          const sample = records[0] as Record<string, unknown> | undefined;
          const supported =
            sample !== undefined &&
            (Object.prototype.hasOwnProperty.call(sample, 'parent') ||
              Object.prototype.hasOwnProperty.call(sample, 'parent_id'));
          return supported ? 1 : 0;
        }
        case 'provisioning': {
          // "Can this account create them?" is approximated by "the endpoint
          // answers" — a 401/403/404 reads as no. Milestones and labels are
          // always creatable over REST.
          const fields = await probeCall(`/orgs/${owner}/issue-fields`);
          return { customFields: fields !== null, periods: true, labels: true };
        }
        default:
          throw new BoardError(`Unknown GitHub capability probe "${probeName}"`);
      }
    },

    async reachable(): Promise<ReachabilityResult> {
      // The repo itself is the bulk signal: a token that lost scope, a private
      // repo this token cannot read, or a deleted/transferred repo all 404
      // here, exactly as they would for a single issue — so the probe is the
      // one read that tells "I cannot see the remote" apart from "that issue
      // is gone". A 200 means the remote is there and readable.
      const path = `/repos/${repo}`;
      try {
        const response = await fetch(`${base}${path}`, { method: 'GET', headers });
        if (response.ok) {
          return { reachable: true, evidence: `GET ${path} → ${response.status}` };
        }
        const detail = (await response.text()).trim();
        return {
          reachable: false,
          evidence: detail
            ? `GET ${path} → ${response.status}: ${detail}`
            : `GET ${path} → ${response.status}`,
        };
      } catch (error) {
        return {
          reachable: false,
          evidence: `GET ${path} failed: ${(error as Error).message}`,
        };
      }
    },

    async comment(remoteId: string, body: string, signal?: AbortSignal): Promise<ConnectorResult> {
      // GitHub returns the created comment with its `id`, `html_url` and
      // `updated_at`; the executor records the id so the next push edits this
      // comment rather than posting a duplicate (LP-278).
      const comment = await call('POST', `/repos/${repo}/issues/${remoteId}/comments`, {
        body,
      }, signal);
      return commentResult(comment ?? {}, repo, remoteId);
    },

    async editComment(
      remoteId: string,
      commentId: string,
      body: string,
      signal?: AbortSignal,
    ): Promise<ConnectorResult> {
      await call('PATCH', `/repos/${repo}/issues/comments/${commentId}`, { body }, signal);
      return commentResult({ id: commentId }, repo, remoteId);
    },

    async deleteComment(
      remoteId: string,
      commentId: string,
      signal?: AbortSignal,
    ): Promise<ConnectorResult> {
      // 204 No Content — the comment is gone, and the issue id is what a
      // caller still needs to address the document.
      await call('DELETE', `/repos/${repo}/issues/comments/${commentId}`, undefined, signal);
      return commentResult({ id: commentId }, repo, remoteId);
    },

    async listComments(remoteId: string, signal?: AbortSignal): Promise<RemoteComment[]> {
      // `GET /repos/:owner/:repo/issues/:number/comments` returns the issue's
      // user comments, oldest first, paged through the `Link` header like the
      // issue listing.  The author is `user.login`; a comment from a deleted
      // account has no login and is reported under the empty name rather than
      // dropped (the pull still appends it — the thread is the thread).
      const comments: RemoteComment[] = [];
      let url: string | null = `${base}/repos/${repo}/issues/${remoteId}/comments?per_page=100`;
      while (url !== null) {
        const page = await callPage(url);
        for (const raw of page.records) {
          const record = raw as unknown as Record<string, unknown>;
          const id = record['id'];
          const user = record['user'] as Record<string, unknown> | undefined;
          const createdAt = record['created_at'];
          comments.push({
            id: typeof id === 'number' ? String(id) : String(id ?? ''),
            author: typeof user?.['login'] === 'string' ? (user['login'] as string) : '',
            createdAt: typeof createdAt === 'string' ? createdAt : '',
            body: typeof record['body'] === 'string' ? record['body'] : '',
          });
        }
        url = page.next;
        if (signal?.aborted) break;
      }
      return comments;
    },

    async listLabels(): Promise<string[]> {
      // `GET /repos/:owner/:repo/labels` returns the repo's labels, newest
      // first, one page of 100. A larger taxonomy would need the paging the
      // issue listing already skips; one page covers every board in practice.
      const response = await call('GET', `/repos/${repo}/labels?per_page=100`);
      if (!Array.isArray(response)) return [];
      return response
        .map((label) => {
          if (typeof label === 'string') return label;
          if (label && typeof label === 'object') {
            const name = (label as { name?: unknown }).name;
            if (typeof name === 'string') return name;
          }
          return '';
        })
        .filter((label) => label.length > 0);
    },

    async createLabel(name: string, color: string, signal?: AbortSignal): Promise<void> {
      // `POST /repos/:owner/:repo/labels` creates a label; the colour is the
      // hex string without a leading `#`. A label that already exists is a
      // 422, which `provision` avoids by checking `listLabels` first.
      await call('POST', `/repos/${repo}/labels`, { name, color }, signal);
    },

    async setProjectStatus(
      remoteId: string,
      value: string,
      signal?: AbortSignal,
    ): Promise<void> {
      await setProjectStatusImpl(remoteId, value, signal);
    },

    async readProjectStatus(remoteId: string, signal?: AbortSignal): Promise<string | undefined> {
      return readProjectStatusImpl(remoteId, signal);
    },

    async readProjectPeriod(remoteId: string, signal?: AbortSignal): Promise<string | undefined> {
      return readProjectPeriodImpl(remoteId, signal);
    },

    graphql: graphqlImpl,
  };
}
