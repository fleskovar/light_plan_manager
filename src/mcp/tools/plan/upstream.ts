import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BoardError } from '../../../core/index.js';
import { scheduleUpstream } from '../../../shared/index.js';
import type { BoardContext } from '../../context.js';
import { guard, json } from '../../reply.js';

/**
 * Pushing the work behind an issue into a queue.
 *
 * A thin caller of `scheduleUpstream` in `src/shared/plans/upstream.ts`, the
 * same planner `lpm upstream --schedule` and the canvas menu use.
 *
 * Its read half — `upstream_work` — is deliberately *not* here. Asking what has
 * to happen first is free, and a read-only server never registers this module,
 * so the question would go unanswerable for exactly the agent most likely to be
 * asking it. It lives in `../work.ts` instead. @see registerWorkTools
 */
export function registerUpstreamTools(server: McpServer, context: BoardContext): void {
  server.registerTool(
    'schedule_upstream',
    {
      title: 'Push the work behind an issue into the queue',
      description:
        'Take everything `upstream_work` reports for an issue and put the unclaimed part of ' +
        'it in the same period, with the same person or pool, as the issue waiting on it — so ' +
        'a chain nobody had scheduled becomes work the queue actually offers. Two rules, both ' +
        'deliberately narrow. Upstream work somebody **already holds is left alone**, its ' +
        'period included: it is their work, and moving it between sprints would be a worse ' +
        'surprise than a short list. And only **work units** are scheduled — a period written ' +
        'on an epic offers nobody anything, because the queue hands out units — so containers ' +
        'are reported and left as they are. Everything looked at comes back in `decisions` ' +
        'with `skipped` saying why, so "nothing changed" can be told apart from "nothing ' +
        'found". Pass `period` or `assignee` to override what is copied, or null for neither ' +
        'half.',
      inputSchema: {
        id: z.string().describe('The issue whose upstream work should be scheduled'),
        period: z
          .string()
          .nullable()
          .optional()
          .describe("Schedule into this period; omit to use the issue's own, null for none"),
        assignee: z
          .string()
          .nullable()
          .optional()
          .describe("Give it to this resource; omit to use the issue's own, null for nobody"),
        dryRun: z.boolean().default(false).describe('Report what would happen, change nothing'),
      },
    },
    guard((args) => {
      const view = context.view();
      const result = scheduleUpstream(view, args.id, {
        ...(args.period !== undefined ? { period: args.period } : {}),
        ...(args.assignee !== undefined ? { assignee: args.assignee } : {}),
      });
      if (!result.plan.ok) throw new BoardError(result.plan.error, result.plan.details);

      const scheduled = result.decisions.filter((entry) => !entry.skipped).map((entry) => entry.id);
      const report = {
        id: args.id,
        period: result.period,
        assignee: result.assignee,
        decisions: result.decisions.map((entry) => ({
          id: entry.id,
          reason: entry.reason,
          skipped: entry.skipped,
        })),
      };

      if (args.dryRun) return json({ ...report, wouldSchedule: scheduled });
      context.run(result.plan);
      return json({ ...report, scheduled });
    }),
  );
}
