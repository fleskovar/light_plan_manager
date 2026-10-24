import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BoardError,
  USER_HOME_ENV_VAR,
  findBoardPaths,
  initBoard,
  loadBoard,
  readStorePointer,
} from '../src/core/index.js';

// `initBoard({ store: 'central' })` writes the board documents to
// `<central_store>/.lpm_central/<name>/`, a pointer to `<project>/.lpm/config.yml`
// and `project.json` to the central board folder (LPM-18).

const scratch: string[] = [];
let home: string;
let store: string;
const savedHome = process.env[USER_HOME_ENV_VAR];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/** A project folder called `name`, in a new temporary parent folder. */
function project(name = 'shop'): string {
  const dir = path.join(tempDir('lpm-parent-'), name);
  mkdirSync(dir);
  return dir;
}

function useCentralStore(dir: string | null): void {
  if (dir === null) rmSync(path.join(home, 'settings.json'), { force: true });
  else writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ central_store: dir }));
}

function initCentral(root: string, options: { git?: boolean } = {}) {
  return initBoard({ root, store: 'central', git: options.git ?? false, today: '2026-08-10' });
}

beforeEach(() => {
  home = tempDir('lpm-home-');
  store = tempDir('lpm-store-');
  process.env[USER_HOME_ENV_VAR] = home;
  useCentralStore(store);
});

afterEach(() => {
  if (savedHome === undefined) delete process.env[USER_HOME_ENV_VAR];
  else process.env[USER_HOME_ENV_VAR] = savedHome;
});

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe('initBoard with store: central', () => {
  it('writes the board to <central_store>/.lpm_central/<name>', () => {
    const root = project('shop');
    const result = initCentral(root);

    const central = path.join(store, '.lpm_central', 'shop');
    expect(result.store).toBe('central');
    expect(result.paths.lpmDir).toBe(central);
    expect(result.paths.root).toBe(root);
    expect(existsSync(path.join(central, 'config.yml'))).toBe(true);
    expect(existsSync(path.join(central, 'board'))).toBe(true);
    expect(existsSync(path.join(central, 'state.json'))).toBe(true);
    expect(existsSync(path.join(central, 'INDEX.md'))).toBe(true);
  });

  it('writes a pointer that holds only the key store', () => {
    const root = project();
    const result = initCentral(root);

    const pointer = path.join(root, '.lpm', 'config.yml');
    expect(readStorePointer(pointer)).toBe(result.paths.lpmDir);
    const keys = readFileSync(pointer, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.startsWith('#'));
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^store: /);
    expect(readdirSync(path.join(root, '.lpm'))).toEqual(['config.yml']);
  });

  it('writes project.json with the project folder', () => {
    const root = project();
    const result = initCentral(root);
    const file = JSON.parse(readFileSync(path.join(result.paths.lpmDir, 'project.json'), 'utf8')) as unknown;
    expect(file).toEqual({ project_path: root });
  });

  it('lists project.json, local.json and credentials.json in the board .gitignore', () => {
    const result = initCentral(project());
    const lines = readFileSync(path.join(result.paths.lpmDir, '.gitignore'), 'utf8').split(/\r?\n/);
    expect(lines).toContain('project.json');
    expect(lines).toContain('local.json');
    expect(lines).toContain('credentials.json');
  });

  it('runs git init in the central board folder, not in the project .lpm', () => {
    const root = project();
    const result = initCentral(root, { git: true });
    expect(result.gitInitialized).toBe(true);
    expect(existsSync(path.join(result.paths.lpmDir, '.git'))).toBe(true);
    expect(existsSync(path.join(root, '.lpm', '.git'))).toBe(false);
  });

  it('adds .lpm/ to the .gitignore of a project that is a git repository', () => {
    const root = project();
    spawnSync('git', ['init'], { cwd: root });
    const result = initCentral(root, { git: true });
    expect(result.gitignoreUpdated).toBe(true);
    expect(readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/)).toContain('.lpm/');
  });

  it('gives a board that findBoardPaths finds and loadBoard loads, with the omni periods', () => {
    const root = project();
    initBoard({ root, store: 'central', git: false, omni: true, today: '2026-08-10' });

    const board = loadBoard(findBoardPaths(root)!);
    expect(board.periods.length).toBeGreaterThan(0);
    expect(board.paths.root).toBe(root);
  });

  it('gives two projects of the same name their own folders', () => {
    const one = initCentral(project('shop'));
    const two = initCentral(project('shop'));
    expect(path.basename(one.paths.lpmDir)).toBe('shop');
    expect(path.basename(two.paths.lpmDir)).toBe('shop-2');
  });

  it('throws a BoardError that names lpm config set central_store without a central store', () => {
    useCentralStore(null);
    const root = project();
    expect(() => initCentral(root)).toThrow(BoardError);
    expect(() => initCentral(root)).toThrow(/central_store/);
    expect(existsSync(path.join(root, '.lpm'))).toBe(false);
  });

  it('refuses a second board in the same project', () => {
    const root = project();
    initCentral(root);
    expect(() => initCentral(root)).toThrow(/A board already exists/);
    expect(() => initBoard({ root, git: false })).toThrow(/A board already exists/);
  });

  it('removes the central board folder and the pointer when it fails', () => {
    const root = project();
    expect(() => initBoard({ root, store: 'central', template: 'no-such-template', git: false })).toThrow();
    expect(existsSync(path.join(root, '.lpm'))).toBe(false);
    expect(readdirSync(path.join(store, '.lpm_central')).length).toBe(0);
  });
});

describe('initBoard with store: local or no store', () => {
  it('creates a local board, as before', () => {
    const root = project();
    const result = initBoard({ root, git: false });
    expect(result.store).toBe('local');
    expect(result.paths.lpmDir).toBe(path.join(root, '.lpm'));
    expect(existsSync(path.join(root, '.lpm', 'project.json'))).toBe(false);
    expect(existsSync(path.join(store, '.lpm_central'))).toBe(false);
  });

  it('creates a local board for store: local even with a central store', () => {
    const root = project();
    const result = initBoard({ root, store: 'local', git: false });
    expect(result.paths.lpmDir).toBe(path.join(root, '.lpm'));
  });
});
