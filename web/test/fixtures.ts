import type {
  ConfigDto,
  IssueDto,
  NodeDto,
  NodeKind,
  PeriodDto,
  ResourceDto,
  TemplateDto,
  TypeDto,
} from '$shared';
import type { WorkingNodes } from '$lib/board/working.js';

/** One declared type, with the flags off unless a case wants them on. */
const type = (
  name: string,
  kind: NodeKind,
  label: string,
  depth: number,
  extra: Partial<TypeDto> = {},
): TypeDto => ({
  name,
  kind,
  label,
  depth,
  attributes: [],
  generic: false,
  atomic: false,
  ...extra,
});

/** A scrum-shaped board, small enough to reason about in a test. */
export const config: ConfigDto = {
  boardName: 'demo',
  defaultStatus: 'backlog',
  statuses: [
    { id: 'backlog', label: 'Backlog', terminal: false, active: false },
    { id: 'in_progress', label: 'In Progress', terminal: false, active: true },
    { id: 'blocked', label: 'Blocked', terminal: false, active: false },
    { id: 'in_review', label: 'In Review', terminal: false, active: false },
    { id: 'done', label: 'Done', terminal: true, active: false },
  ],
  types: {
    program: type('program', 'issue', 'Program', 0),
    epic: type('epic', 'issue', 'Epic', 1),
    feature: type('feature', 'issue', 'Feature', 2),
    user_story: type('user_story', 'issue', 'User Story', 3, {
      attributes: [
        { name: 'story_points', type: 'int' },
        { name: 'priority', type: 'enum', values: ['high', 'medium'], default: 'medium' },
      ],
    }),
    bug: type('bug', 'issue', 'Bug', 3, {
      attributes: [
        { name: 'severity', type: 'enum', values: ['major', 'minor'], default: 'major' },
        { name: 'story_points', type: 'int' },
      ],
    }),
    sub_task: type('sub_task', 'issue', 'Sub-task', 4),
    increment: type('increment', 'period', 'Increment', 0),
    sprint: type('sprint', 'period', 'Sprint', 1),
    person: type('person', 'resource', 'Person', 0),
    role: type('role', 'resource', 'Role', 0, { generic: true }),
    // The registry's one own type; the rest of its vocabulary is the issue
    // types above. @see templateHierarchy in src/core/config/lookup.ts
    folder: type('folder', 'template', 'Folder', 0),
  },
  hierarchy: {
    issue: [['program'], ['epic'], ['feature'], ['user_story', 'bug'], ['sub_task']],
    period: [['increment'], ['sprint']],
    resource: [['person', 'role']],
    squad: [['squad']],
    template: [
      ['program', 'folder'],
      ['epic', 'folder'],
      ['feature', 'folder'],
      ['user_story', 'bug', 'folder'],
      ['sub_task', 'folder'],
    ],
  },
  hasPeriods: true,
  hasResources: true,
  hasSquads: true,
  priorityAttribute: 'priority',
  effortAttribute: 'story_points',
};

/**
 * The same board with some issue types taken whole, for the cases where a story
 * carries its sub-tasks rather than being replaced by them.
 */
export function atomicConfig(...types: string[]): ConfigDto {
  return {
    ...config,
    types: Object.fromEntries(
      Object.entries(config.types).map(([name, def]) => [
        name,
        { ...def, atomic: types.includes(name) },
      ]),
    ),
  };
}

export function issue(
  id: string,
  type: string,
  parentId: string | null,
  extra: Partial<IssueDto> = {},
): IssueDto {
  return {
    kind: 'issue',
    id,
    type,
    title: id,
    body: '',
    parentId,
    depth: config.types[type]!.depth,
    attributes: {},
    status: 'backlog',
    assignee: null,
    period: null,
    flag: null,
    dependsOn: [],
    relatesTo: [],
    relatedFiles: [],
    ...extra,
  };
}

export function period(
  id: string,
  starts: string,
  ends: string,
  parentId: string | null = null,
  type = 'sprint',
): PeriodDto {
  return {
    kind: 'period',
    id,
    type,
    title: id,
    body: '',
    squad: null,
    parentId,
    depth: config.types[type]!.depth,
    attributes: {},
    starts,
    ends,
  };
}

export function resource(id: string, type: string, extra: Partial<ResourceDto> = {}): ResourceDto {
  return {
    kind: 'resource',
    id,
    type,
    title: id,
    body: '',
    parentId: null,
    depth: 0,
    attributes: {},
    capacity: 1,
    covers: [],
    generic: config.types[type]!.generic,
    ...extra,
  };
}

/**
 * A registry template. `type` is one of the board's own issue types, or
 * `folder` for the container that stands in for a level nobody templatized.
 */
export function template(
  id: string,
  type: string,
  parentId: string | null,
  extra: Partial<TemplateDto> = {},
): TemplateDto {
  const parentIsFolder = parentId === null || parentId.startsWith('TF');
  return {
    kind: 'template',
    id,
    type,
    title: id,
    body: '',
    parentId,
    depth: config.types[type]?.depth ?? 0,
    attributes: {},
    description: '',
    params: {},
    root: type !== 'folder' && parentIsFolder,
    dependsOn: [],
    relatesTo: [],
    relatedFiles: [],
    ...extra,
  };
}

export function board(...nodes: NodeDto[]): WorkingNodes {
  return Object.fromEntries(nodes.map((node) => [node.id, node]));
}

/**
 * program > epic > two features, each with two stories, chained
 * S1 -> S2 -> S3 -> S4.
 */
export function sampleBoard(): WorkingNodes {
  return board(
    issue('P', 'program', null),
    issue('E', 'epic', 'P'),
    issue('F1', 'feature', 'E'),
    issue('F2', 'feature', 'E'),
    issue('S1', 'user_story', 'F1', { status: 'done', attributes: { story_points: 3 } }),
    issue('S2', 'user_story', 'F1', { status: 'in_progress', dependsOn: ['S1'], attributes: { story_points: 5 } }),
    issue('S3', 'user_story', 'F2', { dependsOn: ['S2'], attributes: { story_points: 2 } }),
    issue('S4', 'user_story', 'F2', { dependsOn: ['S3'], attributes: { story_points: 8 } }),
  );
}
