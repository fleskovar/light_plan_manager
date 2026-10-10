import { appearanceEntries } from '$lib/app/options.js';
import type { Preferences } from '$lib/app/preferences.svelte.js';
import type { Shell } from '$lib/app/shell.svelte.js';
import type { Tabs } from '$lib/app/tabs.svelte.js';
import {
  bindingOf,
  runBinding,
  shortcutLabel,
  type BindingId,
} from '$lib/shortcuts/bindings.js';
import type { MenuEntry, MenuItem } from '$lib/ui/menu/types.js';
import { isHeading } from '$lib/ui/menu/types.js';
import { createNode } from '$lib/workspace/mutations.js';
import type { Workspace } from '$lib/workspace/workspace.svelte.js';

/**
 * The four menus of the menu bar (File, Edit, View and Help), the menu of one
 * tab, and the actions that they run. The builders return plain menu
 * descriptions, so a test can check them without a component.
 *
 * The word "view" has two meanings in these menus. The File menu acts on a
 * view, which is a saved file under `.lpm/views`. The View menu changes what
 * the window draws, as the View menu of a desktop app does.
 */
export interface ViewContext {
  tabs: Tabs;
  shell: Shell;
  /** The workspace of the active tab. It shows the notices of every action here. */
  workspace: Workspace;
  /** The workspace of an open tab, or undefined when the tab has none. */
  workspaceOf(id: string): Workspace | undefined;
  /** Undefined where the app has no preferences. The entries that need them are then absent. */
  preferences?: {
    values: Preferences;
    set<K extends keyof Preferences>(key: K, value: Preferences[K]): void;
  };
}

/** The context of the menus that also act on the canvas. */
export interface MenuBarContext extends ViewContext {
  /** Lay the graph out again. The canvas supplies this function. */
  arrange: () => void;
}

/** One menu of the menu bar, in the shape that `MenuBar.svelte` takes. */
export interface BarMenu {
  label: string;
  entries: MenuEntry[];
  onopen?: () => void;
}

/**
 * Run `proceed` after the reader decided about the unsaved layout of the tabs
 * `ids`. A tab has an unsaved layout only while the preference `autoSave`
 * holds `false`. With no such tab, `proceed` runs at once.
 */
function whenSaved(
  context: ViewContext,
  ids: string[],
  proceed: () => void | Promise<void>,
): void {
  const unsaved = ids
    .map((id) => context.workspaceOf(id))
    .filter((workspace): workspace is Workspace => workspace?.unsaved === true);
  if (!unsaved.length) {
    void proceed();
    return;
  }
  const names = unsaved.map((workspace) => workspace.doc.name);
  context.shell.confirm({
    title: names.length === 1 ? `Close "${names[0]}"?` : `Close ${names.length} views?`,
    message:
      names.length === 1
        ? 'The layout of this view has changes that no save wrote to the view file.'
        : 'The layouts of these views have changes that no save wrote to the view files.',
    details: names.length > 1 ? names : undefined,
    choice: { label: 'Save before closing', checked: true },
    confirmLabel: 'Close',
    onConfirm: (save) => {
      void (async () => {
        if (save) for (const workspace of unsaved) await workspace.save();
        await proceed();
      })();
    },
  });
}

/** Close one tab. The last tab of a window stays open. */
export function closeTab(context: ViewContext, id: string): void {
  if (context.tabs.open.length < 2) return;
  whenSaved(context, [id], () => context.tabs.close(id));
}

export function closeOtherTabs(context: ViewContext, id: string): void {
  const others = context.tabs.open.filter((entry) => entry !== id);
  whenSaved(context, others, () => context.tabs.closeOthers(id));
}

/**
 * Open the view in a new browser window. The tab closes here when this window
 * holds other tabs. The pending writes run first, so the new window loads the
 * view as this window last showed it.
 */
export function detachTab(context: ViewContext, id: string): void {
  const leaves = context.tabs.open.length > 1;
  whenSaved(context, leaves ? [id] : [], async () => {
    await context.workspaceOf(id)?.flush();
    if (context.tabs.detach(id)) return;
    context.workspace.notify('error', 'The browser blocked the new window', [
      'Allow pop-up windows for this address, then try again.',
    ]);
  });
}

/** Ask, then delete the view file of the active tab. */
export function deleteActiveView(context: ViewContext): void {
  const id = context.tabs.active;
  if (id === null) return;
  context.shell.confirm({
    title: `Delete the view "${context.tabs.name(id)}"?`,
    message: `This deletes the file .lpm/views/${id}.json. Every issue stays on the board.`,
    confirmLabel: 'Delete',
    danger: true,
    onConfirm: () => {
      void context.tabs.remove(id).catch((error: unknown) => context.workspace.report(error));
    },
  });
}

/** A submenu, or none for an empty list. A submenu with no entry opens an empty box. */
const submenu = (items: MenuEntry[]): MenuEntry[] | undefined => (items.length ? items : undefined);

/**
 * The File menu: the commands that act on a view file and on its tab, and the
 * two entries that open the configuration of the board. **Remote board…** opens
 * the same dialog on the tab that shares the board through git or mirrors it
 * onto a tracker.
 */
export function fileMenu(context: ViewContext): MenuEntry[] {
  const { tabs, shell, workspace, preferences } = context;
  const active = tabs.active;
  const ready = workspace.ready;
  const autoSave = preferences?.values.autoSave ?? true;

  return [
    { label: 'New view…', onSelect: () => (shell.viewDialog = 'new') },
    {
      label: 'Open',
      disabled: tabs.views.length === 0,
      items: submenu(
        tabs.views.map((view) => ({
          label: view.mode === 'templates' ? `${view.name} (registry)` : view.name,
          hint: tabs.open.includes(view.id) ? '✓' : undefined,
          onSelect: () => tabs.activate(view.id),
        })),
      ),
    },
    { separator: true },
    {
      label: 'Save',
      hint: shortcutLabel(bindingOf('save')),
      disabled: !ready,
      onSelect: () => void workspace.save(),
    },
    { label: 'Save as…', disabled: !ready, onSelect: () => (shell.viewDialog = 'save-as') },
    { label: 'Rename…', disabled: !ready, onSelect: () => (shell.viewDialog = 'rename') },
    ...(preferences
      ? [
          {
            label: 'Auto-save',
            hint: autoSave ? '✓' : undefined,
            onSelect: () => preferences.set('autoSave', !autoSave),
          },
        ]
      : []),
    { separator: true },
    {
      label: 'Open in new window',
      disabled: active === null,
      onSelect: () => active !== null && detachTab(context, active),
    },
    {
      label: 'Close tab',
      disabled: active === null || tabs.open.length < 2,
      onSelect: () => active !== null && closeTab(context, active),
    },
    { separator: true },
    { label: 'Board configuration…', disabled: !ready, onSelect: () => shell.openConfig('types') },
    { label: 'Remote board…', disabled: !ready, onSelect: () => shell.openConfig('remote') },
    { separator: true },
    {
      label: 'Delete view…',
      danger: true,
      disabled: active === null || workspace.failed,
      onSelect: () => deleteActiveView(context),
    },
  ];
}

/**
 * The Edit menu: create a document, and act on the selection. Each entry with
 * a shortcut runs the binding of that shortcut, so the menu and the keyboard
 * cannot do different things.
 */
export function editMenu(context: MenuBarContext): MenuEntry[] {
  const { workspace } = context;
  const ready = workspace.ready;
  const types = ready ? Object.values(workspace.config.types) : [];
  const roots = types.filter((type) => type.kind === 'issue' && type.depth === 0);
  const others = types.filter((type) => type.kind !== 'issue');
  const selected = ready ? workspace.selection.size : 0;

  const create = (type: string) => (): void => {
    const id = createNode(workspace, { type, parentId: null });
    workspace.selection.focus(id);
  };
  const bound = (id: BindingId, label: string, extra: Partial<MenuItem> = {}): MenuItem => ({
    label,
    hint: shortcutLabel(bindingOf(id)),
    onSelect: () => runBinding(id, context),
    ...extra,
  });

  return [
    {
      label: 'New',
      disabled: roots.length + others.length === 0,
      items: submenu([
        ...roots.map((type) => ({ label: type.label, onSelect: create(type.name) })),
        ...(roots.length && others.length ? [{ separator: true } as const] : []),
        ...others.map((type) => ({
          label: type.label,
          hint: type.kind,
          onSelect: create(type.name),
        })),
      ]),
    },
    { separator: true },
    bound('copy', 'Copy', { disabled: selected === 0 }),
    bound('paste', 'Paste', { disabled: !ready || workspace.clipboard.length === 0 }),
    bound('duplicate', 'Duplicate', { disabled: selected === 0 }),
    { separator: true },
    bound('clear', 'Clear the selection', { disabled: selected === 0 }),
    bound('remove', 'Remove from the view', { disabled: selected === 0 }),
    bound('delete', 'Delete from the board…', { disabled: selected === 0, danger: true }),
    { separator: true },
    bound('push', 'Push pending changes', { disabled: !ready || !workspace.dirty }),
  ];
}

/**
 * The View menu: what the window draws. It holds the board overview, the
 * layout of the graph, the three panes around the canvas and the appearance
 * of the app. A pane entry changes the open view, so it counts as a layout
 * change.
 */
export function viewMenu(context: MenuBarContext): MenuEntry[] {
  const { workspace, shell, preferences } = context;
  const ready = workspace.ready;
  const doc = ready ? workspace.doc : null;

  const pane = (label: string, shown: boolean, set: (shown: boolean) => void): MenuItem => ({
    label,
    hint: shown ? '✓' : undefined,
    disabled: !ready,
    onSelect: () => {
      set(!shown);
      workspace.scheduleSave();
    },
  });

  return [
    { label: 'Board overview…', disabled: !ready, onSelect: () => (shell.overviewOpen = true) },
    { separator: true },
    {
      label: 'Arrange the graph',
      hint: shortcutLabel(bindingOf('arrange')),
      disabled: !ready,
      onSelect: () => runBinding('arrange', context),
    },
    { label: 'Hierarchy display…', disabled: !ready, onSelect: () => shell.openHierarchy() },
    { separator: true },
    // A view over the template registry has no queue.
    ...(workspace.mode === 'board'
      ? [pane('Queue panel', doc?.queue.open === true, (shown) => (doc!.queue.open = shown))]
      : []),
    pane('Details panel', doc !== null && (doc.panel.open || doc.panel.pinned), (shown) => {
      doc!.panel.open = shown;
      if (!shown) doc!.panel.pinned = false;
    }),
    pane('Drawer', doc?.drawer.open === true, (shown) => (doc!.drawer.open = shown)),
    ...(preferences
      ? [
          { separator: true } as const,
          {
            label: 'Appearance',
            items: appearanceEntries(preferences).filter((entry) => !isHeading(entry)),
          },
        ]
      : []),
  ];
}

/** The Help menu. */
export function helpMenu(context: ViewContext): MenuEntry[] {
  return [{ label: 'Keyboard shortcuts…', onSelect: () => (context.shell.shortcutsOpen = true) }];
}

/** The menus of the menu bar, in order. The File menu reads the view list again when it opens. */
export function barMenus(context: MenuBarContext): BarMenu[] {
  return [
    { label: 'File', entries: fileMenu(context), onopen: () => void context.tabs.refresh() },
    { label: 'Edit', entries: editMenu(context) },
    { label: 'View', entries: viewMenu(context) },
    { label: 'Help', entries: helpMenu(context) },
  ];
}

/** The entries of the menu that a right-click on a tab opens. */
export function tabMenu(context: ViewContext, id: string): MenuEntry[] {
  const single = context.tabs.open.length < 2;
  return [
    { label: 'Close', disabled: single, onSelect: () => closeTab(context, id) },
    { label: 'Close other tabs', disabled: single, onSelect: () => closeOtherTabs(context, id) },
    { separator: true },
    { label: 'Open in new window', onSelect: () => detachTab(context, id) },
  ];
}
