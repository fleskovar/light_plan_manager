import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * `lpm git` end to end, against the built CLI: a project with a remote, the
 * board shared onto its own branch, a teammate joining from a second clone,
 * and a change from one arriving at the other through nothing but ordinary
 * commands. Covers the bin wiring and `requireBoard`'s pull, which no core test
 * can reach.
 */
const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function lpm(cwd: string, ...args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LPM_BOARD_PATH: '' },
  });
  return { status: result.status ?? 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** A project that pushes its code to `remote`. */
function project(remote: string): string {
  const dir = temp('lpm-cli-git-');
  git(dir, 'init', '-q');
  git(dir, 'remote', 'add', 'origin', remote);
  return dir;
}

describe('lpm git', () => {
  it("shares a board on the project's repository and keeps two checkouts in step", () => {
    const remote = temp('lpm-cli-git-bare-');
    git(remote, 'init', '--bare', '-q');

    const ada = project(remote);
    expect(lpm(ada, 'init', '--template', 'kanban', '--prefix', 'LP').status).toBe(0);
    expect(lpm(ada, 'git').stdout).toContain('lpm git setup');

    const setup = lpm(ada, 'git', 'setup', '--project');
    expect(setup.stderr).toBe('');
    expect(setup.stdout).toContain('_lpm_board_remote');
    expect(setup.status).toBe(0);

    const bob = project(remote);
    const joined = lpm(bob, 'git', 'join');
    expect(joined.stdout).toContain('joined');
    expect(readFileSync(path.join(bob, '.gitignore'), 'utf8')).toContain('.lpm/');

    // Ada writes; Bob's next command, a read, already sees it.
    expect(lpm(ada, 'new', 'epic', '-t', 'Shared work').status).toBe(0);
    expect(git(remote, 'log', '-1', '--format=%s', '_lpm_board_remote')).toBe('lpm: create an issue');
    const opened = lpm(bob, 'open', 'LP-1', '--path');
    expect(opened.status).toBe(0);
    expect(readFileSync(opened.stdout.trim(), 'utf8')).toContain('Shared work');

    const status = lpm(bob, 'remote', 'git', 'status');
    expect(status.stdout).toContain('in step with the remote');
    expect(status.status).toBe(0);
  });

  it('refuses a tracker remote while the board is shared through git', () => {
    const remote = temp('lpm-cli-git-bare-');
    git(remote, 'init', '--bare', '-q');
    const ada = project(remote);
    lpm(ada, 'init', '--template', 'kanban', '--prefix', 'LP');
    lpm(ada, 'git', 'setup', '--project');

    const add = lpm(ada, 'remote', 'add', 'mirror', '--provider', 'jsonfile');
    expect(add.status).toBe(1);
    expect(add.stderr).toContain('shared through git');
  });

  it('swaps a tracker for git and back without losing it', () => {
    const remote = temp('lpm-cli-git-bare-');
    git(remote, 'init', '--bare', '-q');
    const ada = project(remote);
    lpm(ada, 'init', '--template', 'kanban', '--prefix', 'LP');
    expect(lpm(ada, 'remote', 'add', 'mirror', '--provider', 'jsonfile').status).toBe(0);
    const declared = readFileSync(path.join(ada, '.lpm', 'config.yml'), 'utf8').split('remotes:')[1]!;

    // No terminal to ask at: refused, naming the flag.
    const refused = lpm(ada, 'git', 'setup', '--project');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('--turn-off-remotes');

    const shared = lpm(ada, 'git', 'setup', '--project', '--turn-off-remotes');
    expect(shared.status).toBe(0);
    expect(shared.stdout).toContain('turned off mirror');
    expect(lpm(ada, 'git').stdout).toMatch(/mirrors\s+mirror/);
    expect(lpm(ada, 'remote').stdout).toContain('Turned off');
    expect(lpm(ada, 'remote', 'on', 'mirror').stderr).toContain('--turn-on-remotes');

    const back = lpm(ada, 'git', 'off', '--turn-on-remotes');
    expect(back.status).toBe(0);
    expect(back.stdout).toContain('on  mirror');
    const config = readFileSync(path.join(ada, '.lpm', 'config.yml'), 'utf8');
    expect(config).not.toContain('git_sync');
    expect(config).not.toContain('remotes_off');
    expect(config.split('remotes:')[1]).toBe(declared);

    // And the standalone pair, with no git involved.
    expect(lpm(ada, 'remote', 'off', 'mirror').stdout).toContain('off mirror');
    expect(lpm(ada, 'remote', 'on', 'mirror').stdout).toContain('on mirror');
  });
});
