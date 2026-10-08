import { afterAll, describe, expect, it } from 'vitest';
import {
  createPeriod,
  createResource,
  type BoardPaths,
  type Problem,
} from '../src/core/index.js';
import { hasErrorProblems, preflightPush, vocabularyProblems } from '../src/remote/preflight.js';
import { findProvider } from '../src/remote/registry.js';
import type { OpenedRemote } from '../src/remote/remotes.js';
import { boardPath, cleanupBoards, makeBoard, reload, writeRawIssue } from './helpers.js';

afterAll(cleanupBoards);

const messages = (problems: Problem[]): string => problems.map((p) => p.message).join('\n');

const find = (problems: Problem[], needle: string): Problem | undefined =>
  problems.find((p) => p.message.includes(needle));

/**
 * A fully valid GitHub remote for the scrum board: every type, every status,
 * `priority` mapped, accounts via `github`, and the sprint mapped to a
 * milestone. Built by hand rather than through `openRemote`, so a test can
 * delete one key and watch the preflight report the gap `openRemote` would
 * otherwise refuse.
 */
function githubRemote(mapping: Record<string, unknown>, scope?: string): OpenedRemote {
  return {
    name: 'upstream',
    provider: findProvider('github')!,
    scope,
    direction: 'both',
    on_delete: 'unlink',
    conflict: 'manual',
    fields: {},
    encoding: 'block',
    comments: 'push',
    connection: { repo: 'acme/payments' },
    mapping,
  };
}

const FULL = {
  types: {
    program: { remote: 'program' },
    epic: { remote: 'epic' },
    feature: { remote: 'feature' },
    user_story: { remote: 'story' },
    bug: { remote: 'bug' },
    test: { remote: 'test' },
    review: { remote: 'review' },
    research: { remote: 'research' },
    sub_task: { remote: 'sub-task' },
  },
  statuses: {
    backlog: { remote: ['Backlog'], closed: false },
    ready: { remote: ['Ready'], closed: false },
    in_progress: { remote: ['In Progress'], closed: false },
    in_review: { remote: ['In Review'], closed: false },
    done: { remote: ['Done'], closed: true },
  },
  attributes: { priority: 'Priority' },
  accounts: { via: 'github' },
  periods: { container: 'sprint' },
};

/** Hand-write an issue, the way a user editing the folder by hand would. */
function rawIssue(
  paths: BoardPaths,
  id: string,
  fields: {
    type: string;
    title?: string;
    status?: string;
    assignee?: string;
    period?: string;
    attributes?: Record<string, string>;
  },
): void {
  const lines = [`id: ${id}`, `type: ${fields.type}`, `title: ${fields.title ?? id}`];
  if (fields.status) lines.push(`status: ${fields.status}`);
  if (fields.assignee) lines.push(`assignee: ${fields.assignee}`);
  if (fields.period) lines.push(`period: ${fields.period}`);
  for (const [key, value] of Object.entries(fields.attributes ?? {})) {
    lines.push(`${key}: ${value}`);
  }
  writeRawIssue(boardPath(paths, id), `---\n${lines.join('\n')}\n---\n`);
}

describe('preflightPush', () => {
  it('is silent when every in-scope value maps', () => {
    const paths = makeBoard('scrum', 'LP');
    rawIssue(paths, 'LP-1', { type: 'user_story', status: 'backlog' });
    expect(preflightPush(reload(paths), githubRemote(FULL))).toEqual([]);
  });

  it('reports an unmapped type as an error', () => {
    const paths = makeBoard('scrum', 'LP');
    rawIssue(paths, 'LP-1', { type: 'bug', status: 'backlog' });
    const problems = preflightPush(
      reload(paths),
      githubRemote({ ...FULL, types: { user_story: { remote: 'story' } } }),
    );
    expect(find(problems, 'mapping.types.bug')).toEqual({
      level: 'error',
      path: '.lpm/config.yml',
      message: 'remotes.upstream.mapping.types.bug: type "bug" has no mapping',
    });
  });

  it('reports an unmapped status as an error', () => {
    const paths = makeBoard('scrum', 'LP');
    rawIssue(paths, 'LP-1', { type: 'user_story', status: 'in_review' });
    const problems = preflightPush(
      reload(paths),
      githubRemote({ ...FULL, statuses: { backlog: { remote: ['Backlog'] } } }),
    );
    expect(find(problems, 'mapping.statuses.in_review')).toEqual({
      level: 'error',
      path: '.lpm/config.yml',
      message: 'remotes.upstream.mapping.statuses.in_review: status "in_review" has no mapping',
    });
  });

  it('warns when a used attribute has no mapping, naming the managed block', () => {
    const paths = makeBoard('scrum', 'LP');
    rawIssue(paths, 'LP-1', {
      type: 'user_story',
      status: 'backlog',
      attributes: { commit: 'abc123' },
    });
    const problems = preflightPush(reload(paths), githubRemote(FULL));
    expect(find(problems, 'mapping.attributes.commit')).toEqual({
      level: 'warn',
      path: '.lpm/config.yml',
      message:
        'remotes.upstream.mapping.attributes.commit: attribute "commit" is not mapped; it will be encoded in the managed block',
    });
  });

  it('reports an attribute value that will not coerce as an error', () => {
    const paths = makeBoard('scrum', 'LP');
    rawIssue(paths, 'LP-1', {
      type: 'user_story',
      status: 'backlog',
      attributes: { story_points: 'lots' },
    });
    const problems = preflightPush(
      reload(paths),
      githubRemote({ ...FULL, attributes: { priority: 'Priority', story_points: 'Points' } }),
    );
    expect(find(problems, 'mapping.attributes.story_points')).toEqual({
      level: 'error',
      path: '.lpm/config.yml',
      message: 'remotes.upstream.mapping.attributes.story_points: expected an integer, got string',
    });
  });

  it('warns when a person has no account, pushed unassigned', () => {
    const paths = makeBoard('scrum', 'LP');
    createResource(reload(paths), { type: 'person', title: 'Grace' });
    rawIssue(paths, 'LP-1', { type: 'user_story', status: 'backlog', assignee: 'RS-1' });
    const problems = preflightPush(reload(paths), githubRemote(FULL));
    expect(find(problems, 'mapping.accounts.via')).toEqual({
      level: 'warn',
      path: '.lpm/config.yml',
      message: 'remotes.upstream.mapping.accounts.via: Grace is pushed unassigned (no "github" attribute value)',
    });
  });

  it('warns when no account mapping is configured at all', () => {
    const paths = makeBoard('scrum', 'LP');
    createResource(reload(paths), { type: 'person', title: 'Frank', attributes: { github: 'frank' } });
    rawIssue(paths, 'LP-1', { type: 'user_story', status: 'backlog', assignee: 'RS-1' });
    const problems = preflightPush(reload(paths), githubRemote({ ...FULL, accounts: undefined }));
    const problem = find(problems, 'mapping.accounts.via');
    expect(problem!.level).toBe('warn');
    expect(problem!.message).toContain('no account mapping is configured');
  });

  it('reports nothing for a generic pool, which degrades to a label by design', () => {
    const paths = makeBoard('scrum', 'LP');
    createResource(reload(paths), { type: 'role', title: 'Backend Pool' });
    rawIssue(paths, 'LP-1', { type: 'user_story', status: 'backlog', assignee: 'RS-1' });
    expect(preflightPush(reload(paths), githubRemote(FULL))).toEqual([]);
  });

  it('reports a stale assignee id as an error', () => {
    const paths = makeBoard('scrum', 'LP');
    rawIssue(paths, 'LP-1', { type: 'user_story', status: 'backlog', assignee: 'RS-999' });
    const problems = preflightPush(reload(paths), githubRemote(FULL));
    expect(find(problems, 'mapping.accounts')).toEqual({
      level: 'error',
      path: '.lpm/config.yml',
      message: 'remotes.upstream.mapping.accounts: assignee "RS-999" is not on the roster',
    });
  });

  it('reports a stale period id as an error', () => {
    const paths = makeBoard('scrum', 'LP');
    rawIssue(paths, 'LP-1', { type: 'user_story', status: 'backlog', period: 'TL-999' });
    const problems = preflightPush(reload(paths), githubRemote(FULL));
    expect(find(problems, 'mapping.periods')).toEqual({
      level: 'error',
      path: '.lpm/config.yml',
      message: 'remotes.upstream.mapping.periods: period "TL-999" is not on the timeline',
    });
  });

  it('maps an issue scheduled in a sprint without complaint', () => {
    const paths = makeBoard('scrum', 'LP');
    createPeriod(reload(paths), {
      type: 'increment',
      title: 'PI-1',
      starts: '2026-01-01',
      ends: '2026-03-31',
    });
    createPeriod(reload(paths), {
      type: 'sprint',
      title: 'Sprint 1',
      starts: '2026-01-01',
      ends: '2026-01-14',
      parentId: 'TL-1',
    });
    rawIssue(paths, 'LP-1', { type: 'user_story', status: 'backlog', period: 'TL-2' });
    expect(preflightPush(reload(paths), githubRemote(FULL))).toEqual([]);
  });

  it('only walks the remote scope', () => {
    const paths = makeBoard('scrum', 'LP');
    rawIssue(paths, 'LP-1', { type: 'user_story', status: 'backlog' });
    rawIssue(paths, 'LP-2', { type: 'bug', status: 'backlog' });
    const problems = preflightPush(
      reload(paths),
      githubRemote({ ...FULL, types: { user_story: { remote: 'story' } } }, 'LP-1'),
    );
    expect(messages(problems)).not.toContain('mapping.types.bug');
  });
});

describe('hasErrorProblems', () => {
  it('is true for an error and false for warnings only', () => {
    expect(hasErrorProblems([{ level: 'error', path: '.', message: 'x' }])).toBe(true);
    expect(hasErrorProblems([{ level: 'warn', path: '.', message: 'x' }])).toBe(false);
    expect(hasErrorProblems([])).toBe(false);
  });
});

describe('a connection key only part of the mapping needs', () => {
  /** A Jira remote for the scrum board, whose connection is the test's to shape. */
  function jiraRemote(connection: Record<string, unknown>): OpenedRemote {
    return {
      name: 'jira',
      provider: findProvider('jira')!,
      direction: 'both',
      on_delete: 'unlink',
      conflict: 'manual',
      fields: {},
      encoding: 'block',
      comments: 'push',
      connection,
      mapping: {
        types: { user_story: { remote: 'Story' } },
        statuses: { backlog: { remote: ['To Do'], closed: false } },
        periods: { container: 'sprint', carrier: 'sprint' },
      },
    };
  }

  it('refuses a push that schedules into sprints with no Agile board id', () => {
    // The failure this exists to prevent: the push got as far as creating
    // sprints — after the consent gate, after the first writes were agreed —
    // and only then discovered it had nowhere to create them.
    const paths = makeBoard('scrum', 'LP');
    const problems = preflightPush(reload(paths), jiraRemote({ site: 'https://acme.atlassian.net', project: 'PAY' }));

    const problem = find(problems, 'connection.board');
    expect(problem, messages(problems)).toBeDefined();
    expect(problem!.level).toBe('error');
    expect(hasErrorProblems(problems)).toBe(true);
    // The remedy names where the id actually is, because nothing else will.
    expect(problem!.message).toContain('Agile board');
  });

  it('says nothing once the board id is set', () => {
    const paths = makeBoard('scrum', 'LP');
    const problems = preflightPush(
      reload(paths),
      jiraRemote({ site: 'https://acme.atlassian.net', project: 'PAY', board: '12' }),
    );
    expect(find(problems, 'connection.board')).toBeUndefined();
  });

  it('says nothing when the mapping carries no periods at all', () => {
    // A Jira remote that never schedules needs no board, which is exactly why
    // the provider schema cannot mark the key required.
    const paths = makeBoard('scrum', 'LP');
    const remote = jiraRemote({ site: 'https://acme.atlassian.net', project: 'PAY' });
    const { periods: _periods, ...withoutPeriods } = remote.mapping as Record<string, unknown>;
    const problems = preflightPush(reload(paths), { ...remote, mapping: withoutPeriods });
    expect(find(problems, 'connection.board')).toBeUndefined();
  });
});

describe('the mapped names against the project\u2019s real vocabulary', () => {
  const configPath = '.lpm/config.yml';

  function jiraRemote(types: Record<string, unknown>): OpenedRemote {
    return {
      name: 'jira',
      provider: findProvider('jira')!,
      direction: 'both',
      on_delete: 'unlink',
      conflict: 'manual',
      fields: {},
      encoding: 'block',
      comments: 'push',
      connection: { site: 'https://acme.atlassian.net', project: 'PAY', board: '1' },
      mapping: { types, statuses: { backlog: { remote: ['To Do'], closed: false } } },
    };
  }

  it('refuses a type the project does not have, and names the ones it does', () => {
    // The failure this exists to prevent: a mapping naming `Program` on a
    // project that has no such type got as far as a create and came back
    // `400: Specify a valid issue type`, after the consent gate, with nothing
    // to say about what the project *does* have.
    const problems = vocabularyProblems(
      jiraRemote({ program: { remote: 'Program' }, user_story: { remote: 'Story' } }),
      { types: ['Epic', 'Story', 'Task', 'Subtask'], statuses: ['To Do'] },
      configPath,
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]!.level).toBe('error');
    expect(problems[0]!.message).toContain('has no "Program"');
    expect(problems[0]!.message).toContain('Epic, Story, Task, Subtask');
  });

  it('says nothing when every mapped name exists', () => {
    const problems = vocabularyProblems(
      jiraRemote({ epic: { remote: 'Epic' }, user_story: { remote: 'Story' } }),
      { types: ['Epic', 'Story'], statuses: ['To Do'] },
      configPath,
    );
    expect(problems).toEqual([]);
  });

  it('says nothing about a vocabulary the remote does not report', () => {
    // Absence is not evidence — the same rule the rest of this layer follows.
    const problems = vocabularyProblems(
      jiraRemote({ epic: { remote: 'Epic' } }),
      {},
      configPath,
    );
    expect(problems).toEqual([]);
  });
});
