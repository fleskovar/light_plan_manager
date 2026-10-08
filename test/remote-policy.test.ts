import { describe, expect, it } from 'vitest';
import { NO_BASE, mergeValues, type MergeOutcome } from '../src/remote/merge.js';
import { effectivePolicy, resolveByPolicy } from '../src/remote/policy.js';

/**
 * LP-286 — conflict resolution by policy, per remote and per field.
 *
 * Pure: every case drives `resolveByPolicy` / `effectivePolicy` with literals,
 * or feeds `mergeValues`'s outcome straight in. No board, no disk, no network.
 */

describe('resolveByPolicy — non-conflict outcomes pass through', () => {
  it('an agreement stays none under every policy', () => {
    expect(resolveByPolicy('none', 'manual')).toEqual({ outcome: 'none' });
    expect(resolveByPolicy('none', 'local')).toEqual({ outcome: 'none' });
    expect(resolveByPolicy('none', 'remote')).toEqual({ outcome: 'none' });
  });

  it('a one-sided push stays a push whatever the policy', () => {
    expect(resolveByPolicy('push', 'manual')).toEqual({ outcome: 'push' });
    expect(resolveByPolicy('push', 'remote')).toEqual({ outcome: 'push' });
  });

  it('a one-sided pull stays a pull whatever the policy', () => {
    expect(resolveByPolicy('pull', 'manual')).toEqual({ outcome: 'pull' });
    expect(resolveByPolicy('pull', 'local')).toEqual({ outcome: 'pull' });
  });

  it('a one-sided change never overwrites — the other side did not edit', () => {
    expect(resolveByPolicy('push', 'local').overwrote).toBeUndefined();
    expect(resolveByPolicy('pull', 'remote').overwrote).toBeUndefined();
  });
});

describe('resolveByPolicy — the conflict the policy decides', () => {
  it('manual leaves a conflict a conflict: neither side moves', () => {
    expect(resolveByPolicy('conflict', 'manual')).toEqual({ outcome: 'conflict' });
  });

  it('local resolves a conflict to push and reports the remote edit overwritten', () => {
    expect(resolveByPolicy('conflict', 'local')).toEqual({
      outcome: 'push',
      overwrote: 'remote',
    });
  });

  it('remote resolves a conflict to pull and reports the local edit overwritten', () => {
    expect(resolveByPolicy('conflict', 'remote')).toEqual({
      outcome: 'pull',
      overwrote: 'local',
    });
  });
});

describe('resolveByPolicy against mergeValues', () => {
  it('both-sides edit + local policy → push, remote edit overwritten', () => {
    const merge = mergeValues('local title', 'remote title', 'base title');
    expect(merge).toBe('conflict');
    expect(resolveByPolicy(merge, 'local')).toEqual({
      outcome: 'push',
      overwrote: 'remote',
    });
  });

  it('a remote-owned field never conflicts: both sides edited, remote wins', () => {
    const merge = mergeValues('local status', 'remote status', 'base status');
    expect(merge).toBe('conflict');
    expect(resolveByPolicy(merge, 'remote')).toEqual({
      outcome: 'pull',
      overwrote: 'local',
    });
  });

  it('manual preserves both edits and reports the conflict', () => {
    const merge = mergeValues('a', 'b', 'c');
    expect(resolveByPolicy(merge, 'manual')).toEqual({ outcome: 'conflict' });
  });

  it('a field with no base snapshot is still resolved by policy, not stranded', () => {
    const merge = mergeValues('a', 'b', NO_BASE);
    expect(merge).toBe('conflict');
    expect(resolveByPolicy(merge, 'remote')).toEqual({ outcome: 'pull', overwrote: 'local' });
  });
});

describe('effectivePolicy', () => {
  it('falls back to the remote default when the field has no override', () => {
    expect(effectivePolicy('status', 'manual', {})).toBe('manual');
    expect(effectivePolicy('status', 'local', { title: 'remote' })).toBe('local');
  });

  it('a per-field owner wins over the default', () => {
    expect(effectivePolicy('status', 'manual', { status: 'remote' })).toBe('remote');
    expect(effectivePolicy('status', 'local', { status: 'remote' })).toBe('remote');
    expect(effectivePolicy('status', 'remote', { status: 'local' })).toBe('local');
  });

  it('an override on another field does not leak', () => {
    expect(effectivePolicy('title', 'manual', { status: 'remote' })).toBe('manual');
  });

  it('works with no overrides at all', () => {
    expect(effectivePolicy('status', 'remote')).toBe('remote');
  });
});

describe('the acceptance criteria as one composition', () => {
  it('a status field owned by the remote pulls while a free title pushes, no conflict', () => {
    const overrides = { status: 'remote' as const };
    const defaultPolicy = 'manual' as const;

    const titleMerge = mergeValues('new title', 'old title', 'old title');
    const statusMerge = mergeValues('in_progress', 'done', 'in_progress');

    const title = resolveByPolicy(titleMerge, effectivePolicy('title', defaultPolicy, overrides));
    const status = resolveByPolicy(statusMerge, effectivePolicy('status', defaultPolicy, overrides));

    expect(title).toEqual({ outcome: 'push' });
    expect(status).toEqual({ outcome: 'pull' });
    expect([title.outcome, status.outcome]).not.toContain('conflict');
  });

  it('the full outcome vocabulary is exactly the four merge words', () => {
    const outcomes: MergeOutcome[] = ['none', 'push', 'pull', 'conflict'];
    expect(outcomes).toHaveLength(4);
    for (const outcome of outcomes) {
      expect(resolveByPolicy(outcome, 'manual').outcome).toBe(outcome);
    }
  });
});
