/**
 * Linear's workflow states (LP-333): the team's actual states, fetched with
 * their `type`, judged against the board's `mapping.statuses` and its
 * `terminal` / `active` flags.
 *
 * Linear workflow states are team-scoped, named per team, and each carries a
 * `type` ("triage", "backlog", "unstarted", "started", "completed",
 * "canceled", "duplicate") that says what the state *means* in Linear's own
 * progression. That `type` is the live sanity check on the mapping: a board
 * status marked `terminal` should map to a `completed` or `canceled` state, an
 * `active` status to a `started` one. A disagreement is a warning — the mapping
 * still round-trips, it just says something different from the board — while a
 * mapped state name the team does not have is an error (a push writing it would
 * be refused).
 *
 * The split mirrors Jira's `types.ts`: `validateStateMapping` and
 * `stateProblems` are the pure judges, `preflightWorkflowStates` is the one
 * async composition that ties the connector fetch to the judge, ready for the
 * sync command to call before it plans a push.
 */

import type { Problem } from '../../../core/model/types.js';
import { normalizeStatusMappings } from '../../mapping.js';

/** One workflow state as Linear reports it, trimmed to what the check needs. */
export interface LinearWorkflowState {
  /** The state's UUID. */
  id: string;
  /** The state's name, e.g. "In Progress". */
  name: string;
  /** The state's type — "triage", "backlog", "unstarted", "started", "completed", "canceled", "duplicate". */
  type: string;
}

/** A board status, as `config.statuses` declares it. */
export interface BoardStatusFlags {
  id: string;
  /** True when the status finishes the issue (`terminal: true`). */
  terminal?: boolean;
  /** True when the status marks work in progress (`active: true`). */
  active?: boolean;
}

/** A Linear state type that finishes the issue. */
function isTerminalType(type: string): boolean {
  return type === 'completed' || type === 'canceled';
}

/** A Linear state type that marks work in progress. */
function isActiveType(type: string): boolean {
  return type === 'started';
}

/** A mapped state name the team does not have. */
export interface MissingWorkflowState {
  /** The board status id whose mapping names the state. */
  status: string;
  /** The Linear state name the mapping writes. */
  remote: string;
}

/** A board status whose `terminal` / `active` flag disagrees with the state's type. */
export interface WorkflowStateTypeMismatch {
  /** The board status id. */
  status: string;
  /** The Linear state name. */
  remote: string;
  /** The Linear state's type. */
  type: string;
  /** Which board flag the state's type contradicts. */
  flag: 'terminal' | 'active';
}

/** The board's `mapping.statuses` judged against the team's actual states. */
export interface StateMappingReport {
  /** The team's workflow state names, sorted — the list a bad mapping is shown. */
  available: string[];
  /** Mapped state names the team does not have. */
  missing: MissingWorkflowState[];
  /** Board statuses whose terminal/active flag disagrees with the state's type. */
  typeMismatches: WorkflowStateTypeMismatch[];
}

/**
 * Judge the board's `mapping.statuses` against the team's reported states.
 *
 * Pure: states, mapping and the board status flags in, a report out. A mapped
 * state name the team does not have is `missing`; a mapped state whose `type`
 * contradicts a board `terminal` / `active` flag is a `typeMismatch`.
 */
export function validateStateMapping(
  mapping: Record<string, unknown>,
  states: readonly LinearWorkflowState[],
  boardStatuses: readonly BoardStatusFlags[],
): StateMappingReport {
  const byName = new Map<string, LinearWorkflowState>();
  for (const state of states) {
    if (!byName.has(state.name)) byName.set(state.name, state);
  }

  const statusMappings = normalizeStatusMappings(
    (mapping['statuses'] ?? {}) as Record<string, unknown>,
  );

  const missing: MissingWorkflowState[] = [];
  for (const [status, entry] of Object.entries(statusMappings)) {
    for (const remote of entry.remote) {
      if (!byName.has(remote)) missing.push({ status, remote });
    }
  }

  const typeMismatches: WorkflowStateTypeMismatch[] = [];
  for (const status of boardStatuses) {
    const entry = statusMappings[status.id];
    if (entry === undefined) continue;
    for (const remote of entry.remote) {
      const state = byName.get(remote);
      if (state === undefined) continue;

      // The check is one-way: a status that *declares* a flag must map to a
      // state whose `type` agrees. A status with no flag (a plain `backlog`,
      // `ready`) maps to whatever state it maps to — its `type` says nothing
      // the board contradicts.
      if (status.terminal === true && !isTerminalType(state.type)) {
        typeMismatches.push({ status: status.id, remote, type: state.type, flag: 'terminal' });
      }
      if (status.active === true && !isActiveType(state.type)) {
        typeMismatches.push({ status: status.id, remote, type: state.type, flag: 'active' });
      }
    }
  }

  return {
    available: [...byName.keys()].sort(),
    missing: missing.sort((a, b) => a.status.localeCompare(b.status) || a.remote.localeCompare(b.remote)),
    typeMismatches: typeMismatches.sort(
      (a, b) => a.status.localeCompare(b.status) || a.remote.localeCompare(b.remote),
    ),
  };
}

/**
 * The report as `Problem[]` — the shape `lpm remote …` prints and
 * `hasErrorProblems` gates on. A mapped state the team does not have is an
 * **error** (the push would be refused); a `type` that contradicts a board
 * `terminal` / `active` flag is a **warning** (the mapping round-trips, it just
 * says something different from the board).
 */
export function stateProblems(
  report: StateMappingReport,
  remoteName: string,
  configPath: string,
): Problem[] {
  const problems: Problem[] = [];

  for (const entry of report.missing) {
    problems.push({
      level: 'error',
      path: configPath,
      message:
        `remotes.${remoteName}.mapping.statuses.${entry.status}: the team has no workflow state ` +
        `"${entry.remote}" — it has: ${report.available.join(', ')}`,
    });
  }

  for (const mismatch of report.typeMismatches) {
    const path = `remotes.${remoteName}.mapping.statuses.${mismatch.status}`;
    const consequence =
      mismatch.flag === 'terminal'
        ? 'a push would not close the issue in Linear'
        : 'a push would not mark the issue started in Linear';
    problems.push({
      level: 'warn',
      path: configPath,
      message:
        `${path}: board status "${mismatch.status}" is ${mismatch.flag}, but the ` +
        `Linear state "${mismatch.remote}" has type "${mismatch.type}" — ${consequence}`,
    });
  }

  return problems;
}

/** The connector surface the state logic reads — a live Linear connector or a fake. */
export interface LinearWorkflowStatesConnector {
  readonly name: string;
  /** Fetch the team's workflow states, each with its `type`. */
  workflowStates?(): Promise<LinearWorkflowState[]>;
}

/**
 * The live preflight for workflow states: fetch the team's states through the
 * connector and judge the board's `mapping.statuses` against them, returning
 * the `Problem[]` a sync gates on (`hasErrorProblems`).
 *
 * A connector without `workflowStates()` — a fake, or a provider build before
 * the method — is a no-op: without the live state list there is nothing to
 * judge against.
 */
export async function preflightWorkflowStates(
  connector: LinearWorkflowStatesConnector,
  mapping: Record<string, unknown>,
  boardStatuses: readonly BoardStatusFlags[],
  remoteName: string,
  configPath: string,
): Promise<Problem[]> {
  if (typeof connector.workflowStates !== 'function') return [];
  const states = await connector.workflowStates();
  return stateProblems(validateStateMapping(mapping, states, boardStatuses), remoteName, configPath);
}
