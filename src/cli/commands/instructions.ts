import { parseArgs } from 'node:util';
import type { LoadedBoard, Resource, TemplateFinding } from '../../core/index.js';
import {
  BoardError,
  HELPER_NAMES,
  auditContextTemplates,
  currentTasks,
  currentUser,
  describeFinding,
  displayPath,
  installContextTemplates,
  instructionsFor,
  listContextTemplates,
  nextTasks,
  resolveContextTemplate,
} from '../../core/index.js';
import { requireBoard } from '../context.js';
import { bold, cyan, dim, err, green, out, pad, red, yellow } from '../ui.js';

export const help = `Print the working brief for an issue: everything somebody needs to start it.

Usage
  lpm instructions [<id>]        The brief for an issue, as markdown on stdout
  lpm instructions --list        Which template each issue type is rendered with
  lpm instructions --audit       Read every template on this board for risky code
  lpm instructions --init        Write the starter templates into this board

Options
      --id <id>         The issue, if you would rather name it with a flag
      --template <t>    Use this layout: a name in .lpm/templates/context, or a
                        path to a markdown file
      --no-comments     Leave the issue's work log out of the brief
      --unsafe          Render a template the safety check refused (see below)
      --force           With --init, overwrite templates that already exist

With no id, the brief is for the single issue you have in progress; if you have
none, the top recommendation from \`lpm task next\`.

The output is markdown and nothing else, so it pipes:

  lpm instructions LP-12 > brief.md
  lpm instructions LP-12 | pbcopy

Templates
  Layouts live in .lpm/templates/context/<issue type>.md, with default.md behind
  them and a built-in layout behind that — so a board with no templates at all
  still prints the ancestors' titles and bodies above the issue's own.

  They are Eta templates (eta.js.org), which is EJS syntax:

    <%= issue.title %>                      print a value
    <%= heading(epic.body, 3) %>            print it through a helper
    <% if (epic) { %> … <% } %>             a section that may be empty
    <% for (const t of children) { %> … <% } %>
    <% /* a comment, dropped from the output */ %>

  The code between the tags is JavaScript, so \`children.length\`, \`.filter()\`
  and \`.toUpperCase()\` all work. Note that an empty array is truthy: guard a
  list with \`.length\`, and an optional document with the name alone.

  Values, all of them documents unless marked:  issue, parent, ancestors,
  children, descendants, siblings, blocked_by, blocks, relates_to,
  related_files (list of text), upstream_files (list of {issue, files}
  — what the work this issue comes after touched), period, assignee, comments
  (list), board, today (text), and every issue type this board declares —
  \`epic\` is the nearest epic above this issue.

  A document has:  id, type, type_label, title, body, status, status_label,
  done, active, flag, flag_label (empty when nothing has stopped), related_files,
  path, depth, created, updated, author, attributes.<name>, attribute_list,
  capacity, generic, starts, ends, and the same relations again.

  Helpers:  ${HELPER_NAMES.join(', ')}.
  heading(body, n) re-levels a body so its shallowest heading sits at level n and
  the structure below it is kept — which is how a body nests under the heading
  the template just wrote, whether it starts at # or at ##. Fenced code is left
  alone. indent(text, n) indents every line but the first; def(value, "x") fills
  a gap.

  The full reference is docs/context-templates.md.

Safety
  A context template is compiled to JavaScript and executed. A template that
  arrived with somebody else's board is therefore *their code, running as you*.

  Every template is read before it is compiled, and one that reaches for the
  host — process, require, this, a computed property, an import — is refused.
  \`--audit\` runs that check over the whole board without rendering anything.
  \`--unsafe\` renders anyway; it is for a template you wrote and meant.

  The check refuses the known escapes. It cannot make an untrusted template
  safe. Read templates that arrive with a board you did not write.

Examples
  lpm instructions LP-12
  lpm instructions --template ./brief.md LP-12
  lpm instructions --audit
  lpm instructions --init --force`;

interface Values {
  id?: string;
  template?: string;
  'no-comments'?: boolean;
  list?: boolean;
  audit?: boolean;
  init?: boolean;
  force?: boolean;
  unsafe?: boolean;
}

/** The issue a bare `lpm instructions` is about. */
function implicitIssue(board: LoadedBoard, me: Resource | null): string {
  if (!me) {
    throw new BoardError('No id given and this checkout has no user', [
      'Name an issue: `lpm instructions LP-12`.',
      'Or say who you are first: `lpm me "Alice Smith"`.',
    ]);
  }

  const wip = currentTasks(board, me.id);
  if (wip.length === 1) return wip[0]!.id;
  if (wip.length > 1) {
    throw new BoardError('More than one issue is in progress', [
      `Name one: ${wip.map((issue) => issue.id).join(', ')}.`,
    ]);
  }

  const [top] = nextTasks(board, me.id, { limit: 1 });
  if (top) return top.issue.id;
  throw new BoardError('Nothing in progress and nothing recommended', [
    'Name an issue: `lpm instructions LP-12`.',
    'Or see what there is: `lpm task next --unassigned`.',
  ]);
}

function runList(board: LoadedBoard): number {
  const present = listContextTemplates(board.paths);
  out(`${bold('Context templates')} ${dim(displayPath(board.paths, board.paths.templatesDir))}/context`);
  out();

  if (!present.length) {
    out(dim('  none yet — the built-in layout is used for every type'));
    out(`  ${dim('write the starters with')} ${cyan('lpm instructions --init')}`);
    return 0;
  }

  for (const type of Object.keys(board.config.issue_types)) {
    const source = resolveContextTemplate(board.paths, type);
    const where =
      source.kind === 'builtin'
        ? dim('built-in layout')
        : source.name === type
          ? `${source.name}.md`
          : dim(`${source.name}.md (fallback)`);
    out(`  ${pad(type, 16)}${where}`);
  }

  const unused = present.filter(
    (name) => name !== 'default' && !board.config.issue_types[name],
  );
  if (unused.length) {
    out();
    out(dim(`  no type uses: ${unused.join(', ')} — reachable with --template`));
  }
  out();
  out(`${dim('Check what they can do with')} ${cyan('lpm instructions --audit')}`);
  return 0;
}

/**
 * The whole board's templates, read rather than run.
 *
 * Exits 1 when anything can escape, so this drops into CI next to `lpm check` —
 * a board that pulls in a template with `require` in it should fail the build,
 * not surprise somebody at a terminal.
 */
function runAudit(board: LoadedBoard): number {
  const audits = auditContextTemplates(board);
  out(`${bold('Context template audit')} ${dim(`${audits.length} layout(s)`)}`);
  out();

  let dangers = 0;
  let cautions = 0;

  for (const audit of audits) {
    const where = audit.source.path ?? 'the built-in layout';
    if (audit.error) {
      dangers += 1;
      out(`  ${red('broken')}  ${where}`);
      out(`          ${audit.error}`);
      continue;
    }
    const bad = audit.findings.filter((finding) => finding.severity === 'danger');
    const meh = audit.findings.filter((finding) => finding.severity === 'caution');
    dangers += bad.length;
    cautions += meh.length;

    if (!audit.findings.length) {
      out(`  ${green('ok')}      ${where}`);
      continue;
    }
    out(`  ${bad.length ? red('unsafe') : yellow('check')}  ${where}`);
    for (const finding of audit.findings) {
      const paint = finding.severity === 'danger' ? red : yellow;
      out(`          ${paint(describeFinding(finding))}`);
    }
  }

  out();
  if (dangers) {
    out(red(`${dangers} finding(s) can reach outside the board. These templates will not render.`));
    out(dim('A context template is compiled to JavaScript and run. Read them before you trust them.'));
    return 1;
  }
  out(green(cautions ? `No escapes found; ${cautions} thing(s) worth a look.` : 'No escapes found.'));
  out(dim('This refuses the known escapes; it cannot make an untrusted template safe.'));
  return 0;
}

function runInit(board: LoadedBoard, force: boolean): number {
  const { written, skipped } = installContextTemplates(board.paths, board.config, { force });
  out(`${bold('Context templates')} ${displayPath(board.paths, board.paths.templatesDir)}/context`);
  for (const name of written) out(`  ${cyan('written')}  ${name}.md`);
  for (const name of skipped) out(`  ${dim('kept')}     ${name}.md ${dim('(already there)')}`);
  if (!written.length && !skipped.length) {
    out(dim('  nothing to write: this board declares no type with a starter layout'));
  } else if (skipped.length && !force) {
    out();
    out(dim('  --force replaces the ones already there'));
  }
  if (written.length) {
    out();
    warnAboutTemplates();
  }
  return 0;
}

/**
 * Said wherever templates first appear, because it is the one thing about this
 * feature somebody could not have guessed: a layout is executable.
 */
export function warnAboutTemplates(): void {
  out(yellow('  Context templates are code.'));
  out(dim('  They are compiled to JavaScript and run when a brief is rendered, so a'));
  out(dim('  template that arrives with somebody else’s board runs their code as you.'));
  out(dim('  light-plan reads every template first and refuses the known escapes'));
  out(dim('  (`lpm instructions --audit`), but that is a seatbelt, not a sandbox —'));
  out(dim('  review templates you did not write. Use at your own risk.'));
}

function reportFindings(findings: TemplateFinding[]): void {
  for (const finding of findings) err(yellow(`warn ${describeFinding(finding)}`));
}

export function run(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      id: { type: 'string' },
      template: { type: 'string' },
      'no-comments': { type: 'boolean' },
      list: { type: 'boolean' },
      audit: { type: 'boolean' },
      init: { type: 'boolean' },
      force: { type: 'boolean' },
      unsafe: { type: 'boolean' },
    },
  }) as { values: Values; positionals: string[] };

  const board = requireBoard();
  if (values.init) return runInit(board, Boolean(values.force));
  if (values.audit) return runAudit(board);
  if (values.list) return runList(board);

  const id = positionals[0] ?? values.id ?? implicitIssue(board, currentUser(board)?.resource ?? null);
  const brief = instructionsFor(board, id, {
    template: values.template,
    includeComments: !values['no-comments'],
    allowUnsafe: Boolean(values.unsafe),
  });

  // The brief is the whole of stdout, so it can be redirected or piped into a
  // prompt. Everything about *how* it was made goes to stderr.
  process.stdout.write(brief.text);
  err(dim(`rendered ${brief.issue.id} with ${brief.source.path ?? 'the built-in layout'}`));
  if (values.unsafe && brief.findings.some((finding) => finding.severity === 'danger')) {
    err(red('warn --unsafe: this template can reach outside the board, and you let it'));
  }
  reportFindings(brief.findings);
  for (const warning of brief.warnings) err(yellow(`warn ${warning}`));
  return 0;
}
