import { describe, expect, it } from 'vitest';
import type { ViewDocument } from '$shared';
import { emptyView } from '$shared';
import { currentDetails, saveDetails, type ViewDetailsHost } from '$features/commandbar/view-details.js';
import { tabMenu, type ViewContext } from '$features/commandbar/menus.js';
import type { ViewDetails, Workspace } from '$lib/workspace/workspace.svelte.js';

/**
 * The Edit view dialog changes the name and the description of the view of
 * any open tab. A tab with a loaded workspace changes the view through the
 * workspace, so the next autosave does not write the old name back. A tab
 * without one reads the view file and writes it.
 */

/** A workspace that holds `view` and records each call of `editDetails`. */
function fakeWorkspace(view: ViewDocument, accepts = true) {
  const edits: ViewDetails[] = [];
  const workspace = {
    view,
    editDetails: async (details: ViewDetails) => {
      edits.push(details);
      if (accepts) Object.assign(view, details);
      return accepts;
    },
  } as unknown as Workspace;
  return { workspace, edits };
}

function fakeHost(workspaces: Record<string, Workspace> = {}, files: Record<string, ViewDocument> = {}) {
  const saved: ViewDocument[] = [];
  let refreshes = 0;
  const host: ViewDetailsHost = {
    tabs: {
      name: (id) => files[id]?.name ?? id,
      description: (id) => files[id]?.description ?? '',
      refresh: async () => {
        refreshes++;
      },
    },
    workspaceOf: (id) => workspaces[id],
    loadView: async (id) => {
      const file = files[id];
      if (!file) throw new Error(`No view "${id}"`);
      return structuredClone(file);
    },
    saveView: async (view) => {
      saved.push(view);
      return view;
    },
  };
  return { host, saved, refreshes: () => refreshes };
}

describe('the details of a view', () => {
  it('starts from the loaded workspace, or from the view list for a tab without one', () => {
    const open = { ...emptyView('roadmap', 'Roadmap'), description: 'In memory' };
    const { workspace } = fakeWorkspace(open);
    const files = { triage: { ...emptyView('triage', 'Triage'), description: 'From the list' } };
    const { host } = fakeHost({ roadmap: workspace }, files);

    expect(currentDetails(host, 'roadmap')).toEqual({ name: 'Roadmap', description: 'In memory' });
    expect(currentDetails(host, 'triage')).toEqual({ name: 'Triage', description: 'From the list' });
  });

  it('changes a loaded view through its workspace, with trimmed texts', async () => {
    const { workspace, edits } = fakeWorkspace(emptyView('roadmap', 'Roadmap'));
    const { host, saved, refreshes } = fakeHost({ roadmap: workspace });

    expect(await saveDetails(host, 'roadmap', { name: ' Q3 ', description: ' Epics of Q3 \n' })).toBe(true);

    expect(edits).toEqual([{ name: 'Q3', description: 'Epics of Q3' }]);
    expect(saved).toEqual([]);
    expect(refreshes()).toBe(1);
  });

  it('writes the view file of a tab that has no workspace, and keeps the rest of the file', async () => {
    const file = { ...emptyView('triage', 'Triage'), members: ['LP-1'] };
    const { host, saved } = fakeHost({}, { triage: file });

    expect(await saveDetails(host, 'triage', { name: 'Inbox', description: 'New bugs' })).toBe(true);

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: 'triage', name: 'Inbox', description: 'New bugs', members: ['LP-1'] });
  });

  it('returns false and reads no list when the workspace refused', async () => {
    const { workspace } = fakeWorkspace(emptyView('roadmap', 'Roadmap'), false);
    const { host, refreshes } = fakeHost({ roadmap: workspace });
    expect(await saveDetails(host, 'roadmap', { name: 'Q3', description: '' })).toBe(false);
    expect(refreshes()).toBe(0);
  });

  it('uses the view file when the workspace of the tab still loads another view', async () => {
    const { workspace, edits } = fakeWorkspace(emptyView('other', 'Other'));
    const { host, saved } = fakeHost({ triage: workspace }, { triage: emptyView('triage', 'Triage') });
    await saveDetails(host, 'triage', { name: 'Inbox', description: '' });
    expect(edits).toEqual([]);
    expect(saved.map((view) => view.name)).toEqual(['Inbox']);
  });
});

describe('the menu of a tab', () => {
  it('starts with "Edit…", which opens the Edit view dialog for that tab', () => {
    const shell = { viewDialog: null as unknown };
    const context = {
      tabs: { open: ['roadmap', 'triage'], active: 'roadmap' },
      shell,
    } as unknown as ViewContext;

    const menu = tabMenu(context, 'triage');
    const first = menu[0]!;
    expect('label' in first && first.label).toBe('Edit…');
    if ('onSelect' in first) first.onSelect?.();
    expect(shell.viewDialog).toEqual({ kind: 'edit', id: 'triage' });
  });
});
