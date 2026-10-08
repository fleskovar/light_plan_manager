import type { BoardView, NodeKind, Plan } from '$shared';
import type { Workspace } from '../workspace.svelte.js';

/**
 * Internal helpers shared by the mutation modules.
 *
 * Not re-exported from `mutations.ts` — callers only see the mutation
 * vocabulary, not how it is queued.
 */

/** The board as the planners want it: the config, and the documents by id. */
export function viewOf(workspace: Workspace): BoardView {
  return { config: workspace.config, nodes: workspace.nodes };
}

/** A fresh temporary id, numbered across the whole session of queued edits. */
export function idFactory(workspace: Workspace): () => string {
  return () => workspace.nextTempId();
}

/**
 * Queue a plan, or surface why it cannot run. Returns the ids it created so a
 * caller can select them.
 */
export function enact(workspace: Workspace, plan: Plan, options: { member?: boolean } = {}): string[] {
  if (!plan.ok) {
    workspace.notify('error', plan.error, plan.details);
    return [];
  }
  for (const change of plan.changes) workspace.record(change);
  if (options.member !== false) {
    workspace.addMembers(plan.created.filter((id) => workspace.node(id)?.kind === 'issue'));
  }
  return plan.created;
}
