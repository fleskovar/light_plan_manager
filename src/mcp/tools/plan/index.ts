/**
 * Planning tools that reshape the board.
 *
 * The ten tools registered here are the surface an agent (or CLI `lpm mcp`) uses
 * to lay work out. Each tool's description is a prompt for a model that has
 * never seen this board. The multi-step ones — split, insert, copy, convert —
 * go through the same planners (`src/shared/plans/`) the web UI and CLI use, so
 * an agent reshaping a graph gets the same rewiring a person gets by dragging
 * nodes around.
 *
 * Split by tool family into focused modules so no single file exceeds ~250 lines.
 * The only shared resource is the `attributes` zod schema, created once and
 * passed down.
 */
export { registerPlanTools } from './registrar.js';
