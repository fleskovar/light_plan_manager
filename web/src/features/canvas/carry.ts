/**
 * Alt-drag carries an issue *off* the graph without moving it.
 *
 * Dropping a node into a sprint is not a change to the picture — the issue is
 * scheduled, and the node belongs exactly where the reader put it. So the drag
 * is taken over here, from a capture-phase pointerdown that nothing below ever
 * sees: SvelteFlow never starts a node drag, so the node cannot move, no
 * position is written, and the viewport has no drag to auto-pan along with.
 *
 * The same shape as `pan.ts`, and for the same reason: a gesture the graph
 * library would otherwise interpret has to be intercepted before it does.
 */

/**
 * Is this drag a carry? The primary button plus Alt, and only Alt — Ctrl and
 * Cmd already mean "move the camera", and a chord means neither.
 */
export function isCarry(
  event: Pick<PointerEvent, 'button' | 'altKey' | 'ctrlKey' | 'metaKey'>,
): boolean {
  return event.button === 0 && event.altKey && !event.ctrlKey && !event.metaKey;
}

/**
 * What a carry picks up: the whole selection when the node grabbed is part of
 * it, and that node alone otherwise. The same rule a card dragged inside the
 * Periods drawer follows, so dragging from either place means one thing.
 */
export function carriedIds(grabbed: string, selection: readonly string[]): string[] {
  return selection.length > 1 && selection.includes(grabbed) ? [...selection] : [grabbed];
}

/** Chrome that owns its own drags; swallowing a carry there would break it. */
const KEEPS_ITS_OWN_DRAG =
  '.svelte-flow__minimap, .svelte-flow__controls, button, input, select, textarea';

export interface CarryHandlers {
  /** The node the pointer went down on -> what to carry, or null to decline. */
  pick(nodeId: string): string[] | null;
  /** The pointer moved while carrying. */
  move(ids: string[], event: PointerEvent): void;
  /** The pointer came up. Where it is decides what the carry meant. */
  drop(ids: string[], event: PointerEvent): void;
  /** Escape, or the gesture being taken away. Nothing has changed. */
  cancel(ids: string[]): void;
}

/**
 * Take over the drag, if this is one of ours. Returns whether it did, so the
 * caller can leave everything else alone when it is not.
 */
export function startCarry(event: PointerEvent, handlers: CarryHandlers): boolean {
  if (!isCarry(event)) return false;
  const target = event.target instanceof Element ? event.target : null;
  if (!target || target.closest(KEEPS_ITS_OWN_DRAG)) return false;

  const nodeId = target.closest('[data-node-id]')?.getAttribute('data-node-id');
  if (!nodeId) return false;
  const ids = handlers.pick(nodeId);
  if (!ids?.length) return false;

  // Capture phase: preventing the default here is also what stops the
  // compatibility mouse events a node's drag handler listens for.
  event.preventDefault();
  event.stopPropagation();

  const move = (moved: PointerEvent): void => handlers.move(ids, moved);
  const drop = (released: PointerEvent): void => {
    stop();
    handlers.drop(ids, released);
  };
  const abandon = (): void => {
    stop();
    handlers.cancel(ids);
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
