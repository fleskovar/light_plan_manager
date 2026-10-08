import { describe, expect, it } from 'vitest';
import { MAX_SCALE, paneFit, paneScale } from '$lib/ui/scale.js';

/**
 * The one number that makes a dragged-open pane readable. Everything else about
 * it is CSS, so this is where the shape of the curve is pinned down.
 */
describe('paneScale', () => {
  it('leaves a pane at its default size alone', () => {
    expect(paneScale(320, 320)).toBe(1);
  });

  it('never shrinks the text of a pane someone made smaller', () => {
    expect(paneScale(120, 320)).toBe(1);
  });

  it('grows more slowly than the pane, so a bigger pane shows more', () => {
    const doubled = paneScale(640, 320);
    expect(doubled).toBeGreaterThan(1);
    expect(doubled).toBeLessThan(2);
    expect(doubled).toBeCloseTo(1.41, 2);
  });

  it('stops growing, so a full-screen drawer is not a poster', () => {
    expect(paneScale(4000, 320)).toBe(MAX_SCALE);
  });

  it('survives a view file with nonsense in it', () => {
    expect(paneScale(Number.NaN, 320)).toBe(1);
    expect(paneScale(320, 0)).toBe(1);
  });
});

/**
 * The guard that keeps a saved size from eating the window it is replayed in.
 * The numbers are the ones that caused it: a drawer saved at 865px, opened in
 * an 808px window, which left the canvas at zero height and hung off the
 * bottom of the screen.
 */
describe('paneFit', () => {
  it('honours a saved size that fits', () => {
    expect(paneFit(360, 800, 120)).toBe(360);
  });

  it('keeps the pane beside it alive when the saved size is too tall', () => {
    // 865 saved, 762 of stack, 120 reserved for the canvas.
    expect(paneFit(865, 762, 120)).toBe(642);
  });

  it('takes what exists rather than overflowing a very short window', () => {
    // Nothing can keep the reserve here, and a drawer hanging past the bottom
    // of the screen is worse than a short one.
    expect(paneFit(865, 90, 120)).toBe(90);
  });

  it('trusts the saved size until the container has been measured', () => {
    // The first paint reports 0; collapsing the pane for a frame would flash.
    expect(paneFit(360, 0, 120)).toBe(360);
    expect(paneFit(360, Number.NaN, 120)).toBe(360);
  });

  it('survives a view file with nonsense in it', () => {
    expect(paneFit(Number.NaN, 800, 120)).toBe(0);
    expect(paneFit(-40, 800, 120)).toBe(0);
  });
});
