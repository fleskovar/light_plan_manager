import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { BoardError, BoardPaths, Problem } from '../src/core/index.js';
import {
  DERIVED_FLAG,
  FLAG_REASONS,
  applyFixes,
  checkBoard,
  clearFlag,
  createIssue,
  findIssue,
  flagIssue,
  flagLabel,
  flaggedIssues,
  isDerivedFlag,
  listComments,
  parseActivity,
  moveNode,
  updateNode,
} from '../src/core/index.js';
import {
  FLAG_REASONS as WIRE_FLAG_REASONS,
  flagLabel as wireFlagLabel,
} from '../src/shared/index.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterAll(cleanupBoards);

const DERIVED = DERIVED_FLAG;

const messages = (problems: Problem[]): string => problems.map((p) => p.message).join('\n');

/** A feature (LP-3) with one story under it (LP-4). */
function seed(): BoardPaths {
  const paths = makeBoard('scrum', 'LP');
  createIssue(reload(paths), { type: 'program', title: 'Payments' });
  createIssue(reload(paths), { type: 'epic', title: 'Checkout', parentId: 'LP-1' });
  createIssue(reload(paths), { type: 'feature', title: 'Guest flow', parentId: 'LP-2' });
  createIssue(reload(paths), { type: 'user_story', title: 'Pay as a guest', parentId: 'LP-3' });
  return paths;
}

const flag = (paths: BoardPaths, id: string, reason: string, comment: string) =>
  flagIssue(reload(paths), findIssue(reload(paths), id)!, { reason, comment });

describe('raising a flag', () => {
  it('writes the reason and the comment together', () => {
    const paths = seed();
    const result = flag(paths, 'LP-4', 'help', 'Need a decision on the retry budget');

    expect(result.flag).toBe('help');
    expect(result.previous).toBeNull();
    expect(findIssue(reload(paths), 'LP-4')!.flag).toBe('help');

    // The comment is the whole point of the flag, so the operation writes it
    // rather than trusting three front ends to remember.
    const log = listComments(reload(paths), 'LP-4');
    expect(log).toHaveLength(1);
    expect(log[0]!.body).toContain('Needs help');
    expect(log[0]!.body).toContain('retry budget');
  });

  it('defaults to blocked', () => {
    const paths = seed();
    expect(flag(paths, 'LP-4', undefined as unknown as string, 'ops have not replied').flag).toBe(
      'blocked',
    );
  });

  it('refuses a flag with no comment', () => {
    const paths = seed();
    expect(() => flag(paths, 'LP-4', 'blocked', '   ')).toThrow(/Say why/);
    expect(findIssue(reload(paths), 'LP-4')!.flag).toBeNull();
    expect(listComments(reload(paths), 'LP-4')).toHaveLength(0);
  });

  it('refuses an unknown reason, and names the ones that exist', () => {
    const paths = seed();
    expect(() => flag(paths, 'LP-4', 'sleepy', 'why not')).toThrow(/Unknown flag reason "sleepy"/);
    // The list of what *is* accepted rides in the hints, where the CLI prints it.
    try {
      flag(paths, 'LP-4', 'sleepy', 'why not');
      expect.unreachable();
    } catch (error) {
      expect((error as BoardError).details.join(' ')).toContain('blocked, paused, help');
    }
  });

  it('refuses to flag work that is already finished', () => {
    const paths = seed();
    moveNode(reload(paths), findIssue(reload(paths), 'LP-4')!, { status: 'done' });
    expect(() => flag(paths, 'LP-4', 'blocked', 'too late')).toThrow(/already "done"/);
  });

  it('does not move the issue out of its column', () => {
    const paths = seed();
    moveNode(reload(paths), findIssue(reload(paths), 'LP-4')!, { status: 'in_progress' });
    flag(paths, 'LP-4', 'blocked', 'sandbox credentials expired');

    const issue = findIssue(reload(paths), 'LP-4')!;
    expect(issue.status).toBe('in_progress');
    expect(issue.flag).toBe('blocked');
  });

  it('notes when the issue was not actually in progress', () => {
    const paths = seed();
    flag(paths, 'LP-4', 'blocked', 'cannot start this at all');
    expect(listComments(reload(paths), 'LP-4')[0]!.body).toContain('not in progress');
  });

  it('lists every flagged issue on the board, raised and rolled up', () => {
    const paths = seed();
    flag(paths, 'LP-4', 'paused', 'waiting for the quarter to start');

    const flagged = flaggedIssues(reload(paths));
    // The story somebody stopped, and the three containers standing in front
    // of it. `lpm flag list` and MCP `flagged_issues` separate the two.
    expect(flagged.map((issue) => issue.id)).toEqual(['LP-1', 'LP-2', 'LP-3', 'LP-4']);
    expect(flagged.filter((issue) => !isDerivedFlag(issue.flag)).map((issue) => issue.id)).toEqual([
      'LP-4',
    ]);
  });
});

describe('clearing a flag', () => {
  it('takes it off and says what it was', () => {
    const paths = seed();
    flag(paths, 'LP-4', 'help', 'need a number');

    const board = reload(paths);
    const result = clearFlag(board, findIssue(board, 'LP-4')!, { comment: 'Three retries. Go.' });

    expect(result.flag).toBeNull();
    expect(result.previous).toBe('help');
    expect(findIssue(reload(paths), 'LP-4')!.flag).toBeNull();

    const log = listComments(reload(paths), 'LP-4');
    expect(log).toHaveLength(2);
    expect(log[1]!.body).toContain('Flag cleared');
    expect(log[1]!.body).toContain('Needs help');
  });

  it('needs a comment too', () => {
    const paths = seed();
    flag(paths, 'LP-4', 'blocked', 'stuck');
    const board = reload(paths);
    expect(() => clearFlag(board, findIssue(board, 'LP-4')!, { comment: '' })).toThrow(/Say why/);
    expect(findIssue(reload(paths), 'LP-4')!.flag).toBe('blocked');
  });

  it('refuses when there is nothing to clear', () => {
    const paths = seed();
    const board = reload(paths);
    expect(() => clearFlag(board, findIssue(board, 'LP-4')!, { comment: 'carry on' })).toThrow(
      /not flagged/,
    );
  });
});

describe('finishing flagged work', () => {
  it('drops the flag, because the work answered it', () => {
    const paths = seed();
    flag(paths, 'LP-4', 'blocked', 'sorted it myself in the end');

    const result = moveNode(reload(paths), findIssue(reload(paths), 'LP-4')!, { status: 'done' });
    expect(result.flagCleared).toBe('blocked');
    expect(findIssue(reload(paths), 'LP-4')!.flag).toBeNull();

    // The history stays in the comment log; only the field goes.
    expect(listComments(reload(paths), 'LP-4')).toHaveLength(1);
  });

  it('leaves the flag alone when the status is not terminal', () => {
    const paths = seed();
    flag(paths, 'LP-4', 'paused', 'set down for now');
    const result = moveNode(reload(paths), findIssue(reload(paths), 'LP-4')!, {
      status: 'in_review',
    });
    expect(result.flagCleared).toBeUndefined();
    expect(findIssue(reload(paths), 'LP-4')!.flag).toBe('paused');
  });
});

describe('on disk', () => {
  it('writes no flag key at all until one is raised', () => {
    const paths = seed();
    const before = readFileSync(findIssue(reload(paths), 'LP-4')!.file, 'utf8');
    expect(before).not.toContain('flag:');

    flag(paths, 'LP-4', 'blocked', 'nope');
    expect(readFileSync(findIssue(reload(paths), 'LP-4')!.file, 'utf8')).toContain('flag: blocked');
  });

  it('keeps a flag it does not recognise, and reports it', () => {
    const paths = seed();
    flag(paths, 'LP-4', 'blocked', 'nope');
    const file = findIssue(reload(paths), 'LP-4')!.file;
    writeFileSync(file, readFileSync(file, 'utf8').replace('flag: blocked', 'flag: on_fire'), 'utf8');

    // Kept, not dropped: a flag nobody recognises still means somebody wanted
    // attention, and silently unflagging is the failure nobody would notice.
    expect(findIssue(reload(paths), 'LP-4')!.flag).toBe('on_fire');
    expect(messages(checkBoard(reload(paths)))).toContain('unknown flag "on_fire"');
  });

  it('warns about a flag left on finished work', () => {
    const paths = seed();
    flag(paths, 'LP-4', 'blocked', 'nope');
    const file = findIssue(reload(paths), 'LP-4')!.file;
    writeFileSync(file, readFileSync(file, 'utf8').replace('status: backlog', 'status: done'), 'utf8');
    expect(messages(checkBoard(reload(paths)))).toContain('is flagged "blocked" but is "done"');
  });
});

describe('labels', () => {
  it('names the three reasons, and passes anything else through', () => {
    expect(flagLabel('blocked')).toBe('Blocked');
    expect(flagLabel('paused')).toBe('Paused');
    expect(flagLabel('help')).toBe('Needs help');
    expect(flagLabel('on_fire')).toBe('on_fire');
  });

  it('says the same thing in the browser as in the engine', () => {
    // `src/shared` imports nothing, so the list and the labels live twice. If
    // they drift, the canvas and `lpm flag list` name the same flag differently.
    expect([...WIRE_FLAG_REASONS]).toEqual([...FLAG_REASONS]);
    for (const reason of FLAG_REASONS) expect(wireFlagLabel(reason)).toBe(flagLabel(reason));
    expect(wireFlagLabel('on_fire')).toBe(flagLabel('on_fire'));
  });
});

describe('related files', () => {
  it('are written on create, in order, deduped', () => {
    const paths = seed();
    const issue = createIssue(reload(paths), {
      type: 'user_story',
      title: 'Guest confirmation email',
      parentId: 'LP-3',
      relatedFiles: [' docs/prd.md#L10-L42 ', 'src/mail.ts', 'src/mail.ts', '  '],
    });
    expect(issue.related_files).toEqual(['docs/prd.md#L10-L42', 'src/mail.ts']);
    expect(readFileSync(issue.file, 'utf8')).toContain('related_files:');
  });

  it('are replaced wholesale by update', () => {
    const paths = seed();
    updateNode(reload(paths), findIssue(reload(paths), 'LP-4')!, {
      relatedFiles: ['src/a.ts', 'src/b.ts'],
    });
    updateNode(reload(paths), findIssue(reload(paths), 'LP-4')!, { relatedFiles: ['src/c.ts'] });
    expect(findIssue(reload(paths), 'LP-4')!.related_files).toEqual(['src/c.ts']);
  });

  it('are never checked against the filesystem', () => {
    const paths = seed();
    updateNode(reload(paths), findIssue(reload(paths), 'LP-4')!, {
      relatedFiles: ['src/does/not/exist/yet.ts', '../outside.md'],
    });
    // A story naming a file that does not exist yet is usually the point of it.
    expect(checkBoard(reload(paths))).toEqual([]);
  });

  it('accept a bare string in hand-written frontmatter', () => {
    const paths = seed();
    const file = findIssue(reload(paths), 'LP-4')!.file;
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace('related_files: []', 'related_files: src/one.ts'),
      'utf8',
    );
    expect(findIssue(reload(paths), 'LP-4')!.related_files).toEqual(['src/one.ts']);
  });

  it('report a duplicate, and --fix removes it', () => {
    const paths = seed();
    const file = findIssue(reload(paths), 'LP-4')!.file;
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(
        'related_files: []',
        'related_files:\n  - src/a.ts\n  - src/a.ts',
      ),
      'utf8',
    );
    expect(messages(checkBoard(reload(paths)))).toContain('related_files lists "src/a.ts" more');

    applyFixes(reload(paths));
    expect(findIssue(reload(paths), 'LP-4')!.related_files).toEqual(['src/a.ts']);
  });

  it('are not a resource or period field', () => {
    const paths = seed();
    const board = reload(paths);
    const feature = findIssue(board, 'LP-3')!;
    // Issues only; a period has no code to point at.
    expect(() => updateNode(board, feature, { relatedFiles: ['ok.ts'] })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The record in the document
// ---------------------------------------------------------------------------

/**
 * A flag says work has stopped *now*, and half of the flags on a board are
 * written by the engine rather than typed by anybody: a container gains one
 * because a story four levels down was flagged, an issue loses one because
 * somebody finished it, `--fix` repairs a container that drifted. None of those
 * writes a comment. So the activity section at the end of the document is the
 * record, and it has to be there for the flags nobody explained as much as for
 * the ones somebody did — otherwise `_issue.md` grows and loses a red box with
 * nothing in the file, or in the board's git history, saying when or why.
 */
describe('every flag change is recorded in the document', () => {
  const headings = (paths: BoardPaths, id: string): string[] =>
    parseActivity(findIssue(reload(paths), id)!.body).map((entry) => entry.heading);

  it('records a flag somebody raised, and one they cleared', () => {
    const paths = seed();
    flag(paths, 'LP-4', 'blocked', 'Waiting on the API contract');
    expect(headings(paths, 'LP-4')).toEqual(['flagged: Blocked']);

    clearFlag(reload(paths), findIssue(reload(paths), 'LP-4')!, { comment: 'contract landed' });
    expect(headings(paths, 'LP-4')).toEqual(['flagged: Blocked', 'flag cleared']);
  });

  it('records the auto-clear when finishing the work answers the flag', () => {
    const paths = seed();
    flag(paths, 'LP-4', 'blocked', 'Waiting on the API contract');
    const before = listComments(reload(paths), 'LP-4').length;

    moveNode(reload(paths), findIssue(reload(paths), 'LP-4')!, { status: 'done' });

    expect(headings(paths, 'LP-4')).toEqual(['flagged: Blocked', 'flag cleared — work finished']);
    // Nobody wrote a comment for it, which is exactly why the body has to say so.
    expect(listComments(reload(paths), 'LP-4')).toHaveLength(before);
  });

  it('records a container gaining and losing a derived flag, with no comment anywhere', () => {
    const paths = seed();
    flag(paths, 'LP-4', 'blocked', 'Waiting on the API contract');

    // The feature above it stands in for the stopped work inside.
    expect(findIssue(reload(paths), 'LP-3')!.flag).toBe(DERIVED);
    expect(headings(paths, 'LP-3')).toEqual(['flagged: Stopped inside']);
    expect(listComments(reload(paths), 'LP-3')).toEqual([]);

    clearFlag(reload(paths), findIssue(reload(paths), 'LP-4')!, { comment: 'contract landed' });

    expect(findIssue(reload(paths), 'LP-3')!.flag).toBeNull();
    expect(headings(paths, 'LP-3')).toEqual([
      'flagged: Stopped inside',
      'flag cleared — nothing inside is stopped any more',
    ]);
    // Still nothing in `_comments.md`: that file is where a person explains a
    // stall, and one derived entry per ancestor would bury the explanation.
    expect(listComments(reload(paths), 'LP-3')).toEqual([]);
  });

  it('records a flag that `check --fix` wrote to repair a container', () => {
    const paths = seed();
    // A story flagged by hand-editing its frontmatter: the container never
    // learned about it, which is the drift `--fix` exists to repair.
    const file = findIssue(reload(paths), 'LP-4')!.file;
    writeFileSync(file, readFileSync(file, 'utf8').replace('period: null', 'period: null\nflag: blocked'), 'utf8');

    applyFixes(reload(paths));

    expect(findIssue(reload(paths), 'LP-3')!.flag).toBe(DERIVED);
    expect(headings(paths, 'LP-3')).toEqual(['flagged: Stopped inside']);
  });

  /**
   * The structural half of the rule above. Four operations move a flag and all
   * four go through `setFlag`, which writes the activity entry in the same call
   * — a fifth that assigned the field directly would reintroduce exactly the
   * silent red box these tests are about. Grepping is how that stays true, the
   * same way `test/harness-mapping.test.ts` keeps harness names out of `src/`.
   */
  it('is the only way an operation may move a flag', () => {
    const dir = new URL('../src/core/operations/', import.meta.url);
    /** Lines that assign the field, by file. */
    const offenders: string[] = [];

    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts') || name === 'shared.ts') continue;
      const text = readFileSync(new URL(name, dir), 'utf8');
      for (const line of text.split('\n')) {
        const assigns = /\.flag\s*=[^=]/.test(line) || /^\s*flag:/.test(line);
        if (!assigns) continue;
        // A brand-new issue has no history to record, and a type declaration
        // assigns nothing.
        if (name === 'create.ts' && line.includes('flag: null')) continue;
        if (name === 'flag.ts' && line.includes('flag: string | null')) continue;
        offenders.push(`${name}: ${line.trim()}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
