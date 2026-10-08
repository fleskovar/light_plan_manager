import { describe, expect, it } from 'vitest';
import { createLivePane, createScrollBuffer, truncateVisible, visibleWidth } from '../src/cli/live.js';
import { createAgentView, elapsed, sanitize } from '../src/cli/agent-view.js';
import type { RunEvent } from '../src/runner/index.js';

/**
 * The live view of an agent run. Everything here is about the two ways it can
 * go wrong: a frame that is not the height it thinks it is (so the redraw walks
 * up the screen and eats the transcript), and a terminal left in raw mode.
 */

const ESC = '\x1b';

/** A stream that records what was written to it, pretending to be a terminal. */
function fakeTty(columns = 60): NodeJS.WriteStream & { text: string } {
  const chunks: string[] = [];
  const stream = {
    isTTY: true,
    columns,
    write(text: string) {
      chunks.push(text);
      return true;
    },
    get text() {
      return chunks.join('');
    },
  };
  return stream as unknown as NodeJS.WriteStream & { text: string };
}

function notTty(): NodeJS.WriteStream & { text: string } {
  const stream = fakeTty();
  (stream as unknown as { isTTY: boolean }).isTTY = false;
  return stream;
}

describe('visibleWidth / truncateVisible', () => {
  it('measures what is seen, not what is written', () => {
    expect(visibleWidth(`${ESC}[2mhello${ESC}[0m`)).toBe(5);
  });

  it('leaves a line that fits exactly as it was', () => {
    const line = `${ESC}[1mabc${ESC}[0m`;
    expect(truncateVisible(line, 5)).toBe(line);
  });

  it('cuts to the visible width, ellipsis included, and closes the colour off', () => {
    const cut = truncateVisible(`${ESC}[2mabcdefghij${ESC}[0m`, 4);
    expect(visibleWidth(cut)).toBe(4);
    expect(cut).toContain('abc…');
    expect(cut.endsWith(`${ESC}[0m`)).toBe(true);
  });

  it('keeps the colour codes it passed on the way', () => {
    expect(truncateVisible(`${ESC}[2mabcdef`, 3)).toContain(`${ESC}[2m`);
  });
});

describe('createLivePane', () => {
  it('does nothing at all when the output is not a terminal', () => {
    const stream = notTty();
    const pane = createLivePane({ stream });
    expect(pane.live).toBe(false);
    pane.set(['one', 'two']);
    pane.stop();
    expect(stream.text).toBe('');
  });

  it('moves back over exactly as many lines as it drew', () => {
    const stream = fakeTty();
    const pane = createLivePane({ stream });
    pane.set(['a', 'b', 'c']);
    const before = stream.text;
    expect(before).not.toContain(`${ESC}[3A`);
    pane.set(['d', 'e', 'f']);
    expect(stream.text.slice(before.length)).toContain(`${ESC}[3A`);
  });

  it('erases the tail when a frame gets shorter', () => {
    const stream = fakeTty();
    const pane = createLivePane({ stream });
    pane.set(['a', 'b', 'c']);
    const before = stream.text.length;
    pane.set(['a']);
    const frame = stream.text.slice(before);
    // One line rewritten, two blanked, then back up over the two blanks.
    expect(frame.match(/\x1b\[2K/g)?.length).toBe(3);
    expect(frame).toContain(`${ESC}[2A`);
  });

  it('never draws a line wider than the terminal', () => {
    const stream = fakeTty(20);
    const pane = createLivePane({ stream });
    pane.set(['x'.repeat(100)]);
    for (const line of stream.text.split('\n')) {
      expect(visibleWidth(line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''))).toBeLessThanOrEqual(20);
    }
  });

  it('gives the cursor back on stop, once', () => {
    const stream = fakeTty();
    const pane = createLivePane({ stream });
    pane.set(['a']);
    pane.stop();
    pane.stop();
    expect(stream.text.match(/\x1b\[\?25h/g)?.length).toBe(1);
  });
});

describe('createScrollBuffer', () => {
  it('shows the tail by default', () => {
    const buffer = createScrollBuffer();
    for (const n of [1, 2, 3, 4, 5]) buffer.push(`line ${n}`);
    expect(buffer.window(2)).toEqual(['line 4', 'line 5']);
    expect(buffer.behind).toBe(0);
  });

  it('scrolls back into the history and reports how far', () => {
    const buffer = createScrollBuffer();
    for (const n of [1, 2, 3, 4, 5]) buffer.push(`line ${n}`);
    buffer.scroll(-2);
    expect(buffer.window(2)).toEqual(['line 2', 'line 3']);
    expect(buffer.behind).toBe(2);
  });

  it('holds its place as new lines arrive, then follows again at the end', () => {
    const buffer = createScrollBuffer();
    for (const n of [1, 2, 3, 4, 5]) buffer.push(`line ${n}`);
    buffer.scroll(-2);
    buffer.push('line 6');
    expect(buffer.window(2)).toEqual(['line 2', 'line 3']);
    buffer.scroll(1e9);
    expect(buffer.behind).toBe(0);
    expect(buffer.window(2)).toEqual(['line 5', 'line 6']);
  });

  it('forgets the oldest lines rather than growing without end', () => {
    const buffer = createScrollBuffer(10);
    for (let n = 0; n < 50; n += 1) buffer.push(`line ${n}`);
    expect(buffer.size).toBe(10);
    expect(buffer.window(1)).toEqual(['line 49']);
  });
});

describe('elapsed / sanitize', () => {
  it('says how long in as few characters as it can', () => {
    expect(elapsed(9_000)).toBe('9s');
    expect(elapsed(192_000)).toBe('3m 12s');
    expect(elapsed(3_840_000)).toBe('1h 04m');
  });

  it('flattens whatever a command wrote into something drawable', () => {
    expect(sanitize('a\r\nb')).toBe('a\nb');
    expect(sanitize(`${ESC}[31mred${ESC}[0m`)).toBe('red');
    expect(sanitize('a\tb')).toBe('a  b');
    expect(sanitize('a\x07b')).toBe('ab');
  });
});

describe('createAgentView', () => {
  const events: RunEvent[] = [
    { type: 'task-start', index: 1, id: 'LP-7', title: 'Guest checkout' },
    { type: 'phase', phase: 'running' },
    { type: 'tool-start', name: 'bash', summary: 'npm test' },
    { type: 'tool-output', text: 'ok 1 - it works\n' },
    { type: 'tool-end', name: 'bash', ms: 1200, isError: false },
    { type: 'task-end', id: 'LP-7', completed: true, summary: 'done' },
  ];

  it('draws a frame of a fixed height, whatever has happened', () => {
    const stream = fakeTty(80);
    const view = createAgentView({ stream, height: 4 });
    for (const event of events) view.feed(event);
    view.stop();
    // header, stage, rule, four output lines, hint.
    expect(stream.text).toContain(`${ESC}[8A`);
  });

  it('shows the task, the stage and the running tool', () => {
    const stream = fakeTty(80);
    const view = createAgentView({ stream, height: 4 });
    view.feed(events[0]!);
    view.feed(events[1]!);
    view.feed(events[2]!);
    const text = stream.text;
    view.stop();
    expect(text).toContain('LP-7');
    expect(text).toContain('Guest checkout');
    expect(text).toContain('agent working');
    expect(text).toContain('npm test');
  });

  it('joins streamed fragments into lines', () => {
    const stream = fakeTty(80);
    const view = createAgentView({ stream, height: 4 });
    view.feed(events[0]!);
    view.feed({ type: 'agent-text', text: 'Looking at ' });
    view.feed({ type: 'agent-text', text: 'the tests\n' });
    const text = stream.text;
    view.stop();
    expect(text).toContain('Looking at the tests');
  });

  it('logs one line per event and no escapes when nothing is a terminal', () => {
    const stream = notTty();
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (text: string) => boolean }).write = (text) => {
      written.push(text);
      return true;
    };
    try {
      const view = createAgentView({ stream });
      for (const event of events) view.feed(event);
      view.stop();
    } finally {
      (process.stderr as unknown as { write: typeof original }).write = original;
    }
    const text = written.join('');
    expect(text).toContain('LP-7');
    expect(text).toContain('npm test');
    expect(text).not.toContain(`${ESC}[2K`);
    // The agent's own chatter never reaches a log.
    expect(text).not.toContain('ok 1 - it works');
  });
});
