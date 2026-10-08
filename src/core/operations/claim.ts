import type { LoadedBoard } from '../board/load.js';
import { loadBoard } from '../board/load.js';
import { findIssue, isGenericResource } from '../board/query.js';
import { isActiveStatus, isTerminalStatus, startStatusId } from '../config/lookup.js';
import { BoardError, ConflictError } from '../errors.js';
import type { Issue, Resource } from '../model/types.js';
import { appendActivityEntry } from '../storage/activity.js';
import { nowIso } from '../storage/document.js';
import type { MoveResult } from './move.js';
import { moveNode } from './move.js';
import { boardWrite, requireResource } from './shared.js';

/**
 * Claiming an issue: the one operation that is a test-and-set.
 *
 * Everything else on a board is somebody stating an intention — a title, a
 * dependency, a sprint. This is the one place where two people can want the
 * same thing and only one of them can have it, so "read the board, decide,
 * write" is not good enough: two agents on one checkout both load the board,
 * both see `LP-12` waiting in the pool they cover, and both write their own name
 * on it. The board then says one thing and the two agents believe another, and
 * the work is done twice.
 *
 * So a claim is not `moveNode` with an assignee. It is:
 *
 * 1. take the board lock, so nobody else is mid-write;
 * 2. **re-read the board**, because the handle the caller is holding was loaded
 *    before the lock and may already be out of date;
 * 3. check the issue is still free *as it stands on disk* — and refuse if it is
 *    not, naming who has it;
 * 4. only then write.
 *
 * Step 2 is what makes this different from every other operation, and it is why
 * this one takes the cost of a reload. Elsewhere a stale handle is *detected*
 * (`requireUnchanged`) and the caller is told to read again; here the caller is
 * a queue runner picking work, and "read again" is something this can do for
 * itself in the same breath.
 *
 * The claim is recorded in the document itself and not only in the frontmatter:
 * an entry goes in the activity section, so the `_issue.md` a person opens in a
 * file tree says who took it and when, and so the git history of the board
 * carries the same fact. `assignee` plus an active status is what withholds the
 * issue from everybody else's queue — `candidatesFor` skips work in an active
 * status and routes the rest by assignee — so writing them *is* the claim, and
 * the activity entry is how a reader finds out about it.
 *
 * What this does not do: it is not permission. `--force` takes work off
 * somebody, exactly as it did before, because light-plan routes work and does
 * not police it — the point is that taking it is now a deliberate act with a
 * line in the document, rather than the accident of writing last.
 */

export interface ClaimInput {
  /** Who is taking it: a resource id or name. */
  assignee: string;
  /**
   * The status to move it into. Defaults to the board's first active status,
   * which is what "picked up" means everywhere else.
   */
  status?: string;
  /** Take it even though somebody else holds it. */
  force?: boolean;
}

export interface ClaimResult extends MoveResult {
  issue: Issue;
  /** The resource that now holds it. */
  holder: Resource;
  /** Who it was taken off, when `force` took it off somebody. */
  takenFrom?: string;
  /** The issue was already this resource's, in this status — nothing changed. */
  alreadyHeld: boolean;
}

/**
 * Whether `holder` may take an issue that currently sits with `current` without
 * saying `--force`.
 *
 * Work parked in a pool is *waiting* for whoever covers the pool, so picking it
 * up is the ordinary path and not a theft. Work with somebody's name on it is
 * theirs. This is the rule both `lpm task start` and MCP `start_task` used to
 * carry separately, and they did not agree: the CLI let a pool be drawn from and
 * the MCP tool refused. One definition, so a person and an agent working the
 * same board are offered the same deal.
 */
function mayTake(board: LoadedBoard, holder: Resource, current: string): boolean {
  if (current === holder.id) return true;
  const owner = board.resourcesById.get(current);
  return Boolean(owner && isGenericResource(board, owner) && holder.covers.includes(current));
}

function heldError(board: LoadedBoard, issue: Issue, holder: Resource): ConflictError {
  const owner = issue.assignee ? board.resourcesById.get(issue.assignee) : null;
  const name = owner ? `${owner.title} (${owner.id})` : issue.assignee;
  const active = isActiveStatus(board.config, issue.status);
  return new ConflictError(
    `${issue.id} is already ${active ? 'being worked on by' : 'assigned to'} ${name}`,
    [
      // Read off disk a moment ago, which is the point: whoever is reading this
      // lost the race rather than asked for something impossible.
      `It is "${issue.status}" on the board as it stands now, and ${holder.title} (${holder.id}) is asking for it.`,
      active
        ? 'Force takes it off somebody who is part-way through it. Take something else instead.'
        : 'Force takes it anyway, if you know it is not being worked on.',
    ],
  );
}

/**
 * Claim an issue for a resource, atomically.
 *
 * `target` is only used for its id: the issue this actually writes is the one
 * on disk at the moment the lock is held.
 */
export function claimIssue(board: LoadedBoard, target: Issue, input: ClaimInput): ClaimResult {
  return boardWrite(board, `claim ${target.id}`, () => claimUnderLock(board, target, input));
}

function claimUnderLock(board: LoadedBoard, target: Issue, input: ClaimInput): ClaimResult {
  // The board as it is *now*, not as the caller read it. Everything below —
  // who holds the issue, what status it is in, what its body says — has to come
  // from this handle, or the check and the write would be about different
  // versions of the same document.
  const fresh = loadBoard(board.paths, board.cache ? { cache: board.cache } : undefined);

  const issue = findIssue(fresh, target.id);
  if (!issue) {
    throw new ConflictError(`${target.id} is no longer on the board`, [
      'It was deleted while you were reading. Ask for the next task.',
    ]);
  }

  const holder = requireResource(fresh, input.assignee);

  const status = input.status ?? startStatusId(fresh.config);
  if (!status) {
    throw new BoardError('This board declares no active status', [
      'Mark one of the statuses in .lpm/config.yml with `active: true`.',
    ]);
  }

  if (isTerminalStatus(fresh.config, issue.status)) {
    throw new BoardError(`${issue.id} is already "${issue.status}"`, [
      'Reopen it first if the work is not actually done.',
    ]);
  }

  let takenFrom: string | undefined;
  if (issue.assignee && !mayTake(fresh, holder, issue.assignee)) {
    if (!input.force) throw heldError(fresh, issue, holder);
    takenFrom = issue.assignee;
  }

  const alreadyHeld = issue.assignee === holder.id && issue.status === status;
  if (alreadyHeld) {
    return {
      node: issue,
      issue,
      holder,
      alreadyHeld: true,
      statusChanged: false,
      periodChanged: false,
      assigneeChanged: false,
      rollups: [],
      flagRollups: [],
    };
  }

  // The claim, written into the document a person reads as well as the
  // frontmatter a tool reads. `moveNode` does the rest — the status, the
  // assignee, and carrying a reopened container up the tree — and it re-checks
  // the file against this handle's stamp on the way in, which is the second
  // line of defence if the lock was ever broken underneath us.
  const claimed: Issue = {
    ...issue,
    body: appendActivityEntry(issue.body, {
      at: nowIso(),
      author: `${holder.title} (${holder.id})`,
      heading: takenFrom ? `claimed — taken from ${takenFrom}` : 'claimed',
      text: '',
    }),
  };

  const result = moveNode(fresh, claimed, { assignee: holder.id, status });
  return {
    ...result,
    issue: result.node as Issue,
    holder,
    alreadyHeld: false,
    ...(takenFrom ? { takenFrom } : {}),
  };
}

