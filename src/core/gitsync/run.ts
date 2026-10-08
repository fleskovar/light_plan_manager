import { execFile, spawnSync } from 'node:child_process';

/**
 * The one way this layer runs git.
 *
 * Two properties matter more than anything else here, because git is being run
 * on somebody's behalf from places with nobody to answer it — a web request, an
 * MCP tool call, an agent twenty minutes into a task:
 *
 * **It never waits for a person.** A network command runs with
 * `GIT_TERMINAL_PROMPT=0`, so a missing credential is an error rather than a
 * password prompt nobody will ever see, and SSH runs in `BatchMode` (unless the
 * user already chose their own `GIT_SSH_COMMAND`), so an unknown host key is a
 * refusal rather than a question. Every command has a timeout. A command that
 * waits is not slow, it is a board nobody can write to.
 *
 * **It reads git's answers in one language.** `LC_ALL=C` keeps the messages the
 * code matches on ("rejected", "couldn't find remote ref") the ones it was
 * written against, whatever the machine's locale.
 *
 * Failure is a value, not an exception: `ok` is false and `stderr` says why.
 * What a failure *means* — offline, refused, nothing there yet — is the
 * caller's to decide, because the same exit code is fatal for a write and a
 * shrug for a read.
 */

export interface GitResult {
  ok: boolean;
  /** Exit code, or null when the process was killed (a timeout). */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  /** Talks to a remote: no prompts, a network timeout. */
  network?: boolean;
  /**
   * May ask a person (a credential manager window, a terminal prompt). Only
   * for a command a person typed at a terminal — `lpm git setup` checking a URL
   * for the first time — never for anything automatic.
   */
  interactive?: boolean;
  /** Written to stdin. */
  input?: string | Buffer;
  /** Extra environment, on top of the hardened one. */
  env?: Record<string, string>;
}

/** Overrides the network timeout, in milliseconds. */
export const GIT_TIMEOUT_ENV = 'LPM_GIT_TIMEOUT_MS';

const LOCAL_TIMEOUT_MS = 30_000;
const DEFAULT_NETWORK_TIMEOUT_MS = 60_000;

function networkTimeout(): number {
  const raw = Number(process.env[GIT_TIMEOUT_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_NETWORK_TIMEOUT_MS;
}

function environment(options: GitOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LC_ALL: 'C',
    LANG: 'C',
    // Every path handed to git by this layer is a file name, never a pattern.
    GIT_LITERAL_PATHSPECS: '1',
    ...options.env,
  };
  if (options.network && !options.interactive) {
    env.GIT_TERMINAL_PROMPT = '0';
    env.GCM_INTERACTIVE = 'never';
    if (!process.env.GIT_SSH_COMMAND && !process.env.GIT_SSH) {
      env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
    }
  }
  return env;
}

function timeoutOf(options: GitOptions): number {
  if (options.interactive) return 10 * 60_000;
  return options.network ? networkTimeout() : LOCAL_TIMEOUT_MS;
}

/** Run git in `cwd` and wait for it. */
export function git(cwd: string, args: string[], options: GitOptions = {}): GitResult {
  const result = spawnSync('git', args, {
    cwd,
    env: environment(options),
    input: options.input,
    encoding: 'utf8',
    timeout: timeoutOf(options),
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    // An interactive command keeps the terminal, so a credential prompt can
    // reach a person; everything else is a pipe nobody types into.
    stdio: [options.interactive ? 'inherit' : 'pipe', 'pipe', 'pipe'],
  });
  if (result.error) {
    const missing = (result.error as NodeJS.ErrnoException).code === 'ENOENT';
    return {
      ok: false,
      code: null,
      stdout: '',
      stderr: missing ? 'git is not installed or not on PATH' : result.error.message,
    };
  }
  return {
    ok: result.status === 0,
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: (result.stderr ?? '').trim(),
  };
}

/** Run git and return its stdout as bytes — for reading a file out of a commit. */
export function gitBytes(cwd: string, args: string[]): Buffer | null {
  const result = spawnSync('git', args, {
    cwd,
    env: environment({}),
    timeout: LOCAL_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return result.status === 0 ? (result.stdout as Buffer) : null;
}

/**
 * Run git without blocking the event loop. Only the server needs this — a fetch
 * behind the board poll must not freeze every other request while it waits on
 * the network.
 */
export function gitAsync(cwd: string, args: string[], options: GitOptions = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        env: environment(options),
        timeout: timeoutOf(options),
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
        resolve({ ok: !error, code, stdout: stdout ?? '', stderr: (stderr ?? '').trim() || (error?.message ?? '') });
      },
    );
  });
}

/** The first meaningful line of a git error, for a one-line message. */
export function firstLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^(fatal|error|remote):\s*/i, '').trim())
    .filter(Boolean);
  return lines[0] ?? 'git failed';
}
