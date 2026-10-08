import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { BoardPaths } from '../src/core/index.js';
import { splitPushSelection } from '../src/remote/selection.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

/**
 * Splitting a push selection — the rule that stops "push this sprint" from
 * doing nothing at all.
 *
 * A period does not travel as `only`: a push of work deliberately creates no
 * sprints, so a period is named in `periods` and filing it repairs the
 * mirrored issues that were filed without it. Both halves are asserted here,
 * because the failure of either is silent — a push that reports success and
 * wrote nothing.
 */

afterAll(cleanupBoards);

function board(): BoardPaths {
  const paths = makeBoard('scrum', 'LP');

  const write = (dir: string, file: string, front: string): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/${file}`, `---\n${front}---\n\nBody.\n`);
  };

  // Two stories in one sprint, one of them already mirrored; one story
  // scheduled nowhere.
  write(`${paths.boardDir}/LP-1`, '_issue.md', 'id: LP-1\ntype: user_story\ntitle: Filed\nstatus: in_progress\nperiod: TL-2\n');
  write(`${paths.boardDir}/LP-2`, '_issue.md', 'id: LP-2\ntype: user_story\ntitle: Unfiled\nstatus: backlog\nperiod: TL-2\n');
  write(`${paths.boardDir}/LP-3`, '_issue.md', 'id: LP-3\ntype: user_story\ntitle: Unscheduled\nstatus: backlog\n');
  write(`${paths.timelineDir}/TL-1`, '_period.md', 'id: TL-1\ntype: increment\ntitle: PI 1\n');
  write(`${paths.timelineDir}/TL-1/TL-2`, '_period.md', 'id: TL-2\ntype: sprint\ntitle: Sprint 3\n');

  mkdirSync(`${paths.remotesDir}/upstream`, { recursive: true });
  writeFileSync(
    `${paths.remotesDir}/upstream/links.json`,
    JSON.stringify({
      version: 1,
      cursor: null,
      links: {
        'LP-1': {
          remoteId: 'I_1',
          remoteKey: 'acme/payments#1',
          remoteUrl: '',
          syncedAt: '2026-08-15T00:00:00.000Z',
          remoteRev: 'r1',
        },
      },
    }),
  );
  return paths;
}

describe('splitPushSelection', () => {
  it('leaves a selection of documents alone', () => {
    const loaded = reload(board());
    expect(splitPushSelection(loaded, 'upstream', ['LP-3', 'LP-2'])).toEqual({
      only: ['LP-2', 'LP-3'],
    });
  });

  it('names a period in `periods`, never in `only`', () => {
    const loaded = reload(board());
    const split = splitPushSelection(loaded, 'upstream', ['TL-2']);
    // In `only` it would be a document the planner does not file, and the push
    // would report success having written nothing.
    expect(split.periods).toEqual(['TL-2']);
    expect(split.only).not.toContain('TL-2');
  });

  it('joins the mirrored issues waiting on that period to the run', () => {
    const loaded = reload(board());
    // LP-1 was filed while the sprint did not exist, so its schedule was never
    // written; filing the sprint is when that is repaired. LP-2 is in the same
    // sprint and is not mirrored, so the sprint is not its problem.
    expect(splitPushSelection(loaded, 'upstream', ['TL-2']).only).toEqual(['LP-1']);
  });

  it('keeps a document selected beside a period', () => {
    const loaded = reload(board());
    expect(splitPushSelection(loaded, 'upstream', ['LP-3', 'TL-2'])).toEqual({
      only: ['LP-1', 'LP-3'],
      periods: ['TL-2'],
    });
  });
});
