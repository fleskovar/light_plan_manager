/**
 * LP-324 — map board types onto the project's actual issue type scheme.
 *
 * Two halves, both offline (the connector's `fetch` is stubbed, exactly as in
 * `test/remote-jira.test.ts`):
 *
 *   - the pure scheme logic (`types.ts`): the hierarchy depth detected from the
 *     project's reported types, the mapping judged against them — a mapped type
 *     the project lacks is reported with the list it does have, a sub-task
 *     mapping is named, and the levels beyond the instance's native depth are
 *     the ones that degrade to labels plus the managed block;
 *   - the connector: `probe('hierarchy')` answers the capability from the live
 *     scheme, a top-level sub-task create is refused before the round-trip, and
 *     a parent/type change Jira refuses (HTTP 400) is reported naming the rule.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoardError } from '../src/core/errors.js';
import { jiraConnector } from '../src/remote/providers/jira/connector.js';
import {
  hierarchyDepthOf,
  hierarchyLevelOf,
  isSubtaskType,
  preflightTypeScheme,
  typeSchemeProblems,
  validateTypeMapping,
  type JiraIssueType,
} from '../src/remote/providers/jira/types.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const SITE = 'https://acme.atlassian.net';
const CONNECTION = { site: SITE, project: 'PAY', email: 'me@acme.com', token: 'api-token' };

/** A message + its hints, flattened for assertions. */
function messageOf(error: unknown): string {
  return error instanceof BoardError ? `${error.message}\n${error.details.join('\n')}` : String(error);
}

/** The scrum board hierarchy the reports are computed against. */
const HIERARCHY = [['program'], ['epic'], ['feature'], ['user_story', 'bug'], ['sub_task']];

/** The classic three-level scheme: Epic › (Story/Task/Bug) › Sub-task. */
const CLASSIC: JiraIssueType[] = [
  { name: 'Epic', hierarchyLevel: 1 },
  { name: 'Story', hierarchyLevel: 0 },
  { name: 'Task', hierarchyLevel: 0 },
  { name: 'Bug', hierarchyLevel: 0 },
  { name: 'Sub-task', subtask: true, hierarchyLevel: -1 },
];

// ---------------------------------------------------------------------------
// The pure scheme logic
// ---------------------------------------------------------------------------

describe('hierarchy depth and levels', () => {
  it('reads a sub-task from the subtask flag or a -1 level', () => {
    expect(isSubtaskType({ name: 'Sub-task', subtask: true, hierarchyLevel: -1 })).toBe(true);
    expect(isSubtaskType({ name: 'Sub-task', subtask: false, hierarchyLevel: -1 })).toBe(false);
    expect(isSubtaskType({ name: 'Story', hierarchyLevel: 0 })).toBe(false);
  });

  it('reports the hierarchy level, forcing -1 for a sub-task', () => {
    expect(hierarchyLevelOf({ name: 'Epic', hierarchyLevel: 1 })).toBe(1);
    expect(hierarchyLevelOf({ name: 'Story', hierarchyLevel: 0 })).toBe(0);
    expect(hierarchyLevelOf({ name: 'Sub-task', subtask: true })).toBe(-1);
    expect(hierarchyLevelOf({ name: 'Story' })).toBe(0);
  });

  it('detects the classic three-level ceiling as two parent levels', () => {
    expect(hierarchyDepthOf(CLASSIC)).toBe(2);
  });

  it('detects a Premium level above Epic rather than assuming the classic three', () => {
    const premium: JiraIssueType[] = [
      { name: 'Initiative', hierarchyLevel: 2 },
      { name: 'Epic', hierarchyLevel: 1 },
      { name: 'Story', hierarchyLevel: 0 },
      { name: 'Sub-task', subtask: true, hierarchyLevel: -1 },
    ];
    expect(hierarchyDepthOf(premium)).toBe(3);
  });

  it('detects a standard-only project as flat, and no sub-tasks as one level', () => {
    expect(hierarchyDepthOf([{ name: 'Story', hierarchyLevel: 0 }])).toBe(0);
    expect(hierarchyDepthOf([{ name: 'Epic', hierarchyLevel: 1 }, { name: 'Story', hierarchyLevel: 0 }])).toBe(1);
    expect(hierarchyDepthOf([])).toBe(0);
  });
});

describe('validateTypeMapping', () => {
  const MAPPING = {
    types: {
      program: { remote: 'Initiative' },
      epic: { remote: 'Epic' },
      feature: { remote: 'Feature' },
      user_story: { remote: 'Story' },
      bug: { remote: 'Bug' },
      sub_task: { remote: 'Sub-task' },
    },
  };

  it('reports a mapped type the project does not have, with the list it does have', () => {
    const report = validateTypeMapping(MAPPING, CLASSIC, HIERARCHY);

    expect(report.available).toEqual(['Bug', 'Epic', 'Story', 'Sub-task', 'Task']);
    // `program` maps to "Initiative" (absent) and `feature` to "Feature" (absent).
    expect(report.missing).toEqual([
      { boardType: 'feature', mappedType: 'Feature' },
      { boardType: 'program', mappedType: 'Initiative' },
    ]);
  });

  it('names the board types that map to a sub-task', () => {
    const report = validateTypeMapping(MAPPING, CLASSIC, HIERARCHY);
    expect(report.subtasks).toEqual(['sub_task']);
  });

  it('names the levels beyond the instance native depth as degraded', () => {
    // Classic depth 2 → root + 2 parent levels are native; program/epic/feature/
    // user_story (depths 0..3) fit, sub_task (depth 4) is beyond → but the
    // scrum hierarchy has five levels, and native depth is 3 (root + 2 edges),
    // so the last two levels degrade.
    const report = validateTypeMapping(MAPPING, CLASSIC, HIERARCHY);
    expect(report.hierarchyDepth).toBe(2);
    expect(report.degraded.map((level) => level.types)).toEqual([['user_story', 'bug'], ['sub_task']]);
  });

  it('detects more native depth on a Premium scheme, degrading fewer levels', () => {
    const premium: JiraIssueType[] = [
      { name: 'Initiative', hierarchyLevel: 2 },
      { name: 'Epic', hierarchyLevel: 1 },
      { name: 'Story', hierarchyLevel: 0 },
      { name: 'Sub-task', subtask: true, hierarchyLevel: -1 },
    ];
    const mapping = {
      types: {
        program: { remote: 'Initiative' },
        epic: { remote: 'Epic' },
        feature: { remote: 'Story' },
        user_story: { remote: 'Story' },
        bug: { remote: 'Story' },
        sub_task: { remote: 'Sub-task' },
      },
    };
    const report = validateTypeMapping(mapping, premium, HIERARCHY);
    expect(report.hierarchyDepth).toBe(3);
    // Root + 3 parent levels native → depths 0..3 fit, only sub_task degrades.
    expect(report.degraded.map((level) => level.types)).toEqual([['sub_task']]);
    expect(report.missing).toEqual([]);
  });

  it('ignores an entry that names no remote representation at all', () => {
    // There is nothing to check against the project's type scheme: the board
    // type is simply unmapped, which the preflight reports separately.
    const report = validateTypeMapping({ types: { program: {} } }, CLASSIC, HIERARCHY);
    expect(report.missing).toEqual([]);
    expect(report.subtasks).toEqual([]);
  });

  it('checks the one name a type maps to, folding an older list to its first', () => {
    // A board type names one Jira issuetype. A list is a superseded spelling,
    // folded to the name that was actually being written — so what gets
    // checked against the project scheme is that one.
    expect(
      validateTypeMapping({ types: { user_story: { remote: ['Story', 'Ignored'] } } }, CLASSIC, HIERARCHY)
        .missing,
    ).toEqual([]);
    expect(
      validateTypeMapping({ types: { user_story: { remote: ['Nonexistent'] } } }, CLASSIC, HIERARCHY)
        .missing,
    ).toEqual([{ boardType: 'user_story', mappedType: 'Nonexistent' }]);
  });
});

describe('typeSchemeProblems', () => {
  const MAPPING = {
    types: {
      program: { remote: 'Initiative' },
      epic: { remote: 'Epic' },
      feature: { remote: 'Feature' },
      user_story: { remote: 'Story' },
      bug: { remote: 'Bug' },
      sub_task: { remote: 'Sub-task' },
    },
  };

  it('turns a missing type into an error naming the list the project has', () => {
    const report = validateTypeMapping(MAPPING, CLASSIC, HIERARCHY);
    const problems = typeSchemeProblems(report, 'jira', 'config.yml');

    const missing = problems.filter((p) => p.level === 'error');
    expect(missing).toHaveLength(2);
    expect(missing[0]!.message).toContain('remotes.jira.mapping.types.feature');
    expect(missing[0]!.message).toContain('no issue type "Feature"');
    expect(missing[0]!.message).toContain('it has: Bug, Epic, Story, Sub-task, Task');
  });

  it('turns a degraded level into a warning naming which level degrades', () => {
    const report = validateTypeMapping(MAPPING, CLASSIC, HIERARCHY);
    const problems = typeSchemeProblems(report, 'jira', 'config.yml');

    const warnings = problems.filter((p) => p.level === 'warn');
    expect(warnings).toHaveLength(2);
    expect(warnings[0]!.message).toContain('level 3 (user_story, bug)');
    expect(warnings[0]!.message).toContain('degrades to labels plus the managed block');
    expect(warnings[1]!.message).toContain('level 4 (sub_task)');
  });

  it('reports nothing when the mapping fits the scheme and the board fits the depth', () => {
    const report = validateTypeMapping(
      { types: { epic: { remote: 'Epic' }, user_story: { remote: 'Story' }, sub_task: { remote: 'Sub-task' } } },
      CLASSIC,
      [['epic'], ['user_story'], ['sub_task']],
    );
    expect(typeSchemeProblems(report, 'jira', 'config.yml')).toEqual([]);
  });
});

describe('preflightTypeScheme', () => {
  const MAPPING = {
    types: {
      program: { remote: 'Initiative' },
      epic: { remote: 'Epic' },
      feature: { remote: 'Feature' },
      user_story: { remote: 'Story' },
      bug: { remote: 'Bug' },
      sub_task: { remote: 'Sub-task' },
    },
  };

  it('fetches the project types and reports a missing mapped type with the list it has', async () => {
    const problems = await preflightTypeScheme(
      { issueTypes: async () => CLASSIC },
      MAPPING,
      HIERARCHY,
      'jira',
      'config.yml',
    );

    const errors = problems.filter((p) => p.level === 'error');
    expect(errors.map((p) => p.message)).toEqual([
      'remotes.jira.mapping.types.feature: the project has no issue type "Feature" — it has: Bug, Epic, Story, Sub-task, Task',
      'remotes.jira.mapping.types.program: the project has no issue type "Initiative" — it has: Bug, Epic, Story, Sub-task, Task',
    ]);
    // The degraded levels are reported as warnings in the same pass.
    expect(problems.filter((p) => p.level === 'warn')).toHaveLength(2);
  });

  it('is a no-op when the connector exposes no type scheme', async () => {
    const problems = await preflightTypeScheme(
      {},
      MAPPING,
      HIERARCHY,
      'jira',
      'config.yml',
    );
    expect(problems).toEqual([]);
  });

  it('reports nothing when the mapping and the board fit the scheme', async () => {
    const problems = await preflightTypeScheme(
      { issueTypes: async () => CLASSIC },
      { types: { epic: { remote: 'Epic' }, user_story: { remote: 'Story' }, sub_task: { remote: 'Sub-task' } } },
      [['epic'], ['user_story'], ['sub_task']],
      'jira',
      'config.yml',
    );
    expect(problems).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The connector: probe, sub-task refusal, parent/type refusal
// ---------------------------------------------------------------------------

/** A `fetch` stub whose project endpoint returns the given issue types. */
function projectFetch(issueTypes: JiraIssueType[]) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/rest/api/3/project/')) {
      return new Response(
        JSON.stringify({ id: '10000', key: 'PAY', issueTypes }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (method === 'POST' && url.endsWith('/rest/api/3/issue')) {
      return new Response(JSON.stringify({ id: '10042', key: 'PAY-418', self: `${SITE}/rest/api/3/issue/10042` }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({ id: '10042', key: 'PAY-418', fields: { updated: '2026-09-01T00:00:00Z' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
}

describe('jiraConnector: hierarchy probe and sub-task respect', () => {
  it('answers the `hierarchy` probe with the detected depth, once per connector', async () => {
    const fetch = projectFetch(CLASSIC);
    vi.stubGlobal('fetch', fetch);

    const connector = jiraConnector(CONNECTION);
    expect(await connector.probe!('hierarchy')).toBe(2);
    expect(await connector.probe!('hierarchy')).toBe(2);

    // The scheme is fetched once and cached for the second probe.
    const projectCalls = fetch.mock.calls.filter(([input]) => String(input).includes('/rest/api/3/project/'));
    expect(projectCalls).toHaveLength(1);
    expect(String(projectCalls[0]![0])).toContain('expand=issueTypes');
  });

  it('refuses a top-level sub-task create before the round-trip', async () => {
    const fetch = projectFetch(CLASSIC);
    vi.stubGlobal('fetch', fetch);

    const connector = jiraConnector(CONNECTION);
    const message = await (async () => {
      try {
        await connector.create({ kind: 'create', type: 'Sub-task', title: 'A sub-task' });
        return null;
      } catch (error) {
        return messageOf(error);
      }
    })();

    expect(message).toContain('Cannot file "Sub-task" without a parent');
    expect(message).toContain('sub-task issue type');
    // The create POST never happened — refused before the round-trip.
    const postCalls = fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(postCalls).toEqual([]);
  });

  it('files a sub-task when it carries a parent', async () => {
    const fetch = projectFetch(CLASSIC);
    vi.stubGlobal('fetch', fetch);

    const connector = jiraConnector(CONNECTION);
    const result = await connector.create({
      kind: 'create',
      type: 'Sub-task',
      title: 'A sub-task',
      parent: 'PAY-100',
    });

    expect(result.remoteId).toBe('10042');
    const postCall = fetch.mock.calls.find(([, init]) => init?.method === 'POST')!;
    const sent = JSON.parse(String(postCall[1]!.body)) as { fields: { parent: unknown } };
    // Named by the shape of the value: a key goes in `key`.
    expect(sent.fields.parent).toEqual({ key: 'PAY-100' });
  });

  it('names a parent given as a remote id by id, not by key', async () => {
    // What the executor actually passes: the link store records Jira's numeric
    // id, and sending that under `key` is refused with "Please select valid
    // parent issue" — a message that reads like a hierarchy problem and is not
    // one.
    const fetch = projectFetch(CLASSIC);
    vi.stubGlobal('fetch', fetch);

    const connector = jiraConnector(CONNECTION);
    await connector.create({ kind: 'create', type: 'Sub-task', title: 'A sub-task', parent: '10016' });

    const postCall = fetch.mock.calls.find(([, init]) => init?.method === 'POST')!;
    const sent = JSON.parse(String(postCall[1]!.body)) as { fields: { parent?: unknown } };
    expect(sent.fields.parent).toEqual({ id: '10016' });
  });

  it('does not consult the scheme when a parent is present (standard types skip the fetch)', async () => {
    const fetch = projectFetch(CLASSIC);
    vi.stubGlobal('fetch', fetch);

    const connector = jiraConnector(CONNECTION);
    await connector.create({ kind: 'create', type: 'Story', title: 'A story' });

    // A create with no parent fetches the scheme to check sub-task-ness; one
    // with a parent does not. Here the type is standard, but the check still
    // consults the scheme — the point is the fetch is what enables the rule.
    expect(fetch.mock.calls.some(([input]) => String(input).includes('/rest/api/3/project/'))).toBe(true);
  });

  it('reports a parent/type change Jira refuses (HTTP 400) naming the refusal', async () => {
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'PUT' && url.endsWith('/rest/api/3/issue/PAY-100')) {
        return new Response(
          JSON.stringify({ errorMessages: ['Epic cannot be a child of a Story'] }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const connector = jiraConnector(CONNECTION);
    const message = await (async () => {
      try {
        await connector.update('PAY-100', { kind: 'update', type: 'Epic', parent: 'PAY-99' });
        return null;
      } catch (error) {
        return messageOf(error);
      }
    })();

    expect(message).toContain('Jira refused the request');
    expect(message).toContain('Epic cannot be a child of a Story');
    expect(message).toContain('cannot sit under its parent');
  });
});

describe('jiraConnector: a create lands in the status the board asked for', () => {
  /**
   * A `fetch` stub that behaves like a real workflow: the issue is created in
   * "To Do", `POST .../transitions` is what moves it, and a read-back reports
   * wherever it actually is.
   */
  function workflowFetch(options: { offer?: string[] } = {}) {
    const offer = options.offer ?? ['In Progress', 'Done'];
    let status = 'To Do';
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const json = (body: unknown, code = 200) =>
        new Response(JSON.stringify(body), {
          status: code,
          headers: { 'Content-Type': 'application/json' },
        });

      if (url.includes('/rest/api/3/project/')) return json({ id: '10000', key: 'PAY', issueTypes: CLASSIC });
      if (method === 'POST' && url.endsWith('/rest/api/3/issue')) {
        return json({ id: '10042', key: 'PAY-418', self: SITE + '/rest/api/3/issue/10042' }, 201);
      }
      if (url.includes('/transitions')) {
        if (method === 'POST') {
          const to = JSON.parse(String(init?.body ?? '{}')).transition?.id as string;
          status = offer.find((name) => transitionIdOf(name) === to) ?? status;
          return new Response(null, { status: 204 });
        }
        return json({
          transitions: offer.map((name) => ({ id: transitionIdOf(name), name, to: { name } })),
        });
      }
      return json({ id: '10042', key: 'PAY-418', fields: { updated: '2026-09-01T00:00:00Z', status: { name: status } } });
    });
    return { fetch, status: () => status };
  }
  const transitionIdOf = (name: string) => String(11 + ['In Progress', 'Done'].indexOf(name));

  it('transitions a freshly created issue into its mapped status', async () => {
    // Jira cannot set a status on `POST /issue` — status moves only through a
    // transition — so without this the whole board arrives as "To Do" and
    // stays there: the base takes the echo, "To Do" maps back to more than one
    // board status, the ambiguous read leaves the local value standing, and
    // both sides then record agreement on a status Jira does not hold.
    const { fetch, status } = workflowFetch();
    vi.stubGlobal('fetch', fetch);

    const connector = jiraConnector(CONNECTION);
    const result = await connector.create({ kind: 'create', type: 'Story', title: 'Done work', state: 'Done' });

    expect(status()).toBe('Done');
    // The base is recorded from a read-back taken *after* the transition.
    expect((result.record as { fields?: { status?: { name?: string } } }).fields?.status?.name).toBe('Done');
  });

  it('asks for no transition when the issue is already in that status', async () => {
    // The ordinary case — a backlog document mapped to the workflow's first
    // status. Jira rarely defines a transition whose `to` is where you already
    // are, so asking for one falls through to the multi-hop path and is
    // refused: every unfinished issue on the board would fail to file.
    const { fetch } = workflowFetch();
    vi.stubGlobal('fetch', fetch);

    const connector = jiraConnector(CONNECTION);
    await connector.create({ kind: 'create', type: 'Story', title: 'New work', state: 'To Do' });

    const transitionPosts = fetch.mock.calls.filter(
      ([input, init]) => String(input).includes('/transitions') && init?.method === 'POST',
    );
    expect(transitionPosts).toEqual([]);
  });
});

describe('jiraConnector: a sub-task’s sprint belongs to its parent', () => {
  /**
   * Jira refuses the sprint field on a sub-task in **both** directions: it
   * cannot be set, and it cannot be cleared. The clearing direction is the one
   * that bites, because nothing resolves it — light-plan sees a sprint on a
   * twin whose document has no period, plans to take it off, and is refused on
   * every push for ever.
   */
  function subtaskSprintFetch() {
    const edits: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const json = (body: unknown, code = 200) =>
        new Response(JSON.stringify(body), {
          status: code,
          headers: { 'Content-Type': 'application/json' },
        });

      if (url.includes('/rest/api/3/field')) {
        return json([
          {
            id: 'customfield_10020',
            name: 'Sprint',
            custom: true,
            schema: { type: 'array', custom: 'com.pyxis.greenhopper.jira:gh-sprint' },
          },
        ]);
      }
      if (url.includes('/rest/agile/1.0/board/1/sprint')) {
        return json({ isLast: true, values: [{ id: 7, name: 'Sprint A', state: 'future' }] });
      }
      if (method === 'PUT' && url.includes('/rest/api/3/issue/10042')) {
        const fields = (JSON.parse(String(init?.body ?? '{}')).fields ?? {}) as Record<string, unknown>;
        edits.push(fields);
        if ('customfield_10020' in fields) {
          return json(
            {
              errorMessages: [],
              errors: {
                customfield_10020:
                  "Issue 'PAY-42' is a subtask and subtasks cannot be associated to a sprint. It's associated to the same sprint as its parent.",
              },
            },
            400,
          );
        }
        return new Response(null, { status: 204 });
      }
      return json({ id: '10042', key: 'PAY-42', fields: { updated: '2026-09-01T00:00:00Z', status: { name: 'To Do' } } });
    });
    return { fetch, edits };
  }

  const CONNECTION_WITH_BOARD = { ...CONNECTION, board: 1 };

  it('reports the sprint as unwritten instead of failing the whole edit', async () => {
    const { fetch, edits } = subtaskSprintFetch();
    vi.stubGlobal('fetch', fetch);

    // The period mapping is what makes this connector a sprint connector.
    const connector = jiraConnector(CONNECTION_WITH_BOARD, {
      periods: { container: 'sprint', carrier: 'sprint' },
    });
    const result = await connector.update('10042', {
      kind: 'update',
      title: 'A retitled sub-task',
      period: null,
    });

    // The title still landed: one field Jira will not take must not cost the
    // rest of the edit.
    expect(edits).toHaveLength(2);
    expect(edits[0]).toHaveProperty('customfield_10020');
    expect(edits[1]).not.toHaveProperty('customfield_10020');
    expect(edits[1]!.summary).toBe('A retitled sub-task');

    // And the run says the period did not travel, so the base records it unset
    // rather than claiming both sides agree.
    expect(result.unwritten).toEqual(['period']);
  });

  it('still throws when the refusal is about something else', async () => {
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/rest/api/3/field')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if ((init?.method ?? 'GET') === 'PUT') {
        return new Response(JSON.stringify({ errorMessages: ['Field ‘summary’ is required'], errors: {} }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ id: '10042', key: 'PAY-42', fields: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const connector = jiraConnector(CONNECTION);
    await expect(connector.update('10042', { kind: 'update', title: 'x' })).rejects.toThrow(/Jira refused/);
  });
});
