import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BoardPaths } from '../src/core/index.js';
import {
  BoardError,
  USER_HOME_ENV_VAR,
  abandonCentralStore,
  centralStorePath,
  createIssue,
  findBoardPaths,
  initBoard,
  loadBoard,
  moveCentralStore,
  readStorePointer,
  recordProject,
} from '../src/core/index.js';

// Changing the central store (LPM-48): move every board to the new store, or
// abandon the old store and keep its boards where they are.

const scratch: string[] = [];
let home: string;
let oldStore: string;
const savedHome = process.env[USER_HOME_ENV_VAR];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function centralProject(name: string, options: { git?: boolean } = {}): BoardPaths {
  const root = path.join(tempDir('lpm-parent-'), name);
  mkdirSync(root);
  const paths = initBoard({ root, prefix: 'LP', git: options.git ?? false, omni: false, store: 'central' }).paths;
  createIssue(loadBoard(paths), { type: 'program', title: `Work of ${name}` });
  if (options.git) {
    git(paths.lpmDir, 'add', '-A');
    git(paths.lpmDir, 'commit', '-q', '-m', 'board');
  }
  return paths;
}

beforeEach(() => {
  home = tempDir('lpm-home-');
  oldStore = tempDir('lpm-old-store-');
  process.env[USER_HOME_ENV_VAR] = home;
  writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ central_store: oldStore }));
});

afterEach(() => {
  if (savedHome === undefined) delete process.env[USER_HOME_ENV_VAR];
  else process.env[USER_HOME_ENV_VAR] = savedHome;
});

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe('moveCentralStore', () => {
  it('moves each board, rewrites each pointer, removes the old .lpm_central and sets the key', () => {
    const shop = centralProject('shop', { git: true });
    const blog = centralProject('blog');
    const head = git(shop.lpmDir, 'rev-parse', 'HEAD');
    const newStore = tempDir('lpm-new-store-');

    const result = moveCentralStore(newStore);

    expect(result.failure).toBeNull();
    expect(result.moved.map((board) => board.name).sort()).toEqual(['blog', 'shop']);
    expect(centralStorePath()).toBe(newStore);
    expect(existsSync(path.join(oldStore, '.lpm_central'))).toBe(false);
    for (const [paths, name] of [
      [shop, 'shop'],
      [blog, 'blog'],
    ] as const) {
      const moved = path.join(newStore, '.lpm_central', name);
      expect(readStorePointer(path.join(paths.root, '.lpm', 'config.yml'))).toBe(moved);
      expect(findBoardPaths(paths.root)!.lpmDir).toBe(moved);
      expect(loadBoard(findBoardPaths(paths.root)!).issues[0]!.title).toBe(`Work of ${name}`);
    }
    const movedShop = path.join(newStore, '.lpm_central', 'shop');
    expect(git(movedShop, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(movedShop, 'status', '--porcelain')).toBe('');
  });

  it('gives a board whose name is taken in the new store the next free name', () => {
    const shop = centralProject('shop');
    const newStore = tempDir('lpm-new-store-');
    mkdirSync(path.join(newStore, '.lpm_central', 'shop'), { recursive: true });
    writeFileSync(path.join(newStore, '.lpm_central', 'shop', 'config.yml'), 'key_prefix: OTHER\n');

    moveCentralStore(newStore);

    const moved = path.join(newStore, '.lpm_central', 'shop-2');
    expect(readStorePointer(path.join(shop.root, '.lpm', 'config.yml'))).toBe(moved);
    expect(readFileSync(path.join(newStore, '.lpm_central', 'shop', 'config.yml'), 'utf8')).toBe('key_prefix: OTHER\n');
  });

  it('updates the index entries of the moved boards', () => {
    const shop = centralProject('shop');
    recordProject(shop);
    const newStore = tempDir('lpm-new-store-');

    moveCentralStore(newStore);

    const index = JSON.parse(readFileSync(path.join(home, 'projects.json'), 'utf8')) as { projects: { lpmDir: string }[] };
    expect(index.projects[0]!.lpmDir).toBe(path.join(newStore, '.lpm_central', 'shop'));
  });

  it('stops at a board that fails, keeps the key, and leaves that board where it was', () => {
    centralProject('blog');
    const shop = centralProject('shop');
    const newStore = tempDir('lpm-new-store-');
    const failOnShop = (from: string, to: string, filter: (source: string) => boolean) => {
      if (path.basename(from) === 'shop') throw new Error('disk full');
      cpSync(from, to, { recursive: true, filter });
    };

    const result = moveCentralStore(newStore, { copy: failOnShop });

    expect(result.moved.map((board) => board.name)).toEqual(['blog']);
    expect(result.failure).toMatchObject({ name: 'shop' });
    expect(result.failure!.message).toContain('disk full');
    expect(centralStorePath()).toBe(oldStore);
    expect(findBoardPaths(shop.root)!.lpmDir).toBe(shop.lpmDir);
    expect(readdirSync(path.join(newStore, '.lpm_central'))).toEqual(['blog']);
  });

  it('moves the boards that are left when it runs again after a failure', () => {
    centralProject('blog');
    centralProject('shop');
    const newStore = tempDir('lpm-new-store-');
    moveCentralStore(newStore, {
      copy: (from, to, filter) => {
        if (path.basename(from) === 'shop') throw new Error('disk full');
        cpSync(from, to, { recursive: true, filter });
      },
    });

    const second = moveCentralStore(newStore);

    expect(second.failure).toBeNull();
    expect(second.moved.map((board) => board.name)).toEqual(['shop']);
    expect(centralStorePath()).toBe(newStore);
    expect(readdirSync(path.join(newStore, '.lpm_central')).sort()).toEqual(['blog', 'shop']);
  });

  it('refuses a new store inside the old .lpm_central', () => {
    centralProject('shop');
    const inside = path.join(oldStore, '.lpm_central', 'shop', 'nested');
    expect(() => moveCentralStore(inside)).toThrow(BoardError);
    expect(centralStorePath()).toBe(oldStore);
  });

  it('changes nothing for the folder that is already the store', () => {
    const shop = centralProject('shop');
    const result = moveCentralStore(oldStore);
    expect(result.unchanged).toBe(true);
    expect(findBoardPaths(shop.root)!.lpmDir).toBe(shop.lpmDir);
  });

  it('sets the key when no store was set before', () => {
    rmSync(path.join(home, 'settings.json'));
    const newStore = tempDir('lpm-new-store-');
    const result = moveCentralStore(newStore);
    expect(result.moved).toEqual([]);
    expect(centralStorePath()).toBe(newStore);
  });
});

describe('abandonCentralStore', () => {
  it('writes the key and moves nothing', () => {
    const shop = centralProject('shop');
    const newStore = tempDir('lpm-new-store-');

    abandonCentralStore(newStore);

    expect(centralStorePath()).toBe(newStore);
    expect(findBoardPaths(shop.root)!.lpmDir).toBe(shop.lpmDir);
    expect(existsSync(path.join(newStore, '.lpm_central'))).toBe(false);
  });
});
