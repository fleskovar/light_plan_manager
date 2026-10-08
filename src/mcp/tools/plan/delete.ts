import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BoardError, findNode, nodesOf, subtreeOf } from '../../../core/index.js';
import { removeNode } from '../../../core/index.js';
import type { BoardContext } from '../../context.js';
import { guard, json } from '../../reply.js';

export function registerDeleteTools(server: McpServer, context: BoardContext): void {
  server.registerTool(
    'delete_document',
    {
      title: 'Delete a document',
      description:
        'Remove a document and everything nested under it. Anything that pointed at it is ' +
        'rewritten, so the board is left valid. Deleting something with children requires ' +
        '`recursive`, because it is rarely what a typo means.',
      inputSchema: {
        id: z.string(),
        recursive: z.boolean().default(false),
        dryRun: z.boolean().default(false),
      },
      annotations: { destructiveHint: true },
    },
    guard((args) => {
      context.assertWritable();
      const board = context.board();
      const node = findNode(board, args.id);
      if (!node) throw new BoardError(`No document with id "${args.id}"`);

      const doomed = subtreeOf(nodesOf(board, node.kind), node);
      if (doomed.length > 1 && !args.recursive && !args.dryRun) {
        throw new BoardError(`${node.id} has ${doomed.length - 1} descendant(s)`, [
          'Pass recursive: true to delete them all, or dryRun: true to list them.',
        ]);
      }
      if (args.dryRun) return json({ wouldDelete: doomed.map((entry) => entry.id) });

      const result = removeNode(board, node);
      return json({ deleted: result.removed, rewritten: result.detached });
    }),
  );
}
