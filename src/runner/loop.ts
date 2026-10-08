import type { BoardPaths, Issue, LoadedBoard, ResolvedScope, TaskOptions } from '../core/index.js';
import {
  BoardError,
  ConflictError,
  DocumentCache,
  addComment,
  claimIssue,
  currentTasks,
  findIssue,
  flagIssue,
  instructionsFor,
  isTerminalStatus,
  loadBoard,
  moveNode,
  nextTasks,
  pullBoard,
  resumableTasks,
  startStatusId,
  subtreeOf,
  terminalStatusId,
  workUnits,
} from '../core/index.js';
import type { GitDriver } from './git.js';
import { formatRunComment, writeRunArtifact } from './stats.js';
import { safeSink } from './types.js';
import type {
  CommitMode,
  HeldTask,
  PiRunner,
  RunEventSink,
  RunOutcome,
  RunReport,
  RunStep,
} from './types.js';

/**
 * The development loop behind `lpm queue agent`.
 *
 * It is `simulateQueue` with the pretend taken out: instead of an in-memory
 * overlay it writes to disk and reloads between steps (the push-session
 * rationale — core operations make every handle stale the moment they run). It
 * owns *orchestration* only. What may be picked up is still the engine's
 * decision — `nextTasks` for new work, `resumableTasks` for work a previous run
 * already claimed — so the agent works the same queue `lpm task next` offers and
 * the same sequence `lpm queue simulate` predicts; the pi run arrives as an
 * injected `PiRunner`, so this file never imports the SDK and its tests drive it
 * with a fake.
 */

/** Who wrote the comments and flags a run leaves behind. */
export const AGENT_AUTHOR = 'pi (agent)';

/**
 * How many claims in a row may be lost to other writers before the run stops.
 *
 * Losing one is ordinary on a busy checkout — the queue moved, ask again. A
 * long unbroken streak is not: it means something is claiming everything this
 * run is offered as fast as it can pick, and a loop that never gave up would
 * spin on it without doing any work or reporting why.
 */
const MAX_LOST_RACES = 5;

export interface LoopOptions {
  /** Stop after this many tasks. `Infinity` for unbounded. */
  maxTasks: number;
  includeUnassigned: boolean;
  includeParked: boolean;
  commit: CommitMode;
  /** Pick and brief the next task, but run nothing and write nothing. */
  dryRun: boolean;
  scope: ResolvedScope | null;
  /** Fixed "today", so a test can say what day it is. */
  today?: string;
}

export interface LoopDeps {
  /** Runs one task. Required unless `dryRun` is set. */
  runner?: PiRunner;
  git: GitDriver;
  /** Timestamp source for artifacts, injectable for tests. */
  now?: () => string;
  /**
   * Where the run reports what it is doing, as it does it. The loop emits its
   * own stages and passes the same sink to the runner, so the agent's stream
   * and the board's bookkeeping arrive on one channel in the order they
   * happened. Optional, and never read back: what a front end draws is not the
   * loop's business, and a display that throws cannot stop a task.
   */
  emit?: RunEventSink;
}

/** Every work unit under `parentId` is finished — the feature is complete. */
function parentComplete(board: LoadedBoard, parentId: string): boolean {
  const parent = findIssue(board, parentId);
  if (!parent) return false;
  const units = new Set(workUnits(board).map((issue) => issue.id));
  const inside = subtreeOf(board.issues, parent).filter(
    (issue) => issue.id !== parent.id && units.has(issue.id),
  );
  return inside.length > 0 && inside.every((issue) => isTerminalStatus(board.config, issue.status));
}

/** The commit a finished task should produce, given the mode. */
function commitFor(
  board: LoadedBoard,
  paths: BoardPaths,
  issue: Issue,
  mode: CommitMode,
  git: GitDriver,
): string | null {
  if (mode === 'none') return null;
  if (mode === 'task') return git.commitAll(paths.root, `${issue.id}: ${issue.title}`);

  // 'parent': a work unit with no parent is its own feature, so commit it like a
  // task; otherwise hold until every sibling under the parent is done.
  const parentId = issue.parentId;
  if (!parentId) return git.commitAll(paths.root, `${issue.id}: ${issue.title}`);
  if (!parentComplete(board, parentId)) return null;
  const parent = findIssue(board, parentId);
  const title = parent ? parent.title : parentId;
  return git.commitAll(paths.root, `${parentId}: complete ${title}`);
}

/** The outcome to record when the run itself failed rather than reporting. */
function failure(message: string): RunOutcome {
  return {
    completed: false,
    summary: `The agent run did not finish: ${message}`,
    reason: 'help',
    error: message,
    stats: { model: null, effort: null, tools: [], wallMs: 0, tokens: null, cost: null },
  };
}

export async function runAgentQueue(
  paths: BoardPaths,
  resourceId: string,
  options: LoopOptions,
  deps: LoopDeps,
): Promise<RunReport> {
  const cache = new DocumentCache();
  // On a board shared through git, every look at the queue starts from the
  // remote's latest, so two runners on two machines do not pick the same task.
  // Throttled because the loop reloads after every write it makes, and each of
  // those writes has just pushed. Best effort: a stale pick is still refused at
  // the claim, which the loop already answers by asking the queue again.
  const reload = (): LoadedBoard => {
    try {
      pullBoard(paths, { maxAgeMs: 10_000 });
    } catch {
      // Reported by the write that runs into it.
    }
    return loadBoard(paths, { cache });
  };
  const emit = safeSink(deps.emit);

  let board = reload();
  const startStatus = startStatusId(board.config);
  const terminalStatus = terminalStatusId(board.config);
  if (!startStatus) {
    throw new BoardError('This board has no in-progress status to move work into', [
      'Declare a status with `active: true` in .lpm/config.yml.',
    ]);
  }
  if (!terminalStatus) {
    throw new BoardError('This board has no end state to move finished work into', [
      'Declare a status with `terminal: true` in .lpm/config.yml.',
    ]);
  }
  if (!options.dryRun && !deps.runner) {
    throw new BoardError('No agent runner was provided');
  }

  const steps: RunStep[] = [];
  let focusParent: string | null = null;
  let stopped: RunReport['stopped'] = 'empty';
  let held: HeldTask[] = [];
  /** Claims lost in a row to somebody else on this checkout. */
  let lost = 0;

  while (steps.length < options.maxTasks) {
    board = reload();
    emit({ type: 'phase', phase: 'picking' });
    const ranking: TaskOptions = { focusParent, today: options.today };
    // What this person is already holding comes first. The queue never offers
    // work in an active status — it has been picked up — so a loop that only
    // asked `nextTasks` could never return to a task a previous run claimed and
    // did not finish, and everything waiting on that task stayed blocked for
    // ever. `resumableTasks` is the engine's rule for that, and the same call
    // `simulateQueue` seeds with, so the prediction and the run agree; it stops
    // at a flag, which is what keeps a stalled task from being retried forever.
    const top =
      resumableTasks(board, resourceId, ranking)[0] ??
      nextTasks(board, resourceId, {
        ...ranking,
        includeUnassigned: options.includeUnassigned,
        includeParked: options.includeParked,
        scope: options.scope,
        limit: 1,
      })[0];
    if (!top) {
      // Nothing on offer. Say what this resource is already holding, read off
      // the very handle that produced the empty queue — "nothing to pick up" and
      // "three issues of yours are flagged" are the same board, and only the
      // second one tells anybody what to do about it.
      held = currentTasks(board, resourceId).map((issue) => ({
        id: issue.id,
        title: issue.title,
        flag: issue.flag,
      }));
      break;
    }

    const issue = top.issue;

    if (options.dryRun) {
      const brief = instructionsFor(board, issue.id, { includeComments: true }).text;
      emit({ type: 'task-start', index: 1, id: issue.id, title: issue.title });
      emit({ type: 'note', text: brief });
      steps.push({ id: issue.id, title: issue.title, completed: false, committed: null, artifact: null });
      stopped = 'dry-run';
      break;
    }

    emit({ type: 'task-start', index: steps.length + 1, id: issue.id, title: issue.title });
    emit({ type: 'phase', phase: 'claiming' });
    // Claim it before running, so a crash leaves a visible in-progress trail
    // rather than silently losing the pick. The claim is a test-and-set and can
    // legitimately fail: another agent or a person on this checkout may have
    // taken this issue between the reload above and now. That is not a run
    // failure and it must not be recorded against the issue — the queue simply
    // moved on, so this run asks it again. Only a bounded number of times: a
    // loop that kept re-picking would spin against a board being edited fast
    // enough to always beat it.
    try {
      claimIssue(board, issue, { assignee: resourceId, status: startStatus });
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      emit({ type: 'note', text: `${issue.id} was taken by somebody else; picking again` });
      lost += 1;
      if (lost > MAX_LOST_RACES) {
        stopped = 'contended';
        break;
      }
      continue;
    }
    lost = 0;

    board = reload();
    emit({ type: 'phase', phase: 'briefing' });
    const brief = instructionsFor(board, issue.id, { includeComments: true }).text;

    let outcome: RunOutcome;
    emit({ type: 'phase', phase: 'running' });
    try {
      outcome = await deps.runner!({
        issue: findIssue(board, issue.id) ?? issue,
        brief,
        cwd: paths.root,
        emit: deps.emit,
      });
    } catch (error) {
      outcome = failure((error as Error).message);
    }

    board = reload();
    emit({ type: 'phase', phase: 'recording' });
    const target = findIssue(board, issue.id);
    if (!target) {
      // The issue vanished mid-run (deleted on disk). Record it and move on.
      emit({ type: 'note', text: `${issue.id} is gone; skipping` });
      emit({ type: 'task-end', id: issue.id, completed: false, summary: 'issue no longer on the board' });
      steps.push({
        id: issue.id,
        title: issue.title,
        completed: false,
        committed: null,
        artifact: null,
        error: 'issue no longer on the board',
      });
      focusParent = issue.parentId;
      continue;
    }

    if (outcome.completed) {
      moveNode(board, target, { status: terminalStatus });
      emit({ type: 'task-end', id: issue.id, completed: true, summary: outcome.summary });
    } else {
      const reason = outcome.reason ?? 'help';
      flagIssue(board, target, { reason, comment: outcome.summary, author: AGENT_AUTHOR });
      emit({ type: 'task-end', id: issue.id, completed: false, flagReason: reason, summary: outcome.summary });
    }

    const artifact = writeRunArtifact(paths, issue.id, outcome, deps.now?.());
    board = reload();
    addComment(board, issue.id, {
      body: formatRunComment(outcome, artifact),
      author: AGENT_AUTHOR,
    });

    let committed: string | null = null;
    if (outcome.completed && options.commit !== 'none') {
      emit({ type: 'phase', phase: 'committing' });
      board = reload();
      const done = findIssue(board, issue.id);
      committed = done ? commitFor(board, paths, done, options.commit, deps.git) : null;
      if (committed) emit({ type: 'note', text: `committed ${committed}` });
    }

    steps.push({
      id: issue.id,
      title: issue.title,
      completed: outcome.completed,
      ...(outcome.completed ? {} : { flagReason: outcome.reason ?? 'help' }),
      committed,
      artifact,
      ...(outcome.error ? { error: outcome.error } : {}),
    });
    focusParent = target.parentId;

    if (steps.length >= options.maxTasks) {
      stopped = 'max-tasks';
      break;
    }
  }

  return { steps, stopped, held };
}
