import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { BoardError } from '../errors.js';
import { sleepSync } from './atomic.js';

/**
 * Copying a folder tree and checking the copy, for the operations that move a
 * board, back it up and restore it (`operations/relocate.ts`,
 * `operations/backup.ts`).
 *
 * `listTree` records every folder and file below a folder, with the size of
 * each file. `copyTree` and `copyTreeAsync` copy the listed entries and report
 * the bytes that they copied. `compareTrees` and `compareTreesAsync` compare
 * the file list, the size and the SHA-256 digest of each file in two folders.
 * The async versions let a server answer other requests during a long copy.
 * The sync versions serve the CLI, which has nothing else to do meanwhile.
 *
 * Symbolic links are not copied and not compared. A board holds none.
 *
 * A checked copy compares the two trees after the copy. A program that writes
 * below the source during the copy makes the trees differ. Git does this: after
 * each `git commit`, git starts `git maintenance run --auto --detach`. That
 * background process can repack `.git/objects` while the board is copied. When
 * the comparison finds a difference, the checked copy discards the copy, waits
 * for the next delay in `COPY_RETRY_DELAYS_MS`, and copies again. After the
 * last delay, the next difference fails the copy. An error of the copy itself
 * fails the copy at once.
 */

/** The waits before the second and the third attempt of a checked copy, in milliseconds. */
export const COPY_RETRY_DELAYS_MS: readonly number[] = [1000, 3000];

/** One folder or file below the root of a tree. */
export interface TreeEntry {
  /** The path relative to the root of the tree. */
  relative: string;
  kind: 'dir' | 'file';
  /** The size in bytes. 0 for a folder. */
  size: number;
}

/** Decides which relative paths `listTree` leaves out. A left-out folder is left out with its content. */
export type TreeSkip = (relative: string) => boolean;

/** Bytes copied or compared so far, and the bytes of the whole step. */
export type ByteProgress = (done: number, total: number) => void;

/** Every folder and file below `dir`, parents before children, without the paths that `skip` names. */
export function listTree(dir: string, skip: TreeSkip = () => false): TreeEntry[] {
  const result: TreeEntry[] = [];
  const walk = (current: string): void => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const relative = path.relative(dir, full);
      if (skip(relative)) continue;
      if (entry.isDirectory()) {
        result.push({ relative, kind: 'dir', size: 0 });
        walk(full);
      } else if (entry.isFile()) {
        result.push({ relative, kind: 'file', size: statSync(full).size });
      }
    }
  };
  walk(dir);
  return result;
}

/** The bytes of all files of a tree. */
export function treeBytes(entries: readonly TreeEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.size, 0);
}

/** Copy `entries` from `source` into `target`. `target` is created. A file that exists already is overwritten. */
export function copyTree(source: string, target: string, entries: readonly TreeEntry[], onProgress?: ByteProgress): void {
  const total = treeBytes(entries);
  let done = 0;
  mkdirSync(target, { recursive: true });
  for (const entry of entries) {
    const to = path.join(target, entry.relative);
    if (entry.kind === 'dir') {
      mkdirSync(to, { recursive: true });
      continue;
    }
    copyFileSync(path.join(source, entry.relative), to);
    done += entry.size;
    onProgress?.(done, total);
  }
}

/** `copyTree` with async file calls, so the event loop runs between two files. */
export async function copyTreeAsync(
  source: string,
  target: string,
  entries: readonly TreeEntry[],
  onProgress?: ByteProgress,
): Promise<void> {
  const total = treeBytes(entries);
  let done = 0;
  await mkdir(target, { recursive: true });
  for (const entry of entries) {
    const to = path.join(target, entry.relative);
    if (entry.kind === 'dir') {
      await mkdir(to, { recursive: true });
      continue;
    }
    await copyFile(path.join(source, entry.relative), to);
    done += entry.size;
    onProgress?.(done, total);
  }
}

function digest(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** The first difference between the expected entries and the entries of the copy, or null. */
function listDifference(expected: readonly TreeEntry[], copied: readonly TreeEntry[]): string | null {
  const byPath = new Map(copied.map((entry) => [entry.relative, entry]));
  for (const entry of expected) {
    const other = byPath.get(entry.relative);
    if (!other) return `${entry.relative} is missing from the copy`;
    if (other.kind !== entry.kind) return `${entry.relative} is a ${other.kind === 'dir' ? 'folder' : 'file'} in the copy`;
    if (other.size !== entry.size) return `${entry.relative} has another size in the copy`;
    byPath.delete(entry.relative);
  }
  const extra = byPath.keys().next();
  return extra.done ? null : `${extra.value} is in the copy only`;
}

/**
 * The names in the top folder of a copy target that were there before the
 * copy. The copy must not write them. The comparison leaves them out of the
 * target, and a failed copy keeps them.
 */
export type KeptNames = readonly string[];

function keptSkip(keep: KeptNames): TreeSkip {
  return (relative) => keep.includes(relative);
}

/**
 * Compare the tree of `source` with the tree of `target`: the same folders and
 * files, the same sizes and the same SHA-256 digests. `skip` applies to the
 * source only. `keep` leaves names out of the top folder of `target`. Returns
 * the first difference, or null when the trees match.
 */
export function compareTrees(
  source: string,
  target: string,
  skip: TreeSkip = () => false,
  onProgress?: ByteProgress,
  keep: KeptNames = [],
): string | null {
  const expected = listTree(source, skip);
  const problem = listDifference(expected, listTree(target, keptSkip(keep)));
  if (problem) return problem;
  const total = treeBytes(expected);
  let done = 0;
  for (const entry of expected) {
    if (entry.kind === 'dir') continue;
    const left = digest(readFileSync(path.join(source, entry.relative)));
    const right = digest(readFileSync(path.join(target, entry.relative)));
    if (left !== right) return `${entry.relative} has other content in the copy`;
    done += entry.size;
    onProgress?.(done, total);
  }
  return null;
}

/** `compareTrees` with async reads, so the event loop runs between two files. */
export async function compareTreesAsync(
  source: string,
  target: string,
  skip: TreeSkip = () => false,
  onProgress?: ByteProgress,
  keep: KeptNames = [],
): Promise<string | null> {
  const expected = listTree(source, skip);
  const problem = listDifference(expected, listTree(target, keptSkip(keep)));
  if (problem) return problem;
  const total = treeBytes(expected);
  let done = 0;
  for (const entry of expected) {
    if (entry.kind === 'dir') continue;
    const left = digest(await readFile(path.join(source, entry.relative)));
    const right = digest(await readFile(path.join(target, entry.relative)));
    if (left !== right) return `${entry.relative} has other content in the copy`;
    done += entry.size;
    onProgress?.(done, total);
  }
  return null;
}

/** The progress of a checked copy: the copy first, then the comparison. */
export interface CheckedCopyProgress {
  phase: 'copy' | 'compare';
  done: number;
  total: number;
}

function incomplete(problem: string, consequence: string): BoardError {
  return new BoardError(`The copy of the board is not complete: ${problem}`, [consequence]);
}

/**
 * Undo a failed copy. Without `keep`, remove the folder `target`. With `keep`,
 * remove each entry of the top folder of `target` that `keep` does not name,
 * and keep the folder.
 */
export function discardCopy(target: string, keep: KeptNames = []): void {
  if (keep.length === 0) {
    rmSync(target, { recursive: true, force: true });
    return;
  }
  let names: string[];
  try {
    names = readdirSync(target);
  } catch {
    return;
  }
  for (const name of names) {
    if (!keep.includes(name)) rmSync(path.join(target, name), { recursive: true, force: true });
  }
}

/**
 * Copy `source` into `target`, then compare the two trees. `target` is a new
 * folder, or with `keep` an existing folder that holds only the names in
 * `keep`. `skip` must leave those names out of the copy. When the trees
 * differ, the call copies again after each delay in `COPY_RETRY_DELAYS_MS`.
 * On a failure, `discardCopy` undoes the copy, and the call throws a
 * `BoardError` that holds `consequence` as its hint. `source` is never changed.
 */
export async function copyCheckedAsync(
  source: string,
  target: string,
  skip: TreeSkip,
  consequence: string,
  onProgress?: (progress: CheckedCopyProgress) => void,
  keep: KeptNames = [],
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    let problem: string | null;
    try {
      const entries = listTree(source, skip);
      await copyTreeAsync(source, target, entries, (done, total) => onProgress?.({ phase: 'copy', done, total }));
      problem = await compareTreesAsync(
        source,
        target,
        skip,
        (done, total) => onProgress?.({ phase: 'compare', done, total }),
        keep,
      );
    } catch (error) {
      discardCopy(target, keep);
      throw error;
    }
    if (problem === null) return;
    discardCopy(target, keep);
    const delay = COPY_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) throw incomplete(problem, consequence);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

/**
 * Run `copy`, which copies `source` into `target`, then compare the two trees.
 * The rules of `copyCheckedAsync` apply, with sync file calls. A caller that
 * copies with its own function, such as `operations/relocate.ts`, passes it.
 */
export function copyCheckedWith(
  copy: () => void,
  source: string,
  target: string,
  skip: TreeSkip,
  consequence: string,
  keep: KeptNames = [],
): void {
  for (let attempt = 0; ; attempt++) {
    let problem: string | null;
    try {
      copy();
      problem = compareTrees(source, target, skip, undefined, keep);
    } catch (error) {
      discardCopy(target, keep);
      throw error;
    }
    if (problem === null) return;
    discardCopy(target, keep);
    const delay = COPY_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) throw incomplete(problem, consequence);
    sleepSync(delay);
  }
}

/** `copyCheckedAsync` with sync file calls, for the CLI. */
export function copyCheckedSync(source: string, target: string, skip: TreeSkip, consequence: string, keep: KeptNames = []): void {
  copyCheckedWith(() => copyTree(source, target, listTree(source, skip)), source, target, skip, consequence, keep);
}

/** A sibling path of `dir` that does not exist yet, for a rename inside one parent folder. */
export function freeSibling(dir: string, label: string): string {
  for (let attempt = 0; ; attempt++) {
    const candidate = `${dir}.${label}-${process.pid}-${attempt}`;
    if (!existsSync(candidate)) return candidate;
  }
}

/** Remove a folder, or add a warning to `warnings` when the platform refuses. */
export function removeTreeOrWarn(dir: string, warnings: string[]): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch (error) {
    warnings.push(`Could not delete ${dir}: ${(error as Error).message}. Delete it by hand.`);
  }
}

/**
 * Remove each entry of the folder `dir` that `keep` does not name, and keep
 * the folder. An entry that the platform refuses to remove adds a warning to
 * `warnings`, and the other entries are still removed.
 */
export function removeEntriesOrWarn(dir: string, keep: (name: string) => boolean, warnings: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    warnings.push(`Could not read ${dir}: ${(error as Error).message}. Delete its old files by hand.`);
    return;
  }
  for (const name of names) {
    if (!keep(name)) removeTreeOrWarn(path.join(dir, name), warnings);
  }
}
