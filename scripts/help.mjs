// `make help`: the targets, read from the `##` comments in the Makefile.
//
// This used to be an awk one-liner, which needs a POSIX shell; make on Windows
// hands recipes to cmd.exe when no sh is on the PATH. Colour only on a terminal.
import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
const colour = process.stdout.isTTY && !process.env.NO_COLOR;
const bold = (s) => (colour ? `\x1b[1m${s}\x1b[0m` : s);
const cyan = (s) => (colour ? `\x1b[36m${s}\x1b[0m` : s);

const lines = [];
for (const file of files) {
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const section = /^##@\s*(.*)$/.exec(line);
    if (section) {
      lines.push('', bold(section[1]));
      continue;
    }
    const target = /^([a-zA-Z0-9_-]+):.*?##\s*(.*)$/.exec(line);
    if (target) lines.push(`  ${cyan(target[1].padEnd(14))} ${target[2]}`);
  }
}
console.log(lines.join('\n') + '\n');
