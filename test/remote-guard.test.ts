/**
 * LP-350 — the write-confirmation gate: the first write asks once, and an
 * oversized plan (more creates+closes than the threshold) stops and requires
 * `--yes`. The pure decision (`consentGate`, `countPushWrites`) is tested
 * directly; the integration half drives `runSync` through the same harness the
 * sync-session suite uses, so the gate is exercised exactly where the CLI,
 * the web panel and the MCP tool all land.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { removeNode, updateNode } from '../src/core/index.js';
import {
  countPushWrites,
  DEFAULT_WRITE_THRESHOLD,
  loadLinkStore,
  runSync,
  consentGate,
  writeThresholdOf,
} from '../src/remote/index.js';
import type { OpenedRemote, PushPlan } from '../src/remote/index.js';
import { cleanupBoards } from './helpers.js';
import { githubProvider } from '../src/remote/providers/github/index.js';
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
  pull: providerPull(githubProvider, GITHUB_MAPPING),
};

/** A minimal `OpenedRemote` for the pure gate tests — only `write_threshold` is read. */
function remoteWith(threshold?: number): OpenedRemote {
  return {
    name: 'github',
    provider: githubProvider,
    direction: 'both',
    on_delete: 'unlink',
    conflict: 'manual',
    fields: {},
    encoding: 'block',
    comments: 'push',
    connection: {},
    mapping: {},
    ...(threshold !== undefined ? { write_threshold: threshold } : {}),
  };
}

/** A one-op create plan, for the pure tests. */
function planOf(...kinds: PushPlan['ops']): PushPlan {
  return { ops: kinds, skipped: [] };
}

const create = (localId: string): PushPlan['ops'][number] => ({
  kind: 'create',
  placeholder: `new:${localId}`,
  localId,
  fields: { type: 'user_story', status: 'backlog' },
});

const close = (localId: string): PushPlan['ops'][number] => ({
  kind: 'close',
  localId,
  ref: { kind: 'linked', localId, remoteId: '1' },
});

const deleteOp = (localId: string): PushPlan['ops'][number] => ({
  kind: 'delete',
  localId,
  ref: { kind: 'linked', localId, remoteId: '1' },
});

// ---------------------------------------------------------------------------
// The pure decision
// ---------------------------------------------------------------------------

describe('countPushWrites', () => {
  it('counts creates (and restores) as creates, closes as closes, and every write', () => {
    const plan = planOf(
      create('LP-1'),
      create('LP-2'),
      {
        kind: 'restore',
        placeholder: 'new:3',
        localId: 'LP-3',
        oldRemoteId: 'old',
        fields: { type: 'user_story', status: 'backlog' },
      },
      close('LP-4'),
      { kind: 'unlinkLocal', localId: 'LP-5' },
      { kind: 'decouple', localId: 'LP-6', reason: 'manual' },
    );

    expect(countPushWrites(plan)).toEqual({ creates: 3, closes: 1, deletes: 0, writes: 4 });
  });

  it('counts deletes separately, and feeds them into the write count', () => {
    const plan = planOf(create('LP-1'), close('LP-2'), deleteOp('LP-3'));
    expect(countPushWrites(plan)).toEqual({ creates: 1, closes: 1, deletes: 1, writes: 3 });
  });

  it('counts an empty plan as zero', () => {
    expect(countPushWrites({ ops: [], skipped: [] })).toEqual({
      creates: 0,
      closes: 0,
      deletes: 0,
      writes: 0,
    });
  });
});

describe('consentGate', () => {
  it('never asks for a plan with no remote writes', () => {
    const gate = consentGate({
      remote: remoteWith(),
      consented: false,
      plan: planOf({ kind: 'unlinkLocal', localId: 'LP-1' }),
    });
    expect(gate.requiresConsent).toBe(false);
    expect(gate.counts.writes).toBe(0);
  });

  it('asks on the first write until consent is recorded', () => {
    const plan = planOf(create('LP-1'));
    const first = consentGate({ remote: remoteWith(), consented: false, plan });
    expect(first).toMatchObject({ requiresConsent: true, reason: 'first_write' });

    const again = consentGate({ remote: remoteWith(), consented: true, plan });
    expect(again.requiresConsent).toBe(false);
  });

  it('stops an oversized plan (creates+closes over the threshold) even after consent', () => {
    const plan = planOf(create('LP-1'), create('LP-2'), close('LP-3'));
    const gate = consentGate({ remote: remoteWith(2), consented: true, plan });
    expect(gate).toMatchObject({ requiresConsent: true, reason: 'threshold' });
    expect(gate.counts.creates + gate.counts.closes).toBe(3);
    expect(gate.threshold).toBe(2);
  });

  it('treats the threshold as a strict "more than", not "at least"', () => {
    const plan = planOf(create('LP-1'), close('LP-2'));
    const gate = consentGate({ remote: remoteWith(2), consented: true, plan });
    expect(gate.requiresConsent).toBe(false);
  });

  it('applies the default threshold when the remote declares none', () => {
    expect(writeThresholdOf(remoteWith())).toBe(DEFAULT_WRITE_THRESHOLD);
    expect(DEFAULT_WRITE_THRESHOLD).toBe(25);
  });

  it('prefers the threshold reason over a first write when both apply', () => {
    const plan = planOf(create('LP-1'), create('LP-2'), close('LP-3'));
    const gate = consentGate({ remote: remoteWith(2), consented: false, plan });
    expect(gate.reason).toBe('threshold');
  });

  it('asks for a delete every run, even after consent is recorded (LP-351)', () => {
    const plan = planOf(deleteOp('LP-1'));
    const gate = consentGate({ remote: remoteWith(), consented: true, plan });
    expect(gate).toMatchObject({ requiresConsent: true, reason: 'delete' });
    expect(gate.counts.deletes).toBe(1);
  });

  it('counts deletes toward the threshold, so a bulk deletion is the threshold reason', () => {
    const plan = planOf(deleteOp('LP-1'), deleteOp('LP-2'), deleteOp('LP-3'));
    const gate = consentGate({ remote: remoteWith(2), consented: true, plan });
    expect(gate).toMatchObject({ requiresConsent: true, reason: 'threshold' });
    expect(gate.counts.deletes).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// The gate in runSync
// ---------------------------------------------------------------------------

describe('runSync — the consent gate', () => {
  it('refuses the first write when nothing confirms it, and writes nothing', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_test');
    const h = await buildHarness(githubEntry);
    plantTree(h.paths);

    const result = await runSync(h.reload(), h.opened, h.paths, { direction: 'push' });

    expect(result.pushResult).toBeUndefined();
    expect(result.consentRefused?.reason).toBe('first_write');
    expect(result.consentRefused?.target).toBe('acme/payments');
    expect(result.consentRefused?.counts.creates).toBe(4);
    expect(h.tracker.issues().size).toBe(0);
    expect(loadLinkStore(h.paths, 'github').links.size).toBe(0);
    expect(loadLinkStore(h.paths, 'github').consentedAt).toBeUndefined();
  });

  it('proceeds and records consent when the confirm callback says yes', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_test');
    const h = await buildHarness(githubEntry);
    plantTree(h.paths);
    const asked: string[] = [];
    const confirm = vi.fn(async (request: { target: string }) => {
      asked.push(request.target);
      return true;
    });

    const result = await runSync(h.reload(), h.opened, h.paths, {
      direction: 'push',
      confirm,
    });

    expect(result.consentRefused).toBeUndefined();
    expect(result.pushResult?.summary.created).toBe(4);
    expect(asked).toEqual(['acme/payments']);
    expect(loadLinkStore(h.paths, 'github').consentedAt).toBeDefined();
  });

  it('stops when the confirm callback says no', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_test');
    const h = await buildHarness(githubEntry);
    plantTree(h.paths);

    const result = await runSync(h.reload(), h.opened, h.paths, {
      direction: 'push',
      confirm: async () => false,
    });

    expect(result.consentRefused?.reason).toBe('first_write');
    expect(result.pushResult).toBeUndefined();
    expect(h.tracker.issues().size).toBe(0);
  });

  it('proceeds and records consent with yes, and never asks again', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_test');
    const h = await buildHarness(githubEntry);
    const { story } = plantTree(h.paths);

    await runSync(h.reload(), h.opened, h.paths, { direction: 'push', yes: true });
    expect(loadLinkStore(h.paths, 'github').consentedAt).toBeDefined();

    // A second push — no `yes`, no confirm — proceeds because consent is recorded.
    const stale = h.reload();
    updateNode(stale, stale.byId.get(story.id)!, { title: 'Story (renamed)' });
    const second = await runSync(h.reload(), h.opened, h.paths, { direction: 'push' });
    expect(second.consentRefused).toBeUndefined();
    expect(second.pushResult?.summary.updated).toBe(1);
  });

  it('stops an oversized plan with the threshold reason, never asking to confirm', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_test');
    const h = await buildHarness(githubEntry);
    plantTree(h.paths);
    h.opened.write_threshold = 2; // 4 creates exceed it

    const confirm = vi.fn(async () => true);
    const result = await runSync(h.reload(), h.opened, h.paths, {
      direction: 'push',
      confirm,
    });

    expect(confirm).not.toHaveBeenCalled(); // an oversized plan never prompts
    expect(result.consentRefused?.reason).toBe('threshold');
    expect(result.consentRefused?.counts.creates).toBe(4);
    expect(result.consentRefused?.threshold).toBe(2);
    expect(result.pushResult).toBeUndefined();
    expect(h.tracker.issues().size).toBe(0);
  });

  it('proceeds past the threshold with yes', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_test');
    const h = await buildHarness(githubEntry);
    plantTree(h.paths);
    h.opened.write_threshold = 2;

    const result = await runSync(h.reload(), h.opened, h.paths, {
      direction: 'push',
      yes: true,
    });

    expect(result.consentRefused).toBeUndefined();
    expect(result.pushResult?.summary.created).toBe(4);
  });

  it('never gates a dry run', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_test');
    const h = await buildHarness(githubEntry);
    plantTree(h.paths);

    const result = await runSync(h.reload(), h.opened, h.paths, {
      direction: 'push',
      dryRun: true,
    });

    expect(result.consentRefused).toBeUndefined();
    expect(result.renders).toHaveLength(1);
  });

  it('asks again for a delete even after consent is recorded, and never remembers it (LP-351)', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_test');
    const h = await buildHarness(githubEntry);
    const { story } = plantTree(h.paths);

    // First push files the four twins and records the one-time consent.
    await runSync(h.reload(), h.opened, h.paths, { direction: 'push', yes: true });
    expect(loadLinkStore(h.paths, 'github').consentedAt).toBeDefined();
    expect(h.tracker.issues().size).toBe(4);

    // Delete the story locally and switch the policy to `delete`.
    const board = h.reload();
    removeNode(board, board.byId.get(story.id)!);
    h.opened.on_delete = 'delete';

    // A delete never rides the remembered consent: it refuses with the delete reason.
    const refused = await runSync(h.reload(), h.opened, h.paths, { direction: 'push' });
    expect(refused.consentRefused?.reason).toBe('delete');
    expect(refused.consentRefused?.counts.deletes).toBe(1);
    expect(refused.pushResult).toBeUndefined();

    // `--yes` proceeds for this one run and does not re-record consent — the
    // next delete will ask again.
    const proceeded = await runSync(h.reload(), h.opened, h.paths, {
      direction: 'push',
      yes: true,
    });
    expect(proceeded.consentRefused).toBeUndefined();
    expect(proceeded.pushResult?.landed.some((op) => op.kind === 'delete')).toBe(true);
  });
});
