import { describe, expect, it } from 'vitest';
import { carriedIds, isCarry } from '$features/canvas/carry.js';

/**
 * Alt-drag carries an issue off the graph to schedule it, and the whole point
 * is that the graph does not change: SvelteFlow never sees the drag, so no node
 * moves and no viewport pans. The wiring is DOM; the two decisions in it are
 * here.
 */
describe('isCarry', () => {
  const event = (init: Partial<Record<'button' | 'altKey' | 'ctrlKey' | 'metaKey', unknown>>) => ({
    button: 0,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    ...init,
  }) as Parameters<typeof isCarry>[0];

  it('leaves an ordinary drag to move the node, as it always did', () => {
    expect(isCarry(event({}))).toBe(false);
  });

  it('claims an alt-drag', () => {
    expect(isCarry(event({ altKey: true }))).toBe(true);
  });

  it('yields to the camera, which owns ctrl and cmd', () => {
    expect(isCarry(event({ altKey: true, ctrlKey: true }))).toBe(false);
    expect(isCarry(event({ altKey: true, metaKey: true }))).toBe(false);
  });

  it('ignores anything but the primary button, so a context menu still opens', () => {
    expect(isCarry(event({ altKey: true, button: 2 }))).toBe(false);
  });
});

describe('carriedIds', () => {
  it('carries the one node that was grabbed', () => {
    expect(carriedIds('S1', [])).toEqual(['S1']);
    expect(carriedIds('S1', ['S1'])).toEqual(['S1']);
  });

  it('carries the whole selection when the grabbed node is part of it', () => {
    expect(carriedIds('S1', ['S1', 'S2', 'S3'])).toEqual(['S1', 'S2', 'S3']);
  });

  /**
   * Grabbing something outside the selection is how a reader says "not those,
   * this one" — the same way dragging an unselected card in the drawer does.
   */
  it('carries only the grabbed node when it is not in the selection', () => {
    expect(carriedIds('S9', ['S1', 'S2'])).toEqual(['S9']);
  });

  it('does not hand back the selection array itself', () => {
    const selection = ['S1', 'S2'];
    expect(carriedIds('S1', selection)).not.toBe(selection);
  });
});
