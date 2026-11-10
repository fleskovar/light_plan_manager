import { addDependency } from '$lib/workspace/mutations.js';
import type { Workspace } from '$lib/workspace/workspace.svelte.js';

/**
 * Two fast ways to add a dependency on the canvas, both with the key F.
 *
 * - **F on a selection.** The selection keeps the order of the clicks. When F
 *   is released, each selected item depends on the item selected before it.
 *   Two items give one dependency: the second depends on the first.
 * - **F held, and a drag from one node to another.** The canvas draws a line
 *   from the first node to the pointer. A release over a second node makes the
 *   second node depend on the first.
 *
 * The keyboard link runs on the release of F, not on the press. A reader who
 * holds F to drag a line has not asked for the selection to be linked, so a
 * drag during the hold cancels the keyboard link.
 */

/** One dependency to add: `blocked` waits for `blocker`. */
export interface LinkPair {
  blocked: string;
  blocker: string;
}

/** The dependencies that F adds to a selection: each id depends on the id before it. */
export function chainPairs(ids: readonly string[]): LinkPair[] {
  return ids.slice(1).map((blocked, index) => ({ blocked, blocker: ids[index]! }));
}

/**
 * Add the dependencies of `chainPairs` for the current selection, and report
 * how many the board gained. `addDependency` refuses a cycle and an edge
 * between an issue and a template, and reports the cycle itself.
 */
export function linkSelection(workspace: Workspace): number {
  const ids = [...workspace.selection.ids];
  if (ids.length < 2) {
    workspace.notify('info', 'Select two items in order, then press F: the second depends on the first.');
    return 0;
  }
  let added = 0;
  for (const { blocked, blocker } of chainPairs(ids)) {
    const had = dependsOnOf(workspace, blocked).includes(blocker);
    if (addDependency(workspace, blocked, blocker) && !had) added += 1;
  }
  if (added) {
    workspace.notify('info', added === 1 ? 'Added 1 dependency' : `Added ${added} dependencies`);
  }
  return added;
}

function dependsOnOf(workspace: Workspace, id: string): readonly string[] {
  const node = workspace.node(id);
  return node && 'dependsOn' in node ? node.dependsOn : [];
}

/** True for the key F alone: no Ctrl, Cmd or Alt. Shift is allowed, because Shift+click selects. */
export function isLinkKey(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): boolean {
  return event.key.toLowerCase() === 'f' && !event.ctrlKey && !event.metaKey && !event.altKey;
}

/** Chrome that owns its own pointer gestures; a link drag never starts there. */
const KEEPS_ITS_OWN_DRAG =
  '.svelte-flow__minimap, .svelte-flow__controls, .svelte-flow__resize-control, button, input, select, textarea';

export interface LinkDragHandlers {
  /** The pointer moved. `x` and `y` are client coordinates. */
  move(from: string, x: number, y: number): void;
  /** The pointer came up over `to`, or over no node. */
  drop(from: string, to: string | null): void;
  /** Escape, or the gesture was taken away. */
  cancel(): void;
}

/**
 * Start a link drag from a pointerdown in the capture phase, when F is held
 * and the pointer went down on a node. Returns true when it started one.
 * SvelteFlow never sees the pointerdown, so the node does not move and the
 * camera does not pan.
 */
export function startLinkDrag(
  event: PointerEvent,
  linkKeyHeld: boolean,
  handlers: LinkDragHandlers,
): boolean {
  if (!linkKeyHeld || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey) {
    return false;
  }
  const target = event.target instanceof Element ? event.target : null;
  if (!target || target.closest(KEEPS_ITS_OWN_DRAG)) return false;
  const from = target.closest('[data-node-id]')?.getAttribute('data-node-id');
  if (!from) return false;

  event.preventDefault();
  event.stopPropagation();
  handlers.move(from, event.clientX, event.clientY);

  const move = (moved: PointerEvent): void => handlers.move(from, moved.clientX, moved.clientY);
  const drop = (released: PointerEvent): void => {
    stop();
    const under = document.elementFromPoint(released.clientX, released.clientY);
    handlers.drop(from, under?.closest('[data-node-id]')?.getAttribute('data-node-id') ?? null);
  };
  const abandon = (): void => {
    stop();
    handlers.cancel();
  };
  const onKey = (pressed: KeyboardEvent): void => {
    if (pressed.key === 'Escape') abandon();
  };

  function stop(): void {
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', drop, true);
    window.removeEventListener('pointercancel', abandon, true);
    window.removeEventListener('keydown', onKey, true);
  }

  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', drop, true);
  window.addEventListener('pointercancel', abandon, true);
  window.addEventListener('keydown', onKey, true);
  return true;
}
