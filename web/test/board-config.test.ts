import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardSnapshot, BoardTemplatesDto, ConfigDto, ConfigEdit, NodeDto, TemplateDto } from '$shared';
import { configNameFrom, emptyView } from '$shared';
import { ApiError, api } from '$lib/api/client.js';
import { Shell } from '$lib/app/shell.svelte.js';
import { Tabs, type TabsHost } from '$lib/app/tabs.svelte.js';
import type { MenuEntry, MenuItem } from '$lib/ui/menu/types.js';
import { Workspace } from '$lib/workspace/workspace.svelte.js';
import { fileMenu } from '$features/commandbar/menus.js';
import { ConfigEditor, type ConfigClient } from '$features/config/editor.svelte.js';
import {
  attributeEdits,
  attributeHolders,
  nameProblem,
  namespacesOf,
  parseValues,
  statusRows,
  typesSharing,
} from '$features/config/model.js';
import { config, issue, period } from './fixtures.js';

/**
 * File ▸ Board configuration: the menu entry, the rows that the dialog draws,
 * and the editor that sends an edit and reads the board again. The components
 * are presentational, so these cases cover the logic that they call.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const template = (id: string, type: string, depth: number): TemplateDto => ({
  kind: 'template',
  id,
  type,
  title: id,
  body: '',
  parentId: null,
  depth,
  attributes: {},
  description: '',
  params: {},
  root: true,
  dependsOn: [],
  relatesTo: [],
  relatedFiles: [],
});

/** P-1 program > E-1 epic > F-1 feature > S-1 and S-2 user stories, one sprint, one registry epic. */
const nodes: NodeDto[] = [
  issue('P-1', 'program', null),
  issue('E-1', 'epic', 'P-1'),
  issue('F-1', 'feature', 'E-1'),
  issue('S-1', 'user_story', 'F-1', { status: 'in_progress', attributes: { priority: 'high' } }),
  issue('S-2', 'user_story', 'F-1'),
  period('SP-1', '2026-01-01', '2026-01-14'),
  template('T-1', 'epic', 1),
];

function snapshotOf(all: NodeDto[], withConfig: ConfigDto = config): BoardSnapshot {
  return {
    config: withConfig,
    issues: all.filter((node) => node.kind === 'issue'),
    periods: all.filter((node) => node.kind === 'period'),
    resources: [],
    squads: [],
    templates: all.filter((node) => node.kind === 'template'),
    problems: [],
    readAt: '2026-01-01T00:00:00Z',
  } as BoardSnapshot;
}

function makeWorkspace(): Workspace {
  const workspace = new Workspace({ autoSave: () => false });
  workspace.snapshot = snapshotOf(nodes);
  workspace.view = emptyView('test', 'Test');
  return workspace;
}

describe('the File menu', () => {
  const host: TabsHost = {
    listViews: async () => [],
    createView: async () => emptyView('x', 'X'),
    deleteView: async () => {},
    boardRoot: async () => '',
    storage: null,
    go: () => {},
    openWindow: () => true,
  };
  const entry = (entries: MenuEntry[]): MenuItem =>
    entries.find((item) => 'label' in item && item.label === 'Board configuration…') as MenuItem;

  it('holds the entry "Board configuration…", which opens the dialog', () => {
    const workspace = makeWorkspace();
    const shell = new Shell();
    const item = entry(fileMenu({ tabs: new Tabs(host), shell, workspace, workspaceOf: () => workspace }));

    expect(item.disabled).toBe(false);
    item.onSelect?.();
    expect(shell.configOpen).toBe(true);
  });

  it('disables the entry while the board is not loaded', () => {
    const workspace = new Workspace();
    const item = entry(
      fileMenu({ tabs: new Tabs(host), shell: new Shell(), workspace, workspaceOf: () => workspace }),
    );
    expect(item.disabled).toBe(true);
  });
});

describe('the rows of the dialog', () => {
  it('lists each declared namespace with its levels, its types and the documents of each type', () => {
    const [issues, periods, team] = namespacesOf(config, nodes);

    expect(namespacesOf(config, nodes).map((namespace) => namespace.kind)).toEqual([
      'issue',
      'period',
      'resource',
      'squad',
    ]);
    expect(issues!.levels.map((level) => level.types.map((type) => type.name))).toEqual([
      ['program'],
      ['epic'],
      ['feature'],
      ['user_story', 'bug'],
      ['sub_task'],
    ]);
    // A registry template of an epic counts as a document of the type `epic`.
    expect(issues!.levels[1]!.types[0]).toMatchObject({ name: 'epic', label: 'Epic', documents: 2 });
    expect(issues!.levels[3]!.types[0]!.documents).toBe(2);
    expect(periods!.levels[1]!.types[0]).toMatchObject({ name: 'sprint', documents: 1 });
    expect(team!.levels[0]!.types.map((type) => type.generic)).toEqual([false, true]);
  });

  it('counts the documents at a level or deeper, which decides where a level can be inserted', () => {
    const [issues] = namespacesOf(config, nodes);
    expect(issues!.levels.map((level) => level.documentsFrom)).toEqual([6, 5, 3, 2, 0]);
  });

  it('leaves out a namespace that the board does not declare', () => {
    const bare: ConfigDto = { ...config, hierarchy: { ...config.hierarchy, period: [], squad: [] } };
    expect(namespacesOf(bare, nodes).map((namespace) => namespace.kind)).toEqual(['issue', 'resource']);
  });

  it('counts the issues of each status and marks the default status', () => {
    const rows = statusRows(config, nodes);
    expect(rows.map((row) => [row.id, row.issues, row.isDefault])).toEqual([
      ['backlog', 4, true],
      ['in_progress', 1, false],
      ['blocked', 0, false],
      ['in_review', 0, false],
      ['done', 0, false],
    ]);
  });

  it('counts the documents that hold a value for an attribute', () => {
    expect(attributeHolders(nodes, 'issue', 'user_story', 'priority')).toBe(1);
    expect(attributeHolders(nodes, 'issue', 'user_story', 'story_points')).toBe(0);
  });

  it('names the other types that declare an attribute of the same name', () => {
    expect(typesSharing(config, 'issue', 'user_story', 'story_points')).toEqual(['bug']);
    expect(typesSharing(config, 'issue', 'user_story', 'priority')).toEqual([]);
  });

  it('builds one edit for each type', () => {
    expect(attributeEdits('issue', ['user_story', 'bug'], 'story_points', { name: 'points' })).toEqual([
      { op: 'update-attribute', kind: 'issue', type: 'user_story', attribute: 'story_points', name: 'points' },
      { op: 'update-attribute', kind: 'issue', type: 'bug', attribute: 'story_points', name: 'points' },
    ]);
  });
});

describe('a new name', () => {
  it('comes from the label', () => {
    expect(configNameFrom('Milestone')).toBe('milestone');
    expect(configNameFrom('User Story')).toBe('user_story');
    expect(configNameFrom('  Research / Measure ')).toBe('research_measure');
    expect(configNameFrom('3rd Party')).toBe('rd_party');
    expect(configNameFrom('Época')).toBe('epoca');
  });

  it('is refused when it is empty, malformed or taken', () => {
    expect(nameProblem('', [], 'type name')).toBe('Enter a type name.');
    expect(nameProblem('User Story', [], 'type name')).toBe(
      'Use lower-case letters, digits and "_", starting with a letter.',
    );
    expect(nameProblem('epic', ['epic'], 'type name')).toBe('The type name "epic" is in use.');
    expect(nameProblem('milestone', ['epic'], 'type name')).toBeNull();
  });

  it('reads the values of an enum from text with commas', () => {
    expect(parseValues(' high, medium ,, low, high ')).toEqual(['high', 'medium', 'low']);
  });
});

describe('the editor', () => {
  const rename: ConfigEdit[] = [{ op: 'update-type', kind: 'issue', type: 'epic', name: 'milestone' }];
  const templates: BoardTemplatesDto = {
    templates: [
      { name: 'scrum', source: 'builtin' },
      { name: 'team-flow', source: 'user' },
    ],
    default: 'scrum',
    folder: '/home/me/.light-plan',
  };

  function clientOf(overrides: Partial<ConfigClient> = {}): ConfigClient {
    return {
      editConfig: vi.fn(async () => ({ rewritten: 2, renamedTypes: { epic: 'milestone' }, notes: ['A note.'] })),
      boardTemplates: vi.fn(async () => templates),
      saveBoardTemplate: vi.fn(async () => templates),
      setDefaultBoardTemplate: vi.fn(async (name: string) => ({ ...templates, default: name })),
      removeBoardTemplate: vi.fn(async () => templates),
      ...overrides,
    };
  }

  /** The board that the server answers after the rename. */
  function serverRenamed(): void {
    const renamed: ConfigDto = {
      ...config,
      types: { ...config.types, milestone: { ...config.types.epic!, name: 'milestone' } },
    };
    vi.spyOn(api, 'board').mockResolvedValue(snapshotOf(nodes, renamed));
  }

  it('sends the edits, reads the board again and reports what the server did', async () => {
    serverRenamed();
    const workspace = makeWorkspace();
    const client = clientOf();
    const editor = new ConfigEditor({ workspace, workspaces: () => [workspace] }, client);

    expect(await editor.apply(rename, 'Renamed the type "epic" to "milestone".')).toBe(true);

    expect(client.editConfig).toHaveBeenCalledWith(rename);
    expect(workspace.config.types.milestone?.name).toBe('milestone');
    expect(editor.done).toEqual({
      message: 'Renamed the type "epic" to "milestone". 2 documents were rewritten.',
      notes: ['A note.'],
    });
    expect(editor.problem).toBeNull();
    expect(editor.busy).toBe(false);
    workspace.dispose();
  });

  it('renames the key of `display` in every open tab, so a level keeps its badges', async () => {
    serverRenamed();
    const active = makeWorkspace();
    const other = makeWorkspace();
    other.view = { ...emptyView('other', 'Other'), display: { epic: 'badge', feature: 'badge' } };
    const editor = new ConfigEditor({ workspace: active, workspaces: () => [active, other] }, clientOf());

    await editor.apply(rename, 'Renamed.');

    expect(other.display).toEqual({ milestone: 'badge', feature: 'badge' });
    expect(other.viewDirty).toBe(false);
    active.dispose();
    other.dispose();
  });

  it('refuses while an open tab holds a change that the board did not take', async () => {
    const workspace = makeWorkspace();
    workspace.view = {
      ...emptyView('test', 'Roadmap'),
      changes: [{ kind: 'create', id: 'new:1', nodeKind: 'issue', patch: { type: 'epic', title: 'Later' } }],
    };
    const client = clientOf();
    const editor = new ConfigEditor({ workspace, workspaces: () => [workspace] }, client);

    expect(await editor.apply(rename, 'Renamed.')).toBe(false);

    expect(client.editConfig).not.toHaveBeenCalled();
    expect(editor.problem?.message).toBe('The view "Roadmap" holds 1 unpushed change');
  });

  it('keeps the reason when the server refuses an edit', async () => {
    const workspace = makeWorkspace();
    const client = clientOf({
      editConfig: vi.fn(async () => {
        throw new ApiError('Cannot remove the type "epic"', ['2 documents have this type.'], 400);
      }),
    });
    const editor = new ConfigEditor({ workspace, workspaces: () => [workspace] }, client);

    expect(await editor.apply([{ op: 'remove-type', kind: 'issue', type: 'epic' }], 'Removed.')).toBe(false);

    expect(editor.problem).toEqual({
      message: 'Cannot remove the type "epic"',
      details: ['2 documents have this type.'],
    });
    expect(editor.done).toBeNull();
  });

  it('reads the templates, saves one and sets the default', async () => {
    const workspace = makeWorkspace();
    const client = clientOf();
    const editor = new ConfigEditor({ workspace, workspaces: () => [workspace] }, client);

    await editor.loadTemplates();
    expect(editor.templates?.default).toBe('scrum');

    expect(await editor.saveTemplate('team-flow', true)).toBe(true);
    expect(client.saveBoardTemplate).toHaveBeenCalledWith('team-flow', true);
    expect(editor.done?.notes).toEqual(['Start a board from it with: lpm init --template team-flow']);

    expect(await editor.setDefault('team-flow')).toBe(true);
    expect(editor.templates?.default).toBe('team-flow');
  });
});
