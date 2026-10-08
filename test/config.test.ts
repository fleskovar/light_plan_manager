import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_TEMPLATES,
  builtinTemplatePath,
  depthOfType,
  hasRemotes,
  isAtomicType,
  kindOfType,
  parseConfigText,
  remoteNamed,
} from '../src/core/index.js';

function parse(yaml: string) {
  return parseConfigText(yaml);
}

const MINIMAL = `
version: 1
key_prefix: LP
statuses:
  - id: todo
    label: To Do
  - id: done
    label: Done
hierarchy: [task]
issue_types:
  task:
    label: Task
`;

describe('built-in templates', () => {
  it.each(BUILTIN_TEMPLATES)('%s parses and validates', (name) => {
    const { config, errors } = parse(readFileSync(builtinTemplatePath(name), 'utf8'));
    expect(errors).toEqual([]);
    expect(config).not.toBeNull();
  });

  it('scrum puts every unit of delivery on the same level', () => {
    const { config } = parse(readFileSync(builtinTemplatePath('scrum'), 'utf8'));
    expect(config!.hierarchy).toEqual([
      ['program'],
      ['epic'],
      ['feature'],
      ['user_story', 'bug', 'test', 'review', 'research'],
      ['sub_task'],
    ]);
    for (const type of ['bug', 'user_story', 'test', 'review', 'research']) {
      expect(depthOfType(config!, 'issue', type)).toBe(3);
    }
  });

  it('scrum bodies carry the Agile scaffolding', () => {
    const { config } = parse(readFileSync(builtinTemplatePath('scrum'), 'utf8'));
    expect(config!.issue_types.user_story!.body).toContain('As a **<role>**');
    expect(config!.issue_types.user_story!.body).toContain('## Acceptance Criteria');
    expect(config!.issue_types.bug!.body).toContain('## Steps to Reproduce');
  });

  it('scrum makes the delivery level the unit of work, and nothing above it', () => {
    const { config } = parse(readFileSync(builtinTemplatePath('scrum'), 'utf8'));
    for (const type of ['user_story', 'bug', 'test', 'review', 'research']) {
      expect(isAtomicType(config!, type)).toBe(true);
    }
    for (const type of ['program', 'epic', 'feature', 'sub_task']) {
      expect(isAtomicType(config!, type)).toBe(false);
    }
  });

  it('kanban takes a story whole, tasks and all', () => {
    const { config } = parse(readFileSync(builtinTemplatePath('kanban'), 'utf8'));
    expect(isAtomicType(config!, 'story')).toBe(true);
    expect(isAtomicType(config!, 'task')).toBe(false);
  });
});

describe('parseConfigText', () => {
  it('defaults default_status to the first status', () => {
    const { config } = parse(MINIMAL);
    expect(config!.default_status).toBe('todo');
  });

  it('normalizes a flat hierarchy into levels', () => {
    const { config } = parse(MINIMAL);
    expect(config!.hierarchy).toEqual([['task']]);
  });

  it('reports invalid YAML', () => {
    const { config, errors } = parse('key_prefix: [unclosed');
    expect(config).toBeNull();
    expect(errors[0]).toMatch(/invalid YAML/);
  });

  it('rejects a lowercase key prefix', () => {
    const { errors } = parse(MINIMAL.replace('key_prefix: LP', 'key_prefix: lp'));
    expect(errors.join()).toMatch(/key_prefix/);
  });

  it('rejects a hierarchy type with no definition', () => {
    const { errors } = parse(MINIMAL.replace('hierarchy: [task]', 'hierarchy: [task, ghost]'));
    expect(errors.join()).toMatch(/"ghost" is not defined under issue_types/);
  });

  it('rejects an issue type missing from the hierarchy', () => {
    const { errors } = parse(`${MINIMAL}  extra:\n    label: Extra\n`);
    expect(errors.join()).toMatch(/issue_types.extra: declared but missing from hierarchy/);
  });

  it('rejects a type appearing at two levels', () => {
    const { errors } = parse(MINIMAL.replace('hierarchy: [task]', 'hierarchy: [task, [task]]'));
    expect(errors.join()).toMatch(/each type belongs to exactly one level/);
  });

  it('rejects a reserved attribute name', () => {
    const { errors } = parse(`${MINIMAL}    attributes:\n      status: {type: string}\n`);
    expect(errors.join()).toMatch(/"status" is a reserved field name/);
  });

  it('accepts atomic on an issue type', () => {
    const { config, errors } = parse(`${MINIMAL}    atomic: true\n`);
    expect(errors).toEqual([]);
    expect(isAtomicType(config!, 'task')).toBe(true);
  });

  it('leaves atomic off when nothing declares it', () => {
    const { config } = parse(MINIMAL);
    expect(isAtomicType(config!, 'task')).toBe(false);
  });

  it('rejects atomic on a period type', () => {
    const { errors } = parse(`${MINIMAL}
period_prefix: TL
period_hierarchy: [sprint]
period_types:
  sprint:
    label: Sprint
    atomic: true
`);
    expect(errors.join()).toMatch(/period_types.sprint.atomic: only issue types can be atomic/);
  });

  it('rejects atomic on a resource type', () => {
    const { errors } = parse(`${MINIMAL}
resource_prefix: RS
resource_hierarchy: [person]
resource_types:
  person:
    label: Person
    atomic: true
`);
    expect(errors.join()).toMatch(/resource_types.person.atomic: only issue types can be atomic/);
  });

  it('still rejects generic outside the roster', () => {
    const { errors } = parse(`${MINIMAL}    generic: true\n`);
    expect(errors.join()).toMatch(/issue_types.task.generic: only resource types can be generic/);
  });

  it('rejects an enum without values', () => {
    const { errors } = parse(`${MINIMAL}    attributes:\n      size: {type: enum}\n`);
    expect(errors.join()).toMatch(/enum attributes need a "values" list/);
  });

  it('rejects values on a non-enum attribute', () => {
    const { errors } = parse(
      `${MINIMAL}    attributes:\n      size: {type: string, values: [a]}\n`,
    );
    expect(errors.join()).toMatch(/only valid for enum/);
  });

  it('rejects a default that does not match the attribute type', () => {
    const { errors } = parse(`${MINIMAL}    attributes:\n      points: {type: int, default: "x"}\n`);
    expect(errors.join()).toMatch(/default: expected an integer/);
  });

  it('rejects a default_status that is not a status', () => {
    const { errors } = parse(`${MINIMAL}\ndefault_status: nope\n`);
    expect(errors.join()).toMatch(/default_status/);
  });

  it('rejects duplicate status ids', () => {
    const { errors } = parse(MINIMAL.replace('  - id: done', '  - id: todo'));
    expect(errors.join()).toMatch(/duplicate status id "todo"/);
  });

  it('rejects an unknown attribute type', () => {
    const { errors } = parse(`${MINIMAL}    attributes:\n      x: {type: money}\n`);
    expect(errors.join()).toMatch(/type/);
  });
});

const WITH_PERIODS = `${MINIMAL}
period_prefix: TL
period_hierarchy: [increment, sprint]
period_types:
  increment:
    label: Increment
  sprint:
    label: Sprint
`;

describe('period configuration', () => {
  it('parses and normalizes the period hierarchy', () => {
    const { config, errors } = parse(WITH_PERIODS);
    expect(errors).toEqual([]);
    expect(config!.period_hierarchy).toEqual([['increment'], ['sprint']]);
    expect(config!.period_prefix).toBe('TL');
    expect(depthOfType(config!, 'period', 'sprint')).toBe(1);
  });

  it('leaves the period namespace empty when the board omits it', () => {
    const { config } = parse(MINIMAL);
    expect(config!.period_types).toEqual({});
    expect(config!.period_hierarchy).toEqual([]);
    expect(config!.period_prefix).toBe('');
  });

  it('requires period_hierarchy and period_prefix once period_types exists', () => {
    const withoutRest = `${MINIMAL}\nperiod_types:\n  sprint:\n    label: Sprint\n`;
    const errors = parse(withoutRest).errors.join();
    expect(errors).toMatch(/period_hierarchy: required/);
    expect(errors).toMatch(/period_prefix: required/);
  });

  it('rejects a period prefix equal to the issue prefix', () => {
    const { errors } = parse(WITH_PERIODS.replace('period_prefix: TL', 'period_prefix: LP'));
    expect(errors.join()).toMatch(/must differ from key_prefix/);
  });

  it('rejects a type name used in both namespaces', () => {
    const { errors } = parse(WITH_PERIODS.replace('  sprint:\n    label: Sprint', '  task:\n    label: Task'));
    expect(errors.join()).toMatch(/"task" is also an issue type/);
  });

  it('rejects a period type missing from period_hierarchy', () => {
    const { errors } = parse(`${WITH_PERIODS}  quarter:\n    label: Quarter\n`);
    expect(errors.join()).toMatch(/period_types.quarter: declared but missing from period_hierarchy/);
  });

  it('rejects a period attribute shadowing a reserved period field', () => {
    const { errors } = parse(
      WITH_PERIODS.replace('    label: Sprint', '    label: Sprint\n    attributes:\n      starts: {type: date}'),
    );
    expect(errors.join()).toMatch(/"starts" is a reserved field name/);
  });

  it('lets an issue attribute be named "starts" since that is only reserved for periods', () => {
    const { errors } = parse(
      WITH_PERIODS.replace('  task:\n    label: Task', '  task:\n    label: Task\n    attributes:\n      starts: {type: date}'),
    );
    expect(errors).toEqual([]);
  });

  it('resolves which namespace a type name belongs to', () => {
    const { config } = parse(WITH_PERIODS);
    expect(kindOfType(config!, 'task')).toBe('issue');
    expect(kindOfType(config!, 'sprint')).toBe('period');
    expect(kindOfType(config!, 'nope')).toBeNull();
  });

  it('built-in templates declare periods where expected', () => {
    const scrum = parse(readFileSync(builtinTemplatePath('scrum'), 'utf8')).config!;
    const kanban = parse(readFileSync(builtinTemplatePath('kanban'), 'utf8')).config!;
    const blank = parse(readFileSync(builtinTemplatePath('blank'), 'utf8')).config!;

    expect(scrum.period_hierarchy).toEqual([['increment'], ['sprint']]);
    expect(scrum.period_prefix).toBe('TL');
    expect(scrum.period_types.sprint!.body).toContain('## Sprint Goal');
    expect(kanban.period_hierarchy).toEqual([['cycle']]);
    expect(blank.period_types).toEqual({});
  });

  it('scrum no longer carries a sprint attribute now that periods exist', () => {
    const scrum = parse(readFileSync(builtinTemplatePath('scrum'), 'utf8')).config!;
    expect(scrum.issue_types.user_story!.attributes.sprint).toBeUndefined();
  });
});

const WITH_REMOTES = `${MINIMAL}
remotes:
  upstream:
    provider: github
    scope: LP-2
    direction: pull
    on_delete: unlink
    conflict: manual
    connection:
      repo: acme/payments
      project: 7
    mapping:
      types:
        epic:
          remote: epic
      statuses:
        backlog: Todo
        done: Done
`;

describe('remote configuration', () => {
  it('yields each entry with provider, scope, direction and both policies', () => {
    const { config, errors } = parse(WITH_REMOTES);
    expect(errors).toEqual([]);
    expect(config!.remotes.upstream!.provider).toBe('github');
    expect(config!.remotes.upstream!.scope).toBe('LP-2');
    expect(config!.remotes.upstream!.direction).toBe('pull');
    expect(config!.remotes.upstream!.on_delete).toBe('unlink');
    expect(config!.remotes.upstream!.conflict).toBe('manual');
  });

  it('defaults direction to both', () => {
    const { config, errors } = parse(`${MINIMAL}
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
`);
    expect(errors).toEqual([]);
    expect(config!.remotes.upstream!.direction).toBe('both');
  });

  it('leaves bulk_guard absent by default and accepts a configured fraction', () => {
    const defaults = parse(`${MINIMAL}
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
`);
    expect(defaults.errors).toEqual([]);
    expect(defaults.config!.remotes.upstream!.bulk_guard).toBeUndefined();

    const configured = parse(`${MINIMAL}
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    bulk_guard: 0.75
`);
    expect(configured.errors).toEqual([]);
    expect(configured.config!.remotes.upstream!.bulk_guard).toBe(0.75);
  });

  it('rejects a bulk_guard outside [0, 1]', () => {
    const { errors } = parse(`${MINIMAL}
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    bulk_guard: 1.5
`);
    expect(errors.join()).toMatch(/bulk_guard/);
  });

  it('leaves write_threshold absent by default and accepts a configured count', () => {
    const defaults = parse(`${MINIMAL}
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
`);
    expect(defaults.errors).toEqual([]);
    expect(defaults.config!.remotes.upstream!.write_threshold).toBeUndefined();

    const configured = parse(`${MINIMAL}
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    write_threshold: 10
`);
    expect(configured.errors).toEqual([]);
    expect(configured.config!.remotes.upstream!.write_threshold).toBe(10);
  });

  it('rejects a non-positive write_threshold', () => {
    const { errors } = parse(`${MINIMAL}
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    write_threshold: 0
`);
    expect(errors.join()).toMatch(/write_threshold/);
  });

  it('defaults encoding to block and accepts comment', () => {
    const defaults = parse(`${MINIMAL}
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
`);
    expect(defaults.errors).toEqual([]);
    expect(defaults.config!.remotes.upstream!.encoding).toBe('block');

    const comment = parse(`${MINIMAL}
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    encoding: comment
`);
    expect(comment.errors).toEqual([]);
    expect(comment.config!.remotes.upstream!.encoding).toBe('comment');
  });

  it('rejects an unknown encoding', () => {
    const { errors } = parse(`${MINIMAL}
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    encoding: attachment
`);
    expect(errors.join()).toMatch(/encoding/);
  });

  it('carries connection and mapping through as opaque records, unvalidated', () => {
    const { config } = parse(WITH_REMOTES);
    expect(config!.remotes.upstream!.connection).toEqual({ repo: 'acme/payments', project: 7 });
    expect(config!.remotes.upstream!.mapping).toEqual({
      types: { epic: { remote: 'epic' } },
      statuses: { backlog: 'Todo', done: 'Done' },
    });
  });

  it('defaults connection and mapping to empty records when absent', () => {
    const { config } = parse(`${MINIMAL}
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
`);
    expect(config!.remotes.upstream!.connection).toEqual({});
    expect(config!.remotes.upstream!.mapping).toEqual({});
  });

  it('defaults fields to an empty record and flattens per-field owners', () => {
    const defaults = parse(`${MINIMAL}
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
`);
    expect(defaults.errors).toEqual([]);
    expect(defaults.config!.remotes.upstream!.fields).toEqual({});

    const overrides = parse(`${MINIMAL}
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: local
    fields:
      status:
        owner: remote
      title:
        owner: local
`);
    expect(overrides.errors).toEqual([]);
    expect(overrides.config!.remotes.upstream!.fields).toEqual({
      status: 'remote',
      title: 'local',
    });
  });

  it('rejects a field owner that is not local or remote', () => {
    const { errors } = parse(`${MINIMAL}
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    fields:
      status:
        owner: mine
`);
    expect(errors.join()).toMatch(/fields/);
    expect(errors.join()).toMatch(/owner/);
  });

  it('hasRemotes is false and remoteNamed is null when the key is absent', () => {
    const { config } = parse(MINIMAL);
    expect(config!.remotes).toEqual({});
    expect(hasRemotes(config!)).toBe(false);
    expect(remoteNamed(config!, 'upstream')).toBeNull();
  });

  it('hasRemotes is true and remoteNamed reads an entry when declared', () => {
    const { config } = parse(WITH_REMOTES);
    expect(hasRemotes(config!)).toBe(true);
    expect(remoteNamed(config!, 'upstream')!.provider).toBe('github');
    expect(remoteNamed(config!, 'missing')).toBeNull();
  });

  it('rejects two remotes with the same scope, naming both', () => {
    const { errors } = parse(`${MINIMAL}
remotes:
  jira:
    provider: jira
    scope: LP-2
    on_delete: unlink
    conflict: manual
  github:
    provider: github
    scope: LP-2
    on_delete: unlink
    conflict: manual
`);
    expect(errors.join()).toMatch(/have overlapping scopes/);
    expect(errors.join()).toMatch(/"jira"/);
    expect(errors.join()).toMatch(/"github"/);
  });

  it('rejects two unscoped remotes, naming both', () => {
    const { errors } = parse(`${MINIMAL}
remotes:
  jira:
    provider: jira
    on_delete: unlink
    conflict: manual
  github:
    provider: github
    on_delete: unlink
    conflict: manual
`);
    expect(errors.join()).toMatch(/have overlapping scopes/);
  });

  it('rejects an unscoped remote beside a scoped one, naming both', () => {
    const { errors } = parse(`${MINIMAL}
remotes:
  jira:
    provider: jira
    on_delete: unlink
    conflict: manual
  github:
    provider: github
    scope: LP-2
    on_delete: unlink
    conflict: manual
`);
    expect(errors.join()).toMatch(/have overlapping scopes/);
    expect(errors.join()).toMatch(/"jira"/);
    expect(errors.join()).toMatch(/"github"/);
  });

  it('accepts several remotes with different scopes', () => {
    const { config, errors } = parse(`${MINIMAL}
remotes:
  jira:
    provider: jira
    scope: LP-2
    on_delete: unlink
    conflict: manual
  github:
    provider: github
    scope: LP-3
    on_delete: unlink
    conflict: manual
`);
    expect(errors).toEqual([]);
    expect(Object.keys(config!.remotes)).toEqual(['jira', 'github']);
  });

  it('rejects a remote name that is not lower_snake_case', () => {
    const { errors } = parse(`${MINIMAL}
remotes:
  Upstream:
    provider: github
    on_delete: unlink
    conflict: manual
`);
    expect(errors.join()).toMatch(/must be lower_snake_case/);
  });

  it('rejects an unknown direction', () => {
    const { errors } = parse(`${MINIMAL}
remotes:
  upstream:
    provider: github
    direction: sideways
    on_delete: unlink
    conflict: manual
`);
    expect(errors.join()).toMatch(/direction/);
  });

  it('rejects an unknown on_delete policy', () => {
    const { errors } = parse(`${MINIMAL}
remotes:
  upstream:
    provider: github
    on_delete: nuke
    conflict: manual
`);
    expect(errors.join()).toMatch(/on_delete/);
  });

  it.each(['unlink', 'close', 'delete', 'restore', 'manual'] as const)(
    'accepts on_delete: %s (LP-365)',
    (policy) => {
      const { config, errors } = parse(`${MINIMAL}
remotes:
  upstream:
    provider: github
    on_delete: ${policy}
    conflict: manual
`);
      expect(errors).toEqual([]);
      expect(config!.remotes.upstream!.on_delete).toBe(policy);
    },
  );

  it('rejects an unknown conflict policy', () => {
    const { errors } = parse(`${MINIMAL}
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: mine
`);
    expect(errors.join()).toMatch(/conflict/);
  });

  it('requires conflict', () => {
    const { errors } = parse(`${MINIMAL}
remotes:
  upstream:
    provider: github
`);
    expect(errors.join()).toMatch(/conflict/);
  });

  it('defaults on_delete to unlink when omitted (LP-351)', () => {
    const { config, errors } = parse(`${MINIMAL}
remotes:
  upstream:
    provider: github
    conflict: manual
`);
    expect(errors).toEqual([]);
    expect(config!.remotes.upstream!.on_delete).toBe('unlink');
  });
});
