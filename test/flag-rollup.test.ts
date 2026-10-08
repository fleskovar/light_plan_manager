import { afterAll, describe, expect, it } from 'vitest';
import type { BoardPaths, Problem } from '../src/core/index.js';
import {
  DERIVED_FLAG,
  FLAG_REASONS,
  applyFixes,
  checkBoard,
  clearFlag,
  createIssue,
  findIssue,
  flagIssue,
  isDerivedFlag,
  isFlagReason,
  isValidFlag,
  moveNode,
  nextTasks,
  createResource,
} from '../src/core/index.js';
import { writeNode } from '../src/core/storage/document.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterAll(cleanupBoards);

/**
 * A flag says work has stopped. Whoever runs the plan reads the board from the
 * top, so it carries up through the containers above it — and comes back off
 * when the last stopped thing inside starts moving again.
 *
 * @see src/shared/flag-rollup.ts for the rule.
 */

/** Program LP-1 > epic LP-2 > feature LP-3 > stories LP-4, LP-5. */
function seed(): BoardPaths {
  const paths = makeBoard('scrum', 'LP');
  createIssue(reload(paths), { type: 'program', title: 'Payments' });
  createIssue(reload(paths), { type: 'epic', title: 'Checkout', parentId: 'LP-1' });
  createIssue(reload(paths), { type: 'feature', title: 'Guest flow', parentId: 'LP-2' });
  createIssue(reload(paths), { type: 'user_story', title: 'Pay as a guest', parentId: 'LP-3' });
  createIssue(reload(paths), { type: 'user_story', title: 'Save the card', parentId: 'LP-3' });
  return paths;
}

const raise = (paths: BoardPaths, id: string, reason = 'blocked'): void => {
  flagIssue(reload(paths), findIssue(reload(paths), id)!, { reason, comment: 'the vendor is down' });
};

const clear = (paths: BoardPaths, id: string): void => {
  clearFlag(reload(paths), findIssue(reload(paths), id)!, { comment: 'they answered' });
};

const flagOf = (paths: BoardPaths, id: string): string | null =>
  findIssue(reload(paths), id)!.flag;

const messages = (problems: Problem[]): string => problems.map((p) => p.message).join('\n');

describe('a flag carried up the parent chain', () => {
  it('marks every container above the issue somebody stopped', () => {
    const paths = seed();
    raise(paths, 'LP-4');

    expect(flagOf(paths, 'LP-3')).toBe(DERIVED_FLAG);
    expect(flagOf(paths, 'LP-2')).toBe(DERIVED_FLAG);
    expect(flagOf(paths, 'LP-1')).toBe(DERIVED_FLAG);
    // The flag somebody raised keeps the reason they gave it.
    expect(flagOf(paths, 'LP-4')).toBe('blocked');
    // A sibling is not standing in front of anything.
    expect(flagOf(paths, 'LP-5')).toBeNull();
  });

  it('says where the flag came from in the container’s own body', () => {
    const paths = seed();
    raise(paths, 'LP-4');

    // A red box nobody typed has to explain itself, exactly as a rolled-up
    // status does — the `_issue.md` a person opens is a self-contained record.
    expect(findIssue(reload(paths), 'LP-3')!.body).toContain('Stopped inside');
    expect(findIssue(reload(paths), 'LP-3')!.body).toContain('LP-4');
  });

  it('reports the roll-up on the result, so a caller can print it', () => {
    const paths = seed();
    const result = flagIssue(reload(paths), findIssue(reload(paths), 'LP-4')!, {
      reason: 'help',
      comment: 'need a decision',
    });
    expect(result.rollups.map((rollup) => rollup.issue.id)).toEqual(['LP-3', 'LP-2', 'LP-1']);
  });

  it('does not write a comment on the containers', () => {
    const paths = seed();
    raise(paths, 'LP-4');
    // `_comments.md` is where a person explains a stall; one derived entry per
    // ancestor per flag would bury the explanation the flag exists to carry.
    expect(findIssue(reload(paths), 'LP-3')!.flag).toBe(DERIVED_FLAG);
    expect(reload(paths).issues.find((issue) => issue.id === 'LP-3')).toBeDefined();
  });
});

describe('clearing the last flag inside', () => {
  it('takes the derived flag back off every container', () => {
    const paths = seed();
    raise(paths, 'LP-4');
    clear(paths, 'LP-4');

    expect(flagOf(paths, 'LP-4')).toBeNull();
    expect(flagOf(paths, 'LP-3')).toBeNull();
    expect(flagOf(paths, 'LP-2')).toBeNull();
    expect(flagOf(paths, 'LP-1')).toBeNull();
  });

  it('keeps it while a sibling is still stopped', () => {
    const paths = seed();
    raise(paths, 'LP-4');
    raise(paths, 'LP-5');
    clear(paths, 'LP-4');

    expect(flagOf(paths, 'LP-5')).toBe('blocked');
    expect(flagOf(paths, 'LP-3')).toBe(DERIVED_FLAG);
    expect(flagOf(paths, 'LP-1')).toBe(DERIVED_FLAG);
  });

  it('stops at the container that still holds stopped work', () => {
    const paths = seed();
    // A second feature with its own stopped story, so the epic stays marked.
    createIssue(reload(paths), { type: 'feature', title: 'Card flow', parentId: 'LP-2' }); // LP-6
    createIssue(reload(paths), { type: 'user_story', title: 'Vault it', parentId: 'LP-6' }); // LP-7
    raise(paths, 'LP-4');
    raise(paths, 'LP-7');
    clear(paths, 'LP-4');

    expect(flagOf(paths, 'LP-3')).toBeNull();
    expect(flagOf(paths, 'LP-6')).toBe(DERIVED_FLAG);
    expect(flagOf(paths, 'LP-2')).toBe(DERIVED_FLAG);
  });

  it('comes off when the flagged work is finished rather than cleared', () => {
    const paths = seed();
    raise(paths, 'LP-4');
    // `moveNode` drops a flag at a terminal status; the containers follow.
    moveNode(reload(paths), findIssue(reload(paths), 'LP-4')!, { status: 'done' });

    expect(flagOf(paths, 'LP-4')).toBeNull();
    expect(flagOf(paths, 'LP-3')).toBeNull();
    expect(flagOf(paths, 'LP-1')).toBeNull();
  });
});

describe('a flag somebody raised on a container', () => {
  it('is never overwritten by the roll-up', () => {
    const paths = seed();
    raise(paths, 'LP-3', 'paused');
    raise(paths, 'LP-4');

    // The feature says something more specific than "work inside stopped".
    expect(flagOf(paths, 'LP-3')).toBe('paused');
    expect(flagOf(paths, 'LP-2')).toBe(DERIVED_FLAG);
  });

  it('is never cleared by the roll-up', () => {
    const paths = seed();
    raise(paths, 'LP-3', 'paused');
    raise(paths, 'LP-4');
    clear(paths, 'LP-4');

    // Nothing inside LP-3 is stopped any more, but its own flag is not the
    // roll-up's to answer — only the person who raised it can.
    expect(flagOf(paths, 'LP-3')).toBe('paused');
    expect(flagOf(paths, 'LP-2')).toBe(DERIVED_FLAG);
  });
});

describe('the derived flag is not a reason anybody may raise', () => {
  it('is refused by `flagIssue`', () => {
    const paths = seed();
    expect(() =>
      flagIssue(reload(paths), findIssue(reload(paths), 'LP-4')!, {
        reason: DERIVED_FLAG,
        comment: 'trying it on',
      }),
    ).toThrow(/not a reason you can raise/);
  });

  it('is what tells a raised flag from a rolled-up one', () => {
    const paths = seed();
    raise(paths, 'LP-4');
    expect(isDerivedFlag(flagOf(paths, 'LP-3'))).toBe(true);
    expect(isDerivedFlag(flagOf(paths, 'LP-4'))).toBe(false);
  });
});

describe('what the queue does with it', () => {
  it('withholds nothing extra: a container was never offered anyway', () => {
    const paths = seed();
    createResource(reload(paths), { type: 'person', title: 'Alice Smith' });
    raise(paths, 'LP-4');

    // LP-3 is now flagged, but it is a container — the stories are the work.
    // LP-4 is withheld because *it* is flagged, and LP-5 is still on offer.
    const ready = nextTasks(reload(paths), 'RS-1', {
      includeUnassigned: true,
      today: '2026-08-10',
    }).map((candidate) => candidate.issue.id);
    expect(ready).toEqual(['LP-5']);
  });
});

describe('check and --fix', () => {
  it('reports a container that should be marked and is not', () => {
    const paths = seed();
    raise(paths, 'LP-4');
    // Undo the roll-up by hand, the way a merge or an old board would leave it.
    const board = reload(paths);
    const feature = findIssue(board, 'LP-3')!;
    moveNode(board, feature, { rollUp: false, status: feature.status });
    const stale = reload(paths);
    const target = findIssue(stale, 'LP-3')!;
    target.flag = null;
    // Write it straight through, as a hand edit would.
    writeNode(target, stale.config);

    expect(messages(checkBoard(reload(paths)))).toMatch(/has stopped work inside it/);
    applyFixes(reload(paths));
    expect(flagOf(paths, 'LP-3')).toBe(DERIVED_FLAG);
  });

  it('reports and clears a container marked for work that is no longer stopped', () => {
    const paths = seed();
    raise(paths, 'LP-4');
    // Take the story's flag off behind the roll-up's back.
    const board = reload(paths);
    const story = findIssue(board, 'LP-4')!;
    story.flag = null;
    writeNode(story, board.config);

    expect(messages(checkBoard(reload(paths)))).toMatch(/nothing inside it is stopped any more/);
    applyFixes(reload(paths));
    expect(flagOf(paths, 'LP-3')).toBeNull();
    expect(flagOf(paths, 'LP-1')).toBeNull();
  });

  it('leaves a board the operations kept in step alone', () => {
    const paths = seed();
    raise(paths, 'LP-4');
    expect(checkBoard(reload(paths)).filter((problem) => /stopped/.test(problem.message))).toEqual(
      [],
    );
  });

  // `fixable: true` is a contract: exactly what `check` marks fixable is what
  // `--fix` repairs, and what `--fix` writes has to pass `check`. The roll-up
  // writes a flag value nobody may type, so the flag validation has to know it
  // is legitimate — otherwise the repair produces the errors it was asked to
  // remove, which is how this was caught.
  it('produces a board that `check` passes', () => {
    const paths = seed();
    raise(paths, 'LP-4');
    applyFixes(reload(paths));

    expect(checkBoard(reload(paths)).filter((problem) => problem.level === 'error')).toEqual([]);
  });

  it('accepts the derived flag as a stored value, while refusing it as a reason', () => {
    expect(isValidFlag(DERIVED_FLAG)).toBe(true);
    expect(isFlagReason(DERIVED_FLAG)).toBe(false);
    for (const reason of FLAG_REASONS) {
      expect(isValidFlag(reason)).toBe(true);
      expect(isFlagReason(reason)).toBe(true);
    }
    expect(isValidFlag('nonsense')).toBe(false);
  });
});
