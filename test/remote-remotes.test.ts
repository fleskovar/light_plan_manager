import { describe, expect, it } from 'vitest';
import { BoardError } from '../src/core/errors.js';
import { parseConfigText } from '../src/core/index.js';
import { openRemote } from '../src/remote/remotes.js';

/**
 * `openRemote` — the one place a raw remote declaration becomes a validated,
 * typed one (LP-259). Core validated the frame; the provider's own schema
 * validates `connection` and `mapping` here.
 */

const MINIMAL = `
version: 1
key_prefix: LP
statuses:
  - id: todo
    label: To Do
  - id: done
    label: Done
hierarchy: [task]
issue_types:
  task:
    label: Task
`;

function configWith(remotes: string) {
  const { config, errors } = parseConfigText(`${MINIMAL}${remotes}`);
  expect(errors).toEqual([]);
  return config!;
}

function configWithBase(base: string, remotes: string) {
  const { config, errors } = parseConfigText(`${base}${remotes}`);
  expect(errors).toEqual([]);
  return config!;
}

// A board with an increment › sprint period hierarchy.
const WITH_PERIODS = `
period_prefix: TL
period_hierarchy:
  - increment
  - sprint
period_types:
  increment:
    label: Increment
  sprint:
    label: Sprint
`;

// A github remote with no period mapping.
const REMOTE_NO_PERIODS = `
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    connection:
      repo: acme/payments
    mapping:
      statuses: { todo: Todo, done: Done }
`;

const GITHUB_REMOTE = `
remotes:
  upstream:
    provider: github
    scope: LP-2
    direction: pull
    on_delete: unlink
    conflict: manual
    connection:
      repo: acme/payments
    mapping:
      types: { task: { labels: [task] } }
      statuses: { todo: Todo, done: Done }
`;

describe('openRemote', () => {
  it('validates connection and mapping against the provider schema', () => {
    const opened = openRemote(configWith(GITHUB_REMOTE), 'upstream');
    expect(opened.provider).toBeDefined();
    expect(opened.connection).toEqual({ repo: 'acme/payments' });
    expect(opened.mapping).toEqual({
      types: { task: { remote: 'task' } },
      statuses: { todo: { remote: ['Todo'] }, done: { remote: ['Done'] } },
      attributes: {},
      fields: {},
      status_precedence: 'issue',
    });
  });

  it('fills in the provider schema defaults, so the raw block is gone', () => {
    const opened = openRemote(
      configWith(`
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    connection:
      repo: acme/payments
    mapping:
      statuses: { todo: Todo, done: Done }
`),
      'upstream',
    );
    // The `types`, `attributes` and `fields` sub-maps exist only because the
    // provider schema ran — the raw declaration had no such keys.  `statuses`
    // is normalised from the shorthand to the object form the engine reads.
    expect(opened.mapping).toEqual({
      types: {},
      statuses: { todo: { remote: ['Todo'] }, done: { remote: ['Done'] } },
      attributes: {},
      fields: {},
      status_precedence: 'issue',
    });
  });

  it('carries the frame core validated (scope, direction, policies)', () => {
    const opened = openRemote(configWith(GITHUB_REMOTE), 'upstream');
    expect(opened.name).toBe('upstream');
    expect(opened.scope).toBe('LP-2');
    expect(opened.direction).toBe('pull');
    expect(opened.on_delete).toBe('unlink');
    expect(opened.conflict).toBe('manual');
    expect(opened.encoding).toBe('block');
    expect(opened.fields).toEqual({});
  });

  it('carries per-field owners flattened, ready for the policy resolution', () => {
    const opened = openRemote(
      configWith(`
remotes:
  upstream:
    provider: github
    scope: LP-2
    direction: pull
    on_delete: unlink
    conflict: manual
    fields:
      status:
        owner: remote
    connection:
      repo: acme/payments
    mapping:
      statuses: { todo: Todo, done: Done }
`),
      'upstream',
    );
    expect(opened.fields).toEqual({ status: 'remote' });
  });

  it('hands the provider its validated connection, never raw YAML', () => {
    const opened = openRemote(configWith(GITHUB_REMOTE), 'upstream');
    const connector = opened.provider.connector(opened.connection, opened.mapping);
    expect(connector.name).toBe('github');
  });

  it('rejects a remote with a missing required key, naming remote, key and path', () => {
    const config = configWith(`
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
`);
    let caught: unknown;
    try {
      openRemote(config, 'upstream');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BoardError);
    const error = caught as BoardError;
    expect(error.message).toMatch(/"upstream"/);
    expect(error.message).toMatch(/github/);
    expect(error.details.join('\n')).toMatch(/remotes\.upstream\.connection\.repo/);
    expect(error.details.join('\n')).toMatch(/repo is required/);
  });

  it('rejects a malformed value with the config path under remotes', () => {
    const config = configWith(`
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    connection:
      repo: not-a-repo
`);
    let caught: unknown;
    try {
      openRemote(config, 'upstream');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BoardError);
    const error = caught as BoardError;
    expect(error.details.join('\n')).toMatch(/remotes\.upstream\.connection\.repo/);
    expect(error.details.join('\n')).toMatch(/owner\/repo/);
  });

  it('throws a BoardError naming the remote when the name is not declared', () => {
    const config = configWith(GITHUB_REMOTE);
    let caught: unknown;
    try {
      openRemote(config, 'missing');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BoardError);
    expect((caught as BoardError).message).toBe('No remote named "missing"');
    expect((caught as BoardError).details).toEqual(['Declared remotes: upstream']);
  });

  it('rejects an unknown provider where the remote is opened', () => {
    const config = configWith(`
remotes:
  upstream:
    provider: gitlab
    on_delete: unlink
    conflict: manual
`);
    let caught: unknown;
    try {
      openRemote(config, 'upstream');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BoardError);
    expect((caught as BoardError).message).toBe('Unknown provider "gitlab"');
  });

  it('refuses to open when a board status has no remote counterpart', () => {
    const config = configWith(`
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    connection:
      repo: acme/payments
    mapping:
      statuses: { todo: Todo }
`);
    let caught: unknown;
    try {
      openRemote(config, 'upstream');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BoardError);
    const error = caught as BoardError;
    expect(error.message).toMatch(/cannot be opened/);
    expect(error.details).toEqual(['remotes.upstream.mapping.statuses: status "done" is not mapped']);
  });

  it('accepts the object form of a status mapping', () => {
    const opened = openRemote(
      configWith(`
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    connection:
      repo: acme/payments
    mapping:
      statuses:
        todo: Todo
        done: { remote: [Done, "Won't Fix"], push: Done, closed: true }
`),
      'upstream',
    );
    expect(opened.mapping['statuses']).toEqual({
      todo: { remote: ['Todo'] },
      done: { remote: ['Done', "Won't Fix"], push: 'Done', closed: true },
    });
  });

  it('carries the account mapping through, and defaults it away when absent', () => {
    const opened = openRemote(
      configWith(`
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    connection:
      repo: acme/payments
    mapping:
      statuses: { todo: Todo, done: Done }
      accounts: { via: github }
`),
      'upstream',
    );
    expect(opened.mapping['accounts']).toEqual({ via: 'github' });

    const without = openRemote(
      configWith(`
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    connection:
      repo: acme/payments
    mapping:
      statuses: { todo: Todo, done: Done }
`),
      'upstream',
    );
    expect(without.mapping['accounts']).toBeUndefined();
  });

  it('refuses to open when the board uses periods but maps no period level', () => {
    const config = configWithBase(MINIMAL + WITH_PERIODS, REMOTE_NO_PERIODS);
    let caught: unknown;
    try {
      openRemote(config, 'upstream');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BoardError);
    const error = caught as BoardError;
    expect(error.message).toMatch(/cannot be opened/);
    expect(error.details).toEqual([
      'remotes.upstream.mapping.periods: set "container" to the period type that maps to the remote\'s container, or write `periods: milestones` / `periods: iteration`',
    ]);
  });

  it('refuses to open when the period container names no period type', () => {
    const config = configWithBase(
      MINIMAL + WITH_PERIODS,
      `
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    connection:
      repo: acme/payments
    mapping:
      statuses: { todo: Todo, done: Done }
      periods: { container: quarter }
`,
    );
    let caught: unknown;
    try {
      openRemote(config, 'upstream');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BoardError);
    const error = caught as BoardError;
    expect(error.details.join('\n')).toContain('remotes.upstream.mapping.periods.container');
    expect(error.details.join('\n')).toContain('not a declared period type');
  });

  it('opens a board with periods when the container level is mapped', () => {
    const opened = openRemote(
      configWithBase(
        MINIMAL + WITH_PERIODS,
        `
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    connection:
      repo: acme/payments
    mapping:
      statuses: { todo: Todo, done: Done }
      periods: { container: sprint }
`,
      ),
      'upstream',
    );
    expect(opened.mapping['periods']).toEqual({ container: 'sprint', carrier: 'milestones' });
  });

  it('resolves the shorthand carrier to the deepest level, and validates the iteration field', () => {
    const opened = openRemote(
      configWithBase(
        MINIMAL + WITH_PERIODS,
        `
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    connection:
      repo: acme/payments
    mapping:
      statuses: { todo: Todo, done: Done }
      periods: iteration
      fields: { period: Sprint }
`,
      ),
      'upstream',
    );
    expect(opened.mapping['periods']).toEqual({ container: 'sprint', carrier: 'iteration' });
  });

  it('refuses the iteration carrier with no Project iteration field', () => {
    let caught: unknown;
    try {
      openRemote(
        configWithBase(
          MINIMAL + WITH_PERIODS,
          `
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    connection:
      repo: acme/payments
    mapping:
      statuses: { todo: Todo, done: Done }
      periods: iteration
`,
        ),
        'upstream',
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BoardError);
    expect((caught as BoardError).details.join('\n')).toContain(
      'remotes.upstream.mapping.fields.period',
    );
  });

  it('requires no period mapping on a board with no periods', () => {
    // The fourth criterion: a board without a timeline opens with no `periods`
    // block and nothing about it is required.
    const opened = openRemote(configWith(REMOTE_NO_PERIODS), 'upstream');
    expect(opened.mapping['periods']).toBeUndefined();
  });
});
