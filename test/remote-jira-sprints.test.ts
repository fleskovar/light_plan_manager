/**
 * LP-328 — map periods to Jira sprints through a named Agile board.
 *
 * Sprints are Jira's native period container, and they belong to an Agile
 * *board*, not a project. This file asserts the story's acceptance criteria:
 *
 *   - the provider schema stamps `carrier: 'sprint'` onto `mapping.periods`;
 *   - the connector reads the board's sprints from the Agile API and matches a
 *     period to a sprint by name, writing the sprint field on create/update;
 *   - a closed sprint refuses the work, and the attempt is reported — while an
 *     issue already sitting in that closed sprint is left alone (a title edit
 *     is not a move);
 *   - a missing sprint is a provision request, never a silent no-op;
 *   - the pull resolves a sprint back to a period by name (with its dates);
 *   - the push's desired-sprints computation and the missing
 *     subtraction are pure and idempotent;
 *   - `checkRemoteConfiguration` reports "no connection.board" as "period
 *     mapping is unavailable" rather than failing at the first scheduled issue.
 *
 * Like the other Jira tests, `fetch` is stubbed and the real connector driven
 * through the real jira.js client — no network, no tokens.
 */

import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPeriod, type LoadedBoard } from '../src/core/index.js';
import { jiraConfigSchema } from '../src/remote/providers/jira/config.js';
import { jiraConnector } from '../src/remote/providers/jira/connector.js';
import {
  isClosedSprint,
  missingSprints,
  parseSprints,
  sprintByName,
  sprintFieldIdOf,
  SPRINT_FIELD_TYPE,
} from '../src/remote/providers/jira/sprints.js';
import { describeRequest, fieldsFromRecord } from '../src/remote/providers/jira/translator.js';
import { checkRemoteConfiguration } from '../src/remote/check.js';
import { desiredSprintsOf } from '../src/remote/provision.js';
import type { OpenedRemote } from '../src/remote/remotes.js';
import type { PeriodIndex } from '../src/remote/periods.js';
import { readFileSync } from 'node:fs';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const SITE = 'https://acme.atlassian.net';
const CONNECTION = { site: SITE, project: 'PAY', board: '34', email: 'me@acme.com', token: 'api-token' };

/** The sprint field as `GET /rest/api/3/field` returns it (parsed into a `JiraField`). */
const SPRINT_FIELD = {
  id: 'customfield_10020',
  name: 'Sprint',
  custom: true,
  schemaType: 'array',
  customType: SPRINT_FIELD_TYPE,
};

/** The board's sprints, one in each state. */
const SPRINTS = [
  { id: 37, state: 'active', name: 'Sprint 1', startDate: '2026-01-01', endDate: '2026-01-14' },
  { id: 38, state: 'future', name: 'Sprint 2', startDate: '2026-01-15', endDate: '2026-01-28' },
  { id: 30, state: 'closed', name: 'Sprint 0', startDate: '2025-12-01', endDate: '2025-12-14', completeDate: '2025-12-14T17:00:00.000Z' },
];

// ---------------------------------------------------------------------------
// Pure helpers (sprints.ts)
// ---------------------------------------------------------------------------

describe('parseSprints', () => {
  it('parses the Agile board-sprint page into sprints with name, state and dates', () => {
    const parsed = parseSprints({ values: SPRINTS, isLast: true, startAt: 0, maxResults: 50 });
    expect(parsed).toEqual([
      { id: '37', name: 'Sprint 1', state: 'active', starts: '2026-01-01', ends: '2026-01-14' },
      { id: '38', name: 'Sprint 2', state: 'future', starts: '2026-01-15', ends: '2026-01-28' },
      { id: '30', name: 'Sprint 0', state: 'closed', starts: '2025-12-01', ends: '2025-12-14', completeDate: '2025-12-14T17:00:00.000Z' },
    ]);
  });

  it('drops entries with no id or no name', () => {
    expect(parseSprints({ values: [{ id: 1 }, { name: 'No id' }, { id: 2, name: 'Kept', state: 'active' }] })).toEqual([
      { id: '2', name: 'Kept', state: 'active' },
    ]);
  });

  it('reads dates whether they arrive as strings or as Dates the client coerced', () => {
    const parsed = parseSprints({
      values: [
        { id: 1, name: 'S', state: 'future', startDate: new Date('2026-01-01'), endDate: new Date('2026-01-14'), completeDate: new Date('2026-01-14T17:00:00.000Z') },
      ],
    });
    expect(parsed[0]!.starts).toBe('2026-01-01');
    expect(parsed[0]!.ends).toBe('2026-01-14');
    expect(parsed[0]!.completeDate).toBe('2026-01-14T17:00:00.000Z');
  });
});

describe('isClosedSprint / sprintByName / sprintFieldIdOf', () => {
  it('tells a closed sprint from a future or active one', () => {
    expect(isClosedSprint({ id: '30', name: 'Sprint 0', state: 'closed' })).toBe(true);
    expect(isClosedSprint({ id: '38', name: 'Sprint 2', state: 'future' })).toBe(false);
    expect(isClosedSprint({ id: '37', name: 'Sprint 1', state: 'active' })).toBe(false);
  });

  it('matches a sprint by name', () => {
    expect(sprintByName(parseSprints({ values: SPRINTS }), 'Sprint 2')?.id).toBe('38');
    expect(sprintByName(parseSprints({ values: SPRINTS }), 'Nope')).toBeUndefined();
  });

  it('finds the sprint field id by its custom field type key', () => {
    expect(sprintFieldIdOf([SPRINT_FIELD])).toBe('customfield_10020');
    expect(
      sprintFieldIdOf([
        { id: 'customfield_10016', customType: 'com.atlassian.jira.plugin.system.customfieldtypes:float' },
      ]),
    ).toBeUndefined();
  });
});

describe('missingSprints', () => {
  it('subtracts the board sprints from the desired ones, idempotently', () => {
    const desired = [
      { name: 'Sprint 1', starts: '2026-01-01', ends: '2026-01-14' },
      { name: 'Sprint 3', starts: '2026-01-29', ends: '2026-02-11' },
    ];
    const existing = parseSprints({ values: SPRINTS });
    expect(missingSprints(desired, existing)).toEqual([
      { name: 'Sprint 3', starts: '2026-01-29', ends: '2026-02-11' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Config schema: the sprint carrier is stamped, never user-chosen
// ---------------------------------------------------------------------------

describe('jiraConfigSchema periods', () => {
  it('stamps carrier: sprint onto a container-only periods block', () => {
    const result = jiraConfigSchema.safeParse({
      connection: { site: SITE, project: 'PAY', board: 34 },
      mapping: { periods: { container: 'sprint' } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mapping.periods).toEqual({ container: 'sprint', carrier: 'sprint' });
    }
  });
});

// ---------------------------------------------------------------------------
// Translator: period → sprint on push, sprint → period on pull
// ---------------------------------------------------------------------------

const MAPPING = {
  types: { user_story: { remote: 'Story' } },
  statuses: { backlog: { remote: ['Backlog'] } },
  periods: { container: 'sprint', carrier: 'sprint' },
};

/** A two-level timeline index: an increment holding a sprint. */
function sprintIndex(): PeriodIndex {
  return new Map([
    ['TL-1', { id: 'TL-1', title: 'PI-1', type: 'increment', parentId: null, starts: '2026-01-01', ends: '2026-03-31' }],
    ['TL-2', { id: 'TL-2', title: 'Sprint 1', type: 'sprint', parentId: 'TL-1', starts: '2026-01-01', ends: '2026-01-14' }],
  ]);
}

describe('jiraTranslator: sprint push/pull (LP-328)', () => {
  const op = (fields: Record<string, unknown>) => ({
    kind: 'create' as const,
    localId: 'LP-1',
    fields: { type: 'user_story', status: 'backlog', ...fields },
  });

  it('resolves an issue in a sprint to a container with its dates, and the increment to a degraded level', () => {
    const { request, periodGaps } = describeRequest(
      op({ period: 'TL-2' }),
      MAPPING,
      {},
      new Map(),
      sprintIndex(),
    );
    expect(request.period).toEqual({ name: 'Sprint 1', starts: '2026-01-01', ends: '2026-01-14' });
    expect(request.degradedPeriods).toEqual([{ type: 'increment', name: 'PI-1' }]);
    expect(periodGaps).toEqual([]);
  });

  it('leaves the sprint untouched when the op carries no period', () => {
    const { request } = describeRequest(op({}), MAPPING, {}, new Map(), sprintIndex());
    expect(request.period).toBeUndefined();
  });

  it('reports a period id not on the timeline rather than dropping it', () => {
    const { periodGaps } = describeRequest(op({ period: 'TL-999' }), MAPPING, {}, new Map(), sprintIndex());
    expect(periodGaps).toEqual([{ periodId: 'TL-999', reason: 'not on the timeline' }]);
  });

  it('pulls a sprint back as a period change, with the observed dates', () => {
    const record = {
      fields: { summary: 'A story' },
      sprint: { name: 'Sprint 1', starts: '2026-01-01', ends: '2026-01-14' },
    };
    const result = fieldsFromRecord(record, MAPPING, {}, new Map(), sprintIndex());
    expect(result.patch.period).toBe('TL-2');
    expect(result.period?.periodId).toBe('TL-2');
    expect(result.period?.starts).toBe('2026-01-01');
    expect(result.period?.ends).toBe('2026-01-14');
  });

  it('reports a sprint matching no local period, never invents one', () => {
    const record = {
      fields: { summary: 'A story' },
      sprint: { name: 'Sprint 9' },
    };
    const result = fieldsFromRecord(record, MAPPING, {}, new Map(), sprintIndex());
    expect(result.patch.period).toBeUndefined();
    expect(result.period?.unresolved).toBe('unmapped');
    expect(result.period?.missing?.containerName).toBe('Sprint 9');
  });
});

// ---------------------------------------------------------------------------
// A sub-task's sprint belongs to its parent
// ---------------------------------------------------------------------------

/**
 * Jira does not let a sub-task be scheduled on its own: it reports the
 * **parent's** sprint on the sub-task, the identical object, whether or not
 * anything ever wrote it there. Read as the sub-task's own value it is a remote
 * edit nobody made.
 *
 * This was live on this repository's own board and its shape is why it went
 * unnoticed for so long: all 13 sub-tasks were reported `behind` on `period`,
 * permanently and identically, because the board schedules the story and Jira
 * echoes that sprint down onto each of its children. Verified against Jira's own
 * payload before it was fixed — `SCRUM-1385` (Subtask) and its parent
 * `SCRUM-1225` (Story) returned the same `customfield_10020` entry.
 */
describe('jiraTranslator: a sub-task does not own its sprint', () => {
  const subtask = (sprint: unknown) => ({
    fields: { summary: 'A sub-task', issuetype: { name: 'Subtask', subtask: true } },
    sprint,
  });

  it('never reads a sprint back off a sub-task', () => {
    const result = fieldsFromRecord(
      subtask({ name: 'Sprint 1', starts: '2026-01-01', ends: '2026-01-14' }),
      MAPPING,
      {},
      new Map(),
      sprintIndex(),
    );

    // No value at all, rather than null: the field is not mirrored for this
    // record, so `baseFromRecord` keeps the board's own value and neither side
    // ever disagrees. A `null` here would read as "the remote cleared it".
    expect(result.patch.period).toBeUndefined();
    expect('period' in result.patch).toBe(false);
    expect(result.period).toBeUndefined();
  });

  it('still reads it off a standard issue in the same listing', () => {
    // The guard is the sub-task marker and nothing broader: the sprint is still
    // mirrored, by the document that actually owns it.
    const story = {
      fields: { summary: 'A story', issuetype: { name: 'Story', subtask: false } },
      sprint: { name: 'Sprint 1', starts: '2026-01-01', ends: '2026-01-14' },
    };
    const result = fieldsFromRecord(story, MAPPING, {}, new Map(), sprintIndex());
    expect(result.patch.period).toBe('TL-2');
  });

  it('reads Jira\'s own marker, not the type name', () => {
    // A project may rename or localise its sub-task type, and the board's type
    // name says nothing about what Jira thinks. `issuetype.subtask` is the
    // documented boolean, so a renamed sub-task type is still caught — and a
    // standard type merely *called* something sub-task-ish is not.
    const renamed = {
      fields: { summary: 'Child', issuetype: { name: 'Untertask', subtask: true } },
      sprint: { name: 'Sprint 1' },
    };
    expect(fieldsFromRecord(renamed, MAPPING, {}, new Map(), sprintIndex()).patch.period)
      .toBeUndefined();

    const misleadingName = {
      fields: { summary: 'Not a child', issuetype: { name: 'Subtask-ish', subtask: false } },
      sprint: { name: 'Sprint 1', starts: '2026-01-01', ends: '2026-01-14' },
    };
    expect(fieldsFromRecord(misleadingName, MAPPING, {}, new Map(), sprintIndex()).patch.period)
      .toBe('TL-2');
  });

  it('leaves every other field of a sub-task mirrored', () => {
    // Only the sprint is derived. Narrowing this to the whole record would stop
    // a sub-task's title or status ever being pulled.
    const result = fieldsFromRecord(
      {
        fields: {
          summary: 'A sub-task',
          issuetype: { name: 'Subtask', subtask: true },
          status: { name: 'Backlog' },
        },
        sprint: { name: 'Sprint 1' },
      },
      MAPPING,
      {},
      new Map(),
      sprintIndex(),
    );
    expect(result.patch.title).toBe('A sub-task');
    expect(result.patch.status).toBe('backlog');
    expect(result.patch.period).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Connector: sprint write, closed guard, enrichment, provision surface
// ---------------------------------------------------------------------------

/** A fetch stub over the sprint-related endpoints, capturing the create body. */
function sprintFetch(overrides: {
  issueSprint?: Record<string, unknown> | null;
  searchIssues?: Array<Record<string, unknown>>;
} = {}) {
  const calls: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      url,
      body: init?.body !== undefined ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });

    if (method === 'GET' && url.endsWith('/rest/api/3/field')) {
      // The raw `GET /rest/api/3/field` shape — `schema.custom` is what
      // `parseFields` reads into `customType`.
      return new Response(
        JSON.stringify([{ id: 'customfield_10020', name: 'Sprint', custom: true, schema: { type: 'array', custom: SPRINT_FIELD_TYPE } }]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (method === 'GET' && url.includes('/rest/agile/1.0/board/34/sprint')) {
      return new Response(JSON.stringify({ values: SPRINTS, isLast: true, startAt: 0, maxResults: 50 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (method === 'POST' && url.endsWith('/rest/agile/1.0/sprint')) {
      return new Response(JSON.stringify({ id: 39, name: 'Sprint 3', state: 'future' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (method === 'POST' && url.endsWith('/rest/api/3/issue')) {
      return new Response(JSON.stringify({ id: '10042', key: 'PAY-418', self: `${SITE}/rest/api/3/issue/10042` }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (method === 'PUT' && /\/rest\/api\/3\/issue\/\d+$/.test(url)) {
      // Jira answers a field edit with 204 and no body.
      return new Response(null, { status: 204 });
    }
    if (method === 'GET' && /\/rest\/api\/3\/issue\/\d+$/.test(url)) {
      const sprint = overrides.issueSprint;
      const fields: Record<string, unknown> = { updated: '2026-09-01T00:00:00Z' };
      if (sprint !== undefined) fields['customfield_10020'] = sprint;
      return new Response(JSON.stringify({ id: '10042', key: 'PAY-418', fields }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (method === 'POST' && url.endsWith('/rest/api/3/search/jql')) {
      return new Response(JSON.stringify({ issues: overrides.searchIssues ?? [], nextPageToken: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  return { calls, fetch };
}

describe('jiraConnector: sprint write (LP-328)', () => {
  it('writes the sprint field on create, resolving the period name to its sprint id', async () => {
    const { calls, fetch } = sprintFetch();
    vi.stubGlobal('fetch', fetch);

    const connector = jiraConnector(CONNECTION, { periods: { container: 'sprint', carrier: 'sprint' } });
    await connector.create({
      kind: 'create',
      type: 'Story',
      title: 'A story',
      period: { name: 'Sprint 1', starts: '2026-01-01', ends: '2026-01-14' },
    });

    const create = calls.find((call) => call.method === 'POST' && call.url.endsWith('/rest/api/3/issue'))!;
    expect((create.body.fields as Record<string, unknown>)['customfield_10020']).toBe(37);
  });

  it('refuses a closed sprint on create, reporting the attempt', async () => {
    const { fetch } = sprintFetch();
    vi.stubGlobal('fetch', fetch);

    const connector = jiraConnector(CONNECTION, { periods: { container: 'sprint', carrier: 'sprint' } });
    await expect(
      connector.create({ kind: 'create', type: 'Story', title: 'A story', period: { name: 'Sprint 0' } }),
    ).rejects.toThrow(/Cannot move work into sprint "Sprint 0" — it is closed/);
  });

  it('files the issue unscheduled when the sprint is not there yet, and says so', async () => {
    // The board's work and the board's timeline are pushed independently. A
    // story scheduled into a sprint Jira has not got is filed *unscheduled*
    // rather than refused — refusing made the whole timeline a precondition of
    // filing a single story, which is how one over-long sprint name blocked a
    // board of forty issues.
    const { calls, fetch } = sprintFetch();
    vi.stubGlobal('fetch', fetch);

    const connector = jiraConnector(CONNECTION, { periods: { container: 'sprint', carrier: 'sprint' } });
    const result = await connector.create({
      kind: 'create',
      type: 'Story',
      title: 'A story',
      period: { name: 'Sprint 9' },
    });

    // Filed, and the dropped field named — that is what the executor records
    // as unset, so the next push writes it once the sprint exists.
    expect(result.remoteId).toBeTruthy();
    expect(result.unwritten).toEqual(['period']);

    // The create carried no sprint field at all.
    const create = calls.find((call) => call.method === 'POST' && call.url.endsWith('/rest/api/3/issue'))!;
    const fields = (create.body as { fields: Record<string, unknown> }).fields;
    expect(Object.keys(fields).some((key) => key.startsWith('customfield_'))).toBe(false);
  });

  it('writes the sprint the moment it does exist', async () => {
    // The other half of the same rule: nothing is dropped when the sprint is
    // there, so a re-push after the sprint is filed lands the assignment.
    const { calls, fetch } = sprintFetch();
    vi.stubGlobal('fetch', fetch);

    const connector = jiraConnector(CONNECTION, { periods: { container: 'sprint', carrier: 'sprint' } });
    const result = await connector.create({
      kind: 'create',
      type: 'Story',
      title: 'A story',
      period: { name: 'Sprint 1' },
    });

    expect(result.unwritten).toBeUndefined();
    const create = calls.find((call) => call.method === 'POST' && call.url.endsWith('/rest/api/3/issue'))!;
    const fields = (create.body as { fields: Record<string, unknown> }).fields;
    expect(Object.values(fields)).toContain(37);
  });

  it('leaves an issue already in a closed sprint alone on update (not a move)', async () => {
    const { calls, fetch } = sprintFetch({
      issueSprint: { id: 30, name: 'Sprint 0', state: 'closed' },
    });
    vi.stubGlobal('fetch', fetch);

    const connector = jiraConnector(CONNECTION, { periods: { container: 'sprint', carrier: 'sprint' } });
    await connector.update('10042', {
      kind: 'update',
      type: 'Story',
      title: 'Renamed',
      period: { name: 'Sprint 0' },
    });

    // No closed-sprint refusal: the title update landed, and no sprint field
    // was re-written for the closed sprint the issue is already in.
    const put = calls.find((call) => call.method === 'PUT' && call.url.includes('/rest/api/3/issue/'));
    expect(put).toBeDefined();
    expect((put!.body.fields as Record<string, unknown>)['customfield_10020']).toBeUndefined();
  });

  it('refuses an update that moves the issue into a closed sprint', async () => {
    const { fetch } = sprintFetch({
      issueSprint: { id: 37, name: 'Sprint 1', state: 'active' },
    });
    vi.stubGlobal('fetch', fetch);

    const connector = jiraConnector(CONNECTION, { periods: { container: 'sprint', carrier: 'sprint' } });
    await expect(
      connector.update('10042', { kind: 'update', type: 'Story', title: 'Renamed', period: { name: 'Sprint 0' } }),
    ).rejects.toThrow(/Cannot move work into sprint "Sprint 0" — it is closed/);
  });

  it('lists sprints and creates a future sprint through the Agile API', async () => {
    const { calls, fetch } = sprintFetch();
    vi.stubGlobal('fetch', fetch);

    const connector = jiraConnector(CONNECTION, { periods: { container: 'sprint', carrier: 'sprint' } });
    const sprints = await connector.listSprints!();
    expect(sprints.map((s) => s.name)).toEqual(['Sprint 1', 'Sprint 2', 'Sprint 0']);

    const created = await connector.createSprint!('Sprint 3', '2026-01-29', '2026-02-11');
    expect(created).toEqual({ id: '39' });

    const createSprintCall = calls.find((call) => call.method === 'POST' && call.url.endsWith('/rest/agile/1.0/sprint'))!;
    // A board period's dates are inclusive calendar days; a Jira sprint is a
    // pair of instants and requires start < end. So the start is the beginning
    // of its day and the end is the end of its day — which is what the board
    // meant, and what stops a one-day sprint (`starts === ends`, an ordinary
    // thing to have) being refused outright.
    expect(createSprintCall.body).toEqual({
      name: 'Sprint 3',
      originBoardId: 34,
      startDate: '2026-01-29T00:00:00.000Z',
      endDate: '2026-02-11T23:59:59.000Z',
    });
  });

  it('enriches a listed issue with its sprint so the pull resolves the period', async () => {
    const { fetch } = sprintFetch({
      searchIssues: [
        {
          id: '10042',
          key: 'PAY-418',
          fields: {
            updated: '2026-09-01T00:00:00Z',
            customfield_10020: { id: 37, name: 'Sprint 1', state: 'active', startDate: '2026-01-01', endDate: '2026-01-14' },
          },
        },
      ],
    });
    vi.stubGlobal('fetch', fetch);

    const connector = jiraConnector(CONNECTION, { periods: { container: 'sprint', carrier: 'sprint' } });
    const page = await connector.list();
    expect(page.records[0]!['sprint']).toEqual({
      name: 'Sprint 1',
      state: 'active',
      starts: '2026-01-01',
      ends: '2026-01-14',
    });
  });
});

// ---------------------------------------------------------------------------
// Provision: desired sprints from the timeline, minus the board's existing
// ---------------------------------------------------------------------------

describe('desiredSprintsOf', () => {
  function boardWithSprints(): LoadedBoard {
    const paths = makeBoard('scrum', 'LP');
    createPeriod(reload(paths), { type: 'increment', title: 'PI-1', starts: '2026-01-01', ends: '2026-03-31' });
    createPeriod(reload(paths), { type: 'sprint', title: 'Sprint 1', starts: '2026-01-01', ends: '2026-01-14', parentId: 'TL-1' });
    createPeriod(reload(paths), { type: 'sprint', title: 'Sprint 3', starts: '2026-01-29', ends: '2026-02-11', parentId: 'TL-1' });
    return reload(paths);
  }

  const remote = {
    name: 'jira',
    provider: null as unknown as OpenedRemote['provider'],
    direction: 'both',
    on_delete: 'unlink',
    conflict: 'manual',
    fields: {},
    encoding: 'block',
    comments: 'push',
    connection: { site: SITE, project: 'PAY', board: '34' },
    mapping: { periods: { container: 'sprint', carrier: 'sprint' } },
  } as unknown as OpenedRemote;

  it('lists the mapped-level periods as desired sprints, with their dates', () => {
    const desired = desiredSprintsOf(boardWithSprints(), remote);
    expect(desired).toEqual([
      { name: 'Sprint 1', starts: '2026-01-01', ends: '2026-01-14' },
      { name: 'Sprint 3', starts: '2026-01-29', ends: '2026-02-11' },
    ]);
  });

  it('returns nothing when no period mapping is declared', () => {
    const board = boardWithSprints();
    expect(
      desiredSprintsOf(board, { ...remote, mapping: {} } as unknown as OpenedRemote),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// checkRemoteConfiguration: no board → period mapping unavailable
// ---------------------------------------------------------------------------

describe('checkRemoteConfiguration: sprint mapping needs a board', () => {
  function jiraRemote(extra: { board?: string } = {}): string {
    const board = extra.board !== undefined ? `      board: ${extra.board}\n` : '';
    return `
remotes:
  jira:
    provider: jira
    on_delete: unlink
    conflict: manual
    connection:
      site: https://acme.atlassian.net
      project: PAY
      email: \${JIRA_EMAIL}
      token: \${JIRA_API_TOKEN}
${board}    mapping:
      types: { user_story: { type: Story } }
      statuses: { backlog: Backlog, ready: Ready, in_progress: In Progress, in_review: In Review, done: { remote: Done, closed: true } }
      periods: { container: sprint }
`;
  }

  function boardWith(remotes: string): LoadedBoard {
    const paths = makeBoard('scrum', 'LP');
    writeFileSync(paths.configPath, `${readFileSync(paths.configPath, 'utf8')}\n${remotes}\n`, 'utf8');
    return reload(paths);
  }

  it('reports period mapping as unavailable when connection.board is absent', () => {
    const problems = checkRemoteConfiguration(boardWith(jiraRemote()));
    const problem = problems.find((p) => p.message.includes('connection.board'));
    expect(problem).toBeDefined();
    expect(problem!.level).toBe('error');
    expect(problem!.message).toBe(
      'remotes.jira.mapping.periods: sprint mapping needs connection.board — sprints belong to an Agile board, so without a board id period mapping is unavailable',
    );
  });

  it('is silent when connection.board is present', () => {
    const problems = checkRemoteConfiguration(boardWith(jiraRemote({ board: '34' })));
    expect(problems.find((p) => p.message.includes('connection.board'))).toBeUndefined();
  });
});

describe('a one-day sprint (the Jira round trip)', () => {
  it('sends an inclusive end date as the end of its day, so start < end holds', async () => {
    // A board may legitimately run a one-day sprint (`starts === ends`). Sent
    // as bare dates that is `start === end`, which Jira refuses outright with
    // "The start date of a sprint must be before the end date" — so a real
    // board could not file its own timeline.
    const { calls, fetch } = sprintFetch();
    vi.stubGlobal('fetch', fetch);
    const connector = jiraConnector(CONNECTION, { periods: { container: 'sprint', carrier: 'sprint' } });

    await connector.createSprint!('One day', '2026-07-31', '2026-07-31');

    const body = calls.find((call) => call.url.endsWith('/rest/agile/1.0/sprint'))!.body as {
      startDate: string;
      endDate: string;
    };
    expect(body.startDate).toBe('2026-07-31T00:00:00.000Z');
    expect(body.endDate).toBe('2026-07-31T23:59:59.000Z');
    expect(body.startDate < body.endDate).toBe(true);
  });

  it('passes a value that already carries a time straight through', async () => {
    // A caller that has been explicit is not second-guessed.
    const { calls, fetch } = sprintFetch();
    vi.stubGlobal('fetch', fetch);
    const connector = jiraConnector(CONNECTION, { periods: { container: 'sprint', carrier: 'sprint' } });

    await connector.createSprint!('Explicit', '2026-07-31T09:00:00.000Z', '2026-08-04T17:30:00.000Z');

    const body = calls.find((call) => call.url.endsWith('/rest/agile/1.0/sprint'))!.body as {
      startDate: string;
      endDate: string;
    };
    expect(body.startDate).toBe('2026-07-31T09:00:00.000Z');
    expect(body.endDate).toBe('2026-08-04T17:30:00.000Z');
  });
});
