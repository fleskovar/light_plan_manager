import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createIssue, type LoadedBoard, type Problem } from '../src/core/index.js';
import { emptyCapabilities } from '../src/remote/capabilities.js';
import { checkRemoteConfiguration, fixOrphanedLinks } from '../src/remote/check.js';
import { loadLinkStore, saveLinkStore, setLink, setTombstone } from '../src/remote/links.js';
import type { Provider } from '../src/remote/provider.js';
import { providers } from '../src/remote/registry.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterAll(cleanupBoards);

const messages = (problems: Problem[]): string => problems.map((p) => p.message).join('\n');

/** A blank board (one task), plus a `remotes:` block appended to its config. */
function boardWith(remotes: string): LoadedBoard {
  const paths = makeBoard('blank', 'LP');
  createIssue(reload(paths), { type: 'task', title: 'Do the thing' });
  writeFileSync(paths.configPath, `${readFileSync(paths.configPath, 'utf8')}\n${remotes}\n`, 'utf8');
  return reload(paths);
}

/** A fully valid github remote for the blank board's todo/doing/done statuses. */
const GITHUB = `
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    connection:
      repo: acme/payments
    mapping:
      statuses: { todo: Todo, doing: Doing, done: { remote: Done, closed: true } }
`;

/** The same remote with `done` left unclosed — a closedness mismatch. */
const GITHUB_OPEN_DONE = `
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    connection:
      repo: acme/payments
    mapping:
      statuses: { todo: Todo, doing: Doing, done: Done }
`;

const CONFIG_PATH = '.lpm/config.yml';

describe('checkRemoteConfiguration', () => {
  it('is silent when the board declares no remotes', () => {
    const paths = makeBoard('blank', 'LP');
    createIssue(reload(paths), { type: 'task', title: 'Do the thing' });
    expect(checkRemoteConfiguration(reload(paths))).toEqual([]);
  });

  it('is silent on a fully valid remote', () => {
    expect(checkRemoteConfiguration(boardWith(GITHUB))).toEqual([]);
  });

  it('warns when a terminal status is not marked closed on the remote', () => {
    const problems = checkRemoteConfiguration(boardWith(GITHUB_OPEN_DONE));
    const mismatch = problems.find((p) => p.message.includes('mapping.statuses.done'));
    expect(mismatch).toBeDefined();
    expect(mismatch!.level).toBe('warn');
    expect(mismatch!.message).toBe(
      'remotes.upstream.mapping.statuses.done: status is terminal on the board but not marked closed on the remote',
    );
  });

  it('warns when a non-terminal status is marked closed on the remote', () => {
    const problems = checkRemoteConfiguration(
      boardWith(`
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    connection:
      repo: acme/payments
    mapping:
      statuses:
        todo: { remote: Todo, closed: true }
        doing: Doing
        done: { remote: Done, closed: true }
`),
    );
    const mismatch = problems.find((p) => p.message.includes('mapping.statuses.todo'));
    expect(mismatch).toBeDefined();
    expect(mismatch!.level).toBe('warn');
    expect(mismatch!.message).toBe(
      'remotes.upstream.mapping.statuses.todo: status is marked closed on the remote but not terminal on the board',
    );
  });

  it('reports an unknown provider against the config path', () => {
    const problems = checkRemoteConfiguration(
      boardWith(`
remotes:
  upstream:
    provider: gitlab
    on_delete: unlink
    conflict: manual
`),
    );
    const problem = problems.find((p) => p.message.includes('provider'));
    expect(problem).toBeDefined();
    expect(problem!.level).toBe('error');
    expect(problem!.path).toBe(CONFIG_PATH);
    expect(problem!.message).toBe('remotes.upstream.provider: unknown provider "gitlab"');
  });

  it('reports a scope id that no longer names an issue', () => {
    const problems = checkRemoteConfiguration(
      boardWith(`
remotes:
  upstream:
    provider: github
    scope: LP-999
    on_delete: unlink
    conflict: manual
    connection:
      repo: acme/payments
    mapping:
      statuses: { todo: Todo, doing: Doing, done: { remote: Done, closed: true } }
`),
    );
    const problem = problems.find((p) => p.message.includes('scope'));
    expect(problem).toBeDefined();
    expect(problem!.level).toBe('error');
    expect(problem!.path).toBe(CONFIG_PATH);
    expect(problem!.message).toBe(
      'remotes.upstream.scope: scope "LP-999" does not name an existing issue',
    );
  });

  it('reports every status the mapping does not carry', () => {
    const problems = checkRemoteConfiguration(
      boardWith(`
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    connection:
      repo: acme/payments
    mapping:
      statuses: { todo: Todo }
`),
    );
    const text = messages(problems);
    expect(text).toContain('remotes.upstream.mapping.statuses: status "doing" is not mapped');
    expect(text).toContain('remotes.upstream.mapping.statuses: status "done" is not mapped');
    expect(text).not.toContain('status "todo" is not mapped');
  });

  it('reports a mapping key naming an attribute no type declares', () => {
    const problems = checkRemoteConfiguration(
      boardWith(`
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    connection:
      repo: acme/payments
    mapping:
      statuses: { todo: Todo, doing: Doing, done: { remote: Done, closed: true } }
      attributes: { story_points: Estimate }
`),
    );
    expect(messages(problems)).toContain(
      'remotes.upstream.mapping.attributes.story_points: no type declares attribute "story_points"',
    );
  });

  it('reports an effort mapping naming an attribute no type declares (LP-333)', () => {
    const problems = checkRemoteConfiguration(
      boardWith(`
remotes:
  upstream:
    provider: linear
    on_delete: unlink
    conflict: manual
    connection:
      team: ENG
    mapping:
      statuses: { todo: Todo, doing: Doing, done: { remote: Done, closed: true } }
      effort: { attribute: story_points }
`),
    );
    expect(messages(problems)).toContain(
      'remotes.upstream.mapping.effort.attribute: no type declares attribute "story_points"',
    );
  });

  it('is silent on a linear effort mapping that names the board effort attribute', () => {
    const paths = makeBoard('scrum', 'LP');
    writeFileSync(
      paths.configPath,
      `${readFileSync(paths.configPath, 'utf8')}
remotes:
  upstream:
    provider: linear
    on_delete: unlink
    conflict: manual
    connection:
      team: ENG
    mapping:
      statuses: { backlog: Backlog, ready: Ready, in_progress: "In Progress", in_review: "In Review", done: { remote: Done, closed: true } }
      effort: { attribute: story_points }
      periods: { container: sprint }
`,
      'utf8',
    );
    expect(checkRemoteConfiguration(reload(paths))).toEqual([]);
  });

  it('warns when a linear effort mapping names an attribute that is not the board effort attribute', () => {
    const paths = makeBoard('scrum', 'LP');
    writeFileSync(
      paths.configPath,
      `${readFileSync(paths.configPath, 'utf8')}
remotes:
  upstream:
    provider: linear
    on_delete: unlink
    conflict: manual
    connection:
      team: ENG
    mapping:
      statuses: { backlog: Backlog, ready: Ready, in_progress: "In Progress", in_review: "In Review", done: { remote: Done, closed: true } }
      effort: { attribute: priority }
      periods: { container: sprint }
`,
      'utf8',
    );
    expect(messages(checkRemoteConfiguration(reload(paths)))).toContain(
      'remotes.upstream.mapping.effort.attribute: "priority" is not the board\'s effort attribute ("story_points")',
    );
  });

  it('is silent on an account mapping whose via names a string resource attribute', () => {
    const problems = checkRemoteConfiguration(
      boardWith(`
resource_prefix: RS
resource_hierarchy:
  - [person]
resource_types:
  person:
    label: Person
    attributes:
      github:
        type: string
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    connection:
      repo: acme/payments
    mapping:
      statuses: { todo: Todo, doing: Doing, done: { remote: Done, closed: true } }
      accounts: { via: github }
`),
    );
    expect(messages(problems)).not.toContain('mapping.accounts');
  });

  it('reports an account via naming no resource attribute', () => {
    const problems = checkRemoteConfiguration(
      boardWith(`
resource_prefix: RS
resource_hierarchy:
  - [person]
resource_types:
  person:
    label: Person
    attributes:
      github:
        type: string
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    connection:
      repo: acme/payments
    mapping:
      statuses: { todo: Todo, doing: Doing, done: { remote: Done, closed: true } }
      accounts: { via: handle }
`),
    );
    expect(messages(problems)).toContain(
      'remotes.upstream.mapping.accounts.via: no resource type declares attribute "handle"',
    );
  });

  it('reports an account via naming a non-string resource attribute', () => {
    const problems = checkRemoteConfiguration(
      boardWith(`
resource_prefix: RS
resource_hierarchy:
  - [person]
resource_types:
  person:
    label: Person
    attributes:
      level:
        type: enum
        values: [junior, senior]
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    connection:
      repo: acme/payments
    mapping:
      statuses: { todo: Todo, doing: Doing, done: { remote: Done, closed: true } }
      accounts: { via: level }
`),
    );
    expect(messages(problems)).toContain(
      'remotes.upstream.mapping.accounts.via: attribute "level" is enum, not string — an account must be a string',
    );
  });

  it('reports a missing required connection key from the provider schema, offline', () => {
    const problems = checkRemoteConfiguration(
      boardWith(`
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
`),
    );
    expect(messages(problems)).toContain(
      'remotes.upstream.connection.repo: connection.repo is required',
    );
  });

  it('reports a literal token in the committed config as an error (LP-295)', () => {
    const problems = checkRemoteConfiguration(
      boardWith(`
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    connection:
      repo: acme/payments
      token: ghp_committedSecret
    mapping:
      statuses: { todo: Todo, doing: Doing, done: { remote: Done, closed: true } }
`),
    );
    const problem = problems.find((p) => p.message.includes('connection.token'));
    expect(problem).toBeDefined();
    expect(problem!.level).toBe('error');
    expect(problem!.path).toBe(CONFIG_PATH);
    expect(problem!.message).toBe(
      'remotes.upstream.connection.token: a credential must not be written literally in config.yml — use ${VAR} or lpm remote login',
    );
  });

  it('accepts a ${VAR} reference in the connection as not literal', () => {
    const problems = checkRemoteConfiguration(
      boardWith(`
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    connection:
      repo: acme/payments
      token: \${GITHUB_TOKEN}
    mapping:
      statuses: { todo: Todo, doing: Doing, done: { remote: Done, closed: true } }
`),
    );
    expect(messages(problems)).not.toContain('connection.token');
  });

  it('reports a board with periods but no period mapping as unopenable', () => {
    const paths = makeBoard('scrum', 'LP');
    writeFileSync(
      paths.configPath,
      `${readFileSync(paths.configPath, 'utf8')}\nremotes:\n  upstream:\n    provider: github\n    on_delete: unlink\n    conflict: manual\n    connection:\n      repo: acme/payments\n    mapping:\n      statuses: { backlog: Backlog, ready: Ready, in_progress: In Progress, in_review: In Review, done: { remote: Done, closed: true } }\n`,
      'utf8',
    );
    const problems = checkRemoteConfiguration(reload(paths));
    expect(messages(problems)).toContain('remotes.upstream.mapping.periods');
  });

  it('warns on a period mapping declared for a board with no periods', () => {
    const problems = checkRemoteConfiguration(
      boardWith(`
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    connection:
      repo: acme/payments
    mapping:
      statuses: { todo: Todo, doing: Doing, done: { remote: Done, closed: true } }
      periods: { container: sprint }
`),
    );
    expect(messages(problems)).toContain(
      'remotes.upstream.mapping.periods: the board declares no periods, so this mapping does nothing',
    );
  });

  it('warns when two board statuses share one remote state', () => {
    // A board with more columns than the platform has states necessarily folds
    // two onto one — Jira's default workflow has three. The push stays faithful;
    // what is lost is the way home, because a pull reading that state cannot
    // tell which board status it meant. A warning rather than an error: this is
    // the ordinary outcome of mapping five columns onto three, and it is what
    // `lpm remote add` now drafts for Jira.
    const problems = checkRemoteConfiguration(
      boardWith(`
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    connection:
      repo: acme/payments
    mapping:
      statuses: { todo: Open, doing: Open, done: { remote: Done, closed: true } }
`),
    );
    expect(messages(problems)).toContain(
      'remotes.upstream.mapping.statuses: "Open" is the remote state for doing and todo',
    );
    expect(problems.every((problem) => problem.level === 'warn')).toBe(true);
  });

  it('is silent when every board status has a remote state of its own', () => {
    const problems = checkRemoteConfiguration(boardWith(GITHUB));
    expect(messages(problems)).not.toContain('is the remote state for');
  });

  it('warns on a mapping block the provider schema does not declare', () => {
    // The file tracker holds no period container and resolves no account, so
    // its schema declares neither key and strips both on the way in. A block
    // written here — by hand, or by a scaffold that drafted every provider the
    // same — states a mapping that can never fire, and reads as a decision.
    const problems = checkRemoteConfiguration(
      boardWith(`
remotes:
  demo:
    provider: jsonfile
    on_delete: unlink
    conflict: manual
    connection:
      file: .lpm/remotes/demo/tracker.json
    mapping:
      statuses: { todo: Todo, doing: Doing, done: { remote: Done, closed: true } }
      periods: { container: sprint }
      accounts: { via: email }
`),
    );
    expect(messages(problems)).toContain(
      'remotes.demo.mapping.periods: provider "jsonfile" has no "periods" mapping',
    );
    expect(messages(problems)).toContain(
      'remotes.demo.mapping.accounts: provider "jsonfile" has no "accounts" mapping',
    );
    // Warnings only: the remote still opens and still syncs.
    expect(problems.every((problem) => problem.level === 'warn')).toBe(true);
  });

  it('is silent on a jsonfile remote carrying only the blocks it declares', () => {
    const problems = checkRemoteConfiguration(
      boardWith(`
remotes:
  demo:
    provider: jsonfile
    on_delete: unlink
    conflict: manual
    connection:
      file: .lpm/remotes/demo/tracker.json
    mapping:
      types: { task: { remote: task } }
      statuses: { todo: Todo, doing: Doing, done: { remote: Done, closed: true } }
      attributes: {}
`),
    );
    expect(problems).toEqual([]);
  });

  it('reports a missing credential without building a connector', () => {
    const fake: Provider = {
      config: z.object({
        connection: z.object({
          token: z.string({ error: 'connection.token is required' }),
        }),
        mapping: z.object({}),
      }),
      capabilities: emptyCapabilities(),
      translator: {
        describeRequest: () => ({
          request: { kind: 'create' as const },
          problems: [],
          resourceGaps: [],
          periodGaps: [],
        }),
        fieldsFromRecord: () => ({ patch: {}, problems: [], unknownAccounts: [] }),
      },
      connector: () => {
        throw new Error('the check must never build a connector');
      },
    };
    providers['fakecred'] = fake;
    try {
      const problems = checkRemoteConfiguration(
        boardWith(`
remotes:
  upstream:
    provider: fakecred
    on_delete: unlink
    conflict: manual
`),
      );
      expect(messages(problems)).toContain(
        'remotes.upstream.connection.token: connection.token is required',
      );
    } finally {
      delete providers['fakecred'];
    }
  });

  it('reports an orphaned link as a fixable warning, and --fix prunes it', () => {
    const board = boardWith(GITHUB);
    const store = loadLinkStore(board.paths, 'upstream');
    setLink(store, 'LP-999', {
      remoteId: 'I_kwDOA1',
      remoteKey: 'acme/payments#1',
      remoteUrl: 'https://github.com/acme/payments/issues/1',
      syncedAt: '2026-09-04T11:19:58Z',
      remoteRev: '2026-09-04T11:19:57Z',
    });
    saveLinkStore(board.paths, 'upstream', store);

    const problems = checkRemoteConfiguration(reload(board.paths));
    const orphan = problems.find((p) => p.message.includes('LP-999'));
    expect(orphan).toBeDefined();
    expect(orphan!.level).toBe('warn');
    expect(orphan!.fixable).toBe(true);
    expect(orphan!.path).toBe('.lpm/remotes/upstream/links.json');
    expect(orphan!.message).toBe('link "LP-999" has no matching document');

    const actions = fixOrphanedLinks(reload(board.paths));
    expect(actions).toEqual([
      '.lpm/remotes/upstream/links.json: pruned 1 orphaned link (LP-999)',
    ]);
    expect(loadLinkStore(board.paths, 'upstream').links.has('LP-999')).toBe(false);
  });

  it('reports an orphaned tombstone as fixable, and --fix prunes it (LP-366)', () => {
    const board = boardWith(GITHUB);
    const store = loadLinkStore(board.paths, 'upstream');
    setTombstone(store, 'LP-999', {
      remoteKey: 'acme/payments#1',
      reason: 'manual',
      at: '2026-09-05T00:00:00Z',
    });
    saveLinkStore(board.paths, 'upstream', store);

    const problems = checkRemoteConfiguration(reload(board.paths));
    const orphan = problems.find((p) => p.message.includes('tombstone'));
    expect(orphan).toBeDefined();
    expect(orphan!.level).toBe('warn');
    expect(orphan!.fixable).toBe(true);
    expect(orphan!.path).toBe('.lpm/remotes/upstream/links.json');
    expect(orphan!.message).toBe('tombstone "LP-999" has no matching document');

    const actions = fixOrphanedLinks(reload(board.paths));
    expect(actions).toEqual([
      '.lpm/remotes/upstream/links.json: pruned 1 orphaned tombstone (LP-999)',
    ]);
    expect(loadLinkStore(board.paths, 'upstream').tombstones.has('LP-999')).toBe(false);
  });
});
