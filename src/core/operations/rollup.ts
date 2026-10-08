import type { LoadedBoard } from '../board/load.js';
import type { IssueFlagRollup } from '../board/flag-rollup.js';
import { flagRollupsFor } from '../board/flag-rollup.js';
import type { IssueRollup } from '../board/rollup.js';
import { rollupsFor } from '../board/rollup.js';
import { isTerminalStatus } from '../config/lookup.js';
import type { Issue } from '../model/types.js';
import { flagLabel } from '../model/types.js';
import { appendActivityEntry } from '../storage/activity.js';
import { nowIso } from '../storage/document.js';
import { gitIdentity } from '../storage/git.js';
import { setFlag, writeDocument } from './shared.js';

/**
 * Writing the status a container derives from the work inside it.
 *
 * Nobody drags a feature through the columns — the stories under it are what
 * get worked — so closing the last one closes the feature, and reopening one
 * reopens it. Doing that here, in an operation, is what makes it true of the
 * CLI, the MCP server and the web app at once instead of three times over, and
 * `lpm check --fix` repairs a board where it never happened (hand-edited
 * frontmatter, a merge, a board written before this existed).
 *
 * Every roll-up leaves a line in the parent's activity section. A status
 * nobody typed has to say where it came from, or the first person to notice it
 * has no way to tell an automatic change from somebody else's edit.
 *
 * @see src/shared/rollup.ts for the rule, and `board/rollup.ts` for the reading.
 */

export interface AppliedRollup extends IssueRollup {
  /** The flag closing the parent took off, when there was one. */
  flagCleared?: string;
}

function note(rollup: IssueRollup, board: LoadedBoard): { heading: string; text: string } {
  const closing = isTerminalStatus(board.config, rollup.to);
  return {
    heading: `status rolled up: ${rollup.from} → ${rollup.to}`,
    text: closing
      ? 'Every issue inside it is finished.'
      : 'There is open work inside it again.',
  };
}

/**
 * Write each roll-up to disk, in the order given, and report what landed.
 *
 * Clears a flag on a parent that has just been closed, exactly as `moveNode`
 * does for the issue somebody finished by hand: a red box on something nobody
 * is working on is noise on the canvas forever.
 */
export function writeRollups(board: LoadedBoard, rollups: IssueRollup[]): AppliedRollup[] {
  if (!rollups.length) return [];

  let identity: string | null = null;
  const author = (): string => (identity ??= gitIdentity(board.paths.lpmDir) || 'unknown');
  const applied: AppliedRollup[] = [];

  for (const rollup of rollups) {
    const at = nowIso();
    const { heading, text } = note(rollup, board);
    const issue: Issue = {
      ...rollup.issue,
      status: rollup.to,
      updated: at,
      body: appendActivityEntry(rollup.issue.body, { at, author: author(), heading, text }),
    };

    let flagCleared: string | undefined;
    if (issue.flag && isTerminalStatus(board.config, rollup.to)) {
      flagCleared = issue.flag;
      setFlag(issue, null, { at, author: author(), heading: 'flag cleared — work finished' });
    }

    writeDocument(board, issue);
    applied.push({ issue, from: rollup.from, to: rollup.to, flagCleared });
  }

  return applied;
}

/**
 * Carry an issue's new status up through the containers above it and write what
 * changes, nearest first.
 *
 * `status` is the one the issue now holds: core operations write straight to
 * disk, so the board handle still shows the status it had a moment ago.
 */
export function propagateStatus(board: LoadedBoard, issue: Issue, status: string): AppliedRollup[] {
  return writeRollups(board, rollupsFor(board, issue, status));
}

// --- the flag roll-up -----------------------------------------------------

/**
 * Writing the flag a container derives from the stopped work inside it.
 *
 * The same shape as the status roll-up above and for the same reason: whoever
 * runs the plan reads the board from the top, and a story flagged four levels
 * down was invisible from there. A container gains `DERIVED_FLAG` while
 * anything inside it is flagged and loses it when the last one is cleared.
 *
 * It never touches a flag somebody raised — `rolledUpFlag` writes and clears
 * one value and one value only — so a feature paused by hand keeps saying that.
 *
 * @see src/shared/flag-rollup.ts for the rule.
 */
export interface AppliedFlagRollup extends IssueFlagRollup {}

function flagNote(
  rollup: IssueFlagRollup,
  board: LoadedBoard,
  flags: Map<string, string | null>,
): { heading: string; text: string } {
  if (!rollup.to) {
    return {
      heading: 'flag cleared — nothing inside is stopped any more',
      text: '',
    };
  }
  // Through the overlay, because the write that caused this roll-up has already
  // landed on disk and the board handle has not seen it — naming the issue that
  // stopped is the whole value of the note.
  const flagOf = (id: string): string | null =>
    flags.has(id) ? flags.get(id)! : (board.byId.get(id)?.flag ?? null);
  const stopped = board.issues
    .filter((issue) => issue.parentId === rollup.issue.id && flagOf(issue.id))
    .map((issue) => issue.id);
  return {
    heading: `flagged: ${flagLabel(rollup.to)}`,
    text: stopped.length
      ? `Work inside this has stopped — see ${stopped.join(', ')}.`
      : 'Work inside this has stopped.',
  };
}

/**
 * Write each flag roll-up to disk, in the order given, and report what landed.
 *
 * Every one leaves a line in the container's activity section, exactly as a
 * status roll-up does: a flag nobody typed has to say where it came from, or
 * the first person to see the red box has no way to tell it from somebody's.
 * No comment is written — `_comments.md` is where a person explains a stall,
 * and filling it with one derived entry per ancestor per flag would bury the
 * explanation the flag exists to carry.
 */
export function writeFlagRollups(
  board: LoadedBoard,
  rollups: IssueFlagRollup[],
  seed: Map<string, string | null> = new Map(),
): AppliedFlagRollup[] {
  if (!rollups.length) return [];

  let identity: string | null = null;
  const author = (): string => (identity ??= gitIdentity(board.paths.lpmDir) || 'unknown');
  const applied: AppliedFlagRollup[] = [];
  // Grows as the walk writes, so a note further up names the container below it
  // that this call has only just marked.
  const flags = new Map(seed);

  for (const rollup of rollups) {
    const at = nowIso();
    const { heading, text } = flagNote(rollup, board, flags);
    const issue: Issue = { ...rollup.issue, updated: at };
    setFlag(issue, rollup.to, { at, author: author(), heading, text });
    writeDocument(board, issue);
    flags.set(issue.id, rollup.to);
    applied.push({ issue, from: rollup.from, to: rollup.to });
  }

  return applied;
}

/**
 * Carry a flag change up through the containers above it and write what changes.
 *
 * `flags` names every id whose flag has just been written — the issue itself,
 * plus any ancestor a status roll-up took a flag off in the same call. The
 * board handle is stale by then, which is what the overlay is for.
 */
export function propagateFlag(
  board: LoadedBoard,
  from: Issue,
  flags: Map<string, string | null>,
): AppliedFlagRollup[] {
  return writeFlagRollups(board, flagRollupsFor(board, from.id, flags), flags);
}
