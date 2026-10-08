import { planInsert, wouldCycle } from '$shared';
import type { Workspace } from '../workspace.svelte.js';
import { editNode } from './edits.js';
import { enact, idFactory, viewOf } from './shared.js';

/**
 * Graph-link mutations: dependencies (what blocks what) and edge operations
 * (splicing a node between two others, or creating one there).
 */

// -- dependencies ----------------------------------------------------------

/** Documents that carry `dependsOn`: an issue, and the template it comes from. */
function gated(workspace: Workspace, id: string) {
  const node = workspace.node(id);
  return node?.kind === 'issue' || node?.kind === 'template' ? node : null;
}

export function addDependency(workspace: Workspace, blockedId: string, blockerId: string): boolean {
  const blocked = gated(workspace, blockedId);
  const blocker = workspace.node(blockerId);
  // A template depends on a template and an issue on an issue; an edge between
  // the two would be an issue waiting on a piece of paper.
  if (!blocked || blockedId === blockerId || blocker?.kind !== blocked.kind) return false;
  if (blocked.dependsOn.includes(blockerId)) return true;
  if (wouldCycle(viewOf(workspace), blockedId, blockerId)) {
    workspace.notify('error', 'That dependency would create a cycle');
    return false;
  }
  editNode(workspace, blockedId, { dependsOn: [...blocked.dependsOn, blockerId] });
  return true;
}

export function removeDependency(workspace: Workspace, blockedId: string, blockerId: string): void {
  const blocked = gated(workspace, blockedId);
  if (!blocked) return;
  editNode(workspace, blockedId, {
    dependsOn: blocked.dependsOn.filter((id) => id !== blockerId),
  });
}

// -- edge operations -------------------------------------------------------

/** Put an existing issue between two others, replacing the edge that joined them. */
export function spliceOntoEdge(
  workspace: Workspace,
  id: string,
  sourceId: string,
  targetId: string,
): boolean {
  const plan = planInsert(viewOf(workspace), idFactory(workspace), {
    source: sourceId,
    target: targetId,
    issueId: id,
  });
  if (!plan.ok) {
    workspace.notify('error', plan.error, plan.details);
    return false;
  }
  enact(workspace, plan);
  return true;
}

/** Create a new issue on an edge, inheriting the upstream node's level. */
export function insertOnEdge(
  workspace: Workspace,
  sourceId: string,
  targetId: string,
  type?: string,
): string | null {
  const created = enact(
    workspace,
    planInsert(viewOf(workspace), idFactory(workspace), {
      source: sourceId,
      target: targetId,
      ...(type ? { type } : {}),
    }),
  );
  return created[0] ?? null;
}
