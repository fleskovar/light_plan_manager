import type { NodeLinks } from '$lib/ui/node-links.js';
import type { Workspace } from '$lib/workspace/workspace.svelte.js';
import { issueHash, parseRoute } from './router.svelte.js';

/**
 * The issue window shows one issue in a browser window of its own
 * (`IssueView.svelte`). This module opens it.
 *
 * Each issue window has the name `issue-<id>`. A second request for the same
 * issue finds the window by that name and brings it to the front. The window
 * keeps its unsaved changes, because it does not load again.
 */

/** Wide enough for the two columns of `IssueView.svelte`. */
const FEATURES = 'width=1200,height=860,resizable,scrollbars';

export const issueWindowName = (id: string): string => `issue-${id}`;

/** True when `target` shows the issue `id`. False when the browser does not let this window read it. */
function showsIssue(target: Window, id: string): boolean {
  try {
    const route = parseRoute(target.location.hash);
    return route.name === 'issue' && route.nodeId === id;
  } catch {
    return false;
  }
}

/**
 * Open the issue `id` in its own window, which loads the view `viewId`. When
 * a window already shows that issue, this function brings it to the front.
 */
export function openIssueWindow(id: string, viewId: string): void {
  // An empty address returns the window with this name when one exists, and
  // opens an empty window when none does.
  const target = window.open('', issueWindowName(id), FEATURES);
  // The browser blocked the popup.
  if (!target) return;
  if (!showsIssue(target, id)) {
    const base = window.location.href.replace(/#.*$/, '');
    target.location.href = `${base}${issueHash(id, viewId)}`;
  }
  target.focus();
}

/**
 * The `NodeLinks` of a window that shows the board of `workspace`. A link
 * `[[ID]]` opens the issue window for `ID`, which loads the view `viewId()`.
 */
export function issueWindowLinks(workspace: Workspace, viewId: () => string): NodeLinks {
  return {
    target(id) {
      const node = workspace.node(id);
      return node ? { href: issueHash(id, viewId()), title: node.title } : null;
    },
    open: (id) => openIssueWindow(id, viewId()),
  };
}

/**
 * The window that shows the canvas for this issue window. The function
 * follows `window.opener` past each issue window, so an issue window opened
 * from another issue window reports to the same canvas. Returns null for a
 * window that no other window opened.
 */
export function canvasWindow(): Window | null {
  if (typeof window === 'undefined') return null;
  let current: Window | null = window.opener;
  try {
    while (current?.opener && current.name.startsWith(issueWindowName(''))) {
      current = current.opener as Window;
    }
  } catch {
    // The browser does not let this window read the opener of an opener.
  }
  return current;
}
