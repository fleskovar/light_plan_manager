import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { recordingConnector, sessionFileName } from '../src/remote/fixtures.js';
import { REDACTED, redactHeaders, redactText, redactUrl } from '../src/remote/redact.js';
import { restConnector } from '../src/remote/transport/index.js';
import type { MemoryConnector } from './support/memory-tracker.js';
import { memoryConnector } from './support/memory-tracker.js';

/**
 * LP-354 — prove no secret ever reaches output or a committed file.
 *
 * This is the *integration* half of the redaction story: `redact.test.ts`
 * proves the pure functions and the output sink against the library; this file
 * proves them against the **built CLI**, which has its own error renderer and
 * is the path a user pastes into a bug report. A sentinel token is planted in
 * the credential environment, and the sync is driven to succeed, to fail (with
 * the sentinel in the error), and to dry-run against the in-memory tracker
 * served over HTTP — the same fake the provider conformance suite drives, so
 * nothing here touches the network.
 *
 * Every run is then scanned: stdout, stderr, the audit log and every file under
 * `.lpm` must not contain the sentinel. The library-side ACs follow: a token in
 * a URL or a header is redacted, `lpm check` reports a literal credential, and
 * a recorded trace scrubs the sentinel out.
 */

const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));

/** A token whose every occurrence in any sink is a leak. */
const SENTINEL = 'ghp_LP354_sentinel_token_42';

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

/**
 * Serve an in-memory tracker over HTTP so the CLI's own `fetch` reaches it.
 * The CLI is spawned *asynchronously* — a `spawnSync` would block this process'
 * event loop and the server could never answer, deadlocking the run.
 */
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

/** The remote block for a blank board, with the tracker's URL baked in. */
function remotesBlock(baseUrl: string): string {
  return `
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    connection:
      repo: acme/payments
      base_url: ${baseUrl}
    mapping:
      types:
        task: { labels: [task] }
      statuses:
        todo: Todo
        doing: Doing
        done: { remote: Done, closed: true }
`;
}

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

/** Spawn the built CLI in `cwd`, with the sentinel as the GitHub credential. */
function lpm(cwd: string, args: string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: {
        ...process.env,
        NO_COLOR: '1',
        LPM_BOARD_PATH: '',
        GITHUB_TOKEN: SENTINEL,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ status: code ?? 0, stdout, stderr }));
  });
}

/** A blank board plus the remote, and one task. */
async function setupBoard(baseUrl: string): Promise<string> {
  const cwd = mkdtempSync(path.join(tmpdir(), 'lpm-leak-'));
  dirs.push(cwd);
  expect((await lpm(cwd, ['init', '--no-git', '-t', 'blank', '--prefix', 'LP'])).status).toBe(0);
  writeFileSync(
    path.join(cwd, '.lpm/config.yml'),
    `${readFileSync(path.join(cwd, '.lpm/config.yml'), 'utf8')}${remotesBlock(baseUrl)}`,
  );
  expect((await lpm(cwd, ['new', 'task', '-t', 'Secret probe'])).status).toBe(0);
  return cwd;
}

/** Every file under a directory, recursively. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out;
}

/** The first file under `.lpm` whose text contains `needle`, or null. */
function lpmFileContaining(cwd: string, needle: string): string | null {
  const lpmDir = path.join(cwd, '.lpm');
  if (!existsSync(lpmDir)) return null;
  for (const file of filesUnder(lpmDir)) {
    if (readFileSync(file, 'utf8').includes(needle)) return file;
  }
  return null;
}

/** Assert the sentinel appears in no sink — stdout, stderr, or any `.lpm` file. */
function expectNoLeak(run: Run, cwd: string): void {
  expect(run.stdout, 'stdout carried the sentinel').not.toContain(SENTINEL);
  expect(run.stderr, 'stderr carried the sentinel').not.toContain(SENTINEL);
  expect(lpmFileContaining(cwd, SENTINEL), 'a file under .lpm carried the sentinel').toBeNull();
}

// ---------------------------------------------------------------------------
// AC #1 — the built CLI never leaks the sentinel, whatever the sync does
// ---------------------------------------------------------------------------

describe('a sync never leaks the sentinel (built CLI)', () => {
  it('leaks nothing on a successful push', async () => {
    const baseUrl = await serveTracker(memoryConnector({ repo: 'acme/payments' }));
    const cwd = await setupBoard(baseUrl);

    const run = await lpm(cwd, ['remote', 'push', '--yes']);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('created');
    // The push really landed: one remote issue, one audit line, one link.
    const audit = readFileSync(path.join(cwd, '.lpm/remotes/upstream/log.jsonl'), 'utf8');
    expect(audit).toContain('"created":1');

    expectNoLeak(run, cwd);
  });

  it('leaks nothing when the sync fails with the sentinel in the error', async () => {
    const tracker = memoryConnector({ repo: 'acme/payments' });
    // The pull's list request answers 500 with a body that echoes the sentinel
    // back inside a URL — the shape a real tracker's "bad token" page takes.
    tracker.failNext(
      { status: 500, message: `https://api.example.com/repos?access_token=${SENTINEL}` },
      (request) =>
        request.method === 'GET' &&
        request.path === '/repos/acme/payments/issues' &&
        request.query?.per_page === '100',
    );
    const baseUrl = await serveTracker(tracker);
    const cwd = await setupBoard(baseUrl);

    const run = await lpm(cwd, ['remote', 'pull']);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('failed');
    // The redaction happened — the marker stands where the sentinel was.
    expect(run.stdout).toContain(REDACTED);

    expectNoLeak(run, cwd);
  });

  it('leaks nothing on a dry run', async () => {
    const baseUrl = await serveTracker(memoryConnector({ repo: 'acme/payments' }));
    const cwd = await setupBoard(baseUrl);

    const run = await lpm(cwd, ['remote', 'push', '--dry-run']);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('dry run');
    expect(run.stdout).toContain('create');

    // A dry run wrote nothing: no audit log, no link store.
    expect(existsSync(path.join(cwd, '.lpm/remotes/upstream/log.jsonl'))).toBe(false);
    expect(existsSync(path.join(cwd, '.lpm/remotes/upstream/links.json'))).toBe(false);

    expectNoLeak(run, cwd);
  });
});

// ---------------------------------------------------------------------------
// AC #2 — a token in a URL or a header is redacted there too
// ---------------------------------------------------------------------------

describe('a token in a URL or a header is redacted', () => {
  it('redacts a raw and percent-encoded secret in a URL', () => {
    expect(redactUrl(`https://api.example.com/repos?token=${SENTINEL}`, [SENTINEL])).toBe(
      `https://api.example.com/repos?token=${REDACTED}`,
    );
    const encoded = encodeURIComponent(SENTINEL);
    expect(redactText(`a=${encoded}`, [SENTINEL])).toBe(`a=${REDACTED}`);
  });

  it('redacts a secret-bearing header value whole, and never the header name', () => {
    expect(
      redactHeaders(
        { Accept: 'application/json', Authorization: `Bearer ${SENTINEL}` },
        [SENTINEL],
      ),
    ).toEqual({ Accept: 'application/json', Authorization: REDACTED });
  });
});

// ---------------------------------------------------------------------------
// AC #3 — a literal credential in config.yml is reported by `lpm check`
// ---------------------------------------------------------------------------

describe('lpm check reports a literal credential (built CLI)', () => {
  it('reports the error and never echoes the token value', async () => {
    const literal = 'ghp_committed_secret_abc';
    const cwd = mkdtempSync(path.join(tmpdir(), 'lpm-leak-check-'));
    dirs.push(cwd);
    expect((await lpm(cwd, ['init', '--no-git', '-t', 'blank', '--prefix', 'LP'])).status).toBe(0);
    writeFileSync(
      path.join(cwd, '.lpm/config.yml'),
      `${readFileSync(path.join(cwd, '.lpm/config.yml'), 'utf8')}
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    connection:
      repo: acme/payments
      token: ${literal}
    mapping:
      types:
        task: { labels: [task] }
      statuses:
        todo: Todo
        doing: Doing
        done: { remote: Done, closed: true }
`,
    );

    const run = await lpm(cwd, ['check']);
    expect(run.status).toBe(1);
    expect(`${run.stdout}${run.stderr}`).toContain('a credential must not be written literally');
    // The check names the *where*, never the secret itself.
    expect(run.stdout).not.toContain(literal);
    expect(run.stderr).not.toContain(literal);
  });
});

// ---------------------------------------------------------------------------
// AC #1 (traced) — a recorded trace never carries the sentinel
// ---------------------------------------------------------------------------

describe('a recorded trace never carries the sentinel', () => {
  it('scrubs a sentinel out of a recorded request header and response body', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lpm-leak-trace-'));
    try {
      const inner = restConnector({
        baseUrl: 'https://api.example.com',
        fetch: async () =>
          new Response(JSON.stringify({ url: `https://api.example.com?token=${SENTINEL}` }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        defaultHeaders: { Authorization: `Bearer ${SENTINEL}` },
      });
      const recording = recordingConnector(inner, {
        directory: dir,
        provider: 'github',
        enabled: true,
        secrets: [SENTINEL],
      });

      await recording.request({ method: 'GET', path: '/repos/acme/payments', purpose: 'fetch repo' });
      await recording.close();

      const text = readFileSync(sessionFileName(dir, 'github'), 'utf8');
      expect(text).not.toContain(SENTINEL);
      expect(text).toContain(REDACTED);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC #4 — committed fixtures carry no credential-shaped strings
// ---------------------------------------------------------------------------

describe('committed fixtures carry no credential-shaped strings', () => {
  const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/remote/', import.meta.url));

  const TOKEN_PATTERNS = [
    /\bgh[pousr]_[A-Za-z0-9]{10,}\b/, // GitHub fine-grained tokens
    /\bgithub_pat_[A-Za-z0-9_]{10,}\b/, // GitHub PATs
    /\bATATT[A-Za-z0-9]{10,}\b/, // Atlassian API tokens
    /\blin_api_[A-Za-z0-9]{10,}\b/, // Linear personal API keys
    /\bBearer\s+[A-Za-z0-9._~+/-]{6,}\b/i, // a literal bearer credential
  ];

  function committedFixtureFiles(dir: string = FIXTURES_DIR): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...committedFixtureFiles(full));
      else if (entry.name !== 'README.md') out.push(full);
    }
    return out;
  }

  it('no committed fixture file carries a credential-shaped string', () => {
    const files = committedFixtureFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of TOKEN_PATTERNS) {
        expect(text, `token pattern ${pattern} in ${file}`).not.toMatch(pattern);
      }
    }
  });
});
