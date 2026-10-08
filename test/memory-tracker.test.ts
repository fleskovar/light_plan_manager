/**
 * LP-299 — the in-memory tracker, driven exactly the way a real connector is:
 * through the transport `Connector` contract (`request` / `paginate` / `close`).
 * Every acceptance criterion is exercised here, offline.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  memoryConnector,
  normalizeMarkdown,
  orderLabels,
  type TrackerRecord,
} from './support/memory-tracker.js';
import { githubConnector } from '../src/remote/providers/github/connector.js';
import { RemoteError } from '../src/remote/transport/index.js';

/** Collect every page a `paginate` walk yields (or the error it throws). */
async function pages<T>(walk: AsyncIterable<T>): Promise<{ pages: T[]; error: unknown }> {
  const collected: T[] = [];
  let error: unknown = null;
  try {
    for await (const page of walk) collected.push(page);
  } catch (e) {
    error = e;
  }
  return { pages: collected, error };
}

const repo = 'acme/payments';

describe('the in-memory tracker implements the connector contract', () => {
  it('exposes kind "memory", request, paginate and close', () => {
    const tracker = memoryConnector();
    expect(tracker.kind).toBe('memory');
    expect(typeof tracker.request).toBe('function');
    expect(typeof tracker.paginate).toBe('function');
    expect(typeof tracker.close).toBe('function');
  });

  it('stores issues and answers the same request shapes a real connector does', async () => {
    const tracker = memoryConnector({ repo });

    const created = await tracker.request<TrackerRecord>({
      method: 'POST',
      path: `/repos/${repo}/issues`,
      body: { title: 'Ship it', body: 'do the thing', labels: ['feature'] },
    });
    expect(created.status).toBe(201);
    expect(created.ok).toBe(true);
    expect(created.body).toMatchObject({ number: 1, title: 'Ship it' });

    const fetched = await tracker.request<TrackerRecord>({
      method: 'GET',
      path: `/repos/${repo}/issues/1`,
    });
    expect(fetched.status).toBe(200);
    expect(fetched.body).toMatchObject({ number: 1, title: 'Ship it' });

    const listed = await tracker.request<TrackerRecord[]>({
      method: 'GET',
      path: `/repos/${repo}/issues`,
    });
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body![0]).toMatchObject({ number: 1 });
  });

  it('stores fields, labels, assignees, comments and edges', async () => {
    const tracker = memoryConnector({ repo });

    await tracker.request({
      method: 'POST',
      path: `/repos/${repo}/issues`,
      body: {
        title: 'Epic',
        fields: { story_points: 8, theme: 'sync' },
        labels: ['alpha', 'zulu'],
        assignees: ['alice'],
      },
    });
    await tracker.request({
      method: 'POST',
      path: `/repos/${repo}/issues`,
      body: { title: 'Story', assignees: ['bob'] },
    });

    // Edges: #2 depends on #1.
    await tracker.request({
      method: 'POST',
      path: `/repos/${repo}/issues/2/dependencies`,
      body: { dependencies: [1] },
    });

    // Comments on #2.
    await tracker.request({
      method: 'POST',
      path: `/repos/${repo}/issues/2/comments`,
      body: { body: 'first note' },
    });

    const record = await tracker.request<TrackerRecord>({
      method: 'GET',
      path: `/repos/${repo}/issues/1`,
    });
    expect(record.body!.fields).toEqual({ story_points: 8, theme: 'sync' });
    expect(record.body!.labels).toEqual([{ name: 'alpha' }, { name: 'zulu' }]);
    expect(record.body!.assignee).toEqual({ login: 'alice' });

    expect(tracker.dependencies(2)).toEqual([1]);
    expect(tracker.comments(2)).toHaveLength(1);
    expect(tracker.comments(2)[0]).toMatchObject({ id: 1, body: 'first note' });

    // Edge removal.
    await tracker.request({ method: 'DELETE', path: `/repos/${repo}/issues/2/dependencies/1` });
    expect(tracker.dependencies(2)).toEqual([]);
  });

  it('updates and deletes, and a 404 is a typed not_found error', async () => {
    const tracker = memoryConnector({ repo });
    await tracker.request({ method: 'POST', path: `/repos/${repo}/issues`, body: { title: 'x' } });

    const updated = await tracker.request<TrackerRecord>({
      method: 'PATCH',
      path: `/repos/${repo}/issues/1`,
      body: { title: 'x renamed', state: 'closed' },
    });
    expect(updated.body).toMatchObject({ title: 'x renamed', state: 'closed' });

    await expect(
      tracker.request({ method: 'GET', path: `/repos/${repo}/issues/99` }),
    ).rejects.toMatchObject({ name: 'RemoteError', status: 404, code: 'not_found' });
  });
});

describe('the awkward defaults: normalisation and label reordering', () => {
  it('normalises markdown on write and reorders labels on write', async () => {
    const tracker = memoryConnector({ repo });

    const created = await tracker.request<TrackerRecord>({
      method: 'POST',
      path: `/repos/${repo}/issues`,
      body: { title: 'x', body: 'line one\r\nline two', labels: ['zulu', 'alpha', 'zulu'] },
    });

    // CRLF → LF and a single trailing newline; labels sorted and deduped.
    expect(created.body!.body).toBe('line one\nline two\n');
    expect(created.body!.labels).toEqual([{ name: 'alpha' }, { name: 'zulu' }]);
  });

  it('ships the two defaults as standalone, overridable helpers', () => {
    expect(normalizeMarkdown('a\r\nb')).toBe('a\nb\n');
    expect(normalizeMarkdown('a\n\n\n')).toBe('a\n');
    expect(orderLabels(['b', 'a', 'b'])).toEqual(['a', 'b']);
  });

  it('lets a test replace the awkwardness with an echo', async () => {
    const tracker = memoryConnector({
      repo,
      normalizeMarkdown: (body) => body,
      orderLabels: (labels) => labels,
    });
    const created = await tracker.request<TrackerRecord>({
      method: 'POST',
      path: `/repos/${repo}/issues`,
      body: { title: 'x', body: 'as sent', labels: ['zulu', 'alpha'] },
    });
    expect(created.body!.body).toBe('as sent');
    expect(created.body!.labels).toEqual([{ name: 'zulu' }, { name: 'alpha' }]);
  });
});

describe('induced failures', () => {
  it('induces a 429 rate limit, classified retryable with a Retry-After', async () => {
    const tracker = memoryConnector({ repo });
    tracker.failNext({ status: 429, retryAfterSeconds: 30, message: 'quota spent' });

    const error = await tracker
      .request({ method: 'GET', path: `/repos/${repo}/issues`, purpose: 'fetch issues' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RemoteError);
    const typed = error as RemoteError;
    expect(typed.code).toBe('rate_limit');
    expect(typed.retryable).toBe(true);
    expect(typed.retryAfterMs).toBe(30000);
    expect(typed.message).toContain('rate limited');
  });

  it('induces a 500, classified retryable', async () => {
    const tracker = memoryConnector({ repo });
    tracker.failNext({ status: 500 });

    const error = await tracker
      .request({ method: 'GET', path: `/repos/${repo}/issues` })
      .catch((e: unknown) => e);

    expect((error as RemoteError).code).toBe('server');
    expect((error as RemoteError).retryable).toBe(true);
  });

  it('tells a permission 403 from a rate-limit 403', async () => {
    const permission = memoryConnector({ repo });
    permission.failNext({ status: 403, message: 'not allowed' });
    const permissionError = await permission
      .request({ method: 'GET', path: `/repos/${repo}/issues` })
      .catch((e: unknown) => e);

    const rateLimited = memoryConnector({ repo });
    rateLimited.failNext({ status: 403, retryAfterSeconds: 1 });
    const rateError = await rateLimited
      .request({ method: 'GET', path: `/repos/${repo}/issues` })
      .catch((e: unknown) => e);

    expect((permissionError as RemoteError).code).toBe('permission');
    expect((permissionError as RemoteError).retryable).toBe(false);
    expect((rateError as RemoteError).code).toBe('rate_limit');
    expect((rateError as RemoteError).retryable).toBe(true);
    expect((permissionError as RemoteError).message).not.toBe((rateError as RemoteError).message);
  });

  it('induces a partial page: page one served, the next page fails with a 500', async () => {
    const tracker = memoryConnector({ repo, perPage: 2 });
    for (let i = 0; i < 5; i += 1) {
      await tracker.request({ method: 'POST', path: `/repos/${repo}/issues`, body: { title: `i${i}` } });
    }
    tracker.failNext({ kind: 'partial_page' });

    const { pages: walked, error } = await pages(
      tracker.paginate<TrackerRecord>({
        method: 'GET',
        path: `/repos/${repo}/issues`,
        pagination: { kind: 'cursor', cursorParam: 'after', nextCursorPath: ['next'] },
      }),
    );

    // The first page arrived; the second request broke mid-walk.
    expect((walked[0] as { items: TrackerRecord[] }).items).toHaveLength(2);
    expect(error).toBeInstanceOf(RemoteError);
    expect((error as RemoteError).status).toBe(500);
    expect(walked).toHaveLength(1);
  });
});

describe('the "changed since" query and the controllable clock', () => {
  it('filters by the tracker\'s own clock, which tests move', async () => {
    const tracker = memoryConnector({ repo });
    tracker.setNow(Date.parse('2026-08-10T00:00:00Z'));

    await tracker.request({ method: 'POST', path: `/repos/${repo}/issues`, body: { title: 'before' } });
    tracker.advance(60_000); // one minute later
    await tracker.request({ method: 'POST', path: `/repos/${repo}/issues`, body: { title: 'after' } });

    const since = '2026-08-10T00:01:00.000Z';
    const changed = await tracker.request<TrackerRecord[]>({
      method: 'GET',
      path: `/repos/${repo}/issues`,
      query: { since },
    });

    expect(changed.body!.map((r) => r.title)).toEqual(['after']);
    // The write also stamped `updated_at` from the fake's clock.
    expect(tracker.issues().get(1)!.updated_at).toBe('2026-08-10T00:00:00.000Z');
    expect(tracker.issues().get(2)!.updated_at).toBe('2026-08-10T00:01:00.000Z');
  });
});

describe('capability probes', () => {
  it('answers probes from a configurable capability record', async () => {
    const degraded = memoryConnector({ repo });
    const types = await degraded.request<unknown[]>({ method: 'GET', path: '/orgs/acme/issue-types' });
    const fields = await degraded.request<unknown[]>({ method: 'GET', path: '/orgs/acme/issue-fields' });
    expect(types.body).toEqual([]);
    expect(fields.body).toEqual([]);

    const full = memoryConnector({
      repo,
      capabilities: { nativeTypes: true, customFields: { valueTypes: ['text', 'number'] } },
    });
    const typesFull = await full.request<unknown[]>({ method: 'GET', path: '/orgs/acme/issue-types' });
    const fieldsFull = await full.request<unknown[]>({ method: 'GET', path: '/orgs/acme/issue-fields' });
    expect(typesFull.body!.length).toBeGreaterThan(0);
    expect(fieldsFull.body).toEqual([
      { id: 'text', name: 'text', value_type: 'text' },
      { id: 'number', name: 'number', value_type: 'number' },
    ]);
  });
});

describe('the fetch adapter', () => {
  it('serves a raw-fetch connector and returns a Response for a 404 rather than throwing', async () => {
    const tracker = memoryConnector({ repo });

    const created = await tracker.fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'via fetch' }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as TrackerRecord;
    expect(body.number).toBe(1);

    const missing = await tracker.fetch(`https://api.github.com/repos/${repo}/issues/42`);
    expect(missing.status).toBe(404);
  });
});

describe('the tracker answers the request shapes a real connector sends', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('backs the real github connector, end to end over its raw fetch', async () => {
    const tracker = memoryConnector({ repo });
    vi.stubGlobal('fetch', tracker.fetch);
    const connector = githubConnector({ repo, base_url: 'https://api.github.com' });

    const created = await connector.create({
      kind: 'create',
      title: 'Epic',
      body: 'body text',
      labels: ['feature'],
    });
    expect(created.remoteId).toBe('1');
    expect(created.record).toMatchObject({ number: 1, title: 'Epic' });
    // The awkward default shows through a real provider: markdown normalised.
    expect(created.record?.body).toBe('body text\n');

    const fetched = await connector.get('1');
    expect(fetched).toMatchObject({ number: 1, title: 'Epic' });

    const listed = await connector.list();
    expect(listed.records).toHaveLength(1);
    expect(listed.cursor).toBe(created.record?.updated_at);

    const updated = await connector.update('1', {
      kind: 'update',
      title: 'Epic renamed',
      state: 'closed',
    });
    expect(updated.record).toMatchObject({ title: 'Epic renamed', state: 'closed' });

    const commented = await connector.comment?.('1', 'a note');
    expect(commented?.commentId).toBe('1');
    expect(tracker.comments(1)).toHaveLength(1);
  });
});
