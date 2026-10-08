import { planBreakdown, planDuplicate } from '$shared';
import type { Workspace } from '../workspace.svelte.js';
import { enact, idFactory, viewOf } from './shared.js';

/**
 * Bulk mutations: duplicating a selection, and breaking an issue into pieces.
 */

/** Copy a selection, keeping the dependencies that ran between the copied nodes. */
export function duplicate(workspace: Workspace, selection: string[]): string[] {
  const onCanvas = selection.some((id) => workspace.isMember(id));
  return enact(workspace, planDuplicate(viewOf(workspace), idFactory(workspace), selection), {
    member: onCanvas,
  });
}

// -- breaking down ---------------------------------------------------------

export interface BreakdownRequest {
  count: number;
  mode: 'children' | 'replace';
  titles?: string[];
  chain?: boolean;
  splitAttribute?: string;
}

/** Split an issue into `count` pieces; `planBreakdown` owns the rewiring. */
export function breakDown(workspace: Workspace, id: string, options: BreakdownRequest): string[] {
  const created = enact(
    workspace,
    planBreakdown(viewOf(workspace), idFactory(workspace), id, options),
  );
  if (created.length) {
    if (options.mode === 'replace') workspace.removeMembers([id]);
    workspace.selection.set(created);
  }
  return created;
}
