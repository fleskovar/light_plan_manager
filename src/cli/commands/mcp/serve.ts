import { parseArgs } from 'node:util';
import { BoardError, findBoardPaths, USER_ENV_VAR, PROFILE_ENV_VAR } from '../../../core/index.js';
import { noBoardFound } from '../../context.js';
import { err } from '../../ui.js';

/** stdout is the transport, so anything we would say has to go to stderr. */
function note(line: string): void {
  err(line);
}

export function run(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: {
      user: { type: 'string' },
      profile: { type: 'string' },
      'read-only': { type: 'boolean' },
      'allow-remote': { type: 'boolean' },
      root: { type: 'string' },
    },
  });

  const paths = findBoardPaths(values.root);
  if (!paths) throw noBoardFound('Or pass --root <path>.');

  void (async () => {
    let server: typeof import('../../../mcp/index.js');
    try {
      // The SDK is an optional dependency: the engine and the CLI keep their two
      // runtime dependencies, and this one is only needed to talk to agents.
      server = await import('../../../mcp/index.js');
    } catch (error) {
      const message = (error as Error).message;
      throw new BoardError('The MCP server is not available', [
        'It needs @modelcontextprotocol/sdk, which is an optional dependency.',
        'Install it with: npm install @modelcontextprotocol/sdk',
        message,
      ]);
    }

    // Precedence, most-specific first: explicit flag, then the environment,
    // then (in BoardContext) the profile's `user:`. The same constants the
    // CLI honours — LPM_USER / LPM_PROFILE — so one env var works for both.
    const user =
      values.user ?? (process.env[USER_ENV_VAR]?.trim() || undefined) ?? null;
    const profile =
      values.profile ?? (process.env[PROFILE_ENV_VAR]?.trim() || undefined) ?? null;

    note(`light-plan MCP server on ${paths.root}`);
    if (user) {
      const source = values.user ? 'flag' : `$${USER_ENV_VAR}`;
      note(`  acting as ${user} (${source})`);
    }
    if (profile) {
      const source = values.profile ? 'flag' : `$${PROFILE_ENV_VAR}`;
      note(`  profile ${profile} (${source})`);
    }
    if (values['read-only']) note('  read-only');
    if (values['allow-remote']) note('  allow-remote (remote_sync registered)');

    await server.startMcpServer(paths, {
      user,
      profile,
      readOnly: values['read-only'] === true,
      allowRemote: values['allow-remote'] === true,
    });
  })().catch((error: unknown) => {
    if (error instanceof BoardError) {
      err(`error ${error.message}`);
      for (const detail of error.details) err(`       ${detail}`);
    } else {
      err(`error ${(error as Error).message}`);
    }
    process.exitCode = 1;
  });

  // The process stays alive on the stdio transport until the host closes it.
  return 0;
}
