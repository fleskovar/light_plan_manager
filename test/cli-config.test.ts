import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

// `lpm config` reads and writes the user settings in `settings.json` of the
// user folder (LPM-13). Each case has its own user folder through `LPM_HOME`.
const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));

const dirs: string[] = [];
let home: string;
let cwd: string;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  home = tempDir('lpm-home-');
  cwd = tempDir('lpm-cwd-');
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

function lpm(...args: string[]): Run {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LPM_BOARD_PATH: '', LPM_HOME: home },
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { status: result.status ?? 0, stdout, stderr, all: stdout + stderr };
}

function settings(): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(home, 'settings.json'), 'utf8')) as Record<string, unknown>;
}

describe('lpm config set central_store', () => {
  it('stores the absolute path, prints it and exits 0', () => {
    const store = tempDir('lpm-store-');
    const run = lpm('config', 'set', 'central_store', store);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(store);
    expect(settings().central_store).toBe(store);
  });

  it('fails for an unknown key and lists the known keys', () => {
    const run = lpm('config', 'set', 'unknown_key', 'x');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('central_store');
    expect(run.stderr).toContain('default_template');
  });

  // Changed in LPM-49: `central_store` without a value now means the current
  // folder, so the case uses `default_template`, which still needs a value.
  it('fails without a value', () => {
    const run = lpm('config', 'set', 'default_template');
    expect(run.status).toBe(1);
  });
});

describe('lpm set central_store (LPM-49)', () => {
  function lpmIn(dir: string, ...args: string[]): Run {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', LPM_BOARD_PATH: '', LPM_HOME: home },
    });
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    return { status: result.status ?? 0, stdout, stderr, all: stdout + stderr };
  }

  it('lpm set central_store uses the current folder', () => {
    const here = tempDir('lpm-here-');
    const run = lpmIn(here, 'set', 'central_store');
    expect(run.status).toBe(0);
    expect(settings().central_store).toBe(here);
  });

  it('lpm config set central_store without a path uses the current folder', () => {
    const here = tempDir('lpm-here-');
    expect(lpmIn(here, 'config', 'set', 'central_store').status).toBe(0);
    expect(settings().central_store).toBe(here);
  });

  it('--path names another folder', () => {
    const other = tempDir('lpm-other-');
    const run = lpmIn(tempDir('lpm-here-'), 'set', 'central_store', '--path', other);
    expect(run.status).toBe(0);
    expect(settings().central_store).toBe(other);
  });

  it('with another store set and no terminal, exits 1 and names --move and --abandon', () => {
    const first = tempDir('lpm-first-');
    lpmIn(first, 'set', 'central_store');

    const run = lpmIn(tempDir('lpm-second-'), 'set', 'central_store');

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(first);
    expect(run.stderr).toContain('--move');
    expect(run.stderr).toContain('--abandon');
    expect(settings().central_store).toBe(first);
  });

  it('--abandon switches the key and leaves the old store alone', () => {
    const first = tempDir('lpm-first-');
    lpmIn(first, 'set', 'central_store');
    mkdirSync(path.join(first, '.lpm_central', 'shop'), { recursive: true });
    writeFileSync(path.join(first, '.lpm_central', 'shop', 'config.yml'), 'key_prefix: SH\n');
    const second = tempDir('lpm-second-');

    const run = lpmIn(second, 'set', 'central_store', '--abandon');

    expect(run.status).toBe(0);
    expect(settings().central_store).toBe(second);
    expect(existsSync(path.join(first, '.lpm_central', 'shop', 'config.yml'))).toBe(true);
  });

  it('--move moves the boards to the new store', () => {
    const first = tempDir('lpm-first-');
    lpmIn(first, 'set', 'central_store');
    const project = path.join(tempDir('lpm-parent-'), 'shop');
    mkdirSync(project);
    expect(lpmIn(project, 'init', '--central', '--no-git', '--no-omni').status).toBe(0);
    const second = tempDir('lpm-second-');

    const run = lpmIn(second, 'set', 'central_store', '--move');

    expect(run.status).toBe(0);
    expect(run.stdout).toContain(path.join(second, '.lpm_central', 'shop'));
    expect(settings().central_store).toBe(second);
    expect(lpmIn(project, 'store').stdout).toContain(path.join(second, '.lpm_central', 'shop'));
  });

  it('--move --abandon exits 1', () => {
    lpmIn(tempDir('lpm-first-'), 'set', 'central_store');
    expect(lpmIn(tempDir('lpm-second-'), 'set', 'central_store', '--move', '--abandon').status).toBe(1);
  });

  it('lpm set <id> still edits a document', () => {
    const project = tempDir('lpm-project-');
    lpmIn(project, 'init', '--local', '--no-git', '--no-omni', '--prefix', 'LP');
    lpmIn(project, 'new', 'program', '-t', 'Before');
    const run = lpmIn(project, 'set', 'LP-1', '--title', 'After');
    expect(run.status).toBe(0);
  });
});

describe('lpm config get central_store', () => {
  it('prints the path and exits 0', () => {
    const store = tempDir('lpm-store-');
    lpm('config', 'set', 'central_store', store);
    const run = lpm('config', 'get', 'central_store');
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe(store);
  });

  it('exits 1 and prints nothing on stdout without the key', () => {
    const run = lpm('config', 'get', 'central_store');
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
  });
});

describe('lpm config unset central_store', () => {
  it('removes the key, so a later get exits 1', () => {
    lpm('config', 'set', 'central_store', tempDir('lpm-store-'));
    const run = lpm('config', 'unset', 'central_store');
    expect(run.status).toBe(0);
    expect(lpm('config', 'get', 'central_store').status).toBe(1);
  });
});

describe('lpm config set default_template', () => {
  it('stores a known template', () => {
    const run = lpm('config', 'set', 'default_template', 'kanban');
    expect(run.status).toBe(0);
    expect(settings().default_template).toBe('kanban');
  });

  it('refuses a template that does not exist', () => {
    const run = lpm('config', 'set', 'default_template', 'no-such-template');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('no-such-template');
  });
});

describe('lpm config', () => {
  it('lists central_store and default_template with their values', () => {
    const store = tempDir('lpm-store-');
    lpm('config', 'set', 'central_store', store);
    const run = lpm('config');
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/central_store\s+.*lpm-store-/);
    expect(run.stdout).toMatch(/default_template\s+/);
  });
});
