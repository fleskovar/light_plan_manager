import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import path from 'node:path';
import { BoardError } from '../errors.js';
import { sleepSync } from './atomic.js';
import type { BoardPaths } from './paths.js';

/**
 * The board lock: one writer at a time, across processes.
 *
 * `atomic.ts` stops a reader seeing half a document. This stops two writers
 * taking turns *inside* one another — the read-modify-write that every
 * operation is. Without it two agents both load the board, both see `LP-12`
 * unassigned, both write it, and the second one wins with no trace that the
 * first ever claimed anything. With it they queue, and the loser reads what the
 * winner wrote before deciding what to do (`operations/claim.ts` is the worked
 * example).
 *
 * It is a file, because the board is a folder and there is nothing else to be:
 * `.lpm/lock`, created with `O_EXCL` so exactly one process can make it, holding
 * a JSON record of who has it and what they are doing. Git-ignored, like
 * `local.json` — which process is mid-write is not a property of the plan.
 * Nothing here writes that `.gitignore` entry: `init` puts it there and `check`
 * reports a board that predates it, which is where derived, repairable state
 * belongs. A lock primitive with a side effect on the repository would be a
 * surprise in the one place a surprise is least affordable.
 *
 * Four things it has to get right:
 *
 * **Held for the write, never for the work.** An agent may spend twenty minutes
 * on a task; it holds the lock for the milliseconds it takes to record that it
 * started. A lock scoped to anything longer would be a queue of one.
 *
 * **Re-entrant.** Operations call each other — `flagIssue` writes a document and
 * then a comment, `claimIssue` delegates to `moveNode` — so a nested acquire by
 * the same process counts up rather than deadlocking.
 *
 * **A dead holder does not stop the board — but a live one is never robbed.**
 * A process killed mid-operation would otherwise leave its lock behind, and a
 * plan nobody can write to because of a crash last Tuesday is worse than the
 * race. The cheap answer to that is "break a lock whose pid is not running",
 * and it is wrong: see `isStale`, which is where the hard-won half of this file
 * lives. Instead an interrupted process gives the lock up on its way out
 * (`releaseOnExit`), and a lock is only ever broken for being *old*.
 *
 * **Say what it does not do.** Breaking a stale lock cannot be made perfectly
 * safe without a filesystem primitive nobody has: two processes can decide the
 * same lock is dead, and the second may unlink a lock a third has just taken.
 * The rename-then-delete below makes the *breaker* unique, and the token
 * check-back makes a robbed holder notice — but the real backstop is the stamp
 * check in `operations/shared.ts`, which refuses a write whose document moved
 * underneath it whether or not the lock behaved. Two lines of defence, because
 * this one is advisory: nothing stops a text editor writing `_issue.md`.
 */

/** How long to wait for another process before giving up. */
export const LOCK_TIMEOUT_ENV = 'LPM_LOCK_TIMEOUT_MS';
/** How old a lock has to be before it is assumed to be a crash. */
export const LOCK_STALE_ENV = 'LPM_LOCK_STALE_MS';
/**
 * Skip locking entirely. The escape hatch for a filesystem where `O_EXCL` does
 * not mean what it says — some network mounts — on which every command would
 * otherwise fail. It removes the first line of defence and leaves the second:
 * a stale write is still refused. Documented rather than hidden, for the same
 * reason `--unsafe` is.
 */
export const LOCK_DISABLE_ENV = 'LPM_NO_LOCK';

const DEFAULT_TIMEOUT_MS = 10_000;
/**
 * Deliberately generous. It is the only thing standing between a live holder
 * and having its lock taken away, so it has to exceed the longest legitimate
 * hold — a push of a few hundred changes reloads the board between each one —
 * rather than be tuned to make recovery from a crash feel quick.
 */
const DEFAULT_STALE_MS = 120_000;
/** How long to wait between attempts. Short: a hold is milliseconds. */
const POLL_MS = 20;

/** Who holds the lock, and what they are doing with it. */
export interface LockHolder {
  pid: number;
  host: string;
  /** The account the process runs as, so a message names somebody. */
  user: string;
  /** What it is doing — "claim LP-12", "push 14 changes". */
  op: string;
  /** ISO timestamp of the acquisition. */
  at: string;
  /**
   * Random token for this acquisition. A holder writes it and reads it back,
   * which is how it finds out that somebody broke its lock and took over.
   */
  nonce: string;
}

function positiveEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function disabled(): boolean {
  const raw = process.env[LOCK_DISABLE_ENV]?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function whoami(): string {
  try {
    return userInfo().username;
  } catch {
    return 'unknown';
  }
}

/** Read the record of whoever holds the lock, or null when there is nothing readable. */
export function readLockHolder(file: string): LockHolder | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<LockHolder>;
    if (typeof parsed.pid !== 'number' || typeof parsed.nonce !== 'string') return null;
    return {
      pid: parsed.pid,
      host: typeof parsed.host === 'string' ? parsed.host : '',
      user: typeof parsed.user === 'string' ? parsed.user : 'unknown',
      op: typeof parsed.op === 'string' ? parsed.op : 'something',
      at: typeof parsed.at === 'string' ? parsed.at : '',
      nonce: parsed.nonce,
    };
  } catch {
    // Missing, unparseable, or caught between the create and the write. The
    // caller decides which, by watching how long it stays that way.
    return null;
  }
}

function ageOf(holder: LockHolder): number {
  const at = Date.parse(holder.at);
  // A record with no usable timestamp is treated as brand new, so it expires by
  // the pid check or not at all — guessing "ancient" would break live locks.
  return Number.isFinite(at) ? Date.now() - at : 0;
}

/**
 * Whether a lock may be taken away from whoever wrote it.
 *
 * **Age, and nothing else.** The obvious extra test — "is that pid still
 * running?" — was here and had to come out: `process.kill(pid, 0)` returns
 * `ESRCH` for processes that are demonstrably alive, often enough to matter as
 * soon as a machine is loaded, and a false "dead" does not degrade the lock, it
 * *deletes* it. Eight concurrent `lpm new` calls on one board produced duplicate
 * ids exactly this way: one process judged the live holder dead, broke its lock,
 * and both read the same id counter. A false "alive" costs a wait; a false
 * "dead" costs the guarantee. There is no version of that trade worth taking, so
 * liveness is not consulted at all.
 *
 * What is left is a clock, which is why `staleMs` has to be longer than the
 * longest honest hold — a whole push, a whole `check --fix` — rather than
 * tuned down to make crash recovery snappy. Crash recovery is instead handled
 * where it belongs: a process that is interrupted releases the lock on its way
 * out (see `releaseOnExit`), so the window only matters for a kill nothing can
 * catch.
 */
function isStale(holder: LockHolder, staleMs: number): boolean {
  return ageOf(holder) > staleMs;
}

/**
 * Take a lock away from a holder judged dead.
 *
 * Renaming first is what makes the breaker unique: two processes can both
 * decide the lock is stale, but only one of them can rename the file, and the
 * other gets `ENOENT` and goes back to competing for a fresh one.
 */
function breakLock(file: string): void {
  const victim = `${file}.stale.${randomBytes(4).toString('hex')}`;
  try {
    renameSync(file, victim);
  } catch {
    // Somebody else broke it first, or it was released while we deliberated.
    return;
  }
  try {
    rmSync(victim, { force: true });
  } catch {
    // The record is out of the way, which is all that was needed.
  }
}

/**
 * Errors from the exclusive create that mean "somebody else has it this
 * instant", not "this can never work".
 *
 * `EEXIST` is the honest one and the only one on a POSIX filesystem. The rest
 * are Windows: a file another process has just unlinked stays in a
 * *delete-pending* state until its last handle closes, and creating over it
 * returns `ERROR_ACCESS_DENIED`, which libuv reports as `EPERM` — so the
 * ordinary case of "the previous holder released a millisecond ago" arrives
 * here looking like a permissions failure. Letting it out of the loop turned a
 * lost race into a crashed command under load. A genuinely unwritable board
 * still fails, but as a timeout that names the code rather than as a stack
 * trace, which is the difference between waiting and giving up.
 */
const CONTENDED = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);

/** What the last failed create said, so a timeout can name it. */
let lastCreateError: string | null = null;

/** Create the lock file, or report that somebody already has. */
function tryCreate(file: string, holder: LockHolder): boolean {
  let fd: number;
  try {
    fd = openSync(file, 'wx');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (code === 'ENOENT') {
      // The board folder is not there yet (a board being created). Make it and
      // let the next turn of the loop try again.
      mkdirSync(path.dirname(file), { recursive: true });
      return false;
    }
    if (CONTENDED.has(code)) {
      lastCreateError = code;
      return false;
    }
    throw error;
  }
  lastCreateError = null;
  try {
    writeSync(fd, JSON.stringify(holder));
  } finally {
    closeSync(fd);
  }
  // Read it back: if a process that had judged this board's previous lock stale
  // broke ours between the create and now, the token will not be the one we
  // wrote, and we do not hold what we think we hold.
  return readLockHolder(file)?.nonce === holder.nonce;
}

function timedOut(file: string, op: string, timeoutMs: number): BoardError {
  const holder = readLockHolder(file);
  const seconds = Math.round(timeoutMs / 100) / 10;
  return new BoardError(
    holder
      ? `The board is busy: ${holder.user} is doing "${holder.op}" (pid ${holder.pid} on ${holder.host || 'this machine'})`
      : 'The board is busy and did not come free',
    [
      `Gave up waiting after ${seconds}s to ${op}.`,
      'Another person, agent or editor is part-way through a change. Try again in a moment.',
      `If nothing is running, delete ${file} — it is a leftover lock, and nothing on the board depends on it.`,
      // A board nobody can write to at all reads exactly like a busy one from
      // in here, so say which it was rather than leaving somebody to guess.
      ...(holder === null && lastCreateError
        ? [`The lock file could not be created either (${lastCreateError}); check the folder is writable.`]
        : []),
    ],
  );
}

/**
 * Depth of nesting per lock file, so an operation that calls another operation
 * does not deadlock against itself. Keyed by path rather than by board, because
 * two `BoardPaths` objects for the same folder are the same lock.
 */
const held = new Map<string, { depth: number; nonce: string }>();

/**
 * Run `fn` as the board's only writer.
 *
 * `op` is what to tell whoever is waiting — short, and naming the document when
 * there is one ("claim LP-12" reads better than "moveNode").
 */
export function withBoardLock<T>(paths: BoardPaths, op: string, fn: () => T): T {
  if (disabled()) return fn();

  const file = paths.lockPath;
  const entry = held.get(file);
  if (entry) {
    entry.depth += 1;
    try {
      return fn();
    } finally {
      entry.depth -= 1;
      if (entry.depth === 0) held.delete(file);
    }
  }

  const timeoutMs = positiveEnv(LOCK_TIMEOUT_ENV, DEFAULT_TIMEOUT_MS);
  const staleMs = positiveEnv(LOCK_STALE_ENV, DEFAULT_STALE_MS);
  const nonce = randomBytes(8).toString('hex');
  const holder: LockHolder = {
    pid: process.pid,
    host: hostname(),
    user: whoami(),
    op,
    at: new Date().toISOString(),
    nonce,
  };

  acquire(file, holder, timeoutMs, staleMs, op);
  held.set(file, { depth: 1, nonce });
  const stopWatching = releaseOnExit(file, nonce);
  try {
    return fn();
  } finally {
    const current = held.get(file);
    if (current) {
      current.depth -= 1;
      if (current.depth === 0) {
        held.delete(file);
        stopWatching();
        release(file, nonce);
      }
    }
  }
}

/**
 * Give the lock up if this process is interrupted while holding it.
 *
 * Without this, Ctrl-C during any write leaves a lock behind and the board
 * refuses every change until it ages out — and since `isStale` is a clock and
 * nothing else, that wait is long by design. A `finally` does not cover it:
 * Node's default `SIGINT` handling terminates the process without unwinding.
 * So while the lock is held, and only then, the two catchable signals are
 * intercepted, the lock released, and the signal re-raised with the default
 * behaviour so the process still dies the way the caller asked it to.
 *
 * Returns the function that takes the handlers off again.
 */
function releaseOnExit(file: string, nonce: string): () => void {
  const onExit = (): void => release(file, nonce);
  const onSignal = (signal: NodeJS.Signals): void => {
    release(file, nonce);
    process.removeListener('exit', onExit);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    // Re-raise with no listener left, so the default action applies and the
    // exit code says what actually happened.
    process.kill(process.pid, signal);
  };

  process.once('exit', onExit);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  return () => {
    process.removeListener('exit', onExit);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  };
}

function acquire(
  file: string,
  holder: LockHolder,
  timeoutMs: number,
  staleMs: number,
  op: string,
): void {
  const deadline = Date.now() + timeoutMs;
  /** When we first saw a lock file we could not read, for the same expiry. */
  let unreadableSince: number | null = null;

  for (;;) {
    if (tryCreate(file, holder)) return;

    const current = readLockHolder(file);
    if (current) {
      unreadableSince = null;
      if (isStale(current, staleMs)) {
        breakLock(file);
        continue;
      }
    } else {
      // Either a lock caught between its create and its write — microseconds —
      // or a record something truncated. Time decides which.
      unreadableSince ??= Date.now();
      if (Date.now() - unreadableSince > staleMs) {
        breakLock(file);
        unreadableSince = null;
        continue;
      }
    }

    if (Date.now() >= deadline) throw timedOut(file, op, timeoutMs);
    sleepSync(POLL_MS);
  }
}

/** Give the lock up, unless somebody broke it and it is no longer ours to give. */
function release(file: string, nonce: string): void {
  if (readLockHolder(file)?.nonce !== nonce) return;
  try {
    rmSync(file, { force: true });
  } catch {
    // Already gone. Nothing on the board depends on the file existing.
  }
}
