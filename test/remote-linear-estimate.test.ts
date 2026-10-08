/**
 * LP-333 — map Linear estimates, respecting the team's scale.
 *
 * Two halves, both offline: the pure judge (`estimate.ts`) — the team's
 * `issueEstimationType` plus its two switches turned into the allowed values,
 * and the board's effort values judged against them — and the async preflight
 * that ties a connector's `estimateScale()` to that judge.
 */

import { describe, expect, it } from 'vitest';
import {
  allowedEstimateValues,
  estimateScaleProblems,
  preflightEstimateScale,
  type LinearEstimateScale,
} from '../src/remote/providers/linear/estimate.js';

const scale = (type: string, allowZero = false, extended = false): LinearEstimateScale => ({
  type,
  allowZero,
  extended,
});

describe('allowedEstimateValues', () => {
  it('returns the five base values of each scale', () => {
    expect(allowedEstimateValues(scale('fibonacci'))).toEqual([1, 2, 3, 5, 8]);
    expect(allowedEstimateValues(scale('exponential'))).toEqual([1, 2, 4, 8, 16]);
    expect(allowedEstimateValues(scale('linear'))).toEqual([1, 2, 3, 4, 5]);
  });

  it('maps T-shirt sizes to their numeric Fibonacci values', () => {
    expect(allowedEstimateValues(scale('tShirt'))).toEqual([1, 2, 3, 5, 8]);
  });

  it('adds the two extended values when issueEstimationExtended is set', () => {
    expect(allowedEstimateValues(scale('fibonacci', false, true))).toEqual([1, 2, 3, 5, 8, 13, 21]);
    expect(allowedEstimateValues(scale('exponential', false, true))).toEqual([1, 2, 4, 8, 16, 32, 64]);
    expect(allowedEstimateValues(scale('linear', false, true))).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('admits zero only when issueEstimationAllowZero is set', () => {
    expect(allowedEstimateValues(scale('fibonacci', true))).toEqual([0, 1, 2, 3, 5, 8]);
    expect(allowedEstimateValues(scale('fibonacci', false))).toEqual([1, 2, 3, 5, 8]);
  });

  it('returns null when estimates are disabled, and for an unknown type', () => {
    expect(allowedEstimateValues(scale('notUsed'))).toBeNull();
    expect(allowedEstimateValues(scale('somethingElse'))).toBeNull();
  });
});

describe('estimateScaleProblems', () => {
  it('reports a value off the scale with the allowed values', () => {
    const problems = estimateScaleProblems(scale('fibonacci'), 'story_points', [13], 'linear', 'config.yml');
    expect(problems).toEqual([
      {
        level: 'error',
        path: 'config.yml',
        message:
          'remotes.linear.mapping.effort.attribute: "story_points" value 13 is outside the team\'s fibonacci scale — allowed values: 1, 2, 3, 5, 8',
      },
    ]);
  });

  it('accepts a value the extended scale admits', () => {
    const problems = estimateScaleProblems(
      scale('fibonacci', false, true),
      'story_points',
      [13],
      'linear',
      'config.yml',
    );
    expect(problems).toEqual([]);
  });

  it('reports zero as off-scale unless zero is allowed', () => {
    expect(estimateScaleProblems(scale('fibonacci'), 'story_points', [0], 'linear', 'config.yml')).toHaveLength(1);
    expect(estimateScaleProblems(scale('fibonacci', true), 'story_points', [0], 'linear', 'config.yml')).toEqual([]);
  });

  it('reports every value when estimates are disabled', () => {
    const problems = estimateScaleProblems(scale('notUsed'), 'story_points', [5], 'linear', 'config.yml');
    expect(problems).toEqual([
      {
        level: 'error',
        path: 'config.yml',
        message:
          'remotes.linear.mapping.effort.attribute: "story_points" value 5 cannot be mirrored — the team\'s estimate scale is disabled',
      },
    ]);
  });

  it('reports a repeated offending value once', () => {
    const problems = estimateScaleProblems(scale('fibonacci'), 'story_points', [13, 5, 13], 'linear', 'config.yml');
    expect(problems).toHaveLength(1);
  });
});

describe('preflightEstimateScale', () => {
  it('fetches the scale and reports an off-scale value with the allowed values', async () => {
    const problems = await preflightEstimateScale(
      { name: 'linear', estimateScale: async () => scale('linear', false, true) },
      'story_points',
      [8],
      'linear',
      'config.yml',
    );
    expect(problems).toEqual([
      {
        level: 'error',
        path: 'config.yml',
        message:
          'remotes.linear.mapping.effort.attribute: "story_points" value 8 is outside the team\'s linear scale — allowed values: 1, 2, 3, 4, 5, 6, 7',
      },
    ]);
  });

  it('is a no-op when the connector exposes no estimate scale', async () => {
    expect(await preflightEstimateScale({ name: 'linear' }, 'story_points', [8], 'linear', 'config.yml')).toEqual([]);
  });

  it('reports nothing when every value fits the scale', async () => {
    const problems = await preflightEstimateScale(
      { name: 'linear', estimateScale: async () => scale('fibonacci') },
      'story_points',
      [1, 2, 3, 5, 8],
      'linear',
      'config.yml',
    );
    expect(problems).toEqual([]);
  });
});
