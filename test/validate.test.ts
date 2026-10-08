import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { BoardPaths, Problem } from '../src/core/index.js';
import {
  applyFixes,
  checkBoard,
  createIssue,
  findIssue,
  parseFrontmatter,
  readState,
  writeState,
} from '../src/core/index.js';
import { boardPath, cleanupBoards, makeBoard, reload, writeRawIssue } from './helpers.js';

afterAll(cleanupBoards);

const messages = (problems: Problem[]): string => problems.map((p) => p.message).join('\n');

function seedBlank(): BoardPaths {
  const paths = makeBoard('blank', 'LP');
  createIssue(reload(paths), { type: 'task', title: 'Do the thing' });
  return paths;
}

describe('checkBoard', () => {
  it('passes on a board built with the CLI', () => {
    expect(checkBoard(reload(seedBlank()))).toEqual([]);
  });

  it('flags a folder with no issue file', () => {
    const paths = seedBlank();
    mkdirSync(boardPath(paths, 'notes'), { recursive: true });
    expect(messages(checkBoard(reload(paths)))).toMatch(/folder has no _issue\.md/);
  });

  it('flags malformed frontmatter', () => {
    const paths = seedBlank();
    writeRawIssue(boardPath(paths, 'LP-9-broken'), '---\nid: A\nid: B\n---\n');
    expect(messages(checkBoard(reload(paths)))).toMatch(/invalid YAML frontmatter/);
  });

  it('flags an unknown status, type, and attribute value', () => {
    const paths = seedBlank();
    writeRawIssue(
      boardPath(paths, 'LP-9-odd'),
      '---\nid: LP-9\ntype: saga\ntitle: Odd\nstatus: wip\n---\n',
    );
    const text = messages(checkBoard(reload(paths)));
    expect(text).toMatch(/unknown status "wip"/);
    expect(text).toMatch(/unknown issue type "saga"/);
  });

  it('flags a bad attribute value', () => {
    const paths = seedBlank();
    writeRawIssue(
      boardPath(paths, 'LP-9-odd'),
      '---\nid: LP-9\ntype: task\ntitle: Odd\nstatus: todo\nnotes: [a, b]\n---\n',
    );
    expect(messages(checkBoard(reload(paths)))).toMatch(/attribute "notes": expected a string/);
  });

  it('flags an attribute the type does not declare', () => {
    const paths = seedBlank();
    writeRawIssue(
      boardPath(paths, 'LP-9-odd'),
      '---\nid: LP-9\ntype: task\ntitle: Odd\nstatus: todo\nnotes: me\nmystery: 1\n---\n',
    );
    expect(messages(checkBoard(reload(paths)))).toMatch(/"mystery" is not declared for type "task"/);
  });

  it('flags duplicate ids as unfixable', () => {
    const paths = seedBlank();
    writeRawIssue(
      boardPath(paths, 'LP-1-copy'),
      '---\nid: LP-1\ntype: task\ntitle: Copy\nstatus: todo\nnotes: null\n---\n',
    );
    const duplicate = checkBoard(reload(paths)).filter((p) => /duplicate id/.test(p.message));
    expect(duplicate).toHaveLength(2);
    expect(duplicate.every((p) => !p.fixable)).toBe(true);
  });

  it('flags invalid parenting', () => {
    const paths = makeBoard('scrum', 'LP');
    createIssue(reload(paths), { type: 'program', title: 'P' });
    writeRawIssue(
      boardPath(paths, 'LP-1', 'LP-9-wrong'),
      '---\nid: LP-9\ntype: feature\ntitle: Wrong\nstatus: backlog\n---\n',
    );
    expect(messages(checkBoard(reload(paths)))).toMatch(
      /invalid parenting: "feature" cannot sit at level 1/,
    );
  });

  it('flags a folder carrying anything but the id', () => {
    const paths = seedBlank();
    // The layout an older version wrote: id plus a slug of the title.
    writeRawIssue(
      boardPath(paths, 'LP-9-renamed-entirely'),
      '---\nid: LP-9\ntype: task\ntitle: Renamed entirely\nstatus: todo\nnotes: null\n---\n',
    );
    expect(messages(checkBoard(reload(paths)))).toMatch(/folder name should be "LP-9"/);
  });

  it('flags a stale id counter', () => {
    const paths = seedBlank();
    writeState(paths, {
      counter: 0,
      period_counter: 0,
      resource_counter: 0,
      squad_counter: 0,
      template_counter: 0,
    });
    expect(messages(checkBoard(reload(paths)))).toMatch(/id counter is behind the board/);
  });

  it('flags a required attribute left empty', () => {
    const paths = makeBoard('blank', 'LP');
    writeFileSync(
      paths.configPath,
      readFileSync(paths.configPath, 'utf8').replace(
        '      notes:\n        type: text',
        '      notes:\n        type: text\n        required: true',
      ),
      'utf8',
    );
    writeRawIssue(
      boardPath(paths, 'LP-1-x'),
      '---\nid: LP-1\ntype: task\ntitle: X\nstatus: todo\nnotes: null\n---\n',
    );
    expect(messages(checkBoard(reload(paths)))).toMatch(/required attribute "notes" is empty/);
  });
});

describe('applyFixes', () => {
  it('adopts a hand-written folder with no frontmatter at all', () => {
    const paths = seedBlank();
    writeRawIssue(boardPath(paths, 'saved-cards'), '# Save my card\n\nSome notes.\n');

    applyFixes(reload(paths));
    const board = reload(paths);

    const adopted = board.issues.find((issue) => issue.title === 'Save my card')!;
    expect(adopted.id).toBe('LP-2');
    expect(adopted.type).toBe('task');
    expect(adopted.status).toBe('todo');
    expect(adopted.created).toEqual(expect.any(String));
    expect(adopted.author).toEqual(expect.any(String));
    expect(path.basename(adopted.dir)).toBe('LP-2');
    expect(checkBoard(board)).toEqual([]);
  });

  it('keeps the body intact while filling metadata', () => {
    const paths = seedBlank();
    writeRawIssue(boardPath(paths, 'notes'), '# Kept\n\nOriginal body text.\n');
    applyFixes(reload(paths));
    const adopted = reload(paths).issues.find((issue) => issue.title === 'Kept')!;
    expect(readFileSync(adopted.file, 'utf8')).toContain('Original body text.');
  });

  it('heals .lpm/.gitignore to cover credentials.json on an older board (LP-295)', () => {
    const paths = seedBlank();
    const gitignore = path.join(paths.lpmDir, '.gitignore');
    writeFileSync(gitignore, '', 'utf8');

    const problems = checkBoard(reload(paths));
    const gap = problems.find((p) => p.message.includes('.gitignore does not ignore'));
    expect(gap).toBeDefined();
    expect(gap!.level).toBe('warn');
    expect(gap!.fixable).toBe(true);
    expect(gap!.message).toContain('credentials.json');

    applyFixes(reload(paths));
    expect(readFileSync(gitignore, 'utf8')).toContain('credentials.json');
    expect(checkBoard(reload(paths))).toEqual([]);
  });

  it('takes the id from the folder name when frontmatter lacks one', () => {
    const paths = seedBlank();
    writeRawIssue(
      boardPath(paths, 'LP-40-from-folder'),
      '---\ntype: task\ntitle: From folder\nstatus: todo\n---\n',
    );
    applyFixes(reload(paths));
    const board = reload(paths);
    expect(findIssue(board, 'LP-40')).not.toBeNull();
    expect(readState(paths).counter).toBe(40);
    expect(checkBoard(board)).toEqual([]);
  });

  it('resets an unknown status to the default', () => {
    const paths = seedBlank();
    writeRawIssue(
      boardPath(paths, 'LP-9-odd'),
      '---\nid: LP-9\ntype: task\ntitle: Odd\nstatus: wip\n---\n',
    );
    applyFixes(reload(paths));
    expect(findIssue(reload(paths), 'LP-9')!.status).toBe('todo');
  });

  it('renames folders to the id alone, deepest first', () => {
    const paths = makeBoard('scrum', 'LP');
    // The layout an older version wrote, nested: both have to be renamed, and
    // renaming the parent first would move the child out from under the rename.
    writeRawIssue(
      boardPath(paths, 'LP-1-programme'),
      '---\nid: LP-1\ntype: program\ntitle: Programme\nstatus: backlog\n---\n',
    );
    writeRawIssue(
      boardPath(paths, 'LP-1-programme', 'LP-2-epic-one'),
      '---\nid: LP-2\ntype: epic\ntitle: Epic one\nstatus: backlog\n---\n',
    );

    applyFixes(reload(paths));
    const after = reload(paths);
    expect(existsSync(boardPath(after.paths, 'LP-1', 'LP-2'))).toBe(true);
    expect(checkBoard(after)).toEqual([]);
  });

  it('adds declared attributes that are missing', () => {
    const paths = seedBlank();
    writeRawIssue(
      boardPath(paths, 'LP-9-bare'),
      '---\nid: LP-9\ntype: task\ntitle: Bare\nstatus: todo\n---\n',
    );
    applyFixes(reload(paths));
    const { data } = parseFrontmatter(readFileSync(findIssue(reload(paths), 'LP-9')!.file, 'utf8'));
    expect('notes' in data).toBe(true);
  });

  it('never writes an empty type it could not infer', () => {
    const paths = makeBoard('scrum', 'LP');
    createIssue(reload(paths), { type: 'program', title: 'P' });
    createIssue(reload(paths), { type: 'epic', title: 'E', parentId: 'LP-1' });
    createIssue(reload(paths), { type: 'feature', title: 'F', parentId: 'LP-2' });
    // Level 3 allows user_story or bug, so the type is genuinely ambiguous.
    const feature = findIssue(reload(paths), 'LP-3')!;
    writeRawIssue(path.join(feature.dir, 'ambiguous'), '# Ambiguous\n');

    applyFixes(reload(paths));
    const board = reload(paths);
    const adopted = board.issues.find((issue) => issue.title === 'Ambiguous')!;
    const raw = readFileSync(adopted.file, 'utf8');
    expect(raw).not.toMatch(/type:\s*(''|"")/);
    expect(messages(checkBoard(board))).toMatch(/missing type/);
  });

  it('is idempotent', () => {
    const paths = seedBlank();
    writeRawIssue(boardPath(paths, 'adopt-me'), '# Adopt me\n');
    applyFixes(reload(paths));
    expect(applyFixes(reload(paths))).toEqual([]);
    expect(checkBoard(reload(paths))).toEqual([]);
  });

  it('resyncs a rewound id counter', () => {
    const paths = seedBlank();
    writeState(paths, {
      counter: 0,
      period_counter: 0,
      resource_counter: 0,
      squad_counter: 0,
      template_counter: 0,
    });
    applyFixes(reload(paths));
    expect(readState(paths).counter).toBe(1);
  });
});
