import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { BoardPaths, Problem } from '../src/core/index.js';
import {
  PERIOD_FILE,
  RESOURCE_FILE,
  applyFixes,
  checkBoard,
  createIssue,
  createResource,
  findIssue,
  findResource,
  genericResources,
  isGenericResource,
  linkResource,
  moveNode,
  namedResources,
  parseConfigText,
  readState,
  resourcesCovering,
} from '../src/core/index.js';
import { cleanupBoards, makeBoard, reload, writeRawIssue } from './helpers.js';

afterAll(cleanupBoards);

const messages = (problems: Problem[]): string => problems.map((p) => p.message).join('\n');

/** A scrum board with Alice, Bob and a junior pool Alice can cover. */
function seedTeam(): BoardPaths {
  const paths = makeBoard('scrum', 'LP');
  createResource(reload(paths), { type: 'person', title: 'Alice Smith' });
  createResource(reload(paths), { type: 'person', title: 'Bob Jones', capacity: 0.5 });
  createResource(reload(paths), { type: 'role', title: 'Jr. software developer', capacity: 3 });
  linkResource(reload(paths), findResource(reload(paths), 'RS-1')!, { covers: ['RS-3'] });
  return paths;
}

function teamPath(paths: BoardPaths, ...segments: string[]): string {
  return path.join(paths.teamDir, ...segments);
}

describe('the roster', () => {
  it('creates people and pools under .lpm/team', () => {
    const board = reload(seedTeam());

    expect(board.resources.map((resource) => resource.id)).toEqual(['RS-1', 'RS-2', 'RS-3']);
    expect(board.resources[0]!.file).toBe(
      path.join(board.paths.teamDir, 'RS-1', RESOURCE_FILE),
    );
    expect(namedResources(board).map((resource) => resource.title)).toEqual([
      'Alice Smith',
      'Bob Jones',
    ]);
    expect(genericResources(board).map((resource) => resource.title)).toEqual([
      'Jr. software developer',
    ]);
    expect(checkBoard(board)).toEqual([]);
  });

  it('counts capacity in full-time equivalents', () => {
    const board = reload(seedTeam());
    expect(findResource(board, 'RS-2')!.capacity).toBe(0.5);
    expect(findResource(board, 'RS-3')!.capacity).toBe(3);
  });

  it('uses its own id counter', () => {
    const paths = seedTeam();
    createIssue(reload(paths), { type: 'program', title: 'P' });
    const state = readState(paths);
    expect(state.resource_counter).toBe(3);
    expect(state.counter).toBe(1);
  });

  it('resolves a resource by id, name, slug or unique prefix', () => {
    const board = reload(seedTeam());
    for (const wanted of ['RS-1', 'rs-1', 'Alice Smith', 'alice smith', 'alice-smith', 'alice']) {
      expect(findResource(board, wanted)?.id).toBe('RS-1');
    }
    // "Jr." and "Jones" share no prefix, but an ambiguous one resolves to nothing.
    expect(findResource(board, 'zzz')).toBeNull();
  });

  it('refuses an ambiguous name rather than guessing', () => {
    const paths = seedTeam();
    createResource(reload(paths), { type: 'person', title: 'Alice Brown' });
    expect(findResource(reload(paths), 'alice')).toBeNull();
    expect(findResource(reload(paths), 'alice b')?.title).toBe('Alice Brown');
  });

  it('stores only the forward coverage edge and derives the inverse', () => {
    const board = reload(seedTeam());
    const alice = findResource(board, 'RS-1')!;

    expect(alice.covers).toEqual(['RS-3']);
    expect(readFileSync(findResource(board, 'RS-3')!.file, 'utf8')).not.toMatch(/covered_by/);
    expect(board.coveredBy.get('RS-3')).toEqual(['RS-1']);
    expect(resourcesCovering(board, 'RS-3').map((resource) => resource.id)).toEqual(['RS-1']);
  });

  it('refuses to cover a named resource', () => {
    const paths = seedTeam();
    const board = reload(paths);
    expect(() => linkResource(board, findResource(board, 'RS-2')!, { covers: ['RS-1'] })).toThrow(
      /named resource, not a pool/,
    );
  });

  it('removes coverage again', () => {
    const paths = seedTeam();
    linkResource(reload(paths), findResource(reload(paths), 'RS-1')!, {
      covers: ['RS-3'],
      remove: true,
    });
    expect(findResource(reload(paths), 'RS-1')!.covers).toEqual([]);
  });

  it('reads whether a resource is generic from its type, not the document', () => {
    const board = reload(seedTeam());
    expect(isGenericResource(board, findResource(board, 'RS-3')!)).toBe(true);
    expect(isGenericResource(board, findResource(board, 'RS-1')!)).toBe(false);
    expect(readFileSync(findResource(board, 'RS-3')!.file, 'utf8')).not.toMatch(/generic/);
  });
});

describe('assignment', () => {
  it('assigns at creation, by id or by name', () => {
    const paths = seedTeam();
    createIssue(reload(paths), { type: 'program', title: 'P' });
    const issue = createIssue(reload(paths), {
      type: 'epic',
      title: 'E',
      parentId: 'LP-1',
      assignee: 'alice',
    });
    expect(issue.assignee).toBe('RS-1');
    expect(checkBoard(reload(paths))).toEqual([]);
  });

  it('reassigns and unassigns with move', () => {
    const paths = seedTeam();
    createIssue(reload(paths), { type: 'program', title: 'P', assignee: 'RS-1' });

    const board = reload(paths);
    const moved = moveNode(board, findIssue(board, 'LP-1')!, { assignee: 'RS-3' });
    expect(moved.assigneeChanged).toBe(true);
    expect(findIssue(reload(paths), 'LP-1')!.assignee).toBe('RS-3');

    moveNode(reload(paths), findIssue(reload(paths), 'LP-1')!, { assignee: null });
    expect(findIssue(reload(paths), 'LP-1')!.assignee).toBeNull();
  });

  it('rejects an assignee that is not on the roster', () => {
    const paths = seedTeam();
    expect(() => createIssue(reload(paths), { type: 'program', title: 'P', assignee: 'RS-9' })).toThrow(
      /No resource with id or name/,
    );
  });

  it('rejects --assignee on periods and resources', () => {
    const paths = seedTeam();
    const board = reload(paths);
    expect(() => moveNode(board, findResource(board, 'RS-1')!, { assignee: 'RS-2' })).toThrow(
      /applies to issues only/,
    );
  });

  it('refuses assignment on a board with no roster', () => {
    const paths = makeBoard('blank', 'LP');
    expect(() => createIssue(reload(paths), { type: 'task', title: 'T', assignee: 'anyone' })).toThrow(
      /no team roster/,
    );
  });
});

describe('roster validation', () => {
  it('flags an assignee that no longer exists', () => {
    const paths = seedTeam();
    createIssue(reload(paths), { type: 'program', title: 'P', assignee: 'RS-2' });
    const issue = findIssue(reload(paths), 'LP-1')!;
    writeFileSync(
      issue.file,
      readFileSync(issue.file, 'utf8').replace('assignee: RS-2', 'assignee: RS-42'),
      'utf8',
    );

    const problems = checkBoard(reload(paths));
    expect(messages(problems)).toMatch(/assignee "RS-42" is not in the team roster/);
    // Clearing it for the user would silently lose the intent.
    expect(problems.find((p) => /RS-42/.test(p.message))!.fixable).toBeFalsy();
  });

  it('flags an assignee on a board that declares no resources', () => {
    const paths = makeBoard('blank', 'LP');
    writeRawIssue(
      path.join(paths.boardDir, 'LP-1'),
      '---\nid: LP-1\ntype: task\ntitle: X\nstatus: todo\nassignee: RS-1\n---\n',
    );
    expect(messages(checkBoard(reload(paths)))).toMatch(/config declares no resource types/);
  });

  it('flags team documents on a board that declares no resources', () => {
    const paths = makeBoard('blank', 'LP');
    writeRawIssue(
      path.join(paths.teamDir, 'someone'),
      '---\nid: RS-1\ntitle: Someone\n---\n',
      RESOURCE_FILE,
    );
    expect(messages(checkBoard(reload(paths)))).toMatch(/config declares no resource_types/);
  });

  it('flags negative capacity but accepts zero', () => {
    const paths = seedTeam();
    writeRawIssue(
      teamPath(paths, 'RS-9-away'),
      '---\nid: RS-9\ntype: person\ntitle: Away\ncapacity: -1\n---\n',
      RESOURCE_FILE,
    );
    expect(messages(checkBoard(reload(paths)))).toMatch(/capacity -1 is negative/);

    writeRawIssue(
      teamPath(paths, 'RS-9-away'),
      '---\nid: RS-9\ntype: person\ntitle: Away\ncapacity: 0\n---\n',
      RESOURCE_FILE,
    );
    expect(messages(checkBoard(reload(paths)))).not.toMatch(/capacity/);
  });

  it('warns when work is assigned to someone with no capacity', () => {
    const paths = seedTeam();
    createResource(reload(paths), { type: 'person', title: 'On Leave', capacity: 0 });
    createIssue(reload(paths), { type: 'program', title: 'P', assignee: 'RS-4' });
    expect(messages(checkBoard(reload(paths)))).toMatch(/which has no capacity/);
  });

  it('warns about a pool holding work that nobody covers', () => {
    const paths = seedTeam();
    createResource(reload(paths), { type: 'role', title: 'Sr. data engineer' });
    createIssue(reload(paths), { type: 'program', title: 'P', assignee: 'RS-4' });

    expect(messages(checkBoard(reload(paths)))).toMatch(/holds 1 open issue but no one covers it/);
  });

  it('stays quiet when the pool has coverage', () => {
    const paths = seedTeam();
    createIssue(reload(paths), { type: 'program', title: 'P', assignee: 'RS-3' });
    expect(messages(checkBoard(reload(paths)))).not.toMatch(/no one covers it/);
  });

  it('flags covers that points at a missing or named resource', () => {
    const paths = seedTeam();
    writeRawIssue(
      teamPath(paths, 'RS-9-odd'),
      '---\nid: RS-9\ntype: person\ntitle: Odd\ncapacity: 1\ncovers: [RS-2, RS-42, RS-9]\n---\n',
      RESOURCE_FILE,
    );
    const text = messages(checkBoard(reload(paths)));
    expect(text).toMatch(/covers RS-2 \(Bob Jones\), which is a named resource, not a pool/);
    expect(text).toMatch(/covers "RS-42", which is not in the team roster/);
    expect(text).toMatch(/covers itself/);
  });
});

describe('roster repair', () => {
  it('adopts a hand-made resource folder', () => {
    const paths = seedTeam();
    writeRawIssue(teamPath(paths, 'carol-diaz'), '# Carol Diaz\n', RESOURCE_FILE);

    applyFixes(reload(paths));
    const board = reload(paths);
    const carol = board.resources.find((resource) => resource.title === 'Carol Diaz')!;

    expect(carol.id).toBe('RS-4');
    expect(carol.capacity).toBe(1);
    expect(carol.created).toEqual(expect.any(String));
    expect(path.basename(carol.dir)).toBe('RS-4');
    // "person" or "role" are both possible at this level, so type stays open.
    expect(messages(checkBoard(board))).toMatch(/missing type/);
  });

  it('fills a missing capacity and dedupes covers', () => {
    const paths = seedTeam();
    writeRawIssue(
      teamPath(paths, 'RS-9-dan'),
      '---\nid: RS-9\ntype: person\ntitle: Dan\ncovers: [RS-3, RS-3]\n---\n',
      RESOURCE_FILE,
    );

    applyFixes(reload(paths));
    const dan = findResource(reload(paths), 'RS-9')!;
    expect(dan.capacity).toBe(1);
    expect(dan.covers).toEqual(['RS-3']);
    expect(checkBoard(reload(paths))).toEqual([]);
  });

  it('resyncs the resource counter', () => {
    const paths = seedTeam();
    writeRawIssue(
      teamPath(paths, 'RS-20-eve'),
      '---\nid: RS-20\ntype: person\ntitle: Eve\ncapacity: 1\n---\n',
      RESOURCE_FILE,
    );
    applyFixes(reload(paths));
    expect(readState(paths).resource_counter).toBe(20);
  });

  it('is idempotent', () => {
    const paths = seedTeam();
    writeRawIssue(teamPath(paths, 'adopt-me'), '---\ntype: person\ntitle: Adopt me\n---\n', RESOURCE_FILE);
    applyFixes(reload(paths));
    expect(applyFixes(reload(paths))).toEqual([]);
  });
});

describe('resource configuration', () => {
  const WITH_TEAM = `
version: 1
key_prefix: LP
statuses:
  - id: todo
    label: To Do
  - id: done
    label: Done
    terminal: true
hierarchy:
  - task
issue_types:
  task:
    label: Task
resource_prefix: RS
resource_hierarchy:
  - [person, role]
resource_types:
  person:
    label: Person
  role:
    label: Role
    generic: true
`;

  const parse = (text: string) => parseConfigText(text);

  it('accepts a complete roster namespace', () => {
    const { config, errors } = parse(WITH_TEAM);
    expect(errors).toEqual([]);
    expect(config!.resource_prefix).toBe('RS');
    expect(config!.resource_hierarchy).toEqual([['person', 'role']]);
    expect(config!.resource_types.role!.generic).toBe(true);
  });

  it('leaves the roster off when nothing declares it', () => {
    const { config } = parse(WITH_TEAM.split('resource_prefix')[0]!);
    expect(config!.resource_types).toEqual({});
    expect(config!.resource_hierarchy).toEqual([]);
  });

  it('requires the whole namespace or none of it', () => {
    const { errors } = parse(WITH_TEAM.replace('resource_prefix: RS\n', ''));
    expect(errors.join()).toMatch(/resource_prefix: required/);
  });

  it('rejects a resource prefix that collides with another namespace', () => {
    const { errors } = parse(WITH_TEAM.replace('resource_prefix: RS', 'resource_prefix: LP'));
    expect(errors.join()).toMatch(/resource_prefix: "LP" must differ from key_prefix/);
  });

  it('rejects a type name shared with the issue namespace', () => {
    const { errors } = parse(WITH_TEAM.replace('  person:\n    label: Person', '  task:\n    label: Task'));
    expect(errors.join()).toMatch(/"task" is also an issue type/);
  });

  it('rejects `generic` outside the roster', () => {
    const { errors } = parse(WITH_TEAM.replace('  task:\n    label: Task', '  task:\n    label: Task\n    generic: true'));
    expect(errors.join()).toMatch(/only resource types can be generic/);
  });

  it('rejects an attribute named after a reserved resource field', () => {
    const { errors } = parse(
      WITH_TEAM.replace(
        '  person:\n    label: Person',
        '  person:\n    label: Person\n    attributes:\n      capacity:\n        type: int',
      ),
    );
    expect(errors.join()).toMatch(/"capacity" is a reserved field name/);
  });

  it('rejects an assignee attribute now that the field is reserved', () => {
    const { errors } = parse(
      WITH_TEAM.replace(
        '  task:\n    label: Task',
        '  task:\n    label: Task\n    attributes:\n      assignee:\n        type: string',
      ),
    );
    expect(errors.join()).toMatch(/"assignee" is a reserved field name/);
  });

  it('validates priority_attribute and effort_attribute against the issue types', () => {
    expect(parse(`${WITH_TEAM}\npriority_attribute: nope\n`).errors.join()).toMatch(
      /"nope" is not an attribute of any issue type/,
    );

    const withPriority = WITH_TEAM.replace(
      '  task:\n    label: Task',
      '  task:\n    label: Task\n    attributes:\n      urgency:\n        type: string',
    );
    expect(parse(`${withPriority}\npriority_attribute: urgency\n`).errors.join()).toMatch(
      /is "string"; expected enum/,
    );
    expect(parse(`${withPriority}\neffort_attribute: urgency\n`).errors.join()).toMatch(
      /is "string"; expected int or float/,
    );
  });

  it('rejects a status that is both terminal and active', () => {
    const { errors } = parse(WITH_TEAM.replace('    terminal: true', '    terminal: true\n    active: true'));
    expect(errors.join()).toMatch(/cannot be both terminal and active/);
  });

  it('keeps periods and resources independent', () => {
    const { config } = parse(WITH_TEAM);
    expect(config!.period_types).toEqual({});
    expect(config!.resource_types.person).toBeDefined();
    expect(PERIOD_FILE).not.toBe(RESOURCE_FILE);
  });
});
