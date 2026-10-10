import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardSnapshot, IssueDto, ViewDocument } from '$shared';
import { emptyView } from '$shared';
import { Shell } from '$lib/app/shell.svelte.js';
import { DEFAULT_PREFERENCES, type Preferences } from '$lib/app/preferences.svelte.js';
import { Tabs, type TabsHost } from '$lib/app/tabs.svelte.js';
import type { MenuEntry, MenuItem } from '$lib/ui/menu/types.js';
import { editNode } from '$lib/workspace/mutations.js';
import { Workspace } from '$lib/workspace/workspace.svelte.js';
import { closeTab, fileMenu, type ViewContext } from '$features/commandbar/menus.js';
import { config, sampleBoard } from './fixtures.js';

/**
 * When the view file is written, with the preference `autoSave` on and off.
 *
 * The fake server keeps one view. It records each request as `METHOD path`
 * in `calls`, each body of `PUT /api/views/roadmap` in `saves`, and each view
 * of `POST /api/views/roadmap/push` in `pushes`.
 */
const DELAY = 1500;

const snapshot: BoardSnapshot = {
  config,
  issues: Object.values(sampleBoard()).filter((node): node is IssueDto => node.kind === 'issue'),
  periods: [],
  resources: [],
  squads: [],
  templates: [],
  problems: [],
  readAt: '2026-01-01T00:00:00Z',
};

function fakeServer() {
  const state = {
    view: {
      ...emptyView('roadmap', 'Roadmap', '2026-01-01T00:00:00Z'),
      members: ['S1', 'S2'],
      layout: { S1: { x: 0, y: 0 }, S2: { x: 100, y: 0 } },
    } as ViewDocument,
    calls: [] as string[],
    saves: [] as ViewDocument[],
    pushes: [] as ViewDocument[],
  };
  let clock = 0;
  const stamp = (): string => `2026-01-02T00:00:${String((clock += 1)).padStart(2, '0')}Z`;
  const reply = (data: unknown): Response => new Response(JSON.stringify(data), { status: 200 });

  const fetchFake = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    state.calls.push(`${method} ${path}`);

    if (path === '/api/board') return reply(snapshot);
    if (path === '/api/me') return reply({ id: null });
    if (path === '/api/views/roadmap' && method === 'GET') return reply(state.view);
    if (path === '/api/views/roadmap' && method === 'PUT') {
      state.saves.push(body as ViewDocument);
      state.view = { ...(body as ViewDocument), updated: stamp() };
      return reply(state.view);
    }
    if (path === '/api/views/roadmap/push') {
      const { view } = body as { view: ViewDocument };
      state.pushes.push(view);
      state.view = { ...view, changes: [], updated: stamp() };
      return reply({ idMap: {}, failures: [], board: snapshot, view: state.view });
    }
    return new Response(JSON.stringify({ error: `No route ${method} ${path}` }), { status: 404 });
  };
  return { state, fetchFake };
}

let server: ReturnType<typeof fakeServer>;
const opened: Workspace[] = [];

async function open(autoSave: boolean | (() => boolean)): Promise<Workspace> {
  const read = typeof autoSave === 'function' ? autoSave : () => autoSave;
  const workspace = new Workspace({ autoSave: read });
  // The test drives the clock, so the board poll must not run under it.
  workspace.suspend();
  await workspace.open('roadmap');
  opened.push(workspace);
  return workspace;
}

beforeEach(() => {
  vi.useFakeTimers();
  server = fakeServer();
  vi.stubGlobal('fetch', server.fetchFake);
});

afterEach(async () => {
  for (const workspace of opened.splice(0)) workspace.dispose();
  await vi.runAllTimersAsync();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('with auto-save on', () => {
  it('writes a layout change to the view file after the delay', async () => {
    const workspace = await open(true);
    workspace.setLayout('S1', { x: 40, y: 50 });
    expect(workspace.viewDirty).toBe(true);
    expect(workspace.unsaved).toBe(false);
    expect(server.state.saves).toEqual([]);

    await vi.advanceTimersByTimeAsync(DELAY);
    expect(server.state.saves).toHaveLength(1);
    expect(server.state.saves[0]!.layout.S1).toEqual({ x: 40, y: 50 });
    expect(workspace.viewDirty).toBe(false);
  });

  it('writes the pending layout when the tab closes, without the delay', async () => {
    const workspace = await open(true);
    workspace.setLayout('S1', { x: 40, y: 50 });
    workspace.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(server.state.saves.map((view) => view.layout.S1)).toEqual([{ x: 40, y: 50 }]);
  });

  it('loads a reopened view after the write of the closing tab', async () => {
    const first = await open(true);
    first.setLayout('S1', { x: 40, y: 50 });
    first.dispose();

    const second = await open(true);
    const save = server.state.calls.indexOf('PUT /api/views/roadmap');
    const load = server.state.calls.lastIndexOf('GET /api/views/roadmap');
    expect(save).toBeGreaterThan(-1);
    expect(load).toBeGreaterThan(save);
    expect(second.layout.S1).toEqual({ x: 40, y: 50 });
  });

  it('does not write a deleted view again when its tab closes', async () => {
    const workspace = await open(true);
    workspace.setLayout('S1', { x: 40, y: 50 });
    workspace.dispose({ deleted: true });
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(server.state.saves).toEqual([]);
  });
});

describe('with auto-save off', () => {
  it('keeps a layout change in memory until Save', async () => {
    const workspace = await open(false);
    workspace.setLayout('S1', { x: 40, y: 50 });
    await vi.advanceTimersByTimeAsync(DELAY * 2);
    expect(server.state.saves).toEqual([]);
    expect(workspace.unsaved).toBe(true);

    expect(await workspace.save()).toBe(true);
    expect(server.state.saves.map((view) => view.layout.S1)).toEqual([{ x: 40, y: 50 }]);
    expect(workspace.unsaved).toBe(false);
  });

  it('pushes a board edit and leaves the unsaved layout out of the view file', async () => {
    const workspace = await open(false);
    workspace.setLayout('S1', { x: 40, y: 50 });
    editNode(workspace, 'S1', { title: 'A new title' });
    await vi.advanceTimersByTimeAsync(DELAY);

    // The push carries the queue and the layout that the file already held.
    expect(server.state.pushes).toHaveLength(1);
    expect(server.state.pushes[0]!.changes).toHaveLength(1);
    expect(server.state.pushes[0]!.layout.S1).toEqual({ x: 0, y: 0 });
    expect(server.state.view.layout.S1).toEqual({ x: 0, y: 0 });

    // The screen keeps the layout, and the layout still waits for a Save.
    expect(workspace.layout.S1).toEqual({ x: 40, y: 50 });
    expect(workspace.pending).toEqual([]);
    expect(workspace.unsaved).toBe(true);
  });

  it('drops the unsaved layout when the tab closes', async () => {
    const workspace = await open(false);
    workspace.setLayout('S1', { x: 40, y: 50 });
    workspace.dispose();
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(server.state.saves).toEqual([]);
  });

  it('renames the view and leaves the unsaved layout out of the view file', async () => {
    const workspace = await open(false);
    workspace.setLayout('S1', { x: 40, y: 50 });
    expect(await workspace.rename('Quarter')).toBe(true);
    expect(server.state.saves).toHaveLength(1);
    expect(server.state.saves[0]).toMatchObject({ id: 'roadmap', name: 'Quarter' });
    expect(server.state.saves[0]!.layout.S1).toEqual({ x: 0, y: 0 });
    expect(workspace.doc.name).toBe('Quarter');
    expect(workspace.unsaved).toBe(true);
  });
});

describe('the File menu', () => {
  function context(workspace: Workspace, preferences: Preferences, open: string[]) {
    const host: TabsHost = {
      listViews: async () => [],
      createView: async () => emptyView('x', 'X'),
      deleteView: async () => {},
      boardRoot: async () => '',
      storage: null,
      go: () => {},
      openWindow: () => true,
    };
    const tabs = new Tabs(host);
    for (const id of open) tabs.show(id);
    tabs.show('roadmap');
    const shell = new Shell();
    const view: ViewContext = {
      tabs,
      shell,
      workspace,
      workspaceOf: (id) => (id === 'roadmap' ? workspace : undefined),
      preferences: {
        values: preferences,
        set: (key, value) => {
          preferences[key] = value;
        },
      },
    };
    return { view, tabs, shell };
  }

  const item = (entries: MenuEntry[], label: string): MenuItem =>
    entries.find((entry) => 'label' in entry && entry.label === label) as MenuItem;

  it('ticks Auto-save when the preference holds true, and switches it', async () => {
    const preferences = { ...DEFAULT_PREFERENCES };
    const workspace = await open(() => preferences.autoSave);
    const { view } = context(workspace, preferences, []);

    expect(item(fileMenu(view), 'Auto-save').hint).toBe('✓');
    item(fileMenu(view), 'Auto-save').onSelect?.();
    expect(preferences.autoSave).toBe(false);
    expect(item(fileMenu(view), 'Auto-save').hint).toBeUndefined();
  });

  it('offers Close tab only when the window holds a second tab', async () => {
    const workspace = await open(true);
    const preferences = { ...DEFAULT_PREFERENCES };
    expect(item(fileMenu(context(workspace, preferences, []).view), 'Close tab').disabled).toBe(true);
    expect(item(fileMenu(context(workspace, preferences, ['other']).view), 'Close tab').disabled).toBe(false);
  });

  it('asks before it closes a tab with an unsaved layout, and saves on request', async () => {
    const preferences = { ...DEFAULT_PREFERENCES, autoSave: false };
    const workspace = await open(() => preferences.autoSave);
    const { view, tabs, shell } = context(workspace, preferences, ['other']);
    workspace.setLayout('S1', { x: 40, y: 50 });

    closeTab(view, 'roadmap');
    expect(tabs.open).toEqual(['other', 'roadmap']);
    expect(shell.confirmation?.choice).toEqual({ label: 'Save before closing', checked: true });

    shell.resolveConfirmation(true, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(server.state.saves.map((saved) => saved.layout.S1)).toEqual([{ x: 40, y: 50 }]);
    expect(tabs.open).toEqual(['other']);
  });

  it('closes a tab with a saved layout without a question', async () => {
    const preferences = { ...DEFAULT_PREFERENCES };
    const workspace = await open(true);
    const { view, tabs, shell } = context(workspace, preferences, ['other']);
    closeTab(view, 'roadmap');
    expect(shell.confirmation).toBeNull();
    expect(tabs.open).toEqual(['other']);
  });
});
