/**
 * The process connector: a `Connector` that carries requests by running a
 * command, for users whose auth already lives in a CLI. Generic — a specific
 * tool (the `gh` connector, `gh.ts`) supplies the argv builder.
 *
 * Nothing here talks HTTP directly; the tool it runs does. Each request spawns
 * a fresh process, so `close()` has nothing to release, and a hung command is
 * interruptible with Ctrl-C because the abort signal kills the child.
 */

import { spawn } from 'node:child_process';
import type { Connector, RemoteRequest, RemoteResponse } from './connector.js';
import { RemoteError } from './error.js';
import { DEFAULT_TIMEOUT_MS, purposeOf } from './http.js';

/** What a finished command reports back. */
export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * The injectable seam between the connector and `child_process`. Tests pass a
 * fake; the default runs a real command.
 */
export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options: {
    /** Writes to the child's stdin, when the request carries a body. */
    readonly input?: string;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  },
) => Promise<ProcessResult>;

export interface ProcessConnectorOptions {
  /** The binary to run, e.g. `gh`. */
  readonly binary: string;
  /** The argv (after the binary) for one request. */
  readonly buildArgs: (req: RemoteRequest) => readonly string[];
  /** Turns the request body into stdin text; `undefined` sends no stdin. */
  readonly serializeBody?: (req: RemoteRequest) => string | undefined;
  /** Appended to argv when `paginate` asks the tool to page for us. */
  readonly paginateArg?: string;
  readonly runner?: ProcessRunner;
  readonly defaultTimeoutMs?: number;
}

const defaultRunner: ProcessRunner = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeoutMs = options.timeoutMs ?? 0;
    const timeoutHandle =
      timeoutMs > 0
        ? setTimeout(() => {
            child.kill('SIGTERM');
          }, timeoutMs)
        : undefined;
    const onAbort = (): void => {
      child.kill('SIGTERM');
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = (): void => {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      options.signal?.removeEventListener('abort', onAbort);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });

    if (options.input !== undefined) child.stdin.write(options.input);
    child.stdin.end();
  });

/** Decode stdout as JSON when it parses, raw text when it does not, `null` when empty. */
function decodeStdout<T>(stdout: string): T | null {
  if (stdout === '') return null;
  try {
    return JSON.parse(stdout) as T;
  } catch {
    return stdout as unknown as T;
  }
}

export function processConnector(options: ProcessConnectorOptions): Connector {
  const runner = options.runner ?? defaultRunner;
  const serializeBody = options.serializeBody ?? (() => undefined);
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function run<T>(
    req: RemoteRequest,
    extraArgs: readonly string[] = [],
  ): Promise<RemoteResponse<T>> {
    let result: ProcessResult;
    try {
      result = await runner(options.binary, [...options.buildArgs(req), ...extraArgs], {
        input: serializeBody(req),
        signal: req.signal,
        timeoutMs: req.timeoutMs ?? defaultTimeoutMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new RemoteError({
        kind: 'network',
        retryable: false,
        message: `${options.binary} could not run while ${purposeOf(req)}`,
        detail: message,
        cause: error,
      });
    }

    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim();
      throw new RemoteError({
        kind: 'api',
        code: 'unknown',
        status: null,
        retryable: false,
        message: `${options.binary} failed (exit ${result.exitCode}) while ${purposeOf(req)}`,
        providerMessage: stderr === '' ? null : stderr,
        detail: result.stderr,
      });
    }

    return { status: 200, ok: true, headers: {}, body: decodeStdout<T>(result.stdout) };
  }

  return {
    kind: 'process',

    request<T>(req: RemoteRequest) {
      return run<T>(req);
    },

    async *paginate<T>(req: RemoteRequest): AsyncGenerator<T> {
      // The tool pages for us (e.g. `gh api --paginate` concatenates every page
      // into one array), so the walk is a single, larger request.
      const response = await run<T>(
        req,
        options.paginateArg === undefined ? [] : [options.paginateArg],
      );
      if (response.body !== null) yield response.body;
    },

    // Each request spawns a fresh process; there is nothing to release.
    async close() {},
  };
}
