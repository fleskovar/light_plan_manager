import { describe, expect, it, vi } from 'vitest';
import type { ConfigDto, RemoteMappingDto } from '$shared';
import { emptyView } from '$shared';
import { ApiError } from '$lib/api/client.js';
import { Shell } from '$lib/app/shell.svelte.js';
import { Tabs, type TabsHost } from '$lib/app/tabs.svelte.js';
import type { MenuEntry, MenuItem } from '$lib/ui/menu/types.js';
import { Workspace } from '$lib/workspace/workspace.svelte.js';
import { fileMenu } from '$features/commandbar/menus.js';
import {
  MappingState,
  addRemoteName,
  assignStatus,
  assignType,
  boardStatusesFor,
  boardTypesFor,
  draftOf,
  draftProblems,
  isDirty,
  pushStatus,
  remoteTypeLevels,
  remoteTypesOf,
  sharedStatuses,
  staleNames,
  unassignStatus,
  updateOf,
  type MappingApi,
} from '$features/config/remote/mapping.svelte.js';
import { config } from './fixtures.js';

/**
 * The mapping editor of a tracker remote: the draft that a person changes, the
 * tracker side as a tree, and the request that saves the draft.
 *
 * The fixture board has six issue types on five levels, five statuses and two
 * period types. The tracker below is a Jira project with an Initiative level.
 */

const view: RemoteMappingDto = {
  remoteName: 'jira',
  provider: 'jira',
  reachability: { reachable: true, evidence: 'GET /rest/api/3/project/PAY → project PAY reachable' },
  types: {
    fixed: true,
    items: [
      { name: 'Initiative', level: 2 },
      { name: 'Epic', level: 1 },
      { name: 'Story', level: 0 },
      { name: 'Bug', level: 0 },
      { name: 'Sub-task', level: -1, subtask: true },
    ],
    mapping: {
      program: 'Epic',
      epic: 'Epic',
      feature: 'Epic',
      user_story: 'Story',
      bug: 'Bug',
      sub_task: 'Sub-task',
    },
  },
  statuses: {
    fixed: true,
    items: ['To Do', 'In Progress', 'In Review', 'Done', "Won't Fix"],
    mapping: {
      backlog: ['To Do'],
      in_progress: ['In Progress'],
      blocked: ['In Progress'],
      in_review: ['In Progress'],
      done: ['Done'],
    },
  },
  periods: {
    native: true,
    carrier: 'sprint',
    container: 'sprint',
    items: [{ name: 'Sprint 1', state: 'active' }],
  },
  linked: 0,
  problems: [],
};

const draft = draftOf(view, config);

describe('the draft', () => {
  it('starts from the mapping in the file, keyed by the board item', () => {
    expect(draft.types).toEqual(view.types.mapping);
    expect(draft.statuses).toEqual(view.statuses.mapping);
    expect(draft.periodContainer).toBe('sprint');
    expect(isDirty(draft, view, config)).toBe(false);
    expect(draftProblems(draft, view, config)).toEqual([]);
  });

  it('shows a board item as not mapped when the tracker does not have the mapped word', () => {
    const renamed: RemoteMappingDto = {
      ...view,
      types: { ...view.types, mapping: { ...view.types.mapping, sub_task: 'Subtask' } },
      statuses: { ...view.statuses, mapping: { ...view.statuses.mapping, done: ['Closed'] } },
    };

    expect(staleNames(renamed)).toEqual([
      { block: 'types', boardKey: 'sub_task', name: 'Subtask' },
      { block: 'statuses', boardKey: 'done', name: 'Closed' },
    ]);
    const stale = draftOf(renamed, config);
    expect(stale.types.sub_task).toBe('');
    expect(stale.statuses.done).toEqual([]);
    expect(draftProblems(stale, renamed, config)).toEqual([
      'Board types with no tracker type: sub_task.',
      'Board statuses with no tracker status: done.',
    ]);
    // The file holds a word that the draft dropped, so there is something to save.
    expect(isDirty(stale, renamed, config)).toBe(true);
  });

  it('keeps a word that the tracker did not confirm when the tracker has no list', () => {
    const labels: RemoteMappingDto = {
      ...view,
      types: { fixed: false, items: [{ name: 'epic' }], mapping: { ...view.types.mapping, epic: 'epic' } },
    };
    expect(staleNames(labels).filter((entry) => entry.block === 'types')).toEqual([]);
    expect(draftOf(labels, config).types.user_story).toBe('Story');
  });
});

describe('the tracker side', () => {
  it('groups the tracker types by level, the highest level first', () => {
    const levels = remoteTypeLevels(view.types.items);
    expect(levels.map((level) => [level.level, level.indent, level.types.map((type) => type.name)])).toEqual([
      [2, 0, ['Initiative']],
      [1, 1, ['Epic']],
      [0, 2, ['Story', 'Bug']],
      [-1, 3, ['Sub-task']],
    ]);
  });

  it('gives one group when the tracker reports no level', () => {
    expect(remoteTypeLevels([{ name: 'story' }, { name: 'bug' }])).toEqual([
      { level: null, indent: 0, types: [{ name: 'story' }, { name: 'bug' }] },
    ]);
    expect(remoteTypeLevels([])).toEqual([]);
  });

  it('answers the board items that map to one tracker item', () => {
    expect(boardTypesFor(draft, 'Epic')).toEqual(['program', 'epic', 'feature']);
    expect(boardTypesFor(draft, 'Initiative')).toEqual([]);
    expect(boardStatusesFor(draft, 'In Progress')).toEqual(['in_progress', 'blocked', 'in_review']);
  });
});

describe('a change to the draft', () => {
  it('moves a board type to another tracker type, because a board type has one', () => {
    const next = assignType(draft, 'program', 'Initiative');
    expect(boardTypesFor(next, 'Initiative')).toEqual(['program']);
    expect(boardTypesFor(next, 'Epic')).toEqual(['epic', 'feature']);
    expect(isDirty(next, view, config)).toBe(true);
  });

  it('removes the mapping of a board type, and then refuses Save', () => {
    const next = assignType(draft, 'bug', '');
    expect(draftProblems(next, view, config)).toEqual(['Board types with no tracker type: bug.']);
  });

  it('adds a tracker status to a board status and keeps the first as the pushed one', () => {
    const next = assignStatus(unassignStatus(draft, 'in_review', 'In Progress'), 'in_review', 'In Review');
    expect(next.statuses.in_review).toEqual(['In Review']);

    const two = assignStatus(draft, 'done', "Won't Fix");
    expect(two.statuses.done).toEqual(['Done', "Won't Fix"]);
    expect(pushStatus(two, 'done', "Won't Fix").statuses.done).toEqual(["Won't Fix", 'Done']);
    expect(pushStatus(two, 'done', 'Nowhere')).toBe(two);
    expect(assignStatus(two, 'done', 'Done')).toBe(two);
  });

  it('names the tracker statuses that mean more than one board status', () => {
    expect(sharedStatuses(draft)).toEqual([
      { remote: 'In Progress', statuses: ['in_progress', 'blocked', 'in_review'] },
    ]);
  });

  it('adds a tracker name by hand once, and ignores a blank', () => {
    const next = addRemoteName(draft, view, 'types', '  Task ');
    expect(remoteTypesOf(view, next).map((item) => item.name)).toContain('Task');
    expect(addRemoteName(next, view, 'types', 'Task')).toBe(next);
    expect(addRemoteName(next, view, 'types', 'Epic')).toBe(next);
    expect(addRemoteName(next, view, 'statuses', ' ')).toBe(next);
  });
});

describe('the request that saves the draft', () => {
  it('sends every block, with the period type when the tracker has a container', () => {
    expect(updateOf(draft, view, config)).toEqual({
      types: view.types.mapping,
      statuses: view.statuses.mapping,
      periodContainer: 'sprint',
    });
  });

  it('sends no period type for a tracker with no container, or a board with no periods', () => {
    const none: RemoteMappingDto = { ...view, periods: { native: false, carrier: null, container: null, items: null } };
    expect(updateOf(draftOf(none, config), none, config)).not.toHaveProperty('periodContainer');

    const queue: ConfigDto = { ...config, hasPeriods: false };
    expect(updateOf(draft, view, queue)).not.toHaveProperty('periodContainer');
  });

  it('refuses Save until a period type is chosen', () => {
    const unset: RemoteMappingDto = { ...view, periods: { ...view.periods, container: null } };
    expect(draftProblems(draftOf(unset, config), unset, config)).toEqual([
      'No period type maps to the period container of the tracker.',
    ]);
  });
});

describe('the editor state', () => {
  function apiOf(overrides: Partial<MappingApi> = {}): MappingApi {
    return {
      remoteMapping: vi.fn(async () => view),
      saveRemoteMapping: vi.fn(async (_name, body) => ({
        changed: ['types.program: Epic → Initiative'],
        mapping: { ...view, types: { ...view.types, mapping: body.types! } },
      })),
      ...overrides,
    };
  }

  it('reads the tracker, saves a changed draft and reports the changed lines', async () => {
    const api = apiOf();
    const state = new MappingState(api, () => config);

    await state.load('jira');
    expect(state.dirty).toBe(false);

    state.change((current) => assignType(current, 'program', 'Initiative'));
    expect(state.dirty).toBe(true);
    expect(await state.save()).toBe(true);

    expect(api.saveRemoteMapping).toHaveBeenCalledWith('jira', {
      types: { ...view.types.mapping, program: 'Initiative' },
      statuses: view.statuses.mapping,
      periodContainer: 'sprint',
    });
    expect(state.saved).toEqual(['types.program: Epic → Initiative']);
    expect(state.dirty).toBe(false);
    expect(state.busy).toBeNull();
  });

  it('does not send a draft that leaves a board item with no mapping', async () => {
    const api = apiOf();
    const state = new MappingState(api, () => config);
    await state.load('jira');

    state.change((current) => assignType(current, 'bug', ''));

    expect(await state.save()).toBe(false);
    expect(api.saveRemoteMapping).not.toHaveBeenCalled();
  });

  it('keeps the reason and the draft when the server refuses', async () => {
    const api = apiOf({
      saveRemoteMapping: vi.fn(async () => {
        throw new ApiError('Remote "jira" cannot be opened', ['mapping.periods: …'], 400);
      }),
    });
    const state = new MappingState(api, () => config);
    await state.load('jira');
    state.change((current) => assignType(current, 'program', 'Initiative'));

    expect(await state.save()).toBe(false);

    expect(state.problem).toEqual({ message: 'Remote "jira" cannot be opened', details: ['mapping.periods: …'] });
    expect(state.draft?.types.program).toBe('Initiative');
  });

  it('keeps the reason when the read fails', async () => {
    const state = new MappingState(
      apiOf({
        remoteMapping: vi.fn(async () => {
          throw new ApiError('No remote named "jira"', [], 400);
        }),
      }),
      () => config,
    );

    await state.load('jira');

    expect(state.view).toBeNull();
    expect(state.problem?.message).toBe('No remote named "jira"');
  });
});

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

  it('holds the entry "Remote board…", which opens the configuration dialog on that tab', () => {
    const workspace = new Workspace({ autoSave: () => false });
    const shell = new Shell();
    const entries: MenuEntry[] = fileMenu({ tabs: new Tabs(host), shell, workspace, workspaceOf: () => workspace });
    const entry = entries.find((item) => 'label' in item && item.label === 'Remote board…') as MenuItem;

    entry.onSelect?.();
    expect(shell.configTab).toBe('remote');

    shell.closeConfig();
    expect(shell.configTab).toBeNull();
  });
});
