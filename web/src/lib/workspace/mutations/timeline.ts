import type { Plan } from '$shared';
import { planCarryOver, planCompletePeriod } from '$shared';
import type { Workspace } from '../workspace.svelte.js';
import { enact, viewOf } from './shared.js';
import { editNode } from './edits.js';

/**
 * Timeline mutations: period activation and the two corrections offered when a
 * timebox overruns.
 */

/**
 * Hold the switch over a period's dates, or take it off again.
 *
 * `null` is not "off": it removes the switch and hands the period back to its
 * calendar, which is the state every period starts in.
 */
export function setPeriodActive(
  workspace: Workspace,
  id: string,
  active: boolean | null,
): void {
  if (workspace.node(id)?.kind !== 'period') return;
  editNode(workspace, id, { active });
}

/**
 * Declare a period's unfinished work finished. One of the two answers to a
 * sprint that ran out of calendar; `planCompletePeriod` owns which issues move.
 */
export function completePeriod(workspace: Workspace, id: string): string[] {
  return enact(workspace, planCompletePeriod(viewOf(workspace), id));
}

/** Move a period's unfinished work into the next one, leaving the rest behind. */
export function carryOverPeriod(workspace: Workspace, id: string): string[] {
  return enact(workspace, planCarryOver(viewOf(workspace), id));
}
