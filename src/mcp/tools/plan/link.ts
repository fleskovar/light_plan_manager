import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BoardError, findIssue, linkIssue, rollupsForEdges } from '../../../core/index.js';
import type { BoardContext } from '../../context.js';
import { guard, json } from '../../reply.js';

export function registerLinkTools(server: McpServer, context: BoardContext): void {
  server.registerTool(
    'link_issues',
    {
      title: 'Add or remove a dependency',
      description:
        'Record that one issue blocks another, or take that back. Only the forward edge is ' +
        'stored; a dependency that would close a cycle is refused. Write the dependency ' +
        'between the two pieces of work that actually have it: the containers above them are ' +
        'put in the same order automatically, up to the container they share, and `alsoOrders` ' +
        'reports which ones. Adding that edge to the containers yourself would stop every ' +
        'other piece of work inside them.',
      inputSchema: {
        blocked: z.string().describe('The issue that has to wait'),
        blockedBy: z.array(z.string()).min(1).describe('The issues it waits for'),
        remove: z.boolean().default(false),
      },
    },
    guard((args) => {
      context.assertWritable();
      const board = context.board();
      const issue = findIssue(board, args.blocked);
      if (!issue) throw new BoardError(`No issue with id "${args.blocked}"`);

      const result = linkIssue(board, issue, {
        dependsOn: args.blockedBy,
        remove: args.remove,
      });
      // Read off the same handle the write went through, which is stale by
      // then — that is what `rollupsForEdges` expects.
      const rolled = rollupsForEdges(
        board,
        result.addedDependsOn.map((target) => ({ from: issue.id, to: target })),
      );
      return json({
        issue: result.issue.id,
        dependsOn: result.issue.depends_on,
        added: result.addedDependsOn,
        removed: result.removedDependsOn,
        // The containers this dependency now stands behind each other. Nothing
        // is written on them; the board reads it off the work inside them.
        alsoOrders: rolled.map((entry) => ({
          issue: entry.from,
          waitsOn: entry.to,
          because: { blocked: entry.source, blockedBy: entry.target },
        })),
      });
    }),
  );
}
