import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { BoardPaths, Issue, NewIssueInput } from '../src/core/index.js';
import {
  clearFlag,
  createIssue,
  createResource,
  findIssue,
  flagIssue,
  linkIssue,
  listComments,
  moveNode,
  simulateQueue,
} from '../src/core/index.js';
import { runAgentQueue } from '../src/runner/index.js';
import type { GitDriver, LoopOptions, PiRunner, RunEvent, RunOutcome } from '../src/runner/index.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterAll(cleanupBoards);

const TODAY = '2026-08-10';
const AT = '2026-08-10T00:00:00.000Z';

const STATS = { model: null, effort: null, tools: [], wallMs: 1, tokens: null, cost: null };

/** Alice (RS-1) and a feature (LP-3) to hang stories off. */
function seed(): BoardPaths {
  const paths = makeBoard('scrum', 'LP');
  createResource(reload(paths), { type: 'person', title: 'Alice Smith' });
  createIssue(reload(paths), { type: 'program', title: 'Payments' });
  createIssue(reload(paths), { type: 'epic', title: 'Checkout', parentId: 'LP-1' });
  createIssue(reload(paths), { type: 'feature', title: 'Guest flow', parentId: 'LP-2' });
  return paths;
}

function story(paths: BoardPaths, title: string, input: Partial<NewIssueInput> = {}): Issue {
  return createIssue(reload(paths), { type: 'user_story', title, parentId: 'LP-3', ...input });
}

function opts(over: Partial<LoopOptions> = {}): LoopOptions {
  return {
    maxTasks: Infinity,
    includeUnassigned: false,
    includeParked: false,
    commit: 'none',
    dryRun: false,
    scope: null,
    today: TODAY,
    ...over,
  };
}

/** A runner that returns a scripted outcome per issue id, and records call order. */
function scriptedRunner(script: Record<string, Partial<RunOutcome>> = {}): {
  runner: PiRunner;
  seen: string[];
} {
  const seen: string[] = [];
  const runner: PiRunner = async (request) => {
    seen.push(request.issue.id);
    const scripted = script[request.issue.id] ?? {};
    return {
      completed: scripted.completed ?? true,
      summary: scripted.summary ?? 'work done',
      stats: STATS,
      ...(scripted.reason ? { reason: scripted.reason } : {}),
      ...(scripted.details ? { details: scripted.details } : {}),
    };
  };
  return { runner, seen };
}

/** A runner that throws, to prove a crash is caught and flagged. */
const throwingRunner: PiRunner = async () => {
  throw new Error('agent crashed');
};

function fakeGit(): GitDriver & { commits: { cwd: string; message: string }[] } {
  const commits: { cwd: string; message: string }[] = [];
  return {
    commits,
    hasChanges: () => true,
    commitAll(cwd, message) {
      commits.push({ cwd, message });
      return `sha${commits.length}`;
    },
  };
}

describe('the queue agent loop', () => {
  it('claims a task, marks it done, and leaves a comment and artifact', async () => {
    const paths = seed();
    story(paths, 'One', { assignee: 'RS-1' });

    const { runner, seen } = scriptedRunner({ 'LP-4': { completed: true, summary: 'implemented it' } });
    const git = fakeGit();
    const report = await runAgentQueue(paths, 'RS-1', opts(), { runner, git, now: () => AT });

    expect(seen).toEqual(['LP-4']);
    expect(report.stopped).toBe('empty');
    expect(report.steps).toHaveLength(1);
    expect(report.steps[0]!.completed).toBe(true);

    const board = reload(paths);
    const issue = findIssue(board, 'LP-4')!;
    expect(issue.status).toBe('done');
    expect(issue.assignee).toBe('RS-1');

    const comments = listComments(board, 'LP-4');
    expect(comments.some((comment) => comment.body.includes('completed'))).toBe(true);
    expect(comments.some((comment) => comment.body.includes('implemented it'))).toBe(true);

    const artifact = report.steps[0]!.artifact!;
    expect(artifact).toContain('.lpm/runs/LP-4/');
    expect(existsSync(path.join(paths.root, artifact))).toBe(true);
  });

  it('flags a task the agent could not finish, and never re-offers it', async () => {
    const paths = seed();
    story(paths, 'One', { assignee: 'RS-1' });

    const { runner, seen } = scriptedRunner({
      'LP-4': { completed: false, summary: 'blocked on missing API', reason: 'blocked' },
    });
    const report = await runAgentQueue(paths, 'RS-1', opts(), { runner, git: fakeGit(), now: () => AT });

    expect(seen).toEqual(['LP-4']); // offered exactly once, not retried
    expect(report.steps[0]!.completed).toBe(false);
    expect(report.steps[0]!.flagReason).toBe('blocked');

    const issue = findIssue(reload(paths), 'LP-4')!;
    expect(issue.flag).toBe('blocked');
    expect(issue.status).toBe('in_progress'); // claimed, then flagged in place

    // And the run says why it ran out. "Nothing to pick up" from a board full of
    // this person's stalled work is the truth and looks like a fault.
    expect(report.held).toEqual([
      { id: 'LP-4', title: 'One', flag: 'blocked' },
    ]);
  });

  it('reports what the resource is holding when the queue is empty', async () => {
    const paths = seed();
    story(paths, 'Stopped', { assignee: 'RS-1', status: 'in_progress' });
    story(paths, 'Waiting on it', { assignee: 'RS-1' });
    linkIssue(reload(paths), findIssue(reload(paths), 'LP-5')!, { dependsOn: ['LP-4'] });
    flagIssue(reload(paths), findIssue(reload(paths), 'LP-4')!, {
      reason: 'help',
      comment: 'needs a decision',
    });

    const { runner, seen } = scriptedRunner();
    const report = await runAgentQueue(paths, 'RS-1', opts(), { runner, git: fakeGit(), now: () => AT });

    expect(seen).toEqual([]);
    expect(report.steps).toEqual([]);
    expect(report.stopped).toBe('empty');
    expect(report.held).toEqual([{ id: 'LP-4', title: 'Stopped', flag: 'help' }]);
  });

  it('holds nothing back to report when the board is simply empty', async () => {
    const paths = seed();
    const { runner } = scriptedRunner();
    const report = await runAgentQueue(paths, 'RS-1', opts(), { runner, git: fakeGit(), now: () => AT });

    expect(report.steps).toEqual([]);
    expect(report.held).toEqual([]);
  });

  it('flags with help when the runner throws', async () => {
    const paths = seed();
    story(paths, 'One', { assignee: 'RS-1' });

    const report = await runAgentQueue(paths, 'RS-1', opts(), {
      runner: throwingRunner,
      git: fakeGit(),
      now: () => AT,
    });

    expect(report.steps[0]!.completed).toBe(false);
    expect(report.steps[0]!.flagReason).toBe('help');
    expect(report.steps[0]!.error).toContain('agent crashed');
    expect(findIssue(reload(paths), 'LP-4')!.flag).toBe('help');
  });

  it('stops at max-tasks with work still on the board', async () => {
    const paths = seed();
    story(paths, 'One', { assignee: 'RS-1' });
    story(paths, 'Two', { assignee: 'RS-1' });
    story(paths, 'Three', { assignee: 'RS-1' });

    const { runner } = scriptedRunner();
    const report = await runAgentQueue(paths, 'RS-1', opts({ maxTasks: 2 }), {
      runner,
      git: fakeGit(),
      now: () => AT,
    });

    expect(report.steps.map((step) => step.id)).toEqual(['LP-4', 'LP-5']);
    expect(report.stopped).toBe('max-tasks');
  });

  it('finishes all work under one parent before starting another', async () => {
    const paths = seed();
    // A second feature under the same epic, with its own story between two of LP-3's.
    createIssue(reload(paths), { type: 'feature', title: 'Other flow', parentId: 'LP-2' }); // LP-4
    story(paths, 'A1', { assignee: 'RS-1' }); // LP-5, under LP-3
    createIssue(reload(paths), { type: 'user_story', title: 'B1', parentId: 'LP-4', assignee: 'RS-1' }); // LP-6, under LP-4
    story(paths, 'A2', { assignee: 'RS-1' }); // LP-7, under LP-3

    const { runner, seen } = scriptedRunner();
    await runAgentQueue(paths, 'RS-1', opts(), { runner, git: fakeGit(), now: () => AT });

    // Cohesion: after LP-5 (under LP-3), the loop prefers LP-3's other story
    // (LP-7) over the other feature's (LP-6). Without it the order would be
    // LP-5, LP-6, LP-7 by issue number.
    expect(seen).toEqual(['LP-5', 'LP-7', 'LP-6']);
  });

  it('commits after each finished task in task mode', async () => {
    const paths = seed();
    story(paths, 'One', { assignee: 'RS-1' });
    story(paths, 'Two', { assignee: 'RS-1' });

    const { runner } = scriptedRunner();
    const git = fakeGit();
    const report = await runAgentQueue(paths, 'RS-1', opts({ commit: 'task' }), {
      runner,
      git,
      now: () => AT,
    });

    expect(git.commits).toHaveLength(2);
    expect(git.commits[0]!.message).toContain('LP-4');
    expect(git.commits[0]!.cwd).toBe(paths.root);
    expect(report.steps.every((step) => step.committed)).toBe(true);
  });

  it('commits once a parent is complete in parent mode', async () => {
    const paths = seed();
    story(paths, 'One', { assignee: 'RS-1' }); // LP-4, under LP-3
    story(paths, 'Two', { assignee: 'RS-1' }); // LP-5, under LP-3

    const { runner } = scriptedRunner();
    const git = fakeGit();
    await runAgentQueue(paths, 'RS-1', opts({ commit: 'parent' }), { runner, git, now: () => AT });

    // Nothing after the first task (LP-3 still has LP-5 open); one commit after
    // the second, naming the parent.
    expect(git.commits).toHaveLength(1);
    expect(git.commits[0]!.message).toContain('LP-3');
    expect(git.commits[0]!.message).toContain('complete');
  });

  // A run that claims a task and does not finish it — a crash, a timeout, an
  // operator pressing Ctrl-C — leaves that task in progress. The queue does not
  // offer work in an active status, so a loop that only ever asked `nextTasks`
  // could never come back to it, and everything waiting on it was blocked for
  // ever: one interrupted run dammed the whole board.
  describe('work a previous run left in flight', () => {
    /** Claim a story the way an interrupted run would: in progress, unflagged. */
    function claim(paths: BoardPaths, id: string): void {
      const board = reload(paths);
      moveNode(board, findIssue(board, id)!, { assignee: 'RS-1', status: 'in_progress' });
    }

    it('is picked back up, and unblocks what was waiting on it', async () => {
      const paths = seed();
      story(paths, 'Interrupted', { assignee: 'RS-1' }); // LP-4
      story(paths, 'Downstream', { assignee: 'RS-1' }); // LP-5
      linkIssue(reload(paths), findIssue(reload(paths), 'LP-5')!, { dependsOn: ['LP-4'] });
      claim(paths, 'LP-4');

      const { runner, seen } = scriptedRunner();
      const report = await runAgentQueue(paths, 'RS-1', opts(), {
        runner,
        git: fakeGit(),
        now: () => AT,
      });

      expect(seen).toEqual(['LP-4', 'LP-5']);
      expect(report.steps.map((step) => step.id)).toEqual(['LP-4', 'LP-5']);
      expect(report.held).toEqual([]);
    });

    it('is what `lpm queue simulate` predicts, step for step', async () => {
      const paths = seed();
      story(paths, 'Interrupted', { assignee: 'RS-1' }); // LP-4
      story(paths, 'Downstream', { assignee: 'RS-1' }); // LP-5
      story(paths, 'Independent', { assignee: 'RS-1' }); // LP-6
      linkIssue(reload(paths), findIssue(reload(paths), 'LP-5')!, { dependsOn: ['LP-4'] });
      claim(paths, 'LP-4');

      const board = reload(paths);
      const predicted = simulateQueue(board, board.resourcesById.get('RS-1')!, { today: TODAY });

      const { runner } = scriptedRunner();
      const report = await runAgentQueue(paths, 'RS-1', opts(), {
        runner,
        git: fakeGit(),
        now: () => AT,
      });

      expect(predicted.steps.map((step) => step.issue.id)).toEqual(
        report.steps.map((step) => step.id),
      );
    });

    // The licence to carry on stops at a flag: it says the work has stopped and
    // needs a person, so retrying it would be a loop that never ends.
    it('is left alone once it is flagged, and reported as held', async () => {
      const paths = seed();
      story(paths, 'Stalled', { assignee: 'RS-1' }); // LP-4
      story(paths, 'Downstream', { assignee: 'RS-1' }); // LP-5
      linkIssue(reload(paths), findIssue(reload(paths), 'LP-5')!, { dependsOn: ['LP-4'] });
      claim(paths, 'LP-4');
      flagIssue(reload(paths), findIssue(reload(paths), 'LP-4')!, {
        reason: 'blocked',
        comment: 'needs an API token nobody has',
      });

      const { runner, seen } = scriptedRunner();
      const report = await runAgentQueue(paths, 'RS-1', opts(), {
        runner,
        git: fakeGit(),
        now: () => AT,
      });

      expect(seen).toEqual([]);
      expect(report.stopped).toBe('empty');
      expect(report.held.map((task) => task.id)).toEqual(['LP-4']);
    });

    // Clearing the flag is the remedy the command prints. It has to actually
    // work: before this, the issue stayed in progress and the agent still had
    // nothing to pick up, so the advice was a dead end.
    it('is picked back up once a person clears the flag', async () => {
      const paths = seed();
      story(paths, 'Stalled', { assignee: 'RS-1' }); // LP-4
      claim(paths, 'LP-4');
      flagIssue(reload(paths), findIssue(reload(paths), 'LP-4')!, {
        reason: 'blocked',
        comment: 'needs an API token nobody has',
      });
      clearFlag(reload(paths), findIssue(reload(paths), 'LP-4')!, { comment: 'token issued' });

      const { runner, seen } = scriptedRunner();
      const report = await runAgentQueue(paths, 'RS-1', opts(), {
        runner,
        git: fakeGit(),
        now: () => AT,
      });

      expect(seen).toEqual(['LP-4']);
      expect(report.steps.map((step) => step.id)).toEqual(['LP-4']);
      expect(findIssue(reload(paths), 'LP-4')!.status).toBe('done');
    });

    // A container in an active status is not a thing you pick up: its children
    // are. Resuming it would run the feature as though it were one job.
    it('never resumes a container somebody moved into an active column', async () => {
      const paths = seed();
      const board = reload(paths);
      moveNode(board, findIssue(board, 'LP-3')!, { assignee: 'RS-1', status: 'in_progress' });
      story(paths, 'One', { assignee: 'RS-1' }); // LP-4

      const { runner, seen } = scriptedRunner();
      await runAgentQueue(paths, 'RS-1', opts(), { runner, git: fakeGit(), now: () => AT });

      expect(seen).toEqual(['LP-4']);
    });
  });

  it('previews without running or writing in dry-run', async () => {
    const paths = seed();
    story(paths, 'One', { assignee: 'RS-1' });

    // No runner is given: a dry run must never reach for one.
    const report = await runAgentQueue(paths, 'RS-1', opts({ dryRun: true }), {
      git: fakeGit(),
      now: () => AT,
    });

    expect(report.stopped).toBe('dry-run');
    expect(report.steps.map((step) => step.id)).toEqual(['LP-4']);

    const board = reload(paths);
    expect(findIssue(board, 'LP-4')!.status).toBe('backlog');
    expect(findIssue(board, 'LP-4')!.assignee).toBe('RS-1');
    expect(listComments(board, 'LP-4')).toHaveLength(0);
  });

  it('reports every stage of a task, in the order it happened', async () => {
    const paths = seed();
    story(paths, 'One', { assignee: 'RS-1' });

    const events: RunEvent[] = [];
    // The runner is handed the same sink, so the agent's own stream and the
    // loop's bookkeeping arrive on one channel.
    const runner: PiRunner = async (request) => {
      request.emit?.({ type: 'tool-start', name: 'bash', summary: 'npm test' });
      return { completed: true, summary: 'done', stats: STATS };
    };
    await runAgentQueue(paths, 'RS-1', opts(), {
      runner,
      git: fakeGit(),
      now: () => AT,
      emit: (event) => events.push(event),
    });

    expect(events.map((event) => event.type)).toEqual([
      'phase', // picking
      'task-start',
      'phase', // claiming
      'phase', // briefing
      'phase', // running
      'tool-start',
      'phase', // recording
      'task-end',
      'phase', // picking again, and the queue is empty
    ]);
    expect(events[1]).toEqual({ type: 'task-start', index: 1, id: 'LP-4', title: 'One' });
    expect(events[7]).toMatchObject({ type: 'task-end', id: 'LP-4', completed: true });
  });

  it('finishes the task even when the display throws', async () => {
    const paths = seed();
    story(paths, 'One', { assignee: 'RS-1' });

    const { runner } = scriptedRunner();
    const report = await runAgentQueue(paths, 'RS-1', opts(), {
      runner,
      git: fakeGit(),
      now: () => AT,
      emit: () => {
        throw new Error('the terminal went away');
      },
    });

    expect(report.steps[0]!.completed).toBe(true);
    expect(findIssue(reload(paths), 'LP-4')!.status).toBe('done');
  });
});

describe('sharing a checkout', () => {
  /**
   * Somebody else claims the task between the reload that offered it and the
   * claim itself. The `claiming` phase event fires in exactly that gap, so a
   * sink is how the race is made to happen on purpose rather than hoped for.
   */
  function stealer(paths: BoardPaths, thief: string, steal: (id: string) => boolean) {
    let current = '';
    const stolen: string[] = [];
    const emit = (event: RunEvent): void => {
      if (event.type === 'task-start') current = event.id;
      if (event.type !== 'phase' || event.phase !== 'claiming') return;
      if (!steal(current)) return;
      moveNode(reload(paths), findIssue(reload(paths), current)!, {
        assignee: thief,
        status: 'in_progress',
      });
      stolen.push(current);
    };
    return { emit, stolen };
  }

  it('picks something else when another writer claims the task first', async () => {
    const paths = seed();
    createResource(reload(paths), { type: 'person', title: 'Bob' });
    story(paths, 'Taken', { assignee: 'RS-1' });
    story(paths, 'Mine', { assignee: 'RS-1' });

    const { runner, seen } = scriptedRunner();
    const git = fakeGit();
    const { emit, stolen } = stealer(paths, 'RS-2', (id) => id === 'LP-4');

    const report = await runAgentQueue(paths, 'RS-1', opts(), {
      runner,
      git,
      now: () => AT,
      emit,
    });

    expect(stolen).toEqual(['LP-4']);
    // The run never worked LP-4 and never wrote anything to it: losing a claim
    // is the queue moving on, not a task that went wrong.
    expect(seen).toEqual(['LP-5']);
    expect(report.steps.map((step) => step.id)).toEqual(['LP-5']);
    expect(report.stopped).toBe('empty');

    const taken = findIssue(reload(paths), 'LP-4')!;
    expect(taken.assignee).toBe('RS-2');
    expect(taken.flag).toBeNull();
    expect(listComments(reload(paths), 'LP-4')).toEqual([]);
  });

  it('stops rather than spinning when everything offered keeps being taken', async () => {
    const paths = seed();
    createResource(reload(paths), { type: 'person', title: 'Bob' });
    for (let n = 0; n < 8; n += 1) story(paths, `S${n}`, { assignee: 'RS-1' });

    const { runner, seen } = scriptedRunner();
    const git = fakeGit();
    const { emit, stolen } = stealer(paths, 'RS-2', () => true);

    const report = await runAgentQueue(paths, 'RS-1', opts(), {
      runner,
      git,
      now: () => AT,
      emit,
    });

    expect(seen).toEqual([]);
    expect(report.steps).toEqual([]);
    expect(report.stopped).toBe('contended');
    // It gave up after a bounded number of lost races rather than working
    // through every story on the board.
    expect(stolen.length).toBeLessThan(8);
  });
});
