/**
 * The four categories of multi-step edit plan.
 *
 * Each planner is a pure function from `BoardView` → `Change[]`. The web queues
 * the result, the CLI and MCP hand it to `applyChanges`.  No planner imports
 * from core, sync or a front end — it only reads the structural DTOs, which is
 * what makes it reachable from all three surfaces.
 *
 * - `reading.ts`    plans for content operations (split, copy, insert-between)
 * - `breakdown.ts`  plans for reshaping (convert, reparent, build-parents)
 * - `reparent.ts`   plans for moving nodes within the hierarchy
 * - `timeline.ts`   plans for deadline operations (start-period, correct-period)
 * - `instantiate.ts` copying a registry template onto the board
 * - `upstream.ts`   scheduling the work an issue is waiting on
 */
export * from './reading.js';
export * from './breakdown.js';
export * from './reparent.js';
export * from './timeline.js';
export * from './instantiate.js';
export * from './upstream.js';
