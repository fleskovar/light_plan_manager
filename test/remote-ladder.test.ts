import { writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { BoardPaths, LoadedBoard } from '../src/core/index.js';
import type { ResolvedCapabilities } from '../src/remote/capabilities.js';
import { preflightLadder, refusalProblems, renderLadderReport } from '../src/remote/ladder.js';
import type { OpenedRemote } from '../src/remote/remotes.js';
import { findProvider } from '../src/remote/registry.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterAll(cleanupBoards);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Comment capability shorthand: none, and the full GitHub shape. */
const NO_COMMENTS = { native: false, editable: false, deletable: false };
const FULL_COMMENTS = { native: true, editable: true, deletable: true };

/** GitHub's resolved capability table, with one cell overridable at a time. */
function resolved(overrides: Partial<ResolvedCapabilities> = {}): ResolvedCapabilities {
  return {
    hierarchyDepth: 1,
    nativeTypes: false,
    status: { kind: 'binary', open: 'open', closed: 'closed' },
    edges: { dependsOn: false, relatesTo: false },
    customFields: null,
    provisioning: { customFields: false, periods: false, labels: true },
    periods: { native: true, creatable: true },
    comments: FULL_COMMENTS,
    incrementalRead: { kind: 'since' },
    vocabulary: 'fixed',
    ...overrides,
  };
}

/** A GitHub remote, built by hand the way `openRemote` would leave it. */
function githubRemote(mapping: Record<string, unknown> = {}): OpenedRemote {
  return {
    name: 'upstream',
    provider: findProvider('github')!,
    direction: 'both',
    on_delete: 'unlink',
    conflict: 'manual',
    fields: {},
    encoding: 'block',
    comments: 'push',
    connection: { repo: 'acme/payments' },
    mapping,
  };
}

/** Replace a board's config with a hand-written one (no attributes, no periods). */
function minimalConfig(paths: BoardPaths, issueTypesYaml: string): LoadedBoard {
  writeFileSync(
    paths.configPath,
    `version: 1
key_prefix: LP
statuses:
  - id: todo
    label: To Do
  - id: done
    label: Done
    terminal: true
default_status: todo
hierarchy:
  - task
issue_types:
${issueTypesYaml}
`,
    'utf8',
  );
  return reload(paths);
}

const row = (report: ReturnType<typeof preflightLadder>, construct: string) =>
  report.rows.find((r) => r.construct === construct)!;

// ---------------------------------------------------------------------------
// The rung per construct (criterion 1)
// ---------------------------------------------------------------------------

describe('preflightLadder', () => {
  it('lists every construct with its rung and the reason the rung above failed', () => {
    const paths = makeBoard('scrum', 'LP');
    const report = preflightLadder(
      reload(paths),
      githubRemote({ attributes: { priority: 'Priority' }, periods: { container: 'sprint' } }),
      resolved(),
    );

    // hierarchy: 5 levels vs one native sub-issue level.
    expect(row(report, 'hierarchy')).toMatchObject({
      board: 'program > epic > feature > user_story/bug/test/review/research > sub_task',
      rung: 'managed_block',
    });
    expect(row(report, 'hierarchy').reason).toContain('one native sub-issue level');

    // type: no native issue type -> label.
    expect(row(report, 'type').rung).toBe('label');
    expect(row(report, 'type').reason).toBe('no native issue type');

    // status: open/closed only, no custom fields -> label.
    expect(row(report, 'status')).toMatchObject({
      board: 'backlog ready in_progress in_review done',
      rung: 'label',
    });

    // edges: GitHub has neither.
    expect(row(report, 'depends_on').rung).toBe('managed_block');
    expect(row(report, 'depends_on').reason).toBe('the remote has no blocking edge');
    expect(row(report, 'relates_to').rung).toBe('managed_block');

    // a mapped attribute rides its label prefix.
    expect(row(report, 'priority')).toMatchObject({
      board: '-> "Priority"',
      rung: 'label',
    });

    // an unmapped attribute with no custom fields rides the block.
    expect(row(report, 'story_points')).toMatchObject({
      rung: 'managed_block',
    });
    expect(row(report, 'story_points').reason).toContain('carried in the managed block');

    // periods: the container level is native, the other level rides the block.
    expect(row(report, 'sprint')).toMatchObject({ rung: 'native', board: '-> milestones' });
    expect(row(report, 'increment')).toMatchObject({ rung: 'managed_block' });

    expect(report.lossless).toBe(false);
    expect(report.refused).toBe(false);
  });

  it('reports native types and native workflow states when the provider holds them', () => {
    const paths = makeBoard('scrum', 'LP');
    const report = preflightLadder(
      reload(paths),
      githubRemote(),
      resolved({ nativeTypes: true, status: { kind: 'states' } }),
    );
    expect(row(report, 'type').rung).toBe('native');
    expect(row(report, 'status').rung).toBe('native');
  });

  it('is silent about periods on a board that declares none', () => {
    const paths = makeBoard('blank', 'LP');
    const report = preflightLadder(reload(paths), githubRemote(), resolved());
    expect(report.rows.map((r) => r.construct)).not.toContain('sprint');
    expect(report.rows.map((r) => r.construct)).not.toContain('increment');
  });
});

// ---------------------------------------------------------------------------
// Provisioning (criterion 2)
// ---------------------------------------------------------------------------

describe('provisionable carriers', () => {
  it('names the push when a carrier can be created', () => {
    const paths = makeBoard('scrum', 'LP');
    const report = preflightLadder(
      reload(paths),
      githubRemote(),
      resolved({
        customFields: { valueTypes: ['text', 'number'] },
        provisioning: { customFields: true, periods: true, labels: true },
      }),
    );

    // status now degrades to a provisionable custom field.
    expect(row(report, 'status').rung).toBe('custom_field');
    expect(row(report, 'status').provision?.command).toBe('lpm remote push');

    // unmapped attributes land on a provisionable custom field too.
    expect(row(report, 'story_points').rung).toBe('custom_field');
    expect(row(report, 'story_points').provision?.command).toBe('lpm remote push');

    // a mapped attribute stays on its label — the mapping pinned the carrier.
    const withMapping = preflightLadder(
      reload(paths),
      githubRemote({ attributes: { priority: 'Priority' } }),
      resolved({
        customFields: { valueTypes: ['text', 'number'] },
        provisioning: { customFields: true, periods: true, labels: true },
      }),
    );
    expect(row(withMapping, 'priority').rung).toBe('label');
    expect(row(withMapping, 'priority').provision).toBeUndefined();
  });

  it('says when custom fields exist but cannot be created through the API', () => {
    const paths = makeBoard('scrum', 'LP');
    const report = preflightLadder(
      reload(paths),
      githubRemote(),
      resolved({
        customFields: { valueTypes: ['text'] },
        provisioning: { customFields: false, periods: true, labels: true },
      }),
    );
    expect(row(report, 'story_points').rung).toBe('custom_field');
    expect(row(report, 'story_points').provision).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The short, lossless form (criterion 3)
// ---------------------------------------------------------------------------

describe('lossless boards', () => {
  it('is short and says the board round-trips losslessly when everything is native', () => {
    const paths = makeBoard('blank', 'LP');
    const board = minimalConfig(
      paths,
      `  task:
    label: Task
    attributes: {}
    body: "## Description"`,
    );
    const report = preflightLadder(
      board,
      githubRemote(),
      resolved({
        hierarchyDepth: 5,
        nativeTypes: true,
        status: { kind: 'states' },
        edges: { dependsOn: true, relatesTo: true },
      }),
    );
    expect(report.lossless).toBe(true);
    expect(report.refused).toBe(false);
    expect(renderLadderReport(report)).toBe(
      'Remote "upstream" (acme/payments) — every field round-trips losslessly.\n',
    );
  });
});

// ---------------------------------------------------------------------------
// The bottom rung (criterion 4)
// ---------------------------------------------------------------------------

describe('refused', () => {
  it('refuses a required field with no carrier at all', () => {
    const paths = makeBoard('blank', 'LP');
    const board = minimalConfig(
      paths,
      `  task:
    label: Task
    attributes:
      compliance_id:
        type: string
        required: true
    body: "## Description"`,
    );
    const report = preflightLadder(
      board,
      githubRemote(),
      resolved({ customFields: null, comments: NO_COMMENTS }),
      { bodyWritable: false },
    );
    expect(row(report, 'compliance_id').rung).toBe('refused');
    expect(report.refused).toBe(true);
  });

  it('does not refuse the same field when the body can carry it', () => {
    const paths = makeBoard('blank', 'LP');
    const board = minimalConfig(
      paths,
      `  task:
    label: Task
    attributes:
      compliance_id:
        type: string
        required: true
    body: "## Description"`,
    );
    const report = preflightLadder(
      board,
      githubRemote(),
      resolved({ customFields: null, comments: NO_COMMENTS }),
    );
    expect(row(report, 'compliance_id').rung).toBe('managed_block');
    expect(report.refused).toBe(false);
  });

  it('falls back to a managed comment when the body is not writable but comments exist', () => {
    const paths = makeBoard('blank', 'LP');
    const board = minimalConfig(
      paths,
      `  task:
    label: Task
    attributes:
      compliance_id:
        type: string
        required: true
    body: "## Description"`,
    );
    const report = preflightLadder(
      board,
      githubRemote(),
      resolved({ customFields: null, comments: FULL_COMMENTS }),
      { bodyWritable: false },
    );
    expect(row(report, 'compliance_id').rung).toBe('comment');
    expect(report.refused).toBe(false);
  });

  it('derives bodyWritable from `encoding: comment` on the remote', () => {
    const paths = makeBoard('blank', 'LP');
    const board = minimalConfig(
      paths,
      `  task:
    label: Task
    attributes:
      compliance_id:
        type: string
        required: true
    body: "## Description"`,
    );
    const report = preflightLadder(
      board,
      { ...githubRemote(), encoding: 'comment' },
      resolved({ customFields: null, comments: FULL_COMMENTS }),
    );
    expect(row(report, 'compliance_id').rung).toBe('comment');
    expect(report.refused).toBe(false);
  });

  it('renders refused rows and marks the report refused for the exit code', () => {
    const paths = makeBoard('blank', 'LP');
    const board = minimalConfig(
      paths,
      `  task:
    label: Task
    attributes:
      compliance_id:
        type: string
        required: true
    body: "## Description"`,
    );
    const report = preflightLadder(
      board,
      githubRemote(),
      resolved({ customFields: null, comments: NO_COMMENTS }),
      { bodyWritable: false },
    );
    const text = renderLadderReport(report);
    expect(text).toContain('compliance_id');
    expect(text).toContain('refused');
    expect(text).toContain('required, and no carrier is available');
  });
});

// ---------------------------------------------------------------------------
// The refusal gate (LP-279)
// ---------------------------------------------------------------------------

/** A one-attribute board, with `required` on the attribute when asked. */
function boardWithAttribute(required: boolean): LoadedBoard {
  const paths = makeBoard('blank', 'LP');
  return minimalConfig(
    paths,
    `  task:
    label: Task
    attributes:
      compliance_id:
        type: string${required ? '\n        required: true' : ''}
    body: "## Description"`,
  );
}

/** A remote with no carrier at all, and a body that cannot hold the block. */
function noCarrier() {
  return {
    capabilities: resolved({ customFields: null, comments: NO_COMMENTS }),
    options: { bodyWritable: false } as const,
  };
}

describe('refusalProblems', () => {
  it('refuses a required field with an error naming the field, the capability and the fix', () => {
    const report = preflightLadder(
      boardWithAttribute(true),
      githubRemote(),
      noCarrier().capabilities,
      noCarrier().options,
    );
    expect(report.refused).toBe(true);

    const problems = refusalProblems(report);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toEqual({
      level: 'error',
      path: '.lpm/config.yml',
      message:
        'remotes.upstream.mapping.attributes.compliance_id: attribute "compliance_id" is required, and no carrier is available (no custom fields, no writable body, no comments) — map it to a label so the value is carried: remotes.upstream.mapping.attributes.compliance_id: "<label>"',
    });
  });

  it('ends the refusal message with the concrete config change that resolves it', () => {
    const report = preflightLadder(
      boardWithAttribute(true),
      githubRemote(),
      noCarrier().capabilities,
      noCarrier().options,
    );
    const [problem] = refusalProblems(report);
    expect(problem!.message).toMatch(
      /map it to a label so the value is carried: remotes\.upstream\.mapping\.attributes\.compliance_id: "<label>"$/,
    );
  });

  it('degrades the same field to a warning when it is not required, and the sync proceeds', () => {
    const report = preflightLadder(
      boardWithAttribute(false),
      githubRemote(),
      noCarrier().capabilities,
      noCarrier().options,
    );
    expect(report.refused).toBe(false);
    expect(row(report, 'compliance_id').rung).toBe('dropped');

    const problems = refusalProblems(report);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.level).toBe('warn');
    expect(problems[0]!.message).toBe(
      'remotes.upstream.mapping.attributes.compliance_id: attribute "compliance_id" is not required, and no carrier is available (no custom fields, no writable body, no comments) — the value will be dropped',
    );
  });

  it('downgrades a refusal to a single warning under --force', () => {
    const report = preflightLadder(
      boardWithAttribute(true),
      githubRemote(),
      noCarrier().capabilities,
      noCarrier().options,
    );
    const problems = refusalProblems(report, { force: true });
    expect(problems).toHaveLength(1);
    expect(problems[0]!.level).toBe('warn');
    expect(problems[0]!.message).toContain('compliance_id');
  });

  it('is silent when nothing reaches the bottom of the ladder', () => {
    const report = preflightLadder(
      boardWithAttribute(true),
      githubRemote(),
      resolved({ customFields: null, comments: NO_COMMENTS }),
    );
    expect(report.refused).toBe(false);
    expect(refusalProblems(report)).toEqual([]);
  });
});
