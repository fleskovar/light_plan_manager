/**
 * How much a resizable pane grows the things inside it.
 *
 * A drawer dragged to twice its height should read like a table someone meant
 * to look at, not like the same eleven-pixel rows with a lot of empty space
 * under them. So the splitter reports a size, this turns it into a factor, and
 * the `.ui-scale` block in `app.css` redefines the type and spacing tokens in
 * terms of it — one number, and every component inside grows without knowing
 * anything about panes.
 *
 * The curve is deliberately gentle: growth goes as the square root of the extra
 * room, so a pane at twice its default size reads about 40% larger rather than
 * twice as large. Text that doubled would defeat the point of the drag, which
 * was to see *more*, not fewer things bigger. The floor is 1 — shrinking a pane
 * is how you get it out of the way, and unreadable text is not a smaller pane.
 */
export const MAX_SCALE = 1.5;

export function paneScale(size: number, base: number): number {
  if (!Number.isFinite(size) || !Number.isFinite(base) || base <= 0) return 1;
  const ratio = Math.max(size, base) / base;
  const scale = Math.min(Math.sqrt(ratio), MAX_SCALE);
  // Two decimals: enough to be smooth, few enough that a drag does not churn
  // the style attribute on every pixel.
  return Math.round(scale * 100) / 100;
}

/**
 * The height a pane may actually take, whatever height was saved for it.
 *
 * A saved size is a wish about a window somebody had at the time. Replayed in
 * a shorter one it is destructive rather than merely large: a drawer saved at
 * 865px in an 808px window left the canvas at **zero** height and hung 100px
 * past the bottom of the screen, so opening it looked less like a drawer and
 * more like the board disappearing — which is exactly how it was reported
 * ("I collapsed it and now it is stuck").
 *
 * So the wish is honoured up to the room there is, and `spare` is what the
 * pane beside it keeps no matter what. When even that will not fit — a very
 * short window — the pane takes what exists rather than overflowing, because a
 * control somebody cannot reach is worse than a small one.
 *
 * The saved value is left alone: a person who drags a drawer tall on a big
 * screen should find it tall again there, not silently shrunk by an afternoon
 * spent on a laptop.
 */
export function paneFit(saved: number, available: number, spare: number): number {
  if (!Number.isFinite(saved) || saved <= 0) return 0;
  // Nothing measured yet (the first paint, or a hidden container): the saved
  // size is the best guess there is, and clamping to 0 would collapse the pane
  // for a frame.
  if (!Number.isFinite(available) || available <= 0) return saved;
  const room = available - spare;
  return room <= 0 ? Math.min(saved, available) : Math.min(saved, room);
}
