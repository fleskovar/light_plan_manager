import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { BoardPaths } from '../src/core/index.js';
import {
  applyFixes,
  checkBoard,
  createIssue,
  createPeriod,
  createResource,
  findIssue,
  findPeriod,
  moveIssue,
  removeNode,
  renderBoardIndex,
  retypeNode,
  updateNode,
} from '../src/core/index.js';
import { boardPath, cleanupBoards, makeBoard, reload, writeRawIssue } from './helpers.js';

afterAll(cleanupBoards);

const indexOf = (paths: BoardPaths): string => readFileSync(paths.indexPath, 'utf8');

/** The lines a reader sees, without the heading and the generated-by comment. */
const rows = (paths: BoardPaths): string[] =>
  indexOf(paths)
    .split('\n')
    .filter((line) => line.trimStart().startsWith('- '));

/**
 * The index an operation left behind has to equal the one a full reload
 * renders. Operations write it from a board handle their own write made stale,
 * so this is the property the whole incremental path rests on.
 */
function expectAgreesWithDisk(paths: BoardPaths): void {
  expect(indexOf(paths)).toBe(renderBoardIndex(reload(paths)));
}

function seed(): BoardPaths {
  const paths = makeBoard('scrum', 'LP');
  createIssue(reload(paths), { type: 'program', title: 'Payments platform' });
  createIssue(reload(paths), { type: 'epic', title: 'Checkout revamp', parentId: 'LP-1' });
  createIssue(reload(paths), { type: 'feature', title: 'Guest flow', parentId: 'LP-2' });
  return paths;
}

describe('the board index', () => {
  it('is written by init, and says the board is empty', () => {
    const paths = makeBoard('scrum', 'LP');
    expect(indexOf(paths)).toContain('# Board index');
    expect(indexOf(paths)).toContain('This board has no documents yet.');
    expect(rows(paths)).toEqual([]);
  });

  it('nests each new document under its parent, with a link to its file', () => {
    const paths = seed();
    expect(rows(paths)).toEqual([
      '- [LP-1](board/LP-1/_issue.md) — Payments platform',
      '  - [LP-2](board/LP-1/LP-2/_issue.md) — Checkout revamp',
      '    - [LP-3](board/LP-1/LP-2/LP-3/_issue.md) — Guest flow',
    ]);
    expectAgreesWithDisk(paths);
  });

  it('mirrors the file tree the way a file explorer orders it', () => {
    const paths = makeBoard('scrum', 'LP');
    createIssue(reload(paths), { type: 'program', title: 'P' });
    for (let n = 0; n < 10; n += 1) {
      createIssue(reload(paths), { type: 'epic', title: `Epic ${n}`, parentId: 'LP-1' });
    }
    const ids = rows(paths)
      .slice(1)
      .map((line) => /\[(LP-\d+)]/.exec(line)![1]);
    // LP-2 before LP-10, which plain string order would get backwards.
    expect(ids).toEqual(['LP-2', 'LP-3', 'LP-4', 'LP-5', 'LP-6', 'LP-7', 'LP-8', 'LP-9', 'LP-10', 'LP-11']);
  });

  it('gives periods and resources their own sections', () => {
    const paths = makeBoard('scrum', 'LP');
    createPeriod(reload(paths), {
      type: 'increment',
      title: '2026 H2',
      starts: '2026-07-01',
      ends: '2026-12-31',
    });
    createPeriod(reload(paths), {
      type: 'sprint',
      title: 'Sprint 1',
      starts: '2026-07-01',
      ends: '2026-07-14',
      parentId: 'TL-1',
    });
    createResource(reload(paths), { type: 'person', title: 'Alice Smith' });

    const text = indexOf(paths);
    expect(text).toContain('## Timeline');
    expect(text).toContain('- [TL-1](timeline/TL-1/_period.md) — 2026 H2');
    expect(text).toContain('  - [TL-2](timeline/TL-1/TL-2/_period.md) — Sprint 1');
    expect(text).toContain('## Team');
    expect(text).toContain('- [RS-1](team/RS-1/_resource.md) — Alice Smith');
    // Nothing was created in `board/`, so that section is left out entirely.
    expect(text).not.toContain('## Issues');
    expectAgreesWithDisk(paths);
  });

  it('follows a retitled document without moving its folder', () => {
    const paths = seed();
    updateNode(reload(paths), findIssue(reload(paths), 'LP-2')!, { title: 'Checkout rebuild' });
    expect(rows(paths)[1]).toBe('  - [LP-2](board/LP-1/LP-2/_issue.md) — Checkout rebuild');
    expectAgreesWithDisk(paths);
  });

  it('carries a moved document and everything under it', () => {
    const paths = seed();
    createIssue(reload(paths), { type: 'program', title: 'Billing platform' });
    moveIssue(reload(paths), findIssue(reload(paths), 'LP-2')!, { parentId: 'LP-4' });

    expect(rows(paths)).toEqual([
      '- [LP-1](board/LP-1/_issue.md) — Payments platform',
      '- [LP-4](board/LP-4/_issue.md) — Billing platform',
      '  - [LP-2](board/LP-4/LP-2/_issue.md) — Checkout revamp',
      '    - [LP-3](board/LP-4/LP-2/LP-3/_issue.md) — Guest flow',
    ]);
    expectAgreesWithDisk(paths);
  });

  it('follows a retype that reparents in the same call', () => {
    const paths = seed();
    createIssue(reload(paths), { type: 'feature', title: 'Returning flow', parentId: 'LP-2' });
    retypeNode(reload(paths), findIssue(reload(paths), 'LP-4')!, {
      type: 'user_story',
      parentId: 'LP-3',
    });
    expect(rows(paths)).toContain(
      '      - [LP-4](board/LP-1/LP-2/LP-3/LP-4/_issue.md) — Returning flow',
    );
    expectAgreesWithDisk(paths);
  });

  it('drops a removed document and everything nested inside it', () => {
    const paths = seed();
    removeNode(reload(paths), findIssue(reload(paths), 'LP-2')!);
    expect(rows(paths)).toEqual(['- [LP-1](board/LP-1/_issue.md) — Payments platform']);
    expectAgreesWithDisk(paths);
  });

  it('empties out when the last document goes', () => {
    const paths = seed();
    removeNode(reload(paths), findIssue(reload(paths), 'LP-1')!);
    expect(indexOf(paths)).toContain('This board has no documents yet.');
  });

  it('drops a removed period', () => {
    const paths = makeBoard('scrum', 'LP');
    createPeriod(reload(paths), {
      type: 'increment',
      title: '2026 H2',
      starts: '2026-07-01',
      ends: '2026-12-31',
    });
    removeNode(reload(paths), findPeriod(reload(paths), 'TL-1')!);
    expect(rows(paths)).toEqual([]);
  });

  it('keeps a multi-line title on one row', () => {
    const paths = makeBoard('blank', 'LP');
    writeRawIssue(
      boardPath(paths, 'LP-1'),
      '---\nid: LP-1\ntype: task\ntitle: |\n  One\n  Two\nstatus: todo\n---\n',
    );
    expect(renderBoardIndex(reload(paths))).toContain('- [LP-1](board/LP-1/_issue.md) — One Two');
  });
});

describe('checking the index', () => {
  it('reports a hand-edited index as fixable, and --fix rewrites it', () => {
    const paths = seed();
    writeFileSync(paths.indexPath, '# Board index\n\nsomebody typed here\n', 'utf8');

    const problem = checkBoard(reload(paths)).find((entry) => /index/.test(entry.message))!;
    expect(problem).toMatchObject({ level: 'warn', fixable: true });
    expect(problem.message).toMatch(/no longer matches the board/);

    const actions = applyFixes(reload(paths));
    expect(actions.join('\n')).toMatch(/index rewritten/);
    expect(checkBoard(reload(paths))).toEqual([]);
  });

  it('reports a missing index', () => {
    const paths = seed();
    const messages = checkBoard(reload(paths)).map((entry) => entry.message);
    expect(messages).toEqual([]);

    writeFileSync(paths.indexPath, '', 'utf8');
    expect(checkBoard(reload(paths)).map((entry) => entry.message)).toContain(
      'index no longer matches the board',
    );
  });

  it('rebuilds the index for a board written before there was one', () => {
    const paths = makeBoard('blank', 'LP');
    // The old layout: id plus a slug, and no index anywhere.
    writeRawIssue(
      boardPath(paths, 'LP-1-do-the-thing'),
      '---\nid: LP-1\ntype: task\ntitle: Do the thing\nstatus: todo\nnotes: null\n---\n',
    );
    applyFixes(reload(paths));

    expect(rows(paths)).toEqual(['- [LP-1](board/LP-1/_issue.md) — Do the thing']);
    expect(checkBoard(reload(paths))).toEqual([]);
  });
});
