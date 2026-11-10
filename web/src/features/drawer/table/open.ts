/**
 * A double-click on a row of the table opens the issue window, as a
 * double-click on a node of the canvas does in read mode.
 *
 * The cells of a row also hold fields: the title, the status chip, the
 * selects and the check boxes. A double-click in a field selects a word or
 * changes the value, so it must not open a window. `opensIssueWindow` returns
 * false for a double-click inside one of these elements.
 */
const FIELDS = 'input, select, textarea, button, a, [contenteditable]';

export function opensIssueWindow(target: EventTarget | null): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null;
  if (!element || typeof element.closest !== 'function') return false;
  return !element.closest(FIELDS);
}
