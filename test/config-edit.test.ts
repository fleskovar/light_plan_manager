import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { BoardPaths } from '../src/core/index.js';
import {
  BoardError,
  checkBoard,
  contextTemplatePath,
  createIssue,
  createTemplate,
  editBoardConfig,
  findIssue,
  moveNode,
  updateNode,
} from '../src/core/index.js';
import type { ConfigEdit } from '../src/shared/index.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterAll(cleanupBoards);

/**
 * LP-1 program > LP-2 epic > LP-3 feature > LP-4 user story, and in the
 * registry TPL-1 folder > TPL-2 epic. LP-4 is in the status `in_progress` and
 * holds the priority `high`.
 */
function seed(): BoardPaths {
  const paths = makeBoard('scrum', 'LP');
  createIssue(reload(paths), { type: 'program', title: 'Payments platform' });
  createIssue(reload(paths), { type: 'epic', title: 'Checkout revamp', parentId: 'LP-1' });
  createIssue(reload(paths), { type: 'feature', title: 'Guest flow', parentId: 'LP-2' });
  createIssue(reload(paths), {
    type: 'user_story',
    title: 'Guest checkout',
    parentId: 'LP-3',
    attributes: { priority: 'high' },
  });
  moveNode(reload(paths), findIssue(reload(paths), 'LP-4')!, { status: 'in_progress' });
  const folder = createTemplate(reload(paths), { type: 'folder', title: 'Patterns' });
  createTemplate(reload(paths), { type: 'epic', title: 'Standard epic', parentId: folder.id });
  return paths;
}

const configOf = (paths: BoardPaths): string => readFileSync(paths.configPath, 'utf8');

const errorsOf = (paths: BoardPaths): string[] =>
  checkBoard(reload(paths))
    .filter((problem) => problem.level === 'error')
    .map((problem) => `${problem.path}: ${problem.message}`);

function refusal(run: () => unknown): BoardError {
  try {
    run();
  } catch (error) {
    if (error instanceof BoardError) return error;
    throw error;
  }
  throw new Error('The call did not throw');
}

describe('renaming a type', () => {
  it('rewrites the config, every issue of the type and every registry template of the type', () => {
    const paths = seed();
    const result = editBoardConfig(paths, [
      { op: 'update-type', kind: 'issue', type: 'epic', name: 'milestone', label: 'Milestone' },
    ]);

    const board = reload(paths);
    expect(board.config.issue_types.milestone?.label).toBe('Milestone');
    expect(board.config.issue_types.epic).toBeUndefined();
    expect(board.config.hierarchy[1]).toEqual(['milestone']);
    expect(findIssue(board, 'LP-2')!.type).toBe('milestone');
    expect(board.templatesById.get('TPL-2')!.type).toBe('milestone');
    expect(readFileSync(findIssue(board, 'LP-2')!.file, 'utf8')).toContain('type: milestone');

    expect(result.rewritten).toBe(2);
    expect(result.renamedTypes).toEqual({ epic: 'milestone' });
    expect(errorsOf(paths)).toEqual([]);
  });

  it('keeps the attributes, the body and the field `updated` of a rewritten issue', () => {
    const paths = seed();
    const before = findIssue(reload(paths), 'LP-2')!;
    editBoardConfig(paths, [{ op: 'update-type', kind: 'issue', type: 'epic', name: 'milestone' }]);

    const after = findIssue(reload(paths), 'LP-2')!;
    expect(after.attributes).toEqual(before.attributes);
    expect(after.body).toBe(before.body);
    expect(after.updated).toBe(before.updated);
  });

  it('renames the context template of the type', () => {
    const paths = seed();
    expect(existsSync(contextTemplatePath(paths, 'epic'))).toBe(true);

    const result = editBoardConfig(paths, [
      { op: 'update-type', kind: 'issue', type: 'epic', name: 'milestone' },
    ]);

    expect(existsSync(contextTemplatePath(paths, 'epic'))).toBe(false);
    expect(existsSync(contextTemplatePath(paths, 'milestone'))).toBe(true);
    expect(result.notes).toContain('Renamed the context template context/epic.md to context/milestone.md.');
  });

  it('renames the keys of the mapping of each remote', () => {
    const paths = seed();
    appendFileSync(
      paths.configPath,
      [
        '',
        'remotes:',
        '  tracker:',
        '    provider: jsonfile',
        '    conflict: manual',
        '    mapping:',
        '      types: { epic: Epic, feature: Feature }',
        '      statuses: { backlog: Todo, done: Closed }',
        '',
      ].join('\n'),
    );

    const result = editBoardConfig(paths, [
      { op: 'update-type', kind: 'issue', type: 'epic', name: 'milestone' },
      { op: 'update-status', status: 'backlog', id: 'inbox' },
    ]);

    const mapping = reload(paths).config.remotes.tracker!.mapping;
    expect(mapping.types).toEqual({ milestone: 'Epic', feature: 'Feature' });
    expect(mapping.statuses).toEqual({ inbox: 'Todo', done: 'Closed' });
    expect(result.notes).toContain('Renamed the key "epic" to "milestone" in remotes.tracker.mapping.types.');
  });

  it('notes each remote whose mapping has no entry for a new status or a new type', () => {
    const paths = seed();
    appendFileSync(
      paths.configPath,
      [
        '',
        'remotes:',
        '  tracker:',
        '    provider: jsonfile',
        '    conflict: manual',
        '    mapping:',
        '      types: { epic: Epic }',
        '      statuses: { backlog: Todo }',
        '',
      ].join('\n'),
    );

    const result = editBoardConfig(paths, [
      { op: 'add-status', id: 'parked', label: 'Parked' },
      { op: 'add-type', kind: 'issue', name: 'spike', label: 'Spike', level: 3, placement: 'join' },
      { op: 'add-type', kind: 'period', name: 'quarter', label: 'Quarter', level: 0, placement: 'join' },
    ]);

    expect(result.notes).toEqual([
      'remotes.tracker.mapping.statuses has no entry for "parked". The remote cannot sync until the status is mapped.',
      'remotes.tracker.mapping.types has no entry for "spike". The remote cannot sync an issue of this type until the type is mapped.',
    ]);
  });

  it('changes one line of the config when only the label changes, and rewrites no document', () => {
    const paths = seed();
    const before = configOf(paths).split('\n');

    const result = editBoardConfig(paths, [
      { op: 'update-type', kind: 'issue', type: 'epic', label: 'Milestone' },
    ]);

    const after = configOf(paths).split('\n');
    expect(after.length).toBe(before.length);
    const changed = after.filter((line, index) => line !== before[index]);
    expect(changed).toEqual(['    label: Milestone']);
    expect(result.rewritten).toBe(0);
  });

  it('refuses a name that another type holds', () => {
    const paths = seed();
    const error = refusal(() =>
      editBoardConfig(paths, [{ op: 'update-type', kind: 'issue', type: 'epic', name: 'sprint' }]),
    );
    expect(error.message).toBe('A type called "sprint" already exists (period type)');
  });

  it('renames a period type in the timeline', () => {
    const paths = makeBoard('scrum', 'LP', { omni: true });
    editBoardConfig(paths, [{ op: 'update-type', kind: 'period', type: 'sprint', name: 'iteration' }]);

    const board = reload(paths);
    expect(board.config.period_hierarchy).toEqual([['increment'], ['iteration']]);
    expect(board.periods.map((period) => period.type)).toEqual(['increment', 'iteration']);
    expect(errorsOf(paths)).toEqual([]);
  });
});

describe('adding and removing a type', () => {
  it('adds a type to an existing level', () => {
    const paths = seed();
    editBoardConfig(paths, [
      { op: 'add-type', kind: 'issue', name: 'initiative', label: 'Initiative', level: 1, placement: 'join' },
    ]);

    const board = reload(paths);
    expect(board.config.hierarchy[1]).toEqual(['epic', 'initiative']);
    expect(board.config.issue_types.initiative).toMatchObject({ label: 'Initiative', attributes: {}, body: '' });
    expect(configOf(paths)).toContain('  - [epic, initiative]');
    createIssue(board, { type: 'initiative', title: 'Expansion', parentId: 'LP-1' });
    expect(errorsOf(paths)).toEqual([]);
  });

  it('adds a level below the deepest level of a board that has documents', () => {
    const paths = seed();
    editBoardConfig(paths, [
      { op: 'add-type', kind: 'issue', name: 'step', label: 'Step', level: 5, placement: 'insert' },
    ]);
    expect(reload(paths).config.hierarchy.at(-1)).toEqual(['step']);
    expect(errorsOf(paths)).toEqual([]);
  });

  it('refuses a new level above existing documents, and names one of them', () => {
    const paths = seed();
    const error = refusal(() =>
      editBoardConfig(paths, [
        { op: 'add-type', kind: 'issue', name: 'initiative', label: 'Initiative', level: 1, placement: 'insert' },
      ]),
    );
    expect(error.message).toBe('Cannot insert a level at index 1 of the issue hierarchy');
    // LP-2, LP-3 and LP-4 on the board, and TPL-2 in the registry.
    expect(error.details[0]).toBe('4 documents sit at that level or deeper, for example LP-2.');
  });

  it('inserts a level in the middle of the hierarchy of an empty board', () => {
    const paths = makeBoard('scrum', 'LP');
    editBoardConfig(paths, [
      { op: 'add-type', kind: 'issue', name: 'initiative', label: 'Initiative', level: 1, placement: 'insert' },
    ]);
    expect(reload(paths).config.hierarchy.slice(0, 3)).toEqual([['program'], ['initiative'], ['epic']]);
  });

  it('refuses to remove a type that a document uses', () => {
    const paths = seed();
    const error = refusal(() => editBoardConfig(paths, [{ op: 'remove-type', kind: 'issue', type: 'epic' }]));
    expect(error.message).toBe('Cannot remove the type "epic"');
    expect(error.details[0]).toBe('2 documents have this type, for example LP-2.');
  });

  it('removes an unused type from its level', () => {
    const paths = seed();
    editBoardConfig(paths, [{ op: 'remove-type', kind: 'issue', type: 'research' }]);

    const board = reload(paths);
    expect(board.config.issue_types.research).toBeUndefined();
    expect(board.config.hierarchy[3]).toEqual(['user_story', 'bug', 'test', 'review']);
  });
});

describe('statuses', () => {
  it('renames a status in the config and in every issue that holds it', () => {
    const paths = seed();
    const result = editBoardConfig(paths, [
      { op: 'update-status', status: 'in_progress', id: 'doing', label: 'Doing' },
      { op: 'update-status', status: 'backlog', id: 'inbox' },
    ]);

    const board = reload(paths);
    expect(board.config.statuses.map((status) => status.id)).toEqual(['inbox', 'ready', 'doing', 'in_review', 'done']);
    expect(board.config.statuses[2]).toMatchObject({ id: 'doing', label: 'Doing', active: true });
    expect(board.config.default_status).toBe('inbox');
    expect(findIssue(board, 'LP-4')!.status).toBe('doing');
    expect(findIssue(board, 'LP-3')!.status).toBe('inbox');
    expect(result.rewritten).toBe(4);
    expect(errorsOf(paths)).toEqual([]);
  });

  it('adds a status at a position', () => {
    const paths = seed();
    editBoardConfig(paths, [{ op: 'add-status', id: 'blocked_external', label: 'Waiting', index: 3 }]);
    expect(reload(paths).config.statuses.map((status) => status.id)).toEqual([
      'backlog',
      'ready',
      'in_progress',
      'blocked_external',
      'in_review',
      'done',
    ]);
  });

  it('refuses to remove a status that an issue holds, and removes one that no issue holds', () => {
    const paths = seed();
    const error = refusal(() => editBoardConfig(paths, [{ op: 'remove-status', status: 'in_progress' }]));
    expect(error.details[0]).toBe('1 issue has this status, for example LP-4.');

    editBoardConfig(paths, [{ op: 'remove-status', status: 'ready' }]);
    expect(reload(paths).config.statuses.map((status) => status.id)).not.toContain('ready');
  });

  it('refuses to remove the default status', () => {
    const paths = makeBoard('scrum', 'LP');
    const error = refusal(() => editBoardConfig(paths, [{ op: 'remove-status', status: 'backlog' }]));
    expect(error.details[0]).toBe('It is the default status, which each new issue gets.');
  });
});

describe('attributes', () => {
  it('adds an enum attribute that a document can then hold', () => {
    const paths = seed();
    editBoardConfig(paths, [
      {
        op: 'add-attribute',
        kind: 'issue',
        type: 'feature',
        name: 'risk',
        attribute: { type: 'enum', description: 'Delivery risk', values: ['low', 'high'] },
      },
    ]);

    expect(reload(paths).config.issue_types.feature!.attributes.risk).toEqual({
      type: 'enum',
      description: 'Delivery risk',
      values: ['low', 'high'],
    });
    expect(configOf(paths)).toContain('        values: [low, high]');
    updateNode(reload(paths), findIssue(reload(paths), 'LP-3')!, { attributes: { risk: 'high' } });
    expect(errorsOf(paths)).toEqual([]);
  });

  it('renames an attribute of one type and moves the value in each document of the type', () => {
    const paths = seed();
    const result = editBoardConfig(paths, [
      { op: 'update-attribute', kind: 'issue', type: 'user_story', attribute: 'priority', name: 'urgency' },
    ]);

    const board = reload(paths);
    const story = findIssue(board, 'LP-4')!;
    expect(story.attributes.urgency).toBe('high');
    expect('priority' in story.attributes).toBe(false);
    // Other types still declare `priority`, so the ranking key keeps its value.
    expect(board.config.priority_attribute).toBe('priority');
    expect(result.notes).toEqual([
      'priority_attribute still names "priority". The type "user_story" no longer has an attribute of that name.',
    ]);
  });

  it('moves `priority_attribute` when the last type that declares the attribute is renamed', () => {
    const paths = seed();
    const types = Object.entries(reload(paths).config.issue_types)
      .filter(([, def]) => def.attributes.priority)
      .map(([name]) => name);

    const result = editBoardConfig(
      paths,
      types.map(
        (type): ConfigEdit => ({ op: 'update-attribute', kind: 'issue', type, attribute: 'priority', name: 'urgency' }),
      ),
    );

    const board = reload(paths);
    expect(board.config.priority_attribute).toBe('urgency');
    expect(findIssue(board, 'LP-4')!.attributes.urgency).toBe('high');
    expect(result.notes).toEqual([]);
    expect(errorsOf(paths)).toEqual([]);
  });

  it('removes an attribute from the type and from each document of the type', () => {
    const paths = seed();
    editBoardConfig(paths, [{ op: 'remove-attribute', kind: 'issue', type: 'user_story', attribute: 'commit' }]);

    const board = reload(paths);
    expect(board.config.issue_types.user_story!.attributes.commit).toBeUndefined();
    expect(readFileSync(findIssue(board, 'LP-4')!.file, 'utf8')).not.toContain('commit:');
  });

  it('refuses to drop an enum value that a document holds', () => {
    const paths = seed();
    const error = refusal(() =>
      editBoardConfig(paths, [
        {
          op: 'update-attribute',
          kind: 'issue',
          type: 'user_story',
          attribute: 'priority',
          values: ['critical', 'medium', 'low'],
        },
      ]),
    );
    expect(error.message).toBe('Cannot remove "high" from "priority"');
    expect(error.details[0]).toBe('1 document of the type "user_story" holds a removed value, for example LP-4.');
  });

  it('adds an enum value', () => {
    const paths = seed();
    editBoardConfig(paths, [
      {
        op: 'update-attribute',
        kind: 'issue',
        type: 'user_story',
        attribute: 'priority',
        values: ['critical', 'high', 'medium', 'low', 'someday'],
      },
    ]);
    expect(reload(paths).config.issue_types.user_story!.attributes.priority!.values).toContain('someday');
  });

  it('refuses a reserved field name', () => {
    const paths = seed();
    const error = refusal(() =>
      editBoardConfig(paths, [
        { op: 'add-attribute', kind: 'issue', type: 'feature', name: 'status', attribute: { type: 'string' } },
      ]),
    );
    expect(error.message).toBe('"status" is a reserved field name');
  });
});

describe('a list of edits', () => {
  it('writes nothing when a later edit is refused', () => {
    const paths = seed();
    const config = configOf(paths);
    const epic = readFileSync(findIssue(reload(paths), 'LP-2')!.file, 'utf8');

    refusal(() =>
      editBoardConfig(paths, [
        { op: 'update-type', kind: 'issue', type: 'epic', name: 'milestone' },
        { op: 'remove-status', status: 'in_progress' },
      ]),
    );

    expect(configOf(paths)).toBe(config);
    expect(readFileSync(findIssue(reload(paths), 'LP-2')!.file, 'utf8')).toBe(epic);
    expect(existsSync(contextTemplatePath(paths, 'epic'))).toBe(true);
  });

  it('lets a later edit use the name that an earlier edit gave', () => {
    const paths = seed();
    const result = editBoardConfig(paths, [
      { op: 'update-type', kind: 'issue', type: 'epic', name: 'milestone' },
      { op: 'update-type', kind: 'issue', type: 'milestone', name: 'goal', label: 'Goal' },
    ]);

    expect(findIssue(reload(paths), 'LP-2')!.type).toBe('goal');
    expect(result.renamedTypes).toEqual({ epic: 'goal' });
    expect(result.rewritten).toBe(2);
  });

  it('keeps every comment of the shipped config', () => {
    const paths = seed();
    // A line of a body that starts with `##` is a markdown heading, not a comment.
    const comments = (text: string): string[] => text.split('\n').filter((line) => /^\s*#( |-|$)/.test(line));
    const before = comments(configOf(paths));

    editBoardConfig(paths, [
      { op: 'update-type', kind: 'issue', type: 'epic', name: 'milestone', label: 'Milestone' },
      { op: 'add-status', id: 'parked', label: 'Parked' },
      { op: 'remove-type', kind: 'issue', type: 'sub_task' },
    ]);

    expect(comments(configOf(paths))).toEqual(before);
  });
});
