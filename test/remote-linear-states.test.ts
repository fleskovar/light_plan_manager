/**
 * LP-333 — map Linear workflow states, validated against the board's
 * `terminal` / `active` flags.
 *
 * Two halves, both offline: the pure judge (`states.ts`) — the mapping judged
 * against the team's reported states, a mapped state the team lacks reported
 * with the list it does have, a state `type` that contradicts a board flag
 * reported as a warning — and the async preflight that ties a connector's
 * `workflowStates()` to that judge.
 */

import { describe, expect, it } from 'vitest';
import {
  preflightWorkflowStates,
  stateProblems,
  validateStateMapping,
  type BoardStatusFlags,
  type LinearWorkflowState,
} from '../src/remote/providers/linear/states.js';

/** The scrum board's status flags, exactly as `.lpm/config.yml` declares them. */
const BOARD_STATUSES: BoardStatusFlags[] = [
  { id: 'backlog' },
  { id: 'ready' },
  { id: 'in_progress', active: true },
  { id: 'in_review', active: true },
  { id: 'done', terminal: true },
];

/** A Linear team's workflow states, as `team.states` reports them. */
const STATES: LinearWorkflowState[] = [
  { id: 's-backlog', name: 'Backlog', type: 'backlog' },
  { id: 's-ready', name: 'Ready', type: 'unstarted' },
  { id: 's-progress', name: 'In Progress', type: 'started' },
  { id: 's-review', name: 'In Review', type: 'started' },
  { id: 's-done', name: 'Done', type: 'completed' },
];

/** A mapping whose statuses match the team's states and the board's flags. */
const MAPPING = {
  statuses: {
    backlog: { remote: ['Backlog'] },
    ready: { remote: ['Ready'] },
    in_progress: { remote: ['In Progress'] },
    in_review: { remote: ['In Review'] },
    done: { remote: ['Done'], closed: true },
  },
};

describe('validateStateMapping', () => {
  it('reports nothing when the mapping matches the states and the flags', () => {
    const report = validateStateMapping(MAPPING, STATES, BOARD_STATUSES);
    expect(report.available).toEqual(['Backlog', 'Done', 'In Progress', 'In Review', 'Ready']);
    expect(report.missing).toEqual([]);
    expect(report.typeMismatches).toEqual([]);
  });

  it('reports a mapped state name the team does not have, with the list it does have', () => {
    const report = validateStateMapping(
      { statuses: { backlog: { remote: ['Backlog'] }, done: { remote: ['Completed'], closed: true } } },
      STATES,
      [{ id: 'backlog' }, { id: 'done', terminal: true }],
    );
    expect(report.missing).toEqual([{ status: 'done', remote: 'Completed' }]);
    expect(report.available).toContain('Done');
  });

  it('warns when a terminal status maps to a state whose type is not completed/canceled', () => {
    const report = validateStateMapping(
      { statuses: { done: { remote: ['In Progress'], closed: true } } },
      STATES,
      [{ id: 'done', terminal: true }],
    );
    expect(report.typeMismatches).toEqual([
      { status: 'done', remote: 'In Progress', type: 'started', flag: 'terminal' },
    ]);
  });

  it('warns when an active status maps to a state whose type is not started', () => {
    const report = validateStateMapping(
      { statuses: { in_progress: { remote: ['Backlog'] } } },
      STATES,
      [{ id: 'in_progress', active: true }],
    );
    expect(report.typeMismatches).toEqual([
      { status: 'in_progress', remote: 'Backlog', type: 'backlog', flag: 'active' },
    ]);
  });

  it('does not judge a status with no flag against the state type', () => {
    // `backlog` declares neither `terminal` nor `active`, so mapping it to any
    // state is not a contradiction — there is no flag to disagree with.
    const report = validateStateMapping(
      { statuses: { backlog: { remote: ['Done'] } } },
      STATES,
      [{ id: 'backlog' }],
    );
    expect(report.typeMismatches).toEqual([]);
  });

  it('accepts a canceled state as terminal', () => {
    const states = [{ id: 'c', name: 'Canceled', type: 'canceled' }];
    const report = validateStateMapping(
      { statuses: { done: { remote: ['Canceled'], closed: true } } },
      states,
      [{ id: 'done', terminal: true }],
    );
    expect(report.typeMismatches).toEqual([]);
  });
});

describe('stateProblems', () => {
  it('turns a missing state into an error naming the list the team has', () => {
    const report = validateStateMapping(
      { statuses: { done: { remote: ['Completed'], closed: true } } },
      STATES,
      [{ id: 'done', terminal: true }],
    );
    const problems = stateProblems(report, 'linear', 'config.yml');

    const errors = problems.filter((p) => p.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('remotes.linear.mapping.statuses.done');
    expect(errors[0]!.message).toContain('no workflow state "Completed"');
    expect(errors[0]!.message).toContain('it has: Backlog, Done, In Progress, In Review, Ready');
  });

  it('turns a terminal/type disagreement into a warning naming both sides', () => {
    const report = validateStateMapping(
      { statuses: { done: { remote: ['In Progress'], closed: true } } },
      STATES,
      [{ id: 'done', terminal: true }],
    );
    const problems = stateProblems(report, 'linear', 'config.yml');

    const warnings = problems.filter((p) => p.level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain('board status "done" is terminal');
    expect(warnings[0]!.message).toContain('has type "started"');
    expect(warnings[0]!.message).toContain('would not close the issue in Linear');
  });

  it('reports nothing when the mapping fits', () => {
    const report = validateStateMapping(MAPPING, STATES, BOARD_STATUSES);
    expect(stateProblems(report, 'linear', 'config.yml')).toEqual([]);
  });
});

describe('preflightWorkflowStates', () => {
  it('fetches the states and reports the mismatches against the board flags', async () => {
    const problems = await preflightWorkflowStates(
      {
        name: 'linear',
        workflowStates: async () => [
          { id: 's-backlog', name: 'Backlog', type: 'backlog' },
          { id: 's-done', name: 'Done', type: 'started' },
        ],
      },
      MAPPING,
      BOARD_STATUSES,
      'linear',
      'config.yml',
    );

    expect(problems).toEqual([
      {
        level: 'error',
        path: 'config.yml',
        message:
          'remotes.linear.mapping.statuses.in_progress: the team has no workflow state "In Progress" — it has: Backlog, Done',
      },
      {
        level: 'error',
        path: 'config.yml',
        message:
          'remotes.linear.mapping.statuses.in_review: the team has no workflow state "In Review" — it has: Backlog, Done',
      },
      {
        level: 'error',
        path: 'config.yml',
        message:
          'remotes.linear.mapping.statuses.ready: the team has no workflow state "Ready" — it has: Backlog, Done',
      },
      {
        level: 'warn',
        path: 'config.yml',
        message:
          'remotes.linear.mapping.statuses.done: board status "done" is terminal, but the Linear state "Done" has type "started" — a push would not close the issue in Linear',
      },
    ]);
  });

  it('is a no-op when the connector exposes no workflow states', async () => {
    expect(await preflightWorkflowStates({ name: 'linear' }, MAPPING, BOARD_STATUSES, 'linear', 'config.yml')).toEqual([]);
  });

  it('reports nothing when the mapping fits the states', async () => {
    const problems = await preflightWorkflowStates(
      { name: 'linear', workflowStates: async () => STATES },
      MAPPING,
      BOARD_STATUSES,
      'linear',
      'config.yml',
    );
    expect(problems).toEqual([]);
  });
});
