import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BoardPaths, LoadedBoard } from '../src/core/index.js';
import { ISSUE_FILE, initBoard, loadBoard } from '../src/core/index.js';

const created: string[] = [];

/**
 * A throwaway board on disk. Registered for cleanup by `cleanupBoards()`.
 *
 * Without the omni periods `lpm init` seeds by default, so a test states its
 * own timeline; pass `{ omni: true }` to get the board a person would.
 */
export function makeBoard(template = 'scrum', prefix = 'LP', options: { omni?: boolean } = {}): BoardPaths {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lpm-test-'));
  created.push(root);
  return initBoard({ root, template, prefix, git: false, omni: options.omni ?? false, today: '2026-08-10' }).paths;
}

export function cleanupBoards(): void {
  for (const root of created.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
}

export function reload(paths: BoardPaths): LoadedBoard {
  return loadBoard(paths);
}

/**
 * Write a raw document, as a user editing the folder by hand would.
 * Pass PERIOD_FILE as `fileName` to hand-write a period instead of an issue.
 */
export function writeRawIssue(dir: string, content: string, fileName = ISSUE_FILE): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName);
  writeFileSync(file, content, 'utf8');
  return file;
}

export function boardPath(paths: BoardPaths, ...segments: string[]): string {
  return path.join(paths.boardDir, ...segments);
}

/**
 * The arguments an MCP host config passes to `lpm`, with the launcher removed.
 *
 * `lpm mcp setup` and `lpm agent` write `lpm mcp …` when `lpm` is on the PATH
 * and `node <this checkout's CLI> mcp …` when it is not — both correct, and which
 * one a test sees depends on the machine (a developer who ran `npm link` gets
 * the first, a CI runner the second). Asserting on `args` directly made those
 * tests pass on one and fail on the other; `launchCommand`'s own tests cover
 * the choice itself.
 */
export function lpmArgs(entry: { command: string; args: string[] }): string[] {
  return entry.command === 'lpm' ? entry.args : entry.args.slice(1);
}
