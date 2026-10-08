import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { BoardPaths } from '../src/core/index.js';
import {
  ConflictError,
  LOCK_DISABLE_ENV,
  LOCK_STALE_ENV,
  LOCK_TIMEOUT_ENV,
  claimIssue,
  createIssue,
  createResource,
  findIssue,
  flagIssue,
  listComments,
  moveNode,
  parseActivity,
  readLockHolder,
  sameStamp,
  stampOf,
  updateNode,
  withBoardLock,
  writeFileAtomic,
} from '../src/core/index.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

/**
 * Several people and agents, one `.lpm` folder.
 *
 * These are the tests for the three things that make that work: writes nobody
 * can see half of, one writer at a time, and a claim that is a test-and-set
 * rather than whoever writes last. The interesting cases need two *processes* —
 * a lock nothing else competes for proves nothing — so the ones that matter
 * spawn the built CLI, exactly as `test/cli.test.ts` does.
 */

const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lpm-race-'));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  cleanupBoards();
  delete process.env[LOCK_TIMEOUT_ENV];
  delete process.env[LOCK_STALE_ENV];
  delete process.env[LOCK_DISABLE_ENV];
});

// ---------------------------------------------------------------------------
// Atomic writes
// ---------------------------------------------------------------------------

describe('writeFileAtomic', () => {
  it('replaces a file in one step and leaves no temporary behind', () => {
    const dir = tempDir();
    const file = path.join(dir, 'doc.md');
    writeFileSync(file, 'before', 'utf8');

    writeFileAtomic(file, 'after');

    expect(readFileSync(file, 'utf8')).toBe('after');
    expect(leftovers(dir)).toEqual([]);
  });

  it('leaves the original alone and cleans up when the write fails', () => {
    const dir = tempDir();
    const file = path.join(dir, 'doc.md');
    writeFileSync(file, 'before', 'utf8');

    // A directory where the target should be: the rename cannot land.
    expect(() => writeFileAtomic(path.join(file, 'nested', 'x.md'), 'nope')).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('before');
    expect(leftovers(dir)).toEqual([]);
  });
});

/** Anything in `dir` that is not the document itself — i.e. an abandoned temp. */
function leftovers(dir: string): string[] {
  return readdirSync(dir).filter((name) => name !== 'doc.md');
}

// ---------------------------------------------------------------------------
// Stamps
// ---------------------------------------------------------------------------

describe('document stamps', () => {
  it('changes when the file is rewritten', () => {
    const dir = tempDir();
    const file = path.join(dir, 'doc.md');
    writeFileSync(file, 'one', 'utf8');
    const before = stampOf(file)!;

    writeFileAtomic(file, 'one but longer');
    const after = stampOf(file)!;

    expect(sameStamp(before, after)).toBe(false);
  });

  it('is null for a file that is not there', () => {
    expect(stampOf(path.join(tempDir(), 'nothing.md'))).toBeNull();
  });

  it('is recorded for every document a load reads', () => {
    const paths = makeBoard();
    const board = reload(paths);
    createIssue(board, { type: 'program', title: 'E' });

    const after = reload(paths);
    const issue = findIssue(after, 'LP-1')!;
    expect(after.stamps.get(issue.file)).toBeDefined();
    expect(sameStamp(after.stamps.get(issue.file)!, stampOf(issue.file)!)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The lock
// ---------------------------------------------------------------------------

describe('withBoardLock', () => {
  it('holds the lock for the body and releases it afterwards', () => {
    const paths = makeBoard();
    withBoardLock(paths, 'test', () => {
      expect(existsSync(paths.lockPath)).toBe(true);
      expect(readLockHolder(paths.lockPath)?.pid).toBe(process.pid);
    });
    expect(existsSync(paths.lockPath)).toBe(false);
  });

  it('releases the lock when the body throws', () => {
    const paths = makeBoard();
    expect(() =>
      withBoardLock(paths, 'test', () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(existsSync(paths.lockPath)).toBe(false);
  });

  it('nests without deadlocking, and only the outermost releases', () => {
    const paths = makeBoard();
    withBoardLock(paths, 'outer', () => {
      withBoardLock(paths, 'inner', () => {
        expect(existsSync(paths.lockPath)).toBe(true);
      });
      // The inner exit must not have given the lock away underneath us.
      expect(existsSync(paths.lockPath)).toBe(true);
    });
    expect(existsSync(paths.lockPath)).toBe(false);
  });

  it('gives up on a lock somebody else is holding, and says who has it', () => {
    const paths = makeBoard();
    // A live process that is not us and is not going to finish: the lock has to
    // look held rather than stale.
    writeFileSync(
      paths.lockPath,
      JSON.stringify({
        pid: process.pid,
        host: os.hostname(),
        user: 'someone',
        op: 'a long import',
        at: new Date().toISOString(),
        nonce: 'not-ours',
      }),
      'utf8',
    );
    process.env[LOCK_TIMEOUT_ENV] = '150';

    expect(() => withBoardLock(paths, 'write something', () => 1)).toThrow(
      /someone is doing "a long import"/,
    );
    // Refused, not stolen.
    expect(readLockHolder(paths.lockPath)?.nonce).toBe('not-ours');
  });

  /**
   * The rule that cost the most to get right. Judging a lock dead because its
   * pid is not running looks obviously correct and is not: `process.kill(pid,
   * 0)` reports `ESRCH` for live processes often enough to matter under load,
   * and a lock broken on that basis lets two writers into the same critical
   * section. Age is the only signal, and this is the test that says so.
   */
  it('leaves a fresh lock alone even when its process is long gone', () => {
    const paths = makeBoard();
    writeFileSync(
      paths.lockPath,
      JSON.stringify({
        // A pid nothing can be running under.
        pid: 2 ** 31 - 1,
        host: os.hostname(),
        user: 'crashed',
        op: 'something it never finished',
        at: new Date().toISOString(),
        nonce: 'dead',
      }),
      'utf8',
    );
    process.env[LOCK_TIMEOUT_ENV] = '150';

    expect(() => withBoardLock(paths, 'carry on', () => 'ran')).toThrow(/board is busy/);
    expect(readLockHolder(paths.lockPath)?.nonce).toBe('dead');
  });

  it('breaks a lock older than the stale window', () => {
    const paths = makeBoard();
    writeFileSync(
      paths.lockPath,
      JSON.stringify({
        pid: process.pid,
        host: os.hostname(),
        user: 'stuck',
        op: 'wedged',
        at: new Date(Date.now() - 600_000).toISOString(),
        nonce: 'old',
      }),
      'utf8',
    );
    process.env[LOCK_STALE_ENV] = '100';
    process.env[LOCK_TIMEOUT_ENV] = '2000';

    expect(withBoardLock(paths, 'carry on', () => 'ran')).toBe('ran');
  });

  it('does nothing at all when locking is switched off', () => {
    const paths = makeBoard();
    process.env[LOCK_DISABLE_ENV] = '1';
    withBoardLock(paths, 'test', () => {
      expect(existsSync(paths.lockPath)).toBe(false);
    });
  });

  it('is git-ignored, so a lock in flight is never committed', () => {
    const paths = makeBoard();
    const ignored = readFileSync(path.join(paths.lpmDir, '.gitignore'), 'utf8');
    expect(ignored).toContain('lock');
    expect(ignored).toContain('lock.stale.*');
  });
});

// ---------------------------------------------------------------------------
// Stale writes
// ---------------------------------------------------------------------------

describe('a handle that has gone stale', () => {
  it('refuses an update over a document somebody else rewrote', () => {
    const paths = makeBoard();
    const board = reload(paths);
    createIssue(board, { type: 'program', title: 'E' });

    const mine = reload(paths);
    const theirs = reload(paths);
    updateNode(theirs, findIssue(theirs, 'LP-1')!, { title: 'Theirs' });

    expect(() => updateNode(mine, findIssue(mine, 'LP-1')!, { title: 'Mine' })).toThrow(
      ConflictError,
    );
    // Nothing was written, so nothing was lost.
    expect(findIssue(reload(paths), 'LP-1')!.title).toBe('Theirs');
  });

  it('refuses a flag over a document somebody else rewrote', () => {
    const paths = makeBoard();
    createIssue(reload(paths), { type: 'program', title: 'E' });

    const mine = reload(paths);
    const theirs = reload(paths);
    flagIssue(theirs, findIssue(theirs, 'LP-1')!, { reason: 'blocked', comment: 'theirs' });

    expect(() =>
      flagIssue(mine, findIssue(mine, 'LP-1')!, { reason: 'help', comment: 'mine' }),
    ).toThrow(ConflictError);

    // The winner's flag stands, and no second explanation was written against
    // a flag that never landed.
    const after = reload(paths);
    expect(findIssue(after, 'LP-1')!.flag).toBe('blocked');
    expect(listComments(after, 'LP-1')).toHaveLength(1);
    expect(parseActivity(findIssue(after, 'LP-1')!.body)).toHaveLength(1);
  });

  it('refuses a move over a document somebody else rewrote', () => {
    const paths = makeBoard();
    const board = reload(paths);
    createIssue(board, { type: 'program', title: 'E' });

    const mine = reload(paths);
    const theirs = reload(paths);
    updateNode(theirs, findIssue(theirs, 'LP-1')!, { title: 'Theirs' });

    expect(() => moveNode(mine, findIssue(mine, 'LP-1')!, { status: 'in_progress' })).toThrow(
      /changed on disk/,
    );
  });

  it('lets one handle write the same document twice', () => {
    const paths = makeBoard();
    const board = reload(paths);
    createIssue(board, { type: 'program', title: 'E' });

    const mine = reload(paths);
    const issue = findIssue(mine, 'LP-1')!;
    const once = updateNode(mine, issue, { title: 'One' }).node;
    // The handle recorded what it wrote, so its own previous write is not
    // mistaken for somebody else's edit.
    expect(() => updateNode(mine, once, { title: 'Two' })).not.toThrow();
    expect(findIssue(reload(paths), 'LP-1')!.title).toBe('Two');
  });
});

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

describe('claimIssue', () => {
  function boardWithTwoPeople(): BoardPaths {
    const paths = makeBoard();
    const board = reload(paths);
    createResource(board, { type: 'person', title: 'Alice' });
    createResource(reload(paths), { type: 'person', title: 'Bob' });
    createIssue(reload(paths), { type: 'program', title: 'E' });
    return paths;
  }

  it('assigns, starts and records the claim in the document', () => {
    const paths = boardWithTwoPeople();
    const board = reload(paths);
    const result = claimIssue(board, findIssue(board, 'LP-1')!, { assignee: 'RS-1' });

    expect(result.issue.assignee).toBe('RS-1');
    expect(result.issue.status).toBe('in_progress');
    expect(result.alreadyHeld).toBe(false);

    // The frontmatter is what withholds it from everybody else's queue; the
    // activity entry is how a person reading the file finds out.
    const entries = parseActivity(findIssue(reload(paths), 'LP-1')!.body);
    expect(entries.at(-1)!.heading).toBe('claimed');
    expect(entries.at(-1)!.author).toContain('RS-1');
  });

  it('refuses an issue somebody else took while this handle was reading', () => {
    const paths = boardWithTwoPeople();
    const stale = reload(paths);

    claimIssue(reload(paths), findIssue(reload(paths), 'LP-1')!, { assignee: 'RS-2' });

    // `stale` still believes LP-1 is unassigned and in the backlog.
    expect(findIssue(stale, 'LP-1')!.assignee).toBeNull();
    expect(() => claimIssue(stale, findIssue(stale, 'LP-1')!, { assignee: 'RS-1' })).toThrow(
      ConflictError,
    );
    expect(findIssue(reload(paths), 'LP-1')!.assignee).toBe('RS-2');
  });

  it('takes it with force, and says who it was taken from', () => {
    const paths = boardWithTwoPeople();
    claimIssue(reload(paths), findIssue(reload(paths), 'LP-1')!, { assignee: 'RS-2' });

    const result = claimIssue(reload(paths), findIssue(reload(paths), 'LP-1')!, {
      assignee: 'RS-1',
      force: true,
    });
    expect(result.takenFrom).toBe('RS-2');
    expect(parseActivity(result.issue.body).at(-1)!.heading).toBe('claimed — taken from RS-2');
  });

  it('is idempotent for the resource that already holds it', () => {
    const paths = boardWithTwoPeople();
    claimIssue(reload(paths), findIssue(reload(paths), 'LP-1')!, { assignee: 'RS-1' });

    const again = claimIssue(reload(paths), findIssue(reload(paths), 'LP-1')!, { assignee: 'RS-1' });
    expect(again.alreadyHeld).toBe(true);
    // No second "claimed" line: re-asking for what you have is not an event.
    expect(parseActivity(again.issue.body).filter((e) => e.heading === 'claimed')).toHaveLength(1);
  });

  it('lets anyone who covers a pool draw work out of it', () => {
    const paths = makeBoard();
    createResource(reload(paths), { type: 'role', title: 'Devs', capacity: 3 });
    createResource(reload(paths), { type: 'person', title: 'Alice', covers: ['RS-1'] });
    createIssue(reload(paths), { type: 'program', title: 'E', assignee: 'RS-1' });

    const result = claimIssue(reload(paths), findIssue(reload(paths), 'LP-1')!, {
      assignee: 'RS-2',
    });
    expect(result.issue.assignee).toBe('RS-2');
    expect(result.takenFrom).toBeUndefined();
  });

  it('refuses work that is already finished', () => {
    const paths = boardWithTwoPeople();
    moveNode(reload(paths), findIssue(reload(paths), 'LP-1')!, { status: 'done' });
    expect(() =>
      claimIssue(reload(paths), findIssue(reload(paths), 'LP-1')!, { assignee: 'RS-1' }),
    ).toThrow(/already "done"/);
  });
});

// ---------------------------------------------------------------------------
// Two processes, which is the case none of the above proves
// ---------------------------------------------------------------------------

describe('two processes on one checkout', () => {
  /** Run the built CLI, without inheriting a developer's own board. */
  function lpm(dir: string, env: Record<string, string>, ...args: string[]) {
    return spawnSync(process.execPath, [CLI, ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', LPM_BOARD_PATH: '', ...env },
    });
  }

  /** Start the CLI without waiting, so two of them are genuinely in flight. */
  function lpmAsync(
    dir: string,
    env: Record<string, string>,
    ...args: string[]
  ): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], {
        cwd: dir,
        env: { ...process.env, NO_COLOR: '1', LPM_BOARD_PATH: '', ...env },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += String(chunk)));
      child.stderr.on('data', (chunk) => (stderr += String(chunk)));
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
  }

  it('lets exactly one of several simultaneous claims win', async () => {
    const dir = tempDir();
    lpm(dir, {}, 'init', '--prefix', 'LP', '--no-git');
    const racers = ['RS-1', 'RS-2', 'RS-3', 'RS-4', 'RS-5'];
    for (const [index] of racers.entries()) lpm(dir, {}, 'new', 'person', '-t', `P${index + 1}`);
    lpm(dir, {}, 'new', 'program', '-t', 'The one everybody wants');

    const runs = await Promise.all(
      racers.map((who) => lpmAsync(dir, { LPM_USER: who }, 'task', 'start', 'LP-1')),
    );

    const winners = runs.filter((run) => run.status === 0);
    expect(winners).toHaveLength(1);
    for (const loser of runs.filter((run) => run.status !== 0)) {
      expect(loser.stderr).toMatch(/is already (assigned to|being worked on by)/);
    }

    // The board agrees with the winner rather than with whoever wrote last, and
    // the document itself records the claim exactly once.
    const holder = racers[runs.indexOf(winners[0]!)]!;
    const document = readFileSync(path.join(dir, '.lpm', 'board', 'LP-1', '_issue.md'), 'utf8');
    expect(document).toContain(`assignee: ${holder}`);
    expect(document.match(/— claimed$/gm)).toHaveLength(1);
  });

  it('never hands the same id to two simultaneous creates', async () => {
    const dir = tempDir();
    lpm(dir, {}, 'init', '--prefix', 'LP', '--no-git');

    const runs = await Promise.all(
      ['A', 'B', 'C', 'D'].map((title) => lpmAsync(dir, {}, 'new', 'program', '-t', title)),
    );
    for (const run of runs) expect(`${run.status} ${run.stderr}`.trim()).toBe('0');

    const ids = readFileSync(path.join(dir, '.lpm', 'INDEX.md'), 'utf8')
      .split('\n')
      .flatMap((line) => /- \[(LP-\d+)\]/.exec(line)?.[1] ?? []);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  });

  /**
   * Every flag writes its own document *and* the shared ancestors above it —
   * the derived roll-up — so several at once is the sharpest concurrent-write
   * case the engine has. Three things must survive it: no flag lands without
   * its explanation, the ancestors end up marked exactly once, and the board
   * still loads.
   */
  it('lands every one of several simultaneous flags, explanation included', async () => {
    const dir = tempDir();
    lpm(dir, {}, 'init', '--prefix', 'LP', '--no-git');
    lpm(dir, {}, 'new', 'program', '-t', 'P');
    lpm(dir, {}, 'new', 'epic', '-t', 'E', '-p', 'LP-1');
    lpm(dir, {}, 'new', 'feature', '-t', 'F', '-p', 'LP-2');
    const stories = ['LP-4', 'LP-5', 'LP-6', 'LP-7'];
    for (const [index] of stories.entries()) {
      lpm(dir, {}, 'new', 'user_story', '-t', `S${index + 1}`, '-p', 'LP-3');
    }

    const runs = await Promise.all(
      stories.map((id, index) =>
        lpmAsync(dir, {}, 'flag', id, '--reason', 'blocked', '-m', `stopped by ${index}`),
      ),
    );
    for (const run of runs) expect(`${run.status} ${run.stderr}`.trim()).toBe('0');

    const feature = path.join(dir, '.lpm', 'board', 'LP-1', 'LP-2', 'LP-3');
    for (const [index, id] of stories.entries()) {
      const document = readFileSync(path.join(feature, id, '_issue.md'), 'utf8');
      // The flag and the reason it was raised for land in one write, so a flag
      // can never reach disk without the explanation that makes it actionable.
      expect(document).toContain('flag: blocked');
      expect(document).toContain('— flagged: Blocked');
      expect(document).toContain(`stopped by ${index}`);
      const comments = readFileSync(path.join(feature, id, '_comments.md'), 'utf8');
      expect(comments.match(/^## 20/gm)).toHaveLength(1);
    }

    // Each shared ancestor was rewritten by all four writers and ends up saying
    // the one true thing: work inside it has stopped.
    for (const ancestor of [['LP-1'], ['LP-1', 'LP-2'], ['LP-1', 'LP-2', 'LP-3']]) {
      const document = readFileSync(
        path.join(dir, '.lpm', 'board', ...ancestor, '_issue.md'),
        'utf8',
      );
      expect(document).toContain('flag: inside');
    }

    expect(lpm(dir, {}, 'check').status).toBe(0);
  });

  /**
   * The sharpest concurrent-write case on a board: several people flagging
   * different stories at the same moment, because the flag roll-up means every
   * one of them also writes the *same* feature, epic and program documents.
   */
  it('records every concurrent flag, in the story and in the container', async () => {
    const dir = tempDir();
    lpm(dir, {}, 'init', '--prefix', 'LP', '--no-git');
    lpm(dir, {}, 'new', 'program', '-t', 'Payments');
    lpm(dir, {}, 'new', 'epic', '-t', 'Checkout', '-p', 'LP-1');
    lpm(dir, {}, 'new', 'feature', '-t', 'Guest flow', '-p', 'LP-2');
    const stories = ['LP-4', 'LP-5', 'LP-6', 'LP-7'];
    for (const [index] of stories.entries()) {
      lpm(dir, {}, 'new', 'user_story', '-t', `S${index + 1}`, '-p', 'LP-3');
    }

    const runs = await Promise.all(
      stories.map((id) => lpmAsync(dir, {}, 'flag', id, '-m', `stopped: ${id}`)),
    );
    for (const run of runs) expect(`${run.status} ${run.stderr}`.trim()).toBe('0');

    const feature = path.join(dir, '.lpm', 'board', 'LP-1', 'LP-2', 'LP-3');
    for (const id of stories) {
      const document = readFileSync(path.join(feature, id, '_issue.md'), 'utf8');
      expect(document).toContain('flag: blocked');
      // Exactly one — no write was lost, and none was applied twice.
      expect(document.match(/— flagged: Blocked$/gm)).toHaveLength(1);
    }

    // The container they all wrote carries one derived flag and says so once.
    const container = readFileSync(path.join(feature, '_issue.md'), 'utf8');
    expect(container).toContain('flag: inside');
    expect(container.match(/— flagged: Stopped inside$/gm)).toHaveLength(1);
    // And nobody explained the container's flag, which is the whole point of
    // the line above being there.
    expect(existsSync(path.join(feature, '_comments.md'))).toBe(false);

    expect(lpm(dir, {}, 'check').status).toBe(0);
  });

  it('never leaves a document half-written for a reader', async () => {
    const dir = tempDir();
    lpm(dir, {}, 'init', '--prefix', 'LP', '--no-git');
    lpm(dir, {}, 'new', 'program', '-t', 'P');
    const file = path.join(dir, '.lpm', 'board', 'LP-1', '_issue.md');

    // Read the document as fast as we can while four writers rewrite it. Every
    // read has to see a complete document — a torn one is invalid YAML and a
    // board that will not load.
    let reads = 0;
    let torn = 0;
    const reading = setInterval(() => {
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        // Caught the instant of a rename. Not a torn read — the claim under
        // test is that no reader ever sees *half* a document.
        return;
      }
      reads += 1;
      if (!text.startsWith('---\n') || !text.includes('\nid: LP-1\n')) torn += 1;
    }, 1);

    await Promise.all(
      ['one', 'two', 'three', 'four'].map((title) => lpmAsync(dir, {}, 'set', 'LP-1', '-t', title)),
    );
    clearInterval(reading);

    expect(reads).toBeGreaterThan(0);
    expect(torn).toBe(0);
    expect(statSync(file).size).toBeGreaterThan(0);
  });
});
