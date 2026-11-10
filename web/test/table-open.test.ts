import { describe, expect, it } from 'vitest';
import { opensIssueWindow } from '$features/drawer/table/open.js';

/**
 * A double-click on a row of the table opens the issue window, unless it
 * lands in a field of the row. The tests run without a DOM, so each target
 * is a stand-in that answers `closest` for the selector of the fields.
 */
const inside = (field: boolean) =>
  ({ closest: () => (field ? {} : null) }) as unknown as EventTarget;

describe('opensIssueWindow', () => {
  it('opens the window for a double-click on the cells of a row', () => {
    expect(opensIssueWindow(inside(false))).toBe(true);
  });

  it('leaves a double-click in a field to the field', () => {
    expect(opensIssueWindow(inside(true))).toBe(false);
  });

  it('asks about the title field, the controls and the link', () => {
    let selector = '';
    opensIssueWindow({
      closest: (asked: string) => {
        selector = asked;
        return null;
      },
    } as unknown as EventTarget);
    for (const field of ['input', 'select', 'textarea', 'button', 'a', '[contenteditable]']) {
      expect(selector.split(', ')).toContain(field);
    }
  });

  it('opens nothing for a target that is not an element', () => {
    expect(opensIssueWindow(null)).toBe(false);
    expect(opensIssueWindow({} as EventTarget)).toBe(false);
  });
});
