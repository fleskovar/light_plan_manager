/**
 * LP-301 — record real API traffic to fixtures, scrubbed on the way in, and
 * replay it offline.
 *
 * The recording decorator wraps a transport `Connector` and captures every
 * request/response exchange (success *and* failure) into a session file under
 * `<directory>/<provider>/recording.json`. The replay connector serves that
 * file, failing loudly on an unmatched request rather than falling through to
 * the network. Everything here runs offline: a scripted `fetch` stands in for
 * the network, and the in-memory tracker (`test/support/memory-tracker.ts`)
 * stands in for a paginated collection.
 *
 * The last suite is the story's committed-fixtures gate: every fixture checked
 * in under `test/fixtures/remote/` must already be clean — no email, no token,
 * and any `recording.json` must be idempotent under a re-scrub.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  recordingConnector,
  readSession,
  replayConnector,
  scrubHeaders,
  scrubSession,
  scrubText,
  scrubValue,
  sessionFileName,
  UnmatchedReplayRequestError,
} from '../src/remote/fixtures.js';
import { REDACTED, redactor } from '../src/remote/redact.js';
import type { Connector } from '../src/remote/transport/index.js';
import { RemoteError, graphqlConnector, restConnector } from '../src/remote/transport/index.js';
import { memoryConnector } from './support/memory-tracker.js';

const SENTINEL = 'ghp_SENTINEL12345';
const EMAIL = 'octocat@example.com';

afterEach(() => {
  redactor.clear();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** A `fetch` that dispatches on URL segments; a fresh Response per call, so bodies are never shared. */
function fetchRoutes(routes: Record<string, () => Response>): typeof fetch {
  return async (input) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    for (const [segment, make] of Object.entries(routes)) {
      if (url.includes(segment)) return make();
    }
    return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
  };
}

function tempRecordingDir(): string {
  return mkdtempSync(join(tmpdir(), 'lpm-record-'));
}

// ---------------------------------------------------------------------------
// Scrubbing
// ---------------------------------------------------------------------------

describe('scrubText', () => {
  it('redacts secrets, then emails, then account ids, with the shared marker', () => {
    expect(
      scrubText(`token=${SENTINEL} mail=${EMAIL} owner=acme`, {
        secrets: [SENTINEL],
        accounts: ['acme'],
      }),
    ).toBe(`token=${REDACTED} mail=${REDACTED} owner=${REDACTED}`);
  });

  it('redacts the percent-encoded form of a secret in a URL', () => {
    const secret = 'ab/c d=';
    const encoded = encodeURIComponent(secret);
    expect(encoded).not.toBe(secret);
    expect(scrubText(`https://api.example.com?t=${encoded}`, { secrets: [secret] })).toBe(
      `https://api.example.com?t=${REDACTED}`,
    );
  });

  it('leaves ordinary text alone', () => {
    expect(scrubText('GET /repos/acme/payments/issues', { secrets: [], accounts: [] })).toBe(
      'GET /repos/acme/payments/issues',
    );
  });
});

describe('scrubValue', () => {
  it('recurses through arrays and objects', () => {
    expect(
      scrubValue({ list: [SENTINEL, { mail: EMAIL }], n: 7 }, { secrets: [SENTINEL] }),
    ).toEqual({ list: [REDACTED, { mail: REDACTED }], n: 7 });
  });
});

describe('scrubHeaders', () => {
  it('redacts secret-bearing and secret-named headers whole, leaves the rest', () => {
    expect(
      scrubHeaders(
        {
          Accept: 'application/json',
          Authorization: `Bearer ${SENTINEL}`,
          'X-Api-Key': 'anything-at-all',
          'X-RateLimit-Remaining': '4999',
        },
        { secrets: [SENTINEL] },
      ),
    ).toEqual({
      Accept: 'application/json',
      Authorization: REDACTED,
      'X-Api-Key': REDACTED,
      'X-RateLimit-Remaining': '4999',
    });
  });

  it('returns undefined for an absent header record', () => {
    expect(scrubHeaders(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

describe('recordingConnector', () => {
  it('is a no-op passthrough when LPM_RECORD is unset', () => {
    const inner = restConnector({ baseUrl: 'https://api.example.com', fetch: fetchRoutes({}) });
    const wrapped = recordingConnector(inner, { directory: '/tmp/nope', provider: 'github' });
    expect(wrapped).toBe(inner);
  });

  it('is a no-op passthrough when enabled is false', () => {
    const inner = restConnector({ baseUrl: 'https://api.example.com', fetch: fetchRoutes({}) });
    const wrapped = recordingConnector(inner, {
      directory: '/tmp/nope',
      provider: 'github',
      enabled: false,
    });
    expect(wrapped).toBe(inner);
  });

  it('records when LPM_RECORD=1, scrubbing tokens, emails and account ids', async () => {
    vi.stubEnv('LPM_RECORD', '1');
    const dir = tempRecordingDir();
    try {
      const inner = restConnector({
        baseUrl: 'https://api.example.com',
        fetch: fetchRoutes({
          '/issues/1': () =>
            jsonResponse({
              login: 'octocat',
              email: EMAIL,
              html_url: `https://github.com/acme/payments/issues/1?token=${SENTINEL}`,
            }),
        }),
        defaultHeaders: { Authorization: `Bearer ${SENTINEL}` },
      });
      const recording = recordingConnector(inner, {
        directory: dir,
        provider: 'github',
        secrets: [SENTINEL],
        accounts: ['acme', 'octocat'],
        now: () => new Date('2026-08-16T00:00:00Z'),
      });

      const response = await recording.request({
        method: 'GET',
        path: '/repos/acme/payments/issues/1',
        purpose: 'fetch issue',
      });
      expect(response.body).toBeTruthy();
      await recording.close();

      const file = sessionFileName(dir, 'github');
      expect(existsSync(file)).toBe(true);

      const text = readFileSync(file, 'utf8');
      // Nothing sensitive survives the write.
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain(EMAIL);
      expect(text).not.toContain('acme');
      expect(text).not.toContain('octocat');
      // The scrub left its marker, and the capture date is recorded.
      expect(text).toContain(REDACTED);
      expect(text).toContain('2026-08-16');

      // The committed-shape assertion: a re-scrub changes nothing.
      const session = readSession(file);
      expect(scrubSession(session, { secrets: [SENTINEL], accounts: ['acme', 'octocat'] })).toEqual(
        session,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

describe('replayConnector', () => {
  it('replays recorded responses and recorded failures, in order', async () => {
    const dir = tempRecordingDir();
    try {
      const inner = restConnector({
        baseUrl: 'https://api.example.com',
        fetch: fetchRoutes({
          '/ok': () => jsonResponse({ ok: true, number: 1 }),
          '/boom': () => new Response(JSON.stringify({ message: 'server exploded' }), { status: 500 }),
        }),
      });
      const recording = recordingConnector(inner, {
        directory: dir,
        provider: 'github',
        enabled: true,
      });

      await recording.request({ method: 'GET', path: '/ok' });
      await expect(recording.request({ method: 'GET', path: '/boom' })).rejects.toBeInstanceOf(
        RemoteError,
      );
      await recording.close();

      const replay = replayConnector({ file: sessionFileName(dir, 'github') });
      expect(replay.kind).toBe('rest');

      const ok = await replay.request<{ ok: boolean; number: number }>({ method: 'GET', path: '/ok' });
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ ok: true, number: 1 });

      await expect(replay.request({ method: 'GET', path: '/boom' })).rejects.toMatchObject({
        name: 'RemoteError',
        status: 500,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails loudly on an unmatched request instead of falling through to the network', async () => {
    const dir = tempRecordingDir();
    try {
      const inner = restConnector({
        baseUrl: 'https://api.example.com',
        fetch: fetchRoutes({ '/ok': () => jsonResponse({ ok: true }) }),
      });
      const recording = recordingConnector(inner, {
        directory: dir,
        provider: 'github',
        enabled: true,
      });
      await recording.request({ method: 'GET', path: '/ok' });
      await recording.close();

      const replay = replayConnector({ file: sessionFileName(dir, 'github') });
      await expect(
        replay.request({ method: 'GET', path: '/not-recorded' }),
      ).rejects.toBeInstanceOf(UnmatchedReplayRequestError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replays a paginated walk page for page', async () => {
    const dir = tempRecordingDir();
    try {
      const tracker: Connector = memoryConnector({
        repo: 'acme/payments',
        perPage: 1,
        seed: [{ title: 'one' }, { title: 'two' }, { title: 'three' }],
      });
      const recording = recordingConnector(tracker, {
        directory: dir,
        provider: 'github',
        enabled: true,
      });

      const pages: unknown[] = [];
      for await (const page of recording.paginate({
        method: 'GET',
        path: '/repos/acme/payments/issues',
        query: { state: 'open' },
        pagination: { kind: 'link' },
      })) {
        pages.push(page);
      }
      expect(pages).toHaveLength(3);
      await recording.close();

      const replay = replayConnector({ file: sessionFileName(dir, 'github') });
      const replayed: unknown[] = [];
      for await (const page of replay.paginate({
        method: 'GET',
        path: '/repos/acme/payments/issues',
        query: { state: 'open' },
        pagination: { kind: 'link' },
      })) {
        replayed.push(page);
      }
      expect(replayed).toEqual(pages);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replays a GraphQL pageInfo walk, cursors and all', async () => {
    const dir = tempRecordingDir();
    try {
      const ISSUES_PATH = ['data', 'repository', 'issues'] as const;
      const page = (endCursor: string | null, hasNextPage: boolean, nodes: unknown[]): Response =>
        jsonResponse({
          data: { repository: { issues: { pageInfo: { hasNextPage, endCursor }, nodes } } },
        });
      let served = 0;
      const fetch = fetchRoutes({
        '/graphql': () => {
          served += 1;
          return served === 1
            ? page('cursor-1', true, [{ number: 1 }])
            : page(null, false, [{ number: 2 }]);
        },
      });

      const inner = graphqlConnector({ baseUrl: 'https://api.example.com', fetch });
      const recording = recordingConnector(inner, {
        directory: dir,
        provider: 'github',
        enabled: true,
      });
      const spec = {
        kind: 'graphql' as const,
        cursorVariable: 'after',
        pageSizeVariable: 'first',
        pageSize: 10,
        pageInfoPath: [...ISSUES_PATH, 'pageInfo'],
      };

      const pages: unknown[] = [];
      for await (const body of recording.paginate({
        method: 'POST',
        path: '/graphql',
        body: { query: 'query($first: Int, $after: String) { issues { nodes { number } } }' },
        pagination: spec,
      })) {
        pages.push(body);
      }
      expect(pages).toHaveLength(2);
      await recording.close();

      const replay = replayConnector({ file: sessionFileName(dir, 'github') });
      const replayed: unknown[] = [];
      for await (const body of replay.paginate({
        method: 'POST',
        path: '/graphql',
        body: { query: 'query($first: Int, $after: String) { issues { nodes { number } } }' },
        pagination: spec,
      })) {
        replayed.push(body);
      }
      expect(replayed).toEqual(pages);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Committed fixtures are clean (LP-301 AC)
// ---------------------------------------------------------------------------

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/remote/', import.meta.url));

/** Every non-README file under `test/fixtures/remote/`, recursively. */
function committedFixtureFiles(dir: string = FIXTURES_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...committedFixtureFiles(full));
    else if (entry.name !== 'README.md') out.push(full);
  }
  return out;
}

/** Secret shapes a committed fixture must never carry, across the researched platforms. */
const TOKEN_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{10,}\b/, // GitHub fine-grained tokens
  /\bgithub_pat_[A-Za-z0-9_]{10,}\b/, // GitHub PATs
  /\bATATT[A-Za-z0-9]{10,}\b/, // Atlassian API tokens
  /\blin_api_[A-Za-z0-9]{10,}\b/, // Linear personal API keys
  /\bBearer\s+[A-Za-z0-9._~+/-]{6,}\b/i, // a literal bearer credential
];
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;

describe('committed fixtures are clean (LP-301 AC)', () => {
  it('no fixture carries a token or an email address', () => {
    const files = committedFixtureFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of TOKEN_PATTERNS) {
        expect(text, `token pattern ${pattern} in ${file}`).not.toMatch(pattern);
      }
      expect(text, `email address in ${file}`).not.toMatch(EMAIL_PATTERN);
    }
  });

  it('every committed recording.json is idempotent under a re-scrub', () => {
    for (const file of committedFixtureFiles()) {
      if (basename(file) !== 'recording.json') continue;
      const session = readSession(file);
      expect(scrubSession(session)).toEqual(session);
    }
  });
});
