import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BoardContext } from '../../context.js';
import { registerCreateTools } from './create.js';
import { registerDeleteTools } from './delete.js';
import { registerGraphTools } from './graph.js';
import { registerLinkTools } from './link.js';
import { registerReshapeTools } from './reshape.js';
import { registerTimelineTools } from './timeline.js';
import { registerUpstreamTools } from './upstream.js';

/**
 * Structuring the board: the tools a planning agent uses to lay work out.
 *
 * The multi-step ones — split, insert, copy, convert — go through the same
 * planners the web UI and `lpm` use, so an agent reshaping a graph gets exactly
 * the rewiring a person would get by dragging nodes around.
 */
export function registerPlanTools(server: McpServer, context: BoardContext): void {
  registerCreateTools(server, context);
  registerReshapeTools(server, context);
  registerTimelineTools(server, context);
  registerGraphTools(server, context);
  registerDeleteTools(server, context);
  registerLinkTools(server, context);
  registerUpstreamTools(server, context);
}
