import { describe, expect, it } from 'vitest';
import { appearanceEntries } from '$lib/app/options.js';
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_KEY,
  PreferencesStore,
  applyPreferences,
  parsePreferences,
  type Preferences,
} from '$lib/app/preferences.svelte.js';
import type { MenuEntry, MenuItem } from '$lib/ui/menu/types.js';

/** The three attributes `applyPreferences` touches, on something that is not a DOM. */
function fakeRoot(): HTMLElement & { attributes: Map<string, string> } {
  const attributes = new Map<string, string>();
  return {
    attributes,
    setAttribute: (name: string, value: string) => void attributes.set(name, value),
    removeAttribute: (name: string) => void attributes.delete(name),
  } as unknown as HTMLElement & { attributes: Map<string, string> };
}

function fakeStorage(initial: Record<string, string> = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
  };
}

function fakeDarkQuery(matches: boolean) {
  return {
    matches,
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as MediaQueryList;
}

describe('parsePreferences', () => {
  it('is the defaults when nothing is stored', () => {
    expect(parsePreferences(null)).toEqual(DEFAULT_PREFERENCES);
  });

  it('reads what was stored', () => {
    const stored: Preferences = { theme: 'dark', accent: 'teal', textSize: 'large' };
    expect(parsePreferences(JSON.stringify(stored))).toEqual(stored);
  });

  it('loses only the setting it cannot read, never the others', () => {
    const raw = JSON.stringify({ theme: 'sepia', accent: 'indigo', textSize: 42 });
    expect(parsePreferences(raw)).toEqual({ ...DEFAULT_PREFERENCES, accent: 'indigo' });
  });

  it('treats a corrupt entry as the defaults rather than an error', () => {
    expect(parsePreferences('{not json')).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences('"dark"')).toEqual(DEFAULT_PREFERENCES);
  });
});

describe('applyPreferences', () => {
  it('writes nothing for the defaults, so the stylesheet decides', () => {
    const root = fakeRoot();
    applyPreferences(root, DEFAULT_PREFERENCES);
    expect([...root.attributes]).toEqual([]);
  });

  it('writes a choice, and takes it away again on the way back to the default', () => {
    const root = fakeRoot();
    applyPreferences(root, { theme: 'light', accent: 'graphite', textSize: 'small' });
    expect(Object.fromEntries(root.attributes)).toEqual({
      'data-theme': 'light',
      'data-accent': 'graphite',
      'data-text-size': 'small',
    });
    applyPreferences(root, DEFAULT_PREFERENCES);
    expect([...root.attributes]).toEqual([]);
  });
});

describe('PreferencesStore', () => {
  it('opens on what this browser remembered, and applies it at once', () => {
    const root = fakeRoot();
    const storage = fakeStorage({ [PREFERENCES_KEY]: JSON.stringify({ theme: 'dark' }) });
    const store = new PreferencesStore({ storage, root, darkQuery: fakeDarkQuery(false) });
    expect(store.values.theme).toBe('dark');
    expect(root.attributes.get('data-theme')).toBe('dark');
  });

  it('remembers a change, and applies it', () => {
    const root = fakeRoot();
    const storage = fakeStorage();
    const store = new PreferencesStore({ storage, root, darkQuery: null });
    store.set('accent', 'indigo');
    expect(root.attributes.get('data-accent')).toBe('indigo');
    expect(parsePreferences(storage.entries.get(PREFERENCES_KEY) ?? null).accent).toBe('indigo');
  });

  it('resolves "system" from the system, and an explicit choice from the choice', () => {
    const store = new PreferencesStore({ storage: null, root: null, darkQuery: fakeDarkQuery(true) });
    expect(store.resolvedTheme).toBe('dark');
    store.set('theme', 'light');
    expect(store.resolvedTheme).toBe('light');
  });

  it('keeps the choice for the session when storage refuses it', () => {
    const storage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    const store = new PreferencesStore({ storage, root: null, darkQuery: null });
    expect(store.values).toEqual(DEFAULT_PREFERENCES);
    store.set('textSize', 'large');
    expect(store.values.textSize).toBe('large');
  });
});

describe('Options ▸ Appearance', () => {
  const submenu = (entries: MenuEntry[], label: string): MenuItem[] =>
    ((entries.find((entry) => 'label' in entry && entry.label === label) as MenuItem).items ??
      []) as MenuItem[];

  it('ticks the current choice and nothing else', () => {
    const target = { values: { ...DEFAULT_PREFERENCES, theme: 'dark' as const }, set: () => {} };
    const themes = submenu(appearanceEntries(target), 'Theme');
    expect(themes.filter((item) => item.hint === '✓').map((item) => item.label)).toEqual(['Dark']);
  });

  it('sets the preference it names', () => {
    const calls: [string, string][] = [];
    const target = {
      values: { ...DEFAULT_PREFERENCES },
      set: (key: string, value: string) => void calls.push([key, value]),
    };
    const entries = appearanceEntries(target);
    submenu(entries, 'Accent colour').find((item) => item.label === 'Teal')?.onSelect?.();
    submenu(entries, 'Text size').find((item) => item.label === 'Large')?.onSelect?.();
    expect(calls).toEqual([
      ['accent', 'teal'],
      ['textSize', 'large'],
    ]);
  });
});
