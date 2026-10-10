import type { MenuEntry } from '$lib/ui/menu/types.js';
import {
  ACCENTS,
  TEXT_SIZES,
  THEMES,
  type Accent,
  type Preferences,
  type TextSize,
  type Theme,
} from './preferences.svelte.js';

/**
 * View ▸ Appearance: the entries of the menu bar that are about the reader
 * rather than the view. `viewMenu` in `features/commandbar/menus.ts` places
 * them in the submenu Appearance.
 */
const THEME_LABELS: Record<Theme, string> = {
  system: 'Match the system',
  light: 'Light',
  dark: 'Dark',
};

const ACCENT_LABELS: Record<Accent, string> = {
  blue: 'Blue',
  indigo: 'Indigo',
  teal: 'Teal',
  graphite: 'Graphite',
};

const TEXT_SIZE_LABELS: Record<TextSize, string> = {
  small: 'Small',
  default: 'Default',
  large: 'Large',
};

/** The preferences that this menu offers. `autoSave` is in the File menu. */
type AppearanceKey = 'theme' | 'accent' | 'textSize';

/** The narrow surface the menu needs, so a test can pass a plain object. */
export interface AppearanceTarget {
  values: Preferences;
  set<K extends AppearanceKey>(key: K, value: Preferences[K]): void;
}

export function appearanceEntries(preferences: AppearanceTarget): MenuEntry[] {
  const choices = <K extends AppearanceKey>(
    key: K,
    options: readonly Preferences[K][],
    labels: Record<Preferences[K], string>,
  ): MenuEntry[] =>
    options.map((value) => ({
      label: labels[value],
      hint: preferences.values[key] === value ? '✓' : undefined,
      onSelect: () => preferences.set(key, value),
    }));

  return [
    { heading: 'Appearance' },
    { label: 'Theme', items: choices('theme', THEMES, THEME_LABELS) },
    { label: 'Accent colour', items: choices('accent', ACCENTS, ACCENT_LABELS) },
    { label: 'Text size', items: choices('textSize', TEXT_SIZES, TEXT_SIZE_LABELS) },
  ];
}
