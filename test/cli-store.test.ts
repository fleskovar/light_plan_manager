import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

// `lpm store` shows where the board is, `lpm store move` moves it (LPM-28) and
// `lpm store list` lists the central boards (LPM-32). Each case has its own user
// folder through `LPM_HOME`.
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

function lpmIn(dir: string, ...args: string[]): Run {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LPM_BOARD_PATH: '', LPM_HOME: home, LPM_USER: '' },
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { status: result.status ?? 0, stdout, stderr, all: stdout + stderr };
}

/** A project folder called `name` with a board, local or central. */
function project(name: string, where: 'local' | 'central'): string {
  const dir = path.join(tempDir('lpm-parent-'), name);
  mkdirSync(dir);
  const run = lpmIn(dir, 'init', `--${where}`, '--no-git', '--no-omni');
  if (run.status !== 0) throw new Error(run.all);
  return dir;
}

describe('lpm store', () => {
  it('prints local and the .lpm folder for a local board', () => {
    const dir = project('shop', 'local');
    const run = lpmIn(dir, 'store');
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/local\s+/);
    expect(run.stdout).toContain(path.join(dir, '.lpm'));
  });

  it('prints central, the central board folder and the project for a central board', () => {
    const dir = project('shop', 'central');
    const run = lpmIn(dir, 'store');
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/central\s+/);
    expect(run.stdout).toContain(path.join(store, '.lpm_central', 'shop'));
    expect(run.stdout).toContain(dir);
  });

  it('fails outside a board', () => {
    const run = lpmIn(tempDir('lpm-empty-'), 'store');
    expect(run.status).toBe(1);
  });
});

describe('lpm store list', () => {
  it('prints one line for each central board: name, key prefix and project', () => {
    const shop = project('shop', 'central');
    const blog = project('blog', 'central');
    const run = lpmIn(tempDir('lpm-anywhere-'), 'store', 'list');
    expect(run.status).toBe(0);
    const rows = run.stdout.split(/\r?\n/).filter((line) => /^(shop|blog)\s/.test(line));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/^blog\s+BL\s+/);
    expect(rows[0]).toContain(blog);
    expect(rows[1]).toMatch(/^shop\s+SH\s+/);
    expect(rows[1]).toContain(shop);
  });

  it('says project missing for a board whose project is gone', () => {
    const shop = project('shop', 'central');
    rmSync(shop, { recursive: true, force: true });
    const run = lpmIn(tempDir('lpm-anywhere-'), 'store', 'list');
    expect(run.stdout).toMatch(/^shop\s+SH\s+.*project missing/m);
  });

  it('prints the entries as JSON with --json', () => {
    project('shop', 'central');
    const run = lpmIn(tempDir('lpm-anywhere-'), 'store', 'list', '--json');
    expect(run.status).toBe(0);
    const entries = JSON.parse(run.stdout) as { name: string; keyPrefix: string; pointerOk: boolean }[];
    expect(entries).toEqual([expect.objectContaining({ name: 'shop', keyPrefix: 'SH', pointerOk: true })]);
  });

  it('says how to set a central store when none is set', () => {
    rmSync(path.join(home, 'settings.json'));
    const run = lpmIn(tempDir('lpm-anywhere-'), 'store', 'list');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('lpm config set central_store');
  });
});

describe('lpm store move', () => {
  it('moves a local board to the central store, prints the new folder and exits 0', () => {
    const dir = project('shop', 'local');
    const run = lpmIn(dir, 'store', 'move', '--to', 'central');
    const central = path.join(store, '.lpm_central', 'shop');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(central);
    expect(existsSync(path.join(central, 'config.yml'))).toBe(true);
    expect(lpmIn(dir, 'check').all).toContain('OK board is valid.');
  });

  it('moves a central board back into its project', () => {
    const dir = project('shop', 'central');
    const run = lpmIn(dir, 'store', 'move', '--to', 'local');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(path.join(dir, '.lpm'));
    expect(existsSync(path.join(store, '.lpm_central', 'shop'))).toBe(false);
    expect(lpmIn(dir, 'store').stdout).toMatch(/local\s+/);
  });

  it('prints the reason and exits 1 for a refused move', () => {
    const dir = project('shop', 'central');
    const run = lpmIn(dir, 'store', 'move', '--to', 'central');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('already in the central store');
  });

  it('exits 1 without --to, or with a value other than central or local', () => {
    const dir = project('shop', 'local');
    expect(lpmIn(dir, 'store', 'move').status).toBe(1);
    expect(lpmIn(dir, 'store', 'move', '--to', 'elsewhere').status).toBe(1);
  });
});
