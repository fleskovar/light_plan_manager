import * as acorn from 'acorn';
import { Eta } from 'eta';
import { BoardError } from '../errors.js';

/**
 * A static safety check for context templates.
 *
 * Eta compiles a template into a JavaScript function and runs it, so a
 * `.lpm/templates/context/*.md` file is **executable code**, not data — and a
 * `.lpm` folder arrives over `git pull` from whoever wrote it. Rendering
 * somebody else's board can therefore run somebody else's JavaScript, with the
 * full privileges of the person who typed `lpm instructions`.
 *
 * There is no published sanitizer for Eta or EJS templates — the ecosystem's
 * position is that a template is trusted code. This module is the check that
 * position implies but does not provide. It cannot make an untrusted template
 * safe; nothing can, short of a real sandbox. What it does is refuse the
 * constructs that have no legitimate place in a *brief* and every place in an
 * exploit, so that the residual risk is a template doing something strange
 * rather than a template reading your SSH keys.
 *
 * Two decisions make this worth having rather than security theatre:
 *
 * 1. **It tokenizes with Eta's own parser, never a regex.** Eta's lexer skips
 *    `%>` inside strings and comments, so `<%= "a %> b" %>` is one tag. A
 *    hand-rolled scanner would disagree with the engine about where code
 *    begins, and every such disagreement is a hole.
 * 2. **It parses the code with acorn** rather than matching text, so
 *    `x [ /*c* / "constructor" ]` and `x["cons" + "tructor"]` are seen for what
 *    they are. Anything that reaches a property by a computed key is refused
 *    outright, because that is the evasion route for every name-based rule
 *    below it.
 *
 * What it still cannot stop: a template that only ever prints board values but
 * prints ones it should not, and any escape route nobody has thought of. Treat
 * `danger`-free as "no known escape", not as "safe to run untrusted".
 */

export type FindingSeverity = 'danger' | 'caution';

export interface TemplateFinding {
  /** Machine-readable rule name, e.g. `host-global`. */
  rule: string;
  severity: FindingSeverity;
  message: string;
  /** 1-based, in the template file. */
  line: number;
  column: number;
  /** The offending source text, clipped. */
  snippet: string;
}

export interface TemplateAnalysis {
  findings: TemplateFinding[];
  /** True when the template holds no executable code at all — text and values only. */
  inert: boolean;
  /** How many `<% %>` / `<%= %>` tags carry code. */
  codeTags: number;
}

/**
 * Names that reach outside the data a brief is rendered from. A template that
 * needs any of these is not laying out an issue.
 *
 * `include`, `layout` and the rest of Eta's own helpers are here because they
 * read files from disk: `<%~ include('../../../../etc/passwd') %>` is a file
 * read wearing a template's clothes.
 */
const HOST_GLOBALS = new Set([
  // Node and the host
  'process', 'require', 'module', 'exports', 'global', 'globalThis',
  '__dirname', '__filename', 'Buffer',
  // Anything that turns a string into code
  'eval', 'Function', 'AsyncFunction', 'GeneratorFunction',
  'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask',
  // Reflection, which is how you rebuild the above once it is taken away
  'Reflect', 'Proxy', 'WeakRef', 'FinalizationRegistry',
  // Anything that talks to the world
  'fetch', 'XMLHttpRequest', 'WebSocket', 'Worker', 'WebAssembly',
  'SharedArrayBuffer', 'Atomics', 'navigator', 'window', 'document',
  // Eta's own scope: these read files and write raw output
  'include', 'includeAsync', 'layout', 'block', 'blockAsync',
  'capture', 'captureAsync', 'output', '__eta',
]);

/**
 * Property names that climb out of a value and into the runtime.
 * `this.constructor.constructor("return process")()` is the classic escape, and
 * it needs neither `process` nor `require` to be spelled anywhere.
 */
const ESCAPE_PROPERTIES = new Set([
  'constructor', '__proto__', 'prototype',
  '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
]);

const MESSAGES: Record<string, string> = {
  'host-global': 'reaches outside the board',
  'escape-property': 'climbs out of a value into the runtime',
  'computed-member': 'reaches a property by a computed key, which is how a name-based check is evaded',
  'this-expression': '`this` is the template engine itself, not the issue',
  'dynamic-import': 'loads code at render time',
  'with-statement': 'rebinds what every name in the template means',
  'unbounded-loop': 'may not terminate, which hangs whoever renders it',
  'debugger': 'stops the process under a debugger',
};

/** Where one of Eta's code tokens sits in the template file. */
interface CodeSpan {
  /** Offset of the token's code inside the assembled program. */
  programStart: number;
  /** Offset of the same code inside the template source. */
  sourceStart: number;
  length: number;
}

interface Assembled {
  program: string;
  spans: CodeSpan[];
  codeTags: number;
}

/**
 * Turn a template into one JavaScript program, remembering where each piece
 * came from.
 *
 * Eta's `parse` is the authority on what is code: it is the same call the
 * engine makes on its way to `new Function`, so nothing can be code here and
 * text there. Interpolations become expression statements; execution tags are
 * copied verbatim, which is what keeps `<% if (x) { %>` … `<% } %>` balanced
 * across the assembled whole.
 */
function assemble(source: string, eta: Eta): Assembled {
  let buffer: (string | { t: string; val: string })[];
  try {
    buffer = eta.parse(source) as (string | { t: string; val: string })[];
  } catch (error) {
    throw new BoardError(`Template will not parse: ${(error as Error).message.split('\n')[0]}`);
  }

  let program = '';
  const spans: CodeSpan[] = [];
  let cursor = 0;
  let codeTags = 0;

  for (const token of buffer) {
    if (typeof token === 'string') continue;
    codeTags += 1;

    // Tokens come back in source order, so walking forward from the last one
    // finds this one's code even when the same text appears in the prose.
    const tagAt = source.indexOf('<%', cursor);
    const valueAt = token.val ? source.indexOf(token.val, tagAt < 0 ? cursor : tagAt) : -1;
    const sourceStart = valueAt >= 0 ? valueAt : Math.max(cursor, 0);
    cursor = sourceStart + token.val.length;

    // 'e' is `<% %>`; 'i' and 'r' are `<%= %>` and `<%~ %>`, which are
    // expressions and need a statement around them.
    const wrapped = token.t === 'e' ? token.val : `(${token.val});`;
    spans.push({
      programStart: program.length + (token.t === 'e' ? 0 : 1),
      sourceStart,
      length: token.val.length,
    });
    program += `${wrapped}\n`;
  }

  return { program, spans, codeTags };
}

/** Map an offset in the assembled program back to one in the template. */
function toSource(spans: CodeSpan[], offset: number): number {
  for (const span of spans) {
    if (offset >= span.programStart && offset <= span.programStart + span.length) {
      return span.sourceStart + (offset - span.programStart);
    }
  }
  return spans.find((span) => span.programStart >= offset)?.sourceStart ?? 0;
}

function lineAndColumn(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let start = 0;
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === '\n') {
      line += 1;
      start = index + 1;
    }
  }
  return { line, column: offset - start + 1 };
}

type AnyNode = acorn.Node & Record<string, unknown>;

/**
 * Every node, with its parent and the field it hangs off.
 *
 * Deliberately generic rather than a visitor table: a checker that only walks
 * the node types it knows about stops walking the moment a template uses one it
 * does not, and everything below that node goes unexamined.
 */
function walk(
  node: AnyNode,
  parent: AnyNode | null,
  key: string,
  visit: (node: AnyNode, parent: AnyNode | null, key: string) => void,
): void {
  visit(node, parent, key);
  for (const [field, value] of Object.entries(node)) {
    if (field === 'type' || field === 'start' || field === 'end') continue;
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry && typeof entry === 'object' && typeof (entry as AnyNode).type === 'string') {
          walk(entry as AnyNode, node, field, visit);
        }
      }
    } else if (value && typeof value === 'object' && typeof (value as AnyNode).type === 'string') {
      walk(value as AnyNode, node, field, visit);
    }
  }
}

/** True when this identifier names a property rather than referring to a value. */
function isPropertyName(parent: AnyNode | null, key: string): boolean {
  if (!parent) return false;
  if (parent.type === 'MemberExpression' && key === 'property') return !parent.computed;
  if (
    (parent.type === 'Property' ||
      parent.type === 'PropertyDefinition' ||
      parent.type === 'MethodDefinition') &&
    key === 'key'
  ) {
    return !parent.computed;
  }
  return false;
}

const analyzer = new Eta({ useWith: true, autoEscape: false, autoTrim: false });

/**
 * Read a template without running it, and report everything in it that could do
 * more than lay an issue out.
 *
 * Throws only when the template will not parse at all — which is a broken
 * template rather than a dangerous one, and worth the same error either way.
 */
export function analyzeTemplate(source: string): TemplateAnalysis {
  const { program, spans, codeTags } = assemble(source, analyzer);
  if (!codeTags) return { findings: [], inert: true, codeTags: 0 };

  let tree: acorn.Node;
  try {
    tree = acorn.parse(program, {
      ecmaVersion: 'latest',
      // Script, not module: Eta's output is not strict, and `with` has to parse
      // so that a template using it can be *reported* rather than crash here.
      sourceType: 'script',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowSuperOutsideMethod: true,
    });
  } catch (error) {
    throw new BoardError(`Template will not parse: ${(error as Error).message}`, [
      'Every `<% if (x) { %>` needs its `<% } %>`, and every quote needs its pair.',
    ]);
  }

  const findings: TemplateFinding[] = [];
  const seen = new Set<string>();

  const report = (rule: string, severity: FindingSeverity, node: AnyNode, detail?: string): void => {
    const offset = toSource(spans, node.start);
    const { line, column } = lineAndColumn(source, offset);
    const raw = program.slice(node.start, Math.min(node.end, node.start + 80));
    const snippet = raw.replace(/\s+/g, ' ').trim();
    const fingerprint = `${rule}:${line}:${column}:${snippet}`;
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    findings.push({
      rule,
      severity,
      message: detail ? `${MESSAGES[rule]} (${detail})` : (MESSAGES[rule] ?? rule),
      line,
      column,
      snippet,
    });
  };

  walk(tree as AnyNode, null, 'root', (node, parent, key) => {
    switch (node.type) {
      case 'Identifier': {
        const name = String(node.name);
        if (isPropertyName(parent, key)) {
          if (ESCAPE_PROPERTIES.has(name)) report('escape-property', 'danger', node, `.${name}`);
        } else if (HOST_GLOBALS.has(name)) {
          report('host-global', 'danger', node, name);
        }
        return;
      }
      case 'MemberExpression': {
        if (!node.computed) return;
        const property = node.property as AnyNode;
        if (property.type === 'Literal') {
          const value = property.value;
          if (typeof value === 'string' && ESCAPE_PROPERTIES.has(value)) {
            report('escape-property', 'danger', node, `["${value}"]`);
          }
          // A literal index or a plain string key is exactly as readable as a
          // dotted one, so it is left alone.
          return;
        }
        report('computed-member', 'danger', node);
        return;
      }
      case 'ThisExpression':
        report('this-expression', 'danger', node);
        return;
      case 'ImportExpression':
        report('dynamic-import', 'danger', node);
        return;
      case 'WithStatement':
        report('with-statement', 'danger', node);
        return;
      case 'WhileStatement':
      case 'DoWhileStatement':
      case 'ForStatement':
        report('unbounded-loop', 'caution', node);
        return;
      case 'DebuggerStatement':
        report('debugger', 'caution', node);
        return;
      default:
    }
  });

  findings.sort((a, b) => a.line - b.line || a.column - b.column);
  return { findings, inert: false, codeTags };
}

export function describeFinding(finding: TemplateFinding): string {
  return `${finding.line}:${finding.column}  ${finding.severity}  ${finding.message} — ${finding.snippet}`;
}

/**
 * Analyze, and refuse a template that could escape.
 *
 * `allowUnsafe` exists because it is the caller's machine and their board, and
 * a flat refusal with no way past it just teaches people to stop using the
 * feature. It is never offered to an agent: the MCP server renders whatever the
 * board holds, so it is the one caller that must not be able to say yes.
 */
export function assertTemplateSafe(
  source: string,
  name: string,
  allowUnsafe = false,
): TemplateFinding[] {
  const { findings } = analyzeTemplate(source);
  const dangers = findings.filter((finding) => finding.severity === 'danger');
  if (!dangers.length || allowUnsafe) return findings;

  throw new BoardError(`Refusing to render ${name}: it can do more than lay out an issue`, [
    ...dangers.slice(0, 5).map(describeFinding),
    ...(dangers.length > 5 ? [`…and ${dangers.length - 5} more.`] : []),
    '',
    'A context template is compiled to JavaScript and run, so this is code, not',
    'markup. If you wrote it and meant it, re-run with --unsafe. If it arrived',
    'with somebody else’s board, read it before you do.',
  ]);
}
