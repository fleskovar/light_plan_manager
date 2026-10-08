/**
 * The jsonfile connector — a live connection to one local JSON file, driven by
 * the executor (LP-490).
 *
 * This is the one connector in the codebase that does **no network I/O**: the
 * file is the whole tracker. That is what makes the provider a genuinely
 * useful test/demo target — no token, no account, no server to run — and it is
 * also the proof that the provider contract is not HTTP-shaped: the executor
 * drives it through `create` / `update` / `delete` / `link` / `comment`, and
 * this file answers them with `node:fs`.
 *
 * Because the file can hard-delete, `delete` removes the issue rather than
 * closing it (the one thing GitHub cannot do, and the one capability this
 * provider advertises over it). A `link` / `unlink` adds / removes a native
 * `depends_on` edge. Everything is a whole-file read-modify-write, which is
 * fine for a demo tracker and deliberately not made concurrent.
 */

import path from 'node:path';
import { BoardError } from '../../../core/errors.js';
import { reconcileLabels } from '../../labels.js';
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
import type { JsonfileConnection } from './config.js';
import {
  nextCommentId,
  readJsonStore,
  writeJsonStore,
  type JsonIssue,
  type JsonStore,
} from './store.js';

/** A stored issue as a wire record — the shape `get` / `list` return. */
function recordOf(issue: JsonIssue): RemoteRecord {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    status: issue.status,
    type: issue.type,
    labels: issue.labels,
    assignee: issue.assignee,
    depends_on: issue.depends_on,
    comments: issue.comments,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
  };
}

/** A stored issue → `ConnectorResult`, with the post-write record (LP-288). */
function resultOf(issue: JsonIssue, file: string): ConnectorResult {
  return {
    remoteId: String(issue.number),
    remoteKey: `#${issue.number}`,
    remoteUrl: `file://${file}#${issue.number}`,
    remoteRev: issue.updated_at,
    record: recordOf(issue),
  };
}

/**
 * Build a jsonfile connector from a validated connection block.
 *
 * `file` is required (the schema enforces it); there is no token and no
 * `base_url`. The file is read on every call and rewritten on every write, so
 * two processes pointed at the same file would race — the board lock does not
 * cover the file, and a demo tracker does not need it to.
 *
 * A **relative** `file` is resolved against the board root, not the process's
 * working directory. The default path `lpm remote add` writes is relative and
 * lives under `.lpm/` — resolving it from the cwd would make `lpm remote push`
 * find the tracker from the repository root and miss it from every
 * subdirectory, which is the kind of "works on my machine" a path nobody typed
 * must not have. An absolute `file` is used exactly as written.
 */
export function jsonfileConnector(
  connection: Record<string, unknown>,
  _mapping: Record<string, unknown> = {},
  context?: ConnectorContext,
): Connector {
  const conn = connection as unknown as JsonfileConnection;
  const root = context?.paths?.root;
  const file = root !== undefined && !path.isAbsolute(conn.file) ? path.join(root, conn.file) : conn.file;

  const load = (): JsonStore => readJsonStore(file);
  const save = (store: JsonStore): void => writeJsonStore(file, store);
  const now = (): string => new Date().toISOString();

  const requireIssue = (store: JsonStore, remoteId: string): JsonIssue => {
    const issue = store.issues.find((entry) => entry.number === Number(remoteId));
    if (!issue) {
      throw new BoardError(`jsonfile: issue #${remoteId} not found in ${file}`, [
        'The issue may have been deleted from the file by hand, or the file replaced.',
      ]);
    }
    return issue;
  };

  /** A no-op result for an idempotent edge/comment write that found nothing. */
  const emptyResult = (remoteId: string): ConnectorResult => ({
    remoteId,
    remoteKey: `#${remoteId}`,
    remoteUrl: '',
    remoteRev: '',
  });

  return {
    name: 'jsonfile',

    async create(request: RemoteRequest, _signal?: AbortSignal): Promise<ConnectorResult> {
      const store = load();
      const issue: JsonIssue = {
        number: store.next_number,
        title: request.title ?? '',
        body: typeof request.body === 'string' ? request.body : '',
        status: typeof request.state === 'string' ? request.state : '',
        type: typeof request.type === 'string' ? request.type : '',
        labels: request.labels ?? [],
        assignee: request.assignee ?? null,
        depends_on: [],
        comments: [],
        created_at: now(),
        updated_at: now(),
      };
      store.next_number += 1;
      store.issues.push(issue);
      save(store);
      return resultOf(issue, file);
    },

    async update(
      remoteId: string,
      request: RemoteRequest,
      _signal?: AbortSignal,
    ): Promise<ConnectorResult> {
      const store = load();
      const issue = requireIssue(store, remoteId);

      if (request.title !== undefined) issue.title = request.title;
      if (typeof request.body === 'string') issue.body = request.body;
      if (typeof request.state === 'string') issue.status = request.state;
      if (typeof request.type === 'string') issue.type = request.type;
      if (request.assignee !== undefined) issue.assignee = request.assignee;
      if (request.labels !== undefined) {
        // Reconcile against the claim (LP-308): only the sync's own labels are
        // added or removed, so a human's triage labels survive.
        issue.labels =
          request.labelClaim !== undefined
            ? reconcileLabels(issue.labels, request.labels, request.labelClaim)
            : request.labels;
      }
      issue.updated_at = now();
      save(store);
      return resultOf(issue, file);
    },

    async delete(remoteId: string, _signal?: AbortSignal): Promise<ConnectorResult> {
      const store = load();
      const before = store.issues.length;
      store.issues = store.issues.filter((entry) => entry.number !== Number(remoteId));
      if (store.issues.length === before) return emptyResult(remoteId); // already gone — idempotent
      save(store);
      return emptyResult(remoteId);
    },

    async get(remoteId: string): Promise<RemoteRecord | null> {
      const store = load();
      const issue = store.issues.find((entry) => entry.number === Number(remoteId));
      return issue ? recordOf(issue) : null;
    },

    async resolve(key: string): Promise<ConnectorResult | null> {
      const remoteId = key.startsWith('#') ? key.slice(1) : key;
      const record = await this.get(remoteId);
      if (record === null) return null;
      const issue = (record as unknown as JsonIssue);
      return resultOf(issue, file);
    },

    describe(record: RemoteRecord): { remoteKey: string; remoteUrl: string } {
      const number = record['number'];
      const id = typeof number === 'number' || typeof number === 'string' ? String(number) : '';
      return { remoteKey: `#${id}`, remoteUrl: `file://${file}#${id}` };
    },

    async list(opts?: { cursor?: string | null; onPage?: ListProgress }): Promise<RemotePage> {
      const store = load();
      let issues = [...store.issues].sort((a, b) => a.number - b.number);
      if (opts?.cursor) {
        issues = issues.filter((entry) => entry.updated_at >= opts.cursor!);
      }
      const records = issues.map(recordOf);
      // A file is read in one go, so the listing is a single page.
      opts?.onPage?.({ page: 1, records: records.length });
      let cursor: string | null = null;
      for (const record of records) {
        if (typeof record['updated_at'] === 'string') {
          const updated = record['updated_at'] as string;
          if (cursor === null || updated > cursor) cursor = updated;
        }
      }
      return { records, cursor };
    },

    async link(
      dependentRemoteId: string,
      dependencyRemoteId: string,
      _signal?: AbortSignal,
      kind?: LinkKind,
    ): Promise<ConnectorResult> {
      if (kind === 'relates') return emptyResult(dependentRemoteId); // no native relate edge
      const store = load();
      const issue = requireIssue(store, dependentRemoteId);
      const dependency = Number(dependencyRemoteId);
      if (!issue.depends_on.includes(dependency)) issue.depends_on.push(dependency);
      issue.updated_at = now();
      save(store);
      return resultOf(issue, file);
    },

    async unlink(
      dependentRemoteId: string,
      dependencyRemoteId: string,
      _signal?: AbortSignal,
      kind?: LinkKind,
    ): Promise<ConnectorResult> {
      if (kind === 'relates') return emptyResult(dependentRemoteId);
      const store = load();
      const issue = requireIssue(store, dependentRemoteId);
      issue.depends_on = issue.depends_on.filter((entry) => entry !== Number(dependencyRemoteId));
      issue.updated_at = now();
      save(store);
      return resultOf(issue, file);
    },

    async comment(remoteId: string, body: string, _signal?: AbortSignal): Promise<ConnectorResult> {
      const store = load();
      const issue = requireIssue(store, remoteId);
      const comment = { id: nextCommentId(store), body, author: '', created_at: now() };
      issue.comments.push(comment);
      issue.updated_at = now();
      save(store);
      return {
        remoteId,
        remoteKey: `#${remoteId}`,
        remoteUrl: '',
        remoteRev: issue.updated_at,
        commentId: String(comment.id),
      };
    },

    async listComments(remoteId: string, _signal?: AbortSignal): Promise<RemoteComment[]> {
      const store = load();
      const issue = store.issues.find((entry) => entry.number === Number(remoteId));
      return (issue?.comments ?? []).map((comment) => ({
        id: String(comment.id),
        author: comment.author,
        createdAt: comment.created_at,
        body: comment.body,
      }));
    },

    async editComment(
      remoteId: string,
      commentId: string,
      body: string,
      _signal?: AbortSignal,
    ): Promise<ConnectorResult> {
      const store = load();
      const issue = requireIssue(store, remoteId);
      const comment = issue.comments.find((entry) => entry.id === Number(commentId));
      if (comment) comment.body = body;
      issue.updated_at = now();
      save(store);
      return { remoteId, remoteKey: `#${remoteId}`, remoteUrl: '', remoteRev: issue.updated_at, commentId };
    },

    async deleteComment(
      remoteId: string,
      commentId: string,
      _signal?: AbortSignal,
    ): Promise<ConnectorResult> {
      const store = load();
      const issue = requireIssue(store, remoteId);
      issue.comments = issue.comments.filter((entry) => entry.id !== Number(commentId));
      issue.updated_at = now();
      save(store);
      return { remoteId, remoteKey: `#${remoteId}`, remoteUrl: '', remoteRev: issue.updated_at, commentId };
    },

    async reachable(): Promise<ReachabilityResult> {
      // The file is the whole remote: it exists, or the remote is empty — both
      // are reachable. A directory that cannot be created would fail on write.
      return { reachable: true, evidence: `file ${file}` };
    },
  };
}
