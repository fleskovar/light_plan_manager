import { describe, expect, it } from 'vitest';
import { PanTracker, isCameraPan, pannedViewport, type Viewport } from '$features/canvas/pan.js';

/**
 * Ctrl-drag has to move the camera from wherever it starts, including from
 * inside a node — SvelteFlow's own panning refuses a ctrl-drag outright, so
 * this is the only thing standing between a screen-filling subflow and a graph
 * you cannot move around. The wiring is DOM; the decisions in it are here.
 */
describe('pannedViewport', () => {
  it('moves the camera by the distance dragged, at the same zoom', () => {
    const start: Viewport = { x: 10, y: 20, zoom: 1.5 };
    expect(pannedViewport(start, { x: 30, y: -40 })).toEqual({ x: 40, y: -20, zoom: 1.5 });
  });

  it('moves the camera with the pointer, not against it', () => {
    expect(pannedViewport({ x: 0, y: 0, zoom: 1 }, { x: 50, y: 0 }).x).toBe(50);
  });
});

describe('isCameraPan', () => {
  const event = (init: { button?: number; ctrlKey?: boolean; metaKey?: boolean }) => ({
    button: 0,
    ctrlKey: false,
    metaKey: false,
    ...init,
  });

  it('leaves an ordinary drag to whatever it started on', () => {
    expect(isCameraPan(event({}))).toBe(false);
  });

  it('claims a ctrl-drag, and a cmd-drag on the platforms that use it', () => {
    expect(isCameraPan(event({ ctrlKey: true }))).toBe(true);
    expect(isCameraPan(event({ metaKey: true }))).toBe(true);
  });

  it('ignores anything but the primary button, so a context menu still opens', () => {
    expect(isCameraPan(event({ ctrlKey: true, button: 2 }))).toBe(false);
  });
});

/**
 * The pointer runs out of screen long before a large board runs out of graph,
 * so the drag switches to raw movement deltas once the cursor is locked away.
 * The two sources have to add up to one continuous journey.
 */
describe('PanTracker', () => {
  const at = (x: number, y: number) => ({ clientX: x, clientY: y });
  const by = (x: number, y: number) => ({ clientX: 0, clientY: 0, movementX: x, movementY: y });

  it('follows the cursor while it is on screen', () => {
    const tracker = new PanTracker({ x: 100, y: 100 });
    expect(tracker.advance(at(130, 60))).toEqual({ x: 30, y: -40 });
    expect(tracker.advance(at(150, 60))).toEqual({ x: 50, y: -40 });
  });

  it('keeps going on raw movement once the cursor is locked away', () => {
    const tracker = new PanTracker({ x: 100, y: 100 });
    tracker.advance(at(140, 100));
    tracker.lock();

    // `clientX` is frozen at the lock point; only the deltas mean anything now.
    expect(tracker.advance(by(25, 5))).toEqual({ x: 65, y: 5 });
    expect(tracker.advance(by(25, 5))).toEqual({ x: 90, y: 10 });
  });

  it('does not jump when the lock is dropped and the cursor reappears', () => {
    const tracker = new PanTracker({ x: 100, y: 100 });
    tracker.lock();
    tracker.advance(by(400, 0));
    tracker.unlock();

    // Esc puts the cursor back where it was locked, which this drag never
    // chose: the first sample after that is a baseline, not a movement.
    expect(tracker.advance(at(700, 300))).toEqual({ x: 400, y: 0 });
    expect(tracker.advance(at(710, 300))).toEqual({ x: 410, y: 0 });
  });

  it('carries on unlocked when the lock was refused before it ever engaged', () => {
    const tracker = new PanTracker({ x: 0, y: 0 });
    tracker.advance(at(10, 0));
    tracker.unlock();
    expect(tracker.locked).toBe(false);
    expect(tracker.advance(at(20, 0))).toEqual({ x: 20, y: 0 });
  });
});
