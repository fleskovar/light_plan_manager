/**
 * LP-352 — the sync audit log.
 *
 * Every applied sync appends one JSONL line to `.lpm/remotes/<name>/log.jsonl`
 * recording when, who, which remote, the operation counts and the per-op
 * outcomes; a run that throws still appends a failure line.  Secrets are
 * redacted before the line is written, and the file is append-only so
 * concurrent runs and git merges leave it readable.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoadedBoard } from '../src/core/index.js';
import { githubBlockEdgesOf, githubParentIdOf, githubProvider } from '../src/remote/providers/github/index.js';
import {
  readSyncAudit,
  recordSyncFailure,
  runSync,
  syncAuditPath,
} from '../src/remote/index.js';
import { cleanupBoards, makeBoard } from './helpers.js';
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

/** The audit-log lines a run left, parsed back through the reader. */
function entriesOf(paths: Parameters<typeof syncAuditPath>[0], name = 'github') {
  return readSyncAudit(paths, name);
}

describe('sync audit log', () => {
  it('records one entry per applied sync: who, remote, direction, counts and per-op outcomes', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_test');
    vi.stubEnv('LPM_USER', 'alice');
    const h = await buildHarness(githubEntry);
    plantTree(h.paths);

    const result = await runSync(h.reload(), h.opened, h.paths, { direction: 'push', yes: true });

    expect(result.pushResult?.summary.created).toBe(4);

    const entries = entriesOf(h.paths);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.remote).toBe('github');
    expect(entry.direction).toBe('push');
    expect(entry.author).toBe('alice');
    expect(entry.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry.counts.created).toBe(4);
    expect(entry.counts.failed).toBe(0);
    // Every created op is recorded as landed, with the twin's remote id.
    const creates = entry.operations.filter((op) => op.kind === 'create');
    expect(creates).toHaveLength(4);
    expect(creates.every((op) => op.status === 'landed' && typeof op.remoteId === 'string')).toBe(true);

    // The file itself is line-delimited: one JSON object per line.
    const raw = readFileSync(syncAuditPath(h.paths, 'github'), 'utf8').trim().split('\n');
    expect(raw).toHaveLength(1);
    expect(JSON.parse(raw[0]!)).toEqual(entry);
  });

  it('does not record a dry run — the log records what a sync did', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_test');
    const h = await buildHarness(githubEntry);
    plantTree(h.paths);

    await runSync(h.reload(), h.opened, h.paths, { direction: 'push', dryRun: true });

    expect(entriesOf(h.paths)).toHaveLength(0);
  });

  it('records the reason a run threw, before the error propagates', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_test');
    const h = await buildHarness(githubEntry);
    plantTree(h.paths);
    // The next request — the capability probe — fails, so `runSync` rejects.
    h.tracker.failNext({ status: 500, message: 'connection reset' });

    await expect(
      runSync(h.reload(), h.opened, h.paths, { direction: 'push' }),
    ).rejects.toThrow();

    const entries = entriesOf(h.paths);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.error).toBeDefined();
    expect(entries[0]!.error).not.toBe('');
  });

  it('records a per-op failure with its reason', async () => {
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

    await runSync(h.reload(), h.opened, h.paths, { direction: 'push', yes: true });

    const entries = entriesOf(h.paths);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.counts.failed).toBe(1);
    const failedOp = entries[0]!.operations.find((op) => op.status === 'failed');
    expect(failedOp).toBeDefined();
    expect(failedOp!.kind).toBe('create');
    expect(failedOp!.error).toContain('(500)');
  });

  it('redacts a secret from a recorded reason', () => {
    const paths = makeBoard();
    recordSyncFailure(
      { paths } as LoadedBoard,
      'github',
      'push',
      new Error('POST https://api.github.com/repos/acme/payments/issues?access_token=ghp_secret123 failed'),
      ['ghp_secret123'],
    );

    const raw = readFileSync(syncAuditPath(paths, 'github'), 'utf8');
    expect(raw).not.toContain('ghp_secret123');
    expect(raw).toContain('access_token=***');
  });

  it('is append-only and line-delimited: a second run adds a line, never rewrites', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_test');
    const h = await buildHarness(githubEntry);
    plantTree(h.paths);

    await runSync(h.reload(), h.opened, h.paths, { direction: 'push', yes: true });
    const afterFirst = readFileSync(syncAuditPath(h.paths, 'github'), 'utf8');

    await runSync(h.reload(), h.opened, h.paths, { direction: 'push' });
    const afterSecond = readFileSync(syncAuditPath(h.paths, 'github'), 'utf8');

    expect(afterSecond.startsWith(afterFirst)).toBe(true);
    expect(entriesOf(h.paths)).toHaveLength(2);
  });

  it('skips a malformed line and still reads the rest', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_test');
    const h = await buildHarness(githubEntry);
    plantTree(h.paths);
    await runSync(h.reload(), h.opened, h.paths, { direction: 'push', yes: true });

    const file = syncAuditPath(h.paths, 'github');
    const good = readFileSync(file, 'utf8');
    // A git-merge artefact: a good line, a broken line, another good line.
    writeFileSync(file, `${good}{not json}\n${good}`);
    expect(entriesOf(h.paths)).toHaveLength(2);
  });
});
