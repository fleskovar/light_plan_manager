import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

// End-to-end against the built CLI, so `npm test` also covers the bin wiring.
// `npm test` runs `pretest` (tsc) first.
const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));

const dirs: string[] = [];
let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(path.join(os.tmpdir(), 'lpm-cli-'));
  dirs.push(cwd);
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
  return lpmIn(cwd, {}, ...args);
}

/**
 * `LPM_BOARD_PATH` is cleared unless a case sets it: a developer with one
 * exported in their shell would otherwise point the whole suite at their board.
 */
function lpmIn(dir: string, env: Record<string, string>, ...args: string[]): Run {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LPM_BOARD_PATH: '', ...env },
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { status: result.status ?? 0, stdout, stderr, all: stdout + stderr };
}

function init(...args: string[]): Run {
  return lpm('init', '--no-git', '--no-omni', ...args);
}

describe('lpm', () => {
  it('prints usage and exits 1 with no arguments', () => {
    const run = lpm();
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('lpm <command> [options]');
  });

  it('prints usage and exits 0 for --help', () => {
    expect(lpm('--help').status).toBe(0);
  });

  it('prints the version', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { version: string };
    expect(lpm('--version').stdout.trim()).toBe(pkg.version);
  });

  it('rejects an unknown command', () => {
    const run = lpm('frobnicate');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('unknown command');
  });

  it('rejects an unknown option with a usage hint', () => {
    init();
    const run = lpm('new', 'task', '--wat');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('lpm new --help');
  });

  it('reports when there is no board', () => {
    const run = lpm('check');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('No light-plan board found');
  });
});

describe('lpm init', () => {
  it('creates the board and refuses to run twice', () => {
    expect(init('--prefix', 'ACME').status).toBe(0);
    expect(existsSync(path.join(cwd, '.lpm', 'config.yml'))).toBe(true);
    expect(existsSync(path.join(cwd, '.lpm', 'board'))).toBe(true);

    const second = init();
    expect(second.status).toBe(1);
    expect(second.stderr).toContain('already exists');
  });

  it('rejects an unusable template and an invalid prefix', () => {
    expect(init('-t', 'nope').status).toBe(1);
    expect(init('--prefix', 'lower').stderr).toContain('Invalid key prefix');
  });

  it('derives the prefix from the folder name', () => {
    init();
    const config = readFileSync(path.join(cwd, '.lpm', 'config.yml'), 'utf8');
    expect(config).toMatch(/^key_prefix: [A-Z][A-Z0-9]*$/m);
  });

  it('seeds the omni periods by default, and new issues land in them', () => {
    // Without the `init` helper's --no-omni: this is the board a person gets.
    const created = lpm('init', '--no-git', '--prefix', 'LP');
    expect(created.stdout).toContain('TL-1 Omni Product Increment > TL-2 Omni Sprint');

    expect(lpm('new', 'program', '-t', 'Platform').stdout).toContain('scheduled in TL-2');
    expect(lpm('new', 'program', '-t', 'Later', '--period', 'none').stdout).not.toContain('scheduled');
  });
});

describe('LPM_BOARD_PATH', () => {
  /** Somewhere with no board at or above it, to run from. */
  function away(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lpm-away-'));
    dirs.push(dir);
    return dir;
  }

  it('works the board from a folder that has none', () => {
    init('--prefix', 'LP');
    const board = path.join(cwd, '.lpm');
    const elsewhere = away();

    expect(lpmIn(elsewhere, {}, 'check').status).toBe(1);

    const env = { LPM_BOARD_PATH: board };
    const created = lpmIn(elsewhere, env, 'new', 'program', '-t', 'Payments');
    expect(created.stdout).toContain('LP-1');
    // Paths are still reported against the board, not against the caller.
    expect(created.stdout).toContain('.lpm/board/LP-1/_issue.md');
    expect(created.stdout).not.toContain('..');

    expect(lpmIn(elsewhere, env, 'check').status).toBe(0);
    // The issue landed in the board named, not beside the caller.
    expect(existsSync(path.join(board, 'board', 'LP-1'))).toBe(true);
    expect(existsSync(path.join(elsewhere, '.lpm'))).toBe(false);
  });

  it('fails loudly when it points at no board', () => {
    init();
    const run = lpmIn(cwd, { LPM_BOARD_PATH: path.join(cwd, 'nowhere') }, 'check');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('LPM_BOARD_PATH does not point at a board');
  });

  it('does not divert init, which says so', () => {
    const other = away();
    expect(init().status).toBe(0);
    const run = lpmIn(other, { LPM_BOARD_PATH: path.join(cwd, '.lpm') }, 'init', '--no-git');
    expect(run.status).toBe(0);
    expect(existsSync(path.join(other, '.lpm', 'config.yml'))).toBe(true);
    expect(run.stdout).toContain('LPM_BOARD_PATH points at');
  });
});

describe('lpm new / move / open / check', () => {
  it('walks the documented workflow', () => {
    init('--prefix', 'LP');

    expect(lpm('new', 'program', '-t', 'Payments platform').stdout).toContain('LP-1');
    expect(lpm('new', 'epic', '-t', 'Checkout', '-p', 'LP-1').stdout).toContain('LP-2');
    expect(lpm('new', 'feature', '-t', 'Guest flow', '-p', 'LP-2').stdout).toContain('LP-3');

    const story = lpm(
      'new',
      'user_story',
      '-t',
      'Guest checkout',
      '-p',
      'LP-3',
      '--set',
      'story_points=3',
      '--set',
      'labels=web,checkout',
    );
    expect(story.status).toBe(0);
    expect(story.stdout).toContain('LP-4');

    const check = lpm('check');
    expect(check.status).toBe(0);
    expect(check.stdout).toContain('board is valid');

    const move = lpm('move', 'lp-4', '--status', 'in_progress');
    expect(move.status).toBe(0);
    expect(move.stdout).toContain('backlog');
    expect(move.stdout).toContain('in_progress');

    const open = lpm('open', 'LP-4', '--path');
    expect(open.status).toBe(0);
    expect(existsSync(open.stdout.trim())).toBe(true);
    expect(readFileSync(open.stdout.trim(), 'utf8')).toContain('story_points: 3');
  });

  it('accepts the title as a positional argument', () => {
    init();
    expect(lpm('new', 'program', 'Positional title').status).toBe(0);
  });

  it('reports hierarchy and attribute errors', () => {
    init('--prefix', 'LP');
    lpm('new', 'program', '-t', 'P');

    expect(lpm('new', 'program', '-t', 'X', '-p', 'LP-1').stderr).toContain('top-level type');
    expect(lpm('new', 'user_story', '-t', 'X').stderr).toContain('needs a parent issue');
    expect(lpm('new', 'saga', '-t', 'X').stderr).toContain('Unknown type');
    expect(lpm('new', 'program').stderr).toContain('Missing title');
    expect(lpm('new').stderr).toContain('Missing type');

    lpm('new', 'epic', '-t', 'E', '-p', 'LP-1');
    expect(lpm('new', 'feature', '-t', 'F', '-p', 'LP-2', '--set', 'priority=urgent').stderr).toContain(
      'expected one of',
    );
    expect(lpm('new', 'feature', '-t', 'F', '-p', 'LP-2', '--set', 'nope').stderr).toContain(
      'key=value',
    );
  });

  it('requires something to change on move', () => {
    init('--prefix', 'LP');
    lpm('new', 'program', '-t', 'P');
    expect(lpm('move', 'LP-1').stderr).toContain('Nothing to do');
    expect(lpm('move').stderr).toContain('Missing id');
    expect(lpm('move', 'LP-9', '-s', 'ready').stderr).toContain(
      'No issue, period or resource with id',
    );
  });

  it('exits 1 while errors remain and 0 after --fix', () => {
    init('--prefix', 'LP');

    // A hand-made folder holding nothing but a heading, as the README describes.
    const dir = path.join(cwd, '.lpm', 'board', 'hand-made');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '_issue.md'), '# Hand made\n', 'utf8');

    const before = lpm('check');
    expect(before.status).toBe(1);
    expect(before.stdout).toContain('fixable');

    const fixed = lpm('check', '--fix');
    expect(fixed.stdout).toContain('Fixed');
    expect(fixed.status).toBe(0);
    expect(lpm('check').status).toBe(0);
    expect(existsSync(path.join(cwd, '.lpm', 'board', 'LP-1'))).toBe(true);
    // The adopted folder reached the index, through the built CLI.
    expect(readFileSync(path.join(cwd, '.lpm', 'INDEX.md'), 'utf8')).toContain(
      '- [LP-1](board/LP-1/_issue.md) — Hand made',
    );
  });

  it('keeps INDEX.md in step as documents are added and removed', () => {
    init('--prefix', 'LP');
    const index = (): string => readFileSync(path.join(cwd, '.lpm', 'INDEX.md'), 'utf8');

    expect(index()).toContain('no documents yet');

    lpm('new', 'program', '-t', 'Payments');
    lpm('new', 'epic', '-t', 'Checkout', '-p', 'LP-1');
    expect(index()).toContain('- [LP-1](board/LP-1/_issue.md) — Payments');
    expect(index()).toContain('  - [LP-2](board/LP-1/LP-2/_issue.md) — Checkout');

    lpm('set', 'LP-2', '-t', 'Checkout revamp');
    expect(index()).toContain('  - [LP-2](board/LP-1/LP-2/_issue.md) — Checkout revamp');

    lpm('rm', 'LP-2');
    expect(index()).not.toContain('LP-2');
    expect(lpm('check').status).toBe(0);
  });

  it('creates periods, schedules issues, and links them', () => {
    init('--prefix', 'LP');

    const increment = lpm('new', 'increment', '-t', '2026 H2', '--starts', '2026-07-01', '--ends', '2026-12-31');
    expect(increment.status).toBe(0);
    expect(increment.stdout).toContain('TL-1');
    expect(existsSync(path.join(cwd, '.lpm', 'timeline', 'TL-1', '_period.md'))).toBe(true);

    expect(
      lpm('new', 'sprint', '-t', 'Sprint 1', '--starts', '2026-08-03', '--ends', '2026-08-14', '-p', 'TL-1').stdout,
    ).toContain('TL-2');

    lpm('new', 'program', '-t', 'P');
    lpm('new', 'epic', '-t', 'E', '-p', 'LP-1');
    lpm('new', 'feature', '-t', 'F', '-p', 'LP-2');
    lpm('new', 'user_story', '-t', 'Gateway', '-p', 'LP-3');

    const scheduled = lpm('new', 'user_story', '-t', 'Checkout', '-p', 'LP-3', '--period', 'TL-2', '--depends-on', 'LP-4');
    expect(scheduled.status).toBe(0);
    expect(scheduled.stdout).toContain('scheduled in TL-2');
    expect(scheduled.stdout).toContain('depends on LP-4');

    const moved = lpm('move', 'LP-4', '--period', 'TL-2');
    expect(moved.stdout).toContain('period');
    expect(lpm('move', 'LP-4', '--period', 'none').stdout).toContain('none');

    expect(lpm('check').status).toBe(0);
  });

  it('requires dates for a period and rejects issue-only flags on it', () => {
    init('--prefix', 'LP');
    expect(lpm('new', 'increment', '-t', 'X').stderr).toContain('--starts and --ends');
    expect(
      lpm('new', 'increment', '-t', 'X', '--starts', '2026-01-01', '--ends', '2026-06-30', '-s', 'backlog').stderr,
    ).toContain('--status does not apply to periods');
    expect(lpm('new', 'program', '-t', 'X', '--starts', '2026-01-01').stderr).toContain(
      'apply to periods only',
    );
  });

  it('links and unlinks issues, rejecting cycles', () => {
    init('--prefix', 'LP');
    lpm('new', 'program', '-t', 'P');
    lpm('new', 'epic', '-t', 'E', '-p', 'LP-1');
    lpm('new', 'feature', '-t', 'F', '-p', 'LP-2');
    lpm('new', 'user_story', '-t', 'A', '-p', 'LP-3');
    lpm('new', 'user_story', '-t', 'B', '-p', 'LP-3');

    const linked = lpm('link', 'LP-5', '--depends-on', 'LP-4');
    expect(linked.status).toBe(0);
    expect(linked.stdout).toContain('depends on   + LP-4');

    const cycle = lpm('link', 'LP-4', '--depends-on', 'LP-5');
    expect(cycle.status).toBe(1);
    expect(cycle.stderr).toContain('cycle');

    expect(lpm('link', 'LP-4', '--depends-on', 'LP-4').stderr).toContain('cannot depend on itself');
    expect(lpm('link', 'LP-4').stderr).toContain('Nothing to link');
    expect(lpm('link').stderr).toContain('Missing id');

    const removed = lpm('link', 'LP-5', '--depends-on', 'LP-4', '--remove');
    expect(removed.stdout).toContain('depends on   - LP-4');
    expect(lpm('check').status).toBe(0);
  });

  it('reports the containers a new dependency puts in order', () => {
    init('--prefix', 'LP');
    lpm('new', 'program', '-t', 'P');
    lpm('new', 'epic', '-t', 'Checkout', '-p', 'LP-1');
    lpm('new', 'feature', '-t', 'Guest flow', '-p', 'LP-2');
    lpm('new', 'user_story', '-t', 'A', '-p', 'LP-3');
    lpm('new', 'epic', '-t', 'Accounts', '-p', 'LP-1');
    lpm('new', 'feature', '-t', 'Sign-up', '-p', 'LP-5');
    lpm('new', 'user_story', '-t', 'B', '-p', 'LP-6');

    const linked = lpm('link', 'LP-4', '--depends-on', 'LP-7');
    expect(linked.status).toBe(0);
    expect(linked.stdout).toContain('depends on   + LP-7');
    // The two features and the two epics, nearest the written edge first.
    expect(linked.stdout).toContain('also orders LP-3  Guest flow  after LP-6  Sign-up');
    expect(linked.stdout).toContain('also orders LP-2  Checkout  after LP-5  Accounts');

    // Nothing is written on them: only the story carries the dependency.
    const feature = readFileSync(
      path.join(cwd, '.lpm', 'board', 'LP-1', 'LP-2', 'LP-3', '_issue.md'),
      'utf8',
    );
    expect(feature).not.toContain('LP-6');

    // And the report reads it back off the graph.
    const upstream = lpm('upstream', 'LP-3');
    expect(upstream.status).toBe(0);
    expect(upstream.stdout).toContain('the work inside it puts it after:');
    expect(upstream.stdout).toContain('LP-6  Sign-up');
    expect(upstream.stdout).toContain('via LP-4 → LP-7');
  });

  it('says nothing about containers for a dependency inside one', () => {
    init('--prefix', 'LP');
    lpm('new', 'program', '-t', 'P');
    lpm('new', 'epic', '-t', 'E', '-p', 'LP-1');
    lpm('new', 'feature', '-t', 'F', '-p', 'LP-2');
    lpm('new', 'user_story', '-t', 'A', '-p', 'LP-3');
    lpm('new', 'user_story', '-t', 'B', '-p', 'LP-3');

    const linked = lpm('link', 'LP-5', '--depends-on', 'LP-4');
    expect(linked.stdout).not.toContain('also orders');
    expect(lpm('upstream', 'LP-3').stdout).not.toContain('puts it after');
  });

  it('builds a roster, assigns work and walks the task loop', () => {
    init('--prefix', 'LP');

    const alice = lpm('new', 'person', '-t', 'Alice Smith', '--set', 'email=alice@example.com');
    expect(alice.status).toBe(0);
    expect(alice.stdout).toContain('RS-1');
    expect(alice.stdout).toContain('person, 1 FTE');
    expect(existsSync(path.join(cwd, '.lpm', 'team', 'RS-1', '_resource.md'))).toBe(true);

    const pool = lpm('new', 'role', '-t', 'Jr. software developer', '--capacity', '3');
    expect(pool.stdout).toContain('pool, 3 FTE');

    expect(lpm('link', 'RS-1', '--covers', 'RS-2').stdout).toContain('covers       + RS-2');

    lpm('new', 'program', '-t', 'P');
    lpm('new', 'epic', '-t', 'E', '-p', 'LP-1');
    lpm('new', 'feature', '-t', 'F', '-p', 'LP-2');
    const assigned = lpm('new', 'user_story', '-t', 'Guest checkout', '-p', 'LP-3', '--assignee', 'alice');
    expect(assigned.stdout).toContain('assigned to RS-1');
    lpm('new', 'user_story', '-t', 'Cart totals', '-p', 'LP-3', '--assignee', 'RS-2');

    // Nobody is set yet, so the task commands should say so rather than guess.
    expect(lpm('task', 'next').stderr).toContain('No current user set');

    const me = lpm('me', 'alice');
    expect(me.status).toBe(0);
    expect(me.stdout).toContain('RS-1');
    expect(readFileSync(path.join(cwd, '.lpm', '.gitignore'), 'utf8')).toContain('local.json');

    const next = lpm('task', 'next');
    expect(next.stdout).toContain('LP-4');
    expect(next.stdout).toContain('LP-5');

    const started = lpm('task', 'start');
    expect(started.stdout).toContain('Started LP-4');
    expect(started.stdout).toContain('in_progress');
    expect(lpm('task', 'current').stdout).toContain('LP-4');

    expect(lpm('task', 'done').stdout).toContain('Done LP-4');
    expect(lpm('task', 'prev').stdout).toContain('LP-4');

    const team = lpm('team');
    expect(team.stdout).toContain('Alice Smith');
    expect(team.stdout).toContain('Jr. software developer');
    expect(team.stdout).toContain('covered by RS-1');

    expect(lpm('check').status).toBe(0);
  });

  it('routes work through a profile', () => {
    init('--prefix', 'LP');
    lpm('new', 'person', '-t', 'Alice Smith');
    lpm('new', 'program', '-t', 'P');
    lpm('new', 'epic', '-t', 'Checkout', '-p', 'LP-1');
    lpm('new', 'epic', '-t', 'Refunds', '-p', 'LP-1');
    lpm('new', 'feature', '-t', 'Guest flow', '-p', 'LP-2');
    lpm('new', 'feature', '-t', 'Partial', '-p', 'LP-3');
    lpm('new', 'user_story', '-t', 'Mine', '-p', 'LP-4', '--assignee', 'RS-1');
    lpm('new', 'user_story', '-t', 'Theirs', '-p', 'LP-5', '--assignee', 'RS-1');

    expect(lpm('profile').stdout).toContain('No profile in use');

    const created = lpm('profile', '--init', 'alice.yml', '--user', 'Alice Smith');
    expect(created.status).toBe(0);
    expect(created.stdout).toContain('alice.yml');
    expect(readFileSync(path.join(cwd, 'alice.yml'), 'utf8')).toContain('user: Alice Smith');
    // Recorded as typed, so it survives the checkout moving.
    expect(
      JSON.parse(readFileSync(path.join(cwd, '.lpm', 'local.json'), 'utf8')) as Record<string, unknown>,
    ).toMatchObject({ profile: 'alice.yml' });

    // A profile names the user, so `lpm me` was never needed.
    expect(lpm('me').stdout).toContain('from your profile');

    writeFileSync(
      path.join(cwd, 'alice.yml'),
      'user: Alice Smith\nscope:\n  exclude: [LP-3]\n',
      'utf8',
    );

    const shown = lpm('profile');
    expect(shown.stdout).toContain('scope    not LP-3');
    expect(shown.stdout).toContain('offers   4 issues of 7');

    const next = lpm('task', 'next');
    expect(next.stdout).toContain('scope not LP-3');
    expect(next.stdout).toContain('LP-6');
    expect(next.stdout).not.toContain('LP-7');

    // Scope decides what is offered, never what is reachable.
    expect(lpm('task', 'start', 'LP-7').stdout).toContain('Started LP-7');

    expect(lpm('profile', '--clear').stdout).toContain('no profile in use');
    expect(lpm('task', 'next').stdout).not.toContain('scope');
  });

  it('reports a profile it cannot use, without refusing to work', () => {
    init('--prefix', 'LP');
    lpm('new', 'person', '-t', 'Alice');
    lpm('me', 'Alice');
    writeFileSync(path.join(cwd, 'bad.yml'), 'scope:\n  excludes: [LP-1]\n', 'utf8');

    const refused = lpm('profile', 'bad.yml');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('not a valid profile');
    expect(lpm('profile').stdout).toContain('No profile in use');

    const missing = lpm('profile', 'nowhere.yml');
    expect(missing.stderr).toContain('No profile file at');
  });

  it('refuses to claim someone else\'s work without --force', () => {
    init('--prefix', 'LP');
    lpm('new', 'person', '-t', 'Alice');
    lpm('new', 'person', '-t', 'Bob');
    lpm('new', 'program', '-t', 'P', '--assignee', 'Bob');
    lpm('me', 'Alice');

    // The holder is named rather than numbered: losing a claim to a person is
    // the message, and "RS-2" alone is not one anybody can act on.
    const refused = lpm('task', 'start', 'LP-1');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('assigned to Bob (RS-2)');

    const forced = lpm('task', 'start', 'LP-1', '--force');
    expect(forced.stdout).toContain('Started LP-1');
    expect(forced.stdout).toContain('taken from RS-2');
  });

  it('rejects roster flags on issues and issue flags on the roster', () => {
    init('--prefix', 'LP');
    expect(lpm('new', 'program', '-t', 'P', '--capacity', '2').stderr).toContain(
      '--capacity and --covers apply to resources only',
    );
    expect(lpm('new', 'person', '-t', 'A', '-s', 'backlog').stderr).toContain(
      '--status does not apply to resources',
    );
    expect(lpm('new', 'person', '-t', 'A', '--capacity', 'lots').stderr).toContain('Invalid --capacity');
  });

  it('has no roster on a board that declares none', () => {
    init('--prefix', 'LP', '--template', 'blank');
    expect(existsSync(path.join(cwd, '.lpm', 'team'))).toBe(false);
    expect(lpm('team').stderr).toContain('no team roster');
    expect(lpm('me', 'anyone').stderr).toContain('no team roster');
  });

  it('--strict fails on warnings alone', () => {
    init('--prefix', 'LP');
    lpm('new', 'program', '-t', 'P');
    const file = path.join(cwd, '.lpm', 'board', 'LP-1', '_issue.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace('title: P', 'title: Renamed'), 'utf8');

    expect(lpm('check').status).toBe(0);
    expect(lpm('check', '--strict').status).toBe(1);
  });
});

describe('lpm upstream', () => {
  /**
   * Alice, a sprint, and a feature whose three stories run in a chain:
   * LP-4 -> LP-5 -> LP-6, with LP-6 the one somebody is waiting to deliver.
   */
  function seed(): void {
    init('--prefix', 'LP');
    lpm('new', 'person', '-t', 'Alice Smith');
    lpm('new', 'increment', '-t', '2026 H2', '--starts', '2026-07-01', '--ends', '2026-12-31');
    lpm('new', 'sprint', '-t', 'Sprint 7', '--starts', '2026-08-10', '--ends', '2026-08-21', '-p', 'TL-1');
    lpm('new', 'program', '-t', 'Payments');
    lpm('new', 'epic', '-t', 'Checkout', '-p', 'LP-1');
    lpm('new', 'feature', '-t', 'Guest flow', '-p', 'LP-2');
    lpm('new', 'user_story', '-t', 'Gateway', '-p', 'LP-3');
    lpm('new', 'user_story', '-t', 'Guest checkout', '-p', 'LP-3');
    lpm('new', 'user_story', '-t', 'Refunds', '-p', 'LP-3');
    lpm('link', 'LP-5', '--depends-on', 'LP-4');
    lpm('link', 'LP-6', '--depends-on', 'LP-5');
    lpm('move', 'LP-6', '--period', 'TL-2', '--assignee', 'RS-1');
  }

  it('lists the whole chain, not just the nearest blocker', () => {
    seed();
    const run = lpm('upstream', 'LP-6');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('LP-5');
    expect(run.stdout).toContain('LP-4');
    expect(run.stdout).toContain('2 issues must be finished first');
  });

  it('says so when nothing is upstream', () => {
    seed();
    expect(lpm('upstream', 'LP-4').stdout).toContain('nothing upstream');
  });

  /** A story's document on disk: the stories nest under LP-3 under LP-2 under LP-1. */
  const storyFile = (id: string): string =>
    readFileSync(path.join(cwd, '.lpm', 'board', 'LP-1', 'LP-2', 'LP-3', id, '_issue.md'), 'utf8');

  it('schedules the chain into the same sprint, for the same person', () => {
    seed();
    const run = lpm('upstream', 'LP-6', '--schedule');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Scheduled 2 issues');

    for (const id of ['LP-4', 'LP-5']) {
      expect(storyFile(id)).toContain('period: TL-2');
      expect(storyFile(id)).toContain('assignee: RS-1');
    }
  });

  it('changes nothing on a dry run, and says what it would do', () => {
    seed();
    expect(lpm('upstream', 'LP-6', '--schedule', '--dry-run').stdout).toContain('Would schedule');
    expect(storyFile('LP-4')).toContain('period: null');
  });

  it('refuses a period that does not exist', () => {
    seed();
    const run = lpm('upstream', 'LP-6', '--schedule', '--period', 'TL-99');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('No period with id "TL-99"');
  });

  it('refuses to schedule from an issue carrying neither a sprint nor an owner', () => {
    seed();
    const run = lpm('upstream', 'LP-5', '--schedule');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('not scheduled and not assigned');
  });
});

describe('lpm queue simulate', () => {
  /** Alice covering the junior pool, Bob, and a feature to hang stories off. */
  function seed(): void {
    init('--prefix', 'LP');
    lpm('new', 'person', '-t', 'Alice Smith');
    lpm('new', 'person', '-t', 'Bob Jones');
    lpm('new', 'role', '-t', 'Jr. software developer');
    lpm('link', 'RS-1', '--covers', 'RS-3');
    lpm('new', 'program', '-t', 'Payments');
    lpm('new', 'epic', '-t', 'Checkout', '-p', 'LP-1');
    lpm('new', 'feature', '-t', 'Guest flow', '-p', 'LP-2');
  }

  function story(title: string, ...args: string[]): void {
    lpm('new', 'user_story', '-t', title, '-p', 'LP-3', ...args);
  }

  it('prints help and exits 1 with no subcommand', () => {
    seed();
    const run = lpm('queue');
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('lpm queue simulate');
  });

  it('runs the queue dry for a person, in dependency order', () => {
    seed();
    story('First', '--assignee', 'RS-1');
    story('Second', '--assignee', 'RS-1');
    lpm('link', 'LP-5', '--depends-on', 'LP-4');

    const run = lpm('queue', 'simulate', '--user', 'Alice');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('RS-1 Alice Smith');
    expect(run.stdout.indexOf('LP-4')).toBeLessThan(run.stdout.indexOf('LP-5'));
    expect(run.stdout).toContain('frees LP-5');
    expect(run.stdout).toContain('2 tasks');
  });

  it('simulates a pool with --role', () => {
    seed();
    story('Pooled', '--assignee', 'RS-3');
    story('Alices', '--assignee', 'RS-1');

    const run = lpm('queue', 'simulate', '--role', 'Jr. software developer');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('(pool)');
    expect(run.stdout).toContain('Pooled');
    // Alice's own work is none of the pool's business.
    expect(run.stdout).not.toContain('Alices');
  });

  it('refuses a pool for --user and a person for --role', () => {
    seed();
    expect(lpm('queue', 'simulate', '--user', 'Jr. software developer').stderr).toContain(
      'is a pool, not a person',
    );
    expect(lpm('queue', 'simulate', '--role', 'Alice').stderr).toContain(
      'is a person, not a pool',
    );
    expect(lpm('queue', 'simulate', '--user', 'a', '--role', 'b').stderr).toContain(
      'not both',
    );
  });

  it('explains what the run never reached', () => {
    seed();
    story('Bobs', '--assignee', 'RS-2');
    story('Mine, but after Bob', '--assignee', 'RS-1');
    lpm('link', 'LP-5', '--depends-on', 'LP-4');

    const run = lpm('queue', 'simulate', '--user', 'Alice', '--skipped');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Never reached');
    expect(run.stdout).toContain('assigned to RS-2');
    expect(run.stdout).toContain('waiting on LP-4');
  });

  it('leaves the board untouched', () => {
    seed();
    story('One', '--assignee', 'RS-1');
    const before = lpm('open', 'LP-4', '--path').stdout.trim();
    const text = readFileSync(before, 'utf8');

    expect(lpm('queue', 'simulate', '--user', 'Alice').status).toBe(0);
    expect(readFileSync(before, 'utf8')).toBe(text);
  });

  it('withholds parked work from `task next` and the run alike', () => {
    seed();
    lpm('new', 'increment', '-t', 'PI', '--starts', '2026-08-03', '--ends', '2026-08-28');
    lpm('new', 'sprint', '-t', 'Parked', '-p', 'TL-1', '--starts', '2026-08-03', '--ends', '2026-08-14');
    lpm('period', 'TL-2', '--off');
    story('Parked work', '--assignee', 'RS-1', '--period', 'TL-2');
    lpm('me', 'RS-1');

    // The one rule, in the one place: the queue and the run must agree.
    expect(lpm('task', 'next').stdout).not.toContain('Parked work');
    expect(lpm('task', 'next', '--parked').stdout).toContain('Parked work');

    const run = lpm('queue', 'simulate', '--user', 'Alice');
    expect(run.stdout).not.toContain('Parked work');
    expect(run.stdout).toContain('switched-off periods');
    expect(lpm('queue', 'simulate', '--user', 'Alice', '--parked').stdout).toContain('Parked work');
  });

  it('falls back to the current user, and says when there is none', () => {
    seed();
    story('Mine', '--assignee', 'RS-1');

    expect(lpm('queue', 'simulate').stderr).toContain('No current user set');
    lpm('me', 'RS-1');
    expect(lpm('queue', 'simulate').stdout).toContain('RS-1 Alice Smith');
  });
});

describe('lpm instructions', () => {
  /** program > epic > feature > story, with a body on each. */
  function seed(): void {
    init('--prefix', 'LP');
    lpm('new', 'program', '-t', 'Payments');
    lpm('new', 'epic', '-t', 'Checkout', '-p', 'LP-1');
    lpm('new', 'feature', '-t', 'Guest flow', '-p', 'LP-2');
    lpm('new', 'user_story', '-t', 'Pay as a guest', '-p', 'LP-3');
    lpm('set', 'LP-1', '--body', '## Vision\n\nGet paid.');
    lpm('set', 'LP-4', '--body', '## Acceptance Criteria\n\n- [ ] It works');
  }

  it('prints the brief on stdout and nothing else', () => {
    seed();
    const run = lpm('instructions', 'LP-4');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Payments');
    expect(run.stdout).toContain('Get paid.');
    expect(run.stdout).toContain('- [ ] It works');
    // How it was made goes to stderr, so the brief can be redirected as-is.
    expect(run.stdout).not.toContain('rendered LP-4');
    expect(run.stderr).toContain('rendered LP-4');
  });

  it('takes the id as a flag as well, and does not care about case', () => {
    seed();
    expect(lpm('instructions', '--id', 'lp-4').stdout).toContain('Pay as a guest');
    expect(lpm('brief', 'LP-4').stdout).toContain('Pay as a guest');
  });

  it('writes the starter templates and says which type uses which', () => {
    seed();
    const listed = lpm('instructions', '--list');
    expect(listed.stdout).toContain('user_story');
    expect(listed.stdout).toContain('user_story.md');

    const again = lpm('instructions', '--init');
    expect(again.stdout).toContain('already there');
    expect(lpm('instructions', '--init', '--force').stdout).toContain('written');
  });

  it('renders an override, and refuses one it cannot find', () => {
    seed();
    const file = path.join(cwd, 'tiny.md');
    writeFileSync(file, 'Do <%= issue.id %>', 'utf8');
    expect(lpm('instructions', 'LP-4', '--template', file).stdout.trim()).toBe('Do LP-4');
    expect(lpm('instructions', 'LP-4', '--template', 'nope').stderr).toContain(
      'No context template',
    );
  });

  it('falls back to the issue in progress, and says so when there is none', () => {
    seed();
    lpm('new', 'person', '-t', 'Alice Smith');
    lpm('me', 'RS-1');
    lpm('move', 'LP-4', '--assignee', 'RS-1', '-s', 'in_progress');
    expect(lpm('instructions').stdout).toContain('Pay as a guest');

    lpm('me', '--clear');
    expect(lpm('instructions').stderr).toContain('no user');
  });

  it('reports an id the board does not have', () => {
    seed();
    const run = lpm('instructions', 'LP-99');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('No issue with id');
  });
});

describe('lpm instructions safety', () => {
  function seed(): void {
    init('--prefix', 'LP');
    lpm('new', 'program', '-t', 'Payments');
    lpm('new', 'epic', '-t', 'Checkout', '-p', 'LP-1');
    lpm('new', 'feature', '-t', 'Guest flow', '-p', 'LP-2');
    lpm('new', 'user_story', '-t', 'Pay as a guest', '-p', 'LP-3');
  }

  const plant = (name: string, body: string): void =>
    writeFileSync(path.join(cwd, '.lpm', 'templates', 'context', `${name}.md`), body, 'utf8');

  it('warns at init that templates are executable', () => {
    const run = init('--prefix', 'LP');
    expect(run.stdout).toContain('Context templates are code');
    expect(run.stdout).toContain('at your own risk');
  });

  it('audits every layout on the board and passes the shipped ones', () => {
    seed();
    const run = lpm('instructions', '--audit');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('No escapes found');
    expect(run.stdout).toContain('user_story.md');
    // The honest caveat is part of the output, not just the docs.
    expect(run.stdout).toContain('cannot make an untrusted template safe');
  });

  it('refuses to render a template that reaches for the host', () => {
    seed();
    plant('user_story', '# <%= issue.title %>\n<%= process.env.HOME %>\n');

    const run = lpm('instructions', 'LP-4');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Refusing to render');
    expect(run.stderr).toContain('reaches outside the board');
    // Nothing was rendered: the check runs before the template is compiled.
    expect(run.stdout).toBe('');
  });

  it('catches the escape that names nothing dangerous', () => {
    seed();
    plant('user_story', '<%= this.constructor.constructor("return process")().version %>');
    expect(lpm('instructions', 'LP-4').stderr).toContain('the template engine itself');
  });

  it('fails the audit, and so a build, when a poisoned template arrives', () => {
    seed();
    plant('bug', '<% require("child_process").execSync("id") %>');
    const run = lpm('instructions', '--audit');
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('can reach outside the board');
  });

  it('renders anyway with --unsafe, and says that it did', () => {
    seed();
    plant('user_story', 'pid <%= typeof process %>');
    const run = lpm('instructions', 'LP-4', '--unsafe');
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe('pid object');
    expect(run.stderr).toContain('--unsafe');
  });
});

describe('lpm ui', () => {
  /**
   * A busy port is an ordinary answer, not a crash.
   *
   * `run` hands the socket to Node and returns, so the listen failure arrives
   * after the CLI's own `try` has finished. Thrown there it reached nobody and
   * Node printed the `BoardError` as an unhandled rejection — object, stack and
   * all — which is how "something else is on that port" came to look like the
   * tool falling over.
   */
  it('reports a port already in use, and exits 1 without a stack', async () => {
    lpm('init', '--template', 'scrum', '--no-git', '--no-omni');

    const { createServer } = await import('node:net');
    const blocker = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', () => {
        const address = blocker.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });

    try {
      const run = lpm('ui', '--port', String(port), '--no-open');
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(`Port ${port} is already in use`);
      expect(run.stderr).toContain('Pass --port <n>');
      // The remedy names the address that is already serving, because the other
      // process is nearly always another `lpm ui` on this same board.
      expect(run.stderr).toContain(`http://127.0.0.1:${port}`);
      // Not a crash report: no stack frames, no raw object dump.
      expect(run.all).not.toContain('at file:');
      expect(run.all).not.toContain('details: [');
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
