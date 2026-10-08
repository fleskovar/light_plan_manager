import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/core/index.js';
import { BoardError } from '../src/core/errors.js';
import {
  addRemote,
  connectionFlags,
  connectionKeyNames,
  describeTarget,
  mappingKeyNames,
  lastSyncOf,
  removeRemote,
  secretKeyNames,
  summarizeRemotes,
} from '../src/remote/index.js';
import { lookupProvider } from '../src/remote/registry.js';
import { cleanupBoards, makeBoard } from './helpers.js';

/**
 * `config-file.ts` — reading and writing the `remotes:` block of config.yml in
 * place, plus the small read helpers the `lpm remote` listing uses. The CLI
 * suite drives the command end-to-end; this covers the module's own contract:
 * the provider schema is what validates a connection before anything is
 * written, comments and key order survive, and `rm` keeps state unless purged.
 */

afterAll(cleanupBoards);

describe('connectionKeyNames / secretKeyNames', () => {
  it('reads a provider schema for its connection keys and secret keys', () => {
    expect(connectionKeyNames(lookupProvider('github'))).toEqual(['repo', 'token', 'base_url']);
    expect(secretKeyNames(lookupProvider('github'))).toEqual(['token']);

    expect(connectionKeyNames(lookupProvider('jira'))).toEqual([
      'site',
      'project',
      'board',
      'email',
      'token',
      'tls_verify',
    ]);
    expect(secretKeyNames(lookupProvider('jira'))).toEqual(['email', 'token']);

    expect(connectionKeyNames(lookupProvider('linear'))).toEqual(['team', 'api_key', 'base_url']);
    expect(secretKeyNames(lookupProvider('linear'))).toEqual(['api_key']);
  });
});

describe('mappingKeyNames', () => {
  it('reads a provider schema for the mapping blocks it declares', () => {
    // The three every provider shares, plus whatever it holds natively.
    for (const name of ['github', 'jira', 'jsonfile', 'linear']) {
      expect(mappingKeyNames(lookupProvider(name))).toEqual(
        expect.arrayContaining(['types', 'statuses', 'attributes']),
      );
    }
    // The file tracker resolves no account and holds no period container, so it
    // declares neither key — which is what stops the scaffold drafting them.
    expect(mappingKeyNames(lookupProvider('jsonfile'))).toEqual([
      'types',
      'statuses',
      'attributes',
    ]);
    for (const name of ['github', 'jira', 'linear']) {
      expect(mappingKeyNames(lookupProvider(name))).toEqual(
        expect.arrayContaining(['accounts', 'periods']),
      );
    }
  });
});

describe('describeTarget', () => {
  it('names the one connection value that identifies where the issues live', () => {
    expect(describeTarget('github', { repo: 'acme/payments' })).toBe('acme/payments');
    expect(describeTarget('jira', { site: 'https://acme.atlassian.net', project: 'PAY' })).toBe(
      'PAY @ acme.atlassian.net',
    );
    expect(describeTarget('jira', { site: 'https://acme.atlassian.net/', project: 'PAY' })).toBe(
      'PAY @ acme.atlassian.net',
    );
    expect(describeTarget('linear', { team: 'ENG' })).toBe('ENG');
  });

  it('falls back to the provider name when the identifying key is absent or unknown', () => {
    expect(describeTarget('github', {})).toBe('github');
    expect(describeTarget('something_else', { repo: 'a/b' })).toBe('something_else');
  });
});

describe('addRemote', () => {
  it('validates the connection against the provider schema before writing', () => {
    const paths = makeBoard();
    let thrown: unknown;
    try {
      addRemote(paths, { name: 'upstream', provider: 'github', connection: { repo: 'nope' } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BoardError);
    expect((thrown as BoardError).message).toContain('not configured correctly');
    expect((thrown as BoardError).details.join('\n')).toContain('--repo');

    // Nothing was written: the config still has no remotes.
    const { config } = loadConfig(paths);
    expect(Object.keys(config!.remotes)).toEqual([]);
  });

  it('writes the remotes block, preserving the rest of the file and its comments', () => {
    const paths = makeBoard();
    const before = readFileSync(paths.configPath, 'utf8');

    const result = addRemote(paths, {
      name: 'upstream',
      provider: 'github',
      connection: { repo: 'acme/payments' },
    });
    expect(result).toMatchObject({
      name: 'upstream',
      provider: 'github',
      target: 'acme/payments',
      replaced: false,
      // GitHub's scaffold needs no live remote to draft cleanly: no native
      // types and a binary open/closed status are both conservative facts
      // `staticCapabilities` can state outright, so nothing is left as a
      // `TODO:` marker.
      markers: [],
    });

    const after = readFileSync(paths.configPath, 'utf8');
    // Comments and key order survive; the remotes block is appended.
    expect(after).toContain('# Kanban columns, in board order.');
    expect(after.indexOf('remotes:')).toBeGreaterThan(after.indexOf('issue_types:'));

    const { config, errors } = loadConfig(paths);
    expect(errors).toEqual([]);
    expect(Object.keys(config!.remotes)).toEqual(['upstream']);
    expect(config!.remotes['upstream']).toMatchObject({
      provider: 'github',
      on_delete: 'unlink',
      conflict: 'manual',
      connection: { repo: 'acme/payments' },
    });

    // The original config was not re-formatted away: a comment the template
    // writes is still there in full.
    expect(after).toContain(before.split('\n').find((line) => line.includes('Kanban columns'))!);
  });

  it('refuses a duplicate name unless force', () => {
    const paths = makeBoard();
    addRemote(paths, { name: 'upstream', provider: 'github', connection: { repo: 'acme/payments' } });

    expect(() =>
      addRemote(paths, { name: 'upstream', provider: 'github', connection: { repo: 'other/repo' } }),
    ).toThrowError(/already exists/);

    const replaced = addRemote(paths, {
      name: 'upstream',
      provider: 'github',
      connection: { repo: 'other/repo' },
      force: true,
    });
    expect(replaced.replaced).toBe(true);
    expect(readFileSync(paths.configPath, 'utf8')).toContain('repo: other/repo');
  });
});

describe('removeRemote', () => {
  it('drops the declaration but keeps the per-remote state, unless purge', () => {
    const paths = makeBoard();
    addRemote(paths, { name: 'upstream', provider: 'github', connection: { repo: 'acme/payments' } });

    const stateDir = path.join(paths.remotesDir, 'upstream');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, 'links.json'), '{"version":1}\n');

    const kept = removeRemote(paths, { name: 'upstream' });
    expect(kept.purged).toBe(false);
    expect(existsSync(path.join(stateDir, 'links.json'))).toBe(true);
    expect(Object.keys(loadConfig(paths).config!.remotes)).toEqual([]);

    // Re-add and purge this time.
    addRemote(paths, { name: 'upstream', provider: 'github', connection: { repo: 'acme/payments' } });
    const purged = removeRemote(paths, { name: 'upstream', purge: true });
    expect(purged.purged).toBe(true);
    expect(existsSync(stateDir)).toBe(false);
  });

  it('refuses a remote that is not declared', () => {
    const paths = makeBoard();
    expect(() => removeRemote(paths, { name: 'bogus' })).toThrowError(/No remote named "bogus"/);
  });
});

describe('lastSyncOf / summarizeRemotes', () => {
  it('reports the most recent link syncedAt, and "never" is undefined', () => {
    const paths = makeBoard();
    const stateDir = path.join(paths.remotesDir, 'upstream');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, 'links.json'),
      JSON.stringify({
        version: 1,
        cursor: null,
        links: {
          'LP-1': { remoteId: '1', syncedAt: '2026-08-01T00:00:00.000Z' },
          'LP-2': { remoteId: '2', syncedAt: '2026-08-15T00:00:00.000Z' },
        },
      }),
    );

    expect(lastSyncOf(paths, 'upstream')).toBe('2026-08-15T00:00:00.000Z');
    expect(lastSyncOf(paths, 'never_synced')).toBeUndefined();

    // A malformed store is "never", not a crash.
    writeFileSync(path.join(paths.remotesDir, 'upstream', 'links.json'), 'not json');
    expect(lastSyncOf(paths, 'upstream')).toBeUndefined();
  });

  it('fills in a connection key the provider can name for itself', () => {
    const paths = makeBoard();
    // No `file`: the jsonfile tracker is a path light-plan owns, so making a
    // person invent one was asking them to name something the tool can name.
    const result = addRemote(paths, { name: 'demo', provider: 'jsonfile', connection: {} });
    expect(result.target).toBe('.lpm/remotes/demo/tracker.json');

    const { config, errors } = loadConfig(paths);
    expect(errors).toEqual([]);
    expect(config!.remotes['demo']!.connection).toEqual({
      file: '.lpm/remotes/demo/tracker.json',
    });
  });

  it('lets an explicitly passed connection key win over the default', () => {
    const paths = makeBoard();
    const result = addRemote(paths, {
      name: 'demo',
      provider: 'jsonfile',
      connection: { file: 'somewhere/else.json' },
    });
    expect(result.target).toBe('somewhere/else.json');
  });

  it('reports `--file` as optional for jsonfile, since the provider defaults it', () => {
    const file = connectionFlags(lookupProvider('jsonfile')).find((flag) => flag.name === 'file');
    expect(file).toMatchObject({ name: 'file', type: 'string', required: false });
    // A key nobody can guess stays required — GitHub's repo names somebody
    // else's system.
    const repo = connectionFlags(lookupProvider('github')).find((flag) => flag.name === 'repo');
    expect(repo).toMatchObject({ name: 'repo', required: true });
  });

  it('drafts a jsonfile mapping with nothing left to fill in', () => {
    const paths = makeBoard();
    const result = addRemote(paths, { name: 'demo', provider: 'jsonfile', connection: {} });
    // The tracker file is ours, so its `type` and `status` strings are
    // whatever we write — there is no remote vocabulary to ask about.
    expect(result.markers).toEqual([]);

    const { config } = loadConfig(paths);
    const mapping = config!.remotes['demo']!.mapping as {
      types: Record<string, { remote: string[] }>;
      statuses: Record<string, { remote: string | string[]; closed?: boolean }>;
    };
    // Types read exactly like statuses now: one `remote` list, no second key
    // repeating the carrier the provider already decides.
    expect(mapping.types['user_story']).toEqual({ remote: 'user_story' });
    expect(mapping.statuses['in_progress']).toMatchObject({ remote: 'In Progress' });
    expect(mapping.statuses['done']).toMatchObject({ remote: 'Done', closed: true });

    // ...and nothing the provider would strip. The board declares sprints and a
    // roster, so both blocks are answerable — but this provider's schema has no
    // `accounts` and no `periods` key, so writing either would state a mapping
    // that can never take effect. An assignee and a sprint ride the managed
    // block here; a `periods: { container: sprint }` would claim a native
    // container the file tracker has never had.
    expect(mapping).not.toHaveProperty('accounts');
    expect(mapping).not.toHaveProperty('periods');
  });

  it('drafts accounts and periods for a provider whose schema declares them', () => {
    const paths = makeBoard();
    addRemote(paths, {
      name: 'upstream',
      provider: 'github',
      connection: { repo: 'acme/payments' },
    });
    const { config } = loadConfig(paths);
    const mapping = config!.remotes['upstream']!.mapping;
    expect(mapping).toHaveProperty('accounts');
    expect(mapping).toHaveProperty('periods');
  });

  it("drafts the platform's conventional vocabulary where only the platform names it", () => {
    const paths = makeBoard();
    // Jira's issue types and workflow statuses are the project's own, so the
    // scaffold cannot *know* them — but it knows what they conventionally are,
    // and a declaration that opens and syncs beats fourteen `TODO:` lines that
    // have to be answered in YAML before anything can be tried. A convention
    // that is wrong for this project is corrected by `lpm remote setup`, and
    // refused by the push preflight before any write.
    const result = addRemote(paths, {
      name: 'jira',
      provider: 'jira',
      connection: { site: 'https://acme.atlassian.net', project: 'PAY' },
    });
    expect(result.markers).toEqual([]);

    const { config } = loadConfig(paths);
    const mapping = config!.remotes['jira']!.mapping as {
      types: Record<string, { remote: string }>;
      statuses: Record<string, { remote: string; closed?: boolean }>;
    };
    // The board is the Scrum template: five issue levels onto Jira's three.
    expect(mapping.types['epic']).toEqual({ remote: 'Epic' });
    expect(mapping.types['user_story']).toEqual({ remote: 'Story' });
    expect(mapping.types['bug']).toEqual({ remote: 'Bug' });
    expect(mapping.types['sub_task']).toEqual({ remote: 'Sub-task' });
    expect(mapping.statuses['backlog']).toMatchObject({ remote: 'To Do' });
    expect(mapping.statuses['in_progress']).toMatchObject({ remote: 'In Progress' });
    expect(mapping.statuses['done']).toMatchObject({ remote: 'Done', closed: true });
  });

  it('reports the connection it wrote, so a caller can say which credentials are missing', () => {
    const paths = makeBoard();
    const result = addRemote(paths, {
      name: 'jira',
      provider: 'jira',
      connection: { site: 'https://acme.atlassian.net', project: 'PAY' },
    });
    // Never a secret: a secret key is not an `add` flag and is not written here.
    expect(result.connection).toEqual({ site: 'https://acme.atlassian.net', project: 'PAY' });
  });

  it('summarizes every declared remote in sorted-name order', () => {
    const paths = makeBoard();
    addRemote(paths, { name: 'zeta', provider: 'github', connection: { repo: 'z/repo' }, scope: 'LP-1' });
    addRemote(paths, { name: 'alpha', provider: 'linear', connection: { team: 'ENG' }, scope: 'LP-2' });

    const { config } = loadConfig(paths);
    const summaries = summarizeRemotes(paths, config!);
    expect(summaries.map((remote) => remote.name)).toEqual(['alpha', 'zeta']);
    expect(summaries[0]).toMatchObject({ provider: 'linear', direction: 'both', target: 'ENG' });
    expect(summaries[1]).toMatchObject({ provider: 'github', target: 'z/repo' });
    expect(summaries.every((remote) => remote.lastSync === undefined)).toBe(true);
  });
});
