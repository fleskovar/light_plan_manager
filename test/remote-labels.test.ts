import { describe, expect, it } from 'vitest';
import {
  isClaimedLabel,
  labelClaim,
  labelColor,
  missingLabels,
  reconcileLabels,
} from '../src/remote/labels.js';

const CLAIM = labelClaim(['story', 'Backlog'], ['Points:', 'Priority:', 'pool:']);

describe('labelClaim', () => {
  it('dedupes exact labels and sorts prefixes', () => {
    const claim = labelClaim(['a', 'a', 'b'], ['z:', 'a:']);
    expect([...claim.exact].sort()).toEqual(['a', 'b']);
    expect(claim.prefixes).toEqual(['a:', 'z:']);
  });
});

describe('isClaimedLabel', () => {
  it('matches an exact label', () => {
    expect(isClaimedLabel(CLAIM, 'story')).toBe(true);
    expect(isClaimedLabel(CLAIM, 'Backlog')).toBe(true);
  });

  it('matches a label under a claimed prefix', () => {
    expect(isClaimedLabel(CLAIM, 'Points:3')).toBe(true);
    expect(isClaimedLabel(CLAIM, 'Priority:high')).toBe(true);
    expect(isClaimedLabel(CLAIM, 'pool:RS-3')).toBe(true);
  });

  it('leaves an unclaimed label alone, whatever it looks like', () => {
    expect(isClaimedLabel(CLAIM, 'needs-triage')).toBe(false);
    expect(isClaimedLabel(CLAIM, 'team:frontend')).toBe(false);
    expect(isClaimedLabel(CLAIM, 'bug')).toBe(false);
  });
});

describe('reconcileLabels', () => {
  it('adds a claimed label the issue lacks', () => {
    expect(
      reconcileLabels(['story', 'triage'], ['story', 'In Progress'], CLAIM),
    ).toEqual(['triage', 'story', 'In Progress']);
  });

  it('removes a claimed label the board no longer wants', () => {
    // `Backlog` is claimed; it is not in desired, so it must go.
    expect(reconcileLabels(['story', 'Backlog'], ['story', 'In Progress'], CLAIM)).toEqual([
      'story',
      'In Progress',
    ]);
  });

  it('preserves every label the mapping does not claim', () => {
    const current = ['story', 'Backlog', 'needs-triage', 'team:frontend'];
    const desired = ['story', 'In Progress', 'Points:3'];
    expect(reconcileLabels(current, desired, CLAIM)).toEqual([
      'needs-triage',
      'team:frontend',
      'story',
      'In Progress',
      'Points:3',
    ]);
  });

  it('dedupes a desired label that is also an unclaimed current label', () => {
    // `team:frontend` is unclaimed, so it is kept; it is also in desired (a
    // board that maps labels onto real names) — it must appear once.
    expect(reconcileLabels(['team:frontend'], ['team:frontend', 'story'], CLAIM)).toEqual([
      'team:frontend',
      'story',
    ]);
  });
});

describe('missingLabels', () => {
  it('returns the desired labels the repository lacks, sorted', () => {
    expect(
      missingLabels(['story', 'Backlog', 'Points:3'], ['story']),
    ).toEqual(['Backlog', 'Points:3']);
  });

  it('returns nothing when every desired label exists', () => {
    expect(missingLabels(['story'], ['story', 'other'])).toEqual([]);
  });
});

describe('labelColor', () => {
  it('is a six-digit hex string with no leading #', () => {
    expect(labelColor('story')).toMatch(/^[0-9a-f]{6}$/);
  });

  it('is deterministic — the same label always gets the same colour', () => {
    expect(labelColor('story')).toBe(labelColor('story'));
  });
});
