import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BoardPaths, LoadedBoard, PlanningMode } from '../src/core/index.js';
import { ISSUE_FILE, boardPathsAt, ensureLocalIgnored, initBoard, loadBoard } from '../src/core/index.js';

const created: string[] = [];

/**
 * A throwaway board on disk. Registered for cleanup by `cleanupBoards()`.
 *
 * Without the omni periods `lpm init` seeds by default, so a test states its
 * own timeline; pass `{ omni: true }` to get the board a person would.
 *
 * In `periods` mode, although `lpm init` starts a board in `queue` mode: most
 * tests build a timeline to check what a sprint does to the queue, and queue
 * mode ignores every sprint. Pass `{ planning: 'queue' }` for the default board.
 */
export function makeBoard(
  template = 'scrum',
  prefix = 'LP',
  options: { omni?: boolean; planning?: PlanningMode } = {},
): BoardPaths {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lpm-test-'));
  created.push(root);
  return initBoard({
    root,
    template,
    prefix,
    git: false,
    omni: options.omni ?? false,
    planning: options.planning ?? 'periods',
    today: '2026-08-10',
  }).paths;
}

/** A board whose documents live in a central store, and the project that points at it. */
export interface CentralBoardFixture {
  /** The project folder. Its `.lpm/config.yml` holds only the pointer. */
  project: string;
  /** The central store: the folder that holds `.lpm_central`. */
  store: string;
  /** The central board folder, `<store>/.lpm_central/<name>`. */
  lpmDir: string;
}

/**
 * A central board built by hand, so that the tests of board resolution do not
 * depend on `lpm init --central`.
 *
 * The helper creates a local board, moves its `.lpm` folder to
 * `<store>/.lpm_central/<name>`, and writes the pointer `store: <path>` to
 * `<project>/.lpm/config.yml`. With `projectFile: true` (the default) it also
 * writes `project.json`, which names the project folder.
 */
export function makeCentralBoard(
  options: { name?: string; prefix?: string; projectFile?: boolean } = {},
): CentralBoardFixture {
  const local = makeBoard('scrum', options.prefix ?? 'LP');
  const project = local.root;
  const store = mkdtempSync(path.join(os.tmpdir(), 'lpm-store-'));
  created.push(store);
  const lpmDir = path.join(store, '.lpm_central', options.name ?? path.basename(project));
  mkdirSync(path.dirname(lpmDir), { recursive: true });
  renameSync(local.lpmDir, lpmDir);
  mkdirSync(local.lpmDir);
  writeFileSync(path.join(local.lpmDir, 'config.yml'), `store: ${JSON.stringify(lpmDir)}\n`, 'utf8');
  ensureLocalIgnored(boardPathsAt(lpmDir, { root: project }));
  if (options.projectFile !== false) {
    writeFileSync(
      path.join(lpmDir, 'project.json'),
      `${JSON.stringify({ project_path: project }, null, 2)}\n`,
      'utf8',
    );
  }
  return { project, store, lpmDir };
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
