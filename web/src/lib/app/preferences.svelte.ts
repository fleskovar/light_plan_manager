import { getContext, setContext } from 'svelte';

/**
 * How the app looks to the person using it: light or dark, which accent, how
 * big the type is. The key `autoSave` is the one preference about behaviour:
 * it holds `true` or `false`, the default is `true`, and the workspace reads it
 * to decide whether a layout change writes the view file without a Save.
 *
 * This is deliberately **not** view state. A view is committed with the board
 * and pulled by teammates, and inheriting somebody else's dark mode on a pull
 * would be absurd. So it lives in this browser's `localStorage`, as one entry
 * for the whole app, and it applies to every board and every view opened here.
 * A popup issue window follows a change made in the main one through the
 * `storage` event.
 *
 * Applying it is three attributes on the root element. `app.css` does the rest:
 * every colour token is a `light-dark()` pair, so a theme is one `color-scheme`
 * and needs no second palette.
 */
export const THEMES = ['system', 'light', 'dark'] as const;
export const ACCENTS = ['blue', 'indigo', 'teal', 'graphite'] as const;
export const TEXT_SIZES = ['small', 'default', 'large'] as const;

export type Theme = (typeof THEMES)[number];
export type Accent = (typeof ACCENTS)[number];
export type TextSize = (typeof TEXT_SIZES)[number];

export interface Preferences {
  theme: Theme;
  accent: Accent;
  textSize: TextSize;
  /** Whether a change to the layout of a view writes the view file after a delay. */
  autoSave: boolean;
}

export const DEFAULT_PREFERENCES: Readonly<Preferences> = {
  theme: 'system',
  accent: 'blue',
  textSize: 'default',
  autoSave: true,
};

export const PREFERENCES_KEY = 'lpm:preferences';

const pick = <T extends string>(allowed: readonly T[], value: unknown, fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

/**
 * Read a stored entry, forgivingly. Anything unreadable falls back key by key:
 * a value written by a later version, or by hand, costs that one setting and
 * never the others.
 */
export function parsePreferences(raw: string | null): Preferences {
  let stored: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === 'object') stored = parsed as Record<string, unknown>;
  } catch {
    // A corrupt entry is the defaults, not an error anybody can act on.
  }
  return {
    theme: pick(THEMES, stored.theme, DEFAULT_PREFERENCES.theme),
    accent: pick(ACCENTS, stored.accent, DEFAULT_PREFERENCES.accent),
    textSize: pick(TEXT_SIZES, stored.textSize, DEFAULT_PREFERENCES.textSize),
    autoSave:
      typeof stored.autoSave === 'boolean' ? stored.autoSave : DEFAULT_PREFERENCES.autoSave,
  };
}

/** Write the preferences onto the root element. A default writes nothing. */
export function applyPreferences(root: HTMLElement, preferences: Preferences): void {
  const set = (name: string, value: string, fallback: string): void => {
    if (value === fallback) root.removeAttribute(name);
    else root.setAttribute(name, value);
  };
  set('data-theme', preferences.theme, DEFAULT_PREFERENCES.theme);
  set('data-accent', preferences.accent, DEFAULT_PREFERENCES.accent);
  set('data-text-size', preferences.textSize, DEFAULT_PREFERENCES.textSize);
}

/** What the store needs from the browser, so a test can hand it fakes. */
export interface PreferencesHost {
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  root: HTMLElement | null;
  /** `(prefers-color-scheme: dark)`, or null where there is no window. */
  darkQuery: MediaQueryList | null;
}

export class PreferencesStore {
  values = $state<Preferences>({ ...DEFAULT_PREFERENCES });
  /** Whether the system asks for dark, which is what `system` resolves to. */
  systemDark = $state(false);

  readonly #host: PreferencesHost;
  readonly #onSystemChange = (event: MediaQueryListEvent): void => {
    this.systemDark = event.matches;
  };
  readonly #onStorage = (event: StorageEvent): void => {
    if (event.key !== PREFERENCES_KEY) return;
    this.values = parsePreferences(event.newValue);
    this.#apply();
  };

  constructor(host: PreferencesHost) {
    this.#host = host;
    this.values = parsePreferences(this.#read());
    this.systemDark = host.darkQuery?.matches ?? false;
    host.darkQuery?.addEventListener('change', this.#onSystemChange);
    if (typeof window !== 'undefined') window.addEventListener('storage', this.#onStorage);
    this.#apply();
  }

  /** The theme actually on screen, for the pieces that take one as a prop. */
  get resolvedTheme(): 'light' | 'dark' {
    if (this.values.theme === 'system') return this.systemDark ? 'dark' : 'light';
    return this.values.theme;
  }

  set<K extends keyof Preferences>(key: K, value: Preferences[K]): void {
    this.values = { ...this.values, [key]: value };
    this.#apply();
    try {
      this.#host.storage?.setItem(PREFERENCES_KEY, JSON.stringify(this.values));
    } catch {
      // Storage refused (a private window, a full quota): the choice still
      // holds for this session, it just will not be remembered.
    }
  }

  dispose(): void {
    this.#host.darkQuery?.removeEventListener('change', this.#onSystemChange);
    if (typeof window !== 'undefined') window.removeEventListener('storage', this.#onStorage);
  }

  #read(): string | null {
    try {
      return this.#host.storage?.getItem(PREFERENCES_KEY) ?? null;
    } catch {
      return null;
    }
  }

  #apply(): void {
    if (this.#host.root) applyPreferences(this.#host.root, this.values);
  }
}

/** The store over the real browser. */
export function browserPreferences(): PreferencesStore {
  const hasWindow = typeof window !== 'undefined';
  let storage: Storage | null = null;
  try {
    storage = hasWindow ? window.localStorage : null;
  } catch {
    // Some browsers throw on the getter itself when site data is blocked.
  }
  return new PreferencesStore({
    storage,
    root: hasWindow ? document.documentElement : null,
    darkQuery: hasWindow ? window.matchMedia('(prefers-color-scheme: dark)') : null,
  });
}

const KEY = Symbol('preferences');

export function providePreferences(preferences: PreferencesStore): PreferencesStore {
  return setContext(KEY, preferences);
}

/** Undefined outside the editor — the published viewer has no preferences. */
export function usePreferences(): PreferencesStore | undefined {
  return getContext<PreferencesStore | undefined>(KEY);
}
