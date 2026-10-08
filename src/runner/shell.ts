/**
 * The shell an agent run gets: non-interactive, and unable to open a window.
 *
 * `lpm queue agent` exists to work through a queue without a person sitting
 * over it, so a command that waits for somebody is not a slow command — it is a
 * stopped run. Three kinds of them turned up in practice, and all three are
 * answered here rather than in the loop:
 *
 * - a **pager** (`git log`, `man`) waiting for `q`;
 * - an **editor** (`git commit` with no `-m`) waiting for a file to be saved;
 * - a **window** (`start report.md`, `code src/x.ts`, `xdg-open`) handed to
 *   another program entirely, which the shell then waits for.
 *
 * `NON_INTERACTIVE_ENV` answers the first two the way CI does — by telling the
 * tools themselves, in their own vocabulary, that nobody is watching.
 * `blockedCommand` answers the third, because no environment variable stops
 * `start`. `pi.ts` applies both to every command the agent runs.
 *
 * **What this does not do.** It refuses the *known* ways to open a window; it
 * cannot make an arbitrary command safe, and it is not a sandbox — an agent
 * that wants to evade it can (`ec""ho`, a script, a `$(...)`). It is a guard
 * against a footgun, not a boundary against an adversary. The backstop that
 * holds whatever this misses is the per-command timeout in `pi.ts`.
 */

/**
 * What the agent's shell is told about its terminal. Every entry is a tool's
 * own documented way of saying "non-interactive", so nothing here depends on
 * guessing what a program will do.
 */
export const NON_INTERACTIVE_ENV: Readonly<Record<string, string>> = {
  // Pagers: print and exit rather than waiting for a keypress.
  PAGER: 'cat',
  GIT_PAGER: 'cat',
  MANPAGER: 'cat',
  GH_PAGER: 'cat',
  LESS: 'FRX',
  // Editors: succeed immediately instead of opening a buffer nobody will close.
  EDITOR: 'true',
  VISUAL: 'true',
  GIT_EDITOR: 'true',
  // Credential and confirmation prompts: fail rather than block on an answer.
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  DEBIAN_FRONTEND: 'noninteractive',
  npm_config_yes: 'true',
  npm_config_progress: 'false',
  npm_config_fund: 'false',
  // The one line that stops a test runner from starting in watch mode, and a
  // scaffolder from asking questions. Every major JS tool reads it.
  CI: 'true',
  // Some tools open a browser on success; there is nobody to look at it.
  BROWSER: 'none',
};

/**
 * Programs that hand the file to something else — another window, another
 * process — and then wait for it. Compared against the command's first word,
 * lowercased, with any directory and `.exe`/`.cmd` suffix removed.
 */
const OPENERS: Readonly<Record<string, string>> = {
  start: 'opens the file in whatever program is associated with it',
  open: 'opens the file in another application',
  'xdg-open': 'opens the file in another application',
  'gnome-open': 'opens the file in another application',
  'kde-open': 'opens the file in another application',
  gio: 'can open the file in another application',
  wslview: 'opens the file in a Windows application',
  explorer: 'opens a file-manager window',
  rundll32: 'launches a Windows program outside the shell',
  code: 'opens an editor window',
  'code-insiders': 'opens an editor window',
  cursor: 'opens an editor window',
  windsurf: 'opens an editor window',
  subl: 'opens an editor window',
  atom: 'opens an editor window',
  gedit: 'opens an editor window',
  kate: 'opens an editor window',
  notepad: 'opens an editor window',
  'notepad++': 'opens an editor window',
  write: 'opens an editor window',
};

/** Programs that take the terminal over and wait for a keypress to give it back. */
const FULL_SCREEN: Readonly<Record<string, string>> = {
  vi: 'is a full-screen editor and waits to be closed',
  vim: 'is a full-screen editor and waits to be closed',
  nvim: 'is a full-screen editor and waits to be closed',
  nano: 'is a full-screen editor and waits to be closed',
  pico: 'is a full-screen editor and waits to be closed',
  emacs: 'is a full-screen editor and waits to be closed',
  ed: 'is an interactive editor and waits for input',
  less: 'pages the output and waits for a keypress',
  more: 'pages the output and waits for a keypress',
  most: 'pages the output and waits for a keypress',
  man: 'pages the output and waits for a keypress',
  top: 'runs until it is quit',
  htop: 'runs until it is quit',
  btop: 'runs until it is quit',
  watch: 'repeats a command until it is quit',
};

/** Words in front of the real command that say nothing about what it is. */
const PREFIXES = new Set(['sudo', 'doas', 'env', 'time', 'nohup', 'command', 'exec', 'builtin']);

/** Whole-segment patterns: the first word is innocent, the arguments are not. */
const PATTERNS: ReadonlyArray<{ test: RegExp; why: string }> = [
  { test: /\bstart-process\b/i, why: 'Start-Process launches a program in its own window' },
  { test: /\binvoke-item\b/i, why: 'Invoke-Item opens the file in another application' },
  { test: /\btail\s+(?:-\S*f\b|--follow)/i, why: 'tail follows the file and never ends on its own' },
  {
    test: /\bgit\s+(?:add|rebase|checkout|restore|stash)\b[^\n]*\s-{1,2}(?:i|p|interactive|patch)\b/i,
    why: 'an interactive git command waits for a person',
  },
];

/** Strip a directory and a Windows executable suffix from the first word. */
function programName(word: string): string {
  const base = word.replace(/^.*[\\/]/, '').toLowerCase();
  return base.replace(/\.(exe|cmd|bat|ps1)$/, '');
}

/**
 * Split a command line into the pieces a shell would run separately. Crude on
 * purpose: it over-splits rather than under-splits, because a missed segment is
 * a missed guard and a spurious one costs nothing.
 */
function segments(command: string): string[] {
  return command
    .split(/\n|&&|\|\||[;|&]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** The first real word of a segment, past any `FOO=bar` assignments and prefixes. */
function head(segment: string): string {
  const words = segment.replace(/^[({\s]+/, '').split(/\s+/);
  for (const word of words) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    const name = programName(word);
    if (PREFIXES.has(name)) continue;
    return name;
  }
  return '';
}

/**
 * Why this command would stop the run, or null when it is fine to execute.
 *
 * The message is written to the agent, not to the operator: it says what was
 * refused and what to do instead, so the run carries on with a different
 * command rather than reporting a mystery.
 */
export function blockedCommand(command: string): string | null {
  for (const segment of segments(command)) {
    const name = head(segment);
    const why = OPENERS[name] ?? FULL_SCREEN[name];
    if (why) return `\`${name}\` ${why}`;
    for (const pattern of PATTERNS) {
      if (pattern.test.test(segment)) return pattern.why;
    }
  }
  return null;
}

/**
 * The command to run in place of one that would have waited for a person: it
 * explains itself on stderr and fails, which is what puts the reason in front
 * of the agent as an ordinary tool error.
 */
export function refusalFor(reason: string): string {
  const message =
    `Refused: ${reason}, and this is an unattended agent run with nobody to close it. ` +
    'Read files with the read tool, and use a command that prints to stdout and exits.';
  return `printf '%s\\n' ${quote(message)} >&2; exit 1`;
}

/** Single-quote a string for `sh`, the only quoting that needs no escaping table. */
function quote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}
