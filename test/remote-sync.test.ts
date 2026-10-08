/**
 * LP-341 — the sync session: push, pull and sync as one `runSync` call.
 *
 * Drives the real provider (GitHub) against the in-memory tracker, exactly as
 * the conformance suite does, but through the *orchestration* the CLI's
 * `push` / `pull` / `sync` subcommands are thin printers over: capabilities
 * resolution, the reachability/lifecycle gate, the preflight gate, planning,
 * and — unless it is a dry run — application with the cursor advanced.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIssue, loadBoard, updateNode } from '../src/core/index.js';
import { githubBlockEdgesOf, githubParentIdOf, githubProvider } from '../src/remote/providers/github/index.js';
import { loadLinkStore, runSync } from '../src/remote/index.js';
import { cleanupBoards } from './helpers.js';
import { memoryConnector } from './support/memory-tracker.js';
import {
  buildHarness,
  plantTree,
  providerPull,
  type ConformanceEntry,
} from './support/provider-conformance.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  cleanupBoards();
});

const GITHUB_MAPPING: Record<string, unknown> = {
  types: {
    program: { remote: 'program' },
    epic: { remote: 'epic' },
    feature: { remote: 'feature' },
    user_story: { remote: 'story' },
  },
  statuses: {
    backlog: { remote: ['Backlog'], closed: false },
    ready: { remote: ['Ready'], closed: false },
    in_progress: { remote: ['In Progress'], closed: false },
    in_review: { remote: ['In Review'], closed: false },
    done: { remote: ['Done'], closed: true },
  },
};

const githubEntry: ConformanceEntry = {
  name: 'github',
  provider: githubProvider,
  connection: { repo: 'acme/payments', base_url: 'https://api.github.com' },
  mapping: GITHUB_MAPPING,
  pull: providerPull(githubProvider, GITHUB_MAPPING, {
    parentIdOf: githubParentIdOf,
    blockEdgesOf: githubBlockEdgesOf,
  }),
};

describe('runSync', () => {
  it('push files every in-scope issue and records a twin', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_test');
    const h = await buildHarness(githubEntry);
    plantTree(h.paths);

    const result = await runSync(h.reload(), h.opened, h.paths, { direction: 'push', yes: true });

    expect(result.pushResult?.failed).toEqual([]);
    expect(result.pushResult?.summary.created).toBe(4);
    expect(h.tracker.issues().size).toBe(4);
    expect(loadLinkStore(h.paths, 'github').links.size).toBe(4);
  });

  it('push --dry-run renders the plan and writes nothing', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_test');
    const h = await buildHarness(githubEntry);
    plantTree(h.paths);

    const result = await runSync(h.reload(), h.opened, h.paths, {
      direction: 'push',
      dryRun: true,
    });

    expect(result.pushResult).toBeUndefined();
    expect(result.renders).toHaveLength(1);
    const render = result.renders![0]!;
    expect(render.total).toBeGreaterThan(0);
    expect(render.text).toContain('Sync plan');
    expect(h.tracker.issues().size).toBe(0);
    expect(loadLinkStore(h.paths, 'github').links.size).toBe(0);
  });

  it('incremental push applies only the change', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_test');
    const h = await buildHarness(githubEntry);
    const { story } = plantTree(h.paths);
    await runSync(h.reload(), h.opened, h.paths, { direction: 'push', yes: true });

    const stale = h.reload();
    updateNode(stale, stale.byId.get(story.id)!, { title: 'Story (renamed)' });

    const result = await runSync(h.reload(), h.opened, h.paths, { direction: 'push' });
    expect(result.pushResult?.failed).toEqual([]);
    expect(result.pushResult?.summary.created).toBe(0);
    expect(result.pushResult?.summary.updated).toBe(1);
  });

  it('pull files a remote-only issue', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_test');
    const producer = await buildHarness(githubEntry);
    createIssue(producer.reload(), { type: 'program', title: 'Remote-only' });
    await runSync(producer.reload(), producer.opened, producer.paths, { direction: 'push', yes: true });

    const consumer = await buildHarness(githubEntry, { tracker: producer.tracker });
    const result = await runSync(consumer.reload(), consumer.opened, consumer.paths, {
      direction: 'pull',
    });

    expect(result.pullResult?.failures).toEqual([]);
    expect(result.pullResult?.linked).toHaveLength(1);
    expect(consumer.reload().issues.find((issue) => issue.title === 'Remote-only')).toBeTruthy();
  });

  it('sync pulls first, then pushes — a remote edit merges before a local edit', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_test');
    // Board A files an issue with a title and a body.
    const a = await buildHarness(githubEntry);
    const issue = createIssue(a.reload(), { type: 'program', title: 'Shared' });
    const seeded = a.reload();
    updateNode(seeded, seeded.byId.get(issue.id)!, { body: 'original body' });
    await runSync(a.reload(), a.opened, a.paths, { direction: 'push', yes: true });

    // Board B syncs it (pull files the document, the push records its base).
    const b = await buildHarness(githubEntry, { tracker: a.tracker });
    await runSync(b.reload(), b.opened, b.paths, { direction: 'both', yes: true });
    const remoteId = loadLinkStore(b.paths, 'github').links.get(issue.id)!.remoteId;

    // The remote edits the title (remote-only); board B edits the body (local-only).
    a.tracker.mutateIssue(remoteId, { title: 'Shared (remote)' });
    const edited = b.reload();
    updateNode(edited, edited.byId.get(issue.id)!, { body: 'local body edit' });

    const result = await runSync(b.reload(), b.opened, b.paths, { direction: 'both', yes: true });
    expect(result.pullResult?.failures).toEqual([]);
    expect(result.pushResult?.failed).toEqual([]);

    // The remote's title edit landed locally, and the local body edit landed
    // remotely — each side won the field it alone changed.
    const doc = b.reload().issues.find((candidate) => candidate.title === 'Shared (remote)')!;
    expect(doc.body).toContain('local body edit');
    const remoteRecord = a.tracker.issues().get(Number(remoteId))!;
    expect(remoteRecord.title).toBe('Shared (remote)');
    expect(remoteRecord.body).toContain('local body edit');
  });

  it('--filter syncs only the named subtree', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_test');
    const h = await buildHarness(githubEntry);
    const { epic } = plantTree(h.paths);

    const result = await runSync(h.reload(), h.opened, h.paths, {
      direction: 'push',
      scope: epic.id,
      yes: true,
    });

    // The epic and its two descendants file; the programme above it does not.
    expect(result.pushResult?.failed).toEqual([]);
    expect(result.pushResult?.summary.created).toBe(3);
    expect(h.tracker.issues().size).toBe(3);
    const titles = [...h.tracker.issues().values()].map((issue) => issue.title).sort();
    expect(titles).toEqual(['Epic', 'Feature', 'Story']);
  });

  it('a partial failure reports what landed and what failed', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_test');
    const tracker = memoryConnector({
      repo: 'acme/payments',
      failures: [
        {
          match: (request) =>
            request.method === 'POST' &&
            request.path === '/repos/acme/payments/issues' &&
            (request.body as { title?: string } | undefined)?.title === 'Epic',
          failure: { status: 500, message: 'boom' },
        },
      ],
    });
    const h = await buildHarness(githubEntry, { tracker });
    plantTree(h.paths);

    const result = await runSync(h.reload(), h.opened, h.paths, { direction: 'push', yes: true });

    expect(result.pushResult?.summary.created).toBe(1);
    expect(result.pushResult?.failed).toHaveLength(1);
    const failure = result.pushResult!.failed[0]!;
    expect(failure.localId).toBeTruthy();
    expect(failure.error).toContain('(500)');
    // The children of the failed create were never attempted.
    expect(result.pushResult?.skipped.length).toBeGreaterThan(0);
    // Only the landed create has a twin.
    expect(loadLinkStore(h.paths, 'github').links.size).toBe(1);
  });

  it('throws when the remote cannot be reached, so a caller can continue past it', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_test');
    const h = await buildHarness(githubEntry);
    plantTree(h.paths);
    // The very next request — the capability probe — fails, which `runSync`
    // does not catch: it propagates to the caller.
    h.tracker.failNext({ status: 500, message: 'connection reset' });

    await expect(
      runSync(h.reload(), h.opened, h.paths, { direction: 'push' }),
    ).rejects.toThrow();
  });
});
