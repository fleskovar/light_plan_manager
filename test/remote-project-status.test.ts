import { afterAll, describe, expect, it } from 'vitest';
import { BoardError } from '../src/core/errors.js';
import {
  addProjectItem,
  findProjectItemId,
  planProjectStatusWrite,
  projectStatusFieldOf,
  readProjectItemFieldValue,
  resolveProjectStatus,
  setProjectItemFieldValue,
  setProjectStatusField,
  statusPrecedenceOf,
  terminalStatusOf,
} from '../src/remote/providers/github/project-status.js';
import type { ProjectGraphqlConnector, ProjectIds } from '../src/remote/providers/github/projects.js';

afterAll(() => {});

// ---------------------------------------------------------------------------
// Pure: reading the mapping
// ---------------------------------------------------------------------------

const MAPPING = {
  fields: { status: 'Status', story_points: 'Points' },
  statuses: {
    backlog: { remote: ['Backlog'], closed: false },
    in_progress: { remote: ['In Progress'], closed: false },
    done: { remote: ['Done'], closed: true },
  },
};

describe('projectStatusFieldOf / statusPrecedenceOf / terminalStatusOf', () => {
  it('reads the Project field name for the board status', () => {
    expect(projectStatusFieldOf(MAPPING)).toBe('Status');
    expect(projectStatusFieldOf({ fields: {} })).toBeUndefined();
    expect(projectStatusFieldOf({})).toBeUndefined();
  });

  it('defaults the precedence to issue, and honours project', () => {
    expect(statusPrecedenceOf(MAPPING)).toBe('issue');
    expect(statusPrecedenceOf({ status_precedence: 'project' })).toBe('project');
    expect(statusPrecedenceOf({ status_precedence: 'issue' })).toBe('issue');
  });

  it('names the terminal status from the mapping', () => {
    expect(terminalStatusOf(MAPPING)).toBe('done');
    expect(terminalStatusOf({ statuses: {} })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Pure: the push write plan
// ---------------------------------------------------------------------------

const IDS: ProjectIds = {
  project: { id: 'PVT_1', number: 7, title: 'Payments Board' },
  fields: {
    Status: {
      id: 'PVTF_status',
      name: 'Status',
      type: 'SINGLE_SELECT',
      options: { Backlog: 'OPT_backlog', 'In Progress': 'OPT_in_progress', Done: 'OPT_done' },
    },
  },
};

describe('planProjectStatusWrite', () => {
  it('resolves the option id by name', () => {
    expect(planProjectStatusWrite(IDS, 'Status', 'In Progress')).toEqual({
      field: 'Status',
      value: 'In Progress',
      optionId: 'OPT_in_progress',
      missingOption: false,
    });
  });

  it('reports a value the field has no option for', () => {
    expect(planProjectStatusWrite(IDS, 'Status', 'Blocked')).toEqual({
      field: 'Status',
      value: 'Blocked',
      missingOption: true,
    });
  });

  it('reports a field name the Project does not have', () => {
    expect(planProjectStatusWrite(IDS, 'Workflow', 'Done')).toEqual({
      field: 'Workflow',
      value: 'Done',
      missingOption: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Pure: the pull resolution
// ---------------------------------------------------------------------------

describe('resolveProjectStatus', () => {
  it('resolves an open issue from its column', () => {
    expect(resolveProjectStatus(MAPPING, { column: 'In Progress', state: 'open' })).toEqual({
      status: 'in_progress',
    });
  });

  it('resolves a closed terminal issue from its column', () => {
    expect(resolveProjectStatus(MAPPING, { column: 'Done', state: 'closed' })).toEqual({
      status: 'done',
    });
  });

  it('pulls a closed issue back as terminal even when the column was not moved (AC3)', () => {
    expect(resolveProjectStatus(MAPPING, { column: 'In Progress', state: 'closed' })).toEqual({
      status: 'done',
      discrepancy: {
        column: 'In Progress',
        state: 'closed',
        took: 'issue',
        otherStatus: 'in_progress',
      },
    });
  });

  it('lets the Project column win when the precedence says project (AC4)', () => {
    expect(
      resolveProjectStatus(MAPPING, { column: 'In Progress', state: 'closed' }, 'project'),
    ).toEqual({
      status: 'in_progress',
      discrepancy: {
        column: 'In Progress',
        state: 'closed',
        took: 'project',
        otherStatus: 'done',
      },
    });
  });

  it('forces the terminal status for a closed issue with no column at all', () => {
    expect(resolveProjectStatus(MAPPING, { state: 'closed' })).toEqual({ status: 'done' });
  });

  it('leaves the status absent when nothing resolves', () => {
    expect(resolveProjectStatus(MAPPING, {})).toEqual({});
    expect(resolveProjectStatus(MAPPING, { column: 'Unknown', state: 'open' })).toEqual({});
  });

  it('reports an open issue whose column says terminal, without inventing a status', () => {
    // The issue state (open) wins on precedence `issue`, but "open" names no
    // specific non-terminal status — so the status is left absent and the
    // disagreement is reported, never papered over.
    expect(resolveProjectStatus(MAPPING, { column: 'Done', state: 'open' })).toEqual({
      discrepancy: { column: 'Done', state: 'open', took: 'issue', otherStatus: 'done' },
    });
    expect(resolveProjectStatus(MAPPING, { column: 'Done', state: 'open' }, 'project')).toEqual({
      status: 'done',
      discrepancy: { column: 'Done', state: 'open', took: 'project' },
    });
  });
});

// ---------------------------------------------------------------------------
// The network half
// ---------------------------------------------------------------------------

/** A fake `graphql` connector answering by which document the query matches. */
function fakeGraphql(
  reply: (query: string, variables: Record<string, unknown>) => Record<string, unknown>,
) {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const connector: ProjectGraphqlConnector = {
    name: 'github',
    async graphql(query: string, variables: Record<string, unknown> = {}) {
      calls.push({ query, variables });
      return reply(query, variables);
    },
  };
  return { connector, calls };
}

describe('findProjectItemId', () => {
  it('returns the item whose project matches', async () => {
    const { connector } = fakeGraphql(() => ({
      data: {
        node: {
          projectItems: {
            nodes: [
              { id: 'PVTI_1', project: { id: 'PVT_1' } },
              { id: 'PVTI_2', project: { id: 'PVT_other' } },
            ],
          },
        },
      },
    }));

    expect(await findProjectItemId(connector, 'PVT_1', 'I_1')).toBe('PVTI_1');
  });

  it('returns null when the issue is not in the project', async () => {
    const { connector } = fakeGraphql(() => ({
      data: { node: { projectItems: { nodes: [{ id: 'PVTI_2', project: { id: 'PVT_other' } }] } } },
    }));

    expect(await findProjectItemId(connector, 'PVT_1', 'I_1')).toBeNull();
  });
});

describe('addProjectItem', () => {
  it('adds the issue by node id and returns the item id', async () => {
    const { connector, calls } = fakeGraphql(() => ({
      data: { addProjectV2ItemById: { item: { id: 'PVTI_9' } } },
    }));

    expect(await addProjectItem(connector, 'PVT_1', 'I_1')).toBe('PVTI_9');
    expect(calls[0]!.variables).toEqual({
      input: { projectId: 'PVT_1', contentId: 'I_1' },
    });
  });

  it('throws when the platform returns no item', async () => {
    const { connector } = fakeGraphql(() => ({ data: { addProjectV2ItemById: { item: null } } }));
    await expect(addProjectItem(connector, 'PVT_1', 'I_1')).rejects.toThrow(/no Project item id|Cannot add/);
  });
});

describe('setProjectItemFieldValue', () => {
  it('sends the single-select option id in the mutation input', async () => {
    const { connector, calls } = fakeGraphql(() => ({ data: {} }));

    await setProjectItemFieldValue(connector, 'PVT_1', 'PVTI_1', 'PVTF_status', 'OPT_done');
    expect(calls[0]!.query).toContain('updateProjectV2ItemFieldValue');
    expect(calls[0]!.variables).toEqual({
      input: {
        projectId: 'PVT_1',
        itemId: 'PVTI_1',
        fieldId: 'PVTF_status',
        value: { singleSelectOptionId: 'OPT_done' },
      },
    });
  });
});

describe('readProjectItemFieldValue', () => {
  it('returns the option name of the matching field', async () => {
    const { connector } = fakeGraphql(() => ({
      data: {
        node: {
          fieldValues: {
            nodes: [
              { field: { id: 'PVTF_points' }, name: '3' },
              { field: { id: 'PVTF_status' }, name: 'In Progress', optionId: 'OPT_in_progress' },
            ],
          },
        },
      },
    }));

    expect(await readProjectItemFieldValue(connector, 'PVTI_1', 'PVTF_status')).toBe('In Progress');
  });

  it('returns undefined when no field matches', async () => {
    const { connector } = fakeGraphql(() => ({
      data: { node: { fieldValues: { nodes: [{ field: { id: 'PVTF_points' }, name: '3' }] } } },
    }));

    expect(await readProjectItemFieldValue(connector, 'PVTI_1', 'PVTF_status')).toBeUndefined();
  });
});

describe('setProjectStatusField', () => {
  it('sets the value on an existing item without re-adding it', async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const connector: ProjectGraphqlConnector = {
      name: 'github',
      async graphql(query: string, variables: Record<string, unknown> = {}) {
        calls.push({ query, variables });
        if (query.includes('projectItems')) {
          return { data: { node: { projectItems: { nodes: [{ id: 'PVTI_1', project: { id: 'PVT_1' } }] } } } };
        }
        if (query.includes('updateProjectV2ItemFieldValue')) {
          return { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_1' } } } };
        }
        return { data: {} };
      },
    };

    await setProjectStatusField(connector, IDS, 'Status', 'I_1', 'Done');

    expect(calls).toHaveLength(2);
    expect(calls[0]!.query).toContain('projectItems');
    expect(calls[1]!.query).toContain('updateProjectV2ItemFieldValue');
    expect(calls[1]!.variables).toEqual({
      input: {
        projectId: 'PVT_1',
        itemId: 'PVTI_1',
        fieldId: 'PVTF_status',
        value: { singleSelectOptionId: 'OPT_done' },
      },
    });
  });

  it('adds the issue to the project first when it is not an item (AC1)', async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const connector: ProjectGraphqlConnector = {
      name: 'github',
      async graphql(query: string, variables: Record<string, unknown> = {}) {
        calls.push({ query, variables });
        if (query.includes('projectItems')) {
          return { data: { node: { projectItems: { nodes: [] } } } };
        }
        if (query.includes('addProjectV2ItemById')) {
          return { data: { addProjectV2ItemById: { item: { id: 'PVTI_9' } } } };
        }
        if (query.includes('updateProjectV2ItemFieldValue')) {
          return { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_9' } } } };
        }
        return { data: {} };
      },
    };

    await setProjectStatusField(connector, IDS, 'Status', 'I_1', 'Done');

    expect(calls.map((c) => c.query)).toEqual([
      expect.stringContaining('projectItems'),
      expect.stringContaining('addProjectV2ItemById'),
      expect.stringContaining('updateProjectV2ItemFieldValue'),
    ]);
    expect(calls[1]!.variables).toEqual({
      input: { projectId: 'PVT_1', contentId: 'I_1' },
    });
    // The set mutation addresses the freshly added item.
    expect(calls[2]!.variables).toEqual({
      input: {
        projectId: 'PVT_1',
        itemId: 'PVTI_9',
        fieldId: 'PVTF_status',
        value: { singleSelectOptionId: 'OPT_done' },
      },
    });
  });

  it('refuses a value the field has no option for, before any network call', async () => {
    const calls: Array<{ query: string }> = [];
    const connector: ProjectGraphqlConnector = {
      name: 'github',
      async graphql(query: string) {
        calls.push({ query });
        return { data: {} };
      },
    };

    await expect(setProjectStatusField(connector, IDS, 'Status', 'I_1', 'Blocked')).rejects.toThrow(
      /has no option "Blocked"/,
    );
    expect(calls).toHaveLength(0);
  });

  it('throws when the connector has no GraphQL entry point', async () => {
    await expect(
      setProjectStatusField({ name: 'github' } as ProjectGraphqlConnector, IDS, 'Status', 'I_1', 'Done'),
    ).rejects.toThrow(/no GraphQL API/);
  });
});
