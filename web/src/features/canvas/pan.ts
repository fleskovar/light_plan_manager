/**
 * Ctrl-drag moves the camera, wherever the drag starts — and keeps moving after
 * the pointer runs out of screen.
 *
 * A subflow can easily be bigger than the window, and then there is nowhere
 * left to grab the background: every drag lands on a node and moves it, which
 * is an edit nobody asked for. Holding Ctrl has to mean "pan", and it cannot be
 * left to the graph library — SvelteFlow's pane filter ends in
 * `!event.ctrlKey`, so a ctrl-drag never reaches its panning at all. So the
 * camera is moved here instead, from a capture-phase pointerdown that nothing
 * below ever sees.
 *
 * The canvas still turns node dragging off while Ctrl is held. That is not
 * belt and braces for its own sake: it is what stops a node from moving if a
 * browser delivers the compatibility `mousedown` anyway, and it is what makes
 * the cursor say what the modifier does.
 *
 * **Running out of screen is the interesting part.** A big board needs several
 * screens of panning, and a cursor pinned against the edge of the display stops
 * reporting movement, so the drag dies halfway. A page cannot warp the cursor,
 * so the only way to keep going in the same direction is the Pointer Lock API:
 * the cursor is taken off screen and raw `movementX/Y` deltas arrive instead,
 * which is the same trade every 3D viewport on the web makes. Two consequences
 * are deliberate:
 *
 * - **The lock is asked for on the first few pixels of movement, never on
 *   pointerdown.** Ctrl+click is how the canvas multi-selects, and a click that
 *   blinked the cursor out of existence would be a worse bug than the one this
 *   fixes.
 * - **Losing the lock is not losing the drag.** A refused request, or Esc
 *   halfway through, drops `PanTracker` back to following `clientX/Y` from
 *   wherever the cursor reappeared — the pan carries on, it just stops at the
 *   edge again, exactly as it did before any of this existed.
 */
export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Just enough of a pointer event to follow a drag with. */
export interface PointerSample {
  clientX: number;
  clientY: number;
  movementX?: number;
  movementY?: number;
}

/**
 * How far the pointer has travelled since the drag began.
 *
 * The two sources of that answer are not interchangeable, which is the whole
 * reason this is a class rather than a subtraction. While the cursor is on
 * screen `clientX/Y` is the truth and `movementX/Y` is scaled by the display in
 * some browsers; while it is locked `clientX/Y` is frozen at the lock point and
 * only the deltas mean anything. So the offset is accumulated either way, and
 * switching between them mid-drag adds nothing to it.
 */
export class PanTracker {
  #offset: Point = { x: 0, y: 0 };
  #last: Point;
  #locked = false;
  /** The cursor was just put back somewhere: take the next sample as a baseline. */
  #reseed = false;

  constructor(origin: Point) {
    this.#last = { x: origin.x, y: origin.y };
  }

  get offset(): Point {
    return this.#offset;
  }

  get locked(): boolean {
    return this.#locked;
  }

  /** The pointer is locked: the cursor is gone and only deltas arrive now. */
  lock(): void {
    this.#locked = true;
  }

  /**
   * The lock was refused, or dropped with Esc. The cursor is back on screen at
   * a position this drag never chose, so the next sample is a new baseline
   * rather than a jump the camera would follow.
   */
  unlock(): void {
    if (this.#locked) this.#reseed = true;
    this.#locked = false;
  }

  advance(event: PointerSample): Point {
    if (this.#locked) {
      this.#offset = {
        x: this.#offset.x + (event.movementX ?? 0),
        y: this.#offset.y + (event.movementY ?? 0),
      };
      return this.#offset;
    }

    if (this.#reseed) {
      this.#reseed = false;
      this.#last = { x: event.clientX, y: event.clientY };
      return this.#offset;
    }

    this.#offset = {
      x: this.#offset.x + (event.clientX - this.#last.x),
      y: this.#offset.y + (event.clientY - this.#last.y),
    };
    this.#last = { x: event.clientX, y: event.clientY };
    return this.#offset;
  }
}

/** What the camera holds after being dragged by `offset` screen pixels. */
export function pannedViewport(start: Viewport, offset: Point): Viewport {
  return { x: start.x + offset.x, y: start.y + offset.y, zoom: start.zoom };
}

/** The slice of SvelteFlow's handle this needs, so a test can stand in for it. */
export interface Camera {
  getViewport(): Viewport;
  setViewport(viewport: Viewport): unknown;
}

/**
 * Is this drag a camera pan? The primary button plus the platform's own
 * modifier — Ctrl everywhere, and Cmd as well, where that is the same gesture.
 */
export function isCameraPan(event: Pick<PointerEvent, 'button' | 'ctrlKey' | 'metaKey'>): boolean {
  return event.button === 0 && (event.ctrlKey || event.metaKey);
}

/**
 * Chrome that owns its own drags. The minimap pans by being dragged and the
 * controls are buttons; swallowing a ctrl-drag there would break them for the
 * sake of a gesture nobody makes on top of them.
 */
const KEEPS_ITS_OWN_DRAG =
  '.svelte-flow__minimap, .svelte-flow__controls, button, input, select, textarea';

/** Pixels of travel before this is a drag rather than a ctrl+click on a node. */
const LOCK_THRESHOLD = 4;

/**
 * Take the cursor off screen for the duration of a drag. Returns the release,
 * which is safe to call whether or not the lock was ever granted.
 */
function lockPointer(target: Element | null, onChange: (locked: boolean) => void): () => void {
  if (!target || typeof target.requestPointerLock !== 'function') return () => {};

  const changed = (): void => onChange(document.pointerLockElement === target);
  document.addEventListener('pointerlockchange', changed);
  // A refusal is reported here and nowhere else, and it means "carry on unlocked".
  document.addEventListener('pointerlockerror', changed);

  try {
    const request: unknown = target.requestPointerLock();
    if (request instanceof Promise) request.catch(() => onChange(false));
  } catch {
    onChange(false);
  }

  return () => {
    document.removeEventListener('pointerlockchange', changed);
    document.removeEventListener('pointerlockerror', changed);
    // Unconditional: it is a no-op when nothing is locked, and it is what
    // cancels a request still in flight when the drag was over in two frames.
    try {
      document.exitPointerLock?.();
    } catch {
      /* Nothing to release. */
    }
  };
}

/**
 * Take over the drag, if this is one of ours. Returns whether it did, so the
 * caller can leave everything else alone when it is not.
 *
 * `surface` is the element the cursor is locked to; it defaults to whatever the
 * handler was bound to, which is the canvas.
 */
export function startCameraPan(
  event: PointerEvent,
  camera: Camera,
  surface?: Element | null,
): boolean {
  if (!isCameraPan(event)) return false;
  if (event.target instanceof Element && event.target.closest(KEEPS_ITS_OWN_DRAG)) return false;

  // Capture phase: preventing the default here is also what stops the
  // compatibility mouse events a node's drag handler listens for.
  event.preventDefault();
  event.stopPropagation();

  const target = surface ?? (event.currentTarget instanceof Element ? event.currentTarget : null);
  const start = camera.getViewport();
  const tracker = new PanTracker({ x: event.clientX, y: event.clientY });
  let release: (() => void) | null = null;

  const move = (moved: PointerEvent): void => {
    const offset = tracker.advance(moved);
    if (!release && Math.abs(offset.x) + Math.abs(offset.y) >= LOCK_THRESHOLD) {
      release = lockPointer(target, (locked) => (locked ? tracker.lock() : tracker.unlock()));
    }
    void camera.setViewport(pannedViewport(start, offset));
  };

  const stop = (): void => {
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', stop, true);
    window.removeEventListener('pointercancel', stop, true);
    release?.();
    release = null;
  };

  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', stop, true);
  window.addEventListener('pointercancel', stop, true);
  return true;
}
