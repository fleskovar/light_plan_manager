import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  detectMismatches,
  loadProjectCache,
  projectCachePath,
  resolveProjectGraphql,
  resolveProjectIds,
  saveProjectCache,
  type ProjectCacheFile,
  type ProjectGraphqlConnector,
} from '../src/remote/providers/github/projects.js';
import { githubConfigSchema } from '../src/remote/providers/github/config.js';
import { BoardError } from '../src/core/errors.js';
import { cleanupBoards, makeBoard } from './helpers.js';

afterAll(cleanupBoards);

// ---------------------------------------------------------------------------
// Canned GraphQL responses, in the shape GitHub's GraphQL API returns.
// ---------------------------------------------------------------------------

const CONNECTION = { repo: 'acme/payments', token: 'secret' };

const PROJECT_BY_NUMBER = {
  data: {
    repository: {
      projectV2: { id: 'PVT_1', number: 7, title: 'Payments Board' },
    },
  },
};

const PROJECTS_BY_TITLE = {
  data: {
    repository: {
      projectsV2: {
        nodes: [{ id: 'PVT_1', number: 7, title: 'Payments Board' }],
      },
    },
  },
};

const FIELDS = {
  data: {
    node: {
      fields: {
        nodes: [
          {
            id: 'PVTF_status',
            name: 'Status',
            dataType: 'SINGLE_SELECT',
            options: {
              nodes: [
                { id: 'OPT_backlog', name: 'Backlog' },
                { id: 'OPT_in_progress', name: 'In Progress' },
                { id: 'OPT_done', name: 'Done' },
              ],
            },
          },
          { id: 'PVTF_points', name: 'Story Points', dataType: 'NUMBER' },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  },
};

/**
 * A fake `graphql` connector that answers by the variables the resolver sends:
 * a `number` means the by-number project query, a `projectId` the fields query,
 * anything else the by-title project query. Each answer is overridable so a
 * test can simulate a rename, a miss, or an error.
 */
function fakeConnector(overrides: {
  projectByNumber?: Record<string, unknown>;
  projectsByTitle?: Record<string, unknown>;
  fields?: Record<string, unknown>;
} = {}) {
  const calls: Array<{ query: string; variables?: Record<string, unknown> }> = [];
  const connector: ProjectGraphqlConnector = {
    name: 'github',
    async graphql(query: string, variables: Record<string, unknown> = {}) {
      calls.push({ query, variables });
      if (typeof variables.number === 'number') {
        return overrides.projectByNumber ?? PROJECT_BY_NUMBER;
      }
      if (typeof variables.projectId === 'string') {
        return overrides.fields ?? FIELDS;
      }
      return overrides.projectsByTitle ?? PROJECTS_BY_TITLE;
    },
  };
  return { connector, calls };
}

const INPUT = { repo: 'acme/payments', project: 7, fields: { status: 'Status', effort: 'Story Points' } };

/** The resolved ids the canned data produces. */
const EXPECTED_IDS = {
  project: { id: 'PVT_1', number: 7, title: 'Payments Board' },
  fields: {
    Status: {
      id: 'PVTF_status',
      name: 'Status',
      type: 'SINGLE_SELECT',
      options: {
        Backlog: 'OPT_backlog',
        'In Progress': 'OPT_in_progress',
        Done: 'OPT_done',
      },
    },
    'Story Points': { id: 'PVTF_points', name: 'Story Points', type: 'NUMBER', options: {} },
  },
};

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

describe('githubConfigSchema project and fields', () => {
  it('accepts a Project by number and a fields mapping', () => {
    const result = githubConfigSchema.safeParse({
      connection: CONNECTION,
      mapping: { project: 7, fields: { status: 'Status', priority: 'Priority' } },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.mapping.project).toBe(7);
    expect(result.data.mapping.fields).toEqual({ status: 'Status', priority: 'Priority' });
  });

  it('accepts a Project by title', () => {
    const result = githubConfigSchema.safeParse({
      connection: CONNECTION,
      mapping: { project: 'Payments Board' },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.mapping.project).toBe('Payments Board');
  });

  it('rejects a zero or negative Project number', () => {
    expect(
      githubConfigSchema.safeParse({ connection: CONNECTION, mapping: { project: 0 } }).success,
    ).toBe(false);
  });

  it('rejects an empty field value', () => {
    expect(
      githubConfigSchema.safeParse({
        connection: CONNECTION,
        mapping: { project: 7, fields: { status: '' } },
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The network half
// ---------------------------------------------------------------------------

describe('resolveProjectGraphql', () => {
  it('resolves a Project by number and its fields and options', async () => {
    const { connector, calls } = fakeConnector();
    const ids = await resolveProjectGraphql(connector, INPUT);

    expect(ids).toEqual(EXPECTED_IDS);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.variables).toMatchObject({ owner: 'acme', name: 'payments', number: 7 });
    expect(calls[1]!.variables).toEqual({ projectId: 'PVT_1' });
  });

  it('resolves a Project by title', async () => {
    const { connector } = fakeConnector();
    const ids = await resolveProjectGraphql(connector, { ...INPUT, project: 'Payments Board' });

    expect(ids.project.id).toBe('PVT_1');
    expect(ids.project.number).toBe(7);
  });

  it('reports a Project number that resolves to nothing', async () => {
    const { connector } = fakeConnector({
      projectByNumber: { data: { repository: { projectV2: null } } },
    });
    await expect(resolveProjectGraphql(connector, INPUT)).rejects.toThrow(/No Project #7/);
  });

  it('reports a Project title that matches nothing', async () => {
    const { connector } = fakeConnector({
      projectsByTitle: { data: { repository: { projectsV2: { nodes: [] } } } },
    });
    await expect(
      resolveProjectGraphql(connector, { ...INPUT, project: 'Nope' }),
    ).rejects.toThrow(/No Project named "Nope"/);
  });

  it('throws when the connector has no GraphQL entry point', async () => {
    await expect(
      resolveProjectGraphql({ name: 'github' } as ProjectGraphqlConnector, INPUT),
    ).rejects.toThrow(/no GraphQL API/);
  });

  it('throws when no Project is declared', async () => {
    const { connector } = fakeConnector();
    await expect(resolveProjectGraphql(connector, { repo: 'acme/payments', fields: {} })).rejects.toThrow(
      /No Project declared/,
    );
  });
});

// ---------------------------------------------------------------------------
// The orchestrator + cache
// ---------------------------------------------------------------------------

describe('resolveProjectIds', () => {
  it('resolves once, caches, and reads the cache on the next call without a request', async () => {
    const paths = makeBoard();
    const { connector, calls } = fakeConnector();

    const first = await resolveProjectIds(connector, INPUT, paths, 'upstream');
    expect(first.refreshed).toBe(true);
    expect(first.ids).toEqual(EXPECTED_IDS);
    expect(calls).toHaveLength(2);

    // Second call: a cache hit — no network.
    const second = await resolveProjectIds(connector, INPUT, paths, 'upstream');
    expect(second.refreshed).toBe(false);
    expect(second.ids).toEqual(EXPECTED_IDS);
    expect(calls).toHaveLength(2);

    // The cache is committed under .lpm/remotes/<name>/github.json.
    const cached = loadProjectCache(paths, 'upstream');
    expect(cached).toBeDefined();
    expect(cached!.project.id).toBe('PVT_1');
    expect(Object.keys(cached!.fields).sort()).toEqual(['Status', 'Story Points']);
  });

  it('re-resolves on --refresh even when the cache exists', async () => {
    const paths = makeBoard();
    const { connector, calls } = fakeConnector();
    await resolveProjectIds(connector, INPUT, paths, 'upstream');
    expect(calls).toHaveLength(2);

    const refreshed = await resolveProjectIds(connector, INPUT, paths, 'upstream', { refresh: true });
    expect(refreshed.refreshed).toBe(true);
    expect(calls).toHaveLength(4);
  });

  it('detects a renamed field, reporting both names', async () => {
    const paths = makeBoard();
    const { connector } = fakeConnector();
    await resolveProjectIds(connector, INPUT, paths, 'upstream');

    // The same field id, now renamed upstream.
    const renamedFields = {
      data: {
        node: {
          fields: {
            nodes: [
              {
                id: 'PVTF_status',
                name: 'Workflow',
                dataType: 'SINGLE_SELECT',
                options: { nodes: [] },
              },
              { id: 'PVTF_points', name: 'Story Points', dataType: 'NUMBER' },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    };
    const result = await resolveProjectIds(
      fakeConnector({ fields: renamedFields }).connector,
      INPUT,
      paths,
      'upstream',
      { refresh: true },
    );

    expect(result.fieldFindings).toEqual([
      { kind: 'renamed', name: 'Status', id: 'PVTF_status', newName: 'Workflow' },
    ]);
    expect(result.optionFindings).toEqual([]);
  });

  it('detects a renamed option, reporting both names', async () => {
    const paths = makeBoard();
    const { connector } = fakeConnector();
    await resolveProjectIds(connector, INPUT, paths, 'upstream');

    const renamedOptions = {
      data: {
        node: {
          fields: {
            nodes: [
              {
                id: 'PVTF_status',
                name: 'Status',
                dataType: 'SINGLE_SELECT',
                options: {
                  nodes: [
                    { id: 'OPT_backlog', name: 'Backlog (new)' },
                    { id: 'OPT_in_progress', name: 'In Progress' },
                    { id: 'OPT_done', name: 'Done' },
                  ],
                },
              },
              { id: 'PVTF_points', name: 'Story Points', dataType: 'NUMBER' },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    };
    const result = await resolveProjectIds(
      fakeConnector({ fields: renamedOptions }).connector,
      INPUT,
      paths,
      'upstream',
      { refresh: true },
    );

    expect(result.optionFindings).toEqual([
      { kind: 'renamed', field: 'Status', name: 'Backlog', id: 'OPT_backlog', newName: 'Backlog (new)' },
    ]);
  });

  it('reports a mapped field that resolves to nothing as missing', async () => {
    const paths = makeBoard();
    const { connector } = fakeConnector();
    await resolveProjectIds(connector, INPUT, paths, 'upstream');

    const noStatus = {
      data: {
        node: {
          fields: {
            nodes: [{ id: 'PVTF_points', name: 'Story Points', dataType: 'NUMBER' }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    };
    const result = await resolveProjectIds(
      fakeConnector({ fields: noStatus }).connector,
      INPUT,
      paths,
      'upstream',
      { refresh: true },
    );

    expect(result.fieldFindings).toEqual([{ kind: 'missing', name: 'Status' }]);
  });

  it('reports a missing field on the first resolution too', async () => {
    const paths = makeBoard();
    const noStatus = {
      data: {
        node: {
          fields: {
            nodes: [{ id: 'PVTF_points', name: 'Story Points', dataType: 'NUMBER' }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    };
    const { connector } = fakeConnector({ fields: noStatus });
    const result = await resolveProjectIds(connector, INPUT, paths, 'upstream');
    expect(result.fieldFindings).toEqual([{ kind: 'missing', name: 'Status' }]);
  });

  it('throws on a corrupt cache, naming the path', async () => {
    const paths = makeBoard();
    const { connector } = fakeConnector();
    await resolveProjectIds(connector, INPUT, paths, 'upstream');

    const file = projectCachePath(paths, 'upstream');
    // Corrupt the cache on disk.
    writeFileSync(file, '{ not json', 'utf8');

    await expect(resolveProjectIds(connector, INPUT, paths, 'upstream')).rejects.toThrow(
      /Cannot parse Project cache/,
    );
  });
});

// ---------------------------------------------------------------------------
// Pure mismatch detection
// ---------------------------------------------------------------------------

describe('detectMismatches', () => {
  const previous: ProjectCacheFile = {
    version: 1,
    resolvedAt: '2026-08-18T00:00:00.000Z',
    project: { id: 'PVT_1', number: 7, title: 'Payments Board' },
    fields: {
      Status: {
        id: 'PVTF_status',
        name: 'Status',
        type: 'SINGLE_SELECT',
        options: { Backlog: 'OPT_backlog', Done: 'OPT_done' },
      },
    },
  };

  it('reports nothing when the fresh ids match the cache', () => {
    const fresh = {
      project: { id: 'PVT_1', number: 7, title: 'Payments Board' },
      fields: {
        Status: {
          id: 'PVTF_status',
          name: 'Status',
          type: 'SINGLE_SELECT',
          options: { Backlog: 'OPT_backlog', Done: 'OPT_done' },
        },
      },
    };
    const { fieldFindings, optionFindings } = detectMismatches(previous, fresh, {
      status: 'Status',
    });
    expect(fieldFindings).toEqual([]);
    expect(optionFindings).toEqual([]);
  });

  it('ignores fields the mapping does not name', () => {
    const fresh = {
      project: { id: 'PVT_1', number: 7, title: 'Payments Board' },
      fields: {
        Workflow: {
          id: 'PVTF_status',
          name: 'Workflow',
          type: 'SINGLE_SELECT',
          options: {},
        },
      },
    };
    // The mapping names nothing, so the rename of the un-mapped field is noise.
    const { fieldFindings } = detectMismatches(previous, fresh, {});
    expect(fieldFindings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cache round-trip
// ---------------------------------------------------------------------------

describe('saveProjectCache / loadProjectCache', () => {
  it('round-trips the cache, with keys sorted for a stable diff', () => {
    const paths = makeBoard();
    const cache: ProjectCacheFile = {
      version: 1,
      resolvedAt: '2026-08-18T00:00:00.000Z',
      project: { id: 'PVT_1', number: 7, title: 'Payments Board' },
      fields: {
        Status: {
          id: 'PVTF_status',
          name: 'Status',
          type: 'SINGLE_SELECT',
          options: { Done: 'OPT_done', Backlog: 'OPT_backlog' },
        },
      },
    };
    saveProjectCache(paths, 'upstream', cache);

    const loaded = loadProjectCache(paths, 'upstream');
    expect(loaded).toEqual(cache);

    // Options are written name-sorted, so the file is byte-stable.
    const raw = readFileSync(projectCachePath(paths, 'upstream'), 'utf8');
    expect(raw.indexOf('"Backlog"')).toBeLessThan(raw.indexOf('"Done"'));
  });
});
