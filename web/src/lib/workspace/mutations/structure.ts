import type { BoardView, Plan, ReparentChoices, ReparentPreview } from '$shared';
import {
  planBridgeReparent,
  planConvert,
  planReparent,
  previewReparent as planPreviewReparent,
  reparentChoices as planReparentChoices,
} from '$shared';
import type { Workspace } from '../workspace.svelte.js';
import { enact, idFactory, viewOf } from './shared.js';

/**
 * Structure mutations: type conversion, reparenting, and building the missing
 * levels between a node and a new parent.
 */

export type ReparentResult = ReparentPreview;

/** The board as the planners want it, for a caller that wants to plan first. */
export function boardViewOf(workspace: Workspace): BoardView {
  return viewOf(workspace);
}

/**
 * Queue a plan somebody has already read — the periods view builds a start-now
 * plan to describe it in a dialog, and applies that very plan when the reader
 * agrees, rather than planning a second time against a board that may have
 * moved underneath the question.
 */
export function applyPlan(workspace: Workspace, plan: Plan): string[] {
  return enact(workspace, plan, { member: false });
}

/** Change a document's type, moving it if the new type belongs somewhere else. */
export function convertType(workspace: Workspace, id: string, type: string): void {
  enact(workspace, planConvert(viewOf(workspace), id, type));
}

/** What dropping `id` onto `parentId` would do, without doing it. */
export function previewReparent(
  workspace: Workspace,
  id: string,
  parentId: string | null,
): ReparentPreview {
  return planPreviewReparent(viewOf(workspace), id, parentId);
}

export function reparent(workspace: Workspace, id: string, parentId: string | null): boolean {
  const plan = planReparent(viewOf(workspace), id, parentId);
  if (!plan.ok) {
    workspace.notify('error', plan.error, plan.details);
    return false;
  }
  enact(workspace, plan);
  return true;
}

/** Both ways a drop could be made to work, for the dialog that asks which. */
export function reparentChoices(
  workspace: Workspace,
  id: string,
  parentId: string | null,
): ReparentChoices {
  return planReparentChoices(viewOf(workspace), id, parentId);
}

/**
 * Move a document under a new parent by creating the levels in between, so it
 * keeps the type it has. The containers land on the canvas with it, or the
 * dragged node would appear to jump into nothing.
 */
export function reparentWithBridge(
  workspace: Workspace,
  id: string,
  parentId: string | null,
  titles?: string[],
): string[] {
  return enact(
    workspace,
    planBridgeReparent(viewOf(workspace), idFactory(workspace), id, parentId, { titles }),
  );
}
