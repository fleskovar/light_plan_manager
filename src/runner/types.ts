import type { FlagReason, Issue } from '../core/index.js';

/**
 * The vocabulary the queue runner speaks in.
 *
 * This file imports nothing but a couple of engine *types* (erased at compile
 * time), so the loop, the CLI command and the pi driver can all share it without
 * anyone dragging in the optional pi SDK. `pi.ts` is the only file that touches
 * the SDK, and the loop reaches it only through the injected `PiRunner`.
 */

/** How much of the agent's changes get committed, and when. */
export type CommitMode = 'none' | 'task' | 'parent';
export const COMMIT_MODES: readonly CommitMode[] = ['none', 'task', 'parent'];

/**
 * The agent's thinking budget, mirroring pi's `thinkingLevel`. Kept as a plain
 * union so nothing here depends on the SDK's own type.
 */
export type AgentEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const AGENT_EFFORTS: readonly AgentEffort[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/** One task handed to the agent for an isolated run. */
export interface RunRequest {
  /** The issue as the board holds it, once it has been claimed. */
  issue: Issue;
  /** The rendered working brief — `lpm instructions` for this issue. */
  brief: string;
  /** Where the agent works: the project root, where the code lives. */
  cwd: string;
  /** Where to report what the agent is doing, live. Optional: nothing depends on it. */
  emit?: RunEventSink;
}

/**
 * What stage of one task the loop is in. Everything except `running` is the
 * engine's own work — reading the board, writing the outcome back — and is over
 * in milliseconds; `running` is the agent, and is where a run spends its life.
 */
export type RunPhase =
  | 'picking'
  | 'claiming'
  | 'briefing'
  | 'running'
  | 'recording'
  | 'committing';

/**
 * What a run says about itself while it happens.
 *
 * The loop and the pi driver both emit these; a front end decides what to draw.
 * Nothing in the runner may read one back — this is a report, never a channel,
 * and a sink that throws must not be able to stop a run (`safeSink` wraps it).
 */
export type RunEvent =
  /** A task was picked up. `index` counts from 1 within this run. */
  | { type: 'task-start'; index: number; id: string; title: string }
  /** The loop moved on to another stage of the current task. */
  | { type: 'phase'; phase: RunPhase }
  /** Assistant prose, as it streams. Arrives in fragments, not lines. */
  | { type: 'agent-text'; text: string }
  /** Reasoning, as it streams, when the model exposes it. */
  | { type: 'agent-thinking'; text: string }
  /** The agent started a tool. `summary` is the argument worth reading. */
  | { type: 'tool-start'; name: string; summary: string }
  /** Output a running tool has produced so far, as a fragment. */
  | { type: 'tool-output'; text: string }
  | { type: 'tool-end'; name: string; ms: number | null; isError: boolean }
  /** The task is over, whichever way it went. */
  | { type: 'task-end'; id: string; completed: boolean; flagReason?: FlagReason; summary: string }
  /** Anything else worth a line: a commit, a vanished issue, a dry-run brief. */
  | { type: 'note'; text: string };

/** Where run events go. */
export type RunEventSink = (event: RunEvent) => void;

/**
 * A sink that cannot break the run it is reporting on. Drawing a frame is never
 * a reason to abandon a task the agent has already half-finished on disk.
 */
export function safeSink(sink: RunEventSink | undefined): RunEventSink {
  if (!sink) return () => {};
  return (event) => {
    try {
      sink(event);
    } catch {
      // A display fault is not a run fault.
    }
  };
}

/** One tool the agent called, in the order it called them. */
export interface ToolCall {
  name: string;
  /** Wall-clock milliseconds the call took, or null when it never ended. */
  ms: number | null;
  isError: boolean;
}

/** Token counts as pi reports them; null when the provider does not expose them. */
export interface TokenStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/** Everything worth keeping about one agent run, for QA and debugging. */
export interface RunStats {
  model: string | null;
  effort: string | null;
  /** Tools the agent used, in call order. Pi has no MCP, so none appear here. */
  tools: ToolCall[];
  /** Wall-clock milliseconds for the whole run. */
  wallMs: number;
  tokens: TokenStats | null;
  /** Money spent, in the provider's units, or null when unknown. */
  cost: number | null;
  sessionId?: string;
}

/**
 * What the agent reported back, plus how the run went. `completed` decides
 * whether the loop marks the issue done or flags it; the rest is the trail.
 */
export interface RunOutcome {
  completed: boolean;
  summary: string;
  /** Used when `completed` is false, to pick the flag reason. */
  reason?: FlagReason;
  details?: string;
  stats: RunStats;
  /** Set when the run itself failed (crash, timeout, or no result submitted). */
  error?: string;
}

/** The function the loop calls once per task. Injected, so the loop is SDK-free. */
export type PiRunner = (request: RunRequest) => Promise<RunOutcome>;

/**
 * How long one shell command may run before it is killed, in seconds.
 *
 * A cap rather than a preference: an unattended run has nobody to notice that a
 * command is never coming back, so the choice is between a task that fails with
 * a readable timeout and a queue that stops for ever. Five minutes is longer
 * than a test suite and shorter than a lunch break. `--command-timeout` moves
 * it; a command the agent gives its own timeout keeps that one.
 */
export const DEFAULT_COMMAND_TIMEOUT = 300;

/** Options a `lpm queue agent` config file may carry. Every key is optional. */
export interface AgentConfig {
  user?: string;
  maxTasks?: number;
  model?: string;
  effort?: AgentEffort;
  commit?: CommitMode;
  unassigned?: boolean;
  parked?: boolean;
  /** Per-task wall-clock cap, in seconds. */
  timeout?: number;
  /**
   * Per-*command* wall-clock cap, in seconds, for anything the agent runs in
   * the shell. Defaults to `DEFAULT_COMMAND_TIMEOUT`; the backstop for a
   * command that waits for somebody who is not there.
   */
  commandTimeout?: number;
  /** Restrict the agent to these pi tool names (default: read, bash, edit, write). */
  tools?: string[];
  /** Path to a pi `auth.json`, when not relying on environment API keys. */
  authPath?: string;
}

/** What one task turned into, for the end-of-run report. */
export interface RunStep {
  id: string;
  title: string;
  completed: boolean;
  flagReason?: FlagReason;
  /** The commit this task produced, if any. */
  committed: string | null;
  /** Board-relative path to the run artifact, if one was written. */
  artifact: string | null;
  error?: string;
}

/** The result of a whole `lpm queue agent` run. */
export interface RunReport {
  steps: RunStep[];
  /**
   * Why the loop ended. `contended` is the shared-checkout case: every task the
   * queue offered was claimed by somebody else before this run could take it,
   * several times running, so it stopped rather than spinning. It is not a
   * failure — the work is being done, by whoever won.
   */
  stopped: 'empty' | 'max-tasks' | 'dry-run' | 'contended';
  /**
   * Work this resource already had in flight when the queue ran out, read off
   * the same board handle that produced the empty queue.
   *
   * The queue never re-offers work somebody has picked up, and never offers
   * flagged work at all, so "nothing to pick up" is the truth *and* looks like a
   * fault when the person is holding three stalled issues. This is the run
   * saying which it was. It is reporting only — nothing here decides what may be
   * picked up.
   */
  held: HeldTask[];
}

/** An issue the resource was already holding when the run ended. */
export interface HeldTask {
  id: string;
  title: string;
  /** The flag on it, or null when it is merely in progress. */
  flag: string | null;
}
