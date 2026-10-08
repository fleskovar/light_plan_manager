import { describe, expect, it } from 'vitest';
import { rowAtOffset, rowOffset, windowSlice } from '$features/drawer/table/windowing.js';

describe('windowSlice', () => {
  const ROW = 32; // row height in px

  it('returns nothing for zero total', () => {
    expect(windowSlice(0, 600, ROW, 0)).toEqual({
      start: 0,
      count: 0,
      topPad: 0,
      bottomPad: 0,
    });
  });

  it('returns nothing for zero view height', () => {
    expect(windowSlice(0, 0, ROW, 100)).toEqual({
      start: 0,
      count: 0,
      topPad: 0,
      bottomPad: 0,
    });
  });

  it('renders all rows when they fit without scrolling', () => {
    const view = 10 * ROW; // 320px — exactly 10 rows
    const result = windowSlice(0, view, ROW, 10);
    expect(result.start).toBe(0);
    expect(result.count).toBe(10);
    expect(result.topPad).toBe(0);
    expect(result.bottomPad).toBe(0);
  });

  it('renders a window near the top with overscan', () => {
    // Viewport holds 10 rows. Total is 100.
    const view = 10 * ROW;
    const result = windowSlice(0, view, ROW, 100);
    // start = floor(0/32) - 5 = -5 → clamped to 0
    expect(result.start).toBe(0);
    // end = -5 + 10 + 10 = 15, clamped to 100
    // count = 15 - 0 = 15
    expect(result.count).toBe(15);
    expect(result.topPad).toBe(0);
    expect(result.bottomPad).toBe((100 - 15) * ROW);
  });

  it('renders a window in the middle', () => {
    const view = 10 * ROW;
    // scrollTop = 50 rows down = 50 * 32 = 1600px
    const scrollTop = 50 * ROW;
    const result = windowSlice(scrollTop, view, ROW, 100);
    // rawStart = floor(1600/32) - 5 = 50 - 5 = 45
    // rawEnd = 45 + 10 + 10 = 65
    expect(result.start).toBe(45);
    expect(result.count).toBe(20);
    expect(result.topPad).toBe(45 * ROW);
    expect(result.bottomPad).toBe((100 - 65) * ROW);
  });

  it('clamps overscan at the top', () => {
    const view = 10 * ROW;
    // scrollTop = 2 rows down — overscan would go negative
    const result = windowSlice(2 * ROW, view, ROW, 100);
    // rawStart = floor(64/32) - 5 = 2 - 5 = -3 → clamped to 0
    expect(result.start).toBe(0);
    // rawEnd = -3 + 10 + 10 = 17
    expect(result.count).toBe(17);
    expect(result.topPad).toBe(0);
  });

  it('clamps overscan at the bottom', () => {
    const view = 10 * ROW;
    // scrollTop is near the end
    const scrollTop = 95 * ROW;
    const result = windowSlice(scrollTop, view, ROW, 100);
    // rawStart = floor(3040/32) - 5 = 95 - 5 = 90
    // rawEnd = 90 + 10 + 10 = 110 → clamped to 100
    expect(result.start).toBe(90);
    expect(result.count).toBe(10);
    expect(result.topPad).toBe(90 * ROW);
    expect(result.bottomPad).toBe(0);
  });

  it('renders the full set when total is smaller than the overscan window', () => {
    // Only 5 rows total, viewport can show 10
    const view = 10 * ROW;
    const result = windowSlice(0, view, ROW, 5);
    expect(result.start).toBe(0);
    expect(result.count).toBe(5);
    expect(result.topPad).toBe(0);
    expect(result.bottomPad).toBe(0);
  });

  it('defaults overscan to 5', () => {
    const view = 10 * ROW;
    // Default overscan=5 should match explicit overscan=5
    expect(windowSlice(0, view, ROW, 100)).toEqual(
      windowSlice(0, view, ROW, 100, 5),
    );
  });

  it('handles fractional row heights cleanly', () => {
    // Viewport is 333px, rows 32px → 10.40625 rows visible, ceil → 11
    const result = windowSlice(0, 333, 32, 100);
    // rawStart = 0 - 5 → 0
    // rawEnd = -5 + 11 + 10 = 16
    expect(result.start).toBe(0);
    expect(result.count).toBe(16);
  });
});

describe('rowOffset', () => {
  it('returns 0 for the first row', () => {
    expect(rowOffset(0, 32)).toBe(0);
  });

  it('returns index * height', () => {
    expect(rowOffset(10, 32)).toBe(320);
  });
});

describe('rowAtOffset', () => {
  it('returns 0 for offset 0', () => {
    expect(rowAtOffset(0, 32, 100)).toBe(0);
  });

  it('returns the correct index', () => {
    expect(rowAtOffset(320, 32, 100)).toBe(10);
  });

  it('clamps to the last index', () => {
    expect(rowAtOffset(99999, 32, 100)).toBe(99);
  });

  it('returns 0 for an empty list', () => {
    expect(rowAtOffset(99999, 32, 0)).toBe(0);
  });
});
