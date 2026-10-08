/**
 * Turning a list of `Change`s into writes on disk.
 *
 * `src/shared` says what an edit *is*; `src/core` knows how to perform one. This
 * layer is the hinge between them, and it is deliberately not part of either:
 * the engine should not know about the wire protocol, and the protocol should
 * not know about the filesystem.
 *
 * Three front ends replay changes through here, which is what keeps them
 * agreeing about what an edit means:
 *
 *   the web app  pushes a view's queued changes (src/server/routes/views.ts)
 *   the CLI      runs a planned edit immediately (src/cli/commands/*)
 *   the MCP      does the same on an agent's behalf (src/mcp)
 *
 *   dto.ts      core model -> the wire DTOs, the only place that knows both
 *   session.ts  a board handle that reloads between operations
 *   patch.ts    one patch -> the core operations it implies, in order
 *   apply.ts    a change list -> what landed and what did not
 *   static.ts   a board -> the one file `lpm export` publishes
 */
export * from './apply.js';
export * from './dto.js';
export * from './static.js';
