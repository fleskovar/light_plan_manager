import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Issue } from '../../core/index.js';
import {
  BoardError,
  FLAG_REASONS,
  addComment,
  claimIssue,
  clearFlag,
  currentTasks,
  findIssue,
  flagIssue,
  flagLabel,
  flaggedIssues,
  isDerivedFlag,
  listComments,
  moveNode,
  nextTasks,
  removeComment,
  resourceLoad,
  terminalStatusId,
  upstreamOf,
} from '../../core/index.js';
import type { BoardContext } from '../context.js';
import { guard, json } from '../reply.js';

/**
 * Doing the work: the tools an agent uses to pick something up, say how it
 * went, and hand it on.
 *
 * `next_task` deliberately mirrors `lpm task next` rather than inventing its
 * own ranking — a team of agents and people should be handed work in the same
 * order, or the plan means different things depending on who reads it.
 *
 * `upstream_work` is here rather than beside its writing twin in
 * `plan/upstream.ts` because a read-only server never registers the planning
 * tools, and "what has to happen before this can be done" is exactly the
 * question a read-only agent is there to answer.
 */
export function registerWorkTools(server: McpServer, context: BoardContext): void {
  const who = (given: string | undefined, board = context.board()): string => {
    if (given) return given;
    const user = context.user(board);
    if (!user) {
      throw new BoardError('No resource given and this session has no user', [
        'Pass `assignee`, or start the server with --user <id or name>.',
      ]);
    }
    return user.id;
  };

  server.registerTool(
    'next_tasks',
    {
      title: 'What to work on next',
      description:
        'Work that is ready to start, best first: assigned to this resource or waiting in a ' +
        'pool it covers, with nothing unfinished blocking it. Containers are never offered — ' +
        'the work units under them carry the work. A work unit is an issue with no children, ' +
        'or one whose type the board declares `atomic`, which is taken whole: it is offered ' +
        'even when it has children, and what is nested inside it is its own checklist and is ' +
        'never offered separately. This is the ranking `lpm task next` uses. If this ' +
        "session has a scope, only work inside it is offered; `board_overview` says what it is. " +
        'Work scheduled in a period somebody switched off is not offered either — the switch ' +
        'means "not this one" — though it stays readable with `get_document` and startable by ' +
        'id. Take the top item you can honestly start, then call `get_instructions` on it for ' +
        'the context to do it with.',
      inputSchema: {
        assignee: z.string().optional().describe('A resource id or name; defaults to the session user'),
        includeUnassigned: z.boolean().default(false),
        includeParked: z
          .boolean()
          .default(false)
          .describe('Also offer work in periods somebody switched off'),
        limit: z.number().int().positive().max(50).default(10),
      },
      annotations: { readOnlyHint: true },
    },
    guard((args) => {
      const board = context.board();
      const tasks = nextTasks(board, who(args.assignee, board), {
        includeUnassigned: args.includeUnassigned,
        includeParked: args.includeParked,
        limit: args.limit ?? 10,
        scope: context.scope(board),
      });
      return json({
        tasks: tasks.map((task) => ({
          id: task.issue.id,
          type: task.issue.type,
          title: task.issue.title,
          status: task.issue.status,
          period: task.issue.period,
          assignee: task.issue.assignee,
          attributes: task.issue.attributes,
          // How the work reached you: yours, or waiting in a pool you cover.
          route: task.route,
          pool: task.pool?.id ?? null,
        })),
      });
    }),
  );

  server.registerTool(
    'current_tasks',
    {
      title: 'What is in flight',
      description: 'Work this resource has already started: issues of theirs in an active status.',
      inputSchema: { assignee: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    guard((args) => {
      const board = context.board();
      const issues = currentTasks(board, who(args.assignee, board));
      return json({
        tasks: issues.map((issue) => ({
          id: issue.id,
          title: issue.title,
          status: issue.status,
          period: issue.period,
          // Work you have already stopped. `list_comments` says why.
          flag: issue.flag,
        })),
      });
    }),
  );

  server.registerTool(
    'upstream_work',
    {
      title: 'Everything that must be finished first',
      description:
        'The whole chain of work standing between an issue and being closed, nearest cause ' +
        'first. `next_tasks` tells you what is blocking something *today* and stops at the ' +
        'first thing; this keeps going — what those blockers wait on, what those wait on, to ' +
        'the end of the graph. Each entry says how it was reached. `dependency` is an edge ' +
        'somebody wrote, inherited from the issues above it: a story inside a feature waits ' +
        'on whatever the feature waits on. `contents` is open work *inside* a blocking ' +
        'container — a container is finished when its contents are, so a feature in the way ' +
        'is really its unfinished stories in the way, and those are what anyone can actually ' +
        'be handed. Use it to answer "why is this still not done", or before planning around ' +
        'one deliverable. `schedule_upstream` acts on the same answer.',
      inputSchema: {
        id: z.string().describe('The issue to look behind'),
      },
      annotations: { readOnlyHint: true },
    },
    guard((args) => {
      const board = context.board();
      const issue = findIssue(board, args.id);
      if (!issue) throw new BoardError(`No issue with id "${args.id}"`);

      return json({
        id: issue.id,
        title: issue.title,
        upstream: upstreamOf(board, issue).map((entry) => ({
          id: entry.issue.id,
          type: entry.issue.type,
          title: entry.issue.title,
          status: entry.issue.status,
          period: entry.issue.period,
          assignee: entry.issue.assignee,
          flag: entry.issue.flag ?? null,
          // How it was reached, and from where: enough to redraw the chain.
          reason: entry.reason,
          through: entry.through,
          distance: entry.distance,
        })),
      });
    }),
  );

  server.registerTool(
    'start_task',
    {
      title: 'Pick up an issue',
      description:
        'Claim an issue: assign it to this resource and move it to the board\'s first active ' +
        'status. Call `next_tasks` first unless you already know which one you want, and ' +
        '`get_instructions` straight after this one — that is the brief you work from. ' +
        'The claim is atomic and it can fail: several agents and people may share this ' +
        'checkout, and one of them may have taken this issue between your `next_tasks` call ' +
        'and this one. If you are told somebody else holds it, that is not an error to work ' +
        'around — call `next_tasks` again and take something else. Do not pass `force` to get ' +
        'past it; that takes work off somebody who is part-way through it.',
      inputSchema: {
        id: z.string(),
        assignee: z.string().optional().describe('Defaults to the session user'),
        force: z
          .boolean()
          .default(false)
          .describe('Take it even if someone else holds it. Almost never the right answer'),
      },
    },
    guard((args) => {
      context.assertWritable();
      const board = context.board();
      const issue = findIssue(board, args.id);
      if (!issue) throw new BoardError(`No issue with id "${args.id}"`);

      // The whole test-and-set — reload, check it is still free, write — happens
      // in there, under the board lock. @see src/core/operations/claim.ts
      const result = claimIssue(board, issue, {
        assignee: who(args.assignee, board),
        force: args.force,
      });
      return json({
        started: result.issue.id,
        status: result.issue.status,
        assignee: result.holder.id,
        // Nothing changed: this session already had it in progress.
        alreadyYours: result.alreadyHeld,
        // Set only when `force` took it off somebody who was holding it.
        takenFrom: result.takenFrom ?? null,
        // Picking up work inside a container that was closed reopens it.
        rolledUp: result.rollups.map((rollup) => ({ id: rollup.issue.id, status: rollup.to })),
      });
    }),
  );

  server.registerTool(
    'finish_task',
    {
      title: 'Finish an issue',
      description:
        "Move an issue to the board's first end state. Pass `comment` to record what was done " +
        'in the same call — the next person to read this issue will want it. ' +
        'Finishing the last open issue in a feature finishes the feature too, and so on up the ' +
        'tree — `rolledUp` lists what went with it, and anything that was waiting on those is ' +
        'ready now.',
      inputSchema: {
        id: z.string(),
        comment: z.string().optional().describe('Appended to the issue before it is closed'),
      },
    },
    guard((args) => {
      context.assertWritable();
      const board = context.board();
      const issue = findIssue(board, args.id);
      if (!issue) throw new BoardError(`No issue with id "${args.id}"`);

      const status = terminalStatusId(board.config);
      if (!status) throw new BoardError('This board declares no terminal status');

      if (args.comment) {
        addComment(board, issue.id, { body: args.comment, author: context.authorName(board) });
      }
      const fresh = context.board();
      const result = moveNode(fresh, findIssue(fresh, args.id)!, { status });
      // Finishing answers any flag on the issue; the comment trail keeps why.
      return json({
        finished: result.node.id,
        status,
        flagCleared: result.flagCleared ?? null,
        // Containers this closed: nobody works a feature, its stories do.
        rolledUp: result.rollups.map((rollup) => ({
          id: rollup.issue.id,
          title: rollup.issue.title,
          type: rollup.issue.type,
          status: rollup.to,
        })),
      });
    }),
  );

  server.registerTool(
    'flag_issue',
    {
      title: 'Say that work has stopped',
      description:
        'Raise a flag on an issue you are working on and cannot finish: something outside it ' +
        'has to happen first (`blocked`), you are deliberately setting it down (`paused`), or a ' +
        'person is needed (`help`). The issue keeps its status and its assignee — it stays ' +
        'yours — and it is drawn in red for whoever is running the plan. ' +
        'This is what to call instead of guessing at a requirement, inventing a workaround, or ' +
        'silently moving on to something else. The comment is required and is the whole point: ' +
        'say what you tried, what stopped you, and what would let the work resume. Someone who ' +
        'has not read your session has to be able to act on it. ' +
        'Clearing a flag is the plan owner\'s call, not yours — call `clear_flag` only if you ' +
        'are the one who was asked to unblock it.',
      inputSchema: {
        id: z.string(),
        comment: z
          .string()
          .min(1)
          .describe('What happened and what would resolve it. Markdown. Required'),
        reason: z.enum(FLAG_REASONS).default('blocked'),
      },
    },
    guard((args) => {
      context.assertWritable();
      const board = context.board();
      const issue = findIssue(board, args.id);
      if (!issue) throw new BoardError(`No issue with id "${args.id}"`);

      const result = flagIssue(board, issue, {
        reason: args.reason ?? 'blocked',
        comment: args.comment,
        author: context.authorName(board),
      });
      return json({
        flagged: issue.id,
        flag: result.flag,
        label: flagLabel(result.flag!),
        previous: result.previous,
        comment: result.comment,
        status: issue.status,
        note: 'The issue keeps its status and assignee. Do not start something else on this ' +
          'issue until the flag is cleared.',
      });
    }),
  );

  server.registerTool(
    'clear_flag',
    {
      title: 'Say that work can resume',
      description:
        'Take a flag off an issue: whatever stopped it has been dealt with. This is the plan ' +
        "owner's decision, not the implementer's — call it when you are the one answering the " +
        'flag, not to get past your own. The comment is required and should say what changed, ' +
        'because the person who raised the flag is the one who reads it.',
      inputSchema: {
        id: z.string(),
        comment: z.string().min(1).describe('What changed. Markdown. Required'),
      },
    },
    guard((args) => {
      context.assertWritable();
      const board = context.board();
      const issue = findIssue(board, args.id);
      if (!issue) throw new BoardError(`No issue with id "${args.id}"`);

      const result = clearFlag(board, issue, {
        comment: args.comment,
        author: context.authorName(board),
      });
      return json({ cleared: issue.id, was: result.previous, comment: result.comment });
    }),
  );

  server.registerTool(
    'flagged_issues',
    {
      title: 'What has stopped',
      description:
        'Every flagged issue on the board: work somebody picked up and could not finish. ' +
        'Deliberately unscoped and unfiltered — a flag is addressed to whoever is running the ' +
        'plan, so hiding one because it sits outside this session\'s slice would defeat it. ' +
        'Call `list_comments` on each to read why.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guard(() => {
      const board = context.board();
      const all = flaggedIssues(board);
      const shape = (issue: Issue) => ({
        id: issue.id,
        title: issue.title,
        type: issue.type,
        status: issue.status,
        assignee: issue.assignee,
        period: issue.period,
        flag: issue.flag,
        label: flagLabel(issue.flag!),
      });
      return json({
        // What somebody actually stopped, which is the list to act on.
        flagged: all.filter((issue) => !isDerivedFlag(issue.flag)).map(shape),
        // Containers standing in front of those, so a reader can see how far up
        // the plan a stall reaches. Written and cleared automatically.
        containing: all.filter((issue) => isDerivedFlag(issue.flag)).map(shape),
      });
    }),
  );

  server.registerTool(
    'add_comment',
    {
      title: 'Comment on a document',
      description:
        'Append to a document\'s work log: what was tried, what broke, what a reviewer asked ' +
        'for. Comments are markdown, live beside the document, and are committed with it. ' +
        'This is how an agent leaves a trail a human or another agent can pick up.',
      inputSchema: {
        id: z.string(),
        body: z.string().min(1).describe('Markdown'),
        author: z.string().optional().describe('Defaults to the session user'),
      },
    },
    guard((args) => {
      context.assertWritable();
      const board = context.board();
      const result = addComment(board, args.id, {
        body: args.body,
        author: args.author ?? context.authorName(board),
      });
      return json({
        document: result.node.id,
        comment: result.comment.index,
        author: result.comment.author,
        total: result.total,
      });
    }),
  );

  server.registerTool(
    'list_comments',
    {
      title: 'Read a document’s comments',
      description: 'The work log on a document, oldest first.',
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
    },
    guard((args) => json({ comments: listComments(context.board(), args.id) })),
  );

  server.registerTool(
    'remove_comment',
    {
      title: 'Delete a comment',
      description: 'Remove one entry from a document’s work log by its number.',
      inputSchema: { id: z.string(), index: z.number().int().positive() },
      annotations: { destructiveHint: true },
    },
    guard((args) => {
      context.assertWritable();
      const removed = removeComment(context.board(), args.id, args.index);
      return json({ removed: args.index, body: removed.body });
    }),
  );

  server.registerTool(
    'team_load',
    {
      title: 'Who is carrying what',
      description:
        'The roster with open, in-flight and finished counts against declared capacity, and ' +
        'the two situations that mean work cannot happen: a pool nobody covers, and open work ' +
        'nobody owns. Reports load; it does not level it.',
      inputSchema: { period: z.string().optional().describe('Scope to one period and its children') },
      annotations: { readOnlyHint: true },
    },
    guard((args) => {
      const report = resourceLoad(context.board(), args.period ? { periodId: args.period } : {});
      return json(report);
    }),
  );
}
