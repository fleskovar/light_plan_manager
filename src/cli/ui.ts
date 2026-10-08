import { redactor } from '../remote/redact.js';

const ESC = '\x1b';
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function paint(code: string): (text: string) => string {
  return (text) => (useColor ? `${ESC}[${code}m${text}${ESC}[0m` : text);
}

export const bold = paint('1');
export const dim = paint('2');
export const red = paint('31');
export const green = paint('32');
export const yellow = paint('33');
export const cyan = paint('36');

export function out(line = ''): void {
  process.stdout.write(`${redactor.redact(line)}\n`);
}

export function err(line = ''): void {
  process.stderr.write(`${redactor.redact(line)}\n`);
}

/**
 * A failure, as every command reports one: the message, then each hint on its
 * own line, in red on a terminal that has colour.
 *
 * One definition because there are two callers and they used to be one: the
 * top-level `try` in `index.ts`, and a command whose work outlives its `run`.
 * `lpm ui` is the second kind — it hands the socket to Node and returns — so a
 * `BoardError` thrown from its promise chain reached nobody and Node printed a
 * raw stack dump instead:
 *
 *     BoardError: Port 4571 is already in use
 *         at file:///…/dist/cli/commands/ui.js:67:15 {
 *       details: [ 'Pass --port <n> to use a different port.' ]
 *     }
 *
 * which is a crash report for what is an ordinary answer. Anything async
 * reports through here and sets `process.exitCode` itself.
 *
 * Takes the shape rather than the type, so this file keeps importing nothing
 * but the redactor.
 */
export function reportError(error: unknown): void {
  const problem = error as { message?: string; details?: string[] };
  err(`${red('error')} ${problem?.message ?? String(error)}`);
  for (const detail of problem?.details ?? []) err(`       ${detail}`);
}

/**
 * The containers a status change carried with it — a feature closed by its last
 * story, an epic closed by that feature. Printed by every command that can move
 * an issue, because a status nobody typed has to be visible where it happened.
 *
 * Takes the shape rather than the type, so this file keeps importing nothing.
 */
export function printRollups(
  rollups: ReadonlyArray<{ issue: { id: string; title: string }; from: string; to: string }>,
): void {
  for (const rollup of rollups) {
    out(
      `  ${dim('rolled up')} ${bold(rollup.issue.id)}  ${rollup.issue.title}  ` +
        `${rollup.from} ${dim('->')} ${rollup.to}`,
    );
  }
}

/**
 * The containers a dependency puts in order behind each other, because of the
 * work inside them. Printed where a dependency is written, so the reach of one
 * story-level edge is visible at the moment somebody draws it.
 *
 * Nothing is written on those containers — @see src/shared/dependency-rollup.ts
 * for why — so the wording says "orders", not "linked".
 */
export function printDependencyRollups(
  rolled: ReadonlyArray<{
    issue: { id: string; title: string };
    blocker: { id: string; title: string };
  }>,
): void {
  for (const entry of rolled) {
    out(
      `  ${dim('also orders')} ${bold(entry.issue.id)}  ${entry.issue.title}  ` +
        `${dim('after')} ${bold(entry.blocker.id)}  ${entry.blocker.title}`,
    );
  }
}

export function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}
