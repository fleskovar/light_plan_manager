import type { NodeKind, NodePatch } from '$shared';
import { subtreeIds } from '$shared';
import { workUnitsUnder } from '$lib/board/selectors.js';
import type { Workspace } from '../workspace.svelte.js';
import { viewOf } from './shared.js';

/**
 * Single-node edits: create, update, delete, and the field-level shortcuts
 * (status, assignee, period) the UI triggers from menus and drags.
 */

export interface NewNodeOptions {
  nodeKind?: NodeKind;
  type: string;
  title?: string;
  parentId?: string | null;
  patch?: NodePatch;
  /** Put it on the canvas as well as on the board. Issues only. */
  member?: boolean;
}

export function createNode(workspace: Workspace, options: NewNodeOptions): string {
  // A registry template carries an *issue* type name, so the type cannot say
  // which collection this belongs in — the open view can, and does.
  const nodeKind =
    options.nodeKind ??
    (workspace.mode === 'templates'
      ? 'template'
      : (workspace.config.types[options.type]?.kind ?? 'issue'));
  const id = workspace.nextTempId();

  workspace.record({
    kind: 'create',
    id,
    nodeKind,
    patch: {
      type: options.type,
      title: options.title ?? `New ${workspace.config.types[options.type]?.label ?? options.type}`,
      parentId: options.parentId ?? null,
      ...options.patch,
    },
  });

  const drawable = nodeKind === 'issue' || nodeKind === 'template';
  if (drawable && options.member !== false) workspace.addMembers([id]);
  return id;
}

export function editNode(workspace: Workspace, id: string, patch: NodePatch): void {
  const node = workspace.node(id);
  if (!node) return;
  workspace.record({ kind: 'update', id, nodeKind: node.kind, patch });
}

export function removeNodes(workspace: Workspace, ids: string[]): void {
  // Deleting a parent takes its children with it, so queueing both would leave
  // a change addressed to something that no longer exists.
  const view = viewOf(workspace);
  const doomed = new Set(ids.flatMap((id) => subtreeIds(view, id)));
  for (const id of ids) {
    if (ids.some((other) => other !== id && subtreeIds(view, other).includes(id))) continue;
    const node = workspace.node(id);
    if (node) workspace.record({ kind: 'delete', id, nodeKind: node.kind });
  }
  workspace.removeMembers([...doomed]);
  workspace.selection.retain((id) => !doomed.has(id));
}

export function setStatus(workspace: Workspace, ids: string[], status: string): void {
  for (const id of ids) {
    if (workspace.node(id)?.kind === 'issue') editNode(workspace, id, { status });
  }
}

export function assign(workspace: Workspace, ids: string[], assignee: string | null): void {
  for (const id of ids) {
    if (workspace.node(id)?.kind === 'issue') editNode(workspace, id, { assignee });
  }
}

/**
 * Assign a selection and say what happened.
 *
 * The bulk operations report because they are the ones nobody watches happen: a
 * menu closes over the top of thirty nodes and the only evidence the click
 * landed is the count.
 */
export function assignSelection(
  workspace: Workspace,
  ids: string[],
  assignee: string | null,
): string[] {
  const moved = ids.filter((id) => {
    const node = workspace.node(id);
    return node?.kind === 'issue' && node.assignee !== assignee;
  });
  assign(workspace, moved, assignee);

  const who = assignee ? (workspace.node(assignee)?.title ?? assignee) : 'nobody';
  workspace.notify(
    'info',
    moved.length
      ? `Assigned ${countOf(moved.length, 'issue')} to ${who}`
      : assignee ? `Already assigned to ${who}` : 'Already unassigned',
  );
  return moved;
}

/** "1 issue" / "4 issues". Bulk operations are counted out loud everywhere. */
export function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

// -- Scheduling -------------------------------------------------------------

export function schedule(workspace: Workspace, ids: string[], period: string | null): void {
  for (const id of ids) {
    const node = workspace.node(id);
    if (node?.kind === 'issue' && node.period !== period) editNode(workspace, id, { period });
  }
}

export function scheduleLeaves(
  workspace: Workspace,
  ids: string[],
  period: string | null,
): string[] {
  const wanted = new Set<string>();
  for (const id of ids) {
    for (const unit of workUnitsUnder(workspace.nodes, workspace.config, id, workspace.index)) wanted.add(unit.id);
  }

  const moved = [...wanted].filter((id) => {
    const node = workspace.node(id);
    return node?.kind === 'issue' && node.period !== period;
  });
  schedule(workspace, moved, period);
  return moved;
}

export function scheduleSelection(
  workspace: Workspace,
  ids: string[],
  period: string | null,
): string[] {
  const moved = scheduleLeaves(workspace, ids, period);
  const where = period ? (workspace.node(period)?.title ?? period) : 'the backlog';
  workspace.notify(
    'info',
    moved.length
      ? `Scheduled ${countOf(moved.length, 'issue')} into ${where}`
      : `Already in ${where}`,
  );
  return moved;
}
