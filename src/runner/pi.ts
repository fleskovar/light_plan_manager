import { BoardError } from '../core/index.js';
import { NON_INTERACTIVE_ENV, blockedCommand, refusalFor } from './shell.js';
import { DEFAULT_COMMAND_TIMEOUT, safeSink } from './types.js';
import type { PiRunner, RunEventSink, RunOutcome, RunStats, ToolCall } from './types.js';

/**
 * The one file that talks to the pi coding agent SDK.
 *
 * The SDK is an optional *peer* dependency — never installed with light-plan,
 * because the agent is experimental — and it needs a newer Node than the engine
 * does, so it cannot be assumed present at build time. It is therefore loaded
 * through a computed specifier — `tsc` does not resolve a non-literal `import()`,
 * so the whole project still compiles on a machine that has never installed pi —
 * and reached only through a typed facade of the slice we use. Nothing else in
 * the codebase imports this file's SDK types; the loop takes a `PiRunner` and
 * never knows pi exists.
 *
 * `createPiRunner` loads the SDK once (failing fast with a readable message when
 * it is missing) and returns a runner that opens a *fresh* in-memory session per
 * task, so every task starts with an empty context.
 *
 * Two things here are about a run that nobody is watching, and both belong in
 * this file because both are pi's shell. **The bash tool is replaced** with one
 * of our own (`hardenedBash`): a custom tool of the same name wins over the
 * built-in, which is how the non-interactive environment, the guard in
 * `shell.ts` and a per-command timeout reach every command the agent runs.
 * **Session events are forwarded** as `RunEvent`s, so a front end can show what
 * the agent is doing without knowing that pi exists either.
 */

/** The pi options a run is bound to. */
export interface PiRunnerOptions {
  /** `provider:model`, e.g. `anthropic:claude-opus-4-5`. Omit for pi's default. */
  model?: string;
  effort?: string;
  /** Per-task wall-clock cap, in milliseconds. */
  timeoutMs?: number;
  /** Per-command wall-clock cap, in seconds. Default `DEFAULT_COMMAND_TIMEOUT`. */
  commandTimeout?: number;
  /** Restrict the agent to these tool names (plus the result tool). */
  tools?: string[];
  authPath?: string;
}

// --- The facade: only what we call, typed loosely over the real SDK. ---

interface PiSession {
  subscribe(listener: (event: PiEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  getSessionStats(): PiSessionStats;
  getLastAssistantText(): string | undefined;
  abort(): Promise<void>;
  dispose(): void;
}

interface PiEvent {
  type: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  args?: Record<string, unknown>;
  partialResult?: unknown;
  assistantMessageEvent?: { type: string; delta?: string };
}

/** What pi hands a bash spawn hook, and what it takes back. */
interface BashSpawnContext {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** The exec slice of pi's `BashOperations`. */
interface BashOperations {
  exec(
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ): Promise<{ exitCode: number | null }>;
}

interface PiSessionStats {
  sessionId: string;
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost?: number;
}

interface PiModelRuntime {
  getModel(provider: string, id: string): unknown;
}

interface PiSdk {
  createAgentSession(options: Record<string, unknown>): Promise<{ session: PiSession }>;
  SessionManager: { inMemory(cwd?: string): unknown };
  ModelRuntime: { create(options?: Record<string, unknown>): Promise<PiModelRuntime> };
  defineTool(tool: Record<string, unknown>): unknown;
  /** Both optional: an older pi has no shell to harden, and we fall back to its own. */
  createLocalBashOperations?(options?: Record<string, unknown>): BashOperations;
  createBashToolDefinition?(cwd: string, options?: Record<string, unknown>): { name: string };
}

interface PiAi {
  Type: {
    Object(props: Record<string, unknown>): unknown;
    Boolean(opts?: Record<string, unknown>): unknown;
    String(opts?: Record<string, unknown>): unknown;
    Optional(schema: unknown): unknown;
    Union(schemas: unknown[], opts?: Record<string, unknown>): unknown;
    Literal(value: string): unknown;
  };
}

/** What the agent hands back through the `submit_result` tool. */
interface SubmittedResult {
  completed: boolean;
  summary: string;
  reason?: 'blocked' | 'paused' | 'help';
  details?: string;
}

// Non-literal specifiers so `tsc` does not require the packages to be installed.
const AGENT_PACKAGE: string = '@earendil-works/pi-coding-agent';
const AI_PACKAGE: string = '@earendil-works/pi-ai';

async function loadSdk(): Promise<{ sdk: PiSdk; ai: PiAi }> {
  try {
    const sdk = (await import(AGENT_PACKAGE)) as unknown as PiSdk;
    const ai = (await import(AI_PACKAGE)) as unknown as PiAi;
    return { sdk, ai };
  } catch (error) {
    throw new BoardError('The pi coding agent is not available', [
      'The agent is experimental, so its packages are not installed with light-plan.',
      'Install them beside light-plan (add -g if light-plan is installed globally):',
      '  npm install @earendil-works/pi-coding-agent @earendil-works/pi-ai',
      'They require Node 22.19 or newer.',
      (error as Error).message,
    ]);
  }
}

/**
 * The bash tool an unattended run gets, or null when this pi is too old to
 * build one — in which case the built-in tool is used and only the environment
 * (see `hardenEnvironment`) protects the run.
 *
 * A custom tool replaces a built-in of the same name in pi's registry, so this
 * *is* `bash` as far as the agent is concerned. Three things are added, in
 * order of how much they save: a per-command timeout, so nothing runs for ever;
 * the non-interactive environment, so pagers and editors do not wait; and the
 * refusal in `shell.ts`, for the commands no variable can talk out of opening a
 * window.
 */
function hardenedBash(sdk: PiSdk, cwd: string, timeout: number): unknown | null {
  if (!sdk.createBashToolDefinition || !sdk.createLocalBashOperations) return null;
  const local = sdk.createLocalBashOperations();
  const operations: BashOperations = {
    // The agent may ask for its own timeout on a command it knows is slow; this
    // only fills one in when it did not, so the cap is a floor under carelessness
    // rather than a ceiling over judgement.
    exec: (command, at, opts) => local.exec(command, at, { ...opts, timeout: opts.timeout ?? timeout }),
  };
  return sdk.createBashToolDefinition(cwd, {
    operations,
    spawnHook: (context: BashSpawnContext): BashSpawnContext => {
      const reason = blockedCommand(context.command);
      return {
        cwd: context.cwd,
        env: { ...context.env, ...NON_INTERACTIVE_ENV },
        command: reason ? refusalFor(reason) : context.command,
      };
    },
  });
}

/**
 * Put the non-interactive settings on this process too.
 *
 * Belt and braces: pi builds a child's environment from `process.env`, so this
 * covers the built-in bash tool when `hardenedBash` could not be built, and any
 * other process a run starts. It is set once, on a command that exists to run
 * an agent, and never unset — `lpm queue agent` does nothing else afterwards.
 */
function hardenEnvironment(): void {
  Object.assign(process.env, NON_INTERACTIVE_ENV);
}

/** The argument of a tool call worth putting on one line of a display. */
function summarize(name: string, args: Record<string, unknown> | undefined): string {
  if (!args) return '';
  const first = (...keys: string[]): string => {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  };
  const text =
    name === 'bash'
      ? first('command')
      : first('command', 'path', 'file', 'file_path', 'pattern', 'query', 'summary');
  return text.split('\n')[0] ?? '';
}

/** The text of a tool result, whatever shape pi wrapped it in. */
function resultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return '';
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part && typeof part === 'object' ? String((part as { text?: unknown }).text ?? '') : ''))
    .join('');
}

/** Split `provider:model` (or `provider/model`) into its two parts. */
function splitModel(spec: string): [string, string] {
  const at = spec.search(/[:/]/);
  if (at <= 0 || at >= spec.length - 1) {
    throw new BoardError(`Invalid --model "${spec}"`, [
      'Write it as provider:model, e.g. anthropic:claude-opus-4-5.',
    ]);
  }
  return [spec.slice(0, at), spec.slice(at + 1)];
}

export async function createPiRunner(options: PiRunnerOptions): Promise<PiRunner> {
  const { sdk, ai } = await loadSdk();
  hardenEnvironment();
  const commandTimeout = options.commandTimeout ?? DEFAULT_COMMAND_TIMEOUT;
  const runtime = await sdk.ModelRuntime.create(
    options.authPath ? { authPath: options.authPath } : {},
  );

  let model: unknown;
  if (options.model) {
    const [provider, id] = splitModel(options.model);
    model = runtime.getModel(provider, id);
    if (!model) {
      throw new BoardError(`Unknown model "${options.model}"`, [
        'Check the provider and id, and that its API key is configured.',
      ]);
    }
  }

  return async (request) => {
    const started = Date.now();
    const tools: ToolCall[] = [];
    const startedAt = new Map<string, number>();
    const index = new Map<string, number>();
    const reported = new Map<string, number>();
    const emit: RunEventSink = safeSink(request.emit);
    let submitted: SubmittedResult | null = null;

    const submitTool = sdk.defineTool({
      name: 'submit_result',
      label: 'Submit result',
      description:
        'Report the outcome of this task and end the run. Call this exactly once, ' +
        'when you are done or when you cannot proceed. Set completed=true only if ' +
        'the task is fully finished; otherwise set completed=false and give a reason.',
      parameters: ai.Type.Object({
        completed: ai.Type.Boolean({ description: 'True only if the task is fully done.' }),
        summary: ai.Type.String({ description: 'What you did, or why you stopped.' }),
        reason: ai.Type.Optional(
          ai.Type.Union(
            [ai.Type.Literal('blocked'), ai.Type.Literal('paused'), ai.Type.Literal('help')],
            { description: 'When not completed: why. blocked | paused | help.' },
          ),
        ),
        details: ai.Type.Optional(ai.Type.String({ description: 'Optional longer notes.' })),
      }),
      execute: async (_toolCallId: string, params: SubmittedResult) => {
        submitted = params;
        return { content: [{ type: 'text', text: 'Result recorded. You may stop now.' }], details: {} };
      },
    });

    const bashTool = hardenedBash(sdk, request.cwd, commandTimeout);
    const sessionOptions: Record<string, unknown> = {
      cwd: request.cwd,
      modelRuntime: runtime,
      customTools: bashTool ? [submitTool, bashTool] : [submitTool],
      sessionManager: sdk.SessionManager.inMemory(request.cwd),
    };
    if (model) sessionOptions.model = model;
    if (options.effort) sessionOptions.thinkingLevel = options.effort;
    // An allowlist replaces the defaults, so keep the result tool reachable.
    if (options.tools) sessionOptions.tools = [...options.tools, 'submit_result'];

    const { session } = await sdk.createAgentSession(sessionOptions);

    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'message_update') {
        // The one place a run says what it is *thinking*: text arrives in
        // fragments, and the display is what decides how to break them up.
        const delta = event.assistantMessageEvent?.delta;
        if (!delta) return;
        if (event.assistantMessageEvent?.type === 'text_delta') emit({ type: 'agent-text', text: delta });
        else if (event.assistantMessageEvent?.type === 'thinking_delta') {
          emit({ type: 'agent-thinking', text: delta });
        }
      } else if (event.type === 'tool_execution_start' && event.toolCallId) {
        startedAt.set(event.toolCallId, Date.now());
        index.set(event.toolCallId, tools.length);
        const name = event.toolName ?? 'unknown';
        tools.push({ name, ms: null, isError: false });
        emit({ type: 'tool-start', name, summary: summarize(name, event.args) });
      } else if (event.type === 'tool_execution_update' && event.toolCallId) {
        // pi reports a running tool's output as a growing snapshot; only the
        // part nobody has seen is news.
        const text = resultText(event.partialResult);
        const seen = reported.get(event.toolCallId) ?? 0;
        if (text.length > seen) {
          reported.set(event.toolCallId, text.length);
          emit({ type: 'tool-output', text: text.slice(seen) });
        }
      } else if (event.type === 'tool_execution_end' && event.toolCallId) {
        const at = index.get(event.toolCallId);
        if (at !== undefined) {
          const begin = startedAt.get(event.toolCallId);
          tools[at] = {
            name: tools[at]!.name,
            ms: begin === undefined ? null : Date.now() - begin,
            isError: Boolean(event.isError),
          };
          emit({ type: 'tool-end', name: tools[at]!.name, ms: tools[at]!.ms, isError: tools[at]!.isError });
        }
      }
    });

    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    try {
      // The shell refuses what would stop the run, but a refused command is a
      // wasted turn: saying so up front is cheaper than letting the agent find
      // out. Both halves are here because both are about *this* kind of run.
      const brief =
        `${request.brief}\n\n---\n\n` +
        'Nobody is watching this run. Every command must finish on its own: no ' +
        'pagers, no editors, no `start`/`open`/`code`, no watch modes or servers ' +
        `that stay up (a command is killed after ${commandTimeout}s). Read files ` +
        'with the read tool, and run tests once rather than in watch mode.\n\n' +
        'When you have finished this task, or if you cannot, call the ' +
        '`submit_result` tool with your outcome. Do not stop without calling it.';

      const run = session.prompt(brief);
      if (options.timeoutMs && options.timeoutMs > 0) {
        await Promise.race([
          run,
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              timedOut = true;
              void session.abort().finally(resolve);
            }, options.timeoutMs);
          }),
        ]);
      } else {
        await run;
      }
    } finally {
      if (timer) clearTimeout(timer);
      unsubscribe();
    }

    const raw = session.getSessionStats();
    const stats: RunStats = {
      model: options.model ?? null,
      effort: options.effort ?? null,
      tools,
      wallMs: Date.now() - started,
      tokens: raw.tokens ?? null,
      cost: raw.cost ?? null,
      sessionId: raw.sessionId,
    };
    const lastText = session.getLastAssistantText();
    session.dispose();

    if (submitted) {
      const result = submitted as SubmittedResult;
      const outcome: RunOutcome = {
        completed: result.completed,
        summary: result.summary,
        stats,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.details ? { details: result.details } : {}),
      };
      return outcome;
    }

    // No result submitted: a timeout, a crash, or the agent simply stopping.
    const why = timedOut
      ? `timed out after ${Math.round((options.timeoutMs ?? 0) / 1000)}s`
      : 'the agent ended without submitting a result';
    return {
      completed: false,
      summary: lastText?.trim() || why,
      reason: 'help',
      error: why,
      stats,
    };
  };
}
