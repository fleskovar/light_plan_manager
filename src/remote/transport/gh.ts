/**
 * The `gh` connector (LP-293): a `Connector` that shells requests out to the
 * GitHub CLI, for users whose auth already lives there. It is a process
 * connector with `gh api` argv, so it shares the runner, abort and timeout
 * behaviour of `process.ts` and differs only in how a `RemoteRequest` becomes
 * a command.
 *
 * `connector: gh` is how config selects it; its `kind` is `process`, because
 * that is what a provider requires — it does not care whether the process is
 * `gh` or any other CLI.
 */

import type { Connector, RemoteRequest } from './connector.js';
import { processConnector } from './process.js';

export interface GhConnectorOptions {
  /** The `gh` binary; defaults to `gh` on PATH. */
  readonly binary?: string;
  /** Injectable runner, for tests that never invoke a real CLI. */
  readonly runner?: import('./process.js').ProcessRunner;
  readonly defaultTimeoutMs?: number;
}

/** Turn a request into `gh api` argv: endpoint, method, query fields, headers, body. */
function ghArgs(req: RemoteRequest): readonly string[] {
  const args: string[] = ['api', req.path.replace(/^\//, '')];
  if (req.method !== 'GET') args.push('-X', req.method);
  for (const [key, value] of Object.entries(req.query ?? {})) {
    if (value !== undefined) args.push('-f', `${key}=${value}`);
  }
  for (const [key, value] of Object.entries(req.headers ?? {})) {
    args.push('-H', `${key}: ${value}`);
  }
  if (req.body !== undefined) {
    // `--input -` reads the JSON body from stdin; `-H` says it is JSON.
    args.push('--input', '-', '-H', 'Content-Type: application/json');
  }
  return args;
}

export function ghConnector(options: GhConnectorOptions = {}): Connector {
  return processConnector({
    binary: options.binary ?? 'gh',
    runner: options.runner,
    defaultTimeoutMs: options.defaultTimeoutMs,
    buildArgs: ghArgs,
    serializeBody: (req) => (req.body === undefined ? undefined : JSON.stringify(req.body)),
    paginateArg: '--paginate',
  });
}
