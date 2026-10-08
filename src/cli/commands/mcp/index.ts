import { BoardError } from '../../../core/index.js';
import { DEFAULT_CONFIG_FILE, DEFAULT_SERVER_NAME } from './config.js';
import * as serve from './serve.js';
import * as setup from './setup.js';

/**
 * `lpm mcp` serves the board to agents; `lpm mcp setup` writes the config a
 * host needs to launch it. Dispatching here rather than registering two
 * commands keeps them together, the way `lpm task` holds its subcommands —
 * including the help, since `index.ts` answers `--help` before a subcommand
 * ever sees it.
 */
export const help = `Serve this board to AI agents over the Model Context Protocol.

Usage
  lpm mcp [options]              Run the server (an agent host starts this)
  lpm mcp setup [options]        Write the configuration a host needs

Server options
      --user <id|name>  Act as this team member for the session
      --profile <path>  Use this profile: who the agent is, and what it is offered
      --read-only       Register only the tools that do not write
      --allow-remote    Register remote_sync, which writes to the board's tracker
      --root <path>     Board to serve (default: found from the working directory)

Setup options
      --file <path>     Add the entry to this existing config, in place
  -o, --output <path>   Write a new config here (default: <board>/${DEFAULT_CONFIG_FILE})
      --name <name>     Key for the server entry (default: ${DEFAULT_SERVER_NAME})
      --user <id|name>  Make the agent act as this team member
      --profile <path>  Point the agent at a profile (see \`lpm profile\`)
      --read-only       Give the agent only the tools that do not write
      --allow-remote    Give the agent remote_sync (writes to the board's tracker)
      --print           Print the config instead of writing it
      --force           Replace an entry of the same name, or an existing file

The server speaks MCP over stdin/stdout, so you rarely run it yourself.
\`lpm mcp setup\` writes the entry that launches it:

  {
    "mcpServers": {
      "light-plan": {
        "command": "lpm",
        "args": ["mcp", "--user", "Ada Lovelace"],
        "cwd": "/path/to/your/project"
      }
    }
  }

With --file the entry is merged into what is already there: the rest of the
file is left alone, and the key is matched to the one it already uses
(\`servers\` for VS Code, \`mcpServers\` for everyone else). Without it, a new
file is written, and an existing one is never clobbered.

--user and --profile are per session and are never written to .lpm/local.json,
so several agents can work the same checkout — each as someone else, each
offered a different part of the board — without overwriting each other.

A profile's scope narrows what next_tasks and list_documents offer. It never
narrows what get_document can reach: an agent handed a dependency it could not
read would be worse off than one shown work it should leave alone.

--allow-remote is the gate on the one tool that leaves the checkout:
remote_sync writes to the board's remote tracker. remote_status and
remote_preview are always registered; remote_sync is not registered at all
unless --allow-remote was passed — absent, not present-and-failing, so a model
does not keep retrying it. --read-only excludes every writing tool, remote
included, regardless of --allow-remote.

Examples
  lpm mcp setup                            # -> <board>/${DEFAULT_CONFIG_FILE}
  lpm mcp setup --user "Ada Lovelace"
  lpm mcp setup --profile ./profiles/frontend-agent.yml
  lpm mcp setup --file ~/.cursor/mcp.json
  lpm mcp setup --name light-plan-ro --read-only --file .mcp.json
  lpm mcp setup --allow-remote
  lpm mcp setup --print`;

const SUBCOMMANDS: Record<string, (args: string[]) => number> = { setup: setup.run };

export function run(args: string[]): number {
  const [first, ...rest] = args;
  if (first && !first.startsWith('-')) {
    const sub = SUBCOMMANDS[first];
    if (!sub) {
      throw new BoardError(`Unknown subcommand "${first}"`, [
        `Known: ${Object.keys(SUBCOMMANDS).join(', ')}.`,
        'Run `lpm mcp` with no subcommand to serve the board.',
      ]);
    }
    return sub(rest);
  }
  return serve.run(args);
}
