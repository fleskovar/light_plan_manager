import { randomBytes } from 'node:crypto';
import { renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The three primitives that make a board safe to share.
 *
 * A `.lpm` folder has no server in front of it: two people, a web session and a
 * swarm of agents can all be writing to one checkout at the same moment, and
 * every one of them is a separate process holding its own `LoadedBoard`. Three
 * things have to be true for that to work, and this file is the first two of
 * them.
 *
 * **Nobody reads half a document.** `writeFileAtomic` writes a temporary file
 * beside the target and renames it into place. `rename` over an existing file is
 * atomic on POSIX and on Windows (`MoveFileEx` with replace), so a concurrent
 * reader sees either the whole old document or the whole new one — never the
 * torn middle, which on a YAML frontmatter file reads as a corrupt board.
 *
 * **A writer can tell whether the file moved underneath it.** A `DocStamp` is
 * the identity of a file as it was read: modification time to nanosecond
 * precision plus size. `loadBoard` records one per document, and an operation
 * compares it against disk before writing, so a stale handle is refused rather
 * than silently winning. This is the same evidence `DocumentCache` trusts, and
 * it carries the same caveat — see `sameStamp`.
 *
 * The third is `lock.ts`, which serializes the writers so the compare and the
 * write cannot be interleaved.
 *
 * Deliberately *not* here: `fsync`. The failure this guards against is another
 * process reading at the wrong moment, not the machine losing power; a board is
 * versioned in git, and paying a flush on every status change would make the
 * common case slower to defend against the case git already covers.
 */

/** How long to keep retrying a rename a virus scanner or indexer is holding. */
const RENAME_RETRY_MS = 200;

/** Errors a Windows filesystem raises when something else has the file open. */
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Block the calling thread for `ms`. Everything in the engine is synchronous —
 * operations are called from a CLI process that then exits — so the lock's
 * retry loop and the rename retry below need a wait that does not need an event
 * loop turn. `Atomics.wait` is the only one Node offers on the main thread.
 */
export function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tempNameFor(file: string): string {
  const base = path.basename(file);
  // Leading dot so a temporary that outlives a killed process is hidden from a
  // file tree and from `scanDir`, which skips dot-entries.
  return path.join(path.dirname(file), `.${base}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`);
}

function renameWithRetry(from: string, to: string): void {
  const until = Date.now() + RENAME_RETRY_MS;
  for (;;) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!TRANSIENT.has(code) || Date.now() >= until) throw error;
      sleepSync(10);
    }
  }
}

/**
 * Write `data` to `file` so that no reader ever observes a partial write.
 *
 * The temporary lands in the same directory as the target, because a rename is
 * only atomic within one filesystem and `.lpm` may well be a mount of its own.
 * A failed write takes its temporary with it.
 */
export function writeFileAtomic(file: string, data: string): void {
  const temp = tempNameFor(file);
  try {
    writeFileSync(temp, data, 'utf8');
    renameWithRetry(temp, file);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // The temporary is already gone, or the directory is unwritable — either
      // way the original error is the one worth reporting.
    }
    throw error;
  }
}

/** The identity of a file as some reader saw it. */
export interface DocStamp {
  /** Modification time in nanoseconds, which is what a same-second rewrite needs. */
  mtimeNs: bigint;
  size: number;
}

/** Stamp `file` as it stands now, or null when it does not exist. */
export function stampOf(file: string): DocStamp | null {
  try {
    const stat = statSync(file, { bigint: true });
    return { mtimeNs: stat.mtimeNs, size: Number(stat.size) };
  } catch {
    return null;
  }
}

/**
 * Whether two stamps describe the same version of a file.
 *
 * Say what it does not do: a filesystem with a coarse clock (FAT, and some
 * network mounts) can give two rewrites inside one tick the same timestamp, so
 * a same-size rewrite in that window compares equal. That is the same racy-index
 * hole git guards against and `DocumentCache` closes with a two-second window,
 * and it is why this is the *second* line of defence rather than the only one:
 * the board lock is what makes two writers take turns in the first place.
 */
export function sameStamp(a: DocStamp, b: DocStamp): boolean {
  return a.mtimeNs === b.mtimeNs && a.size === b.size;
}
