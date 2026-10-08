import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  BOARD_ENV_VAR,
  BoardError,
  boardPathsFor,
  displayPath,
  findBoardPaths,
  initBoard,
  loadBoard,
} from '../src/core/index.js';
import { cleanupBoards, makeBoard } from './helpers.js';

const elsewhere: string[] = [];

/** A directory that is nothing to do with any board, to stand in for "anywhere". */
function unrelatedDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lpm-away-'));
  elsewhere.push(dir);
  return dir;
}

const home = process.cwd();

/** Stand where a user with no board under them would be standing. */
function standAnywhere(): string {
  const dir = unrelatedDir();
  process.chdir(dir);
  return dir;
}

afterEach(() => {
  process.chdir(home);
  delete process.env[BOARD_ENV_VAR];
});

afterAll(() => {
  for (const dir of elsewhere) rmSync(dir, { recursive: true, force: true });
  cleanupBoards();
});

describe('LPM_BOARD_PATH', () => {
  it('finds the board from a folder with no board anywhere above it', () => {
    const board = makeBoard();
    standAnywhere();
    expect(findBoardPaths()).toBeNull();

    process.env[BOARD_ENV_VAR] = board.lpmDir;
    const found = findBoardPaths();
    expect(found).not.toBeNull();
    expect(found!.lpmDir).toBe(board.lpmDir);
  });

  it('accepts the folder holding the .lpm as well as the .lpm itself', () => {
    const board = makeBoard();
    standAnywhere();
    process.env[BOARD_ENV_VAR] = board.root;

    expect(findBoardPaths()!.lpmDir).toBe(board.lpmDir);
  });

  it('keeps root and lpmDir in step, so paths still report sensibly', () => {
    const board = makeBoard();
    process.env[BOARD_ENV_VAR] = board.lpmDir;

    const found = findBoardPaths()!;
    expect(found.root).toBe(board.root);
    expect(found.boardDir).toBe(board.boardDir);
    expect(displayPath(found, found.configPath)).toBe('.lpm/config.yml');
  });

  it('loads the board it names', () => {
    const board = makeBoard();
    process.env[BOARD_ENV_VAR] = board.lpmDir;

    const loaded = loadBoard(findBoardPaths()!);
    expect(loaded.config.key_prefix).toBe('LP');
  });

  it('throws when it names no board, rather than searching from the cwd', () => {
    process.env[BOARD_ENV_VAR] = unrelatedDir();
    expect(() => findBoardPaths()).toThrow(BoardError);
    expect(() => findBoardPaths()).toThrow(BOARD_ENV_VAR);
  });

  it('is ignored when a folder is asked about in particular', () => {
    const board = makeBoard();
    const other = makeBoard();
    process.env[BOARD_ENV_VAR] = other.lpmDir;

    expect(findBoardPaths(board.root)!.lpmDir).toBe(board.lpmDir);
  });

  it('is ignored by init, which always creates the board where it was told', () => {
    const other = makeBoard();
    process.env[BOARD_ENV_VAR] = other.lpmDir;

    const root = unrelatedDir();
    const created = initBoard({ root, git: false }).paths;
    expect(created.lpmDir).toBe(boardPathsFor(root).lpmDir);
    expect(created.lpmDir).not.toBe(other.lpmDir);
  });

  it('leaves the search alone when it is not set', () => {
    const board = makeBoard();
    expect(findBoardPaths(board.boardDir)!.lpmDir).toBe(board.lpmDir);
    expect(findBoardPaths(unrelatedDir())).toBeNull();
  });
});
