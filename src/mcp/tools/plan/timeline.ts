import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BoardError, nextPeriodAfter, openIssuesInPeriod } from '../../../core/index.js';
import {
  planCarryOver,
  planCompletePeriod,
  planStartNow,
} from '../../../shared/index.js';
import type { BoardContext } from '../../context.js';
import { guard, json } from '../../reply.js';

export function registerTimelineTools(server: McpServer, context: BoardContext): void {
  server.registerTool(
    'start_period',
    {
      title: 'Start a period today',
      description:
        'Move a sprint or increment so that it runs from today, keeping how long it runs. ' +
        'Everything nested inside it moves by the same number of days, so a restarted ' +
        'increment keeps its shape; whatever else was running today is closed yesterday, ' +
        'and the periods above stretch to reach the new dates. This rewrites dates on ' +
        'several documents — call it when somebody has decided a timebox starts now, not ' +
        'to record that one is already running.',
      inputSchema: {
        id: z.string().describe('A period id'),
        dryRun: z.boolean().optional().describe('Report what would change, write nothing'),
      },
    },
    guard((args) => {
      const today = new Date().toISOString().slice(0, 10);
      const plan = planStartNow(context.view(), args.id, today);
      if (!plan.ok) throw new BoardError(plan.error, plan.details);

      const summary = {
        period: args.id,
        starts: plan.starts,
        ends: plan.ends,
        moved: plan.carried.map((period) => period.id),
        closed: plan.closing.map((period) => period.id),
      };
      if (args.dryRun) return json({ wouldStart: summary, changes: plan.changes });
      context.run(plan);
      return json({ started: summary });
    }),
  );

  server.registerTool(
    'correct_period',
    {
      title: 'Correct a period that overran',
      description:
        'A sprint ended with work still open in it, and there are exactly two honest ' +
        'answers. `complete` moves every open issue in it to the board\'s end state, which ' +
        'records that the team stopped rather than that the work happened. `carry` moves ' +
        'the open issues into the next period beside it and leaves the finished ones where ' +
        'they are. Neither creates a period, so carrying over down a run is what makes the ' +
        'last one\'s backlog grow. Only issues scheduled *directly* in the period are ' +
        'touched: an increment answers for its own epics, its sprints for their stories.',
      inputSchema: {
        id: z.string().describe('A period id'),
        mode: z
          .enum(['complete', 'carry'])
          .describe('complete: mark the open work done. carry: move it to the next period'),
        dryRun: z.boolean().optional().describe('Report what would change, write nothing'),
      },
    },
    guard((args) => {
      const board = context.board();
      const view = context.view(board);
      const open = openIssuesInPeriod(board, args.id).map((issue) => issue.id);
      const next = nextPeriodAfter(board, args.id);

      const plan =
        args.mode === 'complete'
          ? planCompletePeriod(view, args.id)
          : planCarryOver(view, args.id);
      if (!plan.ok) throw new BoardError(plan.error, plan.details);

      const summary = { period: args.id, mode: args.mode, issues: open, movedTo: next?.id ?? null };
      if (args.dryRun) return json({ wouldCorrect: summary, changes: plan.changes });
      context.run(plan);
      return json({ corrected: summary });
    }),
  );
}
