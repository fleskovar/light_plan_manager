import type { LoadedBoard } from '../board/load.js';
import { isActiveStatus, isTerminalStatus } from '../config/lookup.js';
import { BoardError } from '../errors.js';
import type { FlagReason, Issue } from '../model/types.js';
import { DERIVED_FLAG, FLAG_REASONS, flagLabel, isDerivedFlag, isFlagReason } from '../model/types.js';
import { nowIso } from '../storage/document.js';
import { gitIdentity } from '../storage/git.js';
import { addComment } from './comment.js';
import { boardWrite, requireUnchanged, setFlag, writeDocument } from './shared.js';
import type { AppliedFlagRollup } from './rollup.js';
import { propagateFlag } from './rollup.js';

/**
 * Raising and clearing a flag: "I have stopped, and here is why."
 *
 * A flag is not a status. The issue stays in whatever column the board calls
 * in-progress, and the flag says the work is not moving — which is a different
 * claim from "nobody has started this", and the only one that needs somebody's
 * attention today.
 *
 * The comment is written here rather than left to the caller, and it is
 * required. A flag with no explanation is a red box nobody can act on: the
 * person who has to clear it would have to go and ask what it means, which is
 * exactly the round trip the flag exists to save. Putting the rule in the
 * operation is what makes it true of the CLI, the MCP server and the web app at
 * once, instead of three times over.
 *
 * Who may clear one is deliberately *not* enforced. Clearing a flag is the
 * plan-owner's call — it says "carry on" — but light-plan has no permissions
 * anywhere else and inventing them here would make a profile into access
 * control. The convention is documented; the tooling records who did it.
 */
export interface FlagInput {
  /** Why the work stopped. Defaults to `blocked`. */
  reason?: string;
  /** What happened, and what would unblock it. Required. */
  comment: string;
  /** Defaults to the git identity of the checkout. */
  author?: string;
}

export interface FlagResult {
  issue: Issue;
  /**
   * Containers above it whose flag changed with this one — gained one because
   * work inside them stopped, or lost one because the last stopped work in
   * them started again. @see src/shared/flag-rollup.ts
   */
  rollups: AppliedFlagRollup[];
  /** The flag now on the issue, or null once it is cleared. */
  flag: string | null;
  /** What it was before, so a caller can say "already flagged". */
  previous: string | null;
  /** Position of the comment this call wrote. */
  comment: number;
}

function requireReason(reason: string | undefined): FlagReason {
  const wanted = (reason ?? 'blocked').trim().toLowerCase();
  // The roll-up's own word. Letting somebody type it would make a container's
  // own flag indistinguishable from one the roll-up is free to clear.
  if (isDerivedFlag(wanted)) {
    throw new BoardError(`"${DERIVED_FLAG}" is not a reason you can raise`, [
      'It is what a container carries while work inside it is stopped, and it',
      'is written and cleared automatically.',
      `Expected one of: ${FLAG_REASONS.join(', ')}.`,
    ]);
  }
  if (!isFlagReason(wanted)) {
    throw new BoardError(`Unknown flag reason "${reason}"`, [
      `Expected one of: ${FLAG_REASONS.join(', ')}.`,
      'blocked = something outside this issue has to happen first; ' +
        'paused = deliberately set down; help = a person is needed.',
    ]);
  }
  return wanted;
}

function requireComment(comment: string | undefined, verb: string): string {
  const body = comment?.trim() ?? '';
  if (!body) {
    throw new BoardError(`Say why you are ${verb}`, [
      'A flag nobody can read is a red box nobody can act on.',
      'Write what happened and what would resolve it.',
    ]);
  }
  return body;
}

function write(board: LoadedBoard, target: Issue, flag: string | null, body: string, heading: string, author?: string): FlagResult {
  const at = nowIso();
  const resolvedAuthor = author?.trim() || gitIdentity(board.paths.lpmDir) || 'unknown';
  const issue: Issue = { ...target, updated: at };
  // The flag and the line in the body that records it, together — see setFlag.
  setFlag(issue, flag, { at, author: resolvedAuthor, heading, text: body });
  writeDocument(board, issue);
  // After the write, so a comment is never attached to a flag that failed to
  // land. Pass the resolved author explicitly so the comment and the activity
  // entry always name the same person.
  const result = addComment(board, issue.id, { body, author: resolvedAuthor, at });
  // The board handle is stale by now — this wrote straight to disk — so the
  // overlay is what tells the walk upward what this issue's flag actually is.
  const rollups = propagateFlag(board, issue, new Map([[issue.id, flag]]));
  return { issue, flag, previous: target.flag, comment: result.comment.index, rollups };
}

/**
 * Flag an issue and say why. Refuses an issue that is already finished: work
 * nobody is doing cannot be stuck, and a flag left on a closed issue is noise
 * on the canvas forever.
 */
export function flagIssue(board: LoadedBoard, target: Issue, input: FlagInput): FlagResult {
  return boardWrite(board, `flag ${target.id}`, () => flagUnderLock(board, target, input));
}

function flagUnderLock(board: LoadedBoard, target: Issue, input: FlagInput): FlagResult {
  requireUnchanged(board, target);
  const reason = requireReason(input.reason);
  const body = requireComment(input.comment, 'flagging this');

  if (isTerminalStatus(board.config, target.status)) {
    throw new BoardError(`${target.id} is already "${target.status}"`, [
      'Reopen it first if the work is not actually done.',
    ]);
  }

  const note =
    `**Flagged: ${flagLabel(reason)}**\n\n${body}` +
    (isActiveStatus(board.config, target.status)
      ? ''
      : `\n\n_(${target.id} is "${target.status}", not in progress.)_`);

  return write(board, target, reason, note, `flagged: ${flagLabel(reason)}`, input.author);
}

/**
 * Clear a flag and say what changed. The comment is required here too: "carry
 * on" with no reason attached tells the person picking the work back up
 * nothing, and they are the one who wrote the flag.
 */
export function clearFlag(board: LoadedBoard, target: Issue, input: FlagInput): FlagResult {
  return boardWrite(board, `clear the flag on ${target.id}`, () => clearUnderLock(board, target, input));
}

function clearUnderLock(board: LoadedBoard, target: Issue, input: FlagInput): FlagResult {
  requireUnchanged(board, target);
  const body = requireComment(input.comment, 'clearing this flag');
  if (!target.flag) {
    throw new BoardError(`${target.id} is not flagged`, ['There is nothing to clear.']);
  }
  const note = `**Flag cleared** (was: ${flagLabel(target.flag)})\n\n${body}`;
  return write(board, target, null, note, 'flag cleared', input.author);
}
