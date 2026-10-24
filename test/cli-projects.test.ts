import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

// Each CLI command that finds a board records its project in `projects.json`
// of the user folder, and `lpm projects` lists them (LPM-45). The vitest config
// turns recording off with LPM_PROJECT_INDEX=off, so these cases turn it on.
const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));

const dirs: string[] = [];
let home: string;
let store: string;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  home = tempDir('lpm-home-');
  store = tempDir('lpm-store-');
  writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ central_store: store }));
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface Run {
  status: number;
  stdout: string;
  stderr: string;
  all: string;
}

function lpmIn(dir: string, env: Record<string, string>, ...args: string[]): Run {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LPM_BOARD_PATH: '', LPM_HOME: home, LPM_USER: '', LPM_PROJECT_INDEX: '', ...env },
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { status: result.status ?? 0, stdout, stderr, all: stdout + stderr };
}

const lpm = (dir: string, ...args: string[]) => lpmIn(dir, {}, ...args);

function project(name: string, where: 'local' | 'central'): string {
  const dir = path.join(tempDir('lpm-parent-'), name);
  mkdirSync(dir);
  const run = lpm(dir, 'init', `--${where}`, '--no-git', '--no-omni');
  if (run.status !== 0) throw new Error(run.all);
  return dir;
}

function indexedRoots(): string[] {
  const file = path.join(home, 'projects.json');
  if (!existsSync(file)) return [];
  return (JSON.parse(readFileSync(file, 'utf8')) as { projects: { root: string }[] }).projects.map((entry) => entry.root);
}

describe('recording projects', () => {
  it('lpm init records the new board, local or central', () => {
    const shop = project('shop', 'local');
    const blog = project('blog', 'central');
    expect(indexedRoots().sort()).toEqual([blog, shop].sort());
  });

  it('a command run in a subfolder of a project records the project', () => {
    const shop = project('shop', 'local');
    rmSync(path.join(home, 'projects.json'));
    const deep = path.join(shop, 'src');
    mkdirSync(deep);

    expect(lpm(deep, 'check').status).toBe(0);

    expect(indexedRoots()).toEqual([shop]);
  });

  it('a command in a folder without a board records nothing and still works', () => {
    const run = lpm(tempDir('lpm-empty-'), 'config');
    expect(run.status).toBe(0);
    expect(indexedRoots()).toEqual([]);
  });

  it('a broken projects.json does not make a command fail', () => {
    const shop = project('shop', 'local');
    writeFileSync(path.join(home, 'projects.json'), '{ not json');
    expect(lpm(shop, 'check').all).toContain('OK board is valid.');
  });

  it('LPM_PROJECT_INDEX=off records nothing', () => {
    const dir = path.join(tempDir('lpm-parent-'), 'quiet');
    mkdirSync(dir);
    lpmIn(dir, { LPM_PROJECT_INDEX: 'off' }, 'init', '--local', '--no-git', '--no-omni');
    lpmIn(dir, { LPM_PROJECT_INDEX: 'off' }, 'check');
    expect(indexedRoots()).toEqual([]);
  });

  it('lpm store move records the new board folder', () => {
    const shop = project('shop', 'local');
    expect(lpm(shop, 'store', 'move', '--to', 'central').status).toBe(0);
    const entries = (JSON.parse(readFileSync(path.join(home, 'projects.json'), 'utf8')) as {
      projects: { root: string; lpmDir: string; store: string }[];
    }).projects;
    expect(entries).toEqual([
      expect.objectContaining({ root: shop, store: 'central', lpmDir: path.join(store, '.lpm_central', 'shop') }),
    ]);
  });
});

describe('lpm projects', () => {
  it('lists each project with its store, key prefix and folder', () => {
    const shop = project('shop', 'local');
    const blog = project('blog', 'central');

    const run = lpm(tempDir('lpm-anywhere-'), 'projects');

    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(new RegExp(`^blog\\s+central\\s+BL\\s+.*${escape(blog)}`, 'm'));
    expect(run.stdout).toMatch(new RegExp(`^shop\\s+local\\s+SH\\s+.*${escape(shop)}`, 'm'));
  });

  it('prints the entries as JSON with --json', () => {
    project('shop', 'local');
    const run = lpm(tempDir('lpm-anywhere-'), 'projects', '--json');
    const entries = JSON.parse(run.stdout) as { name: string; store: string; state: string }[];
    expect(entries).toEqual([expect.objectContaining({ name: 'shop', store: 'local', state: 'ok' })]);
  });

  it('marks a deleted project as missing, and prune removes it', () => {
    const shop = project('shop', 'local');
    project('blog', 'local');
    rmSync(shop, { recursive: true, force: true });

    expect(lpm(tempDir('lpm-anywhere-'), 'projects').stdout).toMatch(/^shop\s+.*missing/m);
    const pruned = lpm(tempDir('lpm-anywhere-'), 'projects', 'prune');
    expect(pruned.status).toBe(0);
    expect(pruned.stdout).toContain(shop);
    expect(indexedRoots().map((root) => path.basename(root))).toEqual(['blog']);
  });

  it('forget removes one project, and fails for a folder that is not listed', () => {
    const shop = project('shop', 'local');
    const anywhere = tempDir('lpm-anywhere-');
    expect(lpm(anywhere, 'projects', 'forget', shop).status).toBe(0);
    expect(indexedRoots()).toEqual([]);
    expect(lpm(anywhere, 'projects', 'forget', shop).status).toBe(1);
  });
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
