/**
 * The verbs the UI has for changing a board.
 *
 * Free functions over a `Workspace` rather than methods on it: the store's job
 * is to hold the working copy and the queue, and these compose that one
 * primitive (`record`) into the operations menus and shortcuts trigger.
 *
 * Six feature areas, each in `./mutations/`:
 *
 * - `edits.ts`      single-node edits, field shortcuts, and scheduling
 * - `structure.ts`  type conversion, reparenting, and bridge-building
 * - `timeline.ts`   period activation and overrun corrections
 * - `links.ts`      dependencies and edge splicing
 * - `bulk.ts`       duplicating and breaking down
 * - `upstream.ts`   drawing and scheduling the work an issue waits on
 * - `shared.ts`     internal queue/plan helpers (not re-exported)
 *
 * The multi-step edits are planned in `$shared/plans`, so the canvas, `lpm` and
 * the MCP server rewire a graph the same way.  What is left here is the part
 * that is genuinely about this app: queueing the result, keeping the canvas
 * membership in step, and reporting a refusal where the user can see it.
 */

export type { NewNodeOptions } from './mutations/edits.js';
export {
  assign,
  assignSelection,
  countOf,
  createNode,
  editNode,
  removeNodes,
  schedule,
  scheduleLeaves,
  scheduleSelection,
  setStatus,
} from './mutations/edits.js';

export type { ReparentResult } from './mutations/structure.js';
export {
  applyPlan,
  boardViewOf,
  convertType,
  previewReparent,
  reparent,
  reparentChoices,
  reparentWithBridge,
} from './mutations/structure.js';

export {
  carryOverPeriod,
  completePeriod,
  setPeriodActive,
} from './mutations/timeline.js';

export {
  addDependency,
  insertOnEdge,
  removeDependency,
  spliceOntoEdge,
} from './mutations/links.js';

export type { BreakdownRequest } from './mutations/bulk.js';
export { breakDown, duplicate } from './mutations/bulk.js';

export { addUpstream, scheduleUpstream } from './mutations/upstream.js';
