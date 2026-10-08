import type { ConfigDto, NodeDto, StatusRules } from '$shared';
import { rollupsUpward } from '$shared';
import type { NodeIndexImpl } from './index.js';
import type { WorkingNodes } from './working.js';

/**
 * The browser's copy of "a container's status comes from the work inside it".
 *
 * The engine rolls the status up when the change is pushed, so this exists to
 * keep the screen honest in the meantime: close the last story in a feature and
 * the feature has to go grey on the canvas straight away, not after a pull.
 *
 * The rule itself is `src/shared/rollup.ts`, imported rather than restated, and
 * the roll-up is deliberately *not* queued as a change of its own — the engine
 * derives it from the same rule on push. The client mirrors the engine's
 * rules; it does not own them.
 */

export function statusRulesFor(config: ConfigDto): StatusRules {
  const find = (id: string) => config.statuses.find((status) => status.id === id);
  return {
    isTerminal: (status) => find(status)?.terminal === true,
    isActive: (status) => find(status)?.active === true,
    terminalStatus: config.statuses.find((status) => status.terminal)?.id ?? null,
    activeStatus: config.statuses.find((status) => status.active)?.id ?? null,
    defaultStatus: config.defaultStatus,
  };
}

function childIdsOf(nodes: WorkingNodes, id: string, index?: NodeIndexImpl): string[] {
  if (index) return index.childrenOf(id).map((node) => node.id);
  return Object.values(nodes)
    .filter((node) => node.parentId === id)
    .map((node) => node.id);
}

function statusOf(node: NodeDto | undefined): string {
  return node && node.kind === 'issue' ? node.status : '';
}

/**
 * Carry an issue's status up through the containers above it, in place.
 *
 * A non-issue, or an issue whose ancestors already say the truth, changes
 * nothing. Returns the ids that moved, for whoever wants to say so.
 */
export function applyStatusRollup(
  nodes: WorkingNodes,
  id: string,
  config: ConfigDto,
  index?: NodeIndexImpl,
): string[] {
  const start = nodes[id];
  if (!start || start.kind !== 'issue') return [];

  const rollups = rollupsUpward(
    id,
    {
      parentOf: (nodeId) => nodes[nodeId]?.parentId ?? null,
      childIdsOf: (nodeId) => childIdsOf(nodes, nodeId, index),
      statusOf: (nodeId) => statusOf(nodes[nodeId]),
    },
    statusRulesFor(config),
  );

  for (const rollup of rollups) {
    const node = nodes[rollup.id];
    if (node?.kind === 'issue') node.status = rollup.to;
  }
  return rollups.map((rollup) => rollup.id);
}
