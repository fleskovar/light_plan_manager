import { describe, expect, it } from 'vitest';
import type { ViewDocument, ViewMode, ViewSummary } from '$shared';
import { emptyView, summarize } from '$shared';
import {
  DEFAULT_VIEW_NAME,
  TABS_KEY,
  Tabs,
  landingView,
  neighbour,
  parseTabs,
  type TabsHost,
} from '$lib/app/tabs.svelte.js';

/**
 * The tabs of a window, against a fake server and a fake browser.
 *
 * The host records each address that the store asks for (`went`), each window
 * that it opens (`windows`) and each tab that it reports closed (`closed`).
 */
function summary(id: string, name = id, updated = '2026-01-01T00:00:00Z'): ViewSummary {
  return { ...summarize(emptyView(id, name, updated)), updated };
}

function fakeHost(initial: ViewSummary[] = [], stored: Record<string, string> = {}) {
  const state = {
    views: [...initial],
    storage: new Map(Object.entries(stored)),
    went: [] as { id: string; replace: boolean }[],
    windows: [] as string[],
    closed: [] as { id: string; deleted: boolean }[],
    created: [] as string[],
    blockWindows: false,
  };
  const host: TabsHost = {
    listViews: async () => [...state.views],
    createView: async (name: string, mode: ViewMode = 'board'): Promise<ViewDocument> => {
      const id = name.toLowerCase().replace(/\s+/g, '-');
      if (state.views.some((view) => view.id === id)) throw new Error(`A view called "${name}" already exists`);
      state.created.push(name);
      const view = { ...emptyView(id, name), mode };
      state.views = [summarize(view), ...state.views];
      return view;
    },
    deleteView: async (id: string) => {
      state.views = state.views.filter((view) => view.id !== id);
    },
    boardRoot: async () => '/boards/demo',
    storage: {
      getItem: (key: string) => state.storage.get(key) ?? null,
      setItem: (key: string, value: string) => void state.storage.set(key, value),
    },
    go: (id, options) => void state.went.push({ id, replace: options?.replace === true }),
    openWindow: (id) => {
      if (state.blockWindows) return false;
      state.windows.push(id);
      return true;
    },
    closed: (id, deleted) => void state.closed.push({ id, deleted }),
  };
  return { host, state };
}

const KEY = `${TABS_KEY}:/boards/demo`;
const storedTabs = (state: { storage: Map<string, string> }) => parseTabs(state.storage.get(KEY) ?? null);

describe('parseTabs', () => {
  it('gives no tabs for a missing or a corrupt entry', () => {
    expect(parseTabs(null)).toEqual({ open: [], active: null });
    expect(parseTabs('{not json')).toEqual({ open: [], active: null });
    expect(parseTabs('"roadmap"')).toEqual({ open: [], active: null });
  });

  it('keeps the string ids once each, and drops every other value', () => {
    const raw = JSON.stringify({ open: ['a', 7, 'b', 'a', null], active: 3 });
    expect(parseTabs(raw)).toEqual({ open: ['a', 'b'], active: null });
  });
});

describe('landingView', () => {
  const views = [summary('newest'), summary('roadmap'), summary('sprint')];

  it('picks the view that the window showed last', () => {
    expect(landingView({ open: ['sprint', 'roadmap'], active: 'roadmap' }, views)).toBe('roadmap');
  });

  it('picks the first open tab when the last view is gone', () => {
    expect(landingView({ open: ['deleted', 'sprint'], active: 'deleted' }, views)).toBe('sprint');
  });

  it('picks the view with the newest save when no tab is stored', () => {
    expect(landingView({ open: [], active: null }, views)).toBe('newest');
  });

  it('is null on a board with no view', () => {
    expect(landingView({ open: ['a'], active: 'a' }, [])).toBeNull();
  });
});

describe('neighbour', () => {
  it('is the next tab, or the previous tab for the last one', () => {
    expect(neighbour(['a', 'b', 'c'], 'b')).toBe('c');
    expect(neighbour(['a', 'b', 'c'], 'c')).toBe('b');
    expect(neighbour(['a'], 'a')).toBeNull();
    expect(neighbour(['a'], 'x')).toBeNull();
  });
});

describe('Tabs.start', () => {
  it('creates the default view on a board with no view, and shows it', async () => {
    const { host, state } = fakeHost();
    const tabs = new Tabs(host);
    await tabs.start(null);

    expect(state.created).toEqual([DEFAULT_VIEW_NAME]);
    expect(tabs.ready).toBe(true);
    expect(tabs.open).toEqual(['default']);
    expect(tabs.active).toBe('default');
    // The address is replaced, so Back does not return to the empty address.
    expect(state.went).toEqual([{ id: 'default', replace: true }]);
  });

  it('creates one default view when two callers land at the same time', async () => {
    const { host, state } = fakeHost();
    const tabs = new Tabs(host);
    await Promise.all([tabs.start(null), tabs.land()]);
    expect(state.created).toEqual([DEFAULT_VIEW_NAME]);
  });

  it('opens the stored tabs and the view that the window showed last', async () => {
    const stored = { [KEY]: JSON.stringify({ open: ['sprint', 'gone', 'roadmap'], active: 'roadmap' }) };
    const { host, state } = fakeHost([summary('newest'), summary('roadmap'), summary('sprint')], stored);
    const tabs = new Tabs(host);
    await tabs.start(null);

    // The view "gone" has no file any more, so its tab is dropped.
    expect(tabs.open).toEqual(['sprint', 'roadmap']);
    expect(tabs.active).toBe('roadmap');
    expect(state.created).toEqual([]);
  });

  it('opens the newest view in a browser that stored no tabs', async () => {
    const { host } = fakeHost([summary('newest'), summary('older')]);
    const tabs = new Tabs(host);
    await tabs.start(null);
    expect(tabs.open).toEqual(['newest']);
  });

  it('adds a tab for the view that the address names', async () => {
    const stored = { [KEY]: JSON.stringify({ open: ['sprint'], active: 'sprint' }) };
    const { host, state } = fakeHost([summary('roadmap'), summary('sprint')], stored);
    const tabs = new Tabs(host);
    await tabs.start('roadmap');

    expect(tabs.open).toEqual(['sprint', 'roadmap']);
    expect(tabs.active).toBe('roadmap');
    // The address already names the view, so the store does not change it.
    expect(state.went).toEqual([]);
    expect(storedTabs(state)).toEqual({ open: ['sprint', 'roadmap'], active: 'roadmap' });
  });

  it('records the failure when the server does not answer', async () => {
    const { host } = fakeHost();
    host.listViews = async () => {
      throw Object.assign(new Error('Cannot reach the light-plan server'), { details: ['Check lpm ui.'] });
    };
    const tabs = new Tabs(host);
    await tabs.start(null);
    expect(tabs.ready).toBe(false);
    expect(tabs.failure).toEqual({
      message: 'Cannot reach the light-plan server',
      details: ['Check lpm ui.'],
    });
  });

  it('keeps no tabs between sessions in a window without storage', async () => {
    const { host } = fakeHost([summary('roadmap')]);
    host.storage = null;
    const tabs = new Tabs(host);
    await tabs.start('roadmap');
    tabs.show('roadmap');
    expect(tabs.open).toEqual(['roadmap']);
  });
});

async function started(ids: string[], active: string) {
  const stored = { [KEY]: JSON.stringify({ open: ids, active }) };
  const fake = fakeHost(ids.map((id) => summary(id, id.toUpperCase())), stored);
  const tabs = new Tabs(fake.host);
  await tabs.start(null);
  fake.state.went.length = 0;
  return { tabs, state: fake.state };
}

describe('Tabs', () => {
  it('closes the active tab and shows its neighbour', async () => {
    const { tabs, state } = await started(['a', 'b', 'c'], 'b');
    tabs.close('b');
    expect(tabs.open).toEqual(['a', 'c']);
    expect(tabs.active).toBe('c');
    expect(state.went).toEqual([{ id: 'c', replace: false }]);
    expect(state.closed).toEqual([{ id: 'b', deleted: false }]);
    expect(storedTabs(state)).toEqual({ open: ['a', 'c'], active: 'c' });
  });

  it('closes a background tab without a change of address', async () => {
    const { tabs, state } = await started(['a', 'b'], 'a');
    tabs.close('b');
    expect(tabs.open).toEqual(['a']);
    expect(state.went).toEqual([]);
  });

  it('keeps the last tab open', async () => {
    const { tabs, state } = await started(['a'], 'a');
    tabs.close('a');
    expect(tabs.open).toEqual(['a']);
    expect(state.closed).toEqual([]);
  });

  it('closes the other tabs and shows the one that stays', async () => {
    const { tabs, state } = await started(['a', 'b', 'c'], 'a');
    tabs.closeOthers('c');
    expect(tabs.open).toEqual(['c']);
    expect(tabs.active).toBe('c');
    expect(state.closed.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('creates a view and shows it in a new tab', async () => {
    const { tabs, state } = await started(['a'], 'a');
    const id = await tabs.create('Roadmap');
    expect(id).toBe('roadmap');
    expect(tabs.open).toEqual(['a', 'roadmap']);
    expect(tabs.active).toBe('roadmap');
    expect(tabs.name('roadmap')).toBe('Roadmap');
    expect(state.went).toEqual([{ id: 'roadmap', replace: false }]);
  });

  it('deletes the active view and shows its neighbour', async () => {
    const { tabs, state } = await started(['a', 'b'], 'a');
    await tabs.remove('a');
    expect(tabs.open).toEqual(['b']);
    expect(tabs.active).toBe('b');
    expect(tabs.views.map((view) => view.id)).toEqual(['b']);
    expect(state.closed).toEqual([{ id: 'a', deleted: true }]);
  });

  it('creates the default view after the delete of the only view', async () => {
    const { tabs, state } = await started(['a'], 'a');
    await tabs.remove('a');
    expect(state.created).toEqual([DEFAULT_VIEW_NAME]);
    expect(tabs.open).toEqual(['default']);
    expect(tabs.active).toBe('default');
  });

  it('moves a tab to a new window when the window holds other tabs', async () => {
    const { tabs, state } = await started(['a', 'b'], 'a');
    expect(tabs.detach('a')).toBe(true);
    expect(state.windows).toEqual(['a']);
    expect(tabs.open).toEqual(['b']);
  });

  it('keeps the only tab when it opens in a new window too', async () => {
    const { tabs, state } = await started(['a'], 'a');
    expect(tabs.detach('a')).toBe(true);
    expect(state.windows).toEqual(['a']);
    expect(tabs.open).toEqual(['a']);
  });

  it('keeps the tab when the browser blocks the new window', async () => {
    const { tabs, state } = await started(['a', 'b'], 'a');
    state.blockWindows = true;
    expect(tabs.detach('a')).toBe(false);
    expect(tabs.open).toEqual(['a', 'b']);
  });

  it('puts another view in the same tab', async () => {
    const { tabs, state } = await started(['a', 'b', 'c'], 'b');
    tabs.replace('b', 'copy');
    expect(tabs.open).toEqual(['a', 'copy', 'c']);
    expect(tabs.active).toBe('copy');
    expect(state.closed).toEqual([{ id: 'b', deleted: false }]);
  });

  it('compares view names without capitals, and skips the view that is renamed', async () => {
    const { tabs } = await started(['a', 'b'], 'a');
    expect(tabs.nameTaken(' a ')).toBe(true);
    expect(tabs.nameTaken('A', 'a')).toBe(false);
    expect(tabs.nameTaken('C')).toBe(false);
  });
});
