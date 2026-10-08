import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { BoardPaths } from '../core/index.js';
import { BoardContext } from './context.js';
import { registerPlanTools } from './tools/plan.js';
import { registerReadTools } from './tools/read.js';
import { registerRemoteTools } from './tools/remote.js';
import { registerTemplateTools } from './tools/templates.js';
import { registerWorkTools } from './tools/work.js';

/**
 * light-plan as an MCP server, so an agent can use the board the way a person
 * does.
 *
 * The tools mirror the CLI rather than exposing the engine directly: an agent
 * that splits a story gets the same rewiring a person dragging nodes gets,
 * because both go through the planners in `src/shared` and the replay in
 * `src/sync`. That is what lets a planning agent, a working agent and a human
 * share one board without any of them seeing a structure the others would not
 * recognise.
 *
 *   read/       what is on the board
 *   plan/       structuring it
 *   templates/  the reusable pieces of plan somebody already worked out
 *   work/       picking work up, recording how it went
 *   remote/     the tracker the board mirrors: status and preview always,
 *               the gated sync under `--allow-remote`
 *
 * Identity is per session (`--user`), never written to `.lpm/local.json`, so a
 * dozen agents can work one checkout without overwriting each other's answer to
 * "who am I". `--profile` is the same promise for "what is mine": it narrows
 * what the listing and recommendation tools offer, and never what an id can
 * reach — an agent handed a dependency it cannot read would be worse off than
 * one shown work it should leave alone.
 */
export const MCP_SERVER_NAME = 'light-plan';

export interface McpOptions {
  /** The resource this session acts as: an id or a name. */
  user?: string | null;
  /**
   * A profile file for this session: who the agent is, and which part of the
   * board it is offered. Per session, like `user` and for the same reason.
   */
  profile?: string | null;
  /** Register only the tools that do not write. */
  readOnly?: boolean;
  /**
   * Register `remote_sync`, the one tool that writes to a tracker outside the
   * checkout. Off by default, and independent of `readOnly`: a read-only
   * server never registers it, even with this flag.
   */
  allowRemote?: boolean;
  version?: string;
}

export function createMcpServer(paths: BoardPaths, options: McpOptions = {}): McpServer {
  const context = new BoardContext(paths, {
    user: options.user ?? null,
    profile: options.profile ?? null,
    readOnly: options.readOnly === true,
    allowRemote: options.allowRemote === true,
  });

  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: options.version ?? '0.1.0' },
    {
      instructions:
        'This is a light-plan board: a file-based issue tracker where the plan lives in a ' +
        '.lpm folder as markdown, versioned with git.\n\n' +
        'Call board_overview first. Boards define their own document types, hierarchy and ' +
        'statuses, and every other tool speaks in those names — do not assume "epic" or ' +
        '"done" exist until you have seen them.\n\n' +
        'Three collections: issues (what gets built, nested by scope), periods (when — ' +
        'sprints and increments) and resources (who — people and the generic pools work can ' +
        'wait in). An issue at any level can be scheduled into any period and assigned to ' +
        'any resource.\n\n' +
        'Before you write anything, call list_templates. The registry holds reusable pieces of ' +
        'plan this team has already worked out — a feature with its standard stories, the steps ' +
        'a particular kind of change has to go through. If one covers what you are about to ' +
        'create, instantiate_template is both faster and the process they agreed on; creating ' +
        'the same thing by hand quietly skips it.\n\n' +
        'To plan: create documents, link them with link_issues, and reshape with split_issue, ' +
        'insert_between, convert_document and copy_documents — those keep the dependency ' +
        'graph wired up for you, so prefer them to editing edges by hand.\n\n' +
        'To do the work: next_tasks, start_task, then add_comment as you go and finish_task ' +
        'when it is done. Comments are the trail you leave for whoever picks the issue up ' +
        'next, human or agent — say what you tried and what you found, not just that you ' +
        'finished.\n\n' +
        'If this board mirrors a remote tracker, remote_status reports the drift between the ' +
        'two and remote_preview shows what a sync would do without doing it — both are safe. ' +
        'remote_sync is the only tool that writes to a system outside this checkout; it is ' +
        'registered only when the server was started with --allow-remote, and it acts as the ' +
        "board's tracker account, not yours.",
    },
  );

  registerReadTools(server, context);
  registerWorkTools(server, context);
  // Reading the registry is free; instantiating writes, so `guard` and
  // `context.run` refuse it on a read-only server the way every other write is
  // refused. Registering the read tools either way is what keeps "check the
  // registry first" true for an agent that cannot change anything.
  registerTemplateTools(server, context);
  if (!context.readOnly) registerPlanTools(server, context);
  // The remote tools register themselves with the one gate: `remote_status` and
  // `remote_preview` always, `remote_sync` only under `--allow-remote` (and
  // never on a read-only server).
  registerRemoteTools(server, context);

  return server;
}

/** Serve over stdio, which is how an agent host launches this. */
export async function startMcpServer(paths: BoardPaths, options: McpOptions = {}): Promise<void> {
  const server = createMcpServer(paths, options);
  await server.connect(new StdioServerTransport());
}
