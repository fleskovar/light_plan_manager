import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { BoardPaths, Template } from '../src/core/index.js';
import {
  BoardError,
  TEMPLATE_FILE,
  applyFixes,
  checkBoard,
  createIssue,
  createTemplate,
  findRegistryTemplate,
  isTemplateRoot,
  linkTemplate,
  loadBoard,
  moveNode,
  parseConfigText,
  removeNode,
  renderBoardIndex,
  requireTemplate,
  retypeNode,
  templatePath,
  templateRoots,
  templateSubtree,
  updateNode,
  validateAttributeValue,
} from '../src/core/index.js';
import type { BoardView } from '../src/shared/index.js';
import { counterFactory, planInstantiate, resolveParams } from '../src/shared/index.js';
import { applyChanges } from '../src/sync/apply.js';
import { toSnapshot } from '../src/sync/dto.js';
import { cleanupBoards, makeBoard, reload, writeRawIssue } from './helpers.js';

afterAll(cleanupBoards);

/**
 * The template registry: a fifth collection written in the board's own issue
 * types, plus the one thing it adds — parameters, filled in on the way onto the
 * board.
 */

function viewOf(paths: BoardPaths): BoardView {
  const snapshot = toSnapshot(loadBoard(paths));
  const nodes = Object.fromEntries(
    [...snapshot.issues, ...snapshot.periods, ...snapshot.resources, ...snapshot.templates].map(
      (node) => [node.id, node],
    ),
  );
  return { config: snapshot.config, nodes };
}

/**
 * A registry holding one feature template with three chained stories, filed
 * under two folders (the program and epic levels nobody templatized).
 *
 *   TPL-1 folder "Delivery"      (program level)
 *   TPL-2   folder "Epics"       (epic level)
 *   TPL-3     feature "{{name}} API"   <- the root
 *   TPL-4       story "Design the {{name}} schema"
 *   TPL-5       story "Build {{name}}"        after TPL-4
 *   TPL-6       story "Document {{name}}"     after TPL-5
 */
function seedRegistry(): BoardPaths {
  const paths = makeBoard('scrum', 'LP');
  createTemplate(reload(paths), { type: 'folder', title: 'Delivery', description: 'Patterns' });
  createTemplate(reload(paths), { type: 'folder', title: 'Epics', parentId: 'TPL-1' });
  createTemplate(reload(paths), {
    type: 'feature',
    title: '{{name}} API',
    description: 'REST endpoint with tests and docs',
    parentId: 'TPL-2',
    params: {
      name: { type: 'string', required: true, description: 'What the API is for' },
      owner: { type: 'string', default: 'nobody' },
    },
  });
  createTemplate(reload(paths), {
    type: 'user_story',
    title: 'Design the {{name}} schema',
    parentId: 'TPL-3',
  });
  createTemplate(reload(paths), {
    type: 'user_story',
    title: 'Build {{name}}',
    parentId: 'TPL-3',
  });
  createTemplate(reload(paths), {
    type: 'user_story',
    title: 'Document {{name}} for {{owner}}',
    parentId: 'TPL-3',
  });

  let board = reload(paths);
  linkTemplate(board, findRegistryTemplate(board, 'TPL-5')!, { dependsOn: ['TPL-4'] });
  board = reload(paths);
  linkTemplate(board, findRegistryTemplate(board, 'TPL-6')!, { dependsOn: ['TPL-5'] });
  return paths;
}

/** A program and an epic to instantiate feature templates under. */
function seedBoard(paths: BoardPaths): void {
  createIssue(reload(paths), { type: 'program', title: 'Platform' });
  createIssue(reload(paths), { type: 'epic', title: 'Payments', parentId: 'LP-1' });
}

describe('the registry as a collection', () => {
  it('reads templates back off disk with their parameters', () => {
    const board = reload(seedRegistry());
    expect(board.templates.map((entry) => entry.id)).toEqual([
      'TPL-1',
      'TPL-2',
      'TPL-3',
      'TPL-4',
      'TPL-5',
      'TPL-6',
    ]);

    const feature = findRegistryTemplate(board, 'TPL-3')!;
    expect(feature.type).toBe('feature');
    expect(feature.description).toBe('REST endpoint with tests and docs');
    expect(feature.params.name).toEqual({
      type: 'string',
      required: true,
      description: 'What the API is for',
    });
    expect(feature.depth).toBe(2);
  });

  it('is a valid board, and its documents are in the index', () => {
    const paths = seedRegistry();
    const board = reload(paths);
    expect(checkBoard(board).filter((problem) => problem.level === 'error')).toEqual([]);

    const index = renderBoardIndex(board);
    expect(index).toContain('## Registry');
    expect(index).toContain('TPL-3');
  });

  it('mirrors the issue hierarchy, so a template sits where its issue would', () => {
    const paths = seedRegistry();
    const board = reload(paths);
    expect(() =>
      createTemplate(board, { type: 'feature', title: 'Loose', parentId: 'TPL-1' }),
    ).toThrow(/cannot be nested under/);
  });

  it('lets a folder stand in for any level, but never inside a template', () => {
    const paths = seedRegistry();
    // A folder is legal at the story level, standing in for a story nobody
    // templatized — but not under the feature template, which is one document.
    expect(() =>
      createTemplate(reload(paths), { type: 'folder', title: 'Nope', parentId: 'TPL-3' }),
    ).toThrow(/folder cannot sit inside/);
  });

  it('names a root as the thing anybody instantiates', () => {
    const board = reload(seedRegistry());
    expect(templateRoots(board).map((entry) => entry.id)).toEqual(['TPL-3']);
    expect(isTemplateRoot(board, findRegistryTemplate(board, 'TPL-4')!)).toBe(false);
    expect(isTemplateRoot(board, findRegistryTemplate(board, 'TPL-1')!)).toBe(false);
    expect(templatePath(board, findRegistryTemplate(board, 'TPL-3')!)).toEqual([
      'Delivery',
      'Epics',
    ]);
    expect(templateSubtree(board, findRegistryTemplate(board, 'TPL-3')!)).toHaveLength(4);
  });

  it('refuses parameters on a folder', () => {
    const paths = seedRegistry();
    expect(() =>
      createTemplate(reload(paths), {
        type: 'folder',
        title: 'Bad',
        params: { x: { type: 'string' } },
      }),
    ).toThrow(/folder cannot declare parameters/);
  });

  it('refuses parameters on anything but a root', () => {
    const paths = seedRegistry();
    // A story inside the feature template: what somebody instantiates is the
    // feature, so the story takes the answers the feature was given.
    expect(() =>
      createTemplate(reload(paths), {
        type: 'user_story',
        title: 'Nested',
        parentId: 'TPL-3',
        params: { x: { type: 'string' } },
      }),
    ).toThrow(/Only a root declares parameters/);

    const board = reload(paths);
    expect(() =>
      updateNode(board, findRegistryTemplate(board, 'TPL-4')!, {
        params: { x: { type: 'string' } },
      }),
    ).toThrow(/Only a root declares parameters/);
  });

  it('lets a root clear its parameters, and a nested one stay empty', () => {
    const paths = seedRegistry();
    let board = reload(paths);
    updateNode(board, findRegistryTemplate(board, 'TPL-3')!, { params: {} });
    board = reload(paths);
    expect(findRegistryTemplate(board, 'TPL-3')!.params).toEqual({});
    // An empty set is not a declaration, so it is accepted anywhere.
    expect(() =>
      updateNode(board, findRegistryTemplate(board, 'TPL-4')!, { params: {} }),
    ).not.toThrow();
  });

  it('refuses a dependency that leaves the registry', () => {
    const paths = seedRegistry();
    seedBoard(paths);
    const board = reload(paths);
    expect(() =>
      linkTemplate(board, findRegistryTemplate(board, 'TPL-4')!, { dependsOn: ['LP-1'] }),
    ).toThrow(/only be linked to another template/);
  });

  it('refuses a dependency cycle between templates', () => {
    const paths = seedRegistry();
    const board = reload(paths);
    expect(() =>
      linkTemplate(board, findRegistryTemplate(board, 'TPL-4')!, { dependsOn: ['TPL-6'] }),
    ).toThrow(/cycle/);
  });

  it('rewrites the templates that pointed at a deleted one', () => {
    const paths = seedRegistry();
    let board = reload(paths);
    removeNode(board, findRegistryTemplate(board, 'TPL-5')!);

    board = reload(paths);
    expect(findRegistryTemplate(board, 'TPL-5')).toBeNull();
    expect(findRegistryTemplate(board, 'TPL-6')!.depends_on).toEqual([]);
    expect(checkBoard(board).filter((problem) => problem.level === 'error')).toEqual([]);
  });

  it('moves a template between folders, taking its children with it', () => {
    const paths = seedRegistry();
    createTemplate(reload(paths), { type: 'folder', title: 'Other epics', parentId: 'TPL-1' });

    let board = reload(paths);
    moveNode(board, findRegistryTemplate(board, 'TPL-3')!, { parentId: 'TPL-7' });

    board = reload(paths);
    const feature = findRegistryTemplate(board, 'TPL-3')!;
    expect(feature.parentId).toBe('TPL-7');
    expect(findRegistryTemplate(board, 'TPL-4')!.parentId).toBe('TPL-3');
    expect(checkBoard(board).filter((problem) => problem.level === 'error')).toEqual([]);
  });

  it('retypes a template within the level its type allows', () => {
    const paths = seedRegistry();
    const board = reload(paths);
    // A story template and a bug template sit at the same depth.
    retypeNode(board, findRegistryTemplate(board, 'TPL-4')!, { type: 'bug' });
    expect(findRegistryTemplate(reload(paths), 'TPL-4')!.type).toBe('bug');
  });

  it('allocates registry ids from their own counter', () => {
    const paths = seedRegistry();
    seedBoard(paths);
    const board = reload(paths);
    expect(board.issues.map((issue) => issue.id)).toEqual(['LP-1', 'LP-2']);
    expect(board.templates.at(-1)!.id).toBe('TPL-6');
  });
});

describe('checking the registry', () => {
  it('reports parameters declared anywhere but a root', () => {
    const paths = seedRegistry();
    const board = reload(paths);
    const story = findRegistryTemplate(board, 'TPL-4')!;
    // Written by hand: the operations refuse this, `check` is what catches a
    // file somebody edited or merged.
    writeRawIssue(
      story.dir,
      [
        '---',
        'id: TPL-4',
        'type: user_story',
        'title: Design the {{name}} schema',
        'description: ""',
        'params:',
        '  extra:',
        '    type: string',
        'depends_on: []',
        'relates_to: []',
        'related_files: []',
        '---',
        '',
      ].join('\n'),
      TEMPLATE_FILE,
    );

    const problems = checkBoard(reload(paths));
    expect(problems.some((problem) => /only the root of a template/.test(problem.message))).toBe(
      true,
    );
  });

  it('reports a placeholder no parameter answers', () => {
    const paths = seedRegistry();
    let board = reload(paths);
    updateNode(board, findRegistryTemplate(board, 'TPL-4')!, {
      title: 'Design the {{nmae}} schema',
    });

    board = reload(paths);
    const problems = checkBoard(board);
    expect(
      problems.some(
        (problem) => problem.level === 'warn' && problem.message.includes('{{nmae}}'),
      ),
    ).toBe(true);
  });

  it('reports a root with nothing to say for itself', () => {
    const paths = seedRegistry();
    let board = reload(paths);
    updateNode(board, findRegistryTemplate(board, 'TPL-3')!, { description: '' });

    board = reload(paths);
    expect(checkBoard(board).some((problem) => /no description/.test(problem.message))).toBe(true);
  });

  it('leaves the registry valid after --fix', () => {
    const paths = seedRegistry();
    applyFixes(reload(paths));
    const board = reload(paths);
    expect(checkBoard(board).filter((problem) => problem.level === 'error')).toEqual([]);
    expect(board.templates).toHaveLength(6);
  });
});

describe('the config the registry derives', () => {
  it('reserves the folder type across every namespace', () => {
    const { errors } = parseConfigText(
      [
        'key_prefix: LP',
        'statuses:',
        '  - { id: todo, label: Todo }',
        'issue_types:',
        '  folder: { label: Folder }',
        'hierarchy: [folder]',
      ].join('\n'),
    );
    expect(errors.join(' ')).toMatch(/reserved for the template registry/);
  });

  it('refuses a template prefix that collides with another namespace', () => {
    const { errors } = parseConfigText(
      [
        'key_prefix: TPL',
        'statuses:',
        '  - { id: todo, label: Todo }',
        'issue_types:',
        '  task: { label: Task }',
        'hierarchy: [task]',
      ].join('\n'),
    );
    expect(errors.join(' ')).toMatch(/template_prefix/);
  });

  it('takes a template prefix the board declares', () => {
    const { config } = parseConfigText(
      [
        'key_prefix: LP',
        'template_prefix: PAT',
        'statuses:',
        '  - { id: todo, label: Todo }',
        'issue_types:',
        '  task: { label: Task }',
        'hierarchy: [task]',
      ].join('\n'),
    );
    expect(config?.template_prefix).toBe('PAT');
  });
});

describe('resolving parameters', () => {
  const declared = {
    name: { type: 'string' as const, required: true },
    size: { type: 'int' as const, default: 3 },
    tier: { type: 'enum' as const, values: ['a', 'b'] },
  };

  it('fills in defaults and leaves optional parameters empty', () => {
    const { values, errors } = resolveParams(declared, { name: 'Payments' });
    expect(errors).toEqual([]);
    expect(values).toEqual({ name: 'Payments', size: 3, tier: '' });
  });

  it('refuses a required parameter with no answer', () => {
    const { errors } = resolveParams(declared, {});
    expect(errors).toEqual(['"name" is required']);
  });

  it('refuses an answer the template never asked for', () => {
    const { errors } = resolveParams(declared, { name: 'X', nope: 1 });
    expect(errors[0]).toMatch(/"nope" is not a parameter/);
    expect(errors[0]).toMatch(/name, size, tier/);
  });

  it('validates an answer against its declaration', () => {
    const { errors } = resolveParams(declared, { name: 'X', tier: 'c' }, validateAttributeValue);
    expect(errors[0]).toMatch(/"tier"/);
  });
});

describe('instantiating a template', () => {
  it('creates the whole tree with the parameters filled in', () => {
    const paths = seedRegistry();
    seedBoard(paths);

    const plan = planInstantiate(viewOf(paths), counterFactory(), 'TPL-3', {
      parentId: 'LP-2',
      params: { name: 'Payments', owner: 'Ana' },
      validate: validateAttributeValue,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    const result = applyChanges(paths, plan.changes);
    expect(result.failures).toEqual([]);

    const board = reload(paths);
    const titles = board.issues.map((issue) => issue.title);
    expect(titles).toContain('Payments API');
    expect(titles).toContain('Design the Payments schema');
    expect(titles).toContain('Document Payments for Ana');

    const feature = board.issues.find((issue) => issue.title === 'Payments API')!;
    expect(feature.parentId).toBe('LP-2');
    expect(feature.type).toBe('feature');
    expect(checkBoard(board).filter((problem) => problem.level === 'error')).toEqual([]);
  });

  it('repoints the dependencies at the issues it just created', () => {
    const paths = seedRegistry();
    seedBoard(paths);

    const plan = planInstantiate(viewOf(paths), counterFactory(), 'TPL-3', {
      parentId: 'LP-2',
      params: { name: 'Payments' },
    });
    if (!plan.ok) throw new Error(plan.error);
    applyChanges(paths, plan.changes);

    const board = reload(paths);
    const design = board.issues.find((issue) => issue.title.startsWith('Design'))!;
    const build = board.issues.find((issue) => issue.title.startsWith('Build'))!;
    const document = board.issues.find((issue) => issue.title.startsWith('Document'))!;

    expect(build.depends_on).toEqual([design.id]);
    expect(document.depends_on).toEqual([build.id]);
    // Nothing points back into the registry.
    for (const issue of board.issues) {
      expect(issue.depends_on.every((id) => id.startsWith('LP-'))).toBe(true);
    }
  });

  it('schedules and assigns the whole copy when asked to', () => {
    const paths = seedRegistry();
    seedBoard(paths);
    const plan = planInstantiate(viewOf(paths), counterFactory(), 'TPL-3', {
      parentId: 'LP-2',
      params: { name: 'Payments' },
      status: 'in_progress',
    });
    if (!plan.ok) throw new Error(plan.error);
    applyChanges(paths, plan.changes);

    const board = reload(paths);
    const feature = board.issues.find((issue) => issue.title === 'Payments API')!;
    expect(feature.status).toBe('in_progress');
  });

  it('keeps an attribute that is one whole placeholder as its own type', () => {
    const paths = seedRegistry();
    seedBoard(paths);

    let board = reload(paths);
    updateNode(board, findRegistryTemplate(board, 'TPL-3')!, {
      params: {
        name: { type: 'string', required: true },
        owner: { type: 'string', default: 'nobody' },
        points: { type: 'int', default: 5 },
      },
    });
    board = reload(paths);
    updateNode(board, findRegistryTemplate(board, 'TPL-4')!, {
      attributes: { story_points: '{{points}}' },
    });

    const plan = planInstantiate(viewOf(paths), counterFactory(), 'TPL-3', {
      parentId: 'LP-2',
      params: { name: 'Payments', points: 8 },
      validate: validateAttributeValue,
    });
    if (!plan.ok) throw new Error(`${plan.error}: ${(plan.details ?? []).join('; ')}`);
    const result = applyChanges(paths, plan.changes);
    expect(result.failures).toEqual([]);

    const design = reload(paths).issues.find((issue) => issue.title.startsWith('Design'))!;
    expect(design.attributes.story_points).toBe(8);
  });

  it('fills placeholders in the body and in related files', () => {
    const paths = seedRegistry();
    seedBoard(paths);

    let board = reload(paths);
    updateNode(board, findRegistryTemplate(board, 'TPL-4')!, {
      body: '# Schema for {{name}}\n\nOwner: {{owner}}.\n',
      relatedFiles: ['src/{{name}}/schema.ts'],
    });

    const plan = planInstantiate(viewOf(paths), counterFactory(), 'TPL-3', {
      parentId: 'LP-2',
      params: { name: 'payments', owner: 'Ana' },
    });
    if (!plan.ok) throw new Error(plan.error);
    applyChanges(paths, plan.changes);

    board = reload(paths);
    const design = board.issues.find((issue) => issue.title.startsWith('Design'))!;
    expect(design.body).toContain('# Schema for payments');
    expect(design.body).toContain('Owner: Ana.');
    expect(design.related_files).toEqual(['src/payments/schema.ts']);
  });

  it('refuses a target the hierarchy would not accept', () => {
    const paths = seedRegistry();
    seedBoard(paths);
    const plan = planInstantiate(viewOf(paths), counterFactory(), 'TPL-3', {
      params: { name: 'Payments' },
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error).toMatch(/cannot sit at level 0/);
  });

  it('refuses a folder and refuses a template nested inside one', () => {
    const paths = seedRegistry();
    seedBoard(paths);
    const view = viewOf(paths);
    expect(planInstantiate(view, counterFactory(), 'TPL-1', {})).toMatchObject({
      ok: false,
      error: expect.stringMatching(/is a folder/),
    });
    expect(planInstantiate(view, counterFactory(), 'TPL-4', {})).toMatchObject({
      ok: false,
      error: expect.stringMatching(/part of a template/),
    });
  });

  it('refuses a folder somebody nested inside a template by hand', () => {
    const paths = seedRegistry();
    seedBoard(paths);

    // The operations refuse this and `check` reports it; a merged or
    // hand-edited registry can still hold one, and it must not reach the board
    // as an issue of a type that does not exist.
    const board = reload(paths);
    const story = findRegistryTemplate(board, 'TPL-4')!;
    writeRawIssue(
      path.join(story.dir, 'TPL-99'),
      [
        '---',
        'id: TPL-99',
        'type: folder',
        'title: Stray',
        'description: ""',
        'depends_on: []',
        'relates_to: []',
        'related_files: []',
        '---',
        '',
      ].join('\n'),
      TEMPLATE_FILE,
    );

    const plan = planInstantiate(viewOf(paths), counterFactory(), 'TPL-3', {
      parentId: 'LP-2',
      params: { name: 'Payments' },
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error).toMatch(/folder nested inside it/);
    expect(plan.error).toContain('TPL-99');
  });

  it('refuses a placeholder no parameter answers rather than writing it', () => {
    const paths = seedRegistry();
    seedBoard(paths);

    const board = reload(paths);
    updateNode(board, findRegistryTemplate(board, 'TPL-4')!, { title: 'Design {{whoops}}' });

    const plan = planInstantiate(viewOf(paths), counterFactory(), 'TPL-3', {
      parentId: 'LP-2',
      params: { name: 'Payments' },
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.details?.join(' ')).toContain('{{whoops}}');
  });

  it('refuses a title that would collapse to nothing', () => {
    const paths = seedRegistry();
    seedBoard(paths);

    // `note` is optional *and* has no default, so leaving it out fills the
    // title in to "" — an issue with no title, which `createIssue` would refuse
    // several steps into the push, naming a document that does not exist yet.
    let board = reload(paths);
    updateNode(board, findRegistryTemplate(board, 'TPL-3')!, {
      params: {
        name: { type: 'string', required: true },
        owner: { type: 'string', default: 'nobody' },
        note: { type: 'string' },
      },
    });
    board = reload(paths);
    updateNode(board, findRegistryTemplate(board, 'TPL-4')!, { title: '{{note}}' });

    const plan = planInstantiate(viewOf(paths), counterFactory(), 'TPL-3', {
      parentId: 'LP-2',
      params: { name: 'Payments' },
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error).toMatch(/no title/);
    expect(plan.details?.join(' ')).toContain('TPL-4');
  });

  it('leaves the registry untouched', () => {
    const paths = seedRegistry();
    seedBoard(paths);
    const before = readFileSync(
      path.join(reload(paths).paths.registryDir, 'TPL-1', 'TPL-2', 'TPL-3', TEMPLATE_FILE),
      'utf8',
    );

    const plan = planInstantiate(viewOf(paths), counterFactory(), 'TPL-3', {
      parentId: 'LP-2',
      params: { name: 'Payments' },
    });
    if (!plan.ok) throw new Error(plan.error);
    applyChanges(paths, plan.changes);

    const after = readFileSync(
      path.join(reload(paths).paths.registryDir, 'TPL-1', 'TPL-2', 'TPL-3', TEMPLATE_FILE),
      'utf8',
    );
    expect(after).toBe(before);
    expect(reload(paths).templates).toHaveLength(6);
  });

  it('can be instantiated twice, producing two independent copies', () => {
    const paths = seedRegistry();
    seedBoard(paths);

    for (const name of ['Payments', 'Refunds']) {
      const plan = planInstantiate(viewOf(paths), counterFactory(), 'TPL-3', {
        parentId: 'LP-2',
        params: { name },
      });
      if (!plan.ok) throw new Error(plan.error);
      applyChanges(paths, plan.changes);
    }

    const board = reload(paths);
    const features = board.issues.filter((issue) => issue.type === 'feature');
    expect(features.map((issue) => issue.title).sort()).toEqual(['Payments API', 'Refunds API']);

    // Each copy's stories point only at its own siblings.
    for (const feature of features) {
      const stories = board.issues.filter((issue) => issue.parentId === feature.id);
      const ids = new Set(stories.map((issue) => issue.id));
      for (const story of stories) {
        for (const dep of story.depends_on) expect(ids.has(dep)).toBe(true);
      }
    }
  });
});

describe('the registry through the edit protocol', () => {
  it('creates, links and edits templates from a queued change list', () => {
    const paths = makeBoard('scrum', 'LP');

    const result = applyChanges(paths, [
      {
        kind: 'create',
        id: 'new:1',
        nodeKind: 'template',
        patch: { type: 'folder', title: 'Delivery', description: 'Patterns' },
      },
      {
        kind: 'create',
        id: 'new:2',
        nodeKind: 'template',
        patch: { type: 'folder', title: 'Epics', parentId: 'new:1' },
      },
      {
        kind: 'create',
        id: 'new:3',
        nodeKind: 'template',
        patch: {
          type: 'feature',
          title: '{{name}} API',
          parentId: 'new:2',
          description: 'A feature and its stories',
          params: { name: { type: 'string', required: true } },
        },
      },
      {
        kind: 'create',
        id: 'new:4',
        nodeKind: 'template',
        patch: { type: 'user_story', title: 'Build {{name}}', parentId: 'new:3' },
      },
      {
        kind: 'create',
        id: 'new:5',
        nodeKind: 'template',
        // Forward reference: the push holds this link back until new:4 exists.
        patch: {
          type: 'user_story',
          title: 'Ship {{name}}',
          parentId: 'new:3',
          dependsOn: ['new:4'],
        },
      },
    ]);

    expect(result.failures).toEqual([]);
    const board = reload(paths);
    const ship = board.templates.find((entry) => entry.title === 'Ship {{name}}')!;
    const build = board.templates.find((entry) => entry.title === 'Build {{name}}')!;
    expect(ship.depends_on).toEqual([build.id]);

    const feature = board.templates.find((entry) => entry.type === 'feature')!;
    expect(feature.params.name).toEqual({ type: 'string', required: true });
    expect(isTemplateRoot(board, feature)).toBe(true);
  });

  it('carries the registry into the snapshot with roots marked', () => {
    const snapshot = toSnapshot(reload(seedRegistry()));
    expect(snapshot.templates.map((entry) => entry.id)).toHaveLength(6);
    expect(snapshot.templates.filter((entry) => entry.root).map((entry) => entry.id)).toEqual([
      'TPL-3',
    ]);
    // The registry reuses the issue types by name, and adds exactly one.
    expect(snapshot.config.types.feature?.kind).toBe('issue');
    expect(snapshot.config.types.folder?.kind).toBe('template');
    expect(snapshot.config.hierarchy.template[2]).toContain('feature');
    expect(snapshot.config.hierarchy.template[2]).toContain('folder');
  });
});

describe('requireTemplate', () => {
  it('resolves case-insensitively and says where to look when it cannot', () => {
    const board = reload(seedRegistry());
    expect(requireTemplate(board, 'tpl-3').id).toBe('TPL-3');
    let thrown: BoardError | null = null;
    try {
      requireTemplate(board, 'TPL-99');
    } catch (error) {
      thrown = error as BoardError;
    }
    expect(thrown?.message).toMatch(/No template with id/);
    expect(thrown?.details.join(' ')).toMatch(/lpm template list/);
  });

  it('finds a template through findNode, like any other document', () => {
    const board = reload(seedRegistry());
    const found: Template | null = findRegistryTemplate(board, 'TPL-3');
    expect(found?.kind).toBe('template');
  });
});
