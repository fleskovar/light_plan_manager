/**
 * The sizes of the panes in the issue window.
 *
 * The issue window has a description column on the left and a side column on
 * the right. The side column holds the details above the comments. The reader
 * drags two splitters to change the sizes, and this browser keeps them in
 * `localStorage` under the key `lpm:issue-window`, for every board. The value
 * is a JSON object with two keys:
 *
 * - `side`: the width of the side column in pixels. The default is 440.
 * - `split`: the share of the side column's height that the details take,
 *   from 0.15 to 0.85. The default is 0.5, so the details and the comments
 *   start at the same height.
 *
 * Storage can be absent or refuse a write (a private window, blocked site
 * data). The window then uses the defaults and forgets a change on reload.
 */
export interface IssueLayout {
  side: number;
  split: number;
}

export const ISSUE_LAYOUT_KEY = 'lpm:issue-window';

export const DEFAULT_ISSUE_LAYOUT: Readonly<IssueLayout> = { side: 440, split: 0.5 };

export const SIDE_MIN = 300;
export const SIDE_MAX = 1200;
export const SPLIT_MIN = 0.15;
export const SPLIT_MAX = 0.85;

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

/** Read a stored entry. A missing or unreadable key falls back to its default. */
export function parseIssueLayout(raw: string | null): IssueLayout {
  let stored: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === 'object') stored = parsed as Record<string, unknown>;
  } catch {
    // A corrupt entry gives the defaults.
  }
  const number = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return {
    side: clamp(number(stored.side, DEFAULT_ISSUE_LAYOUT.side), SIDE_MIN, SIDE_MAX),
    split: clamp(number(stored.split, DEFAULT_ISSUE_LAYOUT.split), SPLIT_MIN, SPLIT_MAX),
  };
}

export function loadIssueLayout(): IssueLayout {
  try {
    return parseIssueLayout(localStorage.getItem(ISSUE_LAYOUT_KEY));
  } catch {
    return { ...DEFAULT_ISSUE_LAYOUT };
  }
}

export function storeIssueLayout(layout: IssueLayout): void {
  try {
    localStorage.setItem(ISSUE_LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // The size applies until the window closes.
  }
}

/**
 * The share of the side column that the details take, when the comments pane
 * is `commentsHeight` pixels high in a side column of `total` pixels.
 */
export function splitFromCommentsHeight(commentsHeight: number, total: number): number {
  if (total <= 0) return DEFAULT_ISSUE_LAYOUT.split;
  return clamp(1 - commentsHeight / total, SPLIT_MIN, SPLIT_MAX);
}
