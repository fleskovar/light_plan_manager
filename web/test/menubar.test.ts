import { describe, expect, it } from 'vitest';
import type { BoardSnapshot, IssueDto } from '$shared';
import { emptyView } from '$shared';
import { DEFAULT_PREFERENCES, type Preferences } from '$lib/app/preferences.svelte.js';
import { Shell } from '$lib/app/shell.svelte.js';
import { Tabs, type TabsHost } from '$lib/app/tabs.svelte.js';
import { BINDINGS, bindingOf, shortcutLabel } from '$lib/shortcuts/bindings.js';
import type { MenuEntry, MenuItem } from '$lib/ui/menu/types.js';
import { isHeading } from '$lib/ui/menu/types.js';
import { buildIndex } from '$lib/board/index.js';
import { Workspace } from '$lib/workspace/workspace.svelte.js';
import {
  barMenus,
  editMenu,
  helpMenu,
  viewMenu,
  type MenuBarContext,
} from '$features/commandbar/menus.js';
import { config, sampleBoard } from './fixtures.js';

/**
 * The Edit, View and Help menus of the menu bar. `view-save.test.ts` covers
 * the File menu. The workspace holds a board and never calls the server:
 * auto-save is off, so a layout change arms no timer.
 */
function makeWorkspace(mode: 'board' | 'templates' = 'board'): Workspace {
  const nodes = sampleBoard();
  const workspace = new Workspace({ autoSave: () => false });
  workspace.snapshot = {
    config,
    issues: Object.values(nodes).filter((node): node is IssueDto => node.kind === 'issue'),
    periods: [],
    resources: [],
    squads: [],
    templates: [],
    problems: [],
    readAt: '2026-01-01T00:00:00Z',
  } satisfies BoardSnapshot;
  workspace.view = { ...emptyView('test', 'Test'), members: Object.keys(nodes), mode };
  workspace.nodes = nodes;
  workspace.index = buildIndex(nodes);
  return workspace;
}

function context(workspace: Workspace) {
  const host: TabsHost = {
    listViews: async () => [],
    createView: async () => emptyView('x', 'X'),
    deleteView: async () => {},
    boardRoot: async () => '',
    storage: null,
    go: () => {},
    openWindow: () => true,
  };
  const preferences: Preferences = { ...DEFAULT_PREFERENCES };
  const state = { arranged: 0, preferences };
  const bar: MenuBarContext = {
    tabs: new Tabs(host),
    shell: new Shell(),
    workspace,
    workspaceOf: () => workspace,
    preferences: {
      values: preferences,
      set: (key, value) => {
        preferences[key] = value;
      },
    },
    arrange: () => {
      state.arranged += 1;
    },
  };
  return { bar, state };
}

const item = (entries: MenuEntry[], label: string): MenuItem =>
  entries.find((entry) => 'label' in entry && entry.label === label) as MenuItem;
const labels = (entries: MenuEntry[]): string[] =>
  entries.flatMap((entry) => ('label' in entry ? [entry.label] : []));

describe('the menu bar', () => {
  it('holds File, Edit, View and Help, in that order', () => {
    const { bar } = context(makeWorkspace());
    expect(barMenus(bar).map((menu) => menu.label)).toEqual(['File', 'Edit', 'View', 'Help']);
  });

  it('writes the keys of a binding as a menu shows them', () => {
    expect(shortcutLabel(bindingOf('save'))).toBe('Ctrl+S');
    expect(shortcutLabel(bindingOf('push'))).toBe('Ctrl+Enter');
    expect(shortcutLabel(bindingOf('delete'))).toBe('Delete');
    expect(shortcutLabel(bindingOf('clear'))).toBe('Esc');
  });

  it('gives each binding its own id', () => {
    const ids = BINDINGS.map((binding) => binding.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the Edit menu', () => {
  it('offers the top issue types and the other kinds of document under New', () => {
    const { bar } = context(makeWorkspace());
    const created = item(editMenu(bar), 'New').items ?? [];
    const types = Object.values(config.types);
    const roots = types.filter((type) => type.kind === 'issue' && type.depth === 0);
    const others = types.filter((type) => type.kind !== 'issue');
    expect(labels(created)).toEqual([...roots, ...others].map((type) => type.label));
  });

  it('creates a document of the chosen type and selects it', () => {
    const workspace = makeWorkspace();
    const { bar } = context(workspace);
    const root = Object.values(config.types).find((type) => type.kind === 'issue' && type.depth === 0)!;
    item(item(editMenu(bar), 'New').items ?? [], root.label).onSelect?.();

    const id = workspace.selection.primary!;
    expect(workspace.node(id)?.type).toBe(root.name);
    expect(workspace.pending.map((change) => change.kind)).toEqual(['create']);
    workspace.dispose();
  });

  it('disables the selection entries while nothing is selected', () => {
    const { bar } = context(makeWorkspace());
    for (const label of ['Copy', 'Duplicate', 'Remove from the view', 'Delete from the board…']) {
      expect(item(editMenu(bar), label).disabled).toBe(true);
    }
    expect(item(editMenu(bar), 'Paste').disabled).toBe(true);
  });

  it('runs the binding that its shortcut names', () => {
    const workspace = makeWorkspace();
    const { bar } = context(workspace);
    workspace.selection.set(['S1', 'S2']);

    const copy = item(editMenu(bar), 'Copy');
    expect(copy).toMatchObject({ hint: 'Ctrl+C', disabled: false });
    copy.onSelect?.();
    expect(workspace.clipboard).toEqual(['S1', 'S2']);
    expect(item(editMenu(bar), 'Paste').disabled).toBe(false);

    item(editMenu(bar), 'Remove from the view').onSelect?.();
    expect(workspace.isMember('S1')).toBe(false);
    expect(workspace.node('S1')).toBeDefined();
  });

  it('asks before it deletes the selection from the board', () => {
    const workspace = makeWorkspace();
    const { bar } = context(workspace);
    workspace.selection.set(['S4']);
    item(editMenu(bar), 'Delete from the board…').onSelect?.();
    expect(bar.shell.confirmation?.danger).toBe(true);
    expect(workspace.node('S4')).toBeDefined();
  });

  it('offers nothing to create or edit while the view loads', () => {
    const { bar } = context(new Workspace());
    const entries = editMenu(bar);
    expect(item(entries, 'New')).toMatchObject({ disabled: true, items: undefined });
    expect(item(entries, 'Copy').disabled).toBe(true);
    expect(item(entries, 'Push pending changes').disabled).toBe(true);
  });
});

describe('the View menu', () => {
  it('opens the board overview and the hierarchy dialog', () => {
    const { bar } = context(makeWorkspace());
    item(viewMenu(bar), 'Board overview…').onSelect?.();
    item(viewMenu(bar), 'Hierarchy display…').onSelect?.();
    expect(bar.shell.overviewOpen).toBe(true);
    expect(bar.shell.hierarchyOpen).toBe(true);
  });

  it('arranges the graph through the function of the canvas', () => {
    const { bar, state } = context(makeWorkspace());
    const arrange = item(viewMenu(bar), 'Arrange the graph');
    expect(arrange.hint).toBe('Ctrl+L');
    arrange.onSelect?.();
    expect(state.arranged).toBe(1);
  });

  it('ticks each pane that is shown, and switches a pane as a layout change', () => {
    const workspace = makeWorkspace();
    const { bar } = context(workspace);
    // A new view opens with the queue and the drawer shown and the details hidden.
    expect(item(viewMenu(bar), 'Queue panel').hint).toBe('✓');
    expect(item(viewMenu(bar), 'Drawer').hint).toBe('✓');
    expect(item(viewMenu(bar), 'Details panel').hint).toBeUndefined();

    item(viewMenu(bar), 'Drawer').onSelect?.();
    item(viewMenu(bar), 'Details panel').onSelect?.();
    expect(workspace.doc.drawer.open).toBe(false);
    expect(workspace.doc.panel.open).toBe(true);
    expect(workspace.unsaved).toBe(true);
    expect(item(viewMenu(bar), 'Drawer').hint).toBeUndefined();
    expect(item(viewMenu(bar), 'Details panel').hint).toBe('✓');
  });

  it('hides a pinned details panel and removes the pin', () => {
    const workspace = makeWorkspace();
    const { bar } = context(workspace);
    workspace.doc.panel.pinned = true;
    expect(item(viewMenu(bar), 'Details panel').hint).toBe('✓');
    item(viewMenu(bar), 'Details panel').onSelect?.();
    expect(workspace.doc.panel).toMatchObject({ open: false, pinned: false });
  });

  it('offers no queue panel on a view over the template registry', () => {
    const { bar } = context(makeWorkspace('templates'));
    expect(labels(viewMenu(bar))).not.toContain('Queue panel');
  });

  it('holds the three appearance preferences in one submenu', () => {
    const { bar, state } = context(makeWorkspace());
    const appearance = item(viewMenu(bar), 'Appearance').items ?? [];
    expect(appearance.some(isHeading)).toBe(false);
    expect(labels(appearance)).toEqual(['Theme', 'Accent colour', 'Text size']);

    item(item(appearance, 'Theme').items ?? [], 'Dark').onSelect?.();
    expect(state.preferences.theme).toBe('dark');
  });

  it('disables the entries that need the board while the view loads', () => {
    const { bar } = context(new Workspace());
    const entries = viewMenu(bar);
    for (const label of ['Board overview…', 'Arrange the graph', 'Hierarchy display…', 'Drawer']) {
      expect(item(entries, label).disabled).toBe(true);
    }
    // The appearance of the app does not depend on a board.
    expect(item(entries, 'Appearance').disabled).toBeUndefined();
  });
});

describe('the Help menu', () => {
  it('opens the list of keyboard shortcuts', () => {
    const { bar } = context(makeWorkspace());
    item(helpMenu(bar), 'Keyboard shortcuts…').onSelect?.();
    expect(bar.shell.shortcutsOpen).toBe(true);
  });
});
