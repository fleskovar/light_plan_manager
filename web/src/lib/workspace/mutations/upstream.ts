import { blockingLookupOf, scheduleUpstream as planUpstream, upstreamWork } from '$shared';
import { ancestorsOf } from '$lib/board/selectors.js';
import type { Workspace } from '../workspace.svelte.js';
import { countOf } from './edits.js';
import { enact, viewOf } from './shared.js';

/**
 * The work behind a piece of work: drawing it, and pushing it into a queue.
 *
 * Both verbs read the *same* `upstreamWork` the engine and `lpm upstream` read,
 * over the working copy rather than over disk — so the picture answers for the
 * board as it stands on screen, unpushed edits included. Neither of them
 * decides what counts as upstream; that lives once in `$shared/blocking.ts`.
 */

/** The upstream chain of `id`, read off the working copy. */
function upstreamIdsOf(workspace: Workspace, id: string): string[] {
  return upstreamWork(id, blockingLookupOf(viewOf(workspace))).map((entry) => entry.id);
}

/**
 * Draw everything that has to be finished before this issue can be.
 *
 * Ancestors come along with the work, because a story drawn without its feature
 * would float free of the subflow that gives it its meaning — the same rule the
 * importer follows. They are added as *containers*, not as findings: the count
 * reported is the upstream work itself, since that is what was asked for.
 */
export function addUpstream(workspace: Workspace, id: string): string[] {
  const node = workspace.node(id);
  if (node?.kind !== 'issue') return [];

  const upstream = upstreamIdsOf(workspace, id);
  if (!upstream.length) {
    workspace.notify('info', `No open upstream work for ${id}`);
    return [];
  }

  const wanted = new Set<string>(upstream);
  for (const found of upstream) {
    for (const ancestor of ancestorsOf(workspace.nodes, found, workspace.index)) {
      wanted.add(ancestor.id);
    }
  }
  // The starting point has to be on the canvas for the chain to lead anywhere.
  wanted.add(id);

  const added = [...wanted].filter((entry) => !workspace.isMember(entry));
  workspace.addMembers([...wanted]);
  workspace.notify(
    'info',
    added.length
      ? `Added ${countOf(added.length, 'issue')} upstream of ${id}`
      : `Upstream of ${id} already on the canvas`,
  );
  return upstream;
}

/**
 * Put the unclaimed work behind this issue in the same sprint, with the same
 * person or pool.
 *
 * A queued edit like any other, planned by `$shared/plans/upstream.ts` so the
 * canvas, `lpm upstream --schedule` and the MCP tool cannot disagree about what
 * is touched. What it *skipped* is reported as well as what it moved: a chain
 * of six issues that six people already hold is a different board from no
 * upstream work at all, and both would otherwise say "nothing to schedule".
 */
export function scheduleUpstream(workspace: Workspace, id: string): void {
  const result = planUpstream(viewOf(workspace), id);
  if (!result.plan.ok) {
    workspace.notify('error', result.plan.error, result.plan.details);
    return;
  }

  const moved = result.decisions.filter((entry) => !entry.skipped);
  const held = result.decisions.filter((entry) => entry.skipped === 'assigned');
  enact(workspace, result.plan, { member: false });

  const where = result.period ? (workspace.node(result.period)?.title ?? result.period) : 'no period';
  const who = result.assignee ? (workspace.node(result.assignee)?.title ?? result.assignee) : 'nobody';
  const details = held.length
    ? [`Skipped ${countOf(held.length, 'issue')} that already ${held.length === 1 ? 'has' : 'have'} an owner.`]
    : undefined;

  workspace.notify(
    'info',
    moved.length
      ? `Scheduled ${countOf(moved.length, 'issue')} upstream of ${id} into ${where}, for ${who}`
      : `Nothing to schedule upstream of ${id}`,
    details,
  );
}
