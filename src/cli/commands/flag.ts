import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { Issue, LoadedBoard } from '../../core/index.js';
import {
  BoardError,
  FLAG_REASONS,
  clearFlag,
  currentTasks,
  currentUser,
  findIssue,
  flagIssue,
  flagLabel,
  DERIVED_FLAG,
  flaggedIssues,
  isDerivedFlag,
} from '../../core/index.js';
import { requireBoard } from '../context.js';
import { bold, cyan, dim, green, out, pad, plural, red, yellow } from '../ui.js';

export const help = `Say that work has stopped, and say why.

Usage
  lpm flag [<id>] --comment "..."          Raise a flag
  lpm flag clear <id> --comment "..."      Take one off
  lpm flag list                            Every flagged issue on the board

Options
  -m, --comment <text>  What happened, and what would resolve it. Required
  -f, --file <path>     Read the comment from a file ("-" for stdin)
      --reason <what>   ${FLAG_REASONS.join(' | ')}  (default: blocked)
      --author <name>   Override the author; defaults to this checkout's user

A flag is not a status. The issue stays in the column it is in, and the flag
says the work is not moving — which is a different thing from nobody having
started it, and the only one that needs somebody's attention today. Flagged
issues are drawn in red on the canvas.

The reasons:
  blocked   something outside this issue has to happen before it can go on
  paused    deliberately set down; the work is fine, the timing is not
  help      a person is needed — a decision, a review, a pair of eyes

A flag carries up the plan: every container above the issue is marked
"Stopped inside", and the mark comes off by itself once nothing inside it is
stopped any more — whether the flag was cleared or the work was finished. That
is not a reason you can raise, and a flag you put on a container yourself is
never overwritten or cleared for you. \`lpm flag list\` counts the containers
separately from the issues somebody actually stopped.

The comment is required both ways. A red box nobody can read is a round trip
to ask what it means, which is the trip the flag exists to save.

With no id, \`lpm flag\` flags the issue you are working on. Clearing is the
plan owner's call — it says "carry on" — so name the issue explicitly.

Examples
  lpm flag --comment "Sandbox credentials expired; asked ops on #infra"
  lpm flag LP-12 --reason help --comment "Need a decision on the retry budget"
  lpm flag clear LP-12 --comment "New credentials in the vault; carry on"
  lpm flag list`;

function readComment(
  message: string | undefined,
  file: string | undefined,
  positional: string | undefined,
): string | undefined {
  if (file !== undefined) {
    try {
      return readFileSync(file === '-' ? 0 : file, 'utf8');
    } catch (error) {
      throw new BoardError(`Could not read ${file}`, [(error as Error).message]);
    }
  }
  return message ?? positional;
}

function describe(board: LoadedBoard, issue: Issue): string {
  const type = board.config.issue_types[issue.type]?.label ?? issue.type;
  return `${bold(pad(issue.id, 8))}${pad(issue.title, 40)} ${dim(`${type} · ${issue.status}`)}`;
}

/** The issue a bare `lpm flag` means: the one thing you have in flight. */
function inFlight(board: LoadedBoard): Issue {
  const user = currentUser(board);
  if (!user?.resource) {
    throw new BoardError('No id given and this checkout has no user', [
      'Name the issue, or run `lpm me <id or name>` first.',
    ]);
  }
  const wip = currentTasks(board, user.resource.id);
  if (wip.length !== 1) {
    throw new BoardError(
      wip.length ? 'More than one issue is in progress' : 'Nothing is in progress',
      [
        wip.length
          ? `Name one: ${wip.map((issue) => issue.id).join(', ')}`
          : 'Pick something up with `lpm task start`, or name the issue.',
      ],
    );
  }
  return wip[0]!;
}

function requireIssue(board: LoadedBoard, id: string): Issue {
  const issue = findIssue(board, id);
  if (!issue) throw new BoardError(`No issue with id "${id}"`);
  return issue;
}

function authorOf(board: LoadedBoard, given: string | undefined): string | undefined {
  if (given) return given;
  const user = currentUser(board);
  return user?.resource ? `${user.resource.title} (${user.resource.id})` : undefined;
}

function runList(board: LoadedBoard): number {
  const flagged = flaggedIssues(board);
  // A container carrying a derived flag is standing in front of one of these,
  // not asking for anything itself. Listing them together would bury the four
  // issues somebody has to act on under the twelve containers above them.
  const raised = flagged.filter((issue) => !isDerivedFlag(issue.flag));
  const containers = flagged.length - raised.length;

  out(bold('Flagged'));
  if (!raised.length) {
    out(dim('  nothing is flagged'));
    return 0;
  }
  for (const issue of raised) {
    const who = issue.assignee ? board.resourcesById.get(issue.assignee)?.title : null;
    out(
      `  ${red(pad(flagLabel(issue.flag!), 11))}${describe(board, issue)}` +
        (who ? `  ${dim(who)}` : ''),
    );
  }
  out();
  if (containers) {
    out(
      dim(
        `${plural(containers, 'container')} above them ${containers === 1 ? 'is' : 'are'} marked "${flagLabel(DERIVED_FLAG)}" — cleared automatically with the last flag inside.`,
      ),
    );
  }
  out(`${dim('Why, in each case:')} ${cyan('lpm comment <id> --list')}`);
  return 0;
}

interface Values {
  comment?: string;
  file?: string;
  reason?: string;
  author?: string;
}

export function run(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      comment: { type: 'string', short: 'm' },
      file: { type: 'string', short: 'f' },
      reason: { type: 'string' },
      author: { type: 'string' },
      // Accepted so `lpm flag clear --id LP-3` works the way people write it.
      id: { type: 'string' },
    },
  });
  const options = values as Values & { id?: string };

  const board = requireBoard();
  const sub = positionals[0];

  if (sub === 'list' || sub === 'ls') return runList(board);

  if (sub === 'clear' || sub === 'unflag') {
    const id = options.id ?? positionals[1];
    if (!id) {
      throw new BoardError('Missing id', [
        'Usage: lpm flag clear <id> --comment "..."',
        'Clearing is deliberate: it tells whoever raised the flag to carry on.',
      ]);
    }
    const issue = requireIssue(board, id);
    const comment = readComment(options.comment, options.file, positionals[2]);
    const result = clearFlag(board, issue, {
      comment: comment ?? '',
      author: authorOf(board, options.author),
    });
    out(`${green('Cleared')} the ${flagLabel(result.previous!)} flag on ${bold(issue.id)}  ${issue.title}`);
    out(dim(`  comment #${result.comment}`));
    out();
    out(`${dim('Whoever raised it can pick it back up:')} ${cyan(`lpm instructions ${issue.id}`)}`);
    return 0;
  }

  const id = options.id ?? sub;
  const issue = id ? requireIssue(board, id) : inFlight(board);
  const comment = readComment(options.comment, options.file, id ? positionals[1] : positionals[0]);
  const result = flagIssue(board, issue, {
    reason: options.reason,
    comment: comment ?? '',
    author: authorOf(board, options.author),
  });

  out(`${yellow('Flagged')} ${bold(issue.id)}  ${issue.title}`);
  out(`  ${'reason'.padEnd(8)}  ${red(flagLabel(result.flag!))}`);
  if (result.previous) out(`  ${'was'.padEnd(8)}  ${dim(flagLabel(result.previous))}`);
  out(`  ${'comment'.padEnd(8)}  #${result.comment}`);
  out();
  out(dim('It stays in this status and is drawn in red on the canvas.'));
  out(`${dim('Whoever is running the plan clears it with')} ${cyan(`lpm flag clear ${issue.id} --comment "..."`)}`);
  return 0;
}
