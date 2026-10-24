import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  USER_HOME_ENV_VAR,
  findBoardPaths,
  forgetProject,
  initBoard,
  listProjects,
  pruneProjects,
  recordProject,
  relocateBoard,
} from '../src/core/index.js';

// The project index: `projects.json` in the user folder lists every project
// that `lpm` worked on (LPM-44). `listProjects` joins it with the central boards.

const scratch: string[] = [];
let home: string;
let store: string;
const savedHome = process.env[USER_HOME_ENV_VAR];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function project(name: string, where: 'local' | 'central' = 'local', prefix = 'LP') {
  const root = path.join(tempDir('lpm-parent-'), name);
  mkdirSync(root);
  return initBoard({ root, prefix, git: false, omni: false, store: where }).paths;
}

function indexFile(): unknown {
  return JSON.parse(readFileSync(path.join(home, 'projects.json'), 'utf8'));
}

beforeEach(() => {
  home = tempDir('lpm-home-');
  store = tempDir('lpm-store-');
  process.env[USER_HOME_ENV_VAR] = home;
  writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ central_store: store }));
});

afterEach(() => {
  if (savedHome === undefined) delete process.env[USER_HOME_ENV_VAR];
  else process.env[USER_HOME_ENV_VAR] = savedHome;
});

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe('recordProject', () => {
  it('adds an entry with the project folder, the board folder, the store and the time', () => {
    const paths = project('shop');

    recordProject(paths, new Date('2026-10-24T10:00:00Z'));

    expect(indexFile()).toEqual({
      projects: [{ root: paths.root, lpmDir: paths.lpmDir, store: 'local', lastUsed: '2026-10-24T10:00:00.000Z' }],
    });
  });

  it('updates the entry of a project that is already in the index', () => {
    const paths = project('shop');
    recordProject(paths, new Date('2026-10-24T10:00:00Z'));
    recordProject(paths, new Date('2026-10-25T10:00:00Z'));

    const index = indexFile() as { projects: { lastUsed: string }[] };
    expect(index.projects).toHaveLength(1);
    expect(index.projects[0]!.lastUsed).toBe('2026-10-25T10:00:00.000Z');
  });

  it.runIf(process.platform === 'win32')('treats two spellings that differ only in case as one project on Windows', () => {
    const paths = project('shop');
    recordProject(paths);
    recordProject({ ...paths, root: paths.root.toUpperCase() });
    expect((indexFile() as { projects: unknown[] }).projects).toHaveLength(1);
  });

  it('stores a central board with store central and the central board folder', () => {
    const paths = project('shop', 'central');
    recordProject(paths);
    const [entry] = (indexFile() as { projects: { store: string; lpmDir: string }[] }).projects;
    expect(entry).toMatchObject({ store: 'central', lpmDir: path.join(store, '.lpm_central', 'shop') });
  });

  it('replaces a projects.json that does not parse', () => {
    writeFileSync(path.join(home, 'projects.json'), '{ not json');
    const paths = project('shop');
    recordProject(paths);
    expect((indexFile() as { projects: unknown[] }).projects).toHaveLength(1);
  });
});

describe('listProjects', () => {
  it('lists local and central projects, with the key prefix and the state', () => {
    const shop = project('shop', 'local', 'SHOP');
    const blog = project('blog', 'central', 'BLOG');
    recordProject(shop);
    recordProject(blog);

    const list = listProjects();

    expect(list.map((entry) => [entry.name, entry.store, entry.keyPrefix, entry.state])).toEqual([
      ['blog', 'central', 'BLOG', 'ok'],
      ['shop', 'local', 'SHOP', 'ok'],
    ]);
    expect(list[1]).toMatchObject({ root: shop.root, lpmDir: shop.lpmDir });
  });

  it('lists a central board that no command recorded, with lastUsed null', () => {
    const blog = project('blog', 'central', 'BLOG');
    const [entry] = listProjects();
    expect(entry).toMatchObject({ name: 'blog', root: blog.root, store: 'central', lastUsed: null, state: 'ok' });
  });

  it('gives an empty list for an empty user folder', () => {
    expect(listProjects()).toEqual([]);
  });

  it('marks a central board whose project folder is gone as project missing', () => {
    const blog = project('blog', 'central');
    recordProject(blog);
    rmSync(blog.root, { recursive: true, force: true });
    expect(listProjects()[0]!.state).toBe('project missing');
  });

  it('marks a local project whose folder is gone as missing', () => {
    const shop = project('shop');
    recordProject(shop);
    rmSync(shop.root, { recursive: true, force: true });
    expect(listProjects()[0]).toMatchObject({ name: 'shop', state: 'missing', keyPrefix: null });
  });

  it('follows a board that moved from the project to the central store', () => {
    const shop = project('shop');
    recordProject(shop);
    relocateBoard(shop, 'central');

    const [entry] = listProjects();

    expect(entry).toMatchObject({ store: 'central', lpmDir: path.join(store, '.lpm_central', 'shop'), state: 'ok' });
    expect(listProjects()).toHaveLength(1);
    expect(findBoardPaths(shop.root)!.lpmDir).toBe(entry!.lpmDir);
  });
});

describe('forgetProject and pruneProjects', () => {
  it('forgets one project and returns true, or false for an unknown folder', () => {
    const shop = project('shop');
    recordProject(shop);
    expect(forgetProject(shop.root)).toBe(true);
    expect(forgetProject(shop.root)).toBe(false);
    expect(listProjects()).toEqual([]);
  });

  it('prunes the projects in the state missing, and returns their folders', () => {
    const shop = project('shop');
    const blog = project('blog');
    recordProject(shop);
    recordProject(blog);
    rmSync(shop.root, { recursive: true, force: true });

    expect(pruneProjects()).toEqual([shop.root]);
    expect(listProjects().map((entry) => entry.name)).toEqual(['blog']);
  });
});
