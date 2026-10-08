/**
 * The Linear connector — a live connection to one team's workspace, driven by
 * the executor (LP-490).
 *
 * Linear has a single GraphQL endpoint (`https://api.linear.app/graphql`) and
 * one API key. All network I/O for this provider lives here, never in the
 * planners. Built from a validated `connection` block (`team`, `api_key`,
 * optional `base_url`); `mapping` shapes how states, labels, accounts and
 * cycles are written.
 *
 * ## What is and is not resolved here
 *
 * Linear addresses its workflow states, labels, cycles and assignees by UUID.
 * Resolving the board's *names* to those UUIDs — the team's `workflowStates`,
 * `issueLabels`, `cycles` and users — is LP-333 / LP-334's work. This
 * connector (the LP-332 slice, the pure-addition proof) writes the mapped
 * names directly as ids; the conformance suite's in-memory tracker accepts
 * names, and a real Linear remote needs the resolution layer those stories
 * add. The shape of every mutation and query here is Linear's own, so that
 * layer lands without reshaping the connector.
 *
 * `delete` archives the issue (`issueDelete` — Linear's trash, with the 30-day
 * grace period); Linear is the one platform where a real restore
 * (`issueUnarchive`) exists, but that is `on_delete: restore`'s concern
 * (LP-267), not the delete method's.
 */

import { BoardError } from '../../../core/errors.js';
import type {
  Connector,
  ConnectorContext,
  ConnectorResult,
  LinkKind,
  ReachabilityResult,
  RemoteComment,
  ListProgress,
  RemotePage,
  RemoteRecord,
  RemoteRequest,
} from '../../provider.js';
import { reconcileLabels } from '../../labels.js';
import type { RemoteVocabulary } from '../../reconcile.js';
import type { LinearConnection } from './config.js';
import type { LinearEstimateConnector, LinearEstimateScale } from './estimate.js';
import { labelClaimFromLinearMapping } from './labels.js';
import type { LinearWorkflowState, LinearWorkflowStatesConnector } from './states.js';

/** The Linear issue fields every read and write asks for. */
const ISSUE_SELECTION = [
  'id',
  'identifier',
  'title',
  'description',
  'state { id name type }',
  'labels { id name }',
  'assignee { id name email }',
  'estimate',
  'priority',
  'parent { id }',
  'relations { nodes { id type issue { id } relatedIssue { id } } }',
  'inverseRelations { nodes { id type issue { id } relatedIssue { id } } }',
  'cycle { id name number startsAt endsAt }',
  'updatedAt',
  'url',
].join(' ');

const DEFAULT_BASE = 'https://api.linear.app';

/** The decoded body of one GraphQL response: `data` and an optional `errors` list. */
interface GraphqlResponse {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

/**
 * A single GraphQL call. `errors` on a 200 is decoded and thrown as a
 * `BoardError` naming the operation — a missing object reads as a platform
 * miss, not a transport failure, which is what lets `get` return `null`.
 */
async function graphql(
  base: string,
  apiKey: string | undefined,
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers['authorization'] = apiKey;

  let response: Response;
  try {
    response = await fetch(`${base}/graphql`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
      signal,
    });
  } catch (error) {
    throw new BoardError(`Linear request failed: ${operationName(query)}`, [
      (error as Error).message,
    ]);
  }
  if (!response.ok) {
    throw new BoardError(`Linear ${operationName(query)} failed (${response.status})`, [
      await response.text(),
    ]);
  }
  const body = (await response.json()) as GraphqlResponse;
  if (body.errors && body.errors.length > 0) {
    throw new BoardError(
      `Linear refused ${operationName(query)}: ${body.errors.map((error) => error.message).join('; ')}`,
    );
  }
  return (body.data ?? {}) as Record<string, unknown>;
}

/** The operation name, for error messages. */
function operationName(query: string): string {
  const match = /(?:mutation|query)\s+([A-Za-z0-9_]+)/.exec(query);
  return match ? match[1]! : 'request';
}

/** Read the issue out of an `issueCreate` / `issueUpdate` payload. */
function issueFromMutation(data: Record<string, unknown>): RemoteRecord {
  const mutation = Object.values(data)[0] as Record<string, unknown> | undefined;
  const issue = mutation?.['issue'] as RemoteRecord | null | undefined;
  return (issue as RemoteRecord) ?? {};
}

/** Read the record's `updatedAt` revision marker. */
function revOf(record: RemoteRecord): string {
  return typeof record['updatedAt'] === 'string' ? (record['updatedAt'] as string) : '';
}

/** A Linear issue record → `ConnectorResult`, reading the post-write state. */
function resultOf(record: RemoteRecord): ConnectorResult {
  const id = typeof record['id'] === 'string' ? record['id'] : String(record['id'] ?? '');
  const identifier = typeof record['identifier'] === 'string' ? record['identifier'] : id;
  const url = typeof record['url'] === 'string' ? record['url'] : '';
  return {
    remoteId: id,
    remoteKey: identifier || id,
    remoteUrl: url,
    remoteRev: revOf(record),
    record,
  };
}

/**
 * Build a Linear connector from a validated connection block.
 *
 * `team` is required (the schema enforces it); `api_key` authenticates when
 * present, and `base_url` points at a proxied or self-hosted Linear when set.
 */
export function linearConnector(
  connection: Record<string, unknown>,
  mapping: Record<string, unknown> = {},
  _context?: ConnectorContext,
): Connector & LinearWorkflowStatesConnector & LinearEstimateConnector {
  const conn = connection as unknown as LinearConnection;
  const base = (conn.base_url ?? DEFAULT_BASE).replace(/\/+$/, '');
  const team = conn.team;
  const apiKey = conn.api_key;

  /** The mapping's label claim, for label reconciliation (LP-308). */
  const claim = () => labelClaimFromLinearMapping(mapping as never);

  /** Linear labels as plain names, from a record. */
  function labelNamesOf(record: RemoteRecord | null): string[] {
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

  /** Read an issue's relations from both sides: `relations` (the issue is the
   * source) and `inverseRelations` (the issue is the target). */
  function relationsOf(
    record: RemoteRecord | null,
  ): Array<{ id: string; type: string; issueId: string; relatedId: string }> {
    const read = (value: unknown): Array<Record<string, unknown>> => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const nodes = (value as Record<string, unknown>)['nodes'];
      if (!Array.isArray(nodes)) return [];
      return nodes.filter(
        (node): node is Record<string, unknown> => node !== null && typeof node === 'object',
      );
    };
    const endpointIdOf = (node: Record<string, unknown>, key: string): string => {
      const side = node[key];
      if (!side || typeof side !== 'object') return '';
      const id = (side as Record<string, unknown>)['id'];
      return typeof id === 'string' ? id : typeof id === 'number' ? String(id) : '';
    };
    const out: Array<{ id: string; type: string; issueId: string; relatedId: string }> = [];
    for (const node of [...read(record?.relations), ...read(record?.['inverseRelations'])]) {
      const id = node['id'];
      const type = node['type'];
      out.push({
        id: typeof id === 'string' ? id : typeof id === 'number' ? String(id) : '',
        type: typeof type === 'string' ? type : '',
        issueId: endpointIdOf(node, 'issue'),
        relatedId: endpointIdOf(node, 'relatedIssue'),
      });
    }
    return out;
  }

  /** A relation's Linear type name from the link kind. */
  function relationType(kind: LinkKind): string {
    return kind === 'relates' ? 'related' : 'blocks';
  }

  return {
    name: 'linear',

    async create(request: RemoteRequest, signal?: AbortSignal): Promise<ConnectorResult> {
      const query = `mutation IssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE_SELECTION} } } }`;
      const variables = {
        input: {
          teamId: team,
          title: request.title ?? '',
          description: request.body ?? '',
          // Names stand in for the UUIDs LP-333 / LP-334 resolve — see the
          // file docstring.
          ...(request.state !== undefined ? { stateId: request.state } : {}),
          ...(request.estimate !== undefined ? { estimate: request.estimate } : {}),
          ...(request.labels !== undefined ? { labelIds: request.labels } : {}),
          ...(request.assignee !== undefined && request.assignee !== null
            ? { assigneeId: request.assignee }
            : {}),
          ...(request.parent !== undefined ? { parentId: request.parent } : {}),
          ...(request.period !== undefined && request.period !== null
            ? { cycleId: request.period.name }
            : {}),
        },
      };
      const data = await graphql(base, apiKey, query, variables, signal);
      return resultOf(issueFromMutation(data));
    },

    async update(remoteId: string, request: RemoteRequest, signal?: AbortSignal): Promise<ConnectorResult> {
      let labels = request.labels;
      if (request.labels !== undefined && request.labelClaim !== undefined) {
        const current = await this.get(remoteId);
        labels = reconcileLabels(labelNamesOf(current), request.labels, request.labelClaim);
      }

      const query = `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_SELECTION} } } }`;
      const variables = {
        id: remoteId,
        input: {
          ...(request.title !== undefined ? { title: request.title } : {}),
          ...(request.body !== undefined ? { description: request.body } : {}),
          ...(request.state !== undefined ? { stateId: request.state } : {}),
          ...(request.estimate !== undefined ? { estimate: request.estimate } : {}),
          ...(labels !== undefined ? { labelIds: labels } : {}),
          ...(request.assignee !== undefined
            ? { assigneeId: request.assignee ?? null }
            : {}),
          ...(request.period !== undefined
            ? { cycleId: request.period === null ? null : request.period.name }
            : {}),
        },
      };
      const data = await graphql(base, apiKey, query, variables, signal);
      return resultOf(issueFromMutation(data));
    },

    async delete(remoteId: string, signal?: AbortSignal): Promise<ConnectorResult> {
      const query = `mutation IssueDelete($id: String!) { issueDelete(id: $id) { success } }`;
      await graphql(base, apiKey, query, { id: remoteId }, signal);
      return { remoteId, remoteKey: remoteId, remoteUrl: '', remoteRev: '' };
    },

    async get(remoteId: string): Promise<RemoteRecord | null> {
      const query = `query Issue($id: String!) { issue(id: $id) { ${ISSUE_SELECTION} } }`;
      const data = await graphql(base, apiKey, query, { id: remoteId });
      const issue = data['issue'] as RemoteRecord | null | undefined;
      return issue ?? null;
    },

    async resolve(key: string): Promise<ConnectorResult | null> {
      // Linear issues resolve by identifier (`LIN-1`) or id. The fake keys by
      // the numeric id; a real connector resolves the identifier through a
      // search — LP-367's concern, not this slice's.
      const record = await this.get(key);
      return record === null ? null : resultOf(record);
    },

    describe(record: RemoteRecord): { remoteKey: string; remoteUrl: string } {
      const result = resultOf(record);
      return { remoteKey: result.remoteKey, remoteUrl: result.remoteUrl };
    },

    async list(opts?: { cursor?: string | null; onPage?: ListProgress }): Promise<RemotePage> {
      // Incremental through `updatedAt` filtering, paged by relay cursor —
      // Linear's own mechanism (LP-267). The cursor returned is the newest
      // `updatedAt` seen, so the next pull asks only for what changed after it.
      const filter: Record<string, unknown> = { team: { id: { eq: team } } };
      if (opts?.cursor) filter['updatedAt'] = { gte: opts.cursor };

      const query = `query Issues($filter: IssueFilter, $first: Int, $after: String) { issues(filter: $filter, first: $first, after: $after) { nodes { ${ISSUE_SELECTION} } pageInfo { hasNextPage endCursor } } }`;
      const records: RemoteRecord[] = [];
      let after: string | null = null;
      let pages = 0;
      for (;;) {
        const variables: Record<string, unknown> = { filter, first: 50 };
        if (after !== null) variables['after'] = after;
        const data = await graphql(base, apiKey, query, variables);
        const issues = data['issues'] as Record<string, unknown> | undefined;
        const nodes = issues?.['nodes'];
        if (Array.isArray(nodes)) records.push(...(nodes as RemoteRecord[]));
        pages += 1;
        opts?.onPage?.({ page: pages, records: records.length });
        const pageInfo = issues?.['pageInfo'] as Record<string, unknown> | undefined;
        if (pageInfo?.['hasNextPage'] !== true) break;
        const endCursor = pageInfo?.['endCursor'];
        if (typeof endCursor !== 'string' || endCursor === '') break;
        after = endCursor;
      }

      let cursor: string | null = null;
      for (const record of records) {
        const updatedAt = revOf(record);
        if (updatedAt !== '' && (cursor === null || updatedAt > cursor)) cursor = updatedAt;
      }
      return { records, cursor };
    },

    async link(
      dependentRemoteId: string,
      dependencyRemoteId: string,
      signal?: AbortSignal,
      kind?: LinkKind,
    ): Promise<ConnectorResult> {
      const type = relationType(kind ?? 'depends');
      // Linear's relation reads "issueId <type> relatedIssueId" (LP-334): for
      // `blocks` the blocker is `issueId` and the blocked issue `relatedIssueId`.
      // The board's `depends_on` points from the dependent to its dependency, so
      // the *dependency* blocks the dependent — `issueId` is the dependency.
      // `related` is symmetric, so the dependent leads.
      const input =
        kind === 'relates'
          ? { issueId: dependentRemoteId, relatedIssueId: dependencyRemoteId, type }
          : { issueId: dependencyRemoteId, relatedIssueId: dependentRemoteId, type };
      const query = `mutation IssueRelationCreate($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success } }`;
      await graphql(base, apiKey, query, { input }, signal);
      return { remoteId: dependentRemoteId, remoteKey: dependentRemoteId, remoteUrl: '', remoteRev: '' };
    },

    async unlink(
      dependentRemoteId: string,
      dependencyRemoteId: string,
      signal?: AbortSignal,
      kind?: LinkKind,
    ): Promise<ConnectorResult> {
      // Linear relations are removed by relation id, which needs a read first:
      // find the relation between the two ids and delete it by id. A relation
      // already gone is a no-op (LP-334).
      const type = relationType(kind ?? 'depends');
      const record = await this.get(dependentRemoteId);
      const match = relationsOf(record).find((relation) => {
        if (relation.type !== type) return false;
        if (kind === 'relates') {
          // `related` is symmetric: either orientation is the same edge.
          return (
            (relation.issueId === dependentRemoteId && relation.relatedId === dependencyRemoteId) ||
            (relation.issueId === dependencyRemoteId && relation.relatedId === dependentRemoteId)
          );
        }
        // `blocks` is directional: the dependency (blocker) is `issueId`, the
        // dependent (blocked) is `relatedIssueId` (LP-334).
        return relation.issueId === dependencyRemoteId && relation.relatedId === dependentRemoteId;
      });
      if (match === undefined) {
        return { remoteId: dependentRemoteId, remoteKey: dependentRemoteId, remoteUrl: '', remoteRev: '' };
      }
      const query = `mutation IssueRelationDelete($id: String!) { issueRelationDelete(id: $id) { success } }`;
      await graphql(base, apiKey, query, { id: match.id }, signal);
      return { remoteId: dependentRemoteId, remoteKey: dependentRemoteId, remoteUrl: '', remoteRev: '' };
    },

    async comment(remoteId: string, body: string, signal?: AbortSignal): Promise<ConnectorResult> {
      const query = `mutation CommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }`;
      const data = await graphql(base, apiKey, query, { input: { issueId: remoteId, body } }, signal);
      const mutation = Object.values(data)[0] as Record<string, unknown> | undefined;
      const comment = mutation?.['comment'] as Record<string, unknown> | undefined;
      const commentId = typeof comment?.['id'] === 'string' ? (comment['id'] as string) : '';
      return {
        remoteId,
        remoteKey: remoteId,
        remoteUrl: '',
        remoteRev: '',
        commentId,
      };
    },

    async editComment(remoteId: string, commentId: string, body: string, signal?: AbortSignal): Promise<ConnectorResult> {
      const query = `mutation CommentUpdate($id: String!, $input: CommentUpdateInput!) { commentUpdate(id: $id, input: $input) { success } }`;
      await graphql(base, apiKey, query, { id: commentId, input: { body } }, signal);
      return { remoteId, remoteKey: remoteId, remoteUrl: '', remoteRev: '', commentId };
    },

    async deleteComment(remoteId: string, commentId: string, signal?: AbortSignal): Promise<ConnectorResult> {
      const query = `mutation CommentDelete($id: String!) { commentDelete(id: $id) { success } }`;
      await graphql(base, apiKey, query, { id: commentId }, signal);
      return { remoteId, remoteKey: remoteId, remoteUrl: '', remoteRev: '', commentId };
    },

    async listComments(remoteId: string, signal?: AbortSignal): Promise<RemoteComment[]> {
      const query = `query Comments($issueId: String!) { issue(id: $issueId) { comments { nodes { id body createdAt user { name } } } } }`;
      const data = await graphql(base, apiKey, query, { issueId: remoteId }, signal);
      const issue = data['issue'] as Record<string, unknown> | undefined;
      const comments = issue?.['comments'] as Record<string, unknown> | undefined;
      const nodes = comments?.['nodes'];
      if (!Array.isArray(nodes)) return [];
      return nodes
        .map((node) => {
          if (!node || typeof node !== 'object') return null;
          const n = node as Record<string, unknown>;
          const id = n['id'];
          const user = n['user'] as Record<string, unknown> | undefined;
          return {
            id: typeof id === 'string' ? id : typeof id === 'number' ? String(id) : '',
            author: typeof user?.['name'] === 'string' ? (user['name'] as string) : '',
            createdAt: typeof n['createdAt'] === 'string' ? (n['createdAt'] as string) : '',
            body: typeof n['body'] === 'string' ? (n['body'] as string) : '',
          };
        })
        .filter((entry): entry is RemoteComment => entry !== null);
    },

    async reachable(): Promise<ReachabilityResult> {
      const query = `query Team($id: String!) { team(id: $id) { id name } }`;
      try {
        const data = await graphql(base, apiKey, query, { id: team });
        return {
          reachable: data['team'] != null,
          evidence: `team(${team}) → ${data['team'] != null ? 'reachable' : 'not found'}`,
        };
      } catch (error) {
        return { reachable: false, evidence: (error as Error).message };
      }
    },

    /**
     * The team's own words (LP-537): its workflow states, and deliberately **no
     * `types` key** — Linear has no issue types, so a board type is a label of
     * our own choosing and there is nothing to reconcile. Omitting the key says
     * "this platform has no such vocabulary"; an empty list would say "the team
     * reported none", which would mark every mapped type unresolved.
     */
    async vocabulary(): Promise<RemoteVocabulary> {
      const states = await this.workflowStates!();
      return { statuses: states.map((state) => state.name) };
    },

    async workflowStates(): Promise<LinearWorkflowState[]> {
      const query = `query TeamStates($teamId: String!) { team(id: $teamId) { states(first: 250) { nodes { id name type } } } }`;
      const data = await graphql(base, apiKey, query, { teamId: team });
      const teamNode = data['team'] as Record<string, unknown> | undefined;
      const states = teamNode?.['states'] as Record<string, unknown> | undefined;
      const nodes = states?.['nodes'];
      if (!Array.isArray(nodes)) return [];
      return nodes
        .map((node) => {
          if (!node || typeof node !== 'object') return null;
          const n = node as Record<string, unknown>;
          const id = n['id'];
          const name = n['name'];
          const type = n['type'];
          return {
            id: typeof id === 'string' ? id : typeof id === 'number' ? String(id) : '',
            name: typeof name === 'string' ? name : '',
            type: typeof type === 'string' ? type : '',
          };
        })
        .filter((entry): entry is LinearWorkflowState => entry !== null && entry.name !== '');
    },

    async estimateScale(): Promise<LinearEstimateScale> {
      const query = `query TeamEstimate($teamId: String!) { team(id: $teamId) { issueEstimationType issueEstimationAllowZero issueEstimationExtended } }`;
      const data = await graphql(base, apiKey, query, { teamId: team });
      const teamNode = data['team'] as Record<string, unknown> | undefined;
      return {
        type:
          typeof teamNode?.['issueEstimationType'] === 'string'
            ? (teamNode['issueEstimationType'] as string)
            : 'notUsed',
        allowZero: teamNode?.['issueEstimationAllowZero'] === true,
        extended: teamNode?.['issueEstimationExtended'] === true,
      };
    },
  };
}
