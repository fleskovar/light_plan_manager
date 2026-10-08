import { planStartNow } from '$shared';
import type { Workspace } from '$lib/workspace/workspace.svelte.js';
import type { Shell } from '$lib/app/shell.svelte.js';
import { todayIso } from '$lib/board/periods.js';
import { nodesOfKind, workUnitsUnder } from '$lib/board/selectors.js';
import {
  applyPlan,
  boardViewOf,
  carryOverPeriod,
  completePeriod,
  createNode,
  editNode,
  removeNodes,
  schedule,
  setPeriodActive,
} from '$lib/workspace/mutations.js';
import { columnKeys, needsFreshDates, nextPeriodDates, planResequence, type PeriodColumn } from './periods.js';

// ── Dialog descriptions ──────────────────────────────────────────

/** In words a reader can decline: what starting a period would change. */
export function describeStart(
  workspace: Workspace,
  id: string,
): { title: string; message: string; details: string[]; apply: () => void } | null {
  const period = workspace.node(id);
  if (period?.kind !== 'period') return null;
  const plan = planStartNow(boardViewOf(workspace), id, todayIso());
  if (!plan.ok || !plan.changes.length) return null;

  const closing = plan.closing.map((entry) => entry.title).join(', ');

  return {
    title: period.title,
    message:
      `New dates: ${plan.starts} → ${plan.ends} ` +
      `(${period.starts && period.ends ? 'same length' : 'default length'}).`,
    details: [
      ...(plan.carried.length
        ? [
            `${plan.carried.length} nested period${plan.carried.length === 1 ? '' : 's'} shift by the same amount.`,
          ]
        : []),
      ...(plan.closing.length
        ? [
            `${closing} ${plan.closing.length === 1 ? 'ends' : 'end'} yesterday.`,
          ]
        : []),
      'Parent periods extend to fit.',
    ],
    apply: () => applyPlan(workspace, plan),
  };
}

// ── Period lifecycle ─────────────────────────────────────────────

export function addPeriod(workspace: Workspace, type: string, parentId: string | null): string {
  const siblings = nodesOfKind(workspace.nodes, 'period').filter(
    (period) => period.parentId === parentId && period.type === type,
  );
  // Read off the working copy, so a sprint added to an increment that is itself
  // still a pending create is fenced by the dates that create carries.
  const parent = parentId ? workspace.node(parentId) : null;
  const id = createNode(workspace, {
    nodeKind: 'period',
    type,
    parentId,
    member: false,
    patch: nextPeriodDates(siblings, todayIso(), parent?.kind === 'period' ? parent : null),
  });
  workspace.selection.set([id]);
  return id;
}

export function startPeriod(workspace: Workspace, shell: Shell, id: string): void {
  const asked = describeStart(workspace, id);
  if (!asked) return;
  shell.confirm({
    title: `Start ${asked.title} today?`,
    message: asked.message,
    details: asked.details,
    confirmLabel: 'Change dates',
    onConfirm: asked.apply,
  });
}

export function switchPeriod(workspace: Workspace, shell: Shell, id: string, active: boolean | null): void {
  const period = workspace.node(id);
  if (period?.kind !== 'period') return;
  setPeriodActive(workspace, id, active);
  if (active !== true || !needsFreshDates(period)) return;

  const asked = describeStart(workspace, id);
  if (!asked) return;
  shell.confirm({
    title: `Move ${period.title} to today?`,
    message:
      `Its dates (${period.starts ?? '?'} → ${period.ends ?? '?'}) aren't current. ${asked.message}`,
    details: asked.details,
    confirmLabel: 'Move dates',
    onConfirm: asked.apply,
  });
}

export function removePeriod(workspace: Workspace, shell: Shell, id: string): void {
  const period = workspace.node(id);
  const nested = nodesOfKind(workspace.nodes, 'period').filter((entry) => entry.parentId === id).length;
  shell.confirm({
    title: `Delete ${period?.title ?? id}?`,
    message: `${period?.title ?? id} will be deleted on push.`,
    details: [
      'Its issues become unscheduled.',
      ...(nested ? [`Its ${nested} nested period${nested === 1 ? ' is' : 's are'} also deleted.`] : []),
    ],
    confirmLabel: 'Delete',
    danger: true,
    onConfirm: () => removeNodes(workspace, [id]),
  });
}

export function clearPeriods(workspace: Workspace, shell: Shell): void {
  const periods = nodesOfKind(workspace.nodes, 'period');
  if (!periods.length) return;
  const scheduled = nodesOfKind(workspace.nodes, 'issue').filter((issue) => issue.period).length;
  shell.confirm({
    title: 'Delete all periods?',
    message: `All ${periods.length} periods will be deleted on push.`,
    details: [
      `${scheduled} scheduled issue${scheduled === 1 ? '' : 's'} become unscheduled.`,
    ],
    confirmLabel: 'Delete all',
    danger: true,
    onConfirm: () =>
      removeNodes(
        workspace,
        periods.filter((period) => !period.parentId).map((period) => period.id),
      ),
  });
}

// ── Tree utilities ───────────────────────────────────────────────

export function findColumn(columns: PeriodColumn[], key: string): PeriodColumn | null {
  for (const col of columns) {
    if (col.key === key) return col;
    const found = findColumn(col.children, key);
    if (found) return found;
  }
  return null;
}
