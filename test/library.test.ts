import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { BoardPaths } from '../src/core/index.js';
import {
  BoardError,
  ConflictError,
  analyzeTemplate,
  renderTemplate,
  buildContext,
  checkBoard,
  createIssue,
  createLibraryDoc,
  findIssue,
  instructionsFor,
  libraryDir,
  libraryReferrers,
  libraryRefsInBody,
  listLibraryDocs,
  moveLibraryDoc,
  normalizeLibraryId,
  parseLibraryRef,
  readLibraryDoc,
  removeLibraryDoc,
  updateLibraryDoc,
  updateNode,
} from '../src/core/index.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterAll(cleanupBoards);

function setBody(paths: BoardPaths, id: string, body: string): void {
  const board = reload(paths);
  updateNode(board, findIssue(board, id)!, { body });
}

/**
 * The board library: markdown documents in `.lpm/library/<id>.md`, the
 * `library:<id>` references to them, and the documents that a brief prints.
 */

describe('library ids', () => {
  it('accepts a path below the library folder, in its normal form', () => {
    expect(normalizeLibraryId('prompts/code-review')).toBe('prompts/code-review');
    expect(normalizeLibraryId(' library:Prompts\\Code-Review.md ')).toBe('prompts/code-review');
    expect(normalizeLibraryId('/prd/v1.2/')).toBe('prd/v1.2');
  });

  it('refuses a path that leaves the folder or holds other characters', () => {
    for (const bad of ['', '../secrets', 'a/../b', 'my doc', '.hidden', 'prd.', 'a//b', 'x/'.repeat(9) + 'y']) {
      expect(normalizeLibraryId(bad), bad).toBeNull();
    }
  });

  it('reads a reference only with the prefix library:', () => {
    expect(parseLibraryRef('library:prd/payments')).toBe('prd/payments');
    expect(parseLibraryRef('docs/prd.md')).toBeNull();
    expect(parseLibraryRef('library:../x')).toBeNull();
  });

  it('finds the markdown links of a body that point into the library', () => {
    const body = 'See [the PRD](library:prd/payments) and [style](<library:guides/style> "Style").\n' +
      'A [web link](https://example.com) and [the PRD again](library:PRD/payments).';
    expect(libraryRefsInBody(body)).toEqual(['prd/payments', 'guides/style']);
  });
});

describe('library documents on disk', () => {
  it('writes frontmatter only for the keys that hold a value, and reads the document back', () => {
    const paths = makeBoard();
    const doc = createLibraryDoc(reload(paths), {
      id: 'prompts/code-review',
      title: 'Code review prompt',
      description: 'What a reviewer checks',
      body: 'Check the tests first.\n',
    });

    const file = path.join(paths.lpmDir, 'library', 'prompts', 'code-review.md');
    expect(doc.file).toBe(file);
    expect(readFileSync(file, 'utf8')).toBe(
      '---\ntitle: Code review prompt\ndescription: What a reviewer checks\n---\n\nCheck the tests first.\n',
    );
    expect(readLibraryDoc(paths, 'prompts/code-review')).toMatchObject({
      title: 'Code review prompt',
      titled: true,
      description: 'What a reviewer checks',
      body: 'Check the tests first.\n',
    });

    createLibraryDoc(reload(paths), { id: 'notes', body: 'Plain text\n' });
    expect(readFileSync(path.join(paths.lpmDir, 'library', 'notes.md'), 'utf8')).toBe('Plain text\n');
  });

  it('takes the title from the first heading, then from the id', () => {
    const paths = makeBoard();
    const dir = libraryDir(paths);
    mkdirSync(path.join(dir, 'summaries'), { recursive: true });
    writeFileSync(path.join(dir, 'summaries', 'sprint-12.md'), '# What sprint 12 built\n\nText.\n');
    writeFileSync(path.join(dir, 'release_notes.md'), 'No heading.\n');

    expect(listLibraryDocs(paths).map((doc) => [doc.id, doc.title, doc.titled])).toEqual([
      ['release_notes', 'Release notes', false],
      ['summaries/sprint-12', 'What sprint 12 built', false],
    ]);
  });

  it('keeps the frontmatter keys it does not know, and keeps a derived title out of the frontmatter', () => {
    const paths = makeBoard();
    const file = path.join(libraryDir(paths), 'prd.md');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '---\nowner: Ana\n---\n# Payments PRD\n\nOld body.\n');

    updateLibraryDoc(reload(paths), 'prd', { description: 'Requirements', body: '# Payments PRD\n\nNew body.\n' });

    expect(readFileSync(file, 'utf8')).toBe(
      '---\ndescription: Requirements\nowner: Ana\n---\n\n# Payments PRD\n\nNew body.\n',
    );
  });

  it('leaves a file with an invalid name out of the list', () => {
    const paths = makeBoard();
    mkdirSync(libraryDir(paths), { recursive: true });
    writeFileSync(path.join(libraryDir(paths), 'PRD.md'), 'x');
    writeFileSync(path.join(libraryDir(paths), 'ok.md'), 'x');
    writeFileSync(path.join(libraryDir(paths), 'notes.txt'), 'x');
    expect(listLibraryDocs(paths).map((doc) => doc.id)).toEqual(['ok']);
  });
});

describe('library operations', () => {
  it('refuses a second document with the same id, and an id that is not valid', () => {
    const paths = makeBoard();
    createLibraryDoc(reload(paths), { id: 'prd' });
    expect(() => createLibraryDoc(reload(paths), { id: 'PRD.md' })).toThrow('already has a document "prd"');
    expect(() => createLibraryDoc(reload(paths), { id: '../prd' })).toThrow(BoardError);
  });

  it('refuses an update whose revision is not the revision on disk, and writes nothing', () => {
    const paths = makeBoard();
    const first = createLibraryDoc(reload(paths), { id: 'prd', body: 'One\n' });
    const second = updateLibraryDoc(reload(paths), 'prd', { body: 'Two\n', revision: first.revision });
    expect(second.revision).not.toBe(first.revision);

    expect(() => updateLibraryDoc(reload(paths), 'prd', { body: 'Three\n', revision: first.revision })).toThrow(
      ConflictError,
    );
    expect(readLibraryDoc(paths, 'prd')!.body).toBe('Two\n');
    expect(() => updateLibraryDoc(reload(paths), 'gone', { body: 'x' })).toThrow('has no document "gone"');
  });

  it('deletes a document and the folders it left empty, and names the issues that still reference it', () => {
    const paths = makeBoard();
    createLibraryDoc(reload(paths), { id: 'prompts/review/strict' });
    createIssue(reload(paths), { type: 'program', title: 'Checkout', relatedFiles: ['library:prompts/review/strict'] });
    createIssue(reload(paths), { type: 'program', title: 'Billing' });
    setBody(paths, 'LP-2', 'Use [it](library:prompts/review/strict).');

    const result = removeLibraryDoc(reload(paths), 'prompts/review/strict');

    expect(result.referencedBy).toEqual(['LP-1', 'LP-2']);
    expect(existsSync(path.join(libraryDir(paths), 'prompts'))).toBe(false);
    expect(existsSync(libraryDir(paths))).toBe(true);
    expect(libraryReferrers(reload(paths), 'prompts/review/strict')).toEqual(['LP-1', 'LP-2']);
  });
});

describe('moving a library document', () => {
  /**
   *   library: prompts/review.md, prompts/deep/strict.md, prd.md
   *   LP-1 program   related file library:prompts/review, link to Library:Prompts/Deep/Strict in its body
   *   LP-2 program   related files library:prd and src/app.ts
   */
  function seedMoves() {
    const paths = makeBoard();
    createLibraryDoc(reload(paths), { id: 'prompts/review', body: 'Review.\n' });
    createLibraryDoc(reload(paths), { id: 'prompts/deep/strict', body: 'Strict.\n' });
    createLibraryDoc(reload(paths), { id: 'prd', body: 'PRD.\n' });
    createIssue(reload(paths), { type: 'program', title: 'One', relatedFiles: ['library:prompts/review'] });
    setBody(paths, 'LP-1', 'Use [the strict one](Library:Prompts/Deep/Strict "Strict") and [the web](https://example.com).');
    createIssue(reload(paths), { type: 'program', title: 'Two', relatedFiles: ['library:prd', 'src/app.ts'] });
    return paths;
  }

  it('renames one document and rewrites the related files that name it', () => {
    const paths = seedMoves();
    const result = moveLibraryDoc(reload(paths), 'prd', 'requirements/payments');

    expect(result).toEqual({ moved: [{ from: 'prd', to: 'requirements/payments' }], rewritten: ['LP-2'], stale: [] });
    expect(readLibraryDoc(paths, 'prd')).toBeNull();
    expect(readLibraryDoc(paths, 'requirements/payments')!.body).toBe('PRD.\n');
    expect(findIssue(reload(paths), 'LP-2')!.related_files).toEqual(['library:requirements/payments', 'src/app.ts']);
    expect(checkBoard(reload(paths)).filter((problem) => /library/.test(problem.message))).toEqual([]);
  });

  it('moves every document of a folder, rewrites the body links, and removes the empty folder', () => {
    const paths = seedMoves();
    const result = moveLibraryDoc(reload(paths), 'prompts', 'agent-prompts');

    expect(result.moved).toEqual([
      { from: 'prompts/deep/strict', to: 'agent-prompts/deep/strict' },
      { from: 'prompts/review', to: 'agent-prompts/review' },
    ]);
    expect(result.rewritten).toEqual(['LP-1']);
    expect(existsSync(path.join(libraryDir(paths), 'prompts'))).toBe(false);
    const issue = findIssue(reload(paths), 'LP-1')!;
    expect(issue.related_files).toEqual(['library:agent-prompts/review']);
    expect(issue.body).toContain(
      'Use [the strict one](library:agent-prompts/deep/strict "Strict") and [the web](https://example.com).',
    );
  });

  it('keeps the references at the old ids when asked, and names the issues that hold them', () => {
    const paths = seedMoves();
    const result = moveLibraryDoc(reload(paths), 'prd', 'spec', { updateReferences: false });
    expect(result).toMatchObject({ rewritten: [], stale: ['LP-2'] });
    expect(findIssue(reload(paths), 'LP-2')!.related_files).toEqual(['library:prd', 'src/app.ts']);
  });

  it('refuses a taken id, a missing document, a folder into itself and the same id, and changes nothing', () => {
    const paths = seedMoves();
    expect(() => moveLibraryDoc(reload(paths), 'prd', 'prompts/review')).toThrow('already has a document "prompts/review"');
    expect(() => moveLibraryDoc(reload(paths), 'nothing', 'x')).toThrow('no document and no folder "nothing"');
    expect(() => moveLibraryDoc(reload(paths), 'prompts', 'prompts/old')).toThrow('cannot move into itself');
    expect(() => moveLibraryDoc(reload(paths), 'PRD.md', 'prd')).toThrow('already has this id');
    expect(listLibraryDocs(paths).map((doc) => doc.id)).toEqual(['prd', 'prompts/deep/strict', 'prompts/review']);
  });

  it('refuses before it moves anything when an issue it would rewrite changed on disk', () => {
    const paths = seedMoves();
    const stale = reload(paths);
    setBody(paths, 'LP-2', 'Edited by somebody else.');
    expect(() => moveLibraryDoc(stale, 'prd', 'spec')).toThrow(ConflictError);
    expect(readLibraryDoc(paths, 'prd')).not.toBeNull();
    expect(readLibraryDoc(paths, 'spec')).toBeNull();
  });
});

describe('lpm check and the library', () => {
  it('warns about a reference to a missing document, an invalid reference and an invalid file name', () => {
    const paths = makeBoard();
    createLibraryDoc(reload(paths), { id: 'prd' });
    createIssue(reload(paths), {
      type: 'program',
      title: 'Checkout',
      relatedFiles: ['library:prd', 'library:gone', 'library:bad name', 'src/app.ts'],
    });
    setBody(paths, 'LP-1', 'See [the summary](library:summaries/q3).');
    writeFileSync(path.join(libraryDir(paths), 'Read Me.md'), 'x');

    const library = checkBoard(reload(paths)).filter((problem) => /library/i.test(problem.message));

    expect(library.map((problem) => [problem.level, problem.message])).toEqual([
      ['warn', 'LP-1: "library:bad name" is not a valid library reference. An id holds lowercase letters, digits, "-", "_", "." and "/"'],
      ['warn', 'LP-1 references library:gone, and .lpm/library/gone.md does not exist'],
      ['warn', 'LP-1 references library:summaries/q3, and .lpm/library/summaries/q3.md does not exist'],
      ['warn', 'The library file name is not a valid id, so lpm does not list it. Use lowercase letters, digits, "-", "_" and "."'],
    ]);
    expect(library.every((problem) => !problem.fixable)).toBe(true);
  });
});

describe('the brief and the library', () => {
  /**
   *   LP-1 program     references library:prd/payments (related file)
   *   └ LP-2 epic      links to library:guides/style in its body
   *     └ LP-3 feature references library:prd/payments, library:gone and src/pay.ts
   */
  function seed() {
    const paths = makeBoard();
    createLibraryDoc(reload(paths), {
      id: 'prd/payments',
      title: 'Payments PRD',
      description: 'What payments must do',
      body: '## Goals\n\nTake cards.\n',
    });
    createLibraryDoc(reload(paths), { id: 'guides/style', body: '# Style guide\n\nShort sentences.\n' });
    createLibraryDoc(reload(paths), { id: 'unused', body: 'Nobody references this.\n' });
    createIssue(reload(paths), { type: 'program', title: 'Payments', relatedFiles: ['library:prd/payments'] });
    createIssue(reload(paths), {
      type: 'epic',
      title: 'Cards',
      parentId: 'LP-1',
    });
    setBody(paths, 'LP-2', 'Follow [the style guide](library:guides/style).');
    createIssue(reload(paths), {
      type: 'feature',
      title: 'Pay by card',
      parentId: 'LP-2',
      relatedFiles: ['library:prd/payments', 'library:gone', 'src/pay.ts'],
    });
    return paths;
  }

  it('gives a template the documents of the issue and of its ancestors, each once', () => {
    const paths = seed();
    const board = reload(paths);
    const context = buildContext(board, findIssue(board, 'LP-3')!, { today: '2026-08-10' });

    expect(context.docs.map((doc) => [doc.id, doc.missing, doc.referenced_by?.id])).toEqual([
      ['prd/payments', false, 'LP-3'],
      ['gone', true, 'LP-3'],
      ['guides/style', false, 'LP-2'],
    ]);
    expect(context.docs[0]).toMatchObject({
      ref: 'library:prd/payments',
      title: 'Payments PRD',
      description: 'What payments must do',
      body: '## Goals\n\nTake cards.',
      path: '.lpm/library/prd/payments.md',
    });
    expect(context.library.map((doc) => doc.id)).toEqual(['guides/style', 'prd/payments', 'unused']);
    expect(context.related_files).toEqual(['library:prd/payments', 'library:gone', 'src/pay.ts']);
    expect(context.project_files).toEqual(['src/pay.ts']);
  });

  it('prints the documents in the built-in brief, and the missing one as missing', () => {
    const paths = seed();
    // The scrum board ships a feature.md starter. The built-in layout is the one under test.
    rmSync(path.join(paths.lpmDir, 'templates'), { recursive: true, force: true });
    const { text } = instructionsFor(reload(paths), 'LP-3', { today: '2026-08-10' });

    expect(text).toContain('## Library documents');
    expect(text).toContain('### Payments PRD (`library:prd/payments`, referenced by LP-3)');
    expect(text).toContain('What payments must do');
    expect(text).toContain('#### Goals\n\nTake cards.');
    expect(text).toContain('### Style guide (`library:guides/style`, referenced by LP-2)');
    expect(text).toContain('### `library:gone` (not in the library)');
    expect(text).not.toContain('Nobody references this.');
    // The file list holds the project files only.
    expect(text).toContain('- `src/pay.ts`');
    expect(text).not.toContain('- `library:prd/payments`');
  });

  it('prints the documents in the feature.md starter too', () => {
    const paths = seed();
    const { text, source } = instructionsFor(reload(paths), 'LP-3', { today: '2026-08-10' });
    expect(source.name).toBe('feature');
    expect(text).toContain('### Payments PRD (`library:prd/payments`, referenced by LP-3)');
    expect(text).toContain('- `src/pay.ts`');
    expect(text).not.toContain('- `library:prd/payments`');
  });

  it('lets a layout read any document of the library with find, and the safety check accepts the call', () => {
    const paths = seed();
    const layout = "<% const style = library.find((doc) => doc.id === 'guides/style') %><%= style.title %>";
    expect(analyzeTemplate(layout).findings).toEqual([]);
    const board = reload(paths);
    const context = buildContext(board, findIssue(board, 'LP-1')!, { today: '2026-08-10' });
    expect(renderTemplate(layout, context).text.trim()).toBe('Style guide');
  });

  it('prints no library section for an issue that references nothing', () => {
    const paths = makeBoard();
    createIssue(reload(paths), { type: 'program', title: 'Alone' });
    expect(instructionsFor(reload(paths), 'LP-1').text).not.toContain('Library documents');
  });
});
