import { afterAll, describe, expect, it } from 'vitest';
import { BoardError } from '../src/core/errors.js';
import { attributeDefsOf } from '../src/remote/preflight.js';
import {
  desiredProjectFields,
  planProjectProvision,
  projectDataTypeOf,
  provisionProjectGraphql,
  type DesiredProjectField,
  type ProjectProvisionPlan,
} from '../src/remote/providers/github/project-provision.js';
import type { ProjectGraphqlConnector, ProjectIds } from '../src/remote/providers/github/projects.js';
import { findProvider } from '../src/remote/registry.js';
import type { OpenedRemote } from '../src/remote/remotes.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterAll(cleanupBoards);

/** A fully valid GitHub remote declaration (the scrum template's statuses). */
function githubRemote(mapping: Record<string, unknown>): OpenedRemote {
  return {
    name: 'upstream',
    provider: findProvider('github')!,
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

const STATUSES = {
  backlog: 'Backlog',
  ready: 'Ready',
  in_progress: 'In Progress',
  in_review: 'In Review',
  done: 'Done',
};

// ---------------------------------------------------------------------------
// Field type derivation, from board vocabulary
// ---------------------------------------------------------------------------

describe('projectDataTypeOf', () => {
  const defs = attributeDefsOf(reload(makeBoard()));

  it('maps status to a single select, and title to text', () => {
    expect(projectDataTypeOf('status', defs)).toBe('SINGLE_SELECT');
    expect(projectDataTypeOf('title', defs)).toBe('TEXT');
  });

  it('maps the period to an iteration field (LP-313)', () => {
    expect(projectDataTypeOf('period', defs)).toBe('ITERATION');
  });

  it('maps an enum to a single select', () => {
    expect(projectDataTypeOf('priority', defs)).toBe('SINGLE_SELECT');
  });

  it('maps int and float to a number', () => {
    expect(projectDataTypeOf('story_points', defs)).toBe('NUMBER');
    expect(projectDataTypeOf('timebox_hours', defs)).toBe('NUMBER');
  });

  it('maps a date to a date', () => {
    expect(projectDataTypeOf('due', { due: { type: 'date' } })).toBe('DATE');
  });

  it('maps string, text, bool and unknown keys to text', () => {
    expect(projectDataTypeOf('owner', defs)).toBe('TEXT');
    expect(projectDataTypeOf('automated', defs)).toBe('TEXT');
    expect(projectDataTypeOf('anything_else', defs)).toBe('TEXT');
  });
});

// ---------------------------------------------------------------------------
// The desired fields, from the mapping
// ---------------------------------------------------------------------------

describe('desiredProjectFields', () => {
  it('derives type and ordered options for every mapped field', () => {
    const board = reload(makeBoard());
    const remote = githubRemote({
      statuses: STATUSES,
      fields: {
        status: 'Status',
        priority: 'Priority',
        story_points: 'Story Points',
        target_release: 'Target Release',
      },
    });

    const desired = desiredProjectFields(board, remote);
    const byName = Object.fromEntries(desired.map((field) => [field.name, field]));

    // status → single select, in board status order.
    expect(byName['Status']).toEqual({
      name: 'Status',
      dataType: 'SINGLE_SELECT',
      options: ['Backlog', 'Ready', 'In Progress', 'In Review', 'Done'],
    });
    // enum attribute → single select with the declared values, in order.
    expect(byName['Priority']).toEqual({
      name: 'Priority',
      dataType: 'SINGLE_SELECT',
      options: ['critical', 'high', 'medium', 'low'],
    });
    // effort attribute → number.
    expect(byName['Story Points']).toEqual({
      name: 'Story Points',
      dataType: 'NUMBER',
      options: [],
    });
    // string attribute → text.
    expect(byName['Target Release']).toEqual({
      name: 'Target Release',
      dataType: 'TEXT',
      options: [],
    });
  });

  it('uses the mapped remote status label, not the board label', () => {
    const board = reload(makeBoard());
    const remote = githubRemote({
      statuses: { ...STATUSES, done: 'Shipped' },
      fields: { status: 'Status' },
    });

    const desired = desiredProjectFields(board, remote);
    expect(desired).toEqual([
      { name: 'Status', dataType: 'SINGLE_SELECT', options: ['Backlog', 'Ready', 'In Progress', 'In Review', 'Shipped'] },
    ]);
  });

  it('deduplicates two board fields mapping to one Project field name', () => {
    const board = reload(makeBoard());
    const remote = githubRemote({
      statuses: STATUSES,
      fields: { priority: 'Priority', severity: 'Priority' },
    });

    const desired = desiredProjectFields(board, remote);
    expect(desired).toHaveLength(1);
    expect(desired[0]!.name).toBe('Priority');
  });
});

// ---------------------------------------------------------------------------
// The plan: desired minus current
// ---------------------------------------------------------------------------

/** A Project whose `Status` field exists with two of the four board options. */
const CURRENT: ProjectIds = {
  project: { id: 'PVT_1', number: 7, title: 'Payments Board' },
  fields: {
    Status: {
      id: 'PVTF_status',
      name: 'Status',
      type: 'SINGLE_SELECT',
      options: { Backlog: 'OPT_backlog', 'In Progress': 'OPT_in_progress' },
    },
  },
};

const DESIRED: DesiredProjectField[] = [
  { name: 'Status', dataType: 'SINGLE_SELECT', options: ['Backlog', 'In Progress', 'In Review', 'Done'] },
  { name: 'Priority', dataType: 'SINGLE_SELECT', options: ['critical', 'high', 'medium', 'low'] },
  { name: 'Story Points', dataType: 'NUMBER', options: [] },
];

describe('planProjectProvision', () => {
  it('creates missing fields and adds only the missing options', () => {
    const plan = planProjectProvision(CURRENT, [...DESIRED]);

    expect(plan.createFields).toEqual([
      { name: 'Priority', dataType: 'SINGLE_SELECT', options: ['critical', 'high', 'medium', 'low'] },
      { name: 'Story Points', dataType: 'NUMBER', options: [] },
    ]);

    expect(plan.addOptions).toEqual([
      {
        fieldName: 'Status',
        fieldId: 'PVTF_status',
        // Existing options are sent back with their ids; missing ones follow
        // in desired order.
        options: [
          { name: 'Backlog', id: 'OPT_backlog' },
          { name: 'In Progress', id: 'OPT_in_progress' },
          { name: 'In Review' },
          { name: 'Done' },
        ],
        missing: ['In Review', 'Done'],
      },
    ]);
    expect(plan.empty).toBe(false);
  });

  it('is empty when the Project already has everything', () => {
    const complete: ProjectIds = {
      project: CURRENT.project,
      fields: {
        Status: {
          id: 'PVTF_status',
          name: 'Status',
          type: 'SINGLE_SELECT',
          options: {
            Backlog: 'OPT_backlog',
            'In Progress': 'OPT_in_progress',
            'In Review': 'OPT_in_review',
            Done: 'OPT_done',
          },
        },
        Priority: {
          id: 'PVTF_priority',
          name: 'Priority',
          type: 'SINGLE_SELECT',
          options: {
            critical: 'OPT_critical',
            high: 'OPT_high',
            medium: 'OPT_medium',
            low: 'OPT_low',
          },
        },
        'Story Points': { id: 'PVTF_points', name: 'Story Points', type: 'NUMBER', options: {} },
      },
    };

    const plan = planProjectProvision(complete, [...DESIRED]);
    expect(plan.empty).toBe(true);
    expect(plan.createFields).toEqual([]);
    expect(plan.addOptions).toEqual([]);
  });

  it('leaves an existing field of the wrong type alone', () => {
    const wrongType: ProjectIds = {
      project: CURRENT.project,
      fields: {
        Priority: { id: 'PVTF_priority', name: 'Priority', type: 'TEXT', options: {} },
      },
    };
    const plan = planProjectProvision(wrongType, [
      { name: 'Priority', dataType: 'SINGLE_SELECT', options: ['critical', 'high'] },
    ]);

    // The field exists (wrong type), so it is neither created nor given options.
    expect(plan.createFields).toEqual([]);
    expect(plan.addOptions).toEqual([]);
    expect(plan.empty).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The network half
// ---------------------------------------------------------------------------

/** A fake `graphql` connector that records each mutation's variables. */
function fakeConnector(replies: Record<string, unknown> = {}) {
  const calls: Array<{ query: string; variables?: Record<string, unknown> }> = [];
  const connector: ProjectGraphqlConnector = {
    name: 'github',
    async graphql(query: string, variables: Record<string, unknown> = {}) {
      calls.push({ query, variables });
      if (query.includes('createProjectV2Field')) {
        return (replies.create ?? {
          data: { createProjectV2Field: { projectV2Field: { id: 'PVTF_new' } } },
        }) as Record<string, unknown>;
      }
      return (replies.update ?? {
        data: { updateProjectV2Field: { projectV2Field: { id: 'PVTF_status' } } },
      }) as Record<string, unknown>;
    },
  };
  return { connector, calls };
}

const PLAN: ProjectProvisionPlan = {
  createFields: [
    { name: 'Priority', dataType: 'SINGLE_SELECT', options: ['critical', 'high'] },
    { name: 'Story Points', dataType: 'NUMBER', options: [] },
  ],
  addOptions: [
    {
      fieldName: 'Status',
      fieldId: 'PVTF_status',
      options: [
        { name: 'Backlog', id: 'OPT_backlog' },
        { name: 'In Progress', id: 'OPT_in_progress' },
        { name: 'In Review' },
      ],
      missing: ['In Review'],
    },
  ],
  empty: false,
};

describe('provisionProjectGraphql', () => {
  it('sends one create mutation per missing field, with the right input', async () => {
    const { connector, calls } = fakeConnector();
    const outcome = await provisionProjectGraphql(connector, 'PVT_1', PLAN);

    expect(outcome).toEqual({
      created: ['Priority', 'Story Points'],
      optionsAdded: [{ field: 'Status', added: ['In Review'] }],
    });

    expect(calls).toHaveLength(3);

    // A single-select field carries its options at creation.
    expect(calls[0]!.query).toContain('createProjectV2Field');
    expect(calls[0]!.variables).toEqual({
      input: {
        projectId: 'PVT_1',
        dataType: 'SINGLE_SELECT',
        name: 'Priority',
        singleSelectOptions: [{ name: 'critical' }, { name: 'high' }],
      },
    });

    // A number field carries no options.
    expect(calls[1]!.variables).toEqual({
      input: { projectId: 'PVT_1', dataType: 'NUMBER', name: 'Story Points' },
    });

    // Adding options re-sends the whole list — existing options with their ids.
    expect(calls[2]!.query).toContain('updateProjectV2Field');
    expect(calls[2]!.variables).toEqual({
      input: {
        fieldId: 'PVTF_status',
        singleSelectOptions: [
          { name: 'Backlog', id: 'OPT_backlog' },
          { name: 'In Progress', id: 'OPT_in_progress' },
          { name: 'In Review' },
        ],
      },
    });
  });

  it('does nothing (no requests) for an empty plan', async () => {
    const { connector, calls } = fakeConnector();
    const outcome = await provisionProjectGraphql(connector, 'PVT_1', {
      createFields: [],
      addOptions: [],
      empty: true,
    });
    expect(outcome).toEqual({ created: [], optionsAdded: [] });
    expect(calls).toHaveLength(0);
  });

  it('throws naming the required scope when the credential is refused', async () => {
    const { connector } = fakeConnector({
      create: {
        data: null,
        errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }],
      },
    });

    let caught: unknown;
    try {
      await provisionProjectGraphql(connector, 'PVT_1', PLAN);
      expect.unreachable('should have thrown');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BoardError);
    const boardError = caught as BoardError;
    expect(boardError.message).toMatch(/lacks the scope/);
    expect(boardError.details.join('\n')).toMatch(/write:project/);
    expect(boardError.details.join('\n')).toContain('Resource not accessible by integration');
  });

  it('reports a non-permission GraphQL error with the raw message', async () => {
    const { connector } = fakeConnector({
      create: { data: null, errors: [{ message: 'Field name already in use' }] },
    });

    let caught: unknown;
    try {
      await provisionProjectGraphql(connector, 'PVT_1', PLAN);
      expect.unreachable('should have thrown');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BoardError);
    expect((caught as BoardError).details.join('\n')).toContain('already in use');
  });

  it('throws when the connector has no GraphQL entry point', async () => {
    await expect(
      provisionProjectGraphql({ name: 'github' } as ProjectGraphqlConnector, 'PVT_1', PLAN),
    ).rejects.toThrow(/no GraphQL API/);
  });
});
