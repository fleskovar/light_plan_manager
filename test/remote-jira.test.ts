/**
 * LP-491 — open a Jira Cloud connection: site URL, Basic Auth and TLS trust.
 *
 * The Jira provider wraps `jira.js` (an optional *peer* dependency, dynamically
 * imported) behind the provider `Connector` contract. This file asserts the
 * connection story's acceptance criteria, offline:
 *
 *   - the provider schema validates `site` as an https URL (Cloud or custom
 *     domain), and `email` + `token` resolve through the credential chain;
 *   - the Basic Auth header is built by the wrapped client (never by hand) and
 *     the resolved secrets are registered with the redactor, never logged;
 *   - `jira.js` is an optional peer dependency, the four runtime dependencies are
 *     unchanged, and a missing client is a `BoardError` naming the install;
 *   - TLS verification is on by default and `tls_verify: false` warns loudly;
 *   - a wrong site, a wrong email and a revoked token produce three different
 *     messages, each naming the fix;
 *   - no code under `web/` reaches for the Jira API (Atlassian serves no CORS
 *     headers, so sync round-trips through the local server).
 *
 * jira.js v6 rides Node's built-in `fetch`, so the tests stub the global
 * `fetch` and drive the real connector — no network, no tokens.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoardError } from '../src/core/errors.js';
import { jiraConfigSchema } from '../src/remote/providers/jira/config.js';
import { jiraConnector } from '../src/remote/providers/jira/connector.js';
import { jiraProvider } from '../src/remote/providers/jira/index.js';
import {
  describeRequest,
  fieldsFromRecord,
  jiraTranslator,
} from '../src/remote/providers/jira/translator.js';
import { markdownToAdf, type AdfDocument } from '../src/shared/adf.js';
import { redactor } from '../src/remote/redact.js';
import { hashBody } from '../src/remote/links.js';
import { buildConnector, type OpenedRemote } from '../src/remote/remotes.js';
import { cleanupBoards, makeBoard } from './helpers.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  redactor.clear();
});

afterEach(() => {
  // The TLS-disabled test flips the process-wide switch; never let it leak.
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
});

const SITE = 'https://acme.atlassian.net';
const CONNECTION = { site: SITE, project: 'PAY', email: 'me@acme.com', token: 'api-token' };

/** The board-vocabulary connection the provider connector expects. */
function connection(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...CONNECTION, ...extra };
}

/** A message + its hints, flattened for assertions. */
function messageOf(error: unknown): string {
  return error instanceof BoardError ? `${error.message}\n${error.details.join('\n')}` : String(error);
}

// ---------------------------------------------------------------------------
// Provider schema (LP-259): site, project, board, email, token, tls_verify
// ---------------------------------------------------------------------------

describe('jiraConfigSchema', () => {
  it('accepts a Cloud site and a project key', () => {
    const result = jiraConfigSchema.safeParse({
      connection: { site: 'https://acme.atlassian.net', project: 'PAY' },
      mapping: {},
    });
    expect(result.success).toBe(true);
  });

  it('accepts a Cloud site on a custom domain', () => {
    const result = jiraConfigSchema.safeParse({
      connection: { site: 'https://jira.acme.com', project: 'PAY' },
      mapping: {},
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-https site', () => {
    const result = jiraConfigSchema.safeParse({
      connection: { site: 'http://acme.atlassian.net', project: 'PAY' },
      mapping: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects a site with no host', () => {
    const result = jiraConfigSchema.safeParse({
      connection: { site: 'https://', project: 'PAY' },
      mapping: {},
    });
    expect(result.success).toBe(false);
  });

  it('requires connection.site', () => {
    const result = jiraConfigSchema.safeParse({ connection: { project: 'PAY' }, mapping: {} });
    expect(result.success).toBe(false);
  });

  it('requires a project key in the PAY shape', () => {
    const bad = jiraConfigSchema.safeParse({
      connection: { site: SITE, project: 'not a key' },
      mapping: {},
    });
    expect(bad.success).toBe(false);

    const good = jiraConfigSchema.safeParse({
      connection: { site: SITE, project: 'PAY_2' },
      mapping: {},
    });
    expect(good.success).toBe(true);
  });

  it('accepts the agile board id as a number or a numeric string, stringified', () => {
    const asNumber = jiraConfigSchema.safeParse({
      connection: { site: SITE, project: 'PAY', board: 34 },
      mapping: {},
    });
    expect(asNumber.success).toBe(true);
    if (asNumber.success) expect(asNumber.data.connection.board).toBe('34');

    const asString = jiraConfigSchema.safeParse({
      connection: { site: SITE, project: 'PAY', board: '34' },
      mapping: {},
    });
    expect(asString.success).toBe(true);
    if (asString.success) expect(asString.data.connection.board).toBe('34');
  });

  it('treats email and token as optional (resolved through the credential chain)', () => {
    const result = jiraConfigSchema.safeParse({
      connection: { site: SITE, project: 'PAY' },
      mapping: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.connection.email).toBeUndefined();
      expect(result.data.connection.token).toBeUndefined();
    }
  });

  it('leaves tls_verify absent by default, and accepts the explicit false', () => {
    const absent = jiraConfigSchema.safeParse({
      connection: { site: SITE, project: 'PAY' },
      mapping: {},
    });
    expect(absent.success).toBe(true);
    if (absent.success) expect(absent.data.connection.tls_verify).toBeUndefined();

    const off = jiraConfigSchema.safeParse({
      connection: { site: SITE, project: 'PAY', tls_verify: false },
      mapping: {},
    });
    expect(off.success).toBe(true);
    if (off.success) expect(off.data.connection.tls_verify).toBe(false);
  });

  it('declares email and token as secrets, with their conventional env vars', () => {
    expect(jiraProvider.credentials?.secrets).toEqual({
      email: 'JIRA_EMAIL',
      token: 'JIRA_API_TOKEN',
    });
  });
});

// ---------------------------------------------------------------------------
// The wrapped client: Basic Auth built by jira.js, never by hand, never logged
// ---------------------------------------------------------------------------

describe('jiraConnector: sits behind the Connector contract (LP-289)', () => {
  it('builds a connector with the executor-facing operations, no special case', () => {
    const connector = jiraConnector(connection());
    expect(connector.name).toBe('jira');
    expect(typeof connector.create).toBe('function');
    expect(typeof connector.update).toBe('function');
    expect(typeof connector.delete).toBe('function');
    expect(typeof connector.get).toBe('function');
    expect(typeof connector.list).toBe('function');
    expect(typeof connector.resolve).toBe('function');
    expect(typeof connector.link).toBe('function');
    expect(typeof connector.unlink).toBe('function');
    expect(typeof connector.comment).toBe('function');
    expect(typeof connector.editComment).toBe('function');
    expect(typeof connector.deleteComment).toBe('function');
    expect(typeof connector.reachable).toBe('function');
  });
});

describe('jiraConnector: Basic Auth through the wrapped client', () => {
  it('sends the Basic Auth header the client constructed (email:token)', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) } });
      return new Response(JSON.stringify({ id: '1', key: 'PAY-1', fields: { updated: '2026-09-01T00:00:00Z' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const connector = jiraConnector(connection());
    await connector.get('PAY-1');

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`${SITE}/rest/api/3/issue/PAY-1`);
    const expected = Buffer.from('me@acme.com:api-token').toString('base64');
    expect(seen[0]!.headers['Authorization']).toBe(`Basic ${expected}`);

    // The secret values never travel in the clear — not in the URL, not in any
    // header except as the base64 Basic blob the client assembled.
    const onTheWire = JSON.stringify(seen[0]!);
    expect(onTheWire).not.toContain('me@acme.com');
    expect(onTheWire).not.toContain('api-token');
  });

  it('registers the resolved email and token with the process-wide redactor', () => {
    vi.stubEnv('JIRA_EMAIL', 'me@acme.com');
    vi.stubEnv('JIRA_API_TOKEN', 'api-token');
    const paths = makeBoard('blank', 'LP');

    const remote: OpenedRemote = {
      name: 'jira',
      provider: jiraProvider,
      direction: 'both',
      on_delete: 'unlink',
      conflict: 'manual',
      fields: {},
      encoding: 'block',
      comments: 'push',
      connection: {
        site: SITE,
        project: 'PAY',
        email: '${JIRA_EMAIL}',
        token: '${JIRA_API_TOKEN}',
      },
      mapping: {},
    };

    const connector = buildConnector(remote, paths);
    expect(connector.name).toBe('jira');

    // LP-296: the redactor turns each secret into `***`, whole.
    expect(redactor.redact('me@acme.com')).toBe('***');
    expect(redactor.redact('api-token')).toBe('***');
  });
});

// ---------------------------------------------------------------------------
// The client library: optional, dynamic, a BoardError when missing
// ---------------------------------------------------------------------------

describe('jira.js is an optional peer dependency', () => {
  const ROOT = fileURLToPath(new URL('..', import.meta.url));

  it('is an optional peer, like the pi SDK, and the four runtime dependencies are unchanged', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      optionalDependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
      peerDependenciesMeta: Record<string, { optional?: boolean }>;
    };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['acorn', 'eta', 'yaml', 'zod']);
    // Experimental features are not part of the standard install: npm installs
    // an optional dependency by default and an optional peer never, so each of
    // these must be a peer marked optional and nothing else.
    for (const name of ['jira.js', '@earendil-works/pi-coding-agent', '@earendil-works/pi-ai']) {
      expect(pkg.peerDependencies[name], name).toBeDefined();
      expect(pkg.peerDependenciesMeta[name]?.optional, name).toBe(true);
      expect(pkg.dependencies[name], name).toBeUndefined();
      expect(pkg.optionalDependencies[name], name).toBeUndefined();
    }
  });

  it('is imported through a computed specifier, so tsc does not bind to it', () => {
    const source = readFileSync(join(ROOT, 'src/remote/providers/jira/connector.ts'), 'utf8');
    expect(source).toContain('const JIRA_PACKAGE');
    expect(source).toContain('await import(JIRA_PACKAGE)');
    // The specifier must not be inlined into the import — that is what would
    // make the engine fail to build on a machine without jira.js installed.
    expect(source).not.toMatch(/await\s+import\(\s*['"]jira\.js['"]\s*\)/);
  });

});

// ---------------------------------------------------------------------------
// TLS: on by default and stays on; the loud fallback; the three error shapes
// ---------------------------------------------------------------------------

describe('jiraConnector TLS trust', () => {
  it('leaves TLS verification on by default', () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    jiraConnector(connection());

    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).not.toBe('0');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns loudly on every build when tls_verify: false', () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});

    jiraConnector(connection({ tls_verify: false }));
    jiraConnector(connection({ tls_verify: false }));

    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe('0');
    // Two builds, two warnings — the disable is loud on every run, never quiet.
    expect(warn).toHaveBeenCalledTimes(2);
    const text = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(text).toContain('TLS verification is DISABLED');
    expect(text).toContain('NODE_EXTRA_CA_CERTS');
    expect(text).toContain('--use-system-ca');
    warn.mockRestore();
  });

  it('names the trust-store path, and only then tls_verify, for a TLS failure', async () => {
    vi.stubGlobal('fetch', () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('self-signed certificate'), {
          code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
        }),
      });
    });

    const connector = jiraConnector(connection());
    const message = await (async () => {
      try {
        await connector.get('PAY-1');
        return null;
      } catch (error) {
        return messageOf(error);
      }
    })();

    expect(message).toContain('cannot reach the Jira site');
    expect(message).toContain('NODE_EXTRA_CA_CERTS');
    expect(message).toContain('--use-system-ca');
    // The disable is a last resort, not the suggestion.
    expect(message!.indexOf('NODE_EXTRA_CA_CERTS')).toBeLessThan(message!.indexOf('tls_verify: false'));
  });
});

describe('jiraConnector error shapes (LP-294)', () => {
  function stub401(body: unknown) {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify(body), { status: 401, headers: { 'Content-Type': 'application/json' } }),
    );
  }

  it('wrong site: cannot reach, naming the site and the fix', async () => {
    vi.stubGlobal('fetch', () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }),
      });
    });

    const connector = jiraConnector(connection());
    const message = await (async () => {
      try {
        await connector.get('PAY-1');
        return null;
      } catch (error) {
        return messageOf(error);
      }
    })();

    expect(message).toContain('cannot reach the Jira site at https://acme.atlassian.net');
    expect(message).toContain('connection.site');
  });

  it('wrong email: the 401 body blames the account, not the token', async () => {
    stub401({ errorMessages: ['Basic authentication with passwords is deprecated'] });

    const connector = jiraConnector(connection());
    const message = await (async () => {
      try {
        await connector.get('PAY-1');
        return null;
      } catch (error) {
        return messageOf(error);
      }
    })();

    expect(message).toContain('the Jira account email was rejected');
    expect(message).toContain('connection.email');
    expect(message).not.toContain('the Jira API token was rejected');
  });

  it('revoked token: a plain invalid-credentials 401 blames the token', async () => {
    stub401({ errorMessages: ['The security token is invalid'] });

    const connector = jiraConnector(connection());
    const message = await (async () => {
      try {
        await connector.get('PAY-1');
        return null;
      } catch (error) {
        return messageOf(error);
      }
    })();

    expect(message).toContain('the Jira API token was rejected');
    expect(message).toContain('id.atlassian.com');
    expect(message).not.toContain('the Jira account email was rejected');
  });

  it('a Server/Data Center URL gets a not-supported 404 rather than a confusing 401', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ errorMessages: ['Issue does not exist or you do not have permission to see it.'] }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    // A Server instance has no Cloud v3 API, so the cursor-paged search 404s —
    // the one read that tells "this is not a Cloud site" apart from a deletion.
    const connector = jiraConnector(connection({ site: 'https://jira.acme.com' }));
    const message = await (async () => {
      try {
        await connector.list();
        return null;
      } catch (error) {
        return messageOf(error);
      }
    })();

    expect(message).toContain('Jira answered 404');
    expect(message).toContain('not supported');
  });
});

// ---------------------------------------------------------------------------
// No Jira traffic from the browser (LP-250)
// ---------------------------------------------------------------------------

describe('the web app never calls the Jira API', () => {
  const WEB_SRC = fileURLToPath(new URL('../web/src', import.meta.url));

  function filesUnder(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...filesUnder(full));
      else if (/\.(ts|svelte|js|svelte\.ts)$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  it('contains no `atlassian` reference', () => {
    const offenders: string[] = [];
    for (const file of filesUnder(WEB_SRC)) {
      const source = readFileSync(file, 'utf8');
      if (/atlassian/i.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

describe('jiraConnector: listing pages with the v3 cursor search (LP-323)', () => {
  it('POSTs /rest/api/3/search/jql with an updated >= JQL and nextPageToken, never the offset /search', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST' && url.endsWith('/rest/api/3/search/jql')) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        calls.push({ body });
        const nextPageToken = body['nextPageToken'] === undefined ? 'tok-2' : null;
        return new Response(
          JSON.stringify({
            issues: [
              { id: '10042', key: 'PAY-418', fields: { updated: '2026-09-02T00:00:00Z' } },
              { id: '10043', key: 'PAY-419', fields: { updated: '2026-09-01T00:00:00Z' } },
            ],
            nextPageToken,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const connector = jiraConnector(connection());
    const page = await connector.list({ cursor: '2026-09-01T00:00:00Z' });

    // Two pages: the first without a token, the second carrying tok-2.
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body['nextPageToken']).toBeUndefined();
    expect(calls[1]!.body['nextPageToken']).toBe('tok-2');

    const jql = calls[0]!.body['jql'] as string;
    expect(jql).toContain('project = PAY');
    expect(jql).toContain('updated >= "2026-09-01T00:00:00Z"');
    expect(jql).toContain('ORDER BY updated ASC');

    // The returned cursor is the newest `updated` seen across both pages.
    expect(page.cursor).toBe('2026-09-02T00:00:00Z');
    expect(page.records).toHaveLength(4);
  });
});

describe('jiraConnector: create records the twin and sends an ADF description', () => {
  it('files a create, records key + id + browse URL, and writes the body as ADF', async () => {
    const seen: Array<{ url: string; method: string; body: string }> = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      seen.push({ url, method, body: typeof init?.body === 'string' ? init.body : '' });
      if (method === 'POST' && url.endsWith('/rest/api/3/issue')) {
        return new Response(JSON.stringify({ id: '10042', key: 'PAY-418', self: `${SITE}/rest/api/3/issue/10042` }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({ id: '10042', key: 'PAY-418', self: `${SITE}/rest/api/3/issue/10042`, fields: { updated: '2026-09-01T00:00:00Z' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const connector = jiraConnector(connection());
    const result = await connector.create({
      kind: 'create',
      type: 'Story',
      title: 'A title',
      body: markdownToAdf('## Heading\n\nSome prose.'),
    });

    expect(result.remoteId).toBe('10042');
    expect(result.remoteKey).toBe('PAY-418');
    expect(result.remoteUrl).toBe(`${SITE}/browse/PAY-418`);

    const createCall = seen.find((call) => call.method === 'POST')!;
    const sent = JSON.parse(createCall.body) as { fields: { description: unknown; summary: string; issuetype: { name: string } } };
    expect(sent.fields.summary).toBe('A title');
    expect(sent.fields.issuetype).toEqual({ name: 'Story' });
    // The description went as an ADF document, not a markdown string.
    expect(sent.fields.description).toEqual({ version: 1, type: 'doc', content: markdownToAdf('## Heading\n\nSome prose.').content });
  });
});

// ---------------------------------------------------------------------------
// LP-323 — bodies convert both ways: markdown → ADF on push, ADF → markdown
// on pull, and the managed block never reaches Jira's description.
// ---------------------------------------------------------------------------

describe('jiraTranslator: body conversion (LP-323)', () => {
  const MAPPING = {
    types: { user_story: { remote: 'Story' } },
    statuses: { backlog: { remote: ['Backlog'] }, in_progress: { remote: ['In Progress'] } },
    attributes: {},
  };
  const ATTRS = {};

  const op = (fields: Record<string, unknown>) => ({
    kind: 'create' as const,
    localId: 'LP-1',
    fields: { type: 'user_story', status: 'backlog', ...fields },
  });

  it('leaves the body as markdown for the connector to encode', () => {
    // ADF is a *wire* encoding, so the conversion happens at the connector, in
    // `fieldsOf`. It used to happen here — which meant the executor could not
    // add the managed block (it composes in markdown and skipped a body that
    // was already an object), so the degraded parent, the degraded period
    // levels and the block-carried edges never reached Jira at all.
    const { request } = describeRequest(op({ title: 'A title', body: '## Heading\n\nSome **bold** text.' }), MAPPING, ATTRS);
    expect(request.body).toBe('## Heading\n\nSome **bold** text.');
  });

  it('does not send a body when the op carries none (title-only update)', () => {
    const { request } = describeRequest(
      { kind: 'update', localId: 'LP-1', remoteId: 'PAY-1', fields: { type: 'user_story', status: 'backlog', title: 'New title' } },
      MAPPING,
      ATTRS,
    );
    expect(request.body).toBeUndefined();
    expect(request.title).toBe('New title');
  });

  it('strips the managed block, which the executor composes back on (LP-309)', () => {
    const body = [
      'Prose above.',
      '',
      '<!-- lpm:begin -->',
      '| light-plan | |',
      '| --- | --- |',
      '| type | feature |',
      '<!-- lpm:end -->',
      '',
      'Prose below.',
    ].join('\n');
    const { request } = describeRequest(op({ title: 'A title', body }), MAPPING, ATTRS);
    const serialised = JSON.stringify(request.body);
    expect(serialised).not.toContain('lpm:begin');
    expect(serialised).toContain('Prose above');
    expect(serialised).toContain('Prose below');
  });

  it('converts an ADF description back to markdown on pull', () => {
    const doc = markdownToAdf('## Heading\n\n- [ ] open task');
    const record = { fields: { summary: 'A title', description: doc } };
    const { patch } = fieldsFromRecord(record, MAPPING, ATTRS);
    expect(patch.title).toBe('A title');
    expect(patch.body).toBe('## Heading\n\n- [ ] open task');
  });

  it('accepts a stringified ADF description defensively', () => {
    const doc = markdownToAdf('plain prose');
    const record = { fields: { description: JSON.stringify(doc) } };
    const { patch } = fieldsFromRecord(record, MAPPING, ATTRS);
    expect(patch.body).toBe('plain prose');
  });

  it('leaves the body absent when there is no description', () => {
    const { patch } = fieldsFromRecord({ fields: { summary: 'A title' } }, MAPPING, ATTRS);
    expect(patch.body).toBeUndefined();
  });
});


describe('jiraTranslator.normalizeBody: the base can settle (LP-534 neighbour)', () => {
  const normalize = jiraTranslator.normalizeBody!;
  const MAPPING = {
    types: { user_story: { remote: 'Story' } },
    statuses: { backlog: { remote: ['Backlog'] } },
    attributes: {},
  };
  const ATTRS = {};

  it('is declared, because Jira bodies are ADF rather than markdown', () => {
    expect(typeof jiraTranslator.normalizeBody).toBe('function');
  });

  it('reads a hard-wrapped paragraph the way Jira hands it back', () => {
    // ADF has paragraphs and no source line breaks, so the wrap is lost on the
    // way out. Without the normaliser the board's copy never equals the echo
    // and every wrapped document is ahead for ever.
    const wrapped = 'One sentence that somebody\nwrapped at a narrow column\nwhile writing it.';
    const echoed = fieldsFromRecord(
      { fields: { description: markdownToAdf(wrapped) } },
      MAPPING,
      ATTRS,
    ).patch.body;
    expect(normalize(wrapped)).toBe(echoed);
  });

  it('hashes a rewrapped body the same, and a real edit differently', () => {
    const wrapped = 'The same words, wrapped\nacross two lines.';
    const rewrapped = 'The same words, wrapped across two lines.';
    const edited = 'The same words, rewritten across two lines.';
    expect(hashBody(wrapped, normalize)).toBe(hashBody(rewrapped, normalize));
    expect(hashBody(edited, normalize)).not.toBe(hashBody(wrapped, normalize));
  });

  it('is idempotent, so a second push cannot disagree with the first', () => {
    const body = '## Heading\n\n- [ ] one\n- [x] two\n\n```ts\nconst x = 1;\n```';
    expect(normalize(normalize(body))).toBe(normalize(body));
  });
});
