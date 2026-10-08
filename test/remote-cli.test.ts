import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { connectionFlags, secretKeyNames } from '../src/remote/index.js';
import { lookupProvider, registeredProviders } from '../src/remote/registry.js';

// End-to-end against the built CLI for the offline half of LP-287 and LP-367:
// `lpm remote resolve` records a decision and never makes a request, and
// `lpm remote unlink` / `lpm remote link` validation run before any connector
// is built, so they can all be driven with no connector.  `status` (which
// fetches) is covered by the pure planner in test/remote-conflicts.test.ts;
// this suite exercises the command's parsing, validation and persistence.
const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));

const dirs: string[] = [];
let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(path.join(os.tmpdir(), 'lpm-remote-cli-'));
  dirs.push(cwd);
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function lpm(...args: string[]): Run {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    // A conventional GITHUB_TOKEN, so the connector builds offline; none of
    // these tests make a network request, but credential resolution (LP-295)
    // runs when a connector is built.
    env: { ...process.env, NO_COLOR: '1', LPM_BOARD_PATH: '', GITHUB_TOKEN: 'ghp_test' },
  });
  return { status: result.status ?? 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** A GitHub remote declaration whose mapping totals the scrum template's statuses. */
const REMOTES = `
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    connection:
      repo: acme/payments
    mapping:
      types:
        user_story: { labels: [story] }
      statuses:
        backlog: Backlog
        ready: Ready
        in_progress: In Progress
        in_review: In Review
        done: { remote: [Done], push: Done, closed: true }
      attributes:
        story_points: Points
      periods:
        container: sprint
`;

const LINKED_ISSUE = `---
id: LP-12
type: user_story
title: Login page
status: in_progress
---

Body.
`;

const LINKS = {
  version: 1,
  cursor: null,
  links: {
    'LP-12': {
      remoteId: 'I_1',
      remoteKey: 'acme/payments#1',
      remoteUrl: 'https://github.com/acme/payments/issues/1',
      syncedAt: '2026-08-15T00:00:00.000Z',
      remoteRev: 'r1',
      base: {
        title: 'Login page',
        body: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        status: 'in_progress',
        story_points: 5,
      },
    },
  },
};

/**
 * A whole `remotes:` block for a provider other than GitHub, for the credential
 * and setup tests. Each *replaces* the block `setup()` wrote rather than adding
 * to it: two remotes may never mirror the same work, and `upstream` claims the
 * whole board, so appending one would be refused by the config check.
 */
const JIRA_REMOTE = `
remotes:
  jira:
    provider: jira
    on_delete: unlink
    conflict: manual
    connection:
      site: https://acme.atlassian.net
      project: PAY
    mapping:
      types:
        user_story: Story
      statuses:
        backlog: To Do
        ready: To Do
        in_progress: In Progress
        in_review: In Progress
        done: { remote: Done, closed: true }
      periods:
        container: sprint
`;

const LINEAR_REMOTE = `
remotes:
  lin:
    provider: linear
    on_delete: unlink
    conflict: manual
    connection:
      team: ENG
    mapping:
      statuses:
        backlog: Backlog
        ready: Todo
        in_progress: In Progress
        in_review: In Review
        done: { remote: Done, closed: true }
      periods:
        container: sprint
`;

const JSONFILE_REMOTE = `
remotes:
  demo:
    provider: jsonfile
    on_delete: unlink
    conflict: manual
    connection:
      file: .lpm/remotes/demo/tracker.json
    mapping:
      statuses:
        backlog: Backlog
        ready: Ready
        in_progress: In Progress
        in_review: In Review
        done: { remote: Done, closed: true }
`;

/** Replace the board's `remotes:` block with one of the fixtures above. */
function declare(block: string): void {
  const configPath = path.join(cwd, '.lpm/config.yml');
  const config = readFileSync(configPath, 'utf8');
  const at = config.indexOf('\nremotes:');
  writeFileSync(configPath, (at === -1 ? config : config.slice(0, at)) + block);
}

function setup(): void {
  expect(lpm('init', '--no-git').status).toBe(0);
  const config = readFileSync(path.join(cwd, '.lpm/config.yml'), 'utf8');
  writeFileSync(path.join(cwd, '.lpm/config.yml'), config + REMOTES);

  mkdirSync(path.join(cwd, '.lpm/board/LP-12'), { recursive: true });
  writeFileSync(path.join(cwd, '.lpm/board/LP-12/_issue.md'), LINKED_ISSUE);

  mkdirSync(path.join(cwd, '.lpm/board/LP-13'), { recursive: true });
  writeFileSync(
    path.join(cwd, '.lpm/board/LP-13/_issue.md'),
    LINKED_ISSUE.replace('id: LP-12', 'id: LP-13').replace('title: Login page', 'title: Signup page'),
  );

  mkdirSync(path.join(cwd, '.lpm/remotes/upstream'), { recursive: true });
  writeFileSync(
    path.join(cwd, '.lpm/remotes/upstream/links.json'),
    JSON.stringify(LINKS, null, 2),
  );
}

function resolutionsOnDisk(): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(cwd, '.lpm/remotes/upstream/resolutions.json'), 'utf8'));
}

function auditOnDisk(): string {
  return readFileSync(path.join(cwd, '.lpm/remotes/upstream/audit.log'), 'utf8');
}

describe('lpm remote status', () => {
  it('reports in sync with exit 0 when nothing is linked (no fetch needed)', () => {
    expect(lpm('init', '--no-git').status).toBe(0);
    const config = readFileSync(path.join(cwd, '.lpm/config.yml'), 'utf8');
    writeFileSync(path.join(cwd, '.lpm/config.yml'), config + REMOTES);

    const run = lpm('remote', 'status');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('In sync');
  });

  it('--json emits the report DTO and the exit code still signals drift', () => {
    setup();
    expect(lpm('remote', 'decouple', 'LP-12').status).toBe(0);

    const run = lpm('remote', 'status', '--json');
    expect(run.status).toBe(1);
    const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(parsed.remote).toMatchObject({
      name: 'upstream',
      provider: 'github',
      target: 'acme/payments',
    });
    expect(parsed.ahead).toEqual([]);
    expect(parsed.unlinked).toEqual(['LP-13']);
    expect(parsed).not.toHaveProperty('fields');
  });

  it('with no credentials reports the local half and says the remote half is missing', () => {
    setup();
    const run = spawnSync(process.execPath, [CLI, 'remote', 'status'], {
      cwd,
      encoding: 'utf8',
      // No GITHUB_TOKEN: the connector cannot be built, so nothing is fetched.
      env: { ...process.env, NO_COLOR: '1', LPM_BOARD_PATH: '', GITHUB_TOKEN: '' },
    });
    expect(run.status ?? 0).toBe(1);
    // The bucket is labelled `not synced` on screen: "unlinked" described the
    // link store rather than what a reader needs to know about the document.
    expect(run.stdout).toContain('not synced');
    expect(run.stdout).toContain('No credential');
  });
});

describe('lpm remote resolve', () => {
  it('--local records a whole-document decision and writes the audit log', () => {
    setup();
    const run = lpm('remote', 'resolve', 'LP-12', '--local');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Resolved LP-12');
    expect(run.stdout).toContain('default');

    const store = resolutionsOnDisk();
    expect(store.resolutions).toEqual({ 'LP-12': { default: 'local' } });

    const audit = JSON.parse(auditOnDisk().trim());
    expect(audit.localId).toBe('LP-12');
    expect(audit.default).toBe('local');
  });

  it('--field ... --remote / --field ... --local resolves per field', () => {
    setup();
    const run = lpm('remote', 'resolve', 'LP-12', '--field', 'status', '--remote', '--field', 'title', '--local');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('status');
    expect(run.stdout).toContain('title');

    const store = resolutionsOnDisk();
    expect(store.resolutions).toEqual({
      'LP-12': { fields: { status: 'remote', title: 'local' } },
    });
  });

  it('refuses a field the mapping does not track', () => {
    setup();
    const run = lpm('remote', 'resolve', 'LP-12', '--field', 'priority', '--local');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('not a field');
  });

  it('refuses a document that is not linked', () => {
    setup();
    const run = lpm('remote', 'resolve', 'LP-13', '--local');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('not linked');
  });

  it('refuses a call with no decision', () => {
    setup();
    const run = lpm('remote', 'resolve', 'LP-12');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Nothing to resolve');
  });
});

describe('lpm remote decouple', () => {
  it('records a tombstone, drops the link and its base, and leaves the remote untouched', () => {
    setup();
    const run = lpm('remote', 'decouple', 'LP-12');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Decoupled LP-12');
    expect(run.stdout).toContain('manual');
    expect(run.stdout).toContain('acme/payments#1');

    const links = JSON.parse(readFileSync(path.join(cwd, '.lpm/remotes/upstream/links.json'), 'utf8'));
    expect(links.links['LP-12']).toBeUndefined();
    expect(links.tombstones['LP-12'].reason).toBe('manual');
    expect(links.tombstones['LP-12'].remoteKey).toBe('acme/payments#1');
    expect(links.tombstones['LP-12'].at).toBeTruthy();
  });

  it('--reason out_of_scope records that reason', () => {
    setup();
    const run = lpm('remote', 'decouple', 'LP-12', '--reason', 'out_of_scope');
    expect(run.status).toBe(0);

    const links = JSON.parse(readFileSync(path.join(cwd, '.lpm/remotes/upstream/links.json'), 'utf8'));
    expect(links.tombstones['LP-12'].reason).toBe('out_of_scope');
  });

  it('refuses a document that is neither linked nor decoupled', () => {
    setup();
    const run = lpm('remote', 'decouple', 'LP-13');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('neither linked nor decoupled');
  });

  it('refuses an unknown reason', () => {
    setup();
    const run = lpm('remote', 'decouple', 'LP-12', '--reason', 'bogus');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('--reason');
  });
});

describe('lpm remote relink', () => {
  it('clears the tombstone so the document is a plain unlinked document again', () => {
    setup();
    expect(lpm('remote', 'decouple', 'LP-12').status).toBe(0);

    const run = lpm('remote', 'relink', 'LP-12');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Re-linked LP-12');

    const links = JSON.parse(readFileSync(path.join(cwd, '.lpm/remotes/upstream/links.json'), 'utf8'));
    expect(links.tombstones).toBeUndefined();
    expect(links.links['LP-12']).toBeUndefined();
  });

  it('refuses a document that is not decoupled', () => {
    setup();
    const run = lpm('remote', 'relink', 'LP-13');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('not decoupled');
  });
});

describe('lpm remote unlink', () => {
  it('drops the link with no tombstone, leaving the remote untouched', () => {
    setup();
    const run = lpm('remote', 'unlink', 'upstream', 'LP-12');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Unlinked LP-12');
    expect(run.stdout).toContain('acme/payments#1');

    const links = JSON.parse(readFileSync(path.join(cwd, '.lpm/remotes/upstream/links.json'), 'utf8'));
    expect(links.links['LP-12']).toBeUndefined();
    expect(links.tombstones).toBeUndefined();
  });

  it('--dry-run says what would happen and writes nothing', () => {
    setup();
    const run = lpm('remote', 'unlink', 'upstream', 'LP-12', '--dry-run');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Would unlink LP-12');
    expect(run.stdout).toContain('Dry run');

    const links = JSON.parse(readFileSync(path.join(cwd, '.lpm/remotes/upstream/links.json'), 'utf8'));
    expect(links.links['LP-12']).toBeDefined();
  });

  it('refuses a document that is not linked', () => {
    setup();
    const run = lpm('remote', 'unlink', 'upstream', 'LP-13');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('not linked');
  });

  it('refuses an unknown remote', () => {
    setup();
    const run = lpm('remote', 'unlink', 'bogus', 'LP-12');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('No remote named "bogus"');
  });
});

describe('lpm remote link', () => {
  it('refuses a call with no remote key', () => {
    setup();
    const run = lpm('remote', 'link', 'upstream', 'LP-12');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Usage');
  });

  it('refuses a document that is not on the board, before any connector is built', () => {
    setup();
    const run = lpm('remote', 'link', 'upstream', 'LP-999', 'acme/payments#1');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('No document "LP-999"');
  });

  it('refuses an unknown remote', () => {
    setup();
    const run = lpm('remote', 'link', 'bogus', 'LP-12', 'acme/payments#1');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('No remote named "bogus"');
  });
});

describe('lpm remote status reports incoming work', () => {
  /**
   * The bucket nothing could report before.
   *
   * `jsonfile` is the remote because its tracker is a local file: the whole
   * path — the listing, the pull seams that read the parent out of the managed
   * block, `describe` for the key — runs with no credential and no network, so
   * this is an ordinary offline CLI test of the thing that used to need a live
   * Jira to observe at all.
   */
  function jsonfileBoard(issues: unknown[], links: Record<string, unknown>): void {
    expect(lpm('init', '--no-git').status).toBe(0);
    declare(JSONFILE_REMOTE);
    // A document that *agrees* with tracker issue #1, so the only drift in the
    // report is the incoming one. Reusing the suite's LINKED_ISSUE would put
    // every field in conflict and the assertion would be about that instead.
    mkdirSync(path.join(cwd, '.lpm/board/LP-12'), { recursive: true });
    writeFileSync(
      path.join(cwd, '.lpm/board/LP-12/_issue.md'),
      `---\nid: LP-12\ntype: feature\ntitle: Login page\nstatus: backlog\n---\n\nProse.\n`,
    );
    mkdirSync(path.join(cwd, '.lpm/remotes/demo'), { recursive: true });
    writeFileSync(
      path.join(cwd, '.lpm/remotes/demo/tracker.json'),
      JSON.stringify({ version: 1, issues, next_number: 99 }, null, 2),
    );
    writeFileSync(
      path.join(cwd, '.lpm/remotes/demo/links.json'),
      JSON.stringify({ version: 1, cursor: null, links }, null, 2),
    );
  }

  const trackerIssue = (number: number, title: string, parent?: number): Record<string, unknown> => ({
    number,
    title,
    body:
      parent === undefined
        ? 'Prose.'
        : [
            'Prose.',
            '',
            '<!-- lpm:begin -->',
            '| light-plan | |',
            '| --- | --- |',
            `| parent | ${parent} |`,
            '<!-- lpm:end -->',
          ].join('\n'),
    status: 'Backlog',
    type: 'feature',
    labels: [],
    assignee: null,
    depends_on: [],
    comments: [],
    created_at: '2026-09-01T10:00:00Z',
    updated_at: '2026-09-01T10:00:00Z',
  });

  const twin = {
    remoteId: '1',
    remoteKey: '#1',
    remoteUrl: 'file://tracker#1',
    syncedAt: '2026-09-01T10:00:00Z',
    remoteRev: '2026-09-01T10:00:00Z',
  };

  it('names a remote issue with no local document, and how to adopt it', () => {
    jsonfileBoard(
      [trackerIssue(1, 'Login page'), trackerIssue(2, 'Paginate the query API', 1)],
      { 'LP-12': twin },
    );

    const run = lpm('remote', 'status', 'demo');

    // Drift, not "in sync" — which is what it used to say.
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('incoming');
    expect(run.stdout).toContain('#2');
    expect(run.stdout).toContain('Paginate the query API');
    // The report says where a pull would put it, and what to type.
    expect(run.stdout).toContain('would land under LP-12');
    expect(run.stdout).toContain('lpm remote pull demo');
  });

  it('says what the remote half was read from', () => {
    jsonfileBoard([trackerIssue(1, 'Login page')], { 'LP-12': twin });

    const run = lpm('remote', 'status', 'demo');

    expect(run.stdout).toContain('read 1 remote issue in the project');
  });

  it('--json carries incoming through the DTO', () => {
    jsonfileBoard(
      [trackerIssue(1, 'Login page'), trackerIssue(2, 'Added upstream', 1)],
      { 'LP-12': twin },
    );

    const run = lpm('remote', 'status', 'demo', '--json');

    const parsed = JSON.parse(run.stdout) as { incoming: Array<Record<string, unknown>> };
    expect(parsed.incoming).toHaveLength(1);
    expect(parsed.incoming[0]).toMatchObject({
      remoteId: '2',
      remoteKey: '#2',
      title: 'Added upstream',
      parentLocalId: 'LP-12',
    });
  });

  it('--local answers without reading the tracker at all', () => {
    jsonfileBoard(
      [trackerIssue(1, 'Login page'), trackerIssue(2, 'Added upstream', 1)],
      { 'LP-12': twin },
    );

    const run = lpm('remote', 'status', 'demo', '--local');

    // The tracker holds incoming work; --local did not look, and says so rather
    // than reporting an empty bucket as though it had.
    const parsed = JSON.parse(lpm('remote', 'status', 'demo', '--local', '--json').stdout) as {
      incoming: unknown[];
      remoteMissing?: string;
    };
    expect(parsed.incoming).toEqual([]);
    expect(parsed.remoteMissing).toContain('not read');
    expect(run.stdout).not.toContain('read 2 remote issues');
  });

  it('progress goes to stderr so --json stdout stays parseable', () => {
    jsonfileBoard([trackerIssue(1, 'Login page')], { 'LP-12': twin });

    const run = lpm('remote', 'status', 'demo', '--json');

    expect(() => JSON.parse(run.stdout)).not.toThrow();
    expect(run.stderr).toContain('reading the tracker');
  });
});

describe('lpm remote status shows decoupled documents', () => {
  it('lists a decoupled document distinct from never-linked ones', () => {
    setup();
    expect(lpm('remote', 'decouple', 'LP-12').status).toBe(0);

    const run = lpm('remote', 'status');
    // LP-13 is never pushed, so the board has drifted — exit 1.
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('decoupled');
    expect(run.stdout).toContain('LP-12');
    expect(run.stdout).toContain('manual');
    expect(run.stdout).toContain('acme/payments#1');
    // The bucket is labelled `not synced` on screen: "unlinked" described the
    // link store rather than what a reader needs to know about the document.
    expect(run.stdout).toContain('not synced');
    expect(run.stdout).toContain('LP-13');
  });
});

describe('lpm remote login', () => {
  function loginWithInput(input: string, ...args: string[]): Run {
    const result = spawnSync(process.execPath, [CLI, 'remote', 'login', ...args], {
      cwd,
      encoding: 'utf8',
      input,
      env: { ...process.env, NO_COLOR: '1', LPM_BOARD_PATH: '', GITHUB_TOKEN: 'ghp_test' },
    });
    return { status: result.status ?? 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  it('reads the token from stdin, writes it, and never echoes it (LP-295)', () => {
    setup();
    const token = 'ghp_secretNotEchoed';
    const run = loginWithInput(`${token}\n`, 'upstream');
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain(token);
    expect(run.stdout).toContain('upstream');

    const credentials = JSON.parse(readFileSync(path.join(cwd, '.lpm/credentials.json'), 'utf8'));
    expect(credentials.upstream.token).toBe(token);
    expect(readFileSync(path.join(cwd, '.lpm/.gitignore'), 'utf8')).toContain('credentials.json');
  });

  it('refuses an empty token', () => {
    setup();
    const run = loginWithInput('\n', 'upstream');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('No token given');
  });

  it('refuses an unknown remote', () => {
    setup();
    const run = loginWithInput('ghp_x\n', 'bogus');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('No remote named "bogus"');
  });

  it("writes under the provider's own secret key, not a hard-coded `token`", () => {
    // A Linear remote's secret is `api_key`. `login` used to write every value
    // under `token`, so it stored the key where nothing would look for it — and
    // the workaround was documented rather than fixed.
    setup();
    declare(LINEAR_REMOTE);
    const run = loginWithInput('lin_api_key_value\n', 'lin');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('api_key');

    const credentials = JSON.parse(readFileSync(path.join(cwd, '.lpm/credentials.json'), 'utf8'));
    expect(credentials.lin.api_key).toBe('lin_api_key_value');
    expect(credentials.lin.token).toBeUndefined();
  });

  it('--key names one of several secrets, which is how a Jira email is stored', () => {
    setup();
    declare(JIRA_REMOTE);
    // The default lands on the token (Jira declares email *and* token).
    expect(loginWithInput('api-token\n', 'jira').status).toBe(0);
    expect(loginWithInput('me@acme.com\n', 'jira', '--key', 'email').status).toBe(0);

    const credentials = JSON.parse(readFileSync(path.join(cwd, '.lpm/credentials.json'), 'utf8'));
    expect(credentials.jira).toEqual({ token: 'api-token', email: 'me@acme.com' });
  });

  it('refuses a --key the provider does not declare, naming the ones it does', () => {
    setup();
    const run = loginWithInput('x\n', 'upstream', '--key', 'password');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('"password" is not a credential of provider "github"');
    expect(run.stderr).toContain('token');
  });

  it('refuses a provider that holds no secrets at all', () => {
    setup();
    declare(JSONFILE_REMOTE);
    const run = loginWithInput('x\n', 'demo');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('needs no credential');
  });

  /**
   * Drive the CLI as if stdin were a terminal. Node has no pty, so the flag the
   * command branches on is set by a loader that then imports the CLI — which is
   * exactly what the command asks about, and the stdin it reads is still a pipe
   * the test controls.
   */
  function loginAtTerminal(input: string, ...args: string[]): Run {
    const loader = path.join(cwd, 'terminal.mjs');
    writeFileSync(
      loader,
      `Object.defineProperty(process.stdin, 'isTTY', { value: true });\n` +
        `await import(${JSON.stringify(pathToFileURL(CLI).href)});\n`,
    );
    const result = spawnSync(process.execPath, [loader, 'remote', 'login', ...args], {
      cwd,
      encoding: 'utf8',
      input,
      env: { ...process.env, NO_COLOR: '1', LPM_BOARD_PATH: '' },
    });
    return { status: result.status ?? 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  it('asks for every credential key at a terminal, in one command', () => {
    // The Jira pair used to be two invocations and a shell pipe each; a person
    // holding an email and a token should be able to answer two questions.
    setup();
    declare(JIRA_REMOTE);
    const run = loginAtTerminal('me@acme.com\nthe-api-token\n', 'jira');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('email');
    expect(run.stdout).toContain('token');
    // Neither value is echoed back, whichever way it was read.
    expect(run.stdout).not.toContain('the-api-token');

    const credentials = JSON.parse(readFileSync(path.join(cwd, '.lpm/credentials.json'), 'utf8'));
    expect(credentials.jira).toEqual({ email: 'me@acme.com', token: 'the-api-token' });
  });

  it('keeps a credential that already resolves when the answer is a bare Enter', () => {
    // Replacing one expired token must not demand the email back.
    setup();
    declare(JIRA_REMOTE);
    expect(loginAtTerminal('me@acme.com\nfirst-token\n', 'jira').status).toBe(0);

    const run = loginAtTerminal('\nsecond-token\n', 'jira');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('already set');

    const credentials = JSON.parse(readFileSync(path.join(cwd, '.lpm/credentials.json'), 'utf8'));
    expect(credentials.jira).toEqual({ email: 'me@acme.com', token: 'second-token' });
  });

  it('writes nothing when every question is answered with Enter', () => {
    setup();
    declare(JIRA_REMOTE);
    const run = loginAtTerminal('\n\n', 'jira');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Nothing changed');
    expect(existsSync(path.join(cwd, '.lpm/credentials.json'))).toBe(false);
  });

  it('--key asks for one of several, at a terminal too', () => {
    setup();
    declare(JIRA_REMOTE);
    const run = loginAtTerminal('me@acme.com\n', 'jira', '--key', 'email');
    expect(run.status).toBe(0);

    const credentials = JSON.parse(readFileSync(path.join(cwd, '.lpm/credentials.json'), 'utf8'));
    expect(credentials.jira).toEqual({ email: 'me@acme.com' });
  });
});

describe('lpm remote setup', () => {
  it('stops on a missing credential, naming where to create it and how to give it', () => {
    // The whole point of the command: the step after `add` is a credential, and
    // the tool knows the page, the key and the places a value may live.
    setup();
    declare(JIRA_REMOTE);
    const run = lpm('remote', 'setup', 'jira');
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('https://id.atlassian.com');
    expect(run.stdout).toContain('lpm remote login jira');
    // One command asks for both halves of the Jira credential; the per-key
    // pipe is the scripted form, not the thing a person is sent to do.
    expect(run.stdout).toContain('asks for email and token');
    expect(run.stdout).toContain('Setup stopped');
    // Read-only: a stopped setup has changed nothing.
    expect(readFileSync(path.join(cwd, '.lpm/config.yml'), 'utf8')).toContain('backlog: To Do');
  });

  it('reports a provider with no vocabulary to ask about, and exits 0', () => {
    // jsonfile writes whatever the mapping says, so there is nothing to
    // reconcile and nothing to provision — a clean bill of health, not an error.
    setup();
    declare(JSONFILE_REMOTE);
    const run = lpm('remote', 'setup', 'demo');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('no vocabulary to ask about');
    expect(run.stdout).toContain('reachable');
  });

  it('refuses an unknown remote', () => {
    setup();
    const run = lpm('remote', 'setup', 'bogus');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('No remote named "bogus"');
  });
});

describe('lpm remote push / pull / sync (offline validation)', () => {
  it('help names the add, rm, push, pull and sync subcommands', () => {
    const run = lpm('remote', '--help');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('lpm remote add');
    expect(run.stdout).toContain('lpm remote rm');
    expect(run.stdout).toContain('lpm remote push');
    expect(run.stdout).toContain('lpm remote pull');
    expect(run.stdout).toContain('lpm remote sync');
  });

  it('help documents --yes and the first-write / threshold guard', () => {
    const run = lpm('remote', '--help');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('--yes');
    expect(run.stdout).toContain('first write');
    expect(run.stdout).toContain('write_threshold');
  });

  it('accepts --yes as a push option (no unknown-option error)', () => {
    expect(lpm('init', '--no-git').status).toBe(0);
    const config = readFileSync(path.join(cwd, '.lpm/config.yml'), 'utf8');
    writeFileSync(
      path.join(cwd, '.lpm/config.yml'),
      config +
        '\nremotes:\n  upstream:\n    provider: github\n    on_delete: unlink\n    conflict: manual\n    connection: {}\n    mapping: {}\n',
    );
    // The remote is misconfigured (no repo), so the run fails before any
    // request — the point is that --yes parsed rather than being refused as an
    // unknown option.
    const run = lpm('remote', 'push', '--yes');
    expect(run.status).toBe(1);
    expect(run.stderr).not.toContain('Unknown option');
    expect(run.stdout).toContain('failed');
  });

  it('refuses a word that is neither a remote nor a document, before any connector is built', () => {
    // `--filter <id>` used to say this; a document id is simply a positional
    // now, so a typo has to be caught as one.
    setup();
    const run = lpm('remote', 'push', 'NOPE');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('neither a remote nor a document');
  });

  it('refuses a non-integer --limit', () => {
    setup();
    const run = lpm('remote', 'push', '--limit', 'nope');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('--limit must be a positive integer');
  });

  it('explains how to connect a remote when the board has none', () => {
    expect(lpm('init', '--no-git').status).toBe(0);
    const run = lpm('remote', 'push');
    expect(run.status).toBe(1);
    // One command, named — not a description of the YAML to go and write.
    expect(run.stderr).toContain('not connected to a remote');
    expect(run.stderr).toContain('lpm remote connect');
  });

  it('reports a misconfigured remote and exits non-zero', () => {
    expect(lpm('init', '--no-git').status).toBe(0);
    const config = readFileSync(path.join(cwd, '.lpm/config.yml'), 'utf8');
    writeFileSync(
      path.join(cwd, '.lpm/config.yml'),
      config +
        '\nremotes:\n  upstream:\n    provider: github\n    on_delete: unlink\n    conflict: manual\n    connection: {}\n    mapping: {}\n',
    );
    const run = lpm('remote', 'push');
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('Remote upstream');
    expect(run.stdout).toContain('failed');
  });
});

describe('lpm remote add', () => {
  function freshConfig(): string {
    expect(lpm('init', '--no-git').status).toBe(0);
    return readFileSync(path.join(cwd, '.lpm/config.yml'), 'utf8');
  }

  it('writes the remotes block, preserving the rest of the file and its comments', () => {
    freshConfig();
    const run = lpm('remote', 'add', 'upstream', '--provider', 'github', '--repo', 'acme/payments');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Added remote upstream');
    expect(run.stdout).toContain('acme/payments');

    const after = readFileSync(path.join(cwd, '.lpm/config.yml'), 'utf8');
    // The remotes block lands after the rest of the config, whose comments and
    // key order survive (a parse-and-restringify would have dropped them).
    expect(after).toContain('# Kanban columns, in board order.');
    expect(after.indexOf('remotes:')).toBeGreaterThan(after.indexOf('issue_types:'));
    expect(after).toContain('provider: github');
    expect(after).toContain('on_delete: unlink');
    expect(after).toContain('conflict: manual');
    expect(after).toContain('repo: acme/payments');
  });

  it('prompts for a missing required key and writes nothing', () => {
    freshConfig();
    const run = lpm('remote', 'add', 'jira', '--provider', 'jira', '--project', 'PAY');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('--site');
    // A built-in template ships a commented-out `remotes:` example, so the raw
    // substring is present in every fresh config — assert no *active* (flush-
    // left, uncommented) `remotes:` key was written instead.
    expect(readFileSync(path.join(cwd, '.lpm/config.yml'), 'utf8')).not.toMatch(/^remotes:/m);
  });

  it('refuses a malformed value by the provider schema', () => {
    freshConfig();
    const run = lpm('remote', 'add', 'bad', '--provider', 'github', '--repo', 'not-a-repo');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('--repo');
    expect(readFileSync(path.join(cwd, '.lpm/config.yml'), 'utf8')).not.toMatch(/^remotes:/m);
  });

  it('refuses a connection flag the provider does not know', () => {
    freshConfig();
    const run = lpm('remote', 'add', 'lin', '--provider', 'linear', '--repo', 'acme/payments');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('not a connection option');
  });

  it('refuses a name that already exists unless --force', () => {
    freshConfig();
    expect(
      lpm('remote', 'add', 'upstream', '--provider', 'github', '--repo', 'acme/payments').status,
    ).toBe(0);

    const refused = lpm('remote', 'add', 'upstream', '--provider', 'github', '--repo', 'other/repo');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('already exists');

    const forced = lpm('remote', 'add', 'upstream', '--provider', 'github', '--repo', 'other/repo', '--force');
    expect(forced.status).toBe(0);
    expect(forced.stdout).toContain('replaced');
    expect(readFileSync(path.join(cwd, '.lpm/config.yml'), 'utf8')).toContain('repo: other/repo');
  });

  it('refuses a name that is not lower_snake_case', () => {
    freshConfig();
    const run = lpm('remote', 'add', 'Bad-Name', '--provider', 'github', '--repo', 'a/b');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Invalid remote name');
  });
});

describe('lpm remote rm', () => {
  it('removes the config entry and keeps the link store; --purge removes it too', () => {
    expect(lpm('init', '--no-git').status).toBe(0);
    expect(lpm('remote', 'add', 'upstream', '--provider', 'github', '--repo', 'acme/payments').status).toBe(0);

    mkdirSync(path.join(cwd, '.lpm/remotes/upstream'), { recursive: true });
    writeFileSync(path.join(cwd, '.lpm/remotes/upstream/links.json'), '{"version":1}\n');

    const rm = lpm('remote', 'rm', 'upstream');
    expect(rm.status).toBe(0);
    expect(rm.stdout).toContain('Kept the per-remote state');
    // A built-in template ships a commented-out `provider: github` example, so
    // assert the *declared* remote's own connection value is gone rather than
    // the bare substring.
    expect(readFileSync(path.join(cwd, '.lpm/config.yml'), 'utf8')).not.toContain('repo: acme/payments');
    expect(existsSync(path.join(cwd, '.lpm/remotes/upstream/links.json'))).toBe(true);

    // Re-add, then purge.
    expect(lpm('remote', 'add', 'upstream', '--provider', 'github', '--repo', 'acme/payments').status).toBe(0);
    const purge = lpm('remote', 'rm', 'upstream', '--purge');
    expect(purge.status).toBe(0);
    expect(purge.stdout).toContain('Deleted the per-remote state');
    expect(existsSync(path.join(cwd, '.lpm/remotes/upstream'))).toBe(false);
  });

  it('refuses a remote that is not declared', () => {
    expect(lpm('init', '--no-git').status).toBe(0);
    const run = lpm('remote', 'rm', 'bogus');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('No remote named "bogus"');
  });
});

describe('lpm remote (list)', () => {
  it('lists each remote with provider, target, direction and last sync', () => {
    expect(lpm('init', '--no-git').status).toBe(0);
    expect(lpm('remote', 'add', 'upstream', '--provider', 'github', '--repo', 'acme/payments').status).toBe(0);

    const run = lpm('remote');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('upstream');
    expect(run.stdout).toContain('github');
    expect(run.stdout).toContain('acme/payments');
    expect(run.stdout).toContain('both');
    expect(run.stdout).toContain('never');
  });

  it('explains how to connect one when none are declared', () => {
    expect(lpm('init', '--no-git').status).toBe(0);
    const run = lpm('remote');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('not connected to a tracker');
    // The one command, and a worked example per provider it could be.
    expect(run.stdout).toContain('lpm remote connect');
    expect(run.stdout).toContain('--repo owner/repo');
  });
});

describe('lpm remote log', () => {
  const entry = (at: string, author: string, direction: 'push' | 'pull' | 'both') => ({
    at,
    author,
    remote: 'upstream',
    direction,
    counts: {
      created: 1,
      updated: 0,
      skipped: 0,
      conflicted: 0,
      failed: 0,
      pulled: 0,
      linked: 0,
      unlinked: 0,
      decoupled: 0,
    },
    operations: [],
  });

  function writeLog(...entries: unknown[]): void {
    const file = path.join(cwd, '.lpm/remotes/upstream/log.jsonl');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, entries.map((line) => JSON.stringify(line)).join('\n') + '\n');
  }

  it('renders the last runs, most recent first', () => {
    setup();
    writeLog(
      entry('2026-08-20T10:00:00.000Z', 'alice', 'push'),
      entry('2026-08-21T11:00:00.000Z', 'bob', 'both'),
    );

    const run = lpm('remote', 'log');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('bob');
    expect(run.stdout).toContain('alice');
    // Most recent first: bob's later run appears before alice's.
    expect(run.stdout.indexOf('bob')).toBeLessThan(run.stdout.indexOf('alice'));
  });

  it('--since keeps only runs at or after the timestamp', () => {
    setup();
    writeLog(
      entry('2026-08-20T10:00:00.000Z', 'alice', 'push'),
      entry('2026-08-21T11:00:00.000Z', 'bob', 'both'),
    );

    const run = lpm('remote', 'log', '--since', '2026-08-21T00:00:00Z');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('bob');
    expect(run.stdout).not.toContain('alice');
  });

  it('--json emits the entries as JSON, nothing else', () => {
    setup();
    writeLog(entry('2026-08-20T10:00:00.000Z', 'alice', 'push'));

    const run = lpm('remote', 'log', '--json');
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout) as Array<{ author: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.author).toBe('alice');
  });

  it('says no syncs recorded yet when the log is empty', () => {
    setup();
    const run = lpm('remote', 'log');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('no syncs recorded yet');
  });

  it('refuses an unknown remote', () => {
    setup();
    const run = lpm('remote', 'log', 'bogus');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('No remote named "bogus"');
  });
});

/**
 * `lpm remote add` — the connection flags, driven off the registry rather than
 * a list written here.
 *
 * LP-530: the command declared its `parseArgs` options as a hand-written table
 * of the three providers that existed when it was written, so the `jsonfile`
 * provider's `--file` was rejected by the parser and the provider could not be
 * declared from the CLI at all — while its schema, its error hint and
 * `addRemote` all knew the key by name. The tests that should have caught it
 * listed `github`, `jira` and `linear` one by one, which is the same mistake in
 * the test suite. Every case below iterates `registeredProviders()`.
 */
describe('lpm remote add — connection flags', () => {
  it('parses every non-secret connection key of every registered provider', () => {
    setup();
    for (const name of registeredProviders()) {
      const flags = connectionFlags(lookupProvider(name));
      expect(flags.length, `${name} declares at least one non-secret connection key`).toBeGreaterThan(0);
      for (const flag of flags) {
        const args = flag.type === 'boolean' ? [] : ['probe-value'];
        const run = lpm('remote', 'add', 'probe', '--provider', name, `--${flag.name}`, ...args);
        // The value may well fail the provider's own schema — `probe-value` is
        // not an `owner/repo`. What must never happen is the *parser* refusing
        // the flag, which is the shape of the LP-530 defect.
        expect(run.stderr, `${name} --${flag.name} reached the provider schema`).not.toContain(
          'Unknown option',
        );
      }
    }
  });

  it('never offers a secret key as a flag', () => {
    setup();
    for (const name of registeredProviders()) {
      const secrets = secretKeyNames(lookupProvider(name));
      const offered = new Set(connectionFlags(lookupProvider(name)).map((flag) => flag.name));
      for (const secret of secrets) {
        expect(offered.has(secret), `${name} --${secret} is not a flag`).toBe(false);
      }
    }
  });

  it('declares a remote for every registered provider and writes it to config.yml', () => {
    // One minimal *valid* connection per provider. The guard below is what
    // keeps this honest: a fifth provider fails here until somebody adds its
    // sample, rather than being quietly untested.
    const minimal: Record<string, string[]> = {
      github: ['--repo', 'acme/payments'],
      jira: ['--site', 'https://acme.atlassian.net', '--project', 'PAY'],
      jsonfile: ['--file', '.lpm/remotes/demo/tracker.json'],
      linear: ['--team', 'ENG'],
    };
    expect(Object.keys(minimal).sort()).toEqual(registeredProviders());

    setup();
    // Two remotes may not claim the same documents, and `setup()`'s `upstream`
    // already claims the whole board — so each probe gets a scope of its own.
    // A distinct document per provider is the simplest way to satisfy that.
    const scopes = registeredProviders().map((_, index) => `LP-${100 + index}`);
    for (const scope of scopes) {
      mkdirSync(path.join(cwd, `.lpm/board/${scope}`), { recursive: true });
      writeFileSync(
        path.join(cwd, `.lpm/board/${scope}/_issue.md`),
        LINKED_ISSUE.replace('id: LP-12', `id: ${scope}`).replace('title: Login page', `title: Scope ${scope}`),
      );
    }
    // `upstream` claims the whole board; narrow it so the probes can coexist.
    // Anchored to the real entry's exact indentation — a built-in template
    // ships a commented-out `provider: github` example too, and a bare
    // substring replace would land the scope inside that comment instead.
    const withScope = readFileSync(path.join(cwd, '.lpm/config.yml'), 'utf8').replace(
      '\n    provider: github',
      '\n    provider: github\n    scope: LP-12',
    );
    writeFileSync(path.join(cwd, '.lpm/config.yml'), withScope);

    for (const [index, name] of registeredProviders().entries()) {
      const run = lpm('remote', 'add', `probe_${name}`, '--provider', name, ...minimal[name]!, '--scope', scopes[index]!);
      expect(run.status, `${name}: ${run.stderr}`).toBe(0);
      expect(run.stdout).toContain(`Added remote probe_${name}`);
    }

    const config = readFileSync(path.join(cwd, '.lpm/config.yml'), 'utf8');
    for (const name of registeredProviders()) {
      expect(config).toContain(`probe_${name}:`);
    }

    // The board still *parses* with all of them declared — `addRemote`
    // re-validates the whole file before writing, and each add after the
    // first proves the previous one left a loadable config behind. `add`
    // drafts a mapping rather than leaving one empty, but a provider whose
    // remote vocabulary genuinely cannot be guessed (Jira's workflow names,
    // Linear's states) still comes back with unresolved `TODO:` markers a
    // human has to answer before that remote will open.
    expect(lpm('remote').status).toBe(0);
    for (const name of registeredProviders()) {
      expect(lpm('remote').stdout).toContain(`probe_${name}`);
    }
  });

  it('refuses a flag that belongs to another provider, naming the ones that work', () => {
    setup();
    const run = lpm('remote', 'add', 'probe', '--provider', 'jsonfile', '--repo', 'acme/payments');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('--repo is not a connection option for provider "jsonfile"');
    expect(run.stderr).toContain('--file <file>');
  });

  it('documents every registered provider in the help, with its own flags', () => {
    const run = lpm('remote', '--help');
    expect(run.status).toBe(0);
    for (const name of registeredProviders()) {
      expect(run.stdout, `${name} appears in the add help`).toContain(name);
      for (const flag of connectionFlags(lookupProvider(name))) {
        expect(run.stdout, `${name} --${flag.name} appears in the add help`).toContain(
          `--${flag.name}`,
        );
      }
    }
  });
});

/**
 * The connect → push → pull workflow, end to end against the built CLI.
 *
 * `jsonfile` is the provider here because it needs no credential and no
 * network: its tracker is a JSON file this board owns, which makes the whole
 * loop — declare, file, import — assertable offline.
 */
describe('lpm remote connect / push <id> / pull <key>', () => {
  /** A board with a program → epic → feature → two stories, and no remote. */
  function plant(): void {
    // --prefix, because `init` otherwise derives the ids from the folder name
    // and these temp directories are named after the suite.
    expect(lpm('init', '--template', 'scrum', '--prefix', 'LP', '--no-git').status).toBe(0);
    expect(lpm('new', 'program', 'Payments').status).toBe(0);
    expect(lpm('new', 'epic', 'Checkout', '--parent', 'LP-1').status).toBe(0);
    expect(lpm('new', 'feature', 'Card form', '--parent', 'LP-2').status).toBe(0);
    expect(lpm('new', 'user_story', 'Card number', '--parent', 'LP-3').status).toBe(0);
    expect(lpm('new', 'user_story', 'Expiry', '--parent', 'LP-3').status).toBe(0);
  }

  function tracker(): { issues: Array<Record<string, unknown>> } {
    return JSON.parse(
      readFileSync(path.join(cwd, '.lpm/remotes/jsonfile/tracker.json'), 'utf8'),
    ) as { issues: Array<Record<string, unknown>> };
  }

  function links(): Record<string, Record<string, unknown>> {
    return (
      JSON.parse(readFileSync(path.join(cwd, '.lpm/remotes/jsonfile/links.json'), 'utf8')) as {
        links: Record<string, Record<string, unknown>>;
      }
    ).links;
  }

  it('connects a board to a tracker in one command, asking nothing it can work out', () => {
    // The whole point: `add` + `login` + `setup` was three commands in an order
    // nobody could be expected to know. A provider that needs no credential and
    // names its own file has nothing to ask about at all.
    plant();
    const run = lpm('remote', 'connect', 'jsonfile');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Connected');
    expect(run.stdout).toContain('reachable');
    expect(readFileSync(path.join(cwd, '.lpm/config.yml'), 'utf8')).toContain('jsonfile:');
  });

  it('refuses to connect over a remote of the same name without --force', () => {
    plant();
    expect(lpm('remote', 'connect', 'jsonfile').status).toBe(0);
    const again = lpm('remote', 'connect', 'jsonfile');
    expect(again.status).toBe(1);
    expect(again.stderr).toContain('already has a remote named');
  });

  it('pushes the one document named, and nothing else', () => {
    plant();
    expect(lpm('remote', 'connect', 'jsonfile').status).toBe(0);

    const run = lpm('remote', 'push', 'LP-4', '--yes');
    expect(run.status).toBe(0);
    expect(tracker().issues.map((issue) => issue.title)).toEqual(['Card number']);
    expect(Object.keys(links())).toEqual(['LP-4']);
  });

  it('says what a partial push cannot carry yet, rather than filing it silently', () => {
    plant();
    expect(lpm('remote', 'connect', 'jsonfile').status).toBe(0);
    const run = lpm('remote', 'push', 'LP-4', '--yes');
    expect(run.stdout).toContain('its parent is not there yet');
    expect(run.stdout).toContain('LP-3');
  });

  it('moves a twin under its parent when the parent is pushed later', () => {
    // Filing a plan a piece at a time is the point of pushing by id, and it is
    // only safe if the shape heals: the story filed at the tracker's root ends
    // up under the feature as soon as the feature is filed.
    plant();
    expect(lpm('remote', 'connect', 'jsonfile').status).toBe(0);
    expect(lpm('remote', 'push', 'LP-4', '--yes').status).toBe(0);
    expect(links()['LP-4']!.parentRemoteId).toBeNull();

    const run = lpm('remote', 'push', 'LP-3', '--yes');
    expect(run.status).toBe(0);
    // The feature's twin, and the story now pointing at it.
    const feature = tracker().issues.find((issue) => issue.title === 'Card form')!;
    expect(links()['LP-4']!.parentRemoteId).toBe(String(feature.number));
  });

  it('writes a dependency once both ends are filed', () => {
    // The other half of filing a plan piecemeal. An edge is planned from the
    // dependent, so a story filed while the thing it waits on was still local
    // would otherwise have an edge nobody ever writes: pushing the dependency
    // touches a different document.
    plant();
    expect(lpm('link', 'LP-4', '--depends-on', 'LP-5').status).toBe(0);
    expect(lpm('remote', 'connect', 'jsonfile').status).toBe(0);
    expect(lpm('remote', 'push', 'LP-4', '--yes').status).toBe(0);

    const before = tracker().issues.find((issue) => issue.title === 'Card number')!;
    expect(before.depends_on).toEqual([]);

    expect(lpm('remote', 'push', 'LP-5', '--yes').status).toBe(0);
    const after = tracker().issues.find((issue) => issue.title === 'Card number')!;
    const blocker = tracker().issues.find((issue) => issue.title === 'Expiry')!;
    expect(after.depends_on).toEqual([blocker.number]);
  });

  it('--recursive files everything nested inside the document named', () => {
    plant();
    expect(lpm('remote', 'connect', 'jsonfile').status).toBe(0);
    expect(lpm('remote', 'push', 'LP-3', '--recursive', '--yes').status).toBe(0);
    expect(Object.keys(links()).sort()).toEqual(['LP-3', 'LP-4', 'LP-5']);
  });

  it('--children files one level down, --recursive files all of it', () => {
    // The two answers that differ when a container has depth. Neither is a
    // guess: with no terminal to ask, only what was named is filed.
    plant();
    expect(lpm('remote', 'connect', 'jsonfile').status).toBe(0);
    expect(lpm('remote', 'push', 'LP-2', '--children', '--yes').status).toBe(0);
    // The epic and the feature under it — not the two stories under that.
    expect(Object.keys(links()).sort()).toEqual(['LP-2', 'LP-3']);

    expect(lpm('remote', 'push', 'LP-2', '--recursive', '--yes').status).toBe(0);
    expect(Object.keys(links()).sort()).toEqual(['LP-2', 'LP-3', 'LP-4', 'LP-5']);
  });

  it('--all pushes what changed and nothing else, and says so', () => {
    // The push is change-driven: a document whose fields still match the base
    // snapshot produces no operation at all. That is invisible in a summary of
    // what was written, which is how somebody comes to believe a bare push
    // re-files the whole board — so the report says what it looked at.
    plant();
    expect(lpm('remote', 'connect', 'jsonfile').status).toBe(0);
    expect(lpm('remote', 'push', '--all', '--yes').status).toBe(0);
    expect(Object.keys(links()).length).toBe(5);

    // Nothing changed since: no writes, and the report explains the silence.
    const idle = lpm('remote', 'push', '--all', '--yes');
    expect(idle.status).toBe(0);
    expect(idle.stdout).toContain('5 mirrored · 5 unchanged');
    expect(idle.stdout).toContain('updated       0');

    // One local edit: one write.
    expect(lpm('set', 'LP-4', '--title', 'Card number (edited)').status).toBe(0);
    const run = lpm('remote', 'push', '--all', '--yes');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('1 changed');
    expect(run.stdout).toContain('updated       1');
    expect(tracker().issues.filter((issue) => issue.title === 'Card number (edited)')).toHaveLength(1);
  });

  it('refuses --all together with a document id', () => {
    plant();
    expect(lpm('remote', 'connect', 'jsonfile').status).toBe(0);
    const run = lpm('remote', 'push', '--all', 'LP-4');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('contradict each other');
  });

  it('a plain pull refreshes every mirrored document, with no flag', () => {
    // "Pull everything that is in the ledger" is the default: the listing is
    // complete unless --changed asks for the incremental one, so an edit to a
    // document nobody touched locally comes back without anybody passing a
    // flag for it.
    plant();
    expect(lpm('remote', 'connect', 'jsonfile').status).toBe(0);
    expect(lpm('remote', 'push', '--all', '--yes').status).toBe(0);

    const file = path.join(cwd, '.lpm/remotes/jsonfile/tracker.json');
    const store = JSON.parse(readFileSync(file, 'utf8')) as {
      issues: Array<Record<string, unknown>>;
    };
    const twin = store.issues.find((issue) => issue.title === 'Expiry')!;
    twin.title = 'Expiry (edited upstream)';
    writeFileSync(file, JSON.stringify(store, null, 2));

    const run = lpm('remote', 'pull');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('pulled        1');
    expect(readFileSync(path.join(cwd, '.lpm/INDEX.md'), 'utf8')).toContain('Expiry (edited upstream)');
  });

  it('narrows a pull to a subtree when a document id names one', () => {
    plant();
    expect(lpm('remote', 'connect', 'jsonfile').status).toBe(0);
    expect(lpm('remote', 'push', 'LP-3', '--recursive', '--yes').status).toBe(0);

    const run = lpm('remote', 'pull', 'LP-3');
    expect(run.status).toBe(0);
    // Nothing was closed, deleted or unlinked for sitting outside the subtree.
    expect(Object.keys(links()).sort()).toEqual(['LP-3', 'LP-4', 'LP-5']);
  });

  it('pulls one remote issue onto the board by its id', () => {
    plant();
    expect(lpm('remote', 'connect', 'jsonfile').status).toBe(0);
    expect(lpm('remote', 'push', 'LP-3', '--recursive', '--yes').status).toBe(0);

    // Something that exists only on the tracker, as if somebody filed it there.
    const file = path.join(cwd, '.lpm/remotes/jsonfile/tracker.json');
    const store = JSON.parse(readFileSync(file, 'utf8')) as {
      issues: Array<Record<string, unknown>>;
      next_number: number;
    };
    store.issues.push({
      number: store.next_number,
      title: 'Reported by support',
      body: 'Amex is rejected',
      status: 'Backlog',
      type: 'user_story',
      labels: [],
      assignee: null,
      depends_on: [],
      comments: [],
      created_at: '2026-09-12T00:00:00.000Z',
      updated_at: '2026-09-12T00:00:00.000Z',
    });
    const pulled = String(store.next_number);
    store.next_number += 1;
    writeFileSync(file, JSON.stringify(store, null, 2));

    const run = lpm('remote', 'pull', pulled, '--parent', 'LP-3');
    expect(run.status).toBe(0);

    // The document exists on the board, under the parent it was given.
    expect(readFileSync(path.join(cwd, '.lpm/INDEX.md'), 'utf8')).toContain('Reported by support');
    // The twins that were not asked about are untouched — a targeted pull
    // reconciles no existence.
    expect(Object.keys(links()).sort()).toEqual(['LP-3', 'LP-4', 'LP-5', 'LP-6']);
  });

  it('names --parent when a pulled issue has nowhere to go', () => {
    plant();
    expect(lpm('remote', 'connect', 'jsonfile').status).toBe(0);
    expect(lpm('remote', 'push', 'LP-4', '--yes').status).toBe(0);

    const file = path.join(cwd, '.lpm/remotes/jsonfile/tracker.json');
    const store = JSON.parse(readFileSync(file, 'utf8')) as {
      issues: Array<Record<string, unknown>>;
      next_number: number;
    };
    store.issues.push({
      number: store.next_number,
      title: 'Orphan',
      body: '',
      status: 'Backlog',
      type: 'user_story',
      labels: [],
      assignee: null,
      depends_on: [],
      comments: [],
      created_at: '2026-09-12T00:00:00.000Z',
      updated_at: '2026-09-12T00:00:00.000Z',
    });
    const orphan = String(store.next_number);
    store.next_number += 1;
    writeFileSync(file, JSON.stringify(store, null, 2));

    const run = lpm('remote', 'pull', orphan);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('--parent');
  });

  it('reads the remote name from the front of the command', () => {
    plant();
    expect(lpm('remote', 'connect', 'jsonfile').status).toBe(0);
    const run = lpm('remote', 'jsonfile', 'push', 'LP-4', '--yes');
    expect(run.status).toBe(0);
    expect(Object.keys(links())).toEqual(['LP-4']);
  });

  it('reports where each document is filed, and what is not filed at all', () => {
    plant();
    expect(lpm('remote', 'connect', 'jsonfile').status).toBe(0);
    expect(lpm('remote', 'push', 'LP-4', '--yes').status).toBe(0);

    const run = lpm('remote', 'ledger', '--unlinked');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('LP-4');
    expect(run.stdout).toContain('jsonfile');
    expect(run.stdout).toContain('1 mirrored, 4 not yet');
    expect(run.stdout).toContain('LP-1');
  });

  it('names no remote when there is none, and says how to get one', () => {
    plant();
    const run = lpm('remote', 'ledger');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('lpm remote connect');
  });
});
