import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { BoardPaths, Problem } from '../src/core/index.js';
import {
  applyFixes,
  checkBoard,
  createIssue,
  createResource,
  findIssue,
  nextTasks,
  parseFrontmatter,
} from '../src/core/index.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterAll(cleanupBoards);

const messages = (problems: Problem[]): string => problems.map((p) => p.message).join('\n');

/**
 * A feature (LP-3) with a research task under it (LP-4) and two stories that
 * came out of it once the fog cleared (LP-5, LP-6).
 */
function seed(): BoardPaths {
  const paths = makeBoard('scrum', 'LP');
  createIssue(reload(paths), { type: 'program', title: 'Payments' });
  createIssue(reload(paths), { type: 'epic', title: 'Checkout', parentId: 'LP-1' });
  createIssue(reload(paths), { type: 'feature', title: 'Guest flow', parentId: 'LP-2' });
  createIssue(reload(paths), {
    type: 'research',
    title: 'Measure gateway latency',
    parentId: 'LP-3',
  });
  for (const title of ['Retry queue', 'Latency budget alert']) {
    createIssue(reload(paths), { type: 'user_story', title, parentId: 'LP-3' });
  }
  createResource(reload(paths), { type: 'person', title: 'Alice Smith' });
  return paths;
}

/** Give an issue the frontmatter a board written before the change would have. */
function writeLegacyLink(paths: BoardPaths, id: string, targets: string[]): void {
  const issue = findIssue(reload(paths), id)!;
  const text = readFileSync(issue.file, 'utf8');
  writeFileSync(
    issue.file,
    text.replace(/^relates_to:.*$/m, `$&\ninformed_by: [${targets.join(', ')}]`),
    'utf8',
  );
}

describe('the scrum template', () => {
  it('offers review and research alongside user stories', () => {
    const board = reload(makeBoard('scrum', 'LP'));
    expect(board.config.hierarchy[3]).toEqual(['user_story', 'bug', 'test', 'review', 'research']);
    expect(board.config.issue_types.review?.label).toBe('Review');
    expect(board.config.issue_types.research?.label).toBe('Research / Measure');
  });
});

// `informed_by` gated the queue exactly as `depends_on` does — two edges with
// one behaviour. It is gone, and a board written before that is migrated by the
// same `check --fix` that migrates everything else.
describe('a board still carrying informed_by', () => {
  it('loads, and keeps the key rather than dropping somebody\'s data', () => {
    const paths = seed();
    writeLegacyLink(paths, 'LP-5', ['LP-4']);

    const issue = findIssue(reload(paths), 'LP-5')!;
    expect(issue.attributes.informed_by).toEqual(['LP-4']);
    const { data } = parseFrontmatter(readFileSync(issue.file, 'utf8'));
    expect(data.informed_by).toEqual(['LP-4']);
  });

  it('no longer gates the queue with it, since nothing reads the key', () => {
    const paths = seed();
    writeLegacyLink(paths, 'LP-5', ['LP-4']);

    const ready = nextTasks(reload(paths), 'RS-1', {
      includeUnassigned: true,
      today: '2026-08-10',
    }).map((candidate) => candidate.issue.id);
    expect(ready).toEqual(['LP-4', 'LP-5', 'LP-6']);
  });

  // Which is exactly why it must not pass silently: the ordering the plan
  // recorded stopped being honoured the moment the field was retired.
  it('is reported as fixable, naming what has to move', () => {
    const paths = seed();
    writeLegacyLink(paths, 'LP-5', ['LP-4']);

    const problem = checkBoard(reload(paths)).find((p) => /informed_by is no longer/.test(p.message));
    expect(problem?.level).toBe('warn');
    expect(problem?.fixable).toBe(true);
    expect(problem?.message).toMatch(/LP-4 belongs in depends_on/);
  });

  it('is reported once, not twice as an undeclared key as well', () => {
    const paths = seed();
    writeLegacyLink(paths, 'LP-5', ['LP-4']);

    expect(messages(checkBoard(reload(paths)))).not.toMatch(/"informed_by" is not declared/);
  });

  it('becomes depends_on on --fix, keeping the ordering it recorded', () => {
    const paths = seed();
    writeLegacyLink(paths, 'LP-5', ['LP-4']);
    applyFixes(reload(paths));

    const issue = findIssue(reload(paths), 'LP-5')!;
    expect(issue.depends_on).toEqual(['LP-4']);
    expect(issue.attributes.informed_by).toBeUndefined();
    const { data } = parseFrontmatter(readFileSync(issue.file, 'utf8'));
    expect(data.informed_by).toBeUndefined();

    // And the queue withholds the story again, for the reason it always did.
    const ready = nextTasks(reload(paths), 'RS-1', {
      includeUnassigned: true,
      today: '2026-08-10',
    }).map((candidate) => candidate.issue.id);
    expect(ready).toEqual(['LP-4', 'LP-6']);
  });

  it('merges into an existing depends_on without repeating an id', () => {
    const paths = seed();
    writeLegacyLink(paths, 'LP-5', ['LP-4', 'LP-6']);
    const issue = findIssue(reload(paths), 'LP-5')!;
    writeFileSync(
      issue.file,
      readFileSync(issue.file, 'utf8').replace(/^depends_on:.*$/m, 'depends_on: [LP-4]'),
      'utf8',
    );
    applyFixes(reload(paths));

    expect(findIssue(reload(paths), 'LP-5')!.depends_on).toEqual(['LP-4', 'LP-6']);
  });

  it('leaves the board clean afterwards', () => {
    const paths = seed();
    writeLegacyLink(paths, 'LP-5', ['LP-4']);
    applyFixes(reload(paths));

    expect(checkBoard(reload(paths))).toEqual([]);
  });
});
