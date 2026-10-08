/**
 * Connecting a remote without a terminal — the engine half of the web connect
 * form (`src/remote/connection.ts`, `connection-catalogue.ts`, `inspect.ts`).
 *
 * The form sends every answer at once, so the rules `lpm remote connect` and
 * `lpm remote login` enforce a question at a time have to hold for a single
 * call. The ones that matter most are the ones that protect a committed file
 * and a mirror that already exists: a secret never reaches config.yml, a
 * refused key never leaves anything half-written, and a remote with twins is
 * never re-pointed in place.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadBoard, loadConfig, type BoardPaths } from '../src/core/index.js';
import {
  applyInspectAnswers,
  connectRemote,
  describeProviders,
  inspectRemoteConnection,
  registeredProviders,
  remoteCredentialStates,
  setRemoteConnection,
  storeCredentials,
} from '../src/remote/index.js';
import { cleanupBoards, makeBoard } from './helpers.js';

afterEach(cleanupBoards);
afterEach(() => vi.unstubAllEnvs());

beforeEach(() => {
  // A credential in the developer's own shell must not satisfy a test's remote.
  for (const env of ['GITHUB_TOKEN', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'LINEAR_API_KEY']) vi.stubEnv(env, '');
});

const config = (paths: BoardPaths) => loadConfig(paths).config!;
const configText = (paths: BoardPaths) => readFileSync(paths.configPath, 'utf8');

/** A link store holding one twin, so the remote counts as already mirroring. */
function mirrorOne(paths: BoardPaths, remote: string): void {
  const dir = path.join(paths.remotesDir, remote);
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
          remoteUrl: 'https://github.com/acme/payments/issues/1',
          syncedAt: '2026-08-15T00:00:00.000Z',
          remoteRev: 'r1',
          base: { title: 'x' },
        },
      },
    }),
  );
}

describe('describeProviders', () => {
  it('describes every registered provider, so the form needs no list of its own', () => {
    expect(describeProviders().map((provider) => provider.name)).toEqual(registeredProviders());
  });

  it('never offers a credential as a connection field', () => {
    // A field for `token` in the connection half of the form would put the
    // secret into config.yml, which is committed.
    for (const provider of describeProviders()) {
      const secrets = new Set(provider.credentials.map((field) => field.key));
      for (const field of provider.connection) expect(secrets.has(field.name), `${provider.name}.${field.name}`).toBe(false);
    }
  });

  it('marks only a value that is no secret to look at as visible', () => {
    const jira = describeProviders().find((provider) => provider.name === 'jira')!;
    expect(jira.credentials).toEqual([
      { key: 'email', env: 'JIRA_EMAIL', visible: true },
      { key: 'token', env: 'JIRA_API_TOKEN', visible: false },
    ]);
    expect(jira.credentialUrl).toMatch(/^https:\/\//);
    expect(jira.conditional.map((field) => field.key)).toEqual(['board']);
  });

  it('asks nothing of a provider that can work its own connection out', () => {
    const jsonfile = describeProviders().find((provider) => provider.name === 'jsonfile')!;
    expect(jsonfile.credentials).toEqual([]);
    expect(jsonfile.connection.every((field) => !field.required)).toBe(true);
  });
});

describe('connectRemote', () => {
  it('declares the remote and stores its credential beside it, never in config.yml', () => {
    const paths = makeBoard('scrum', 'LP');
    const result = connectRemote(paths, config(paths), {
      name: 'github',
      provider: 'github',
      connection: { repo: 'acme/payments' },
      credentials: { token: 'ghp_do-not-commit' },
    });

    expect(result.stored).toEqual(['token']);
    expect(configText(paths)).toContain('repo: acme/payments');
    expect(configText(paths)).not.toContain('ghp_do-not-commit');
    expect(JSON.parse(readFileSync(paths.credentialsPath, 'utf8'))).toEqual({
      github: { token: 'ghp_do-not-commit' },
    });

    // The state says where the value is, and the result carries no value at all.
    expect(result.credentials[0]!.source).toContain('credentials.json');
    expect(JSON.stringify(result)).not.toContain('ghp_do-not-commit');
  });

  it('refuses a secret sent as a connection value, before anything is written', () => {
    const paths = makeBoard('scrum', 'LP');
    const before = configText(paths);
    expect(() =>
      connectRemote(paths, config(paths), {
        name: 'github',
        provider: 'github',
        connection: { repo: 'acme/payments', token: 'ghp_do-not-commit' },
      }),
    ).toThrow(/is a credential of provider "github", not a connection value/);
    expect(configText(paths)).toBe(before);
    expect(existsSync(paths.credentialsPath)).toBe(false);
  });

  it('refuses an undeclared credential key before declaring the remote', () => {
    // Half a connect — the remote declared, its credential refused — is the
    // state a form must never leave behind.
    const paths = makeBoard('scrum', 'LP');
    const before = configText(paths);
    expect(() =>
      connectRemote(paths, config(paths), {
        name: 'github',
        provider: 'github',
        connection: { repo: 'acme/payments' },
        credentials: { password: 'hunter2' },
      }),
    ).toThrow(/"password" is not a credential of provider "github"/);
    expect(configText(paths)).toBe(before);
  });

  it('refuses a connection key the provider does not declare', () => {
    const paths = makeBoard('scrum', 'LP');
    expect(() =>
      connectRemote(paths, config(paths), {
        name: 'github',
        provider: 'github',
        connection: { repo: 'acme/payments', team: 'ENG' },
      }),
    ).toThrow(/"team" is not a connection option for provider "github"/);
  });

  it('refuses a name that is taken unless replacing it is asked for', () => {
    const paths = makeBoard('scrum', 'LP');
    const options = { name: 'github', provider: 'github', connection: { repo: 'acme/payments' } };
    connectRemote(paths, config(paths), options);
    expect(() => connectRemote(paths, config(paths), options)).toThrow(/already has a remote named "github"/);
    expect(connectRemote(paths, config(paths), { ...options, force: true }).replaced).toBe(true);
  });

  it('declares a provider that needs no credential and no connection answers', () => {
    const paths = makeBoard('scrum', 'LP');
    const result = connectRemote(paths, config(paths), { name: 'demo', provider: 'jsonfile', connection: {} });
    expect(result.credentials).toEqual([]);
    expect(configText(paths)).toContain('provider: jsonfile');
  });
});

describe('storeCredentials', () => {
  it('keeps what is there when a value is left blank', () => {
    const paths = makeBoard('scrum', 'LP');
    connectRemote(paths, config(paths), {
      name: 'jira',
      provider: 'jira',
      connection: { site: 'https://acme.atlassian.net', project: 'PAY' },
      credentials: { email: 'me@acme.com', token: 'old-token' },
    });

    // Replacing one expired token must not demand the email back.
    expect(storeCredentials(paths, 'jira', 'jira', { email: '', token: 'new-token' })).toEqual(['token']);
    expect(JSON.parse(readFileSync(paths.credentialsPath, 'utf8')).jira).toEqual({
      email: 'me@acme.com',
      token: 'new-token',
    });
  });

  it('refuses an unknown key without writing the known ones', () => {
    const paths = makeBoard('scrum', 'LP');
    connectRemote(paths, config(paths), { name: 'github', provider: 'github', connection: { repo: 'acme/payments' } });
    expect(() => storeCredentials(paths, 'github', 'github', { token: 't', extra: 'x' })).toThrow(
      /"extra" is not a credential/,
    );
    expect(existsSync(paths.credentialsPath)).toBe(false);
  });

  it('reports states by source, following the conventional env var', () => {
    const paths = makeBoard('scrum', 'LP');
    connectRemote(paths, config(paths), { name: 'github', provider: 'github', connection: { repo: 'acme/payments' } });
    expect(remoteCredentialStates(paths, config(paths), 'github')[0]!.source).toBeUndefined();
    vi.stubEnv('GITHUB_TOKEN', 'from-the-shell');
    const [state] = remoteCredentialStates(paths, config(paths), 'github');
    expect(state!.source).toBe('$GITHUB_TOKEN');
    expect(JSON.stringify(state)).not.toContain('from-the-shell');
  });
});

describe('setRemoteConnection', () => {
  function jira(paths: BoardPaths) {
    connectRemote(paths, config(paths), {
      name: 'jira',
      provider: 'jira',
      connection: { site: 'https://acme.atlassian.net', project: 'PAY' },
    });
  }

  it('fills a gap and re-points a remote that mirrors nothing yet', () => {
    const paths = makeBoard('scrum', 'LP');
    jira(paths);
    setRemoteConnection(paths, config(paths), 'jira', { board: '12', project: 'OPS' });
    const connection = loadConfig(paths).config!.remotes!.jira!.connection;
    expect(connection.project).toBe('OPS');
    // A numeric id is written as a YAML number; the provider's schema reads it back as a string.
    expect(String(connection.board)).toBe('12');
  });

  it('will not re-point a remote that already mirrors documents', () => {
    const paths = makeBoard('scrum', 'LP');
    jira(paths);
    mirrorOne(paths, 'jira');
    const before = configText(paths);
    expect(() => setRemoteConnection(paths, config(paths), 'jira', { project: 'OPS' })).toThrow(
      /already mirrors 1 document, so project cannot change in place/,
    );
    expect(configText(paths)).toBe(before);
  });

  it('still corrects a conditional key on a mirrored remote — it says where sprints live, not issues', () => {
    const paths = makeBoard('scrum', 'LP');
    jira(paths);
    setRemoteConnection(paths, config(paths), 'jira', { board: '12' });
    mirrorOne(paths, 'jira');
    setRemoteConnection(paths, config(paths), 'jira', { board: '14' });
    // Written as a YAML number, the way Jira's own board id reads; the provider's
    // schema is what turns it back into a string, and core does not run it.
    expect(String(loadConfig(paths).config!.remotes!.jira!.connection.board)).toBe('14');
  });

  it('refuses a secret and refuses removing a required value', () => {
    const paths = makeBoard('scrum', 'LP');
    jira(paths);
    expect(() => setRemoteConnection(paths, config(paths), 'jira', { token: 't' })).toThrow(/is a credential/);
    expect(() => setRemoteConnection(paths, config(paths), 'jira', { site: '' })).toThrow(/site is required/);
  });

  it('never writes a switch as false — unticking restores the default instead', () => {
    // For Jira `tls_verify: false` is what turns certificate checking OFF. A
    // form must not be able to reach that by unticking a box.
    const paths = makeBoard('scrum', 'LP');
    jira(paths);
    setRemoteConnection(paths, config(paths), 'jira', { tls_verify: true });
    expect(configText(paths)).toContain('tls_verify: true');
    setRemoteConnection(paths, config(paths), 'jira', { tls_verify: false });
    expect(configText(paths)).not.toContain('tls_verify');
  });
});

describe('inspectRemoteConnection and applyInspectAnswers', () => {
  it('reports a provider with nothing to reconcile as reachable and ready, writing nothing', async () => {
    const paths = makeBoard('scrum', 'LP');
    connectRemote(paths, config(paths), { name: 'demo', provider: 'jsonfile', connection: {} });
    const before = configText(paths);

    const report = await inspectRemoteConnection(loadBoard(paths), 'demo', { apply: true });

    expect(report.reachability?.reachable).toBe(true);
    expect(report.stopped).toBe(false);
    expect(report.vocabulary).toBeUndefined();
    expect(report.choices).toEqual([]);
    expect(report.needed).toEqual([]);
    expect(report.written).toEqual([]);
    expect(configText(paths)).toBe(before);
  });

  it('refuses an answer naming a connection key the remote was never asked about', () => {
    // The answers writer takes free-form keys; without this a token could be
    // written into config.yml through it.
    const paths = makeBoard('scrum', 'LP');
    connectRemote(paths, config(paths), {
      name: 'jira',
      provider: 'jira',
      connection: { site: 'https://acme.atlassian.net', project: 'PAY' },
    });
    const before = configText(paths);
    expect(() => applyInspectAnswers(paths, config(paths), 'jira', { connection: { token: 'secret' } })).toThrow(
      /"token" is not a connection key the remote can be asked about/,
    );
    expect(configText(paths)).toBe(before);

    expect(applyInspectAnswers(paths, config(paths), 'jira', { connection: { board: '12' } })).toEqual([
      'connection.board: 12',
    ]);
  });
});
