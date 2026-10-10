/**
 * The connect routes — the web connect form's half of the server.
 *
 * These are the only routes that take a secret *in*, so the property worth
 * asserting on every one of them is the negative: a credential value goes into
 * `.lpm/credentials.json` and comes back in no response body, no error message
 * and no committed file. The refusals themselves are the engine's
 * (`test/remote-connection.test.ts`); this file checks the wire keeps them.
 */

import { readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardPaths } from '../src/core/index.js';
import type {
  RemoteConnectionDto,
  RemoteConnectResultDto,
  RemoteCredentialsResultDto,
  RemoteInspectDto,
  RemoteMappingDto,
  RemoteMappingUpdateResultDto,
  RemoteProviderDto,
} from '../src/shared/index.js';
import { startBoardServer } from '../src/server/index.js';
import { remoteSyncGuard, resetRemoteSyncGuard } from '../src/server/routes/remotes.js';
import { registeredProviders } from '../src/remote/index.js';
import { cleanupBoards, makeBoard } from './helpers.js';

const SECRET = 'ghp_this-must-never-come-back';

let paths: BoardPaths;
let server: Server;
let base: string;

beforeEach(async () => {
  for (const env of ['GITHUB_TOKEN', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'LINEAR_API_KEY']) vi.stubEnv(env, '');
  paths = makeBoard('scrum', 'LP');
  const running = await startBoardServer(paths, { port: 0, serveApp: false, experimental: true });
  server = running.server;
  base = running.url;
});

afterEach(() => {
  server.close();
  resetRemoteSyncGuard();
  vi.unstubAllEnvs();
});
afterEach(cleanupBoards);

/** A request, returning the status and the raw body text — the text is what a leak would be in. */
async function call(method: string, route: string, body?: unknown): Promise<{ status: number; text: string }> {
  const response = await fetch(`${base}${route}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return { status: response.status, text: await response.text() };
}

const connectGithub = () =>
  call('POST', '/api/remotes', {
    name: 'github',
    provider: 'github',
    connection: { repo: 'acme/payments' },
    credentials: { token: SECRET },
  });

describe('GET /api/remote-providers', () => {
  it('describes every registered provider, with no secret offered as a connection field', async () => {
    const { status, text } = await call('GET', '/api/remote-providers');
    expect(status).toBe(200);
    const providers = JSON.parse(text) as RemoteProviderDto[];
    expect(providers.map((provider) => provider.name)).toEqual(registeredProviders());
    const github = providers.find((provider) => provider.name === 'github')!;
    expect(github.connection.map((field) => field.name)).toContain('repo');
    expect(github.connection.map((field) => field.name)).not.toContain('token');
    expect(github.credentials).toEqual([{ key: 'token', env: 'GITHUB_TOKEN', visible: false }]);
  });
});

describe('POST /api/remotes', () => {
  it('declares the remote, stores the credential, and returns only where it went', async () => {
    const { status, text } = await connectGithub();
    expect(status).toBe(201);
    expect(text).not.toContain(SECRET);

    const result = JSON.parse(text) as RemoteConnectResultDto;
    expect(result).toMatchObject({ name: 'github', provider: 'github', target: 'acme/payments', stored: ['token'] });
    expect(result.credentials[0]!.source).toContain('credentials.json');

    expect(readFileSync(paths.configPath, 'utf8')).not.toContain(SECRET);
    expect(readFileSync(paths.credentialsPath, 'utf8')).toContain(SECRET);
  });

  it('refuses a secret sent as a connection value, and does not repeat it in the error', async () => {
    const { status, text } = await call('POST', '/api/remotes', {
      name: 'github',
      provider: 'github',
      connection: { repo: 'acme/payments', token: SECRET },
    });
    expect(status).toBe(400);
    expect(text).toContain('is a credential');
    expect(text).not.toContain(SECRET);
    // Nothing was declared: the Scrum template mentions GitHub in its comments, so check the declaration.
    expect(readFileSync(paths.configPath, 'utf8')).not.toContain('provider: github');
  });

  it('refuses a malformed body by naming the key, never the value', async () => {
    const { status, text } = await call('POST', '/api/remotes', {
      name: 'github',
      provider: 'github',
      credentials: { token: { nested: SECRET } },
    });
    expect(status).toBe(400);
    expect(text).toContain('credentials.token must be a string');
    expect(text).not.toContain(SECRET);
  });

  it('will not change the config while a sync is running', async () => {
    remoteSyncGuard.inFlight = 'somewhere';
    const { status, text } = await connectGithub();
    expect(status).toBe(409);
    expect(text).toContain('A sync is running');
  });
});

describe('the connection of a declared remote', () => {
  it('shows non-secret values and credential sources, never the credential', async () => {
    await connectGithub();
    const { status, text } = await call('GET', '/api/remotes/github/connection');
    expect(status).toBe(200);
    expect(text).not.toContain(SECRET);
    const connection = JSON.parse(text) as RemoteConnectionDto;
    expect(connection.connection).toEqual({ repo: 'acme/payments' });
    expect(connection.credentials.map((state) => state.key)).toEqual(['token']);
    expect(connection.linked).toBe(0);
  });

  it('replaces a credential and reports its source, keeping a blank as "unchanged"', async () => {
    await connectGithub();
    const kept = await call('PUT', '/api/remotes/github/credentials', { credentials: { token: '' } });
    expect((JSON.parse(kept.text) as RemoteCredentialsResultDto).stored).toEqual([]);

    const replaced = await call('PUT', '/api/remotes/github/credentials', { credentials: { token: 'ghp_rotated' } });
    expect(replaced.status).toBe(200);
    expect(replaced.text).not.toContain('ghp_rotated');
    expect(JSON.parse(readFileSync(paths.credentialsPath, 'utf8')).github.token).toBe('ghp_rotated');
  });

  it('refuses a credential key the provider does not declare', async () => {
    await connectGithub();
    const { status, text } = await call('PUT', '/api/remotes/github/credentials', { credentials: { password: SECRET } });
    expect(status).toBe(400);
    expect((JSON.parse(text) as { error: string }).error).toContain('"password" is not a credential');
    expect(text).not.toContain(SECRET);
  });

  it('will not re-point a remote that already mirrors documents', async () => {
    await connectGithub();
    const dir = path.join(paths.remotesDir, 'github');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'links.json'),
      JSON.stringify({
        version: 1,
        cursor: null,
        links: {
          'LP-1': {
            remoteId: 'I_1',
            remoteKey: 'acme/payments#1',
            remoteUrl: '',
            syncedAt: '2026-08-15T00:00:00.000Z',
            remoteRev: 'r1',
            base: { title: 'x' },
          },
        },
      }),
    );
    const { status, text } = await call('PUT', '/api/remotes/github/connection', { connection: { repo: 'acme/other' } });
    expect(status).toBe(400);
    expect(text).toContain('already mirrors 1 document');
    expect(readFileSync(paths.configPath, 'utf8')).toContain('repo: acme/payments');
  });
});

describe('inspect, answers and remove', () => {
  it('inspects a remote that needs nothing, reporting it reachable and ready', async () => {
    await call('POST', '/api/remotes', { name: 'demo', provider: 'jsonfile', connection: {} });
    const { status, text } = await call('POST', '/api/remotes/demo/inspect', {});
    expect(status).toBe(200);
    const report = JSON.parse(text) as RemoteInspectDto;
    expect(report).toMatchObject({ remoteName: 'demo', stopped: false, noVocabulary: true, ready: true });
    expect(report.reachability?.reachable).toBe(true);
  });

  it('refuses an answer that would write a credential into config.yml', async () => {
    await call('POST', '/api/remotes', {
      name: 'jira',
      provider: 'jira',
      connection: { site: 'https://acme.atlassian.net', project: 'PAY' },
    });
    const { status, text } = await call('POST', '/api/remotes/jira/answers', { connection: { token: SECRET } });
    expect(status).toBe(400);
    expect(text).not.toContain(SECRET);
    expect(readFileSync(paths.configPath, 'utf8')).not.toContain(SECRET);
  });

  it('removes a remote', async () => {
    await connectGithub();
    const { status } = await call('DELETE', '/api/remotes/github');
    expect(status).toBe(200);
    const remotes = JSON.parse((await call('GET', '/api/remotes')).text) as unknown[];
    expect(remotes).toEqual([]);
  });
});

describe('the credential is only ever in one file', () => {
  it('leaves no trace of the secret anywhere under .lpm but credentials.json', async () => {
    // The strongest form of the property: not just absent from responses and
    // config.yml, but from every file the connect, the rotation and the read
    // touched - a log, a cache, a link store.
    await connectGithub();
    await call('PUT', '/api/remotes/github/credentials', { credentials: { token: SECRET } });
    await call('GET', '/api/remotes/github/connection');

    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry !== 'credentials.json' && readFileSync(full, 'utf8').includes(SECRET)) hits.push(full);
      }
    };
    walk(paths.lpmDir);
    expect(hits).toEqual([]);
  });
});

describe('the mapping editor routes', () => {
  const connectJira = () =>
    call('POST', '/api/remotes', {
      name: 'jira',
      provider: 'jira',
      connection: { site: 'https://acme.atlassian.net', project: 'PAY' },
    });

  it('answers the drafted mapping, and says why the tracker was not asked', async () => {
    await connectJira();
    const { status, text } = await call('GET', '/api/remotes/jira/mapping');

    expect(status).toBe(200);
    const view = JSON.parse(text) as RemoteMappingDto;
    expect(view.provider).toBe('jira');
    expect(view.types.fixed).toBe(false);
    expect(view.types.mapping.user_story).toBe('Story');
    expect(view.statuses.mapping.done).toEqual(['Done']);
    expect(view.problems[0]).toContain('The tracker was not asked');
  });

  it('writes a chosen mapping into config.yml and answers the changed lines with the new view', async () => {
    await connectJira();
    const before = JSON.parse((await call('GET', '/api/remotes/jira/mapping')).text) as RemoteMappingDto;

    const { status, text } = await call('PUT', '/api/remotes/jira/mapping', {
      types: { ...before.types.mapping, test: 'Story' },
      statuses: { ...before.statuses.mapping, in_review: ['In Review', 'In Progress'] },
    });

    expect(status).toBe(200);
    const result = JSON.parse(text) as RemoteMappingUpdateResultDto;
    expect(result.changed).toEqual([
      'types.test: Task → Story',
      'statuses.in_review: ["In Progress"] → ["In Review","In Progress"]',
    ]);
    expect(result.mapping.types.mapping.test).toBe('Story');
    expect(result.mapping.statuses.mapping.in_review).toEqual(['In Review', 'In Progress']);
    // The entry keeps the object form that `lpm remote add` wrote.
    expect(readFileSync(paths.configPath, 'utf8')).toMatch(/test: \{ ?remote: Story ?\}/);
  });

  it('answers 400 for a mapping that leaves a board status unmapped, and for a malformed body', async () => {
    await connectJira();
    const refused = await call('PUT', '/api/remotes/jira/mapping', { statuses: { backlog: ['To Do'] } });
    expect(refused.status).toBe(400);
    expect(JSON.parse(refused.text).error).toBe('Not every status of the board is mapped');

    expect((await call('PUT', '/api/remotes/jira/mapping', { statuses: { backlog: 'To Do' } })).status).toBe(400);
  });

  it('is not registered on a server started without --experimental', async () => {
    const plain = await startBoardServer(paths, { port: 0, serveApp: false });
    try {
      expect((await fetch(`${plain.url}/api/remotes/jira/mapping`)).status).toBe(404);
    } finally {
      plain.server.close();
    }
  });
});
