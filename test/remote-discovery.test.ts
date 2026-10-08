import { afterEach, describe, expect, it, vi } from 'vitest';
import { jiraConnector } from '../src/remote/providers/jira/connector.js';
import { linearConnector } from '../src/remote/providers/linear/connector.js';
import { credentialStates, writeCredential } from '../src/remote/credentials.js';
import { addRemote, updateRemoteMapping } from '../src/remote/config-file.js';
import { corrections, reconcileMapping } from '../src/remote/reconcile.js';
import { loadConfig } from '../src/core/index.js';
import { lookupProvider } from '../src/remote/registry.js';
import { redactor } from '../src/remote/redact.js';
import { cleanupBoards, makeBoard } from './helpers.js';

/**
 * Discovery (LP-537): the two ends of `lpm remote setup` that touch the outside
 * world — `connector.vocabulary()`, which asks the remote what its own words
 * are, and `credentialStates`, which answers "do we have a credential yet"
 * without resolving (or printing) one.
 *
 * Both are driven offline: the Jira and Linear connectors ride `fetch`, so a
 * stub drives the real connector, and the credential reporter reads a board's
 * own files.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  redactor.clear();
});

afterEach(cleanupBoards);

/** A `fetch` stub that answers each URL fragment with a JSON body. */
function stubFetch(routes: Array<[fragment: string, body: unknown]>): { urls: string[] } {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    void init;
    for (const [fragment, body] of routes) {
      if (url.includes(fragment)) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
  });
  return { urls };
}

describe('jira connector.vocabulary', () => {
  const connection = {
    site: 'https://acme.atlassian.net',
    project: 'PAY',
    email: 'me@acme.com',
    token: 'api-token',
  };

  it("reports the project's issue types and the union of its statuses", async () => {
    // Jira answers statuses *per issue type*, so the project's statuses are the
    // union: a state only the Bug workflow has is still one this project has,
    // and a mapping naming it is correct.
    const { urls } = stubFetch([
      [
        '/rest/api/3/project/PAY/statuses',
        [
          { name: 'Story', statuses: [{ name: 'To Do' }, { name: 'In Progress' }, { name: 'Done' }] },
          { name: 'Bug', statuses: [{ name: 'To Do' }, { name: 'Triage' }, { name: 'Done' }] },
        ],
      ],
      [
        '/rest/api/3/project/PAY',
        { issueTypes: [{ name: 'Epic' }, { name: 'Story' }, { name: 'Sub-task', subtask: true }] },
      ],
    ]);

    const connector = jiraConnector(connection);
    const vocabulary = await connector.vocabulary!();

    expect(vocabulary.types).toEqual(['Epic', 'Story', 'Sub-task']);
    expect(vocabulary.statuses?.sort()).toEqual(['Done', 'In Progress', 'To Do', 'Triage']);
    expect(urls.some((url) => url.includes('/project/PAY/statuses'))).toBe(true);
  });

  it('caches both reads, so a setup run asks each question once', async () => {
    const { urls } = stubFetch([
      ['/rest/api/3/project/PAY/statuses', [{ name: 'Story', statuses: [{ name: 'Done' }] }]],
      ['/rest/api/3/project/PAY', { issueTypes: [{ name: 'Story' }] }],
    ]);
    const connector = jiraConnector(connection);
    await connector.vocabulary!();
    await connector.vocabulary!();
    expect(urls).toHaveLength(2);
  });

  it('survives a project whose statuses come back in an unexpected shape', async () => {
    // A permission-shaped answer, an empty body, a string where a list was
    // expected: report nothing rather than throwing in the middle of setup.
    stubFetch([
      ['/rest/api/3/project/PAY/statuses', { errorMessages: ['nope'] }],
      ['/rest/api/3/project/PAY', { issueTypes: [{ name: 'Story' }] }],
    ]);
    const connector = jiraConnector(connection);
    const vocabulary = await connector.vocabulary!();
    expect(vocabulary.statuses).toEqual([]);
    expect(vocabulary.types).toEqual(['Story']);
  });
});

describe('linear connector.vocabulary', () => {
  it('reports the team states and omits types entirely', async () => {
    // Linear has no issue types, so the key is absent rather than empty — the
    // difference the reconciler reads as "nothing to reconcile" instead of
    // "every mapped type is unresolved".
    stubFetch([
      [
        '/graphql',
        {
          data: {
            team: {
              states: {
                nodes: [
                  { id: '1', name: 'Backlog', type: 'backlog' },
                  { id: '2', name: 'In Progress', type: 'started' },
                  { id: '3', name: 'Done', type: 'completed' },
                ],
              },
            },
          },
        },
      ],
    ]);

    const connector = linearConnector({ team: 'ENG', api_key: 'lin_api_x' });
    const vocabulary = await connector.vocabulary!();
    expect(vocabulary.statuses).toEqual(['Backlog', 'In Progress', 'Done']);
    expect(vocabulary).not.toHaveProperty('types');
  });
});

describe('every provider that states a convention can also be asked', () => {
  it('pairs standardVocabulary with a connector that reports one', () => {
    // The two halves of LP-537 are useless apart: a convention nobody can check
    // is a guess, and a check nothing drafts against has nothing to correct. A
    // new provider that declares one must declare the other.
    for (const name of ['github', 'jira', 'linear', 'jsonfile']) {
      const provider = lookupProvider(name);
      if (provider.standardVocabulary === undefined) continue;
      const connector = provider.connector(
        // A connection that never gets used: the factory is lazy, and this only
        // asks whether the method exists.
        name === 'jira'
          ? { site: 'https://x.atlassian.net', project: 'P', email: 'e', token: 't' }
          : { team: 'ENG', api_key: 'k' },
        {},
      );
      expect(typeof connector.vocabulary).toBe('function');
    }
  });
});

describe('the setup spine, end to end and offline', () => {
  it("asks the project for its words and rewrites the draft to match them", async () => {
    // `lpm remote setup` is these four steps: draft (at `add` time), ask,
    // reconcile, write. Driving them in one test is what proves the pieces fit —
    // each is unit-tested apart, and the seam between them is where a mapping
    // that looks corrected but is not would hide.
    const paths = makeBoard('scrum', 'LP');
    addRemote(paths, {
      name: 'jira',
      provider: 'jira',
      connection: { site: 'https://acme.atlassian.net', project: 'PAY' },
    });

    // The convention the draft used.
    const drafted = loadConfig(paths).config!.remotes['jira']!.mapping as {
      types: Record<string, { remote: string }>;
      statuses: Record<string, { remote: string }>;
    };
    expect(drafted.types['sub_task']!.remote).toBe('Sub-task');
    expect(drafted.statuses['backlog']!.remote).toBe('To Do');

    // A project that renamed two of them and never had a third.
    stubFetch([
      [
        '/rest/api/3/project/PAY/statuses',
        [{ name: 'Story', statuses: [{ name: 'TODO' }, { name: 'In Progress' }, { name: 'Shipped' }] }],
      ],
      [
        '/rest/api/3/project/PAY',
        {
          issueTypes: [
            { name: 'Epic' },
            { name: 'Story' },
            { name: 'Bug' },
            { name: 'Task' },
            { name: 'Subtask', subtask: true },
          ],
        },
      ],
    ]);

    const connector = jiraConnector({
      site: 'https://acme.atlassian.net',
      project: 'PAY',
      email: 'me@acme.com',
      token: 'api-token',
    });
    const vocabulary = await connector.vocabulary!();

    const claims = {
      types: Object.fromEntries(
        Object.entries(drafted.types).map(([key, entry]) => [key, entry.remote]),
      ),
      statuses: Object.fromEntries(
        Object.entries(drafted.statuses).map(([key, entry]) => [key, entry.remote]),
      ),
    };
    const report = reconcileMapping(claims, vocabulary);

    // `Sub-task` → `Subtask` is the same word; `Done` is simply not there.
    expect(corrections(report.types)).toEqual({ sub_task: 'Subtask' });
    expect(corrections(report.statuses)).toEqual({ backlog: 'TODO', ready: 'TODO' });
    expect(
      report.statuses!.entries.filter((entry) => entry.verdict === 'unresolved').map((e) => e.boardKey),
    ).toEqual(['done']);

    updateRemoteMapping(paths, 'jira', {
      types: corrections(report.types),
      statuses: corrections(report.statuses),
    });

    const after = loadConfig(paths).config!.remotes['jira']!.mapping as {
      types: Record<string, { remote: string }>;
      statuses: Record<string, { remote: string; closed?: boolean }>;
    };
    expect(after.types['sub_task']).toEqual({ remote: 'Subtask' });
    expect(after.statuses['backlog']).toMatchObject({ remote: 'TODO' });
    // The word the project does not have is left exactly as it was, for a person
    // to answer — never dropped, which would leave the status unmapped and the
    // remote unopenable.
    expect(after.statuses['done']).toMatchObject({ remote: 'Done', closed: true });
    // And the entries nobody corrected still say what they said.
    expect(after.types['epic']).toEqual({ remote: 'Epic' });
  });
});

describe('credentialStates', () => {
  const secrets = { token: 'GITHUB_TOKEN' };

  it('reports a secret as missing when nothing holds one', () => {
    const paths = makeBoard();
    vi.stubEnv('GITHUB_TOKEN', '');
    const states = credentialStates('upstream', {}, secrets, paths);
    expect(states).toEqual([{ key: 'token', env: 'GITHUB_TOKEN' }]);
  });

  it('names the source when the conventional env var holds one', () => {
    const paths = makeBoard();
    vi.stubEnv('GITHUB_TOKEN', 'ghp_x');
    expect(credentialStates('upstream', {}, secrets, paths)[0]).toMatchObject({
      source: '$GITHUB_TOKEN',
    });
  });

  it('names the credentials file when login wrote one', () => {
    const paths = makeBoard();
    vi.stubEnv('GITHUB_TOKEN', '');
    writeCredential(paths, 'upstream', 'token', 'ghp_x');
    expect(credentialStates('upstream', {}, secrets, paths)[0]!.source).toContain(
      'credentials.json',
    );
  });

  it('follows a ${VAR} reference the config points at, and reports the name either way', () => {
    const paths = makeBoard();
    vi.stubEnv('MY_TOKEN', 'ghp_x');
    const found = credentialStates('upstream', { token: '${MY_TOKEN}' }, secrets, paths);
    expect(found[0]).toMatchObject({ reference: 'MY_TOKEN', source: '$MY_TOKEN' });

    vi.stubEnv('MY_TOKEN', '');
    const missing = credentialStates('upstream', { token: '${MY_TOKEN}' }, secrets, paths);
    expect(missing[0]).toEqual({ key: 'token', env: 'GITHUB_TOKEN', reference: 'MY_TOKEN' });
  });

  it('reports a literal secret in the config as unset, because the resolver refuses it', () => {
    // A token written into the committed config is the one mistake a shared repo
    // cannot recover from. Reporting it as "found" would tell a person they were
    // set up when the next sync is going to refuse.
    const paths = makeBoard();
    vi.stubEnv('GITHUB_TOKEN', '');
    expect(credentialStates('upstream', { token: 'ghp_literal' }, secrets, paths)).toEqual([
      { key: 'token', env: 'GITHUB_TOKEN' },
    ]);
  });

  it('never returns the value itself, only where it came from', () => {
    const paths = makeBoard();
    vi.stubEnv('GITHUB_TOKEN', 'ghp_secret_value');
    const states = credentialStates('upstream', {}, secrets, paths);
    expect(JSON.stringify(states)).not.toContain('ghp_secret_value');
  });
});
