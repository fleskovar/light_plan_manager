import type { RunEvent, RunPhase } from '../runner/index.js';
import { attachScrollKeys, createLivePane, createScrollBuffer, visibleWidth } from './live.js';
import { bold, cyan, dim, err, green, red, yellow } from './ui.js';

/**
 * What `lpm queue agent` looks like while it runs.
 *
 * The run reports itself as a stream of `RunEvent`s; this is the only thing
 * that decides how any of it is drawn. Two shapes, chosen by where the output
 * goes and never by a flag alone:
 *
 * - **On a terminal**, a pane at the bottom of the screen: which task, which
 *   stage, which tool, and the tail of what the agent is saying and running.
 *   It is a window, not a transcript — a few lines that are rewritten in place
 *   and can be scrolled back through, so an hour-long run does not bury the
 *   report it ends with.
 * - **Anywhere else** (a pipe, a log, `--plain`), one line per thing that
 *   happened and nothing else. The agent's own chatter is dropped rather than
 *   flooding a log with a model thinking out loud.
 *
 * Nothing here writes to stdout: the run's report is stdout, and this is the
 * commentary beside it, so `lpm queue agent > run.txt` still gets a clean file.
 */

/** How many lines of the agent's stream the pane shows at once. */
const WINDOW = 10;
/** Redraw at most this often. Deltas arrive far faster than anyone can read. */
const FRAME_MS = 120;

export interface AgentView {
  /** Feed the view one event from the run. */
  feed(event: RunEvent): void;
  /** Take the pane down and give the terminal back. Safe to call twice. */
  stop(): void;
}

export interface AgentViewOptions {
  /** Draw plain lines even on a terminal. */
  plain?: boolean;
  /** Lines of agent output to show at once. */
  height?: number;
  /** Where the pane is drawn. Defaults to stderr; a test passes its own. */
  stream?: NodeJS.WriteStream;
}

/** What each stage of a task is called on screen, in the order they happen. */
const PHASES: Record<RunPhase, string> = {
  picking: 'reading the board',
  claiming: 'claiming the task',
  briefing: 'building the brief',
  running: 'agent working',
  recording: 'recording the outcome',
  committing: 'committing',
};

/** `12s`, `3m 12s`, `1h 04m` — short enough to sit in a corner. */
export function elapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

/**
 * Make a fragment of somebody else's output safe to put in a frame.
 *
 * Tool output is whatever a command wrote: carriage returns that would jump the
 * cursor, escape sequences that would repaint half the screen, tabs that make a
 * line wider than it measures. All of it is flattened to plain text, because
 * the pane's arithmetic only holds if a line is as wide as it looks.
 */
export function sanitize(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\t/g, '  ')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

interface Task {
  index: number;
  id: string;
  title: string;
  startedAt: number;
}

export function createAgentView(options: AgentViewOptions = {}): AgentView {
  const height = options.height ?? WINDOW;
  const stream = options.stream ?? process.stderr;
  const pane = createLivePane({ stream });
  const live = pane.live && !options.plain;
  const buffer = createScrollBuffer();

  let task: Task | null = null;
  let phase: RunPhase = 'picking';
  let tool: string | null = null;
  let tools = 0;
  let errors = 0;
  let dirty = true;
  let timer: NodeJS.Timeout | undefined;
  let detachKeys: (() => void) | undefined;
  let stopped = false;

  // One partial line at a time, tagged with what is writing it: a switch from
  // the agent's prose to a command's output ends the line in progress, so two
  // sources cannot end up spliced into one.
  let pending = '';
  let pendingFrom = '';

  const flush = (): void => {
    if (!pending) return;
    buffer.push(pending);
    pending = '';
  };

  const append = (from: string, text: string, style: (line: string) => string): void => {
    if (from !== pendingFrom) {
      flush();
      pendingFrom = from;
    }
    const parts = sanitize(text).split('\n');
    for (let i = 0; i < parts.length; i += 1) {
      pending += style(parts[i]!);
      if (i < parts.length - 1) flush();
    }
    dirty = true;
  };

  const line = (text: string): void => {
    flush();
    buffer.push(text);
    dirty = true;
  };

  const columns = (): number => Math.max(40, (stream.columns ?? 80) - 1);

  /** Left text, right text, one line, whatever width the terminal is now. */
  const pad = (left: string, right: string): string => {
    const gap = columns() - visibleWidth(left) - visibleWidth(right) - 2;
    return gap > 1 ? `${left}${' '.repeat(gap)}${right}` : left;
  };

  const frame = (): string[] => {
    const rows: string[] = [];
    if (task) {
      const left = `  ${bold(task.id)}  ${task.title}`;
      const right = `task ${task.index} · ${elapsed(Date.now() - task.startedAt)}`;
      rows.push(pad(left, right));
      const counts = [`${tools} ${tools === 1 ? 'tool' : 'tools'}`];
      if (errors) counts.push(`${errors} failed`);
      const doing = tool ? `${PHASES[phase]} · ${cyan(tool)}` : PHASES[phase];
      rows.push(pad(`  ${dim(doing)}`, dim(counts.join(' · '))));
    } else {
      rows.push(`  ${dim(PHASES[phase])}`);
    }
    rows.push(dim(`  ${'─'.repeat(Math.max(10, columns() - 4))}`));
    const window = buffer.window(height);
    for (const text of window) rows.push(`  ${text}`);
    for (let i = window.length; i < height; i += 1) rows.push('');
    const hint = detachKeys ? '↑↓ PgUp/PgDn scroll · Ctrl+C stop' : '';
    rows.push(pad(`  ${dim(hint)}`, buffer.behind ? dim(`${buffer.behind} lines back`) : ''));
    return rows;
  };

  const draw = (): void => {
    if (!live || stopped) return;
    pane.set(frame());
    dirty = false;
  };

  if (live) {
    detachKeys = attachScrollKeys(
      (delta) => {
        buffer.scroll(delta);
        dirty = true;
      },
      () => {
        stop();
        err(dim('  interrupted — the task stays in progress and the next run resumes it'));
        process.exit(130);
      },
    );
    // The clock in the corner has to move even when nothing is happening: a
    // frozen frame and a stalled run look identical, and only one of them is a
    // reason to reach for Ctrl-C.
    timer = setInterval(() => {
      if (dirty || task) draw();
    }, FRAME_MS);
    timer.unref();
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    detachKeys?.();
    pane.stop();
  }

  return {
    stop,
    feed(event) {
      switch (event.type) {
        case 'task-start':
          task = { index: event.index, id: event.id, title: event.title, startedAt: Date.now() };
          tool = null;
          tools = 0;
          errors = 0;
          // The header already names the task; this is the marker somebody
          // scrolling back needs to see where one task ended and the next began.
          if (live) line(`${dim('──')} ${bold(event.id)}  ${event.title}`);
          else err(`${dim('picked')} ${bold(event.id)}  ${event.title}`);
          break;
        case 'phase':
          phase = event.phase;
          if (event.phase !== 'running') tool = null;
          dirty = true;
          break;
        case 'agent-text':
          if (live) append('text', event.text, (text) => text);
          break;
        case 'agent-thinking':
          if (live) append('thinking', event.text, dim);
          break;
        case 'tool-start':
          tools += 1;
          tool = event.summary ? `${event.name} ${event.summary}` : event.name;
          if (live) line(`${cyan(`❯ ${event.name}`)} ${dim(event.summary)}`);
          else err(`  ${dim(`${event.name} ${event.summary}`.trim())}`);
          break;
        case 'tool-output':
          if (live) append('output', event.text, dim);
          break;
        case 'tool-end':
          if (event.isError) errors += 1;
          if (live && event.isError) line(red(`  ${event.name} failed`));
          tool = null;
          dirty = true;
          break;
        case 'task-end': {
          const mark = event.completed
            ? green('done')
            : yellow(`flagged${event.flagReason ? ` (${event.flagReason})` : ''}`);
          if (live) line(`${bold(event.id)} ${mark}`);
          else err(`  ${bold(event.id)} ${mark}  ${dim(firstLine(event.summary))}`);
          task = null;
          tool = null;
          break;
        }
        case 'note':
          if (live) line(dim(event.text));
          else err(event.text);
          break;
      }
      if (dirty) draw();
    },
  };
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? '';
}
