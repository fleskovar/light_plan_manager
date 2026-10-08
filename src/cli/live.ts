/**
 * A block of terminal that redraws itself in place.
 *
 * `lpm` prints reports: a command says what happened and exits. One command
 * does not — `lpm queue agent` runs for as long as there is work — and a run
 * nobody can see into is a run nobody trusts. This is the primitive that lets
 * it show what the agent is doing without scrolling a thousand lines past.
 *
 * It draws a fixed number of lines and rewrites them, so the transcript above
 * stays where the reader left it. Everything about that is conditional on
 * writing to a terminal: with output redirected, `set` does nothing at all and
 * the caller falls back to printing ordinary lines, because a log file full of
 * cursor escapes is worse than no live view.
 *
 * It owns nothing but the cursor. What to put in the lines is the caller's
 * business, which is why nothing here mentions an agent, a task or a board.
 */

const ESC = '\x1b';
/** Matches an ANSI escape sequence, so width can be measured on what is seen. */
const ANSI = /\x1b\[[0-9;]*m/g;

export interface LivePane {
  /** False when output is not a terminal: `set` is a no-op and the caller prints instead. */
  readonly live: boolean;
  /** Replace what the pane shows. Extra lines are dropped, short frames padded. */
  set(lines: string[]): void;
  /** Erase the pane and give the cursor back. Safe to call twice. */
  stop(): void;
}

export interface LivePaneOptions {
  /** Where to draw. Defaults to stderr, so stdout stays a clean report. */
  stream?: NodeJS.WriteStream;
}

/** The printable width of a string, ignoring colour. */
export function visibleWidth(text: string): number {
  return text.replace(ANSI, '').length;
}

/**
 * Cut a string to `width` printable characters — the ellipsis included, so the
 * result is never wider than it was asked for — keeping colour codes intact and
 * closing them off. A line longer than the terminal would wrap, and a wrapped
 * line makes the pane taller than it says it is, which corrupts every redraw
 * after it.
 */
export function truncateVisible(text: string, width: number): string {
  if (width <= 0) return '';
  if (visibleWidth(text) <= width) return text;
  let out = '';
  let seen = 0;
  let index = 0;
  while (index < text.length && seen < width - 1) {
    ANSI.lastIndex = index;
    const match = ANSI.exec(text);
    if (match && match.index === index) {
      out += match[0];
      index += match[0].length;
      continue;
    }
    out += text[index];
    index += 1;
    seen += 1;
  }
  return `${out}…${ESC}[0m`;
}

export function createLivePane(options: LivePaneOptions = {}): LivePane {
  const stream = options.stream ?? process.stderr;
  const live = Boolean(stream.isTTY);
  let drawn = 0;
  let stopped = false;

  const width = (): number => Math.max(20, (stream.columns ?? 80) - 1);

  const write = (text: string): void => {
    stream.write(text);
  };

  if (live) write(`${ESC}[?25l`);

  return {
    live,
    set(lines) {
      if (!live || stopped) return;
      const frame = lines.map((line) => truncateVisible(line, width()));
      // Back to the top of the last frame, then one line at a time: clearing
      // each line as it is rewritten is what stops a short line from leaving
      // the tail of a long one behind it.
      let text = drawn ? `${ESC}[${drawn}A` : '';
      for (const line of frame) text += `${ESC}[2K${line}\n`;
      // A frame shorter than the last one has to erase the difference, or the
      // leftovers become part of the next frame's height.
      const extra = Math.max(0, drawn - frame.length);
      for (let i = 0; i < extra; i += 1) text += `${ESC}[2K\n`;
      if (extra) text += `${ESC}[${extra}A`;
      drawn = frame.length;
      write(text);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (!live) return;
      let text = drawn ? `${ESC}[${drawn}A` : '';
      for (let i = 0; i < drawn; i += 1) text += `${ESC}[2K\n`;
      if (drawn) text += `${ESC}[${drawn}A`;
      drawn = 0;
      write(`${text}${ESC}[?25h`);
    },
  };
}

/**
 * A window onto the tail of a long stream of lines.
 *
 * The pane shows the last `height` lines as they arrive, which is what somebody
 * watching a run wants nine times in ten. The tenth time they want the line
 * that has just scrolled off, so the buffer keeps `limit` of them and `scroll`
 * moves the window back through it. Following resumes the moment the window
 * reaches the end again — a view that stayed where it was put would silently
 * stop being live.
 */
export interface ScrollBuffer {
  push(line: string): void;
  /** Move the window by `delta` lines; negative is back into the history. */
  scroll(delta: number): void;
  /** The lines to draw, oldest first, exactly `height` of them or fewer. */
  window(height: number): string[];
  /** How many lines are hidden below the window; 0 when following the tail. */
  readonly behind: number;
  readonly size: number;
}

export function createScrollBuffer(limit = 2000): ScrollBuffer {
  const lines: string[] = [];
  // How far the window's bottom edge sits above the newest line. 0 is "follow".
  let offset = 0;

  return {
    push(line) {
      lines.push(line);
      if (lines.length > limit) lines.splice(0, lines.length - limit);
      // Scrolled back: hold the same lines in view as new ones arrive, until
      // the history runs out from under us.
      if (offset > 0) offset = Math.min(offset + 1, lines.length - 1);
    },
    scroll(delta) {
      offset = Math.max(0, Math.min(offset - delta, Math.max(0, lines.length - 1)));
    },
    window(height) {
      const end = Math.max(0, lines.length - offset);
      return lines.slice(Math.max(0, end - height), end);
    },
    get behind() {
      return offset;
    },
    get size() {
      return lines.length;
    },
  };
}

/**
 * Arrow keys and page keys, for as long as a run lasts.
 *
 * Reading keys means raw mode, and raw mode means this file owns Ctrl-C: the
 * terminal no longer turns it into a signal, so it is caught here and turned
 * back into one. Getting that wrong makes a long run unstoppable, which is a
 * worse bug than the one scrolling fixes, so `detach` is idempotent and is
 * called from `stop` as well as from the exit handler.
 */
export function attachScrollKeys(
  onScroll: (delta: number) => void,
  onInterrupt: () => void,
): () => void {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== 'function') return () => {};

  const onData = (chunk: Buffer): void => {
    const key = chunk.toString('utf8');
    if (key === '\x03') {
      onInterrupt();
      return;
    }
    if (key === `${ESC}[A` || key === 'k') onScroll(-1);
    else if (key === `${ESC}[B` || key === 'j') onScroll(1);
    else if (key === `${ESC}[5~`) onScroll(-10);
    else if (key === `${ESC}[6~`) onScroll(10);
    else if (key === `${ESC}[H`) onScroll(-1e9);
    else if (key === `${ESC}[F` || key === 'G') onScroll(1e9);
  };

  input.setRawMode(true);
  input.resume();
  input.on('data', onData);
  // Never hold the process open for a keystroke that is not coming.
  input.unref();

  let detached = false;
  const detach = (): void => {
    if (detached) return;
    detached = true;
    input.off('data', onData);
    if (input.isTTY) input.setRawMode(false);
    input.pause();
  };
  process.once('exit', detach);
  return detach;
}
