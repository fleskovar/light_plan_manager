import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { planDuplicate, planInsert } from '../../../shared/index.js';
import type { BoardContext } from '../../context.js';
import { guard, json } from '../../reply.js';

export function registerGraphTools(server: McpServer, context: BoardContext): void {
  server.registerTool(
    'insert_between',
    {
      title: 'Insert an issue into a dependency',
      description:
        'Put an issue in the middle of an existing dependency: source -> target becomes ' +
        'source -> middle -> target, replacing the original edge. Either move an existing ' +
        'issue in with `issue`, or leave it out to create one at the upstream issue\'s level.',
      inputSchema: {
        source: z.string().describe('The upstream issue'),
        target: z.string().describe('The downstream issue, which depends on source'),
        issue: z.string().optional().describe('Move this existing issue in'),
        type: z.string().optional().describe('Otherwise create one of this type'),
        title: z.string().optional(),
      },
    },
    guard((args) => {
      const plan = planInsert(context.view(), context.ids(), {
        source: args.source,
        target: args.target,
        issueId: args.issue,
        type: args.type,
        title: args.title,
      });
      const { created } = context.run(plan);
      return json({
        inserted: created[0] ?? args.issue,
        between: [args.source, args.target],
      });
    }),
  );

  server.registerTool(
    'copy_documents',
    {
      title: 'Duplicate documents',
      description:
        'Copy documents and everything nested under them. Dependencies between the copied ' +
        'documents are kept and repointed at the copies; those leaving the selection are ' +
        'dropped, so the duplicate stands on its own.',
      inputSchema: {
        ids: z.array(z.string()).min(1),
        under: z.string().nullable().optional().describe('Put the copies here instead'),
      },
    },
    guard((args) => {
      const plan = planDuplicate(context.view(), context.ids(), args.ids);
      if (plan.ok && args.under !== undefined) {
        const roots = new Set(plan.created.slice(0, args.ids.length));
        for (const change of plan.changes) {
          if (change.kind === 'create' && roots.has(change.id)) change.patch.parentId = args.under;
        }
      }
      const { created } = context.run(plan);
      return json({ copied: args.ids, created });
    }),
  );
}
