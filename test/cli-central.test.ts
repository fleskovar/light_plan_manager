import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { initBoard, readStorePointer, setupGitSync } from '../src/core/index.js';
import { cleanupBoards, makeCentralBoard } from './helpers.js';

// The central store through the built CLI. `npm test` builds `dist/` first.
const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));

const dirs: string[] = [];
/** The user folder of every run, so no case reads `~/.light-plan`. */
let home: string;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  home = tempDir('lpm-home-');
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  cleanupBoards();
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

function useCentralStore(): string {
  const store = tempDir('lpm-store-');
  writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ central_store: store }));
  return store;
}

describe('lpm init and the central store', () => {
  it('lpm init --central creates the board in the central store', () => {
    const store = useCentralStore();
    const project = path.join(tempDir('lpm-parent-'), 'shop');
    mkdirSync(project);

    const run = lpmIn(project, 'init', '--central', '--no-git');

    expect(run.status).toBe(0);
    expect(existsSync(path.join(store, '.lpm_central', 'shop', 'config.yml'))).toBe(true);
    expect(run.stdout).toMatch(/store\s+central/);
    expect(run.stdout).toContain(path.join(store, '.lpm_central', 'shop'));
    expect(lpmIn(project, 'check').all).toContain('OK board is valid.');
  });

  it('lpm init --local creates a local board with a central store set', () => {
    const store = useCentralStore();
    const project = tempDir('lpm-project-');

    const run = lpmIn(project, 'init', '--local', '--no-git');

    expect(run.status).toBe(0);
    expect(readFileSync(path.join(project, '.lpm', 'config.yml'), 'utf8')).toMatch(/key_prefix/);
    expect(existsSync(path.join(store, '.lpm_central'))).toBe(false);
  });

  it('lpm init without a terminal and without a flag creates a local board', () => {
    useCentralStore();
    const project = tempDir('lpm-project-');

    const run = lpmIn(project, 'init', '--no-git');

    expect(run.status).toBe(0);
    expect(readFileSync(path.join(project, '.lpm', 'config.yml'), 'utf8')).toMatch(/key_prefix/);
  });

  it('lpm init --central --local exits 1', () => {
    useCentralStore();
    const run = lpmIn(tempDir('lpm-project-'), 'init', '--central', '--local', '--no-git');
    expect(run.status).toBe(1);
  });

  it('lpm init --central without a central store exits 1 and names lpm config', () => {
    const project = tempDir('lpm-project-');
    const run = lpmIn(project, 'init', '--central', '--no-git');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('lpm config set central_store');
    expect(existsSync(path.join(project, '.lpm'))).toBe(false);
  });
});

describe('lpm git join and the central store', () => {
  it('lpm git join --central clones into the central store and writes the pointer', () => {
    const store = useCentralStore();
    const remote = tempDir('lpm-bare-');
    spawnSync('git', ['init', '--bare', '-q'], { cwd: remote });
    const ada = initBoard({ root: tempDir('lpm-ada-'), git: true, omni: false }).paths;
    setupGitSync(ada, { url: remote, branch: 'main' });
    const project = path.join(tempDir('lpm-parent-'), 'shop');
    mkdirSync(project);

    const run = lpmIn(project, 'git', 'join', '--url', remote, '--central');

    expect(run.status).toBe(0);
    const central = path.join(store, '.lpm_central', 'shop');
    expect(run.stdout).toContain(central);
    expect(readStorePointer(path.join(project, '.lpm', 'config.yml'))).toBe(central);
    expect(lpmIn(project, 'check').all).toContain('OK board is valid.');
  });
});

describe('a project with a store pointer', () => {
  it('lpm check validates the central board', () => {
    const central = makeCentralBoard();
    const run = lpmIn(central.project, 'check');
    expect(run.all).toContain('OK board is valid.');
    expect(run.status).toBe(0);
  });

  it('lpm new writes the issue to the central board folder', () => {
    const central = makeCentralBoard();
    const deep = path.join(central.project, 'src');
    mkdirSync(deep);

    const run = lpmIn(deep, 'new', 'program', '-t', 'Checkout');

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('LP-1');
    expect(lpmIn(central.project, 'check').all).toContain('OK board is valid.');
    expect(run.stdout).toContain(`${path.basename(central.lpmDir)}/board/LP-1`);
  });

  it('fails with exit code 1 when the pointer names a missing folder', () => {
    const central = makeCentralBoard();
    rmSync(central.lpmDir, { recursive: true, force: true });

    const run = lpmIn(central.project, 'check');

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('holds no board');
    expect(run.stderr).toContain(path.join(central.project, '.lpm', 'config.yml'));
  });
});
