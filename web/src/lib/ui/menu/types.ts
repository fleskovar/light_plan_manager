/** The shape a context menu is described in. Builders live next to the feature. */
export interface MenuItem {
  label: string;
  /** Right-aligned hint, used for keyboard shortcuts and for ticks. */
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  /** A submenu opens on hover; an item with `items` has no action of its own. */
  items?: MenuEntry[];
  onSelect?: () => void;
}

export interface MenuSeparator {
  separator: true;
}

/**
 * A line of text that is not an action. It exists for one reason: a menu whose
 * entries act on a whole selection has to say so, or "Delete" reads as a
 * question about the node under the pointer.
 */
export interface MenuHeading {
  heading: string;
}

export type MenuEntry = MenuItem | MenuSeparator | MenuHeading;

export function isSeparator(entry: MenuEntry): entry is MenuSeparator {
  return 'separator' in entry;
}

export function isHeading(entry: MenuEntry): entry is MenuHeading {
  return 'heading' in entry;
}

/** Where a menu was opened, in viewport coordinates. */
export interface MenuAnchor {
  x: number;
  y: number;
}
