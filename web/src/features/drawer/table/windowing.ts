/**
 * Pure windowing math for virtualizing a scrollable list.
 *
 * Used by the Table drawer to render only the rows in (and just around) the
 * viewport, so DOM cost scales with the viewport, not the board size.
 *
 * No dependencies — only arithmetic.
 */

export interface WindowSlice {
  /** Index of the first rendered row. */
  start: number;
  /** Number of rendered rows. */
  count: number;
  /** Height in px of the top spacer, which keeps the scroll position correct. */
  topPad: number;
  /** Height in px of the bottom spacer. */
  bottomPad: number;
}

/**
 * Compute which slice of `total` rows to render given the scroll position.
 *
 * @param scrollTop  Pixels scrolled from the top of the container.
 * @param viewHeight Visible height of the scroll container in px.
 * @param rowHeight  Fixed height of a single row in px.
 * @param total      Total number of rows in the data set.
 * @param overscan   Extra rows to render above and below the viewport, so
 *                   scrolling into them is a repaint rather than a DOM change.
 *                   Defaults to 5.
 */
export function windowSlice(
  scrollTop: number,
  viewHeight: number,
  rowHeight: number,
  total: number,
  overscan = 5,
): WindowSlice {
  if (total <= 0 || viewHeight <= 0 || rowHeight <= 0) {
    return { start: 0, count: 0, topPad: 0, bottomPad: 0 };
  }

  // How many rows fit in the viewport, rounded up so we never leave a gap.
  const viewRows = Math.ceil(viewHeight / rowHeight);

  // First visible row index, clamped. Subtracting the overscan means we start
  // rendering a few rows above what the reader can see.
  const rawStart = Math.floor(scrollTop / rowHeight) - overscan;
  const start = Math.max(0, rawStart);

  // Last visible row index, plus overscan, clamped to the data set.
  const rawEnd = rawStart + viewRows + overscan * 2;
  const end = Math.min(total, Math.max(0, rawEnd));

  const count = Math.max(0, end - start);
  const topPad = start * rowHeight;
  const bottomPad = Math.max(0, (total - end) * rowHeight);

  return { start, count, topPad, bottomPad };
}

/**
 * The pixel offset of a row at `index`, given the fixed row height.
 * Used to scroll a specific row into the viewport.
 */
export function rowOffset(index: number, rowHeight: number): number {
  return index * rowHeight;
}

/**
 * The index of the row at a given pixel offset, clamped to `[0, total)`.
 */
export function rowAtOffset(offset: number, rowHeight: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(total - 1, Math.floor(offset / rowHeight)));
}
