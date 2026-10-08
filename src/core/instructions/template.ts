import { Eta } from 'eta';
import { BoardError } from '../errors.js';
import type { TemplateFinding } from './analyze.js';
import { assertTemplateSafe } from './analyze.js';

/**
 * Rendering a context template, with [Eta](https://eta.js.org) doing the work.
 *
 * The syntax is Eta's, which is EJS's: `<%= value %>` prints, `<% code %>`
 * runs, and the code in between is ordinary JavaScript. `useWith` puts the
 * board in scope, so a template says `issue.title` rather than `it.issue.title`,
 * and the helpers below (`heading`, `indent`, …) are ordinary functions rather
 * than a filter syntax nobody else's tooling understands.
 *
 * **A template is executable code.** Eta compiles it with `new Function` and
 * runs it, which means rendering a board someone else wrote runs JavaScript
 * they wrote, as you. That is a real trade and it was made deliberately: a
 * standard engine people already know, at the cost of a capability a layout
 * does not need. `analyze.ts` is what makes the trade survivable — every
 * template goes through it before it is compiled, and one that reaches for the
 * host is refused rather than run. `lpm init` says so out loud.
 *
 * Nothing in this file knows what an issue is. It is text plus data in, text
 * plus warnings out.
 */

/** What a render produced, and everything about it that looked wrong. */
export interface RenderResult {
  text: string;
  /**
   * Values that came out empty or nonsensical. Rendering never fails over
   * these — a brief with one empty section still beats no brief — but they are
   * how a template gets fixed.
   */
  warnings: string[];
  /** What the safety check saw. Empty for a template that only lays out text. */
  findings: TemplateFinding[];
}

export interface RenderOptions {
  /** Shown in errors, e.g. `.lpm/templates/context/user_story.md`. */
  name?: string;
  /**
   * Render even though the safety check found something that can escape.
   * Never set this for input that did not come from the person at the keyboard.
   */
  allowUnsafe?: boolean;
}

/**
 * Re-level a body's headings so its shallowest one sits at `level`, keeping the
 * structure below it intact.
 *
 * This is a re-level rather than a fixed shift because bodies do not agree with
 * each other: one document starts at `#`, the next at `##`, and a template that
 * shifted both by the same amount would nest one of them wrongly. What a
 * template actually means by `<%= heading(epic.body, 4) %>` is "put this under
 * the heading I just wrote", and that is what it does.
 *
 * Fenced blocks are left alone — a `# comment` in a shell sample is not a
 * heading, and a brief that mangled one would be lying about the code.
 */
export function shiftHeadings(text: string, level: number): string {
  const target = Math.min(6, Math.max(1, Math.round(level)));
  const lines = text.split('\n');

  let fenced = false;
  const headingAt: (number | null)[] = lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return null;
    }
    if (fenced) return null;
    const match = /^(#{1,6})(\s|$)/.exec(line);
    return match ? match[1]!.length : null;
  });

  const depths = headingAt.filter((depth): depth is number => depth !== null);
  if (!depths.length) return text;

  const shift = target - Math.min(...depths);
  if (shift === 0) return text;

  return lines
    .map((line, index) => {
      const depth = headingAt[index];
      if (depth === null || depth === undefined) return line;
      return `${'#'.repeat(Math.min(6, Math.max(1, depth + shift)))}${line.slice(depth)}`;
    })
    .join('\n');
}

/** Warnings collected during the current render. Rendering is synchronous. */
let collector: Set<string> | null = null;

/**
 * Turn a value into the text that stands for it.
 *
 * Runs on every interpolation, so a brief never contains `undefined`, `null` or
 * `[object Object]` — three things a person reading a working brief should not
 * have to interpret.
 */
export function stringify(value: unknown): string {
  if (value === null || value === undefined) {
    collector?.add('a value came out empty — guard it with <% if %> or wrap it in def()');
    return '';
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (Array.isArray(value)) {
    return value
      .map((entry) => (entry === null || entry === undefined ? '' : stringify(entry)))
      .filter((entry) => entry !== '')
      .join(', ');
  }
  collector?.add(
    'a document was printed where a value was expected — write .title, .id or .body on it',
  );
  return '';
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(Math.max(0, Math.round(spaces)));
  // The first line sits where the template put it; the rest have to catch up.
  return text
    .split('\n')
    .map((line, index) => (index === 0 || line.trim() === '' ? line : pad + line))
    .join('\n');
}

/**
 * The functions a template can call.
 *
 * Small on purpose: JavaScript already has `.toUpperCase()`, `.length`,
 * `.filter()` and `.map()`, so this is only the handful of things markdown
 * needs and JavaScript has no opinion about.
 */
export const HELPERS = {
  /** Re-level a markdown body so it nests under the heading above it. */
  heading: (value: unknown, level = 2): string => shiftHeadings(stringify(value), level),
  /** Indent every line but the first, to keep a template's own margin. */
  indent: (value: unknown, spaces = 2): string => indent(stringify(value), spaces),
  /** Print a value the way an interpolation would, without printing it. */
  text: (value: unknown): string => stringify(value),
  /** A fallback for anything empty. */
  def: (value: unknown, fallback: string): string => {
    const rendered = value === null || value === undefined ? '' : stringify(value);
    return rendered === '' ? fallback : rendered;
  },
  /** Join a list, stringifying each entry the same way an interpolation does. */
  join: (value: unknown, separator = ', '): string =>
    Array.isArray(value) ? value.map((entry) => stringify(entry)).join(separator) : stringify(value),
  /** Cap a string's length, with an ellipsis. */
  truncate: (value: unknown, limit = 200): string => {
    const rendered = stringify(value);
    return rendered.length <= limit
      ? rendered
      : `${rendered.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
  },
};

export const HELPER_NAMES = Object.keys(HELPERS).sort();

/**
 * A line holding nothing but one `<% %>` tag takes its newline with it.
 *
 * Eta spells that `-%>`, per tag. Applying it for whole control lines is what
 * lets a template be laid out like the markdown it produces: without it every
 * `<% } %>` leaves a blank line behind and a brief comes out double-spaced, so
 * the author would have to inline the control flow and the layout would stop
 * being readable.
 *
 * Done by rewriting the line rather than removing it, so the line numbers in a
 * parse error and in a safety finding still point at the file the author has
 * open. Interpolations are never touched: those are content.
 */
export function trimControlLines(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      // One tag, alone on the line, that is not an interpolation. `(?!%>)` keeps
      // a line holding two tags out of it.
      const match = /^[ \t]*<%(?![=~])((?:(?!%>)[\s\S])*?)[-_]?%>[ \t]*$/.exec(line);
      return match ? `<%${match[1]}-%>` : line;
    })
    .join('\n');
}

/**
 * The names Eta's own compiled function holds in the scope around `with`.
 *
 * They are function-locals, not globals, so nothing else can tell them from a
 * name a template made up — and `__eta` in particular is what the whole render
 * appends to. `openScope` below has to let them past, or the first line of
 * output would be assigning to `undefined.res`. Every one of them is already a
 * `danger` in `analyze.ts`, so a template naming one is refused long before it
 * gets here; this is about the engine's own code, not the author's.
 */
const ETA_SCOPE = new Set([
  '__eta', 'it', 'include', 'includeAsync', 'layout',
  'block', 'blockAsync', 'capture', 'captureAsync', 'output',
]);

/**
 * A value that stands for a name the board does not answer.
 *
 * Empty string rather than `undefined`, and the choice is the fix: `useWith`
 * compiles to `with (data)`, so an identifier the data has no key for falls
 * through to the host scope and throws a `ReferenceError` that takes the whole
 * render with it. That is how one retired value (`informs`, after `informed_by`
 * went) broke the brief on every board still holding the starter that printed
 * it — a layout is a file somebody pulled months ago, and the vocabulary moves
 * underneath it.
 *
 * `undefined` would only move the failure one character along, since the guard
 * a layout in this codebase writes is `<% if (list.length) %>` and reaching
 * through nothing is a `TypeError`. An empty array survives that but is
 * *truthy*, so `<% if (list) %>` would open a section with nothing in it. An
 * empty string is the one value that is falsy, has a `.length` of zero, walks
 * as nothing under `for…of`, prints as nothing, is safe to reach through, and
 * fills in from `def()` — every way a layout can ask about a name it turns out
 * not to have.
 */
const ABSENT = '';

/**
 * Put `data` in scope so that a name it does not answer comes out empty and
 * warned about, instead of throwing.
 *
 * The proxy claims an identifier **only** when nothing else would answer it:
 * the data's own keys resolve as they always did, and so does a real global, so
 * what a template may reach stays entirely `analyze.ts`'s decision and does not
 * quietly change here. What is left is exactly the case that used to be fatal.
 */
function openScope(data: Record<string, unknown>, missing: (name: string) => void): object {
  return new Proxy(data, {
    has(target, key) {
      // Symbols are the engine's business (`@@unscopables`), never a template's.
      if (typeof key === 'symbol') return false;
      if (Reflect.has(target, key)) return true;
      if (ETA_SCOPE.has(key) || key.startsWith('__eta')) return false;
      // A global still resolves to the global, exactly as before.
      if (key in globalThis) return false;
      return true;
    },
    get(target, key, receiver) {
      if (typeof key === 'symbol' || Reflect.has(target, key)) {
        return Reflect.get(target, key, receiver);
      }
      missing(key);
      return ABSENT;
    },
  });
}

const eta = new Eta({
  useWith: true,
  // Briefs are markdown, not HTML: escaping would turn a `<` in a body into
  // `&lt;` and a code sample into nonsense.
  autoEscape: false,
  autoTrim: false,
  autoFilter: true,
  filterFunction: (value: unknown) => stringify(value),
  cache: false,
});

/**
 * Render `source` against `data`.
 *
 * Throws a `BoardError` when the template will not parse, or when the safety
 * check finds something that can reach outside the board; anything the data
 * does not answer is a warning, so a board with no epics still gets a brief.
 */
export function renderTemplate(
  source: string,
  data: Record<string, unknown>,
  options: RenderOptions = {},
): RenderResult {
  const name = options.name ?? 'this template';

  // Before anything is compiled. Eta's own parser decides what counts as code,
  // so this cannot disagree with the engine about where a tag begins.
  const findings = assertTemplateSafe(source, name, options.allowUnsafe);

  const warnings = new Set<string>();
  collector = warnings;
  let rendered: string;
  try {
    const scope = openScope({ ...data, ...HELPERS }, (missing) => {
      warnings.add(
        `\`${missing}\` is not a value this board offers — the layout names something ` +
          'the engine no longer has, or never had. Run `lpm instructions --help` for the list.',
      );
    });
    rendered = eta.renderString(trimControlLines(source), scope);
  } catch (error) {
    const message = (error as Error).message.split('\n')[0] ?? String(error);
    throw new BoardError(`Cannot render ${name}: ${message}`, [
      'Every <% if %> needs its <% } %>. A name the board does not answer is empty,',
      'not an error — but reaching through it (`.a.b`) is still a TypeError.',
      'Run `lpm instructions --audit` to check every template this board holds.',
    ]);
  } finally {
    collector = null;
  }

  // Collapse the runs of blank lines that dropping an empty section leaves.
  const text = rendered.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: text ? `${text}\n` : '', warnings: [...warnings], findings };
}
