import type { UpstreamEntry } from '../blocking.js';
import { upstreamWork } from '../blocking.js';
import type { Change } from '../changes.js';
import type { IssueDto } from '../model.js';
import type { Plan } from './breakdown.js';
import { fail, update } from './breakdown.js';
import type { BoardView } from './reading.js';
import { blockingLookupOf } from './reading.js';

/**
 * Pushing the work behind an issue into somebody's queue.
 *
 * `upstreamWork` (in `../blocking.ts`) answers what has to happen before an
 * issue can be finished. This is the one thing all three front ends *do* with
 * that answer: put the unclaimed part of it in the same sprint, with the same
 * person or pool, as the issue that is waiting on it — so a chain nobody had
 * scheduled becomes a queue somebody is actually offered.
 *
 * Two rules decide what is touched, and both are narrower than they could be on
 * purpose:
 *
 *   - **Only unassigned work.** An upstream issue somebody already holds is
 *     left entirely alone, its period included. It is their work; a command
 *     that quietly moved it between sprints — or off the person doing it —
 *     would be a worse surprise than a short list.
 *   - **Only work units.** A period written on an epic schedules nothing
 *     anybody can pick up, because the queue offers units. This is the same
 *     rule `scheduleLeaves` follows on the canvas: the work under a container
 *     moves, never the container standing over it. The containers still come
 *     back in `skipped`, so a reader can see the shape of what was found.
 */

/** What `planScheduleUpstream` decided about one upstream issue. */
export interface UpstreamDecision extends UpstreamEntry {
  /** Why it was left alone, or null when it was scheduled. */
  skipped: 'assigned' | 'container' | 'unchanged' | null;
}

export interface ScheduleUpstreamOptions {
  /**
   * Where the work goes. Defaults to the target's own period; pass `null` to
   * assign without scheduling.
   */
  period?: string | null;
  /**
   * Who gets it. Defaults to the target's own assignee; pass `null` to schedule
   * without assigning.
   */
  assignee?: string | null;
}

export interface ScheduleUpstreamPlan {
  plan: Plan;
  /** Every upstream issue and what was decided about it, nearest cause first. */
  decisions: UpstreamDecision[];
  /** The period the work was put in, as resolved. */
  period: string | null;
  /** The resource it was given to, as resolved. */
  assignee: string | null;
}

/**
 * Work out the upstream schedule, reporting what was skipped as well as what
 * was planned.
 *
 * Callers that only want the changes use `planScheduleUpstream`; the CLI and
 * the MCP tool use this one, because "nothing happened" is an answer that needs
 * to say why — three issues already had owners is a different board from no
 * upstream work at all.
 */
export function scheduleUpstream(
  view: BoardView,
  id: string,
  options: ScheduleUpstreamOptions = {},
): ScheduleUpstreamPlan {
  const empty = { decisions: [], period: null, assignee: null };
  const target = view.nodes[id];
  if (!target) return { ...empty, plan: fail(`No issue with id "${id}"`) };
  if (target.kind !== 'issue') {
    return {
      ...empty,
      plan: fail(`${id} is a ${target.kind}; only issues have upstream work`),
    };
  }

  const period = options.period === undefined ? target.period : options.period;
  const assignee = options.assignee === undefined ? target.assignee : options.assignee;
  if (period === null && assignee === null) {
    return {
      ...empty,
      plan: fail(`${id} is not scheduled and not assigned, so there is nothing to copy onto its upstream work`, [
        'Schedule or assign it first, or pass a period and an assignee explicitly.',
      ]),
    };
  }

  const lookup = blockingLookupOf(view);
  const decisions: UpstreamDecision[] = [];
  const changes: Change[] = [];

  for (const entry of upstreamWork(id, lookup)) {
    const issue = view.nodes[entry.id];
    if (!issue || issue.kind !== 'issue') continue;

    const skipped = skipReason(issue, lookup.isWorkUnit(entry.id), period, assignee);
    decisions.push({ ...entry, skipped });
    if (skipped) continue;

    // Both fields travel in one patch: the two halves of "this is now yours,
    // this sprint" must not be able to land separately.
    const patch: { period?: string | null; assignee?: string | null } = {};
    if (issue.period !== period) patch.period = period;
    if (issue.assignee !== assignee) patch.assignee = assignee;
    changes.push(update(view, entry.id, patch));
  }

  return { plan: { ok: true, changes, created: [] }, decisions, period, assignee };
}

function skipReason(
  issue: IssueDto,
  isUnit: boolean,
  period: string | null,
  assignee: string | null,
): UpstreamDecision['skipped'] {
  if (issue.assignee !== null) return 'assigned';
  if (!isUnit) return 'container';
  if (issue.period === period && issue.assignee === assignee) return 'unchanged';
  return null;
}

/**
 * The changes alone, for a caller that just wants to queue them.
 *
 * @see scheduleUpstream for the decisions behind them.
 */
export function planScheduleUpstream(
  view: BoardView,
  id: string,
  options: ScheduleUpstreamOptions = {},
): Plan {
  return scheduleUpstream(view, id, options).plan;
}
