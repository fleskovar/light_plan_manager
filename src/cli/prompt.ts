/**
 * Asking one question, synchronously.
 *
 * Every `lpm` command is `run(args): number`, and an exit code that a script can
 * trust is worth more than the convenience of `await`. So this reads stdin a
 * byte at a time rather than reaching for `readline` — and a caller only ever
 * asks when stdin is a terminal, because a command that blocks in CI is a hung
 * build.
 *
 * Two ways of reading, and the difference is what the terminal shows. `readLine`
 * echoes, like any other prompt. `readSecret` turns echo off and prints one dot
 * per character, so a token pasted into a shared screen or a recorded session
 * does not end up in the scrollback — the same reason `lpm remote login` has
 * never taken the value as a flag.
 *
 * Above those sit the three questions a command actually asks: `ask` (one
 * value), `choose` (one of a numbered list) and `confirm` (yes or no). They are
 * here rather than beside their callers because `lpm agent` and `lpm remote`
 * must not disagree about what a bare Enter means, or what happens when there
 * is no terminal at all.
 */

import { readSync } from 'node:fs';
import { BoardError } from '../core/index.js';
import { bold, dim, out } from './ui.js';

/** Read one byte from stdin, retrying the read a terminal defers. */
function readByte(buffer: Buffer): number {
  for (;;) {
    try {
      return readSync(0, buffer, 0, 1, null);
    } catch (error) {
      // A TTY with nothing typed yet reports EAGAIN on some platforms; the read
      // is retried rather than treated as end of input.
      if ((error as NodeJS.ErrnoException).code === 'EAGAIN') continue;
      if ((error as NodeJS.ErrnoException).code === 'EOF') return 0;
      throw error;
    }
  }
}

/** Read one echoed line from stdin. Returns null at EOF. */
export function readLine(): string | null {
  const buffer = Buffer.alloc(1);
  let line = '';
  for (;;) {
    const read = readByte(buffer);
    if (read === 0) return line || null;
    const char = buffer.toString('utf8');
    if (char === '\n') return line.trim();
    if (char !== '\r') line += char;
  }
}

/**
 * Read one line with the terminal's echo turned off, drawing a dot per
 * character so the typist can still see that the paste landed.
 *
 * Bytes are collected and decoded at the end rather than per byte, because a
 * character outside ASCII arrives in pieces and half of one is not a string.
 * Ctrl-C is answered here rather than left to the default handler: raw mode is
 * this function's to undo, and a terminal left raw is a broken shell.
 */
export function readSecret(): string | null {
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw === true;
  try {
    stdin.setRawMode?.(true);
  } catch {
    // A terminal that will not go raw still takes a line; it is echoed, which
    // is worse than a row of dots and much better than no way to type at all.
    return readLine();
  }

  const buffer = Buffer.alloc(1);
  const bytes: number[] = [];
  try {
    for (;;) {
      const read = readByte(buffer);
      const byte = buffer[0]!;
      if (read === 0 || byte === 0x04) break; // EOF, or Ctrl-D
      if (byte === 0x0a || byte === 0x0d) break; // Enter
      if (byte === 0x03) {
        process.stdout.write('\n');
        throw new BoardError('Cancelled', ['Nothing was written.']);
      }
      if (byte === 0x7f || byte === 0x08) {
        // Backspace: drop the last whole character, and one dot with it.
        if (bytes.pop() !== undefined) {
          while (bytes.length > 0 && (bytes[bytes.length - 1]! & 0xc0) === 0x80) bytes.pop();
          process.stdout.write('\b \b');
        }
        continue;
      }
      if (byte < 0x20) continue; // an escape sequence, an arrow key: not input
      bytes.push(byte);
      if ((byte & 0xc0) !== 0x80) process.stdout.write('*');
    }
  } finally {
    stdin.setRawMode?.(wasRaw);
  }

  process.stdout.write('\n');
  const line = Buffer.from(bytes).toString('utf8').trim();
  return line === '' ? null : line;
}

/**
 * Ask for one value at the terminal. `secret` hides what is typed.
 *
 * Returns the trimmed answer, or null when the person pressed Enter without
 * typing anything — which every caller here reads as "leave this one alone"
 * rather than as an empty value.
 */
export function ask(question: string, opts: { secret?: boolean } = {}): string | null {
  process.stdout.write(question);
  const answer = opts.secret === true ? readSecret() : readLine();
  return answer === null || answer === '' ? null : answer;
}

export interface Choice<T extends string> {
  value: T;
  label: string;
  detail: string;
}

/**
 * Offer a numbered choice. The first is the default, taken on a bare Enter.
 * With no terminal to ask, this throws rather than guessing: installing into the
 * wrong scope is tedious to undo by hand.
 */
export function choose<T extends string>(
  question: string,
  choices: Choice<T>[],
  flagHint: string,
): T {
  if (!process.stdin.isTTY) {
    throw new BoardError(`${question} — and there is no terminal to ask`, [
      `Pass ${flagHint} explicitly.`,
    ]);
  }

  out();
  out(bold(question));
  choices.forEach((choice, index) => {
    const marker = index === 0 ? dim(' (default)') : '';
    out(`  ${index + 1}) ${choice.label}${marker}`);
    out(`     ${dim(choice.detail)}`);
  });
  out();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    process.stdout.write(`Choose 1-${choices.length}: `);
    const answer = readLine();
    if (answer === null) break;
    if (answer === '') return choices[0]!.value;

    const byNumber = Number(answer);
    if (Number.isInteger(byNumber) && byNumber >= 1 && byNumber <= choices.length) {
      return choices[byNumber - 1]!.value;
    }
    const byName = choices.find((choice) => choice.value === answer.toLowerCase());
    if (byName) return byName.value;

    out(dim(`  "${answer}" is not one of them.`));
  }

  throw new BoardError('No choice made', [`Pass ${flagHint} explicitly.`]);
}


/**
 * Ask a yes/no question. `fallback` is the answer a bare Enter gives, and the
 * answer a caller gets when there is no terminal — a question nobody can be
 * asked must not stop a script, and every caller here has a safe default.
 */
export function confirm(question: string, fallback: boolean): boolean {
  if (!process.stdin.isTTY) return fallback;
  const hint = fallback ? 'Y/n' : 'y/N';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = ask(`${question} [${hint}] `);
    if (answer === null) return fallback;
    const word = answer.toLowerCase();
    if (word === 'y' || word === 'yes') return true;
    if (word === 'n' || word === 'no') return false;
    out(dim(`  "${answer}" is not yes or no.`));
  }
  return fallback;
}
