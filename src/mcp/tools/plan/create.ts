import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BoardError, findNode, moveNode, updateNode } from '../../../core/index.js';
import type { NodeKind } from '../../../shared/index.js';
import type { BoardContext } from '../../context.js';
import { guard, json } from '../../reply.js';

/** Shared by create_document and update_document. */
const attributes = z
  .record(z.string(), z.unknown())
  .optional()
  .describe('Attribute values, by the names board_overview lists for the type');

export function registerCreateTools(server: McpServer, context: BoardContext): void {
  server.registerTool(
    'create_document',
    {
      title: 'Create a document',
      description:
        'Add an issue, period or resource. The type decides where it goes: an issue type ' +
        'lands in the board, a period type in the timeline, a resource type in the roster. ' +
        'A type that is not top-level needs a parent of the type one level above it.',
      inputSchema: {
        type: z.string().describe('A type name from board_overview'),
        title: z.string(),
        parent: z.string().optional().describe('Parent document id'),
        body: z.string().optional().describe("Markdown body; replaces the type's template"),
        status: z.string().optional().describe('Issues only'),
        assignee: z.string().optional().describe('Issues only; a resource id or name'),
        period: z
          .string()
          .nullable()
          .optional()
          .describe(
            "Issues only; a period id. Omit it and the issue lands in the board's catch-all " +
              'period while that is the whole timeline; null keeps it unscheduled.',
          ),
        dependsOn: z.array(z.string()).optional().describe('Issues only; ids that block this'),
        relatedFiles: z
          .array(z.string())
          .optional()
          .describe(
            'Issues only; files this issue is about — the requirement it came from, the ' +
              'source that has to change. Paths from the project root, optionally with a ' +
              'line range: "docs/prd.md#L10-L42". Write these when you know them: they are ' +
              'the first thing whoever picks the issue up will open',
          ),
        starts: z.string().optional().describe('Periods only, YYYY-MM-DD'),
        ends: z.string().optional().describe('Periods only, YYYY-MM-DD'),
        capacity: z.number().optional().describe('Resources only; full-time equivalents'),
        attributes,
      },
    },
    guard((args) => {
      const board = context.board();
      const kind: NodeKind = context.view(board).config.types[args.type]?.kind ?? 'issue';
      const { created } = context.run({
        ok: true,
        created: ['new:1'],
        changes: [
          {
            kind: 'create',
            id: 'new:1',
            nodeKind: kind,
            patch: {
              type: args.type,
              title: args.title,
              parentId: args.parent ?? null,
              body: args.body,
              status: args.status,
              assignee: args.assignee,
              period: args.period,
              dependsOn: args.dependsOn,
              relatedFiles: args.relatedFiles,
              starts: args.starts,
              ends: args.ends,
              capacity: args.capacity,
              attributes: args.attributes,
            },
          },
        ],
      });
      return json({ created: created[0], type: args.type, title: args.title });
    }),
  );

  server.registerTool(
    'update_document',
    {
      title: 'Update a document',
      description:
        "Edit a document's own content and where it sits: title, body, attributes, and for " +
        'issues the status, assignee and period. Renaming moves its folder. Use ' +
        '`convert_document` to change what a document *is*.',
      inputSchema: {
        id: z.string(),
        title: z.string().optional(),
        body: z.string().optional(),
        status: z.string().optional().describe('Issues only'),
        assignee: z.string().nullable().optional().describe('Issues only; null to unassign'),
        period: z.string().nullable().optional().describe('Issues only; null to unschedule'),
        relatedFiles: z
          .array(z.string())
          .optional()
          .describe(
            'Issues only; replaces the whole list of files this issue is about. Pass the ' +
              'existing entries plus the new ones — `get_document` returns them',
          ),
        starts: z.string().optional().describe('Periods only'),
        ends: z.string().optional().describe('Periods only'),
        active: z
          .boolean()
          .nullable()
          .optional()
          .describe(
            'Periods only: run it whatever the dates say (true), park it (false), or ' +
              'hand it back to its dates (null). Use `start_period` to move the dates.',
          ),
        capacity: z.number().optional().describe('Resources only'),
        attributes,
      },
    },
    guard((args) => {
      context.assertWritable();
      const board = context.board();
      const node = findNode(board, args.id);
      if (!node) throw new BoardError(`No document with id "${args.id}"`);

      // Where a document sits is `move`; what it holds is `update`. Doing both
      // needs the second to run against the board the first left behind.
      let rolledUp: Array<{ id: string; status: string }> = [];
      if (args.status !== undefined || args.assignee !== undefined || args.period !== undefined) {
        const moved = moveNode(board, node, {
          status: args.status,
          assignee: args.assignee,
          period: args.period,
        });
        // A status carries the containers above it; say which ones moved.
        rolledUp = moved.rollups.map((rollup) => ({ id: rollup.issue.id, status: rollup.to }));
      }

      const fresh = context.board();
      const target = findNode(fresh, args.id)!;
      const result = updateNode(fresh, target, {
        title: args.title,
        body: args.body,
        attributes: args.attributes,
        relatedFiles: args.relatedFiles,
        starts: args.starts,
        ends: args.ends,
        active: args.active,
        capacity: args.capacity,
      });
      return json({ updated: result.node.id, title: result.node.title, rolledUp });
    }),
  );
}
