import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  BOARD_ENV_VAR,
  BoardError,
  boardPathsAt,
  boardPathsFor,
  displayPath,
  findBoardPaths,
  loadBoard,
} from '../src/core/index.js';
import { cleanupBoards, makeBoard, makeCentralBoard } from './helpers.js';

// A central board keeps its documents in `<store>/.lpm_central/<name>/`, and
// the project keeps a `.lpm/config.yml` that holds only the key `store`. These
// tests state how `lpm` finds such a board (LPM-5, LPM-6).

const scratch: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env[BOARD_ENV_VAR];
});

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  cleanupBoards();
});

describe('boardPathsAt with a separate root', () => {
  it('keeps the root it is given and puts every other path in the board folder', () => {
    const project = tempDir('lpm-project-');
    const lpmDir = path.join(tempDir('lpm-store-'), '.lpm_central', 'shop');

    const paths = boardPathsAt(lpmDir, { root: project });

    expect(paths.root).toBe(project);
    expect(paths.lpmDir).toBe(lpmDir);
    expect(paths.configPath).toBe(path.join(lpmDir, 'config.yml'));
    expect(paths.boardDir).toBe(path.join(lpmDir, 'board'));
    expect(paths.localPath).toBe(path.join(lpmDir, 'local.json'));
    expect(paths.lockPath).toBe(path.join(lpmDir, 'lock'));
  });

  it('derives the root from the parent of the board folder when no root is given', () => {
    const project = tempDir('lpm-project-');
    const paths = boardPathsAt(path.join(project, '.lpm'));
    expect(paths.root).toBe(project);
  });
});

describe('findBoardPaths on a project with a store pointer', () => {
  it('returns the project as root and the central board folder as lpmDir', () => {
    const central = makeCentralBoard();

    const paths = findBoardPaths(central.project);

    expect(paths).not.toBeNull();
    expect(paths!.root).toBe(central.project);
    expect(paths!.lpmDir).toBe(central.lpmDir);
    expect(paths!.configPath).toBe(path.join(central.lpmDir, 'config.yml'));
    expect(paths!.boardDir).toBe(path.join(central.lpmDir, 'board'));
  });

  it('finds the same board from a subfolder of the project', () => {
    const central = makeCentralBoard();
    const deep = path.join(central.project, 'src', 'deep');
    mkdirSync(deep, { recursive: true });

    const paths = findBoardPaths(deep);

    expect(paths!.root).toBe(central.project);
    expect(paths!.lpmDir).toBe(central.lpmDir);
  });

  it('loads the board from the central board folder', () => {
    const central = makeCentralBoard({ prefix: 'SHOP' });
    const board = loadBoard(findBoardPaths(central.project)!);
    expect(board.config.key_prefix).toBe('SHOP');
  });

  it('throws a BoardError when the pointer names a folder without config.yml', () => {
    const central = makeCentralBoard();
    rmSync(central.lpmDir, { recursive: true, force: true });

    expect(() => findBoardPaths(central.project)).toThrow(BoardError);
    expect(() => findBoardPaths(central.project)).toThrow(/holds no board/);
  });

  it('throws a BoardError when the pointer names another pointer', () => {
    const central = makeCentralBoard();
    const second = tempDir('lpm-second-');
    mkdirSync(path.join(second, '.lpm'));
    writeFileSync(
      path.join(second, '.lpm', 'config.yml'),
      `store: ${JSON.stringify(path.join(central.project, '.lpm'))}\n`,
      'utf8',
    );

    expect(() => findBoardPaths(second)).toThrow(BoardError);
    expect(() => findBoardPaths(second)).toThrow(/another pointer/);
  });
});

describe('findBoardPaths on a local board', () => {
  it('gives the same paths as before central boards existed', () => {
    const local = makeBoard();
    expect(findBoardPaths(local.root)).toEqual(boardPathsFor(local.root));
  });
});

describe('LPM_BOARD_PATH and a central board', () => {
  it('accepts the project folder', () => {
    const central = makeCentralBoard();
    process.env[BOARD_ENV_VAR] = central.project;

    const paths = findBoardPaths()!;
    expect(paths.root).toBe(central.project);
    expect(paths.lpmDir).toBe(central.lpmDir);
  });

  it('accepts the project .lpm folder that holds the pointer', () => {
    const central = makeCentralBoard();
    process.env[BOARD_ENV_VAR] = path.join(central.project, '.lpm');

    const paths = findBoardPaths()!;
    expect(paths.root).toBe(central.project);
    expect(paths.lpmDir).toBe(central.lpmDir);
  });

  it('takes the root from project.json when it names the central board folder', () => {
    const central = makeCentralBoard();
    process.env[BOARD_ENV_VAR] = central.lpmDir;

    const paths = findBoardPaths()!;
    expect(paths.root).toBe(central.project);
    expect(paths.lpmDir).toBe(central.lpmDir);
  });

  it('uses the central board folder as root when project.json is missing', () => {
    const central = makeCentralBoard();
    unlinkSync(path.join(central.lpmDir, 'project.json'));
    process.env[BOARD_ENV_VAR] = central.lpmDir;

    const paths = findBoardPaths()!;
    expect(paths.root).toBe(central.lpmDir);
    expect(paths.lpmDir).toBe(central.lpmDir);
  });
});

describe('displayPath on a central board', () => {
  it('is relative to the parent of the central board folder', () => {
    const central = makeCentralBoard({ name: 'shop' });
    const paths = findBoardPaths(central.project)!;
    const file = path.join(paths.boardDir, 'LP-1', '_issue.md');

    expect(displayPath(paths, file)).toBe('shop/board/LP-1/_issue.md');
  });

  it('is relative to the parent of the board folder when the root is elsewhere', () => {
    const project = tempDir('lpm-project-');
    const lpmDir = path.join(tempDir('lpm-store-'), '.lpm_central', 'shop');
    const paths = boardPathsAt(lpmDir, { root: project });

    expect(displayPath(paths, paths.configPath)).toBe('shop/config.yml');
  });

  it('does not change for a local board', () => {
    const local = makeBoard();
    expect(displayPath(local, local.configPath)).toBe('.lpm/config.yml');
  });
});
