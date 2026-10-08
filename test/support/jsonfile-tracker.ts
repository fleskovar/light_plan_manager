/**
 * The file-backed tracker double (LP-360) — the jsonfile provider's stand-in
 * for the in-memory HTTP tracker the conformance suite (LP-300) runs every
 * other provider against.
 *
 * The provider's connector writes to a local JSON file with `node:fs`, so the
 * HTTP `memory-tracker.ts` cannot play the platform: there is no request to
 * route. This double reads and writes the *same file* the connector does —
 * through the provider's own `store.ts` — and exposes the same inspection /
 * mutation surface the conformance scenarios drive (`issues()`, `comments()`,
 * `dependencies()`, `mutateIssue()`, `deleteIssue()`), so the shared scenario
 * bodies need no per-provider branch.
 *
 * It exists in `test/support/`, never shipped, exactly like the memory
 * tracker. It implements `MemoryConnector` so the harness can pass it anywhere
 * a tracker is expected; the transport methods (`request` / `paginate`) are
 * unreachable stubs because the jsonfile connector never calls them.
 */

import type {
  RemoteRequest,
  RemoteResponse,
} from '../../src/remote/transport/connector.js';
import type { StoredComment, StoredIssue, TrackerRecord, SeedIssue } from './memory-tracker.js';
import type { MemoryConnector } from './memory-tracker.js';
import {
  readJsonStore,
  writeJsonStore,
  type JsonComment,
  type JsonIssue,
  type JsonStore,
} from '../../src/remote/providers/jsonfile/store.js';

/** The jsonfile tracker double, with its file path exposed for the harness. */
export type JsonFileTracker = MemoryConnector & { readonly file: string };

/** The jsonfile-specific fields a scenario mutates on a stored issue. */
export interface JsonIssuePatch {
  title?: string;
  body?: string;
  status?: string;
  type?: string;
  labels?: string[];
  assignee?: string | null;
  depends_on?: number[];
}

/** Read a stored issue with its jsonfile fields, from any tracker double. */
export function jsonIssueOf(
  tracker: MemoryConnector,
  remoteId: string,
): JsonIssue | undefined {
  return tracker.issues().get(Number(remoteId)) as unknown as JsonIssue | undefined;
}

/** Mutate a stored issue's jsonfile fields, from any tracker double. */
export function mutateJsonIssue(
  tracker: MemoryConnector,
  remoteId: string,
  patch: JsonIssuePatch,
): void {
  tracker.mutateIssue(remoteId, patch as never);
}

/** A stored issue as a wire record — the shape the pull seams read. */
function recordOf(issue: JsonIssue): TrackerRecord {
  return { ...issue } as unknown as TrackerRecord;
}

/** A stored comment in the memory tracker's `StoredComment` shape. */
function storedComment(comment: JsonComment): StoredComment {
  return { id: comment.id, body: comment.body, created_at: comment.created_at, updated_at: comment.created_at };
}

/**
 * Build a file-backed tracker double.
 *
 * `file` is the same path the provider's connector is built against, so both
 * read and write one JSON document. `seed` preloads issues (the memory
 * tracker's `SeedIssue` shape, with `workflowState` carrying the native status
 * name and `dependencies` the native `depends_on` edges) for the two-issue
 * pull scenarios.
 */
export function jsonFileTracker(options: {
  file: string;
  seed?: SeedIssue[];
  now?: () => string;
}): JsonFileTracker {
  const file = options.file;
  const now = options.now ?? (() => new Date().toISOString());

  const load = (): JsonStore => readJsonStore(file);
  const save = (store: JsonStore): void => writeJsonStore(file, store);

  // Seed: write the initial store, mapping the memory tracker's seed shape
  // onto the jsonfile issue shape (`workflowState` → native `status`,
  // `dependencies` → native `depends_on`).
  if (options.seed && options.seed.length > 0) {
    const store = load();
    let next = store.next_number;
    for (const seed of options.seed) {
      const number = seed.number ?? next;
      next = Math.max(next, number + 1);
      store.issues.push({
        number,
        title: seed.title,
        body: seed.body ?? '',
        status: seed.workflowState ?? '',
        type: '',
        labels: seed.labels ?? [],
        assignee: seed.assignees?.[0] ?? null,
        depends_on: seed.dependencies ?? [],
        comments: [],
        created_at: seed.created_at ?? now(),
        updated_at: seed.updated_at ?? now(),
      });
    }
    store.next_number = next;
    save(store);
  }

  /** The stored issue, or undefined. */
  const issueOf = (remoteId: string, store: JsonStore = load()): JsonIssue | undefined =>
    store.issues.find((entry) => entry.number === Number(remoteId));

  const tracker: JsonFileTracker = {
    kind: 'memory',

    async request<T>(_req: RemoteRequest): Promise<RemoteResponse<T>> {
      throw new Error('jsonfile tracker: transport request is unreachable (the connector uses fs)');
    },

    paginate<T>(_req: RemoteRequest): AsyncIterable<T> {
      throw new Error('jsonfile tracker: paginate is unreachable (the connector uses fs)');
    },

    async close(): Promise<void> {},

    issues() {
      const store = load();
      const map = new Map<number, JsonIssue>();
      for (const issue of store.issues) map.set(issue.number, issue);
      return map as unknown as ReadonlyMap<number, StoredIssue>;
    },

    comments(issueNumber: number) {
      const issue = issueOf(String(issueNumber));
      return (issue?.comments ?? []).map(storedComment);
    },

    dependencies(issueNumber: number) {
      const issue = issueOf(String(issueNumber));
      return issue?.depends_on ?? [];
    },

    labels() {
      return [];
    },

    records() {
      return load().issues.map(recordOf);
    },

    linearRecords() {
      return load().issues.map(recordOf);
    },

    failNext(): void {},

    mutateIssue(remoteId: string, patch: Partial<StoredIssue>) {
      const store = load();
      const issue = store.issues.find((entry) => entry.number === Number(remoteId));
      if (!issue) return;
      const p = patch as Record<string, unknown>;
      if (p['title'] !== undefined) issue.title = String(p['title']);
      if (p['body'] !== undefined) issue.body = String(p['body']);
      if (p['status'] !== undefined) issue.status = String(p['status']);
      if (p['type'] !== undefined) issue.type = String(p['type']);
      if (p['labels'] !== undefined) issue.labels = [...(p['labels'] as string[])];
      if (p['assignee'] !== undefined) {
        issue.assignee = p['assignee'] === null ? null : String(p['assignee']);
      }
      if (p['depends_on'] !== undefined) {
        issue.depends_on = (p['depends_on'] as unknown[]).map(Number);
      }
      issue.updated_at = now();
      save(store);
    },

    deleteIssue(remoteId: string) {
      const store = load();
      store.issues = store.issues.filter((entry) => entry.number !== Number(remoteId));
      save(store);
    },

    setNow(): void {},
    setSubIssues(): void {},
    advance(): void {},
    now(): number {
      return Date.now();
    },

    fetch() {
      throw new Error('jsonfile tracker: fetch is unreachable (the connector uses fs)');
    },

    file,
  };

  return tracker;
}
