import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseDocument } from 'yaml';
import type { BoardPaths } from '../src/core/index.js';
import { BoardError, editBoardConfig, loadConfig } from '../src/core/index.js';
import { addRemote } from '../src/remote/config-file.js';
import { writeCredential } from '../src/remote/credentials.js';
import { readRemoteMapping, writeRemoteMapping } from '../src/remote/mapping-editor.js';
import { redactor } from '../src/remote/redact.js';
import { openRemote } from '../src/remote/remotes.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

/**
 * The mapping editor: what a tracker has beside what the mapping says, and the
 * write of a chosen mapping.
 *
 * The Jira connector rides `fetch`, so a stub drives the real connector. The
 * stub answers the project (issue types with their hierarchy level), the
 * statuses of each issue type, and the sprints of Agile board 7.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  redactor.clear();
});

afterEach(cleanupBoards);

const PROJECT = {
  key: 'PAY',
  issueTypes: [
    { name: 'Initiative', hierarchyLevel: 2 },
    { name: 'Epic', hierarchyLevel: 1 },
    { name: 'Story', hierarchyLevel: 0 },
    { name: 'Bug', hierarchyLevel: 0 },
    { name: 'Sub-task', hierarchyLevel: -1, subtask: true },
  ],
};

const STATUSES = [
  { name: 'Story', statuses: [{ name: 'To Do' }, { name: 'In Progress' }, { name: 'In Review' }, { name: 'Done' }] },
  { name: 'Bug', statuses: [{ name: 'To Do' }, { name: "Won't Fix" }, { name: 'Done' }] },
];

const SPRINTS = {
  isLast: true,
  values: [
    { id: 37, state: 'active', name: 'Sprint 1', startDate: '2026-01-01T00:00:00.000Z', endDate: '2026-01-14T00:00:00.000Z' },
    { id: 38, state: 'future', name: 'Sprint 2' },
  ],
};

/** Answer each URL fragment with a JSON body, the first match first. A URL with no match answers 404. */
function stubJira(routes: Array<[fragment: string, body: unknown]>): void {
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    for (const [fragment, body] of routes) {
      if (url.includes(fragment)) {
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    }
    return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
  });
}

const liveJira = (): void =>
  stubJira([
    ['/sprint', SPRINTS],
    ['/project/PAY/statuses', STATUSES],
    ['/project/PAY', PROJECT],
  ]);

/** A scrum board with a Jira remote called `jira`, its credential stored, and Agile board 7. */
function boardWithJira(): BoardPaths {
  const paths = makeBoard('scrum', 'LP');
  addRemote(paths, {
    name: 'jira',
    provider: 'jira',
    connection: { site: 'https://acme.atlassian.net', project: 'PAY', board: '7' },
  });
  writeCredential(paths, 'jira', 'email', 'me@acme.com');
  writeCredential(paths, 'jira', 'token', 'api-token');
  return paths;
}

const mappingOf = (paths: BoardPaths): Record<string, unknown> =>
  loadConfig(paths).config!.remotes.jira!.mapping;

function refusal(run: () => unknown): BoardError {
  try {
    run();
  } catch (error) {
    if (error instanceof BoardError) return error;
    throw error;
  }
  throw new Error('The call did not throw');
}

describe('readRemoteMapping', () => {
  it('lists the issue types of the tracker with the hierarchy level of each', async () => {
    liveJira();
    const view = await readRemoteMapping(reload(boardWithJira()), 'jira');

    expect(view.provider).toBe('jira');
    expect(view.reachability?.reachable).toBe(true);
    expect(view.types.fixed).toBe(true);
    expect(view.types.items).toEqual([
      { name: 'Initiative', level: 2 },
      { name: 'Epic', level: 1 },
      { name: 'Story', level: 0 },
      { name: 'Bug', level: 0 },
      { name: 'Sub-task', level: -1, subtask: true },
    ]);
    expect(view.problems).toEqual([]);
  });

  it('answers the mapping that `lpm remote add` drafted, as board word to tracker word', async () => {
    liveJira();
    const view = await readRemoteMapping(reload(boardWithJira()), 'jira');

    expect(view.types.mapping).toMatchObject({
      program: 'Epic',
      epic: 'Epic',
      user_story: 'Story',
      bug: 'Bug',
      sub_task: 'Sub-task',
    });
    expect(view.statuses.mapping).toEqual({
      backlog: ['To Do'],
      ready: ['To Do'],
      in_progress: ['In Progress'],
      in_review: ['In Progress'],
      done: ['Done'],
    });
  });

  it('lists the union of the statuses and the sprints of the Agile board', async () => {
    liveJira();
    const view = await readRemoteMapping(reload(boardWithJira()), 'jira');

    expect(view.statuses.fixed).toBe(true);
    expect([...view.statuses.items].sort()).toEqual(['Done', 'In Progress', 'In Review', 'To Do', "Won't Fix"]);
    expect(view.periods).toMatchObject({ native: true, carrier: 'sprint', container: 'sprint' });
    expect(view.periods.items).toEqual([
      { name: 'Sprint 1', state: 'active', starts: '2026-01-01', ends: '2026-01-14' },
      { name: 'Sprint 2', state: 'future' },
    ]);
  });

  it('answers from the mapping alone, with the reason, when no credential is stored', async () => {
    for (const env of ['JIRA_EMAIL', 'JIRA_API_TOKEN']) vi.stubEnv(env, '');
    const paths = makeBoard('scrum', 'LP');
    addRemote(paths, {
      name: 'jira',
      provider: 'jira',
      connection: { site: 'https://acme.atlassian.net', project: 'PAY' },
    });

    const view = await readRemoteMapping(reload(paths), 'jira');

    expect(view.types.fixed).toBe(false);
    expect(view.types.items.map((item) => item.name)).toEqual(['Epic', 'Story', 'Bug', 'Task', 'Sub-task']);
    expect(view.statuses.items).toEqual(['To Do', 'In Progress', 'Done']);
    expect(view.problems).toHaveLength(1);
    expect(view.problems[0]).toContain('The tracker was not asked');
  });

  it('stops after the probe when the project cannot be seen', async () => {
    stubJira([]);
    const view = await readRemoteMapping(reload(boardWithJira()), 'jira');

    expect(view.reachability?.reachable).toBe(false);
    expect(view.types.fixed).toBe(false);
    expect(view.periods.items).toBeNull();
  });

  it('reads a remote that the strict open refuses, because a board status has no mapping', async () => {
    liveJira();
    const paths = boardWithJira();
    editBoardConfig(paths, [{ op: 'add-status', id: 'parked', label: 'Parked' }]);
    expect(() => openRemote(loadConfig(paths).config!, 'jira')).toThrow('not every board status is mapped');

    const view = await readRemoteMapping(reload(paths), 'jira');

    expect(view.statuses.mapping.parked).toBeUndefined();
    expect(view.statuses.items).toContain('To Do');
  });

  it('reads a status that lists several states with the pushed state first', async () => {
    liveJira();
    const paths = boardWithJira();
    // A hand-written entry whose `push` names the second state of its list.
    const doc = parseDocument(readFileSync(paths.configPath, 'utf8'));
    doc.setIn(['remotes', 'jira', 'mapping', 'statuses', 'done'], {
      remote: ["Won't Fix", 'Done'],
      push: 'Done',
      closed: true,
    });
    writeFileSync(paths.configPath, doc.toString(), 'utf8');

    const view = await readRemoteMapping(reload(paths), 'jira');
    expect(view.statuses.mapping.done).toEqual(['Done', "Won't Fix"]);
  });
});

describe('writeRemoteMapping', () => {
  const types = {
    program: 'Initiative',
    epic: 'Epic',
    feature: 'Epic',
    user_story: 'Story',
    bug: 'Bug',
    test: 'Story',
    review: 'Story',
    research: 'Story',
    sub_task: 'Sub-task',
  };

  it('writes the chosen tracker type of each board type and reports each changed line', () => {
    const paths = boardWithJira();
    const { changed } = writeRemoteMapping(reload(paths), 'jira', { types });

    expect(changed).toContain('types.program: Epic → Initiative');
    expect(changed).toContain('types.test: Task → Story');
    expect(changed.some((line) => line.startsWith('types.epic'))).toBe(false);
    const written = openRemote(loadConfig(paths).config!, 'jira').mapping.types as Record<string, { remote: string }>;
    expect(Object.fromEntries(Object.entries(written).map(([type, entry]) => [type, entry.remote]))).toEqual(types);
  });

  it('keeps the flag `closed` of a status entry and writes several states as a list', () => {
    const paths = boardWithJira();
    writeRemoteMapping(reload(paths), 'jira', {
      statuses: {
        backlog: ['To Do'],
        ready: ['To Do'],
        in_progress: ['In Progress'],
        in_review: ['In Review'],
        done: ['Done', "Won't Fix"],
      },
    });

    const statuses = mappingOf(paths).statuses as Record<string, { remote: unknown; closed?: boolean }>;
    expect(statuses.done).toEqual({ remote: ['Done', "Won't Fix"], closed: true });
    expect(statuses.in_review).toEqual({ remote: 'In Review', closed: false });
  });

  it('adds the entry of a status that the board gained, with `closed` from its `terminal` flag', () => {
    const paths = boardWithJira();
    editBoardConfig(paths, [{ op: 'add-status', id: 'parked', label: 'Parked' }]);
    const current = loadConfig(paths).config!.statuses.map((status) => status.id);

    writeRemoteMapping(reload(paths), 'jira', {
      statuses: Object.fromEntries(current.map((id) => [id, [id === 'done' ? 'Done' : 'To Do']])),
    });

    expect((mappingOf(paths).statuses as Record<string, unknown>).parked).toEqual({ remote: 'To Do', closed: false });
    expect(() => openRemote(loadConfig(paths).config!, 'jira')).not.toThrow();
  });

  it('writes the period type that maps to the sprint of the tracker', () => {
    const paths = boardWithJira();
    const { changed } = writeRemoteMapping(reload(paths), 'jira', { periodContainer: 'increment' });

    expect(changed).toEqual(['periods.container: sprint → increment']);
    expect(openRemote(loadConfig(paths).config!, 'jira').mapping.periods).toEqual({
      container: 'increment',
      carrier: 'sprint',
    });
  });

  it('refuses a choice that leaves a board type or a board status with no mapping, and writes nothing', () => {
    const paths = boardWithJira();
    const before = readFileSync(paths.configPath, 'utf8');

    const { program: _dropped, ...partial } = types;
    const typeError = refusal(() => writeRemoteMapping(reload(paths), 'jira', { types: partial }));
    expect(typeError.message).toBe('Not every issue type of the board is mapped');
    expect(typeError.details[0]).toBe('Not mapped: program');

    const statusError = refusal(() =>
      writeRemoteMapping(reload(paths), 'jira', { statuses: { backlog: ['To Do'], done: [] } }),
    );
    expect(statusError.details[0]).toBe('Not mapped: ready, in_progress, in_review, done');

    expect(refusal(() => writeRemoteMapping(reload(paths), 'jira', { periodContainer: 'quarter' })).message).toBe(
      '"quarter" is not a period type of the board',
    );
    expect(readFileSync(paths.configPath, 'utf8')).toBe(before);
  });

  it('changes nothing and reports nothing when the choice is the mapping that the file holds', async () => {
    liveJira();
    const paths = boardWithJira();
    const view = await readRemoteMapping(reload(paths), 'jira');
    const before = readFileSync(paths.configPath, 'utf8');

    const { changed } = writeRemoteMapping(reload(paths), 'jira', {
      types: view.types.mapping,
      statuses: view.statuses.mapping,
      periodContainer: view.periods.container!,
    });

    expect(changed).toEqual([]);
    expect(readFileSync(paths.configPath, 'utf8')).toBe(before);
  });

  it('drops the entry of a type that the board does not declare', () => {
    const paths = boardWithJira();
    // A hand edit left a key for a type that the hierarchy does not hold.
    const doc = parseDocument(readFileSync(paths.configPath, 'utf8'));
    doc.setIn(['remotes', 'jira', 'mapping', 'types', 'ghost'], 'Task');
    writeFileSync(paths.configPath, doc.toString(), 'utf8');

    const { changed } = writeRemoteMapping(reload(paths), 'jira', { types });

    expect(changed).toContain('types.ghost: removed, the board has no such type');
    expect(mappingOf(paths).types).not.toHaveProperty('ghost');
  });
});

describe('the other providers', () => {
  it('reads a jsonfile remote, which has no list of its own and no period container', async () => {
    const paths = makeBoard('scrum', 'LP');
    addRemote(paths, { name: 'file', provider: 'jsonfile', connection: {} });

    const view = await readRemoteMapping(reload(paths), 'file');

    expect(view.problems).toEqual([]);
    expect(view.types.fixed).toBe(false);
    // The file tracker takes the words of the board, so each board type is its own name.
    expect(view.types.mapping.user_story).toBe('user_story');
    expect(view.statuses.fixed).toBe(false);
    expect(view.periods).toEqual({ native: false, carrier: null, container: null, items: null });
  });

  it('keeps the carrier of a GitHub remote when the period type changes', () => {
    vi.stubEnv('GITHUB_TOKEN', '');
    const paths = makeBoard('scrum', 'LP');
    addRemote(paths, { name: 'github', provider: 'github', connection: { repo: 'acme/payments' } });
    const before = openRemote(loadConfig(paths).config!, 'github').mapping.periods as { carrier: string };

    writeRemoteMapping(reload(paths), 'github', { periodContainer: 'increment' });

    expect(openRemote(loadConfig(paths).config!, 'github').mapping.periods).toEqual({
      container: 'increment',
      carrier: before.carrier,
    });
  });
});
