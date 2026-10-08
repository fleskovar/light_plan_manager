import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LoadedBoard } from '../../core/index.js';
import { BoardError, remoteNames } from '../../core/index.js';
import {
  computeRemoteStatus,
  openRemote,
  runSync,
  type OpenedRemote,
  type RunSyncResult,
} from '../../remote/index.js';
import { remoteStatusExitCode, summarizePushFailures } from '../../shared/index.js';
import type { BoardContext } from '../context.js';
import { guard, json } from '../reply.js';

/**
 * The remote tools — what an agent can do with the tracker this board mirrors.
 *
 * Three tools, one gate.  `remote_status` and `remote_preview` are read-only
 * and always registered; `remote_sync` writes to a company's tracker and is
 * registered only when the server was started with `--allow-remote`.  The
 * remote's credentials are the *board's*, not the agent's, so every agent on a
 * checkout pushes as the same tracker account — the descriptions say so,
 * because "safe to preview, gated to run" is the whole point of this surface.
 *
 * All three are thin over the same remote layer the CLI and the web panel
 * drive (`computeRemoteStatus`, `runSync`), so an agent cannot see drift or a
 * plan that a person would not.
 */

/** The one remote a name-less call acts on, or a `BoardError` naming the choice. */
function singleRemoteName(board: LoadedBoard, given: string | undefined): string {
  const names = remoteNames(board.config);
  if (names.length === 0) {
    throw new BoardError('This board declares no remotes', [
      'Add a remotes: block to .lpm/config.yml first, e.g.',
      '  lpm remote add upstream --provider github --repo acme/payments',
    ]);
  }
  if (given !== undefined) {
    if (!names.includes(given)) {
      throw new BoardError(`No remote named "${given}"`, [
        names.length > 0 ? `Declared remotes: ${names.join(', ')}` : 'This board declares no remotes',
      ]);
    }
    return given;
  }
  if (names.length > 1) {
    throw new BoardError('This board declares more than one remote — name one', [
      `Declared remotes: ${names.join(', ')}`,
    ]);
  }
  return names[0]!;
}

/** The remote a call acts on, opened and validated. */
function openTarget(
  board: LoadedBoard,
  given: string | undefined,
): { name: string; remote: OpenedRemote } {
  const name = singleRemoteName(board, given);
  return { name, remote: openRemote(board.config, name) };
}

/** Refuse a filter naming no document, before any request is made. */
function validateFilter(board: LoadedBoard, filter: string | undefined): void {
  if (filter !== undefined && !board.byId.has(filter)) {
    throw new BoardError(`Filter names no document "${filter}"`, [
      'Give a document id on this board, e.g. the issue you just finished.',
    ]);
  }
}

/** A dry-run `RunSyncResult` as an agent reads it: the rendered plan, and nothing applied. */
function previewReply(name: string, result: RunSyncResult): Record<string, unknown> {
  return {
    remote: name,
    direction: result.direction,
    preflight: result.preflight.map((problem) => ({
      level: problem.level,
      message: problem.message,
    })),
    preflightBlocked: result.preflightBlocked,
    ...(result.unreachable !== undefined ? { unreachable: result.unreachable } : {}),
    plan: (result.renders ?? []).map((render) => render.text).join('\n\n') || 'Nothing to do.',
    note: 'Dry run — nothing was written to the board or the remote. Call remote_sync to apply it.',
  };
}

/** An applied `RunSyncResult` as an agent reads it: what landed, what did not. */
function syncReply(name: string, result: RunSyncResult): Record<string, unknown> {
  const reply: Record<string, unknown> = {
    remote: name,
    direction: result.direction,
    preflight: result.preflight.map((problem) => ({
      level: problem.level,
      message: problem.message,
    })),
    preflightBlocked: result.preflightBlocked,
  };

  if (result.unreachable !== undefined) reply.unreachable = result.unreachable;

  if (result.consentRefused !== undefined) {
    reply.consentRefused = {
      reason: result.consentRefused.reason,
      target: result.consentRefused.target,
      creates: result.consentRefused.counts.creates,
      closes: result.consentRefused.counts.closes,
      deletes: result.consentRefused.counts.deletes,
      threshold: result.consentRefused.threshold,
    };
  }

  if (result.pullResult !== undefined) {
    reply.pull = {
      applied: result.pullResult.applied.length,
      linked: result.pullResult.linked.length,
      unlinked: result.pullResult.unlinked.length,
      decoupled: result.pullResult.decoupled.length,
      appendedComments: result.pullResult.appendedComments,
      failures: summarizePushFailures(result.pullResult.failures),
    };
  }

  if (result.pushResult !== undefined) {
    reply.push = {
      created: result.pushResult.summary.created,
      updated: result.pushResult.summary.updated,
      skipped: result.pushResult.summary.skipped,
      conflicted: result.pushResult.summary.conflicted,
      failed: result.pushResult.summary.failed,
      conflictedOps: result.pushResult.conflicted.map((op) => ({
        kind: op.kind,
        localId: op.localId,
        error: op.error,
      })),
      failedOps: result.pushResult.failed.map((op) => ({
        kind: op.kind,
        localId: op.localId,
        error: op.error,
      })),
      ...(result.pushResult.stopped !== undefined
        ? { stopped: result.pushResult.stopped }
        : {}),
    };
  }

  if (result.pullPlan !== undefined) {
    reply.conflicts = {
      existence: (result.pullPlan.conflicts ?? []).map((conflict) => ({
        localId: conflict.localId,
        remoteId: conflict.remoteId,
        reason: conflict.reason,
      })),
      fields: (result.pullPlan.fieldConflicts ?? []).map((conflict) => ({
        localId: conflict.localId,
        field: conflict.field,
        local: conflict.local,
        remote: conflict.remote,
      })),
    };
  }

  return reply;
}

/** The zod shape the preview and sync tools share. */
const syncArgs = {
  name: z
    .string()
    .optional()
    .describe('The remote to act on; defaults to the only one declared'),
  filter: z
    .string()
    .optional()
    .describe(
      'Only this document and its subtree — sync the one issue you just ' +
        'finished rather than the whole board',
    ),
};

export function registerRemoteTools(server: McpServer, context: BoardContext): void {
  server.registerTool(
    'remote_status',
    {
      title: 'Is the board in step with its tracker',
      description:
        'Report the sync drift between this board and its remote tracker, document by ' +
        'document: ahead (local edits not pushed), behind (remote edits not pulled), ' +
        'conflicted (both sides edited), unlinked (never pushed) and orphaned. ' +
        'It also reports `incoming`: issues that exist in the tracker with no document ' +
        'on this board yet — work somebody added upstream. Those carry a remote key and ' +
        'title rather than a local id, because there is no local document; `remote_sync` ' +
        'with direction pull adopts them under the twin of their remote parent, which ' +
        '`parentLocalId` names. ' +
        'Read-only — it reads the remote but writes nothing anywhere. The remote is a ' +
        'tracker outside this checkout, so its credentials are the board\'s, not yours: ' +
        'every agent using this tool acts as the same tracker account. Use it before ' +
        '`remote_preview` or `remote_sync` to see whether anything needs syncing.',
      inputSchema: { name: syncArgs.name },
      annotations: { readOnlyHint: true },
    },
    guard(async (args) => {
      const board = context.board();
      const name = singleRemoteName(board, args.name);
      const report = await computeRemoteStatus(board, name);
      const exitCode = remoteStatusExitCode(report);
      return json({ ...report, exitCode, inSync: exitCode === 0 });
    }),
  );

  server.registerTool(
    'remote_preview',
    {
      title: 'What a sync would do, without doing it',
      description:
        'Show what `remote_sync` would do, without doing it: the plan rendered as a diff — ' +
        'what would be created, updated, closed, linked or unlinked — plus any preflight ' +
        'problem that would refuse the push. This is safe: it writes nothing to the board ' +
        'or the tracker. It does read the remote (as the board\'s tracker account, not ' +
        'yours), so it needs the same credential `remote_sync` does. Use it to report what ' +
        'a sync would do and to ask before running `remote_sync`.',
      inputSchema: { ...syncArgs },
      annotations: { readOnlyHint: true },
    },
    guard(async (args) => {
      const board = context.board();
      const { name, remote } = openTarget(board, args.name);
      validateFilter(board, args.filter);

      const result = await runSync(board, remote, board.paths, {
        direction: 'both',
        dryRun: true,
        ...(args.filter !== undefined ? { scope: args.filter } : {}),
      });
      return json(previewReply(name, result));
    }),
  );

  // The gate is the feature: `remote_sync` writes to somebody else's tracker,
  // so it is not even registered unless `--allow-remote` was passed — absent,
  // not present-and-failing, so a model never keeps retrying it.  `--read-only`
  // excludes it too, independently of `--allow-remote`.
  if (!context.allowRemote || context.readOnly) return;

  server.registerTool(
    'remote_sync',
    {
      title: 'Sync this board with its tracker',
      description:
        'Run a sync between this board and its remote tracker: pull remote edits, then ' +
        'push local ones, so finishing a task updates the team\'s tracker. ' +
        'THIS WRITES TO THE TRACKER — it is the only tool here that changes a system ' +
        'outside this checkout, so it is registered only when the server was started with ' +
        '`--allow-remote`. Pass `filter` to sync only one document (the issue you just ' +
        'finished) and its subtree rather than the whole board, and pass `dryRun` to see ' +
        'the plan instead. Every agent acts as the board\'s tracker account, not its own — ' +
        'call `remote_preview` first and report what you would do before you run this.',
      inputSchema: {
        ...syncArgs,
        dryRun: z
          .boolean()
          .default(false)
          .describe('Report what would happen, write nothing'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('At most this many remote write operations'),
        yes: z
          .boolean()
          .optional()
          .describe(
            'Confirm the first write, a plan larger than the write threshold, or ' +
              'a plan that deletes remote issues. An agent never prompts, so without ' +
              'this a refused plan stops with a message.',
          ),
      },
      annotations: { destructiveHint: true },
    },
    guard(async (args) => {
      // Defense in depth: registration already keeps this off a read-only
      // server, but the refusal must hold even if that gate ever loosens.
      context.assertWritable();
      const board = context.board();
      const { name, remote } = openTarget(board, args.name);
      validateFilter(board, args.filter);

      const result = await runSync(board, remote, board.paths, {
        direction: 'both',
        dryRun: args.dryRun === true,
        ...(args.filter !== undefined ? { scope: args.filter } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.yes === true ? { yes: true } : {}),
      });
      return json(args.dryRun ? previewReply(name, result) : syncReply(name, result));
    }),
  );
}
