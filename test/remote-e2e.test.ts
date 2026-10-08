import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { MemoryConnector } from './support/memory-tracker.js';
import { memoryConnector } from './support/memory-tracker.js';

/**
 * LP-355 — `lpm remote` end to end against the fake connector.
 *
 * The command surface as a user meets it, not as a library: every run spawns
 * the **built** `dist/cli/index.js` (as `test/cli.test.ts` does), and the
 * remote is the in-memory tracker (`test/support/memory-tracker.ts`, LP-299)
 * served over HTTP — the same fake the conformance suite drives, so nothing
 * here touches the network. A spawn is *async* (`spawn`, never `spawnSync`):
 * a sync spawn would block this process' event loop and the fake server could
 * never answer, deadlocking the run.
 *
 * The acceptance criteria:
 *   AC #1 — add, push, status, pull, resolve and log run in
 *           sequence against the fake-backed remote.
 *   AC #2 — `--dry-run` on each write command writes nothing, and its rendering
 *           is the plan the real run then applies.
 *   AC #3 — drift exits 1, conflict exits 2.
 *   AC #4 — without `--yes`, a non-interactive run over the threshold stops
 *           rather than hanging on a prompt.
 *   AC #5 — the file sits under `test/`, so `vitest.config.ts`'s
 *           `test/**` include pattern picks it up.
 */

const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));

/** The dummy GitHub credential the connector resolves; the fake never checks it. */
const TOKEN = 'ghp_LP355_e2e_token';

const dirs: string[] = [];
const servers: Server[] = [];

async function closeServers(): Promise<void> {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

afterEach(async () => {
  await closeServers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(async () => {
  await closeServers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The fake remote, served over HTTP for the built CLI
// ---------------------------------------------------------------------------

/** Serve an in-memory tracker over HTTP so the CLI's own `fetch` reaches it. */
async function serveTracker(tracker: MemoryConnector): Promise<string> {
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const port = (server.address() as AddressInfo).port;
      const response = await tracker.fetch(`http://127.0.0.1:${port}${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: rawBody === '' ? undefined : rawBody,
      });
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      res.end(await response.text());
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: String(error) }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

// ---------------------------------------------------------------------------
// Spawning the built CLI
// ---------------------------------------------------------------------------

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the built CLI in `cwd` and wait for it to exit. A timeout is the
 * "did not hang" assertion for AC #4: a run that prompts with nobody to answer
 * would never exit, so the timer turns that into a loud failure instead of a
 * silently hung suite.
 */
function lpm(cwd: string, args: string[], timeoutMs = 30_000): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1', LPM_BOARD_PATH: '', GITHUB_TOKEN: TOKEN },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`lpm ${args.join(' ')} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code ?? 0, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// Board setup
// ---------------------------------------------------------------------------

/**
 * A blank board with one GitHub remote pointed at the tracker. The remote is
 * declared *and mapped* by `lpm remote add` (AC #1): the mapping is drafted
 * from the board's own types and statuses, and GitHub needs no live remote to
 * draft one cleanly (no native issue types, a binary open/closed status), so
 * nothing here has to be filled in by hand before the first sync. That is the
 * flow a person actually gets, so it is the flow this test drives.
 */
async function newBoard(
  baseUrl: string,
  opts: { writeThreshold?: number } = {},
): Promise<string> {
  const cwd = mkdtempSync(path.join(tmpdir(), 'lpm-e2e-'));
  dirs.push(cwd);

  expect((await lpm(cwd, ['init', '--no-git', '-t', 'blank', '--prefix', 'LP'])).status).toBe(0);
  expect(
    (
      await lpm(cwd, [
        'remote',
        'add',
        'upstream',
        '--provider',
        'github',
        '--repo',
        'acme/payments',
        '--base_url',
        baseUrl,
      ])
    ).status,
  ).toBe(0);

  if (opts.writeThreshold !== undefined) {
    const configPath = path.join(cwd, '.lpm/config.yml');
    // Inserted into the declared entry, not appended to the file: a built-in
    // template ships a commented-out `remotes:` example after the real block,
    // so anything appended at EOF would land outside `upstream:` entirely.
    // The 4-space indent anchors this to the real entry — every line of the
    // commented example starts with `#`.
    const text = readFileSync(configPath, 'utf8').replace(
      '\n    provider: github',
      `\n    provider: github\n    write_threshold: ${opts.writeThreshold}`,
    );
    writeFileSync(configPath, text);
  }
  return cwd;
}

/** Create tasks through the CLI; returns their ids in creation order. */
async function newTasks(cwd: string, titles: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const title of titles) {
    const run = await lpm(cwd, ['new', 'task', '-t', title]);
    expect(run.status, `lpm new task -t "${title}"`).toBe(0);
    const match = /Created (LP-\d+)/.exec(run.stdout);
    expect(match, 'lpm new prints the created id').toBeTruthy();
    ids.push(match![1]!);
  }
  return ids;
}

/** The raw markdown of one issue, as a reader of the file tree would see it. */
function issueFile(cwd: string, id: string): string {
  return readFileSync(path.join(cwd, '.lpm/board', id, '_issue.md'), 'utf8');
}

/** The link store's `links` map: local id → its twin's remote id. */
function linksOf(cwd: string): Record<string, { remoteId: string }> {
  return JSON.parse(
    readFileSync(path.join(cwd, '.lpm/remotes/upstream/links.json'), 'utf8'),
  ).links;
}

// ---------------------------------------------------------------------------
// AC #1 + AC #3 — the command sequence, drift and conflict
// ---------------------------------------------------------------------------

describe('lpm remote end to end against the fake connector (LP-355)', () => {
  it('drives add, push, status, pull, resolve and log in sequence (AC #1), with drift and conflict exit codes (AC #3)', async () => {
    const tracker = memoryConnector({ repo: 'acme/payments' });
    const baseUrl = await serveTracker(tracker);
    const cwd = await newBoard(baseUrl);

    // add — the remote is declared, connection keys written, mapping drafted
    // from the board's own vocabulary with nothing left to fill in.
    const config = readFileSync(path.join(cwd, '.lpm/config.yml'), 'utf8');
    expect(config).toContain('provider: github');
    expect(config).toContain('repo: acme/payments');
    expect(config).toContain(`base_url: ${baseUrl}`);
    // Nothing was left for a human: the drafted mapping carries no unresolved
    // marker. Comment lines are stripped first — a built-in template ships a
    // commented-out example whose Jira and Linear blocks do carry `TODO:`.
    const declared = config
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(declared).not.toContain('TODO:');

    const taskIds = await newTasks(cwd, ['First task', 'Second task']);
    const first = taskIds[0]!;
    const second = taskIds[1]!;

    // The repository defines none of the mapped labels yet, and a GitHub issue
    // can only carry labels that exist. That used to be a command of its own
    // (`provision`) which the first push told you to go and run; the push now
    // creates them itself and says so.
    expect(tracker.labels()).toEqual([]);

    // push — creates the labels it needs, then files both tasks.
    const push = await lpm(cwd, ['remote', 'push', '--yes']);
    expect(push.status).toBe(0);
    expect(push.stdout).toContain('created');
    expect(push.stdout).toContain('label task');
    expect(tracker.labels()).toEqual(['Doing', 'Done', 'To Do', 'task']);
    expect(tracker.issues().size).toBe(2);

    // A second push creates nothing: the labels are there, so the report is
    // silent about them.
    const pushAgain = await lpm(cwd, ['remote', 'push', '--yes']);
    expect(pushAgain.status).toBe(0);
    expect(pushAgain.stdout).not.toContain('label task');

    // status — in sync, exit 0.
    const status0 = await lpm(cwd, ['remote', 'status']);
    expect(status0.status).toBe(0);
    expect(status0.stdout).toContain('In sync');

    // log — the push is recorded.
    const log1 = await lpm(cwd, ['remote', 'log']);
    expect(log1.status).toBe(0);
    expect(log1.stdout).toContain('push');

    // drift (AC #3) — a local-only rename is ahead, exit 1. A title is a field
    // every remote can take, so it lands in the actionable half of `ahead`, which
    // the report labels `to push`.
    expect((await lpm(cwd, ['set', first, '--title', 'First task (renamed)'])).status).toBe(0);
    const drifted = await lpm(cwd, ['remote', 'status']);
    expect(drifted.status).toBe(1);
    expect(drifted.stdout).toContain('to push');
    expect(drifted.stdout).toContain(first);

    // push the rename up so the two sides agree again.
    expect((await lpm(cwd, ['remote', 'push', '--yes'])).status).toBe(0);

    // pull — a remote-only rename is "behind", and `pull` brings it onto the board.
    const remoteId = linksOf(cwd)[first]!.remoteId;
    tracker.mutateIssue(remoteId, { title: 'First task (remote)' });
    const behind = await lpm(cwd, ['remote', 'status']);
    expect(behind.status).toBe(1);
    // The report labels this `to pull`: what a reader needs is the *action*, and
    // "behind" named the board's position rather than what to do about it.
    expect(behind.stdout).toContain('to pull');

    const pull = await lpm(cwd, ['remote', 'pull']);
    expect(pull.status).toBe(0);
    expect(pull.stdout).toContain('pulled');
    expect(issueFile(cwd, first)).toContain('title: First task (remote)');
    expect((await lpm(cwd, ['remote', 'status'])).status).toBe(0);

    // conflict (AC #3) — both sides edit the title, exit 2.
    expect((await lpm(cwd, ['set', first, '--title', 'First task (local conflict)'])).status).toBe(0);
    tracker.mutateIssue(remoteId, { title: 'First task (remote conflict)' });
    const conflicted = await lpm(cwd, ['remote', 'status']);
    expect(conflicted.status).toBe(2);
    expect(conflicted.stdout).toContain('conflict');

    // resolve — records the decision; the next status reads the document as
    // "ahead" (the board wins) rather than conflicted.
    const resolved = await lpm(cwd, ['remote', 'resolve', first, '--local']);
    expect(resolved.status).toBe(0);
    expect(resolved.stdout).toContain('Resolved');

    const afterResolve = await lpm(cwd, ['remote', 'status']);
    expect(afterResolve.status).toBe(1); // ahead, not the conflict exit 2
    expect(afterResolve.stdout).toContain('to push');
    expect(afterResolve.stdout).not.toContain('conflict');

    // log — the record now spans the push and the pull.
    const log2 = await lpm(cwd, ['remote', 'log']);
    expect(log2.status).toBe(0);
    expect(log2.stdout).toContain('push');
    expect(log2.stdout).toContain('pull');

    // Sanity: both documents are still on the board and the fake still holds two.
    expect(second).toBeTruthy();
    expect(tracker.issues().size).toBe(2);
  });

  // -------------------------------------------------------------------------
  // AC #2 — `--dry-run` on each write command
  // -------------------------------------------------------------------------

  it('--dry-run writes nothing and renders the plan the real run then applies (AC #2)', async () => {
    const tracker = memoryConnector({ repo: 'acme/payments' });
    const baseUrl = await serveTracker(tracker);
    const cwd = await newBoard(baseUrl);
    const taskIds = await newTasks(cwd, ['First task', 'Second task']);
    const first = taskIds[0]!;

    // push --dry-run: two creates and the labels the push would have to make
    // first — nothing filed, nothing created, nothing recorded.
    const dryPush = await lpm(cwd, ['remote', 'push', '--dry-run']);
    expect(dryPush.status).toBe(0);
    expect(dryPush.stdout).toContain('Sync plan — 2 operations');
    expect(dryPush.stdout).toContain('create');
    expect(dryPush.stdout).toContain('to create  label task');
    expect(dryPush.stdout).toContain('Dry run — nothing was written');
    expect(tracker.issues().size).toBe(0);
    expect(tracker.labels()).toEqual([]);
    expect(existsSync(path.join(cwd, '.lpm/remotes/upstream/log.jsonl'))).toBe(false);
    expect(existsSync(path.join(cwd, '.lpm/remotes/upstream/links.json'))).toBe(false);

    // The real push then files exactly the two the dry-run rendered, and
    // creates the four labels it said it would.
    const push = await lpm(cwd, ['remote', 'push', '--yes']);
    expect(push.status).toBe(0);
    expect(push.stdout).toContain('created');
    expect(tracker.issues().size).toBe(2);
    expect(tracker.labels().length).toBe(4);

    // pull --dry-run of a remote-only rename: one update, the board untouched.
    const remoteId = linksOf(cwd)[first]!.remoteId;
    tracker.mutateIssue(remoteId, { title: 'First task (remote)' });
    const dryPull = await lpm(cwd, ['remote', 'pull', '--dry-run']);
    expect(dryPull.status).toBe(0);
    expect(dryPull.stdout).toContain('update');
    expect(dryPull.stdout).toContain('Dry run — nothing was written');
    expect(issueFile(cwd, first)).toContain('title: First task');

    // The real pull applies the update the dry-run rendered.
    const pull = await lpm(cwd, ['remote', 'pull']);
    expect(pull.status).toBe(0);
    expect(pull.stdout).toContain('pulled');
    expect(issueFile(cwd, first)).toContain('title: First task (remote)');
  });

  // -------------------------------------------------------------------------
  // AC #4 — the threshold stops a non-interactive run instead of prompting
  // -------------------------------------------------------------------------

  it('without --yes, a non-interactive run over the threshold stops rather than prompting (AC #4)', async () => {
    const tracker = memoryConnector({ repo: 'acme/payments' });
    const baseUrl = await serveTracker(tracker);
    // A threshold of 1 makes two creates an oversized plan.
    const cwd = await newBoard(baseUrl, { writeThreshold: 1 });
    await newTasks(cwd, ['First task', 'Second task']);

    // No `--yes`, and the spawn has no terminal — the run must refuse, not hang.
    const refused = await lpm(cwd, ['remote', 'push']);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toContain('Push refused');
    expect(refused.stdout).toContain('threshold');
    // Nothing reached the remote.
    expect(tracker.issues().size).toBe(0);
    // The refusal is recorded in the sync log — the trail, not a write upstream.
    expect(readFileSync(path.join(cwd, '.lpm/remotes/upstream/log.jsonl'), 'utf8')).toContain(
      'refused: threshold',
    );

    // `--yes` is the way past the gate.
    const push = await lpm(cwd, ['remote', 'push', '--yes']);
    expect(push.status).toBe(0);
    expect(push.stdout).toContain('created');
    expect(tracker.issues().size).toBe(2);
  });
});
