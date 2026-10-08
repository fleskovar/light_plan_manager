import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BoardError, findNode } from '../../../core/index.js';
import {
  planBreakdown,
  planBridgeReparent,
  planConvert,
  planReparent,
  reparentChoices,
} from '../../../shared/index.js';
import type { BoardContext } from '../../context.js';
import { guard, json } from '../../reply.js';

export function registerReshapeTools(server: McpServer, context: BoardContext): void {
  server.registerTool(
    'convert_document',
    {
      title: 'Convert a document to another type',
      description:
        'Change what a document is. A type that belongs at a different depth takes the ' +
        'document with it: a user story converted to a feature moves up to its epic. To ' +
        'demote instead, pass `under` — the id of the document it should sit inside. When ' +
        '`under` skips levels there are two answers: the document changes type, or with ' +
        '`buildParents` it keeps its type and the levels in between are created for it.',
      inputSchema: {
        id: z.string(),
        type: z.string().optional().describe('The new type; omit when using `under`'),
        under: z
          .string()
          .nullable()
          .optional()
          .describe('Move under this parent, demoting the type to fit; null for the top level'),
        buildParents: z
          .boolean()
          .default(false)
          .describe('With `under`: create the missing levels instead of changing the type'),
        dryRun: z.boolean().default(false).describe('Report what would happen, change nothing'),
      },
    },
    guard((args) => {
      const board = context.board();
      const view = context.view(board);

      if (args.under !== undefined) {
        const choices = reparentChoices(view, args.id, args.under);
        if (args.buildParents) {
          if (args.dryRun) return json({ wouldMove: args.id, creating: choices.bridge });
          const { created } = context.run(
            planBridgeReparent(view, context.ids(), args.id, args.under),
          );
          return json({ moved: args.id, under: args.under, created });
        }
        if (args.dryRun) {
          return json({ wouldMove: args.id, ...choices.convert, buildParents: choices.bridge });
        }
        context.run(planReparent(view, args.id, args.under));
        return json({ moved: args.id, under: args.under, type: choices.convert.type });
      }

      if (!args.type) throw new BoardError('Pass a type, or `under` to demote in place');
      const plan = planConvert(view, args.id, args.type);
      if (args.dryRun) {
        if (!plan.ok) throw new BoardError(plan.error, plan.details);
        return json({ wouldConvert: args.id, to: args.type, changes: plan.changes });
      }
      context.run(plan);
      const after = findNode(context.board(), args.id);
      return json({ converted: args.id, type: args.type, parentId: after?.parentId ?? null });
    }),
  );

  server.registerTool(
    'split_issue',
    {
      title: 'Break an issue into smaller ones',
      description:
        'Split one issue into several, keeping the graph wired up: whatever blocked the ' +
        'original blocks the first piece and whatever waited on it waits on the last. ' +
        '`children` nests the pieces inside the original (a story becoming sub-tasks); ' +
        '`replace` puts them where it stood and deletes it (one big story becoming five).',
      inputSchema: {
        id: z.string(),
        count: z.number().int().positive().max(50).optional(),
        titles: z.array(z.string()).optional().describe('Titles for the pieces; sets the count'),
        mode: z.enum(['children', 'replace']).default('children'),
        chain: z.boolean().default(true).describe('Make each piece depend on the one before it'),
        splitEffort: z
          .boolean()
          .default(false)
          .describe("Divide the board's effort attribute across the pieces"),
        dryRun: z.boolean().default(false),
      },
    },
    guard((args) => {
      const board = context.board();
      const count = args.count ?? args.titles?.length;
      if (!count) throw new BoardError('Pass a count, or a list of titles');

      const plan = planBreakdown(context.view(board), context.ids(), args.id, {
        count,
        mode: args.mode ?? 'children',
        titles: args.titles,
        chain: args.chain !== false,
        ...(args.splitEffort ? { splitAttribute: board.config.effort_attribute } : {}),
      });

      if (args.dryRun) {
        if (!plan.ok) throw new BoardError(plan.error, plan.details);
        return json({ wouldSplit: args.id, into: count, changes: plan.changes });
      }
      const { created } = context.run(plan);
      return json({ split: args.id, mode: args.mode ?? 'children', created });
    }),
  );
}
